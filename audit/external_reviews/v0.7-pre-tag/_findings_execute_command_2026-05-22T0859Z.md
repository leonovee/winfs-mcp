# execute_command.ts external review — findings consolidation — 2026-05-22T0859Z

Wave: `v0.7-pre-tag-execute_command` against `main @ a885126`. File: `src/tools/exec/execute_command.ts` (referenced: `src/core/exec_safety.ts`, `src/core/exec_hints.ts`).

## ⚠ Wave provenance caveat

Mixed coverage with one substantive substituted artifact and three failure-only:

| Reviewer | Status | Provenance |
|---|---|---|
| **Codex** | failure-only artifact (1.4 KB) | CLI not installed; agent returned failure notice. |
| **Kimi** | missing artifact | Both kimi CLI and `MOONSHOT_API_KEY` unavailable; agent stopped (and saved a re-runnable `kimi_invoke.py`). |
| **Gemini** | substantive artifact (22.1 KB), substituted | CLI not installed; gemini-reviewer subagent substituted with Sonnet-driven static analysis. Explicitly labeled. 9 distinct findings across Q1-Q9 buckets. |
| **DeepSeek** | failure-only artifact (1.3 KB) | API key absent; agent stopped without fabrication. |

**Effective convergence: 1/4** — same as edit_file. All substantive findings
come from one Sonnet-driven static analysis. Two of the P1 claims are
security-relevant (blocklist bypasses) and should be re-checked against a
real reviewer before landing fixes.

## Reviewer profiles (recap)

- Codex — sharp on P1. **Did not produce findings**.
- Kimi — adversarial-test brainstorm. **Did not run**.
- Gemini — Windows-specific (PowerShell, PATH, taskkill, MSIX). **Substituted**. Profile aligns with this surface — Windows-specific is where execute_command lives.
- DeepSeek — anti-hallucination structural. **Did not run**.

## P1 findings

### P1.1 — Blocklist bypass via `powershell -EncodedCommand <base64>`

Raised by: **Gemini (substituted)** only. Single-source. **Security-relevant — verify before landing.**

- Gemini Q3a: "`command: "powershell -EncodedCommand <base64>"` composes to a string where the base64 payload contains `Remove-Item -Recurse` in encoded form — none of the `DEFAULT_EXEC_BLOCKLIST` patterns match it. `-EncodedCommand` is not itself blocked. This is a complete bypass of every blocklist rule." Location: `exec_safety.ts` lines 14-50 (DEFAULT_EXEC_BLOCKLIST), `execute_command.ts` line 80 (string composition).

**Converged description.** The blocklist regex-matches against the composed string `powershell <argv>`. A caller passing `["powershell", "-EncodedCommand", "<base64-encoded Remove-Item -Recurse C:\\>"]` produces a composed string that contains literally `-EncodedCommand <base64>` — and none of the patterns (`Remove-Item\s+.*-Recurse`, etc.) match because the destructive verb is base64-encoded.

**Recommended fix.** Add explicit blocklist patterns:
- `-EncodedCommand` (full long form, case-insensitive matching already in place)
- `-e\b` and `-en\b` and `-enc\b` and `-enco\b` and `-encod\b` and `-encode\b` and `-encoded\b` and `-encodedc\b` and `-encodedco\b` and `-encodedcom\b` and `-encodedcomm\b` and `-encodedcomma\b` and `-encodedcomman\b` (PowerShell accepts unambiguous prefix matches of the parameter name)

That's verbose. Cleaner: a single pattern `-\bEnc[a-z]*Comm[a-z]*` (case-insensitive) covers all unambiguous prefixes of `-EncodedCommand`. Add a test that confirms `-EncodedCommand`, `-EncodedC`, `-EncodedC`, `-Enc`, `-e` all match.

**Critical: verify-before-landing.** Confirm the bypass is real by writing a test that:
1. Constructs `["powershell", "-EncodedCommand", b64("Remove-Item -Recurse C:\\nonexistent\\")]`.
2. Asserts `EBLOCKED` is returned (not allowed-through).

If the test fails (allowed through), the bypass is real → fix. If it passes (already blocked by some other rule we missed), Gemini's analysis was incomplete and the finding is invalid.

### P1.2 — Blocklist bypass: `rm -r` short flag (Remove-Item alias)

Raised by: **Gemini (substituted)** only. Single-source. **Security-relevant.**

