import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { auditContentFields } from "../../core/audit.js";
import { spawnSubprocess } from "../../core/exec_safety.js";
import { resolveSshBin } from "../../core/ssh_resolver.js";
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
      `Per-call timeout in seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S} (the full ${MAX_TIMEOUT_S}s is honored — no longer clamped to config.maxTimeoutMs).`,
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
  sshBin: string,
  signal?: AbortSignal,
): Promise<ValidateResult> {
  if (validatedHostCache.has(host)) return { ok: true };

  // Reject raw `user@host` strings up front. SSH config Host aliases
  // conventionally don't contain `@`; rejecting `@` keeps the input in the
  // alias form `ssh -G` resolves against ~/.ssh/config.
  if (host.includes("@")) {
    return {
      ok: false,
      reason:
        "host contains '@' — raw user@host form is not accepted; use a ~/.ssh/config Host alias",
      details: { host },
    };
  }

  const result = await spawnSubprocess({
    bin: sshBin,
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
  // `ssh -G <host>` prints the resolved config as `keyword value` lines. We
  // require a non-empty `hostname` line as proof ssh.exe ran and the alias is
  // syntactically resolvable. IMPORTANT: ssh prints `hostname <literal>` even
  // for an UNKNOWN alias (it falls back to the literal name), so this check
  // does NOT prove the alias is defined in ~/.ssh/config — it is resolvability
  // validation, NOT a security allowlist. The enforced allowlist is
  // config.allowedSshHosts (checked in sshExecImpl before any spawn).
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
  // GPT-review #1 — enforced host allowlist. When config.allowedSshHosts is set,
  // `host` MUST be an exact member, checked BEFORE any ssh.exe spawn. This is
  // the real security control. The `ssh -G` step below only validates that the
  // alias is syntactically resolvable (ssh prints `hostname <literal>` even for
  // unknown aliases), so it is NOT a whitelist — never call it one. An empty
  // array is a valid strictest config that blocks every host.
  if (
    config.allowedSshHosts !== undefined &&
    !config.allowedSshHosts.includes(args.host)
  ) {
    return buildError("EHOST_UNKNOWN", "host is not in the config.allowedSshHosts allowlist", {
      details: { host: args.host, allowed_count: config.allowedSshHosts.length },
      hint: "Add this Host alias to config.allowedSshHosts, or remove allowedSshHosts to fall back to `ssh -G` resolvability validation.",
    });
  }

  // Resolve the ssh binary: explicit config.sshExePath (strict), else
  // auto-detect (Git-bundled preferred over the often-broken System32 one).
  const sshBin = resolveSshBin(config);

  // Step 1: ssh.exe existence check. Fail fast with ESSHNOTFOUND so the
  // caller can install OpenSSH or fix sshExePath without doing remote work.
  if (!(await sshExeExists(sshBin))) {
    return buildError("ESSHNOTFOUND", "ssh.exe not found at resolved path", {
      details: { sshExePath: sshBin, configured: config.sshExePath ?? "(auto-detect)" },
      hint: "Install OpenSSH client (Windows Settings → Apps → Optional features → OpenSSH Client), install Git for Windows (bundles ssh), or set config.sshExePath.",
    });
  }

  // Step 2: host resolvability validation via `ssh -G` (NOT an allowlist; the
  // enforced allowlist is config.allowedSshHosts, checked above).
  const valid = await validateHost(args.host, config, sshBin, signal);
  if (!valid.ok) {
    return buildError("EHOST_UNKNOWN", `host alias not resolvable: ${valid.reason}`, {
      details: { host: args.host, ...(valid.details ?? {}) },
      hint: "Add a Host entry for this alias in ~/.ssh/config (Windows: %USERPROFILE%\\.ssh\\config).",
    });
  }

  const timeoutS = Math.min(args.timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);

  // Step 3: spawn ssh.exe directly — no shell, no PowerShell.
  const spawnResult = await spawnSubprocess({
    bin: sshBin,
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

**Host allowlist:** set \`config.allowedSshHosts\` to an array of Host aliases to
ENFORCE an allowlist — any \`host\` not in it is rejected with EHOST_UNKNOWN
before ssh runs. When \`allowedSshHosts\` is unset, \`host\` is only validated for
RESOLVABILITY via \`ssh -G\` against \`~/.ssh/config\` (Windows:
\`%USERPROFILE%\\.ssh\\config\`): that proves the alias resolves, NOT that it is a
configured Host (ssh echoes \`hostname <literal>\` even for unknown aliases), so
on its own it is NOT a security boundary. Raw \`user@host\` strings are always
rejected. Validated aliases are cached for the server lifetime.

**Binary:** \`config.sshExePath\` when set (used strictly); otherwise
auto-detected — Git-bundled \`C:\\Program Files\\Git\\usr\\bin\\ssh.exe\`
(preferred, since the System32 OpenSSH client exits 255 on some hosts), then
\`C:\\Windows\\System32\\OpenSSH\\ssh.exe\`, then PATH. Missing → \`ESSHNOTFOUND\`.

**Output cap:** 4 KB per stream; excess sets \`truncated_stdout\` /
\`truncated_stderr\`. Process tree killed on timeout.

**Prerequisite (not enforced — documented):** working ssh-agent or
passphrase-less key. Non-interactive subprocesses on Windows don't inherit
Pageant / agent state from interactive sessions.

Args:
  - host (string): ssh config Host alias
  - command (string): remote command
  - timeout_seconds (number, optional): default 30, max 300 (full 300s honored)

Returns: { host, stdout, stderr, exit_code, timed_out, truncated_stdout?, truncated_stderr?, duration_ms }

Errors:
  - ESSHNOTFOUND: sshExePath does not exist on disk
  - EHOST_UNKNOWN: host not in config.allowedSshHosts (when set), not resolvable via \`ssh -G\`, or raw \`user@host\` form rejected
  - ETIMEDOUT: exceeded timeout_seconds
  - EIO: ssh.exe failed to start (mirror v0.6 exec_safety spawn-error fix)

Audit log records host, the SHA-256 digest + byte length of the command,
exit_code, timed_out, duration_ms — the command text is NEVER persisted (set
config.auditVerbose=true to ALSO record a 256-char prefix for debugging).`,
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
          // ssh sessions can exceed the default 10s; bound by max 300s. The
          // maxTimeoutMs override raises runTool's outer ceiling so the full
          // 300s is honored (previously clamped to config.maxTimeoutMs=60s).
          timeoutMs: ((args as Input).timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000,
          maxTimeoutMs: MAX_TIMEOUT_S * 1000,
          auditExtras: (result) => {
            const a = args as Input;
            // GPT-review #3: sha256 + byte length by default; the remote command
            // prefix only when config.auditVerbose (it can carry a secret).
            const base: Record<string, unknown> = {
              host: a.host,
              ...auditContentFields("command", a.command, config.auditVerbose, AUDIT_COMMAND_PREFIX_CAP),
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
