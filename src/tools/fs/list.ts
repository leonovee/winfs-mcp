import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";

const InputShape = {
  path: AbsolutePath,
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(1)
    .describe("Recursion depth (1 = immediate children only, max 5)."),
  glob: z
    .string()
    .optional()
    .describe('Optional simple glob (e.g., "*.md"). Matches against entry basename only.'),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

interface ListEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
  is_dir: boolean;
  depth: number;
}

const OutputShape = {
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      size: z.number().int().nonnegative(),
      mtime: z.string(),
      is_dir: z.boolean(),
      depth: z.number().int().positive(),
    }),
  ),
  total: z.number().int().nonnegative(),
} as const;

interface ListResult extends Record<string, unknown> {
  entries: ListEntry[];
  total: number;
}

/**
 * Compile a simple glob into a RegExp. Supports `*` (any chars except `/`),
 * `?` (single char) and `[...]` character classes. No `**` because depth is
 * controlled by `max_depth` and we only match basenames.
 */
function compileGlob(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") re += "[^/\\\\]*";
    else if (ch === "?") re += "[^/\\\\]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (/[.+^${}()|\\]/.test(ch ?? "")) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re, process.platform === "win32" ? "i" : "");
}

async function walk(
  dir: string,
  baseDepth: number,
  maxDepth: number,
  glob: RegExp | undefined,
  out: ListEntry[],
): Promise<void> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    const matches = glob ? glob.test(d.name) : true;
    let size = 0;
    let mtime = new Date(0);
    try {
      const st = await fs.stat(full);
      size = st.isDirectory() ? 0 : st.size;
      mtime = st.mtime;
    } catch {
      /* skip unreadable */
    }
    if (matches) {
      out.push({
        name: d.name,
        path: full,
        size,
        mtime: mtime.toISOString(),
        is_dir: d.isDirectory(),
        depth: baseDepth,
      });
    }
    if (d.isDirectory() && baseDepth < maxDepth) {
      await walk(full, baseDepth + 1, maxDepth, glob, out);
    }
  }
}

export async function listImpl(args: Input, config: ResolvedConfig): Promise<Result<ListResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (!stat.isDirectory()) {
    return buildError("ENOTDIR", "Path is not a directory", { details: { path: realPath } });
  }

  const glob = args.glob ? compileGlob(args.glob) : undefined;
  const entries: ListEntry[] = [];
  await walk(realPath, 1, args.max_depth, glob, entries);

  return ok({ entries, total: entries.length });
}

export function registerListTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "list",
    {
      title: "List directory entries with metadata",
      description: `Recursively list a directory. Returns entries with size, mtime, is_dir flag and 1-based depth.

Args:
  - path (string): Absolute directory path inside allowedRoots
  - max_depth (1..5, default 1): recursion depth
  - glob (string, optional): basename glob ("*.md"). \`*\` and \`?\` and \`[...]\` are supported.

Returns: { entries: [{name, path, size, mtime, is_dir, depth}], total }
Errors: EPERM_ROOT, ENOENT, ENOTDIR, ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "list", config }, args, (a) => listImpl(a as Input, config)),
  );
}
