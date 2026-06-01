# CC prompt — v0.7 pre-tag bug-fix wave

## Origin

Two inputs feed this wave:

1. **Empirical bug #1** observed in this session (and independently in a parallel ai-judge chat): after `execute_command` returns `EPERM_ROOT`, subsequent winfs calls hang for 4 minutes. Stable reproducer. Suspected resource leak in the error path — child_process or AbortSignal listener not cleaned up when early-throw happens before main I/O completes.

2. **Review wave findings** at `audit/external_reviews/v0.7-pre-tag/_findings_*.md` (committed `87b9f2d`). Four consolidation files, ~13 P1 + ~25 P2 across the four surfaces. Reviewer provenance was weakened (only Kimi was a real external model; Codex/Gemini were Sonnet-substituted; DeepSeek mostly absent). Chat-Claude has triaged findings into accept / verify-first / defer.

These two inputs converge on a single insight: **async cleanup on error paths is the systemic weakness**. Reviewers found the same pattern in three places (fetch_url AbortSignal listener not removed, edit_file AbortSignal silently dropped, execute_command abort race). Bug #1 is most likely the fourth instance of the same defect class in execute_command.

## Triaged scope for this wave

### Accept (no verification required — structurally clear or convergent)

- **fetch_url P1.1**: HTTPS→HTTP redirect downgrade (3/3 reviewer convergence; strongest signal in wave)
- **fetch_url P1.2**: explicit `rejectUnauthorized: true` (one-liner, defense-in-depth)
- **fetch_url P2.2**: AbortSignal listener leak — `removeEventListener` on `safeResolve` (3/3 convergence; **same category as bug #1**)
- **fetch_url P2.8**: trim `allowedUrlHosts` entries (3/3, one-liner)
- **execute_command P1.3**: add `aborted: boolean` field + close `pid === undefined` kill race (structural)
- **execute_command P2.6**: rewrite `exec_hints.ts` "try cmd" wording (this server is PowerShell-only)
- **edit_file P1.1**: thread `AbortSignal` through `editFileImpl` and `atomicWriteFile`. Includes prep commit refactoring `atomicWriteFile` signature
- **edit_file P2.1**: `EUNIQUE` absence hint conditional on `i > 0`
- **grep P1.1**: inner-deadline must precede outer-deadline by ≥ 2 s (2/2 convergence)
- **grep P1.3**: defense-in-depth guard for negative `context_lines` in `grepImpl`
- **grep P2.5**: defensive `re.lastIndex = 0` reset (one-liner)
- **grep P2.8**: assert compileGlob base absolute non-empty before checkAllowed

### Verify-first (test must fail demonstrating the bug before applying fix)

- **fetch_url P1.3**: `isInternalIP` misses `fe90::1`, `fea0::1`, `febc::1` (fe80::/10 partial block)
- **fetch_url P1.4**: `isInternalIP` misses `::ffff:c0a8:0101` (IPv4-mapped IPv6 hex-colon form)
- **fetch_url P2.4**: `final_url` returns query string unredacted (verify by inspecting current return value)
- **execute_command P1.1**: `-EncodedCommand <base64>` bypasses blocklist (security-relevant; Gemini-substituted only)
- **execute_command P1.2**: `rm -r C:\foo` bypasses blocklist (Gemini-substituted only)
- **grep P1.2** (combined with P2.7): single 10 KB line + pathological regex stalls beyond deadline

Procedure for verify-first: write a failing test that demonstrates the bug. If the test passes against current code, the finding is invalid (close as such, note in CHANGELOG). If the test fails, apply the fix.

### Defer to v0.7.1 patch (acknowledged but post-tag)

- **fetch_url P2.1** (truncated flag rewire) — needs spec decision; out of bug-fix scope
- **fetch_url P2.3** (gzip silent corruption Content-Encoding check)
- **fetch_url P2.5** (data handler settled guard)
- **fetch_url P2.6** (3xx body early destroy)
- **fetch_url P2.7** (EMAXREDIRECTS new code)
- **fetch_url P2.9** (trailing-dot FQDN — needs empirical test first)
- **execute_command P2.1-P2.5, P2.7-P2.8** — structural / docs / over-broad-blocklist
- **edit_file P2.2 / P2.3 / P2.4 / P3.x** — UTF-8 boundary, WeakMap fragility, TOCTOU
- **grep P2.1** (stream pagination memory) — moderate refactor
- **grep P2.2+P2.4+P2.9** (unified truncated semantics) — needs design call
- **grep P2.3 / P2.6** (CRLF/bare-`\r` docs only)

All P3 items deferred to v0.7.x cleanup pass.

### Out of scope entirely (not findings, but related observations)

- Re-running reviewers with real CLIs / API keys is operator work, not this wave's
- Process registry, ssh_exec, write_json, list_path_dirs reviews — separate post-tag wave

## Bug #1 investigation

Before applying ANY findings, localize and fix the EPERM_ROOT-hang bug. Reproducer:

1. Call `execute_command` with `cwd` outside `allowedRoots` → returns `EPERM_ROOT` correctly.
2. Within ~60s of that error, call any winfs tool (even `winfs:read` on a valid path) → hangs 4 minutes, then Claude Desktop reports "No result received from the local MCP server".
3. After the hang, server recovers; next call succeeds.

Hypothesis: in `execute_command`, the `allowedRoots` check on `cwd` happens AFTER some async resource is set up (child_process spawn, AbortSignal listener registration, deadline timer arm, etc.). When the check throws `EPERM_ROOT`, the resource leak holds the event loop or stdio pipes long enough that the next request can't process.

Investigation steps:

1. **Reproduce empirically.** Write a test that calls execute_command with bad cwd, then immediately calls another tool, asserts second call returns within 1 second. Confirm it fails (hangs).
2. **Read `src/tools/exec/execute_command.ts` and `src/core/exec_safety.ts`.** Trace the order of operations:
   - Where does `cwd` validation happen?
   - What async resources are created BEFORE that point?
   - Are they cleaned up in the EPERM_ROOT error path?
3. **Fix.** Move `cwd` validation to the very top of the handler, before any async setup. Or add `try / finally` cleanup around the resource setup that runs on every exit path (success, error, abort).
4. **Verify.** Re-run the test from step 1. It should now pass — second call returns immediately.
5. **Audit the pattern.** Apply the same lens to other tools: scan for `await` or resource creation that happens before validation. Document any other instances found (`grep -n "checkAllowed\|allowedRoots" src/tools/`).

If the bug is elsewhere (not execute_command — maybe it's actually in `runTool` wrapper or `MCPError` handling), the investigation steps surface the right location. Report finding regardless of fix.

## Phase plan

### Phase 0 — verify-first

For each item in the "Verify-first" section above, write a failing test under `tests/unit/<surface>/` named after the finding (`fe80_partial_block.test.ts`, etc.). Run `npm test` after each — confirm the test fails before any code change.

If a test PASSES (no bug present), close the finding as a false positive. Note in `audit/external_reviews/v0.7-pre-tag/_invalidated_findings.md` (new file) with one sentence each.

Five expected tests. Commit at the end of Phase 0:

```
chore(tests): pre-tag bug-fix wave — verify-first tests for 5 unverified findings
```

Report which tests failed (= real bugs, proceed to fix) and which passed (= invalid findings, dropped from this wave).

### Phase 1 — bug #1 + shared infrastructure precursor

Two commits in this phase:

1. **`fix(execute_command): early cwd validation eliminates EPERM_ROOT post-error hang`** (or wherever the investigation localizes the bug). Include the regression test from Bug #1 investigation step 1.
2. **`refactor(core): atomicWriteFile accepts AbortSignal`** — thread `signal` through `fs.open`, `handle.writeFile`, `handle.sync`, `fs.rename`. Update callers (write, append, edit_file impls) to pass `signal` from runTool's wrapper. No behavior change for callers that don't pass signal (default `undefined`). Test: mock slow rename + abort, assert temp cleanup. This is the precursor for edit_file P1.1.

### Phase 2 — per-tool P1 fixes

In severity-then-ease order. Each is one commit unless paired:

1. `fix(fetch_url): block HTTPS→HTTP redirect downgrade` (P1.1) — add protocol-downgrade check in redirect loop. Use new error code `EPROTOCOL_DOWNGRADE` or reuse `EHOSTNOTALLOWED` — judgment call, document either way.
2. `fix(fetch_url): explicit rejectUnauthorized: true on HTTPS options` (P1.2) — one-liner.
3. `fix(fetch_url): remove AbortSignal listener on safeResolve` (P2.2) — capture listener reference; `removeEventListener` in `safeResolve`. Same pattern as Phase 1 commit #1 will use.
4. `fix(fetch_url): trim allowedUrlHosts entries` (P2.8) — one-liner.
5. `fix(fetch_url): isInternalIP recognises full fe80::/10 range` (P1.3) — **only if** Phase 0 confirmed bypass.
6. `fix(fetch_url): isInternalIP recognises IPv4-mapped IPv6 hex-colon form` (P1.4) — only if Phase 0 confirmed bypass.
7. `fix(fetch_url): redact final_url query string in response` (P2.4) — only if Phase 0 confirmed leak.
8. `fix(exec_safety): block -EncodedCommand pattern` (P1.1) — only if Phase 0 confirmed bypass.
9. `fix(exec_safety): broaden rm short-flag pattern` (P1.2) — only if Phase 0 confirmed bypass.
10. `fix(execute_command): add aborted flag + close pid-undefined kill race` (P1.3) — structural.
11. `fix(exec_hints): rewrite "try cmd" wording for accuracy` (P2.6) — text-only.
12. `fix(edit_file): forward AbortSignal to editFileImpl I/O calls` (P1.1) — depends on Phase 1 commit #2. Edit signature + thread signal.
13. `fix(edit_file): EUNIQUE absence hint conditional on i > 0` (P2.1) — one-liner.
14. `fix(grep): inner-deadline precedes outer-deadline by ≥ 2 s` (P1.1) — recompute clamp order; regression test.
15. `fix(grep): defense-in-depth guard for negative context_lines` (P1.3) — one-liner.
16. `fix(grep): defensive re.lastIndex = 0 reset` (P2.5) — one-liner.
17. `fix(grep): assert compileGlob base absolute non-empty` (P2.8) — one-liner.
18. `fix(grep): cap per-line scan length for ReDoS protection` (P1.2 + P2.7 combined) — only if Phase 0 confirmed stall. Introduce `LINE_SCAN_CAP` (16 KB default); surface `truncated_long_line: true` per match.

### Phase 3 — docs, CHANGELOG, spec

One commit:

```
docs: v0.7 pre-tag bug-fix wave — CHANGELOG + spec amendments
```

Contents:
- CHANGELOG `[Unreleased]` — add all bug fixes under `Fixed`. Mention new error codes if any landed (`EPROTOCOL_DOWNGRADE`?).
- Spec amendments (if any new error codes or behavior contracts changed).
- Update `_invalidated_findings.md` if Phase 0 dropped any findings.

Push to origin/main at end.

## Commit decomposition summary

Approximate commit count: 1 (verify-first) + 2 (phase 1) + 15-18 (phase 2, depending on what Phase 0 invalidates) + 1 (phase 3) = **19-22 commits**.

CC may fold related fixes (e.g. consecutive one-liners on the same file) with judgment. No force-pushes, no rewrites of pushed history.

Baseline tests: 372 passing. Expected after wave: ~390-410 (+18-38 new regression tests across the wave).

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary.
- For verify-first items: **DO NOT apply the fix if the test passes against current code** — that means the finding is invalid. Close it in `_invalidated_findings.md`, skip the corresponding fix commit.
- New error codes (`EPROTOCOL_DOWNGRADE`, etc.) require updating the error-codes registry and spec.
- AbortSignal threading in atomicWriteFile must be backward-compatible (signal optional, default undefined).
- Bug #1 fix MUST include a regression test that fails without the fix — otherwise the bug recurs silently next session.
- No version bump in this wave. [Unreleased] only in CHANGELOG.
- Pre-existing 10 Windows-flaky failures in `tests/unit/process/*` — not addressed in this wave (out of scope, post-tag patch wave).

## Reporting

End of wave (single block):

```
v0.7 pre-tag bug-fix wave done:
  phase 0 verify-first: <N> tests written, <M> findings invalidated, <K> findings confirmed
  phase 1 bug #1 + atomicWriteFile: <sha> + <sha>
  phase 2 per-tool fixes: <N> commits, <listing of fix SHAs grouped by surface>
  phase 3 docs+changelog: <sha>
  main @ <sha>, pushed
  tests: <N> passing (was 372)
  new error codes: <listing or "none">
  invalidated findings: <listing from _invalidated_findings.md>
```

Plus: did bug #1 localization confirm the hypothesis (resource leak in execute_command setup before cwd validation)? Or was the actual root cause elsewhere? One-paragraph note.

On any failure: stop at the failing commit, report which fix, full stdout/stderr. Earlier phases pushed = safe checkpoint.
