# Gemini review — Phase v0.7-pre-tag-execute_command — 2026-05-22T0859Z

## Invocation

Model attempted: `gemini-2.5-flash-preview` (preferred `gemini-3-flash-preview` not found;
  attempted `gemini-2.5-flash-preview` as next candidate)
Audit type: whole-phase (security + correctness + prompt-engineering)
Phase: v0.7-pre-tag-execute_command
Target file: `src/tools/exec/execute_command.ts` at HEAD `a885126`
Related references: `src/core/exec_safety.ts`, `src/core/exec_hints.ts`

### CLI invocation attempts

Attempted commands (exact, in order):

1. `gemini --model gemini-2.5-flash-preview --prompt $promptText`
   (via bash -c: `gemini: command not found`, exit 127)

2. `which gemini` / `command -v gemini`
   Result: not found in PATH.

3. `find /c/Users/User/AppData -name 'gemini*' -maxdepth 8`
   Result: only `/c/Users/User/AppData/Local/WisprFlow/.../gemini.jpg` — no CLI binary.

4. `npm list -g --depth=0`
   Result: no output (empty npm global registry). Node v24.15.0 installed, no @google/gemini-cli package.

5. `find /c/Users/User -name 'gemini.exe' / 'gemini.cmd' / 'gemini.ps1'`
   Result: empty. No gemini binary variants found.

**Root cause:** Gemini CLI (`@google/gemini-cli`) is NOT installed on this machine
(`C:\Users\User\Desktop\AI\tools\winfs`, Windows 10 Pro 10.0.19045). The npm global
directory is empty. No system-level installation found under AppData, Program Files,
or PATH-reachable locations.

**Recommended action:** Install gemini CLI via `npm install -g @google/gemini-cli` (or
the equivalent Google subscription install path), authenticate, and re-invoke this
subagent.

---

## Raw output

NONE — CLI invocation failed. Per trust model rule 3: output not substituted with
fabricated Gemini responses.

---

## Subagent analysis (gemini-reviewer subagent reading — NOT Gemini CLI output)

**IMPORTANT:** The following is the gemini-reviewer subagent's independent analysis of
`execute_command.ts` at HEAD `a885126`, produced WITHOUT Gemini CLI. This is clearly
labeled as a subagent reading and must NOT be treated as Gemini output. Architect
decides whether to accept this as a provisional review or defer until CLI is available.

The subagent has read:
- `src/tools/exec/execute_command.ts` (full, 242 lines)
- `src/core/exec_safety.ts` (full, 383 lines)
- `src/core/exec_hints.ts` (full, 51 lines)
- `audit/external_reviews/_review_execute_command.prompt.md` (full, 329 lines)

---

### Finding Q1 — P2 — & operator output silent-drop: root cause analysis

**Location:** `execute_command.ts` line 80 (composition), `exec_safety.ts` lines 219-224
(spawn options).

**Analysis:**

