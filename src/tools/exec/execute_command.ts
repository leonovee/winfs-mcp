import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { auditContentFields } from "../../core/audit.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { checkExecBlocklist } from "../../core/exec_safety.js";
import * as execSafety from "../../core/exec_safety.js";
import { resolvePowershellBin } from "../../core/powershell_resolver.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { diagnoseHints } from "../../core/exec_hints.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_COMMAND_LEN = 8 * 1024;
const MAX_ARGS_LEN = 64;
// The inner spawn deadline is set this far below runTool's outer withTimeout so
// the inner deadline (graceful `timed_out: true` + partial output + tree-kill)
// always fires first. Mirrors grep's OUTER_TIMEOUT_BUFFER_MS.
const OUTER_TIMEOUT_BUFFER_MS = 2000;

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
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Per-call timeout in ms. Default 30000 (shellTimeoutMs). Honored up to the HARD MAX shellMaxTimeoutMs (default 600000 = 10 min) — pass a high value for long builds. NOTE: Claude Desktop applies a SEPARATE ~4-min MCP-transport ceiling upstream; that is not this timeout. On expiry the command is tree-killed and the response carries timed_out:true with partial output (not an error).",
    ),
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
  hints: z.array(z.string()).optional(),
} as const;

interface ExecuteCommandResult extends Record<string, unknown> {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  timed_out: boolean;
  hints?: string[];
}

const auditByResult = new WeakMap<object, Record<string, unknown>>();

export function getExecuteCommandAuditExtras(value: ExecuteCommandResult): Record<string, unknown> | undefined {
  return auditByResult.get(value);
}

const AUDIT_PREFIX_CAP = 4 * 1024;
const COMPOSED_PREFIX_CAP = 64;

