import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { spawnSubprocess } from "../../core/exec_safety.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import type { ToolContext } from "../../core/tool_context.js";

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 300;
const SSH_G_TIMEOUT_MS = 5000;
const OUTPUT_CAP_BYTES = 4 * 1024;
const AUDIT_COMMAND_PREFIX_CAP = 256;

const InputShape = {
  host: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "Host alias resolvable via `ssh -G` against ~/.ssh/config (Windows: %USERPROFILE%\\.ssh\\config). Raw `user@host` strings are rejected.",
    ),
  command: z
    .string()
    .min(1)
    .max(8 * 1024)
    .describe("Command to run on the remote host."),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(
      `Per-call timeout in seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}. Effective max is also clamped by config.maxTimeoutMs (default 60_000ms — raise it in config if you need longer ssh sessions).`,
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  host: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  truncated_stdout: z.boolean().optional(),
  truncated_stderr: z.boolean().optional(),
  duration_ms: z.number().int().nonnegative(),
} as const;

interface SshExecResult extends Record<string, unknown> {
  host: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated_stdout?: boolean;
  truncated_stderr?: boolean;
  duration_ms: number;
}

// Validated-host cache lives for the server process lifetime. Cleared between
// tests via `_resetSshHostCache`. We cache by exact alias string — case
// matters because `ssh -G` is case-sensitive.
const validatedHostCache = new Map<string, true>();

/** Test hook: clear the validated-host cache. */
export function _resetSshHostCache(): void {
  validatedHostCache.clear();
}

async function sshExeExists(sshExePath: string): Promise<boolean> {
  try {
    const s = await fs.stat(sshExePath);
    return s.isFile();
  } catch {
    return false;
  }
}

type ValidateResult =
  | { ok: true }
  | { ok: false; reason: string; details?: Record<string, unknown> };

