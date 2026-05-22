import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result, type StructuredError } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  src: AbsolutePath.describe("Source file or directory inside allowedRoots."),
  dst: AbsolutePath.describe("Destination path inside allowedRoots."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("If false and dst exists, returns EEXIST."),
  recursive: z
    .boolean()
    .default(true)
    .describe("For directories, recurse into entries."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  copied: z.literal(true),
  bytes_copied: z.number().int().nonnegative(),
  files_copied: z.number().int().nonnegative(),
  files_skipped: z.number().int().nonnegative(),
  skipped_paths: z.array(z.string()),
} as const;

interface CopyResult extends Record<string, unknown> {
  copied: true;
  bytes_copied: number;
  files_copied: number;
  files_skipped: number;
  skipped_paths: string[];
}

/**
 * Internal handle the copy registration uses to surface the un-capped
 * `files_skipped_total` to the audit log without polluting the user-facing
 * response (which keeps the capped `skipped_paths` array). The map is keyed
 * by the result object identity so concurrent copy calls don't collide.
 */
const skipCountByResult = new WeakMap<object, number>();

export function getFullSkipCountForAudit(value: CopyResult): number | undefined {
  return skipCountByResult.get(value);
}

interface Counters {
  bytes: number;
  files: number;
  skipped: number;
  skippedPaths: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function isInsideAllowed(realPath: string, config: ResolvedConfig): boolean {
  const norm = path.normalize(realPath);
  const cmp = process.platform === "win32" ? norm.toLowerCase() : norm;
  for (const root of config.resolvedAllowedRoots) {
    const r = process.platform === "win32" ? root.toLowerCase() : root;
    if (cmp === r) return true;
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    if (cmp.startsWith(withSep)) return true;
  }
  return false;
}

/**
 * Recursive copy that respects spec amendment 2026-05-16 §B: each entry is
 * realpath-checked; if it resolves outside allowedRoots (junction/symlink
 * escape) or is dangling, it's skipped and counted. Up to 10 skipped paths
 * are surfaced in the result for trace-ability.
 */
async function copyEntry(
  srcAbs: string,
  dstAbs: string,
  recursive: boolean,
  config: ResolvedConfig,
  counters: Counters,
): Promise<StructuredError | undefined> {
  let real: string;
  try {
    real = await fs.realpath(srcAbs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      // Dangling symlink: skip.
      counters.skipped++;
      if (counters.skippedPaths.length < 10) counters.skippedPaths.push(srcAbs);
      return undefined;
    }
    return fromNodeError(err, `realpath ${srcAbs}`);
  }

  if (!isInsideAllowed(real, config)) {
    // Junction / symlink that escapes the sandbox: skip.
    counters.skipped++;
    if (counters.skippedPaths.length < 10) counters.skippedPaths.push(srcAbs);
    return undefined;
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(real);
  } catch (err) {
    return fromNodeError(err, `stat ${real}`);
  }

  if (stat.isDirectory()) {
    if (!recursive) {
      return buildError("EISDIR", "Source is a directory and recursive=false", {
        details: { src: real },
      });
    }
    try {
      await fs.mkdir(dstAbs, { recursive: true });
    } catch (err) {
      return fromNodeError(err, `mkdir ${dstAbs}`);
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(real, { withFileTypes: true });
    } catch (err) {
      return fromNodeError(err, `readdir ${real}`);
    }
    for (const ent of entries) {
      const childSrc = path.join(real, ent.name);
      const childDst = path.join(dstAbs, ent.name);
      const err = await copyEntry(childSrc, childDst, recursive, config, counters);
      if (err) return err;
    }
    return undefined;
  }

  // Regular file (or symlink-to-file that resolved inside allowed)
  try {
    await fs.copyFile(real, dstAbs);
  } catch (err) {
    return fromNodeError(err, `copyFile ${real} → ${dstAbs}`);
  }
  counters.bytes += stat.size;
  counters.files++;
  return undefined;
}

export async function copyImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<CopyResult>> {
  const srcCheck = await checkAllowed(args.src, config);
  if ("ok" in srcCheck && srcCheck.ok === false) return srcCheck;
  const srcReal = (srcCheck as { realPath: string }).realPath;

  const dstCheck = await checkAllowed(args.dst, config, { allowMissing: true });
  if ("ok" in dstCheck && dstCheck.ok === false) {
    if (dstCheck.error.code === "EPERM_ROOT") {
      return buildError("EPERM_ROOT", "Destination is outside allowedRoots", {
        details: { src: srcReal, dst: args.dst },
        hint: dstCheck.error.hint,
      });
    }
    return dstCheck;
  }
  const dstReal = (dstCheck as { realPath: string }).realPath;

  if (await exists(dstReal)) {
    if (!args.overwrite) {
      return buildError("EEXIST", "Destination exists and overwrite=false", {
        details: { dst: dstReal },
        hint: "Pass overwrite=true to replace.",
      });
    }
    try {
      await fs.rm(dstReal, { recursive: true, force: true });
    } catch (err) {
      return fromNodeError(err, "could not remove existing destination");
    }
  }

  const counters: Counters = { bytes: 0, files: 0, skipped: 0, skippedPaths: [] };
  const err = await copyEntry(srcReal, dstReal, args.recursive, config, counters);
  if (err) return err;

  const value: CopyResult = {
    copied: true,
    bytes_copied: counters.bytes,
    files_copied: counters.files,
    files_skipped: counters.skipped,
    skipped_paths: counters.skippedPaths,
  };
  // Carryover #2: audit gets the FULL skip count even though the response
  // surfaces only the first 10 paths. `skipped_paths` itself is unchanged so
  // the user-visible envelope stays the same.
  skipCountByResult.set(value, counters.skipped);
  return ok(value);
}

export function registerCopyTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "copy",
    {
      title: "Copy file or directory (recursive)",
      description: `Copy a path. Both src and dst must resolve inside allowedRoots. Directories are
recursed when recursive=true (default). Each entry inside the source tree is realpath-checked
during the walk; junction/symlink-escape or dangling links are skipped and reported in
files_skipped + skipped_paths (capped at 10 entries) — see spec amendment 2026-05-16 §B.

Args:
  - src (string): Absolute path inside allowedRoots (file or directory)
  - dst (string): Absolute path inside allowedRoots
  - overwrite (boolean, default false): if false and dst exists, returns EEXIST
  - recursive (boolean, default true): for directories, recurse into entries

Returns: { copied: true, bytes_copied, files_copied, files_skipped, skipped_paths }
Errors: EPERM_ROOT (either side), ENOENT (src), EEXIST (overwrite=false + dst exists), EISDIR (dir src + recursive=false), EIO.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        // v0.8: destructiveHint is true (matches move): copy with
        // overwrite:true may overwrite the destination. Clients should
        // confirm before invoking unless they explicitly pass
        // overwrite:false (the default; safer for blind invocations).
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "copy",
          config,
          auditExtras: (result) => {
            if (!result.ok) return {};
            const full = getFullSkipCountForAudit(result.value as CopyResult);
            return full !== undefined ? { files_skipped_total: full } : {};
          },
        },
        args,
        (a) => copyImpl(a as Input, config),
      ),
  );
}