export async function executeCommandImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
  /** Inner spawn deadline; when omitted, derived from the shell timeout pair.
   *  The registered tool passes `outer − BUFFER` so the inner deadline (which
   *  surfaces the graceful `timed_out: true`) always fires before runTool's
   *  outer withTimeout. */
  deadlineMsOverride?: number,
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
    // P2.8: discriminant check instead of unsafe cast — if checkAllowed's
    // return shape ever loses `realPath`, the failure is at type-check
    // time (or a clear runtime error) instead of a silent undefined cwd.
    if (!("realPath" in cwdCheck) || typeof cwdCheck.realPath !== "string") {
      return buildError("EIO", "checkAllowed succeeded but did not return realPath", {
        details: { cwd: args.cwd },
      });
    }
    cwd = cwdCheck.realPath;
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

  // Phase B (child-spawn hardening): execute_command is the SHELL one-shot
  // path, so it uses the dedicated shell timeout pair (default 30s, ceiling
  // 300s) rather than the general defaultTimeoutMs/maxTimeoutMs (10s/60s) used
  // by pure-FS tools. A genuinely hung shell child is still bounded and killed
  // (SIGTERM → taskkill /F /T); the per-call timeout_ms override is honored,
  // clamped to shellMaxTimeoutMs. Timeout is surfaced as `timed_out: true`
  // inside the ok() envelope (documented v0.7 contract), never as an error.
  const deadline =
    deadlineMsOverride ??
    resolveTimeoutMs(args.timeout_ms, config.shellTimeoutMs, config.shellMaxTimeoutMs);

  // PowerShell as dispatch shell with v0.7.2 H2 hardening:
  //   -NoProfile         no user profile (else PATH / encoding may shift)
  //   -NonInteractive    no interactive prompts
  //   -OutputFormat Text force plain text on stdout (default is Text for
  //                      powershell.exe / pwsh but several historical contexts
  //                      have leaked CLIXML; pin it explicitly).
  //   -InputFormat None  PowerShell does not try to read stdin; safe even
  //                      though stdio[0] is "ignore" — belt-and-suspenders
  //                      against the documented "pipe-capture hangs PowerShell
  //                      waiting on stdin" pattern.
  //
  // Composed command is wrapped with:
  //   (a) `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` —
  //       forces UTF-8 on stdout regardless of the system OEM code page
  //       (1252 / 437 / 850 / 1251 are common Windows defaults and produce
  //       garbled non-ASCII output without this). Our utf8.ts strict decoder
  //       rejects non-UTF-8 with EENCODING, so without this prefix any
  //       non-ASCII output from a wrapped command would be lost.
  //   (b) `; exit $LASTEXITCODE` — propagates the last external command's
  //       exit code through the PowerShell wrapper. PowerShell already
  //       propagates the exit code when the script's only statement IS an
  //       external command; the explicit `exit` is defensive against future
  //       composed-command shapes where additional PowerShell statements
  //       run after the external command and `$LASTEXITCODE` would otherwise
  //       be hidden behind a 0 exit from the wrapper.
  //
  // Bug #2 from handoff #1 (the historical "execute_command silent-output"
  // operational note) — investigated in v0.7.1 and not reproducible at
  // server source-code layer. The H2 hardening here closes the door on the
  // suspected environmental causes (CLIXML leakage, stdin-deadlock, OEM
  // code page corruption) as defense-in-depth.
  const bin = resolvePowershellBin(config);
  const wrappedComposed =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
    composed +
    "; exit $LASTEXITCODE";
  const psArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-InputFormat",
    "None",
    "-Command",
    wrappedComposed,
  ];

  // Note: dispatched through the namespace object so test suites can
  // `vi.spyOn(execSafety, "spawnSubprocess").mockResolvedValue(...)`. A direct
  // named-import binding would not be redirected by the spy.
  const spawnRes = await execSafety.spawnSubprocess({
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

  // v0.7 wave 2a: surface diagnostic hints for known cryptic stderr signatures.
  // Raw stderr is never mutated; hints land in a new envelope field. Field is
  // omitted entirely when no marker matched (envelope cleanliness).
  const hints = diagnoseHints(spawnRes.stderr);

  const value: ExecuteCommandResult = {
    stdout: spawnRes.stdout,
    stderr: spawnRes.stderr,
    exit_code: spawnRes.exitCode,
    duration_ms: spawnRes.durationMs,
    truncated_stdout: spawnRes.truncatedStdout,
    truncated_stderr: spawnRes.truncatedStderr,
    timed_out: spawnRes.timedOut,
    ...(hints.length > 0 ? { hints } : {}),
  };
  // GPT-review #3: sha256 + byte length by default; content prefixes (composed
  // command, stdout, stderr) only when config.auditVerbose. A prefix can leak a
  // secret on the command line or on output line 1.
  const verbose = config.auditVerbose;
  auditByResult.set(value, {
    ...auditContentFields("composed", composed, verbose, COMPOSED_PREFIX_CAP),
    ...auditContentFields("stdout", spawnRes.stdout, verbose, AUDIT_PREFIX_CAP),
    ...auditContentFields("stderr", spawnRes.stderr, verbose, AUDIT_PREFIX_CAP),
  });
  return ok(value);
}

export function registerExecuteCommandTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
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
  Windows via \`taskkill /F /T /PID\`. Best-effort: detached grandchildren
  that escape the process group (e.g. via Win32 \`DETACHED_PROCESS\` flag
  or PowerShell \`Start-Process -WindowStyle Hidden\` without \`-Wait\`)
  are NOT terminated by \`/T\`.
- Per-stream output cap (\`config.execMaxOutputBytes\`, default 1 MB).
  Excess bytes dropped; cap-hit kills the subprocess; \`truncated_*\` flags
  set in response.

Args:
  - command (string): PowerShell expression
  - args (string[], default []): extra tokens appended after a space
  - cwd (string, optional): defaults to allowedRoots[0]
  - timeout_ms (number, optional): default 30000; hard max shellMaxTimeoutMs
    (default 600000 = 10 min). Pass a high value for a 6–8 min build. The
    separate ~4-min Claude Desktop transport ceiling is upstream, not this.

Returns: { stdout, stderr, exit_code, duration_ms, truncated_stdout, truncated_stderr, timed_out, hints? }
  - \`hints\` is an array of short diagnostic strings when stderr matches a known
    cryptic-failure signature (e.g. PowerShell's "Cannot run a document in the
    middle of a pipeline"). Field is absent when nothing matched. Raw stderr
    is never mutated.

Errors: EPERM_ROOT (cwd outside roots), ENOTDIR (cwd not a directory),
EBLOCKED (blocklist hit, see details.pattern), EIO (spawn failure),
ETIMEDOUT surfaced as \`timed_out: true\` + truncated output (not as an error
code) so callers receive partial diagnostics.

Audit log records the SHA-256 digest + byte length of the composed command and
of stdout/stderr — NEVER the content (a prefix can leak a CLI password or a
secret on output line 1). Set config.auditVerbose=true to ALSO record 64-char /
4 KB prefixes for debugging.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      // Coordinate the outer (runTool withTimeout) and inner (spawn) deadlines:
      // outer honors timeout_ms up to shellMaxTimeoutMs (raising runTool's
      // ceiling via maxTimeoutMs so it isn't clamped to the general 60 s max);
      // inner = outer − BUFFER so the graceful timed_out path fires first.
      const outerDeadline = resolveTimeoutMs(
        (args as Input).timeout_ms,
        config.shellTimeoutMs,
        config.shellMaxTimeoutMs,
      );
      const innerDeadline = Math.max(1, outerDeadline - OUTER_TIMEOUT_BUFFER_MS);
      return runTool(
        {
          tool: "execute_command",
          config,
          timeoutMs: outerDeadline,
          maxTimeoutMs: config.shellMaxTimeoutMs,
          auditExtras: (result) => {
            if (!result.ok) {
              return {
                command_bytes: Buffer.byteLength((args as Input).command ?? "", "utf8"),
              };
            }
            const extras = getExecuteCommandAuditExtras(result.value as ExecuteCommandResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a, sig) => executeCommandImpl(a as Input, config, sig, innerDeadline),
      );
    },
  );
}
