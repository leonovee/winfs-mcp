# External code review — winfs `execute_command.ts` — v0.5.0 post-tag

## Context

winfs `execute_command` is the **second mutation tool** in the codebase (after `edit_file`) and the **first one that spawns external processes**. It dispatches PowerShell with `-NoProfile -NonInteractive -Command <composed>` and captures stdout/stderr/exit_code. Hard defenses per spec §2 invariants #7–#12:

- Pre-spawn blocklist regex check on the composed command string. Default patterns cover `Remove-Item -Recurse`, `format C:`, `bcdedit`, `reg delete HKLM`, `shutdown`, `Stop-Process -Force`, `cipher /w`, `Clear-Disk`, `Initialize-Disk`. Match → `EBLOCKED`.
- PowerShell as the only dispatch shell. Never `cmd.exe`, never `bash`.
- Bounded I/O capture: per-stream cap = `config.execMaxOutputBytes` (default 1 MB). Cap hit → kill subprocess + `truncated_stdout: true` flag.
- Sanitized PATH: minimal inherited PATH (`System32`, `Windows`, `Git\cmd`, `nodejs`, optional `pythonHome`). User `$PATH` NOT inherited.
- `cwd` checked against `allowedRoots`; defaults to `allowedRoots[0]`.
- Hard deadline with SIGTERM → SIGKILL escalation. Windows process tree killed via `taskkill /F /T /PID`.
- AbortSignal threading from `runTool` wrapper into spawn.
- Timeout surfaces as `timed_out: true` flag + truncated output, NOT as an error code (caller receives partial diagnostics).

Audit log records command **prefix (first 64 chars)** + full length + stdout/stderr first 4 KB. Never full command (passwords on CLI). Never full output.

`checkExecBlocklist`, `spawnSubprocess` (in `src/core/exec_safety.ts`) are trusted — separate review may be warranted post-this-pass. `runTool` wrapper is trusted — already audited in v0.3.0–v0.4.0 cycles. `checkAllowed` is trusted.

See `_review_audit_tail.prompt.md` and `_review_edit_file.prompt.md` for full project context (invariants, error envelope conventions, audit redaction policy, AbortSignal threading precedent from v0.3.2 Kimi P2.2).

## Your task

Review `src/tools/exec/execute_command.ts` for: argument composition correctness, blocklist bypass surfaces, PATH sanitization completeness, AbortSignal + process tree kill correctness, output capture reliability, audit redaction completeness. This is **the most security-critical mutation surface in the codebase** — it spawns arbitrary user-controlled shell commands inside `allowedRoots`. The bar is strict.

## Targeted questions

**Q1 (output capture silent-failure for `&`-operator invocations).**

Empirically observed at v0.5.0 release (chat Claude session, 2026-05-17): when `execute_command` is invoked with a PowerShell `& "C:\path\with spaces\exe.exe" args...` call pattern, **stdout and stderr from the child process do NOT propagate to the captured response**, but the command DOES execute correctly (state changes land on disk / network).

Symptom shape: `{stdout: "", stderr: "", exit_code: 0, duration_ms: ~134, truncated_*: false, timed_out: false}` — identical 134ms duration for divergent commands (`git status`, `git push`, `git ls-remote`) is the smoking gun. Compare to the first call in the session (`git tag -a v0.5.0 -m "..."`) which returned `exit_code: 0, duration_ms: 177` — git tag produces no output on success, so that result is normal.

Look at this composition:

```typescript
const composed = args.args.length > 0
  ? `${args.command} ${args.args.join(" ")}`
  : args.command;
// ...
const psArgs = ["-NoProfile", "-NonInteractive", "-Command", composed];
```

So `composed` becomes the SINGLE STRING value of `-Command`. PowerShell parses it. When `composed === '& "C:\\Program Files\\Git\\cmd\\git.exe" status'`, PowerShell invokes git.exe via the `&` call operator and git.exe writes to stdout. The question is **why doesn't that stdout propagate back through PowerShell to Node's spawn() capture?**

Hypotheses to investigate:
- Does `& "<path>" args...` in `-Command` context inherit stdout/stderr differently than direct `<cmd> args...`?
- Does PowerShell's `-NonInteractive` mode close child stdio handles unexpectedly?
- Does `spawnSubprocess` (in `src/core/exec_safety.ts`) attach to the wrong pipe end when the child process invokes a grandchild?
- Is there a buffering issue where the child's exit happens before stdout flushes, and Node closes the pipe too eagerly?

