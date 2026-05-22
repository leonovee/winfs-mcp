import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { atomicAppend } from "../../core/atomic_write.js";
import { encodeUtf8NoBom } from "../../core/utf8.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
  content: z.string().describe("UTF-8 text appended verbatim. No newline added."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  bytes_added: z.number().int().nonnegative(),
  new_size: z.number().int().nonnegative(),
} as const;

interface AppendResult extends Record<string, unknown> {
  bytes_added: number;
  new_size: number;
}

export async function appendImpl(args: Input, config: ResolvedConfig): Promise<Result<AppendResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let beforeSize = 0;
  try {
    const st = await fs.stat(realPath);
    if (st.isDirectory()) {
      return buildError("EISDIR", "Cannot append to a directory", { details: { path: realPath } });
    }
    beforeSize = st.size;
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }

  const addition = encodeUtf8NoBom(args.content);

  try {
    await atomicAppend(realPath, addition);
  } catch (err) {
    return fromNodeError(err, "atomic append failed");
  }

  return ok({
    bytes_added: addition.length,
    new_size: beforeSize + addition.length,
  });
}

export function registerAppendTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "append",
    {
      title: "Atomic append UTF-8 to existing file",
      description: `Append UTF-8 text to an existing file atomically. Implementation reads the existing
file, concatenates the addition, and atomically writes the combined buffer via temp + fsync + rename.
No newline is inserted — caller controls line separators.

Args:
  - path (string): Absolute path inside allowedRoots (must exist)
  - content (string): UTF-8 text to append

Returns: { bytes_added, new_size }
Errors: EPERM_ROOT, ENOENT, EISDIR, EIO, ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "append", config }, args, (a) => appendImpl(a as Input, config)),
  );
}