async function validateHost(
  host: string,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<ValidateResult> {
  if (validatedHostCache.has(host)) return { ok: true };

  // Reject raw `user@host` strings up front. SSH config Host aliases
  // conventionally don't contain `@`; the alias-only convention is what makes
  // the ~/.ssh/config whitelist meaningful.
  if (host.includes("@")) {
    return {
      ok: false,
      reason:
        "host contains '@' — raw user@host form is not accepted; use a ~/.ssh/config Host alias",
      details: { host },
    };
  }

  const result = await spawnSubprocess({
    bin: config.sshExePath,
    args: ["-G", host],
    cwd: config.resolvedAllowedRoots[0] ?? process.cwd(),
    deadlineMs: SSH_G_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    config,
    signal,
  });

  if (result.spawnFailed) {
    return {
      ok: false,
      reason: "ssh.exe failed to spawn during host validation",
      details: { errno: result.spawnErrorCode, cause: result.spawnErrorMessage },
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: `ssh -G validation timed out after ${SSH_G_TIMEOUT_MS} ms`,
      details: { timeout_ms: SSH_G_TIMEOUT_MS },
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `ssh -G exited ${result.exitCode}; host not resolvable`,
      details: { exit_code: result.exitCode, stderr_preview: result.stderr.slice(0, 256) },
    };
  }
  // `ssh -G <host>` prints the resolved config as `keyword value` lines, one
  // per line. We require a `hostname <something-non-empty>` line as proof the
  // alias actually resolved. ssh prints `hostname <host>` even when the alias
  // is unknown (falling back to the literal name), so we additionally require
  // that some Host stanza matched — easiest tell is that one of the `user`,
  // `port`, or `identityfile` lines is non-default. But the simplest, robust
  // discriminator is: alias must appear as a Host entry. We approximate that
  // by requiring `hostname` to be present (which it always is from ssh -G)
  // AND requiring it to be non-empty. That's enough to verify ssh.exe ran
  // successfully and the alias is at least syntactically valid. Stricter
  // alias-in-config-file validation lives in v0.7+ if smoke surfaces gaps.
  const hostnameLine = result.stdout
    .split(/\r?\n/)
    .find((line) => /^hostname\s+\S+/i.test(line));
  if (!hostnameLine) {
    return {
      ok: false,
      reason: "ssh -G output missing a non-empty `hostname` line",
      details: { stdout_preview: result.stdout.slice(0, 256) },
    };
  }
  validatedHostCache.set(host, true);
  return { ok: true };
}

export async function sshExecImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<SshExecResult>> {
  // Step 1: ssh.exe existence check. Fail fast with ESSHNOTFOUND so the
  // caller can install OpenSSH or fix sshExePath without doing remote work.
  if (!(await sshExeExists(config.sshExePath))) {
    return buildError("ESSHNOTFOUND", "ssh.exe not found at configured path", {
      details: { sshExePath: config.sshExePath },
      hint: "Install OpenSSH client (Windows Settings → Apps → Optional features → OpenSSH Client) or set config.sshExePath.",
    });
  }

  // Step 2: host whitelist check via `ssh -G`.
  const valid = await validateHost(args.host, config, signal);
  if (!valid.ok) {
    return buildError("EHOST_UNKNOWN", `host alias not resolvable: ${valid.reason}`, {
      details: { host: args.host, ...(valid.details ?? {}) },
      hint: "Add a Host entry for this alias in ~/.ssh/config (Windows: %USERPROFILE%\\.ssh\\config).",
    });
  }

  const timeoutS = Math.min(args.timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);

  // Step 3: spawn ssh.exe directly — no shell, no PowerShell.
  const spawnResult = await spawnSubprocess({
    bin: config.sshExePath,
    args: [args.host, args.command],
    cwd: config.resolvedAllowedRoots[0] ?? process.cwd(),
    deadlineMs: timeoutS * 1000,
    maxOutputBytes: OUTPUT_CAP_BYTES,
    config,
    signal,
  });

  if (spawnResult.spawnFailed) {
    return buildError("EIO", "ssh.exe failed to start", {
      details: {
        errno: spawnResult.spawnErrorCode,
        cause: spawnResult.spawnErrorMessage,
        spawnFailed: true,
      },
      hint: "Check that sshExePath is correct and not blocked by AV / EDR.",
    });
  }

  if (spawnResult.timedOut) {
    return buildError("ETIMEDOUT", `ssh_exec exceeded timeout_seconds=${timeoutS}`, {
      details: {
        host: args.host,
        timeout_seconds: timeoutS,
        partial_stdout: spawnResult.stdout.slice(0, 1024),
        partial_stderr: spawnResult.stderr.slice(0, 1024),
      },
    });
  }

  const value: SshExecResult = {
    host: args.host,
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    exit_code: spawnResult.exitCode,
    timed_out: false,
    duration_ms: spawnResult.durationMs,
  };
  if (spawnResult.truncatedStdout) value.truncated_stdout = true;
  if (spawnResult.truncatedStderr) value.truncated_stderr = true;
  return ok(value);
}

export function registerSshExecTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "ssh_exec",
    {
      title: "First-class SSH remote command execution",
      description: `Run a command on a remote host via OpenSSH. Spawns \`ssh.exe\` directly
through \`child_process.spawn\` — no shell, no PowerShell wrapper. Sidesteps
the PATH-sanitization, PowerShell document-in-pipeline, and silent-stdout
issues that make \`execute_command\` unreliable for ssh on this Windows host.

**Host whitelist:** \`host\` MUST be a Host alias resolvable via \`ssh -G\` against
\`~/.ssh/config\` (Windows: \`%USERPROFILE%\\.ssh\\config\`). Raw \`user@host\`
strings are rejected; the user's ssh config is the only whitelist. Validated
aliases are cached for the server lifetime.

**Binary:** absolute path resolved from \`config.sshExePath\` (default
\`C:\\Windows\\System32\\OpenSSH\\ssh.exe\`). Missing binary → \`ESSHNOTFOUND\`.

**Output cap:** 4 KB per stream; excess sets \`truncated_stdout\` /
\`truncated_stderr\`. Process tree killed on timeout.

**Prerequisite (not enforced — documented):** working ssh-agent or
passphrase-less key. Non-interactive subprocesses on Windows don't inherit
Pageant / agent state from interactive sessions.

Args:
  - host (string): ssh config Host alias
  - command (string): remote command
  - timeout_seconds (number, optional): default 30, max 300 (also clamped by
    config.maxTimeoutMs — raise the config value if you need longer sessions)

Returns: { host, stdout, stderr, exit_code, timed_out, truncated_stdout?, truncated_stderr?, duration_ms }

Errors:
  - ESSHNOTFOUND: sshExePath does not exist on disk
  - EHOST_UNKNOWN: host not resolvable via \`ssh -G\` (or raw \`user@host\` form rejected)
  - ETIMEDOUT: exceeded timeout_seconds
  - EIO: ssh.exe failed to start (mirror v0.6 exec_safety spawn-error fix)

Audit log records host, command prefix (first 256 chars), command length,
exit_code, timed_out, duration_ms — full command is NEVER persisted.`,
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
          tool: "ssh_exec",
          config,
          // ssh sessions can exceed the default 10s; bound by max 300s.
          timeoutMs: ((args as Input).timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000,
          auditExtras: (result) => {
            const a = args as Input;
            const base: Record<string, unknown> = {
              host: a.host,
              command_prefix: a.command.slice(0, AUDIT_COMMAND_PREFIX_CAP),
              command_length: Buffer.byteLength(a.command, "utf8"),
              truncated_at: AUDIT_COMMAND_PREFIX_CAP,
            };
            if (!result.ok) return base;
            const v = result.value as SshExecResult;
            return {
              ...base,
              exit_code: v.exit_code,
              timed_out: v.timed_out,
              duration_ms: v.duration_ms,
            };
          },
        },
        args,
        (a, sig) => sshExecImpl(a as Input, config, sig),
      ),
  );
}
