import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import type { ProcessRegistry } from "../../core/process_registry.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { checkExecBlocklist } from "../../core/exec_safety.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_TIMEOUT_SECONDS = 300;

const InputShape = {
  command: z
    .array(z.string().min(1).max(8 * 1024))
    .min(1, "command must be a non-empty argv array")
    .max(64, "command argv too long")
    .describe("Argv array. Spawned with shell:false — caller is responsible for argument quoting."),
  cwd: AbsolutePath.optional().describe("Working directory; must be inside allowedRoots. Defaults to allowedRoots[0]."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra env vars merged on top of the sanitized exec env. PATH/Path/PATHEXT are pinned (a PATH/PATHEXT key here is ignored — the sanitized PATH and standard PATHEXT always win); GIT_TERMINAL_PROMPT defaults to '0' but may be overridden."),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Per-session deadline. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}.`),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  session_id: z.string(),
  started_at: z.string(),
  status: z.union([
    z.literal("running"),
    z.literal("spawn_failed"),
  ]),
  command_prefix: z.string(),
} as const;

interface StartProcessResult extends Record<string, unknown> {
  session_id: string;
  started_at: string;
  status: "running" | "spawn_failed";
  command_prefix: string;
}

interface StartProcessAuditExtras {
  command_prefix: string;
  command_length: number;
  cwd: string;
  env_key_count: number;
  timeout_seconds: number;
  session_id: string;
  status: string;
}

const auditByResult = new WeakMap<object, StartProcessAuditExtras>();

export function getStartProcessAuditExtras(value: StartProcessResult): StartProcessAuditExtras | undefined {
  return auditByResult.get(value);
}

export async function startProcessImpl(
  args: Input,
  config: ResolvedConfig,
  registry: ProcessRegistry,
): Promise<Result<StartProcessResult>> {
  // Blocklist check on the joined argv (same patterns as execute_command).
  const composed = args.command.join(" ");
  const blocked = checkExecBlocklist(composed, config);
  if (blocked) return blocked;

  // cwd → realpath via checkAllowed.
  let cwd: string;
  if (args.cwd !== undefined) {
    const cwdCheck = await checkAllowed(args.cwd, config);
    if ("ok" in cwdCheck && cwdCheck.ok === false) return cwdCheck;
    cwd = (cwdCheck as { realPath: string }).realPath;
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) {
        return buildError("ENOTDIR", "cwd is not a directory", { details: { cwd } });
      }
    } catch (err) {
      return buildError("ENOENT", "cwd does not exist", {
        details: { cwd, cause: (err as Error).message },
      });
    }
  } else {
    if (config.resolvedAllowedRoots.length === 0) {
      return buildError("EPERM_ROOT", "no allowedRoots configured; cwd is required", {
        hint: "Add at least one entry to config.allowedRoots, or pass an explicit cwd inside one.",
      });
    }
    cwd = config.resolvedAllowedRoots[0]!;
  }

  // Concurrency cap.
  if (registry.runningCount() >= config.processMaxConcurrent) {
    return buildError("EBUSY", `process concurrency cap reached (${config.processMaxConcurrent} running sessions)`, {
      details: {
        running: registry.runningCount(),
        max_concurrent: config.processMaxConcurrent,
      },
      hint: "Wait for an existing session to settle, or call kill_process on a stale one.",
    });
  }

  const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const extraEnv = args.env ?? {};

  const session = await registry.spawn(args.command, cwd, extraEnv, timeoutSeconds);

  const value: StartProcessResult = {
    session_id: session.session_id,
    started_at: session.started_at,
    status: session.status === "spawn_failed" ? "spawn_failed" : "running",
    command_prefix: composed.slice(0, 256),
  };

  auditByResult.set(value, {
    command_prefix: composed.slice(0, 256),
    command_length: composed.length,
    cwd,
    env_key_count: Object.keys(extraEnv).length,
    timeout_seconds: timeoutSeconds,
    session_id: session.session_id,
    status: session.status,
  });
  return ok(value);
}

export function registerStartProcessTool(server: McpServer, ctx: ToolContext): void {
  const { config, registry } = ctx;
  server.registerTool(
    "start_process",
    {
      title: "Spawn a long-running child process and return its session id",
      description: `Spawn a child process via \`child_process.spawn(argv[0], argv.slice(1), { shell: false })\`
and register it in the in-memory ProcessRegistry. Returns immediately with a
\`session_id\` that subsequent calls to \`interact\`, \`list_process\`, and
\`kill_process\` use to address the session.

Defenses:
- argv[0] (joined argv string) is checked against the exec blocklist (same
  patterns as execute_command).
- cwd must be inside allowedRoots (defaults to allowedRoots[0]).
- env extends the sanitized exec env (subprocess PATH is sanitizedPath — user
  $PATH is NOT inherited).
- Concurrency: max ${config.processMaxConcurrent} running sessions
  (config.processMaxConcurrent). 17th call → EBUSY.
- Per-session deadline (timeout_seconds, default ${DEFAULT_TIMEOUT_SECONDS},
  max ${MAX_TIMEOUT_SECONDS}). On fire, the registry SIGKILLs the child and
  the session settles as \`timed_out\`.
- stdin is piped so \`interact\` can write to it. stdout/stderr captured to
  per-stream buffers capped at ${config.processBufferCap} bytes (overflow
  flagged via \`truncated_*\`).

Args:
  - command (string[]): argv, length 1..64
  - cwd (string, optional): inside allowedRoots
  - env (object, optional): extra env vars (string → string)
  - timeout_seconds (number, optional)

Returns: { session_id, started_at, status, command_prefix }
  - \`status\` is \`running\` on the happy path, or \`spawn_failed\` if the OS
    rejected the binary (e.g. ENOENT for argv[0]).

Errors: EBLOCKED (blocklist), EPERM_ROOT, ENOTDIR, ENOENT (cwd missing),
EBUSY (concurrency cap).

Audit (mutation): command_prefix, command_length, cwd, env_key_count,
timeout_seconds, session_id, status. Carries \`mode\`. Full command body
is NEVER persisted.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "start_process",
          config,
          auditExtras: (result) => {
            if (!result.ok) {
              return {
                command_prefix: ((args as Input).command ?? []).join(" ").slice(0, 256),
                command_length: ((args as Input).command ?? []).join(" ").length,
              };
            }
            const extras = getStartProcessAuditExtras(result.value as StartProcessResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a) => startProcessImpl(a as Input, config, registry),
      ),
  );
}
