import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result } from "../../core/errors.js";
import { sanitizedPathDirs } from "../../core/exec_safety.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  path_dirs: z.array(z.string()),
  total: z.number().int().nonnegative(),
} as const;

interface ListPathDirsResult extends Record<string, unknown> {
  path_dirs: string[];
  total: number;
}

export async function listPathDirsImpl(
  _args: Input,
  config: ResolvedConfig,
): Promise<Result<ListPathDirsResult>> {
  const dirs = sanitizedPathDirs(config);
  return ok({ path_dirs: dirs, total: dirs.length });
}

export function registerListPathDirsTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "list_path_dirs",
    {
      title: "List the sanitized PATH directories subprocesses see",
      description: `Return the sanitized PATH array that \`execute_command\`, \`run_python\`,
\`run_pytest\`, and \`find_command\` inherit. Use it to debug "why is binary X
invisible" without trial-and-error: if a directory isn't in this list, the
subprocess can't see binaries in it.

Includes Windows System32, PowerShell 5.1 / 7, Git CLI directories, the
default Node install location, and (when configured) \`pythonHome\`. The
caller's interactive \$PATH is **not** inherited — that's the point: a
subprocess is sandboxed to a deterministic, audit-friendly set of binaries.

Args: none.
Returns: { path_dirs: string[], total: number }.
Errors: ETIMEDOUT (wrapper deadline; effectively unreachable for an in-memory
constant-time tool).`,
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
      runTool({ tool: "list_path_dirs", config }, args, (a) =>
        listPathDirsImpl(a as Input, config),
      ),
  );
}