How serious? Severity P2 (downgraded from P1 at chat Claude's discretion) because **commands DO execute correctly** — state mutation works, just observable output is empty. But: callers who depend on stdout for decision-making get false-empty signals → bad UX, potentially worse if a caller treats `stdout === ""` as "no result, success" when actually it's "result was generated but lost".

Cleanest fix? Options:
- (a) Investigate spawn stdio inheritance through `&` call operator. Maybe a `-OutputFormat` flag fixes it. Test matrix: `git status` directly (no `&`), `& git status` (PATH-resolved), `& "C:\path\git.exe" status` (absolute), with and without quoting.
- (b) Switch to `Start-Process -RedirectStandardOutput temp.txt -RedirectStandardError err.txt -Wait`, then read temp files. Adds disk I/O but bypasses pipe inheritance.
- (c) Document the limitation in tool description: "If invoking executables via `& "<path>"` and they produce output, also redirect explicitly via `| Out-String` or `*>&1`".

**Q2 (argument composition via single-space join — quoting hazard).**

```typescript
const composed = args.args.length > 0
  ? `${args.command} ${args.args.join(" ")}`
  : args.command;
```

`args.join(" ")` doesn't quote individual args. Edge cases this breaks:

- `command: "echo", args: ["hello world"]` → composed: `echo hello world` (TWO args from PowerShell's POV, not ONE; lossy)
- `command: "Get-Content", args: ["C:\\Program Files\\app\\config.txt"]` → composed contains an unquoted space; PowerShell parses as two args, fails
- `command: "Set-Location", args: ["C:\\path with (x86)\\subdir"]` → parens treated as expression delimiters in PowerShell, completely different parse
- `command: "Write-Output", args: ["it's a test"]` → unquoted apostrophe; PowerShell breaks token stream
- `command: "Write-Output", args: ['"hello"']` → quote inside arg; needs escaping; ambiguous

The tool description says: *"args (string[], default []): extra tokens appended after a space"* and *"NOT passed as positional pwsh args (those would require shell quoting we don't perform)"*. So the contract IS that caller bears quoting burden. But:

- Is this contract surfaceable to callers in a way they'll actually read? Tool description is the only signal; most callers will see the schema and assume `args` works like Node's `child_process.spawn(cmd, args)` (which DOES quote).
- Spec lesson #12 (v0.5 base prompt) explicitly flags "PowerShell argument quoting hazards" as test-matrix-mandatory. Are there unit tests for the path-with-spaces / quotes-inside-args / parens-inside-args cases that pin the **expected behavior** (either: fail loudly with `EINVAL` early, OR document that caller must quote and `EINVAL` only if literal `\0` / control chars)?

Recommendation evaluation: should the impl
- (a) Reject `args` containing whitespace as `EINVAL` (forces caller to quote inline), OR
- (b) Auto-quote each arg with PowerShell-safe single-quote escaping (treating doubled `'` as escape), OR
- (c) Keep current behavior + add big warning in description?

**Q3 (blocklist bypass via PowerShell features).**

Default blocklist (from spec §2 #7) is regex patterns:

```
Remove-Item.*-Recurse
format [A-Za-z]:
bcdedit
reg delete HKLM
shutdown
Stop-Process.*-Force
cipher /w
Clear-Disk
Initialize-Disk
```

These match on the **composed command string** before spawn. Audit caller bypass vectors:

- **EncodedCommand:** `command: "powershell", args: ["-EncodedCommand", "<base64 of Remove-Item -Recurse C:\\>"]` — composed: `powershell -EncodedCommand <base64>`. Blocklist regex doesn't match `Remove-Item.*-Recurse` because the dangerous string is base64-encoded. Does the blocklist also reject `-EncodedCommand` as a pattern? (Spec doesn't say so. Impl seems to not.)
- **Aliasing:** PowerShell has aliases: `rm`, `del`, `erase` all map to `Remove-Item`. `command: "rm -r C:\\"` — composed: `rm -r C:\`. Does blocklist match? Pattern `Remove-Item.*-Recurse` is literal; alias `rm` and short flag `-r` bypass.
- **Variable indirection:** `command: "$x = 'Remove-Item'; & $x -Recurse C:\\"` — composed contains the literal string `Remove-Item` and `-Recurse` (though with `;` separation). Does the regex match across the semicolon? Pattern uses `.*` greedy, which by default matches across newlines (in some regex flavors). Verify: is the regex compiled with single-line flag? Multi-line?
- **PowerShell here-strings + Invoke-Expression:** `command: "Invoke-Expression @'Remove-Item -Recurse C:\\'@"` — heredoc isolates the dangerous string. Blocklist sees `Remove-Item.*-Recurse` and matches → caught. But what about `Invoke-Expression $env:USER_INPUT` where the dangerous string comes from env? Blocklist can't catch that.
- **Function definition:** `command: "function rmrf { Remove-Item -Recurse $args[0] }; rmrf C:\\"` — defines a function, then calls it. The function body contains `Remove-Item -Recurse` so blocklist matches → caught. But: `command: "iex (gc functions.ps1); rmrf C:\\"` — function source loaded from file → blocklist doesn't see it.

How does the threat model handle these? Is the blocklist intended as a **defense-in-depth** layer (assuming caller is benign but typo-prone), or as a **hard security boundary** (preventing all adversarial inputs)? If the latter, what's the response to the above bypass vectors?

**Q4 (PATH sanitization completeness — `find_command("git")` returned `found: false`).**

Spec invariant #10 (v0.5 base prompt §1 #10): *"Subprocess PATH inherits minimal PATH: `C:\Windows\System32`, `C:\Windows`, `C:\Program Files\Git\cmd`, `C:\Program Files\nodejs`, `<config.pythonHome>` if set."*

Empirical finding (chat Claude session 2026-05-17): `winfs:find_command({name: "git"})` from within the server returned `{found: false}`. External PowerShell `Get-Command git` succeeded, returning `C:\Program Files\Git\cmd\git.exe`. The sanitized PATH that the server hands to subprocess spawn does NOT include git's directory — at least not on this operator's machine.

Two possibilities:
- (a) Impl deviates from spec invariant #10 — git path was dropped from the sanitized PATH list in `exec_safety.ts`. If so, what's the rationale? (Maybe git directory varies per-install — `C:\Program Files\Git\cmd` is one location, `C:\Program Files (x86)\Git\cmd` another, portable-git different again.)
- (b) Operator's machine has git at a non-standard install path, and impl correctly looks for the standard path which is missing on this system.

Investigation:
- Read `src/core/exec_safety.ts` PATH sanitization list. Compare against spec invariant #10. Note any divergences.
- If divergence, was it deliberate? Find commit history / commit message.
- If accidental, add `C:\Program Files\Git\cmd` (and `C:\Program Files (x86)\Git\cmd` as fallback) to the sanitized PATH list. Add invariant test that pins the PATH list against spec.
- If git path varies per-system, consider a dynamic resolution step at server startup: probe `Get-Command git` once with full PATH inherited, cache the resolved directory, add it to the sanitized PATH for subsequent subprocess spawns. This adds startup cost but fixes the per-system variance.

How serious? Severity P3 in chat Claude's classification (workaround: pass absolute path). But: if `find_command` is supposed to be the "where's the binary?" tool for callers, returning `found: false` for binaries that ARE installed and ARE on the system PATH is a **correctness bug** with non-trivial caller impact.

**Q5 (AbortSignal threading + process tree kill correctness).**

`executeCommandImpl` accepts `signal?: AbortSignal` and passes it to `spawnSubprocess`. Inside `spawnSubprocess` (trusted but not yet reviewed in this pass), the signal should:

- Trigger SIGTERM to the PowerShell child on abort
- Escalate to SIGKILL after a brief grace window (typically 2s) if SIGTERM doesn't take
- On Windows, additionally invoke `taskkill /F /T /PID <pid>` to kill the process tree (since PowerShell may have spawned grandchildren that wouldn't receive the signal)

Concerns to investigate:

- **Race between SIGTERM and process spawn.** What if abort fires before `spawn()` returns the child PID? Is there a window where the child is alive but `kill()` has no handle on it? Test: abort within first 10ms of execute_command, verify no orphan.
- **`taskkill /F /T /PID` reliability.** Windows process tree killing is best-effort. What if a grandchild process re-parented itself via `Start-Process` with `-PassThru` (which detaches from the parent group)? Test: spawn `powershell.exe -Command 'Start-Process notepad -PassThru'`, abort, verify notepad is gone.
- **Signal threading completeness.** `executeCommandImpl` accepts `signal` from `runTool`. Does it pass it to `spawnSubprocess`? Yes per source. Does `spawnSubprocess` actually USE it? (Not in this review's scope per "trusted", but flag if signature suggests it's not wired through.)
- **Audit log on abort.** When abort kills the subprocess, what does the audit record show? Does `result_status` reflect "aborted" vs "ok" vs "timed_out"? Lessons learned suggest auditing should distinguish.
- **Re-entry on rapid abort.** If caller fires execute_command, aborts immediately, fires another execute_command, is there any shared state (e.g., PID tracking, lockfile in cwd) that could collide? Race conditions in audit_extras WeakMap (same pattern as edit_file Q5 in prior review)?

Process tree management was flagged as Lesson #11 of the v0.5 base prompt ("server's AbortSignal must kill entire tree, not just parent"). Pin via test: spawn deep tree, abort, verify no orphans via `Get-Process | Where-Object { $_.ProcessName -match 'powershell' }`.

R9 Inspector smoke probe used `Start-Sleep -Seconds 30` which **self-terminates** — even a broken tree-kill would leave no orphan after 30 seconds. Methodology weakness already documented in `docs/v0.5-acceptance.md` (P2 backlog). For this review, focus on the IMPL'S correctness, not the test's coverage.

## Output format

P1/P2/P3 tiers as in audit_tail and grep/edit_file prompts. Title + line numbers + reproduction + fix per finding. Explicit "Pn: none" if a tier is clear.

## File content

```typescript
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

// registerExecuteCommandTool below — registration shape; audit-extras wiring
// follows the WeakMap pattern from edit_file (see _review_edit_file.prompt.md Q5).
```

## Known context

- `checkExecBlocklist(composed, config)` (in `src/core/exec_safety.ts`) — applies hardcoded default blocklist regex array + `config.execExtraBlocklist` additions. Returns `Result.error("EBLOCKED", ..., { details: { pattern, position } })` on match, else returns `null`/`undefined`. Trusted; review separately if Q3 surfaces bypass concerns.
- `spawnSubprocess({ bin, args, cwd, deadlineMs, maxOutputBytes, config, signal })` — wraps Node `child_process.spawn` with bounded output capture, deadline timer, SIGTERM/SIGKILL escalation, Windows taskkill /T tree kill, AbortSignal listener. Returns `{stdout, stderr, exitCode, durationMs, truncatedStdout, truncatedStderr, timedOut, spawnFailed, spawnErrorCode, spawnErrorMessage}`. Trusted but Q5 may surface concerns worth revisiting.
- `checkAllowed(path, config)` — canonicalises via realpath, checks against `config.resolvedAllowedRoots`. Trusted.
- `runTool` wrapper — applies wall-clock timeout via `withTimeout`, audits args + result, threads AbortSignal into impl. Trusted.
- `resolveTimeoutMs(requested, default, max)` — clamps timeout to `[1, config.maxTimeoutMs]`, falls back to `config.defaultTimeoutMs` if not specified. Trusted.
- Audit redaction (spec §T, v0.5 amendment): `args.command` prefix-64, `args.args` last-64 per arg, `stdout`/`stderr` first 4 KB with `truncated_at_audit` marker. Never full command (passwords on CLI). Never full output.
- Spec §5 error catalog has `EBLOCKED`, `EPERM_ROOT`, `ENOTDIR`, `ENOENT`, `EIO`, `ETIMEDOUT` — relevant for this review. `ETIMEDOUT` surfaces as `timed_out: true` flag, not as an error envelope (per design).
- Lesson #11 (v0.5 base prompt): process tree management — server's AbortSignal must kill the entire tree, not just parent. Pin via test with deep child tree.
- Lesson #12 (v0.5 base prompt): PowerShell argument quoting hazards — test matrix mandatory for space/quote/paren/bracket edge cases.
- v0.3.2 audit_tail Kimi P2.2 fix is the precedent for AbortSignal threading through I/O. Compare with current execute_command + spawnSubprocess threading.
- v0.5.0 known issue P2 already filed (in `docs/v0.5-acceptance.md`): "execute_command silent output capture for `&`-operator invocations". This review's Q1 corresponds; reviewer findings will inform the v0.5.1 fix design.
