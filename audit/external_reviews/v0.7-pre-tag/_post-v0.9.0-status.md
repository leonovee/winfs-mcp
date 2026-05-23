# v0.7 pre-tag P2 findings — status at main @ a7bcfcd (post-v0.9.0)

Re-triage as Phase 0 of the v0.9.1 patch-wave prompt. Cross-checks each
P2 from the 4 consolidation files against current `main` source to
identify which items were incidentally closed by intervening waves
(v0.7 pre-tag bug-fix, v0.7.1 hotfix, v0.7.2 H2, v0.8 filesystem-parity,
v0.8.0 cut, v0.8 P3 audit-IO investigation, v0.9.0 MCP Roots).

**Summary**

| Surface | Open | Closed | Doc-only | Total P2 |
|---|---|---|---|---|
| fetch_url | 6 | 3 (P2.2, P2.4, P2.8) | 0 | 9 |
| execute_command | 6 (1 partially mitigated) | 1 (P2.6) | 1 (P2.5) | 8 |
| edit_file | 3 | 1 (P2.1) | 0 | 4 |
| grep | 5 | 2 (P2.5, P2.8) | 2 (P2.3, P2.6) | 9 |
| **Total** | **20** (1 partial) | **7** | **3** | **30** |

Of the 20 still-open: ~5 trivial one-liners, ~7 small-refactor scope,
~4 medium, ~3 large (edit_file P2.4 TOCTOU is the canonical "may blow
up" item per the v0.9.1 prompt).

---

## fetch_url

### P2.1 — `truncated` flag dead in the success path
**Status: STILL OPEN.** Verified at `src/tools/network/fetch_url.ts:380-402`
(data handler still sets `truncated = true` then fires `safeResolve(ESIZE)`;
the `end` handler that would return `{truncated: true}` is unreachable).
Wave 2c, v0.7 bug-fix, and v0.8 filesystem-parity all left this alone.
**v0.9.1 plan**: Phase C1 rewire — split into named fields, deprecate
`truncated` boolean with one-release alias.

### P2.2 — AbortSignal listener leak on normal completion
**CLOSED in v0.7 pre-tag bug-fix wave, commit `8b10c72`** —
`safeResolve` calls `p.signal.removeEventListener("abort", onAbort)`
explicitly. Verified at `src/tools/network/fetch_url.ts:299-307`. No
further action.

### P2.3 — Silent gzip corruption when server ignores `Accept-Encoding: identity`
**Status: STILL OPEN.** No `Content-Encoding` check anywhere in
fetch_url. **v0.9.1 plan**: Phase C2 — refuse with new error code
(`EENCODING_UNSUPPORTED { encoding: "gzip" }`) per CC judgment in
prompt; transparent decompression is the "preferred but bigger" path,
deferred until a real workload demands it.

### P2.4 — `final_url` leaks unredacted query string
**CLOSED in v0.7 pre-tag bug-fix wave, commit `d5fc256`** — `final_url`
wrapped in `redactUrlForAudit(currentUrl.toString())`. Verified the
match in the smoke probe (`bugfix: fetch_url final_url redacts query`).
No further action.

### P2.5 — `data` handler missing `settled` guard
**Status: STILL OPEN.** Verified at line 380 (`res.on("data", ...)`) —
no `if (settled) return;` early-out. Easy one-liner.
**v0.9.1 plan**: Phase C3 — add the guard.

### P2.6 — 3xx body wasted bandwidth (DoS vector)
**Status: STILL OPEN.** Verified at line 374-379 (Location read but no
`res.destroy()` after). Body keeps streaming up to `maxBytes` for every
3xx hop.
**v0.9.1 plan**: Phase C4 — `res.destroy()` after stamping `redirectTo`.

### P2.7 — Wrong error code `EHOSTNOTALLOWED` for redirect-limit exhaustion
**Status: STILL OPEN.** Verified at `fetchUrlImpl` redirect loop —
`EHOSTNOTALLOWED` returned when `hops > MAX_REDIRECTS`. Semantically
wrong; misleads callers' error-handling logic.
**v0.9.1 plan**: Phase C5 — new error code `EMAXREDIRECTS`. Caller-
breaking change: callers checking `EHOSTNOTALLOWED` on the redirect
exhaustion path will see the new code. Flagged in CHANGELOG.

### P2.8 — Whitelist entries not `.trim()`-ed
**CLOSED in v0.7 pre-tag bug-fix wave, commit `1310f80`** —
`validateHostWhitelist` uses `map((h) => h.trim().toLowerCase())`.
Verified at line 164. No further action.

### P2.9 — Trailing-dot FQDN whitelist behavior
**Status: STILL OPEN (verify-first).** Reviewer disagreement at the
time. DeepSeek tested and said safe ("WHATWG URL parser strips trailing
dot"); Kimi denied with "needs empirical verification".
**v0.9.1 plan**: Phase C6 — write failing test that demonstrates the
bypass. If passes against current code, mark invalid. If fails, apply
fix (strip trailing dot before whitelist comparison).

---

## execute_command

### P2.1 — `&` operator output silent-drop on Windows
**Status: PARTIALLY MITIGATED.** Prompt-side: the v0.7.1 + v0.7.2 H2
hardening (commits `cd1f7c7`) added `-OutputFormat Text`, `-InputFormat
None`, `[Console]::OutputEncoding = UTF8`, `exit $LASTEXITCODE`. The
underlying PowerShell-host quirk still exists, but the wrapper now
forces text-mode output and propagates exit codes through the `&`
operator more reliably. The bug #2 investigation (v0.7.1, regression
tests in `tests/unit/exec/stdout_capture.regression.test.ts`) confirms
stdout capture works correctly at the in-process layer.
**v0.9.1 plan**: skip — covered by existing hardening + regression
test suite.

### P2.2 — Argument composition quoting: caller burden poorly surfaced
**Status: STILL OPEN.** No pre-validation of argv elements for
PowerShell metacharacters.
**v0.9.1 plan**: Phase C7 — judgment call. Most callers compose
deliberately; eager validation may produce false positives. Likely
**skip with doc note** in tool description.

### P2.3 — Blocklist cache invalidation: cache key excludes `DEFAULT_EXEC_BLOCKLIST`
**Status: STILL OPEN.** `compileBlocklist` caches on `extra` only.
Production impact nil today (DEFAULT_EXEC_BLOCKLIST never mutated at
runtime); structural fragility.
**v0.9.1 plan**: Phase C7 — hash DEFAULT into cache key. Small change.

### P2.4 — PATH sanitization: non-standard git install paths not covered
**Status: STILL OPEN.** `sanitizedPathDirs` whitelists only the
standard Git install. Portable git / MSYS2 / chocolatey installs
invisible to subprocesses.
**v0.9.1 plan**: Phase C7 — startup-time dynamic probe via
`Get-Command git` against pre-sanitization PATH. Medium change; may
defer if scope blows up.

### P2.5 — `taskkill /T` doesn't catch detached grandchildren
**Status: DOC-ONLY.** Known Windows limitation; tool description
already says "best-effort". No code change worth shipping.
**v0.9.1 plan**: Phase C7 — extend tool description with explicit
"detached child processes that leave the process group are NOT
terminated by /T" note.

### P2.6 — Hint text accuracy: "try cmd" inapplicable
**CLOSED in v0.7 pre-tag bug-fix wave, commit `7a0b56b`** — hint
rewritten to surface Start-Process / ssh_exec / direct-binary
alternatives. Verified in `src/core/exec_hints.ts`. No further action.

### P2.7 — `taskkill /F` blocklist may be over-broad
**Status: STILL OPEN.** Pattern blocks ALL `taskkill /F ...`
invocations including legitimate single-process force-kills.
**v0.9.1 plan**: Phase C7 — judgment call. Narrow to `taskkill /F /T`
(only block tree-force-kill); accept narrower scope as strict-by-
default.

### P2.8 — `cwdCheck` cast: unsafe type assertion
**Status: STILL OPEN.** `(cwdCheck as { realPath: string }).realPath`
at `execute_command.ts:91`. Works because checkAllowed returns
`{ realPath }` on success today; future change could silently produce
undefined.
**v0.9.1 plan**: Phase C7 — replace cast with proper discriminant
check (`if ("realPath" in cwdCheck)`). One-liner.

---

## edit_file

### P2.1 — `EUNIQUE` hint for `edit[0]` with `occ=0` is misleading
**CLOSED in v0.7 pre-tag bug-fix wave, commit `ce0fcb2`** — hint
conditional on `i > 0`; first-edit absence suggests checking spelling
and whitespace. Verified in `src/tools/editor/edit_file.ts:158-165`.
No further action.

### P2.2 — Diff truncation may split UTF-8 boundary, emitting trailing U+FFFD
**Status: STILL OPEN.** Verified at `src/tools/editor/edit_file.ts:219-222`
— `Buffer.subarray(0, 16384).toString("utf8")` cuts at byte boundary,
not codepoint boundary. Real for non-ASCII content; cosmetic for the
typical ASCII-Windows-path use.
**v0.9.1 plan**: Phase C8 — walk backward to the last valid UTF-8
sequence boundary before slicing. Small helper.

### P2.3 — `auditByResult` WeakMap fragility
**Status: STILL OPEN.** WeakMap stores `value` by object identity;
fragile if a future wrapping layer destructures or clones `result.value`.
No current bug.
**v0.9.1 plan**: Phase C9 — judgment call. The fragility is real but
the WeakMap pattern is well-tested today. Likely **defer** with spec
amendment documenting the convention "do not clone `result.value`
between impl and runTool".

### P2.4 — TOCTOU: `checkAllowed` realpath is stale by the time `readFile` / `atomicWriteFile` run
**Status: STILL OPEN.** Prompt explicitly flags this as the "may blow
up" item.
**v0.9.1 plan**: Phase C10 — apply v0.3.2 audit_tail fd-bound pattern:
open fd at stat time, read via fd, coordinate write ordering. Stop and
report if scope expands beyond one commit.

---

## grep

### P2.1 — Full-scan-before-slice memory pressure
**Status: STILL OPEN.** `searchFileFull` accumulates to
TOTAL_MATCH_CEILING (10 000) before sort+slice. Pattern `.*` with
`offset=9999, limit=1` loads all 10 000 matches before slicing.
**v0.9.1 plan**: Phase C11 — short-circuit when collected matches
≥ `offset + limit + buffer`. Bounded memory.

### P2.2 — `next_offset` misleads when `total_matches_capped: true`
**Status: STILL OPEN.** When ceiling hit, `totalMatches = 10000` is a
LOWER bound; `next_offset = offset + page.length` may point past the
actual scan boundary.
**v0.9.1 plan**: Phase C12 — bundle with P2.4, P2.9 as unified
truncated semantics rewrite.

### P2.3 — Pattern `\r` on CRLF files returns zero matches
**Status: DOC-ONLY.** Line-mode normalisation strips `\r` before
iteration. Behaviour is intentional; spec contract documentation gap.
**v0.9.1 plan**: Phase C13 — README + spec note on line-ending
normalisation. No code change.

### P2.4 — `next_offset` ambiguous on timeout truncation
**Status: STILL OPEN.** When walk aborts due to timeout, `totalMatches`
is partial. Related to P2.2.
**v0.9.1 plan**: Phase C12 — bundled with P2.2 + P2.9.

### P2.5 — `re.lastIndex` latent corruption across files
**CLOSED in v0.7 pre-tag bug-fix wave, commit `9d8ca78`** — defensive
`re.lastIndex = 0` reset at the top of both inner loops in
`searchFile` and `searchFileFull`. Verified at
`src/tools/search/grep.ts:135-140`. No further action.

### P2.6 — Bare `\r` line endings (old Mac) treated as one giant line
**Status: DOC-ONLY.** Same line-ending normalisation as P2.3; documented
together.
**v0.9.1 plan**: Phase C13 — bundled with P2.3.

### P2.7 — 10 MB single line stored in `match.match` without cap
**Status: STILL OPEN.** No per-line length cap. Memory-pressure DoS
vector if attacker controls input.
**v0.9.1 plan**: Phase C7-equivalent — likely **skip** or fold into a
later structural pass. Out of v0.9.1 scope unless a quick cap is
trivially addable.

### P2.8 — Wildcards-only glob may produce empty base
**CLOSED in v0.7 pre-tag bug-fix wave, commit `9d8ca78`** — defense-
in-depth assert at `src/tools/search/grep.ts` checks
`compileGlob.base` is absolute non-empty. Verified. No further action.

### P2.9 — `truncated=false` but `total_matches_capped=true` invisible
**Status: STILL OPEN.** Related to P2.2 + P2.4.
**v0.9.1 plan**: Phase C12 — bundled.

---

## Phase C narrowed scope (post-triage)

The prompt's 13-item Phase C list narrows to:

| Item | Phase | Effort | Risk |
|---|---|---|---|
| C1 fetch_url P2.1 truncated rewire | small | low | back-compat alias one release |
| C2 fetch_url P2.3 gzip refuse | small | low | new error code |
| C3 fetch_url P2.5 settled guard | trivial | low | one-liner |
| C4 fetch_url P2.6 3xx early destroy | trivial | low | one-liner |
| C5 fetch_url P2.7 EMAXREDIRECTS | small | medium | caller-breaking |
| C6 fetch_url P2.9 trailing-dot FQDN | verify-first | low | may be invalid |
| C7 execute_command bundle (P2.3 cache, P2.5 doc, P2.7 narrow, P2.8 cast) | small | low | |
|   — execute_command P2.1 mitigated; P2.2 + P2.4 likely skip | n/a | |
| C8 edit_file P2.2 UTF-8 boundary | small | low | |
| C9 edit_file P2.3 WeakMap docs | doc-only | low | defer code change |
| C10 edit_file P2.4 TOCTOU | **largest, may blow up** | high | fold-or-punt |
| C11 grep P2.1 streaming pagination | small-medium | low | |
| C12 grep P2.2+P2.4+P2.9 unified semantics | medium | low | |
| C13 grep P2.3+P2.6 doc | trivial | low | |

Tactical ordering: C3-C8 are quick wins. C10 is gated by scope. C11+C12
sit between depending on grep refactor depth. C13 is appended at the
end.

Of the 30 originally-deferred P2s, after v0.9.1: **at most 5 unaddressed**
(execute_command P2.2 / P2.4 / grep P2.7 / edit_file P2.3 / possibly
edit_file P2.4 if it punts). All are documented; all are non-blocking;
all are tracked here for a future patch.