- Gemini Q3b: "Pattern `rm\s.*-rf` requires the literal combined flag `-rf`. `rm -r C:\` (the equally valid PowerShell `Remove-Item` alias with short recursive flag) is NOT blocked. `rm -Recurse C:\` is also not blocked via the `rm` alias path." Location: `exec_safety.ts` line 18.

**Recommended fix.** Replace `rm\s.*-rf` with `rm\s.*-[rR]\b` (matches `-r` or `-R` as standalone flag). Also consider `rm\s.*-Recurse\b` for the long-form Remove-Item alias path. Test: `rm -r C:\foo`, `rm -R C:\foo`, `rm -rf C:\foo`, `rm -Recurse C:\foo` should all match EBLOCKED.

**Verify-before-landing.** Same approach: write a test that drives `rm -r ...` through the blocklist and asserts EBLOCKED. If currently passes, finding is invalid (already blocked).

### P1.3 — AbortSignal race: `pid === undefined` window + no `aborted` flag on result

Raised by: **Gemini (substituted)** only. Single-source.

- Gemini Q5a: "If `opts.signal.aborted` is true before `child.pid` is assigned an OS value, `killTree` returns immediately as a no-op (`if (pid === undefined) return`). More actionably: `onAbort` sets no `aborted` flag in the result — the caller sees `timed_out: false` and cannot distinguish an aborted execution from a clean exit with `exit_code: null`." Location: `exec_safety.ts` lines 288-301 (onAbort), 241-273 (killTree).

**Converged description.** Two issues:
1. **Race window:** between spawn and pid assignment, an abort can no-op the kill. Narrow on Windows but real.
2. **Caller observability gap:** an aborted execution returns `{timed_out: false, exit_code: null}` indistinguishable from a clean exit-by-null. Needs explicit `aborted: boolean` field.

**Recommended fix.**
1. Add `aborted: boolean` field to `SpawnSubprocessResult`; default `false`; set `true` in `onAbort`.
2. For the kill-race: if `pid === undefined` in `killTree` and we're aborting, hook onto the next `spawn` event to fire the kill once pid materialises. Or: capture the abort intent in a closure flag and check it in the `spawn` event handler.

## P2 findings (Gemini-substituted)

### P2.1 — `&` operator output silent-drop on Windows (Gemini Q1)

`command: "& 'C:\\Program Files\\Git\\cmd\\git.exe' status"` returns empty stdout/stderr but exit 0; the side effect (e.g., a file modification) does occur. PowerShell file-association quirk. **Fix:** document in tool description that `& "path\exe" args` should be replaced with direct exe invocation; consider a heuristic detection + hint in `exec_hints.ts`.

### P2.2 — Argument composition quoting: caller burden poorly surfaced (Gemini Q2)

A caller passing an argv element with embedded quotes or special chars (`\"`, `;`, `&`) gets it concatenated into the composed PowerShell string. The blocklist sees the composed string. No security bypass (the blocklist still runs on the composed result), but cryptic failures when caller intent diverges from PowerShell's parsing. **Fix:** add an early validation pass that rejects `args[]` elements containing PowerShell metacharacters with a clear error explaining shell-quoting risk.

### P2.3 — Blocklist cache invalidation: cache key excludes `DEFAULT_EXEC_BLOCKLIST` (Gemini Q3c)

`compileBlocklist` cache keys on `config.execExtraBlocklist`. If `DEFAULT_EXEC_BLOCKLIST` were ever mutated in a hotfix, the cache wouldn't invalidate. Production impact nil today; structural fragility. **Fix:** hash `DEFAULT_EXEC_BLOCKLIST` into the cache key, or document that the default is immutable post-startup.

### P2.4 — PATH sanitization: non-standard git install paths not covered (Gemini Q4)

`sanitizedPathDirs` whitelists `C:\Program Files\Git\cmd` (standard). Users with portable git, MSYS2-bundled git, or chocolatey-installed git get a `find_command name="git"` miss + cryptic subprocess failures. **Fix:** add a startup-time dynamic probe — attempt `Get-Command git -ErrorAction SilentlyContinue` against the pre-sanitization PATH, cache the resolved directory, append to `sanitizedPathDirs()` output. One-time startup cost, robust against install variation.

### P2.5 — `taskkill /T` doesn't catch detached grandchildren (Gemini Q5b)

Known Windows limitation. Doc-only fix: tool description already says "best-effort"; consider being more explicit about "child processes that detach from the parent process group are NOT terminated by /T". **Fix:** doc update only.

