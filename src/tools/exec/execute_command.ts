import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { checkExecBlocklist, spawnSubprocess } from "../../core/exec_safety.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { AbsolutePath } from "../../schemas/common.js";

const MAX_COMMAND_LEN = 8 * 1024;
const MAX_ARGS_LEN = 64;

const InputShape = {
  command: z
    .string()
    .min(1, "command must be non-empty")
    .max(MAX_COMMAND_LEN)
    .describe("PowerShell expression. Composed with args (joined by single spaces) before blocklist check."),
  args: z
    .array(z.string().max(2048))
    .max(MAX_ARGS_LEN)
    .default([])
    .describe("Extra args appended to `command` for the composed string. NOT passed as positional pwsh args (those would require shell quoting we don't perform)."),
  cwd: AbsolutePath.optional().describe("Working directory; must be inside allowedRoots. Defaults to allowedRoots[0]."),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative(),
  truncated_stdout: z.boolean(),
  truncated_stderr: z.boolean(),
  timed_out: z.boolean(),
} as const;

interface ExecuteCommandResult extends Record<string, unknown> {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  timed_out: boolean;
}

interface ExecAuditExtras {
  composed_prefix: string;
  composed_length: number;
  stdout_prefix: string;
  stderr_prefix: string;
  truncated_at_audit: number;
}

const auditByResult = new WeakMap<object, ExecAuditExtras>();

export function getExecuteCommandAuditExtras(value: ExecuteCommandResult): ExecAuditExtras | undefined {
  return auditByResult.get(value);
}

const AUDIT_PREFIX_CAP = 4 * 1024;

export async function executeCommandImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<ExecuteCommandResult>> {
  // Compose the full command string. Args are joined with single spaces —
  // caller is responsible for quoting if they need preservation.
  const composed = args.args.length > 0 ? `${args.command} ${args.args.join(" ")}` : args.command;

  // Pre-spawn blocklist check.
  const blocked = checkExecBlocklist(composed, config);
  if (blocked) return blocked;

  // Resolve cwd.
  let cwd: string;
  if (args.cwd !== undefined) {
    const cwdCheck = await checkAllowed(args.cwd, config);
    if ("ok" in cwdCheck && cwdCheck.ok === false) return cwdCheck;
    cwd = (cwdCheck as { realPath: string }).realPath;
    // Verify it's actually a directory.
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

  const deadline = resolveTimeoutMs(
    args.timeout_ms,
    config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );

  // PowerShell as dispatch shell. -NoProfile and -NonInteractive prevent
  // user-profile config from affecting behavior and block interactive prompts.
  const bin = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const psArgs = ["-NoProfile", "-NonInteractive", "-Command", composed];

  const spawnRes = await spawnSubprocess({
    bin,
    args: psArgs,
    cwd,
    deadlineMs: deadline,
    maxOutputBytes: config.execMaxOutputBytes,
    config,
    signal,
  });

  if (spawnRes.spawnFailed) {
    return buildError("EIO", "execute_command failed to spawn PowerShell", {
      details: {
        bin,
        errno: spawnRes.spawnErrorCode,
        cause: spawnRes.spawnErrorMessage,
      },
    });
  }

  const value: ExecuteCommandResult = {
    stdout: spawnRes.stdout,
    stderr: spawnRes.stderr,
    exit_code: spawnRes.exitCode,
    duration_ms: spawnRes.durationMs,
    truncated_stdout: spawnRes.truncatedStdout,
    truncated_stderr: spawnRes.truncatedStderr,
    timed_out: spawnRes.timedOut,
  };
  auditByResult.set(value, {
    composed_prefix: composed.slice(0, 64),
    composed_length: composed.length,
    stdout_prefix: spawnRes.stdout.slice(0, AUDIT_PREFIX_CAP),
    stderr_prefix: spawnRes.stderr.slice(0, AUDIT_PREFIX_CAP),
    truncated_at_audit: AUDIT_PREFIX_CAP,
  });
  return ok(value);
}

export function registerExecuteCommandTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "execute_command",
    {
      title: "Run a PowerShell command (read or write — guarded by blocklist)",
      description: `Run a PowerShell command and capture stdout/stderr/exit code.

Security defenses (spec invariants Step 1 #7–#12):
- Pre-spawn blocklist regex check on the COMPOSED command string. Default
  patterns cover Remove-Item -Recurse, format, bcdedit, reg delete HKLM,
  shutdown, Stop-Process -Force, etc. Match → EBLOCKED with the offending
  pattern in details.
- PowerShell as the only dispatch shell (-NoProfile -NonInteractive).
- Subprocess PATH is SANITIZED (System32, Git, Node, optional pythonHome).
  User \$PATH is NOT inherited. Other env vars inherit unless
  \`config.execSanitizeEnv: true\`.
- cwd must be inside allowedRoots (default: allowedRoots[0]).
- Hard deadline with SIGTERM → SIGKILL escalation; process tree killed on
  Windows via \`taskkill /F /T /PID\`.
- Per-stream output cap (\`config.execMaxOutputBytes\`, default 1 MB).
  Excess bytes dropped; cap-hit kills the subprocess; \`truncated_*\` flags
  set in response.

Args:
  - command (string): PowerShell expression
  - args (string[], default []): extra tokens appended after a space
  - cwd (string, optional): defaults to allowedRoots[0]
  - timeout_ms (number, optional)

Returns: { stdout, stderr, exit_code, duration_ms, truncated_stdout, truncated_stderr, timed_out }

Errors: EPERM_ROOT (cwd outside roots), ENOTDIR (cwd not a directory),
EBLOCKED (blocklist hit, see details.pattern), EIO (spawn failure),
ETIMEDOUT surfaced as \`timed_out: true\` + truncated output (not as an error
code) so callers receive partial diagnostics.

Audit log records command PREFIX (first 64 chars), full length, stdout/stderr
first 4 KB — NEVER full output, NEVER full command (passwords on CLI).`,
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
          tool: "execute_command",
          config,
          auditExtras: (result) => {
            if (!result.ok) {
              return {
                composed_length: ((args as Input).command ?? "").length,
              };
            }
            const extras = getExecuteCommandAuditExtras(result.value as ExecuteCommandResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a, sig) => executeCommandImpl(a as Input, config, sig),
      ),
  );
}