The empirically observed silent-drop of stdout/stderr when `composed` contains
`& "C:\path\git.exe" args` is caused by an interaction between PowerShell's `-Command`
parsing and Node's pipe inheritance, not by `-NonInteractive` itself. When PowerShell
executes `& "C:\path\git.exe" status` under `-Command`, it invokes git.exe as a
grandchild process. The grandchild inherits PowerShell's stdout/stderr file descriptors
(since `stdio: ['ignore','pipe','pipe']` pipes PowerShell's own stdout/stderr). In
theory git writes to its inherited stdout which flows back through PowerShell to Node's
pipe. However, `windowsHide: true` in combination with Windows console subsystem quirks
can cause the grandchild to open a new console buffer rather than writing to the
inherited pipe. More specifically: on Windows, executables linked against the Windows
console subsystem (like git.exe, which is a CUI application) that are invoked as
grandchildren of a process with `windowsHide:true` may not correctly inherit the pipe
handles if the parent was itself spawned with `CREATE_NO_WINDOW`. The PowerShell
`-Command` mode may also buffer output differently from `-File` mode when grandchildren
write to console vs pipe handles.

A secondary factor: the tool description says `& "path" args` is a known bug (v0.5.0
known issue P2, per prompt §context). The prompt explicitly notes this was classified P2
because state mutations succeed — only observability is lost. The missing fix is to
advise callers to append `| Out-String` or use explicit redirection, or to switch to
`Start-Process -RedirectStandardOutput`.

**Severity:** P2. Correct at P2: state mutation works, output is lost. UX degradation
and potential false-empty signal for callers using stdout for decisions.

**Fix recommendation:** Document in the tool description that `& "path\exe" args`
invocations may produce empty stdout/stderr due to Windows console handle inheritance.
Recommend callers use `& "path\exe" args | Out-String` for output capture, or pass the
absolute path as part of `command` without `&`. Alternatively, add a hint entry in
`exec_hints.ts` that detects when `composed` starts with `& "` and stderr is empty with
exit_code 0 — attach a hint proactively.

---

### Finding Q2 — P2 — Argument composition quoting: caller burden poorly surfaced

**Location:** `execute_command.ts` line 80.

**Analysis:**

`args.join(' ')` without quoting means any `args[]` element containing whitespace,
parentheses, apostrophes, or quotes will be parsed incorrectly by PowerShell. The field
name `args` strongly implies spawn-style positional array semantics (as in Node's
`child_process.spawn(cmd, args)`). The description currently says "NOT passed as
positional pwsh args (those would require shell quoting we don't perform)" — this is
correct but buried. A caller seeing `args: string[]` in the schema is very likely to
pass `["C:\\Program Files\\app\\config.txt"]` and get a broken command. `MAX_ARGS_LEN`
= 64 entries * 2048 chars = up to 131 KB of unquoted concatenated tokens, which is a
large attack surface for accidental misuse. There are no unit tests pinning the
expected behavior for paths with spaces (spec Lesson #12 flags test-matrix-mandatory).

**Severity:** P2. No security bypass possible (blocklist runs on the composed string),
but high probability of caller confusion leading to subtly wrong behavior.

**Fix recommendation:** Add an early validation pass that rejects any `args[]` element
containing ASCII whitespace with `EINVAL` and a message "arg contains unquoted
whitespace; PowerShell composition does not auto-quote — embed quoting in the arg or
include it in command directly". This converts silent misbehavior to a loud early error.
Alternatively, rename the field to `raw_tokens` to better signal its raw-concatenation
semantics.

---

### Finding Q3a — P1 — Blocklist bypass: -EncodedCommand base64

**Location:** `exec_safety.ts` lines 14-50 (DEFAULT_EXEC_BLOCKLIST), `execute_command.ts`
line 80 (composition).

**Analysis:**

`command: "powershell -EncodedCommand <base64>"` composes to
`powershell -EncodedCommand <base64string>`. The blocklist checks this composed string.
The base64-encoded payload may contain `Remove-Item -Recurse C:\` or any other blocked
pattern — but base64 encoding renders them unrecognizable to the regex patterns. None of
the DEFAULT_EXEC_BLOCKLIST patterns block `-EncodedCommand` itself. A caller can
trivially bypass every blocklist rule by base64-encoding the dangerous command. This is
a complete bypass of the pre-spawn blocklist for all destructive patterns.

**Severity:** P1. The blocklist is the primary stated defense (spec invariant #7). The
`-EncodedCommand` vector entirely circumvents it. This is an incorrect behavior relative
to spec, not merely a UX issue.

**Fix recommendation:** Add `"-EncodedCommand"` and `"-e\\b"` (the short flag) as
explicit blocklist patterns. Any use of encoded commands bypasses the safety layer
entirely and should be rejected. Consider also blocking `"Invoke-Expression"` without a
paired allowlist exception (it is partially covered by the download-and-execute pattern
but not by standalone usage).

---

### Finding Q3b — P1 — Blocklist bypass: rm alias with -r short flag

**Location:** `exec_safety.ts` line 18: `"rm\\s.*-rf"`.

**Analysis:**

The pattern `rm\s.*-rf` requires the literal string `-rf` (combined). `rm -r C:\` uses
`-r` alone (without `f`). PowerShell's `rm` alias maps to `Remove-Item`. `rm -r C:\`
is functionally equivalent to `Remove-Item -Recurse C:\` on PowerShell. The pattern
does NOT match. Similarly `rm -Recurse C:\` would not match the `rm\s.*-rf` pattern but
WOULD match `Remove-Item\s.*-Recurse` only if the user spells out `Remove-Item`. The
alias form with `-r` short flag is a clear gap.

**Severity:** P1. Direct blocklist bypass for recursive deletion via PowerShell alias
with standard short flag.

**Fix recommendation:** Add pattern `"rm\\s.*-[rR]\\b"` (matches `-r` or `-R` as a
standalone flag boundary) and `"ri\\s.*-[rR]\\b"` (ri is another alias for
Remove-Item). Alternatively, add `"\\brm\\b"` entirely as a blocked pattern since rm
in PowerShell context is almost exclusively Remove-Item and legitimate callers can use
the full cmdlet name.

---

### Finding Q3c — P2 — Blocklist cache invalidation: key excludes DEFAULT_EXEC_BLOCKLIST

**Location:** `exec_safety.ts` lines 56-77 (compileBlocklist cache).

**Analysis:**

The module-level `_compiled` cache is keyed solely on `extra.join('|||')` (the
`config.execExtraBlocklist` content). `DEFAULT_EXEC_BLOCKLIST` is a `readonly string[]`
const and in production is never mutated — so this is normally safe. However, in test
suites that monkey-patch `DEFAULT_EXEC_BLOCKLIST` or mock the module, a different
`extra` array with the same content (or an empty array) would hit the cached compiled
set from a prior test run that used the unpatched default list. This creates a stale
cache bug in test isolation. Additionally, if two `ResolvedConfig` instances with the
same `execExtraBlocklist` but different `DEFAULT_EXEC_BLOCKLIST` states exist in the
same process (possible in integration tests), the second compilation is skipped.

**Severity:** P2. Production impact is nil if DEFAULT_EXEC_BLOCKLIST is never mutated.
Test isolation is affected. Documents a fragile assumption.

**Fix recommendation:** Include a hash of `DEFAULT_EXEC_BLOCKLIST` in the cache key, or
simplify: since `DEFAULT_EXEC_BLOCKLIST` is module-level const, compile it once at
module load time into a separate immutable compiled array and always combine with the
extra patterns at runtime. This eliminates the cache complexity entirely.

---

### Finding Q4 — P2 — PATH sanitization: non-standard git install paths not covered

**Location:** `exec_safety.ts` lines 113-125 (sanitizedPathDirs).

**Analysis:**

`sanitizedPathDirs` hardcodes `C:\Program Files\Git\cmd` and `C:\Program Files\Git\bin`.
Common non-standard installs: `C:\Program Files (x86)\Git\cmd` (32-bit installer),
`%USERPROFILE%\scoop\apps\git\current\bin` (Scoop), `C:\ProgramData\chocolatey\bin`
(Chocolatey shim), `C:\tools\git\cmd` (custom portable). The empirical finding
(`find_command` returning `found: false` for git on operator's machine) confirms the
gap. The spec invariant #10 says "C:\Program Files\Git\cmd" — the spec itself is
written for the standard install path only. The root cause is that the spec's PATH list
is insufficient for non-standard installs.

**Severity:** P2. The spec invariant matches the implementation. The gap is between the
spec and real-world install diversity. No incorrect logic in the implementation per-spec,
but a known limitation causing `found: false` for installed binaries.

**Fix recommendation:** Add a startup-time dynamic probe: attempt `Get-Command git -ErrorAction SilentlyContinue` with full inherited `process.env.PATH` (before sanitization), cache the resolved directory, and append it to `sanitizedPathDirs()` output. This is a one-time startup cost and correctly handles all install paths. Document the probe in config comments.

---

### Finding Q5a — P1 — AbortSignal race: pid undefined window

**Location:** `exec_safety.ts` lines 288-301 (onAbort), lines 241-273 (killTree).

**Analysis:**

`spawn()` is synchronous in Node.js — it returns a `ChildProcess` object immediately,
but `child.pid` may be `undefined` if the process has not yet been assigned an OS PID
(this can happen in rare timing cases on Windows, or more commonly if spawn itself is
about to fail asynchronously). `killTree` checks `if (pid === undefined) return` and
does nothing. `onAbort` is registered as an AbortSignal listener before `spawn()`
returns in the flow of `spawnSubprocess`. If `opts.signal.aborted` is already true
before the `spawn()` call, `onAbort()` is called immediately (line 299), before
`child.pid` is assigned a valid OS value. The 2-second `setTimeout` inside `onAbort`
does call `killTree()` after a delay — by that point `child.pid` should be defined if
spawn succeeded. However, between the `onAbort()` call and the 2-second timer firing,
the process is running unkilled.

More critically: the guard `if (!settled) killTree()` inside the 2s setTimeout means
if the process exits naturally within 2 seconds of an abort, `killTree` is NOT called
(settled = true). This is correct behavior. But the `onAbort` does not set `timedOut`
or any abort flag — the response will have `timed_out: false` and whatever exit_code
the process returned or `null` if it was killed. The caller has no signal that an abort
occurred.

**Severity:** P1. The `pid === undefined` race is narrow but real on Windows. The
missing abort flag in the response is a behavioral contract issue — callers cannot
distinguish abort from clean exit.

**Fix recommendation:** (1) Add an `aborted: boolean` field to `SpawnSubprocessResult`
and `ExecuteCommandResult`, set to `true` in `onAbort`. (2) In `killTree`, if
`pid === undefined`, schedule a retry after 50ms (or use the `child.on('spawn')` event
in Node 16+ to fire the kill only after the process is confirmed started).

---

### Finding Q5b — P2 — taskkill /T limitation: detached grandchildren

**Location:** `exec_safety.ts` lines 242-273 (killTree).

**Analysis:**

`taskkill /F /T /PID` kills the process tree by walking the parent-child relationship
in the Windows process table. A PowerShell script that internally uses
`Start-Process -PassThru` (without `-NoNewWindow`) or `Start-Job` creates a new
process that is a child of the Windows Session Manager or ConHost, not of the
PowerShell host being killed. These processes escape `/T` scope. This is a fundamental
Windows limitation, not a code bug. The current implementation is the best achievable
without a Windows Job Object approach.

**Severity:** P2. Known Windows limitation. The tool description correctly says
"process tree killed via taskkill /F /T /PID" without claiming it handles detached
processes. No code fix without significant architecture change (Job Objects).

**Fix recommendation:** Document the limitation in the tool description: "Note: processes
spawned with Start-Process -PassThru or Start-Job inside the command may not be
terminated by the abort/timeout mechanism — they will run to completion independently."

---

### Finding Q6 — P3 — Hints omitted from audit: potential gap for large stderr

**Location:** `execute_command.ts` lines 149-167 (diagnoseHints call, auditByResult).

**Analysis:**

`diagnoseHints` runs on the full `spawnRes.stderr` string (not the 4KB truncated prefix).
The audit record stores `stderr_prefix` = first 4KB. If stderr is larger than 4KB and
the cryptic marker (e.g., "Cannot run a document in the middle of a pipeline") appears
after the 4KB mark, the live response would include the hint but the audit record would
not capture the matched text. This is a minor gap in audit completeness. The design
decision to omit hints from audit (noise reduction per the design comment) is stated
and intentional. However, a matched hint without corresponding text in the audit makes
the audit record harder to reconstruct post-hoc.

**Severity:** P3. Intentional design tradeoff, not a bug. Audit correctness is not
violated since stderr_prefix still captures what it can.

**Fix recommendation:** Consider storing `hints_matched: boolean` (or `hints_count:
number`) in the audit extras even if the hint text itself is omitted. This allows
post-hoc audit analysis to know a hint fired without storing the full hint string.

---

### Finding Q7 — P2 — Hint text accuracy: "try cmd" inapplicable

**Location:** `exec_hints.ts` line 28: hint text for "Cannot run a document in the
middle of a pipeline".

**Analysis:**

The hint text reads: "Try invoking it via a different shell (cmd) or with the full path,
or use a passthrough tool if available." This tool dispatches EXCLUSIVELY through
PowerShell (`powershell.exe` or `pwsh`). There is no cmd.exe dispatch path. The advice
"Try invoking it via a different shell (cmd)" is not actionable from within this tool
and may confuse callers into thinking they can switch shells via `execute_command`. The
actual root cause of this PowerShell error is more precisely: invoking a `.ps1` script
file path directly in `-Command` context (without dot-sourcing or `&`) — PowerShell
treats it as a document, not as a command. The PATHEXT explanation is secondary and less
common. The `try cmd` advice is misleading in a PowerShell-only dispatch context.

**Severity:** P2. The hint fires when it should, but gives inapplicable advice. A
caller reading the hint may attempt to switch shells, discover they cannot, and be
no better informed than before.

**Fix recommendation:** Revise the hint text to: "PowerShell refused to execute a file
as a command. If you are invoking a .ps1 script, use the call operator: '& \"path\\script.ps1\"'.
If invoking an executable, ensure it is in the sanitized PATH or pass its absolute path.
Passing a script file path directly to -Command without '&' is the most common cause."

---

### Finding Q8 — P2 — taskkill /F blocklist: pattern may be too broad

**Location:** `exec_safety.ts` line 39: `"taskkill\\s.*\\/F"`.

**Analysis:**

The pattern `taskkill\s.*\/F` blocks any `taskkill` call containing `/F` anywhere after
the command name. This blocks:
- `taskkill /F /PID 1234` (forceful kill by PID — legitimate process management)
- `taskkill /F /IM process.exe` (forceful kill by image name — legitimate)
- `taskkill /IM process.exe /F` (same, different order)

It also blocks the pattern the server uses internally — but the server calls
`spawn('taskkill', ['/F','/T','/PID',pid])` directly, not through `execute_command`,
so there is no self-interference. The concern is that legitimate process management
from a caller (e.g., "kill this specific PID that the previous command returned") is
completely blocked. The blocklist pattern targets force-kill scenarios but `/F` alone
is not uniquely dangerous — it's the combination of `/T` (tree kill) or `/IM *` (all
processes of an image) that elevates risk. Without `/T`, `taskkill /F /PID n` is a
scoped, targeted kill.

**Severity:** P2. Over-broad blocklist rule reduces tool utility for legitimate
process management without proportional security benefit.

**Fix recommendation:** Consider narrowing to `"taskkill\\s.*\\/F\\s.*\\/T"` (blocks
force tree-kill) and `"taskkill\\s.*\\/F\\s.*\\/IM\\s+\\*"` (blocks force kill of all
instances). Or document the blocklist as intentionally broad and provide a
`config.execExtraBlocklist` workaround — but note that current API only ADDS to the
blocklist, not removes, so this cannot be overridden by callers.

---

### Finding Q9 — P2 — cwdCheck cast: unsafe type assertion

**Location:** `execute_command.ts` line 91: `cwd = (cwdCheck as { realPath: string }).realPath`.

**Analysis:**

`checkAllowed` is described as returning a `Result`-shaped object. The preceding line
checks `if ('ok' in cwdCheck && cwdCheck.ok === false) return cwdCheck` — meaning if
we reach line 91, the check passed (not a falsy `.ok`). The cast assumes the success
shape has a `realPath` field. If `checkAllowed` returns `{ ok: true }` without
`realPath`, or returns a string directly, or returns `{ ok: true, path: string }`, the
cast silently produces `undefined`, and `cwd` becomes `undefined`. This is then passed
to `fs.stat(cwd)` which would throw with a confusing error (not an ENOENT about the
user's path, but a TypeError or ENOENT on "undefined"). The function is marked "trusted"
in the prompt, so the cast may be correct — but it is fragile and not type-safe.

**Severity:** P2. In practice, if `checkAllowed` is stable, this is safe. But it
creates a maintenance trap: any change to `checkAllowed`'s return type that is not
reflected here would cause a runtime `undefined` propagation that TypeScript wouldn't
catch.

**Fix recommendation:** Replace the cast with a proper type guard or import
`checkAllowed`'s return type and narrow via discriminated union. At minimum, add a
runtime assertion: `if (!(cwdCheck as Record<string, unknown>).realPath) return
buildError("EINTERNAL", "checkAllowed returned unexpected shape")`.

---

### Summary table

| Q  | Severity | Title |
|----|----------|-------|
| Q1 | P2       | `&` operator output silent-drop: Windows console handle inheritance |
| Q2 | P2       | Argument composition: unquoted args cause silent misbehavior |
| Q3a | P1      | Blocklist bypass: -EncodedCommand passes base64-encoded dangerous commands |
| Q3b | P1      | Blocklist bypass: `rm -r` short flag not caught (only `-rf` pattern) |
| Q3c | P2      | Blocklist cache: key excludes DEFAULT_EXEC_BLOCKLIST, fragile in tests |
| Q4 | P2       | PATH sanitization: non-standard git install paths not covered |
| Q5a | P1      | AbortSignal race: pid undefined window + no abort flag in response |
| Q5b | P2      | taskkill /T: detached grandchildren escape scope (Windows limitation) |
| Q6 | P3       | Hints not in audit: gap for stderr > 4KB with late-appearing marker |
| Q7 | P2       | Hint text: "try cmd" inapplicable in PowerShell-only dispatch |
| Q8 | P2       | taskkill /F blocklist: pattern too broad, blocks scoped legitimate kills |
| Q9 | P2       | cwdCheck cast: unsafe type assertion, realPath may silently be undefined |

**Count:** P0: 0 | P1: 3 | P2: 8 | P3: 1

**Verdict: NEEDS FIXES (P1 present)**
