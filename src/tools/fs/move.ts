import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import { copyImpl } from "./copy.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  src: AbsolutePath.describe("Source path inside allowedRoots (must exist)."),
  dst: AbsolutePath.describe("Destination path inside allowedRoots."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("If false and dst exists, returns EEXIST."),
  allow_cross_volume: z
    .boolean()
    .default(false)
    .describe(
      "If true and rename fails with EXDEV, fall back to a non-atomic copy + delete. Default false (fail-fast).",
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  moved: z.literal(true),
  src: z.string(),
  dst: z.string(),
  atomic: z.boolean(),
} as const;

interface MoveResult extends Record<string, unknown> {
  moved: true;
  src: string;
  dst: string;
  atomic: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function moveImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<MoveResult>> {
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

  try {
    await fs.rename(srcReal, dstReal);
    return ok({ moved: true, src: srcReal, dst: dstReal, atomic: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "EXDEV") {
      return fromNodeError(err, "rename failed");
    }

    // v0.3 amendment: opt-in fallback for cross-volume moves. The fallback
    // is non-atomic (copy then delete src) — the result envelope flags this
    // via atomic:false so callers can decide whether the operation is
    // tolerable.
    if (!args.allow_cross_volume) {
      return buildError("EIO", "cross-volume move requires allow_cross_volume=true", {
        hint: "Pass allow_cross_volume=true to enable a non-atomic copy+delete fallback.",
        details: { src: srcReal, dst: dstReal, errno: "EXDEV" },
      });
    }

    const copyRes = await copyImpl(
      { src: srcReal, dst: dstReal, overwrite: false, recursive: true },
      config,
    );
    if (!copyRes.ok) {
      return buildError(copyRes.error.code, `cross-volume move failed during copy: ${copyRes.error.message}`, {
        details: { src: srcReal, dst: dstReal, ...(copyRes.error.details ?? {}) },
        hint: copyRes.error.hint,
      });
    }
    try {
      await fs.rm(srcReal, { recursive: true, force: true });
    } catch (rmErr) {
      // Source still exists, destination already written. Surface the failure
      // so callers can decide whether to retry the delete or accept a
      // duplicated tree.
      return buildError(
        "EIO",
        `cross-volume move: copy succeeded but source delete failed: ${(rmErr as Error).message}`,
        {
          details: { src: srcReal, dst: dstReal, errno: "EXDEV", phase: "delete" },
          hint: "Inspect both paths; the destination contains the data.",
        },
      );
    }
    return ok({ moved: true, src: srcReal, dst: dstReal, atomic: false });
  }
}

export function registerMoveTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "move",
    {
      title: "Rename / move file or directory",
      description: `Rename or move a path. Both src and dst must resolve inside allowedRoots after
realpath canonicalisation. \`fs.rename\` is used first — atomic on a single NTFS volume.

Cross-volume moves: by default returns EIO with errno:EXDEV in details. Pass
\`allow_cross_volume: true\` to opt in to a non-atomic copy+delete fallback. The response
envelope's \`atomic\` flag distinguishes the two paths so callers can audit which moves
were race-free.

Args:
  - src (string): Absolute path inside allowedRoots (must exist)
  - dst (string): Absolute path inside allowedRoots
  - overwrite (boolean, default false): if false and dst exists, returns EEXIST
  - allow_cross_volume (boolean, default false): opt-in non-atomic fallback on EXDEV

Returns: { moved: true, src, dst, atomic }
Errors: EPERM_ROOT (either side), ENOENT (src), EEXIST (dst exists + overwrite=false), EIO.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "move", config }, args, (a) => moveImpl(a as Input, config)),
  );
}
