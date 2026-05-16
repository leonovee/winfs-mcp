import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";

const InputShape = {
  src: AbsolutePath.describe("Source path inside allowedRoots (must exist)."),
  dst: AbsolutePath.describe("Destination path inside allowedRoots."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("If false and dst exists, returns EEXIST."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  moved: z.literal(true),
  src: z.string(),
  dst: z.string(),
} as const;

interface MoveResult extends Record<string, unknown> {
  moved: true;
  src: string;
  dst: string;
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
  // Spec §2.2 + v0.2 amendment §A: BOTH paths must be inside allowedRoots.
  const srcCheck = await checkAllowed(args.src, config);
  if ("ok" in srcCheck && srcCheck.ok === false) return srcCheck;
  const srcReal = (srcCheck as { realPath: string }).realPath;

  // dst may not exist yet — allowMissing for the destination side only.
  const dstCheck = await checkAllowed(args.dst, config, { allowMissing: true });
  if ("ok" in dstCheck && dstCheck.ok === false) {
    // Surface both paths in details for debuggability.
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
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EXDEV") {
      // v0.2 amendment §A: cross-volume rename = fail-fast, no silent fallback.
      return buildError("EIO", "cross-volume move is not supported in v0.2", {
        hint: "Source and destination must be on the same drive. v0.3 will add an opt-in copy+delete fallback.",
        details: { src: srcReal, dst: dstReal, errno: "EXDEV" },
      });
    }
    return fromNodeError(err, "rename failed");
  }

  return ok({ moved: true, src: srcReal, dst: dstReal });
}

export function registerMoveTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "move",
    {
      title: "Rename / move file or directory (same volume only)",
      description: `Rename or move a path. Both src and dst must resolve inside allowedRoots after
realpath canonicalisation. Uses fs.rename which is atomic on a single NTFS volume; cross-volume
moves fail-fast with EIO + errno:EXDEV in details (no silent copy-delete fallback in v0.2).

Args:
  - src (string): Absolute path inside allowedRoots (must exist)
  - dst (string): Absolute path inside allowedRoots
  - overwrite (boolean, default false): if false and dst exists, returns EEXIST

Returns: { moved: true, src, dst }
Errors: EPERM_ROOT (either side), ENOENT (src), EEXIST (dst exists + overwrite=false), EIO (incl. cross-volume).`,
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
