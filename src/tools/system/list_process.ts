import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import type { ProcessRegistry, SessionSummary } from "../../core/process_registry.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result } from "../../core/errors.js";

const InputShape = {} as const;
export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const SessionSummarySchema = z.object({
  session_id: z.string(),
  command_prefix: z.string(),
  started_at: z.string(),
  status: z.union([
    z.literal("running"),
    z.literal("exited"),
    z.literal("killed"),
    z.literal("timed_out"),
    z.literal("spawn_failed"),
  ]),
  exit_code: z.number().int().nullable(),
  stdout_bytes: z.number().int().nonnegative(),
  stderr_bytes: z.number().int().nonnegative(),
  truncated_stdout: z.boolean(),
  truncated_stderr: z.boolean(),
  settled_at: z.string().nullable(),
});

const OutputShape = {
  sessions: z.array(SessionSummarySchema),
  total: z.number().int().nonnegative(),
} as const;

interface ListProcessResult extends Record<string, unknown> {
  sessions: SessionSummary[];
  total: number;
}

export async function listProcessImpl(
  _args: Input,
  registry: ProcessRegistry,
): Promise<Result<ListProcessResult>> {
  const sessions = registry.list();
  return ok({ sessions, total: sessions.length });
}

export function registerListProcessTool(
  server: McpServer,
  config: ResolvedConfig,
  registry: ProcessRegistry,
): void {
  server.registerTool(
    "list_process",
    {
      title: "Enumerate active and recently-settled process sessions",
      description: `Return a summary of every session in the in-memory ProcessRegistry —
both running and recently-settled (held in the registry for
\`config.processSessionTtlMs\` after settle, default 60 s).

Each entry carries \`session_id\`, \`command_prefix\` (first 256 chars of the
joined argv), \`started_at\`, \`status\` (\`running\` | \`exited\` | \`killed\` |
\`timed_out\` | \`spawn_failed\`), \`exit_code\` (null until settled),
\`stdout_bytes\` / \`stderr_bytes\` (raw byte counts in the per-session capped
buffer), \`truncated_stdout\` / \`truncated_stderr\`, and \`settled_at\`
(null while running).

Sorted by \`started_at\` ascending. Read-only.

Args: (none)
Returns: { sessions: SessionSummary[], total: number }`,
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
      runTool({ tool: "list_process", config }, args, (a) =>
        listProcessImpl(a as Input, registry),
      ),
  );
}
