import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { atomicWriteFile } from "../../core/atomic_write.js";
import { encodeUtf8NoBom } from "../../core/utf8.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
  content: z
    .string()
    .describe("Full file contents, UTF-8. Written atomically (no BOM)."),
  overwrite: z
    .boolean()
    .default(true)
    .describe("If false and file exists, returns EEXIST."),
  mkdirParents: z
    .boolean()
    .default(false)
    .describe("Create missing parent directories before writing."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  bytes_written: z.number().int().nonnegative(),
  lines_written: z.number().int().nonnegative(),
  created: z.boolean(),
} as const;

interface WriteResult extends Record<string, unknown> {
  bytes_written: number;
  lines_written: number;
  created: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeImpl(args: Input, config: ResolvedConfig): Promise<Result<WriteResult>> {
  const check = await checkAllowed(args.path, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  const parent = path.dirname(realPath);
  const parentExists = await exists(parent);
  if (!parentExists) {
    if (!args.mkdirParents) {
      return buildError("ENOENT", `Parent directory does not exist: ${parent}`, {
        hint: "Pass mkdirParents:true to create it.",
      });
    }
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (err) {
      return fromNodeError(err, "mkdir parent failed");
    }
  }

  const fileExists = await exists(realPath);
  if (fileExists && !args.overwrite) {
    return buildError("EEXIST", `File exists and overwrite=false`, {
      hint: "Pass overwrite=true if intended.",
      details: { path: realPath },
    });
  }

  const buf = encodeUtf8NoBom(args.content);

  try {
    await atomicWriteFile(realPath, buf);
  } catch (err) {
    return fromNodeError(err, "atomic write failed");
  }

  return ok({
    bytes_written: buf.length,
    lines_written: args.content.length === 0 ? 0 : args.content.split(/\r?\n/).length,
    created: !fileExists,
  });
}

export function registerWriteTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "write",
    {
      title: "Atomic write (overwrite) UTF-8 file",
      description: `Atomically write a UTF-8 text file. Uses temp + fsync + rename, so partial writes
are impossible if the process is killed mid-flight. Never writes a BOM.

Args:
  - path (string): Absolute path inside allowedRoots
  - content (string): UTF-8 content (any length, capped by atomic write memory)
  - overwrite (boolean, default true): if false and target exists, returns EEXIST
  - mkdirParents (boolean, default false): create missing parent directories

Returns: { bytes_written, lines_written, created }
Errors: EPERM_ROOT, EEXIST (overwrite=false), ENOENT (parent missing), EIO, ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "write", config }, args, (a) => writeImpl(a as Input, config)),
  );
}
