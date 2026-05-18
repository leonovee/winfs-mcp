import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import type { ProcessRegistry } from "../../core/process_registry.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";

const InputShape = {
  session_id: z.string().min(1),
  force: z
    .boolean()
    .optional()
    .describe("If true, immediate SIGKILL / taskkill /F /T. Default false → graceful SIGTERM / taskkill /T then SIGKILL after 5 s grace."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  session_id: z.string(),
  killed: z.boolean(),
  was_already_settled: z.boolean(),
  status: z.union([
    z.literal("running"),
    z.literal("exited"),
    z.literal("killed"),
    z.literal("timed_out"),
    z.literal("spawn_failed"),
  ]),
  exit_code: z.number().int().nullable(),
} as const;

interface KillResult extends Record<string, unknown> {
  session_id: string;
  killed: boolean;
  was_already_settled: boolean;
  status: string;
  exit_code: number | null;
}

export async function killProcessImpl(
  args: Input,
  registry: ProcessRegistry,
): Promise<Result<KillResult>> {
  const session = registry.get(args.session_id);
  if (!session) {
    return buildError("ENOSESSION", `session_id not found in registry: ${args.session_id}`, {
      details: { session_id: args.session_id },
      hint: "Sessions are retained for processSessionTtlMs after settle (default 60 s). Past that, the id is gone.",
    });
  }

  // Idempotent: settled sessions are a no-op.
  if (session.status !== "running") {
    return ok({
      session_id: session.session_id,
      killed: false,
      was_already_settled: true,
      status: session.status,
      exit_code: session.exit_code,
    });
  }

  const force = args.force === true;
  const killed = await registry.kill(session.session_id, force);

  return ok({
    session_id: session.session_id,
    killed,
    was_already_settled: false,
    status: session.status,
    exit_code: session.exit_code,
  });
}

export function registerKillProcessTool(
  server: McpServer,
  config: ResolvedConfig,
  registry: ProcessRegistry,
): void {
  server.registerTool(
    "kill_process",
    {
      title: "Terminate a process session (graceful or forced)",
      description: `Terminate a running session. Idempotent: calling on an already-settled
session returns \`killed: false, was_already_settled: true\` plus the
preserved exit_code.

Platform behaviour (Windows):
  - \`force: false\` (default) → \`taskkill /T /PID <pid>\` (no /F). Posts
    WM_CLOSE to GUI processes; console apps may terminate immediately.
    5 s grace, then escalates to SIGKILL.
  - \`force: true\` → \`taskkill /F /T /PID <pid>\` (force, tree, no grace).

Platform behaviour (POSIX):
  - \`force: false\` → SIGTERM, 5 s grace, then SIGKILL.
  - \`force: true\` → immediate SIGKILL.

Args:
  - session_id (string)
  - force (boolean, optional, default false)

Returns: { session_id, killed, was_already_settled, status, exit_code }
  - \`killed: true\` iff the call actually requested termination of a running
    child. \`false\` for the idempotent no-op path.

Errors: ENOSESSION (id not in registry).

Audit (mutation): session_id, force, killed, was_already_settled.
Carries \`mode\`.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "kill_process",
          config,
          // Kill may take up to 5 s grace + 2 s final-wait inside registry.
          timeoutMs: Math.max(config.maxTimeoutMs, 10_000),
          auditExtras: (result) => {
            const base: Record<string, unknown> = {
              session_id: (args as Input).session_id,
              force: (args as Input).force === true,
            };
            if (result.ok) {
              const v = result.value as KillResult;
              base.killed = v.killed;
              base.was_already_settled = v.was_already_settled;
              base.session_status = v.status;
            }
            return base;
          },
        },
        args,
        (a) => killProcessImpl(a as Input, registry),
      ),
  );
}