### P2.6 — Hint text accuracy: "try cmd" inapplicable (Gemini Q7)

`exec_hints.ts` line 28: the hint for "Cannot run a document in the middle of a pipeline" advises trying `cmd` instead. But this server runs only PowerShell-dispatched commands. The advice is inapplicable from inside this tool. **Fix:** revise hint text to "PowerShell refused to execute a file via the call operator (`&`). The file-association extension is registered with a non-PowerShell-runnable handler. Try invoking the binary directly without `&`, or use `Start-Process`."

### P2.7 — `taskkill /F` blocklist may be over-broad (Gemini Q8)

`exec_safety.ts` line 39: `taskkill\s.*\/F` blocks ALL `taskkill /F ...` invocations. Legitimate single-process force-kill is impossible. **Fix:** narrow to `taskkill\s.*\/F\s.*\/T` (only blocks tree-force-kill), or accept current strictness as principle-of-least-privilege.

### P2.8 — `cwdCheck` cast: unsafe type assertion (Gemini Q9)

`execute_command.ts` line 91: `cwd = (cwdCheck as { realPath: string }).realPath`. Works because `checkAllowed` returns `{ realPath }` on success today. Future change to `checkAllowed`'s success shape would silently produce `undefined`. **Fix:** replace cast with a type guard (`if ("realPath" in cwdCheck && typeof cwdCheck.realPath === "string")`) or add the discriminant via an `ok` field on the result.

## P3 findings

- **P3.1 — Hints omitted from audit log** (Gemini Q6). Intentional design tradeoff: hints are advice, not evidence. Acceptable. Optional: add `hints_count` (not text) to audit for forensic visibility.

## Reviewer-unique findings flagged

**All findings are single-source (Gemini-substituted only).** Particular caution warranted on the two security-relevant P1s (P1.1 and P1.2):

- They claim blocklist bypasses — high-stakes claims that need empirical verification (a test that proves the bypass is real) before acceptance.
- A real Codex / Kimi / DeepSeek reviewer would catch any false positive here. Currently no cross-check.

The non-security P1 (P1.3 — AbortSignal race) is structurally verifiable from the source; lower risk of false positive.

## Recommended action plan

Order: empirical verification first, then severity, then ease. Chat-Claude approval gates.

1. **PRE-FIX VERIFICATION TESTS** — before any P1.1/P1.2 fix lands, write failing tests that demonstrate the claimed bypasses. If the tests fail (bypass is real), continue. If they pass (already blocked), the Gemini finding is invalid and there's nothing to fix. This is non-negotiable for security-claim fixes.
2. **`fix(exec_safety): block -EncodedCommand and unambiguous prefixes` (P1.1)** — only if step 1 confirms bypass.
3. **`fix(exec_safety): broaden rm short-flag pattern to -[rR]\\b and -Recurse\\b` (P1.2)** — only if step 1 confirms bypass.
4. **`fix(execute_command): add aborted flag + close pid-undefined kill race` (P1.3)** — structural; safe to land independent of step 1.
5. **`fix(exec_safety): hash DEFAULT_EXEC_BLOCKLIST into cache key` (P2.3)** — tiny; defensive.
6. **`fix(exec_safety): dynamic git PATH probe at startup` (P2.4)** — bigger; defer if not impacting current workflows.
7. **`fix(exec_hints): revise "try cmd" wording for accuracy` (P2.6)** — text-only.
8. **`fix(execute_command): replace cwdCheck cast with type guard` (P2.8)** — one-liner + test.
9. **`docs(execute_command): & operator output drop + argument quoting caveats` (P2.1 + P2.2)** — single doc commit.
10. **`fix(exec_safety): narrow taskkill /F blocklist to /F /T combination` (P2.7)** — only if a user reports legitimate use blocked.

## Re-run guidance

This surface is the most security-relevant in the wave and has the worst
reviewer coverage. **Strongly recommend re-running at least one real CLI**:

- **Codex (preferred)** — designed for security-relevant exec surfaces.
- **Kimi via Moonshot** — `MOONSHOT_API_KEY` exists in ai-judge `.env`. Saved invoke script at `audit/external_reviews/v0.7-pre-tag/execute_command/kimi_invoke.py` is ready once auth is in place.
- **DeepSeek** — structural review style would specifically test the blocklist contract.

The P1.1 and P1.2 blocklist-bypass claims are exactly the kind of finding that
benefits most from independent verification. Single source is not enough
confidence to ship a "fixes a security bypass" commit on tag eve.
