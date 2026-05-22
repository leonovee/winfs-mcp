# grep.ts external review — findings consolidation — 2026-05-22T0859Z

Wave: `v0.7-pre-tag-grep` against `main @ a885126`. File: `src/tools/search/grep.ts`.

## ⚠ Wave provenance caveat

The v0.7 pre-tag review wave hit a tooling gap on this machine: the `codex`
and `gemini` CLIs are not installed, the `kimi` CLI is not installed, and
the DeepSeek API key is not present in the environment. The 4 cells split
as follows for this surface:

| Reviewer | Status | Provenance |
|---|---|---|
| **Codex** | failure-only artifact (1.5 KB) | CLI not installed; agent returned a verbatim failure notice with no review content. |
| **Kimi** | substantive artifact (19.6 KB) | API call via `moonshot-v1-128k` fallback (preferred `kimi-k2.6` timed out on thinking-token budget). Genuine model output, subagent then triaged for false positives. |
| **Gemini** | substantive artifact (13.3 KB), substituted | CLI not installed; the gemini-reviewer subagent substituted its own Sonnet-driven static analysis. Explicitly labeled in the artifact. |
| **DeepSeek** | missing artifact | Agent stopped on missing API key. No findings written; key resolution blocked by auto-mode classifier on `C:\Users\User\Desktop\ai\ai-judge\.env`. |

The methodology's 4-eyes convergence signal is **structurally compromised**
for this surface. Treat the findings below as engineering opinions from
the indicated source — not as confirmed multi-reviewer agreement. Where
both Kimi and Gemini-substituted raise the same issue, that's promising
signal; where only one raises it, that's a single-source claim.

## Reviewer profiles (recap)

- Codex — tightest, sharp on P1, ~4 findings. **Did not run** here.
- Kimi — adversarial process-risk, ~10+ findings. Ran via API.
- Gemini — Windows-specific (CRLF/BOM/junctions, PowerShell quoting), ~7 findings. **Substituted**.
- DeepSeek — anti-hallucination structural concerns. **Did not run**.

## P1 findings (cross-reviewer signal)

### P1.1 — Deadline race at `timeout_ms = config.maxTimeoutMs`

Raised by: **Kimi (real)** + **Gemini (substituted)** — convergence on 2/2 reviewers that ran.

- Kimi `[B1]`: "When `timeout_ms = config.maxTimeoutMs`, both timers fire at the same wall-clock instant. The outer `runTool` wrapper may win, returning ETIMEDOUT error instead of `{truncated:true, reason:"timeout"}`. Non-deterministic failure." Lines 348-359 (`outerDeadline = Math.min(innerDeadline + 2000, maxTimeoutMs)` formula in `registerGrepTool`).
- Gemini `P1-1`: "When `timeout_ms = maxTimeoutMs`, `innerDeadline === outerDeadline === 60000`. Node.js timer ordering is non-deterministic at equal expiry … the outer `withTimeout` wrapper can fire first, returning `ETIMEDOUT` instead of `{truncated:true, reason:"timeout"}`." Lines 356-359.

**Converged description.** When the caller passes `timeout_ms` equal to (or close to) `config.maxTimeoutMs`, the inner deadline used to convert grep into a partial-result response is clamped equal to the outer wrapper deadline. The grep handler intends "inner fires ~2 s before outer so partial results win". The clamp via `Math.min(..., maxTimeoutMs)` collapses that gap to zero.

**Recommended fix.** Compute the outer deadline first against `maxTimeoutMs`, then derive the inner deadline as `outerDeadline - OUTER_TIMEOUT_BUFFER_MS` (≥ 2 000). Or clamp `innerDeadline` to `maxTimeoutMs - OUTER_TIMEOUT_BUFFER_MS` before computing `outerDeadline`. Add a unit test that exercises `timeout_ms = maxTimeoutMs` and asserts the partial-result path wins.

### P1.2 — Catastrophic backtracking ReDoS stalls within a single line

Raised by: **Kimi (real)** only. Single-source.

- Kimi `[C1]`: "The abort signal is checked BETWEEN lines but a single line's `regex.test()` runs to completion. Pattern `(a+)+$` on a 10 000-char line of 'a' can stall V8 for minutes despite the deadline." Line 133 (`re.test(line)` inside `searchFile/searchFileFull`).

**Converged description.** Per-line abort cooperation. The deadline-driven abort is checked between lines, not within a single regex match. A pathological pattern + a long line can stall the V8 regex engine in a single uninterruptible call, exceeding the wall-clock timeout.

**Recommended fix.** Two options: (a) cap maximum line length scanned (e.g. 16 KB per line) — surface `truncated_long_line: true` per match if hit; (b) introduce a worker-thread-isolated regex matcher per line so the deadline can SIGTERM it. Option (a) is the cheap one; option (b) is the correct one. For v0.7 tag, prefer (a) + a single test fixture proving the bound. Document the cap in the tool description.

### P1.3 — `context_lines = -1` bypasses impl-level guard

Raised by: **Kimi (real)** only. Single-source.

- Kimi `[F3]`: "No defense-in-depth check for negative `context_lines` inside `grepImpl`. `Math.max(0, i - (-1)) = i + 1` widens the before-context window by one extra line per match. Zod guards the registered tool path; internal callers (unit tests, future tools) bypass this." Lines 136-139 / 178-183.

**Converged description.** Zod input validation at the registered tool boundary correctly rejects negative `context_lines`. Internal callers that invoke `grepImpl` directly (current: unit tests; future: composed tools) bypass the Zod gate. There's no inner sanity assertion.

**Recommended fix.** Add `if (context_lines < 0 || !Number.isInteger(context_lines)) return EINVAL` at the top of `grepImpl`. Mirror the Zod constraint as an inner assertion. Trivial one-liner; closes the defense-in-depth gap.

## P2 findings

### P2.1 — Full-scan-before-slice memory pressure (Kimi P2 [A4])

`searchFileFull` accumulates into `allMatches` up to TOTAL_MATCH_CEILING before sort+slice. Pattern `.*` with `limit=1, offset=9999` on a 10 000-line file loads all 10 000 `Match` objects (~5 MB worst case) before slicing. Repeated pagination from an untrusted caller = DoS vector. Lines 230-277. **Fix:** stream slice — discard matches with `index < offset` and stop accumulating once `index >= offset + limit + buffer`. Same final result, bounded memory.

### P2.2 — `next_offset` misleads when `total_matches_capped: true` (Kimi P2 [A6])

When the ceiling is hit, `totalMatches = 10 000` is a lower bound. A caller with `offset=9995, limit=10` gets `next_offset=10005`. But the scan stopped at 10 000; position 10005 was never checked. Paginating to 10005 returns `{matches:[]}` and the caller must infer termination. Lines 284-289. **Fix:** when `total_matches_capped === true`, set `truncated: true` and either omit `next_offset` or document the lower-bound semantics in the tool description.

### P2.3 — Pattern `\r` on CRLF files returns zero matches (Kimi P2 [C4])

`text.split(/\r?\n/)` strips `\r` before line iteration. Searching for `\r` finds nothing on CRLF-encoded files even though `\r` bytes are present. Cosmetic given Windows tooling normally hides `\r`, but spec contract is silently false. Line 128. **Fix:** add an explicit note in the tool description that line-mode normalises CRLF, or expose a byte-mode toggle.

### P2.4 — `next_offset` ambiguous on timeout truncation (Gemini P1-3, downgraded by reviewer-style reading to P2)

When the walk aborts due to timeout, `totalMatches` is a partial count. If `offset + page.length >= totalMatches` at timeout, `next_offset` is `undefined` — indistinguishable from "last page". Caller cannot know whether the scan completed. Line 286. **Fix:** when `reason === "timeout"`, always emit `next_offset` (or always set `total_matches_capped: true` on timeout), since both make `total_matches` a lower bound. Note: this overlaps with P2.2; consider a single output-flag redesign covering both timeout-truncation and ceiling-truncation pagination semantics.

### P2.5 — `re.lastIndex` latent corruption across files (Gemini P1-2, downgraded — not exploitable today)

Same `RegExp` instance reused across all files. If the regex were ever compiled with `g` or `y` flags (currently not, but the description says "JavaScript regex source" inviting future flag-pass-through), `re.test(line)` advances `lastIndex`, causing false negatives. Lines 133, 176. **Fix:** add `re.lastIndex = 0` at the top of both inner loops as a defensive invariant. One-liner.

### P2.6 — Bare `\r` line endings (old Mac) treated as one giant line (Kimi P2 [D2])

`split(/\r?\n/)` doesn't split on bare `\r`. Old-Mac-format file is one line; line numbers all 1, `context_lines` ineffective. Low real-world impact. **Fix accepted as documented limitation** unless callers complain.

### P2.7 — 10 MB single line stored in `match.match` without cap (Kimi P2 [D4])

No per-line length limit. A file with a single 10 MB line produces a `Match` with a 10 MB `match.match` string; with `context_lines > 0`, context arrays multiply this. Memory pressure DoS. Line 134. **Fix:** truncate `match.match` to a sensible cap (4 KB) with a `truncated: true` flag on the Match object, or share with P1.2's line cap.

### P2.8 — Wildcards-only glob may produce empty base (Kimi P2 [E1])

`compileGlob("**/*.ts")` may return `base=""` or `base="."`. `checkAllowed("")` behavior depends on `compileGlob` — flagged as candidate P1 pending separate compileGlob review. Line 204. **Fix:** assert `base.length > 0 && path.isAbsolute(base)` before `checkAllowed`.

### P2.9 — `truncated=false` but `total_matches_capped=true` invisible to bare checks (Kimi P2 [H2])

When the ceiling is hit with no timeout and no page overflow, `truncated` stays `false`. Callers that only check `truncated` consider the result complete. Spec correctness depends on reading `total_matches_capped` separately. **Fix:** set `truncated: true` whenever `total_matches_capped` is true; the two flags should be consistent.

## P3 findings

- **P3.1 — DNS rebinding etc. not applicable to grep** (Gemini noted; not relevant)
- **P3.2 — Pattern with embedded V8-flag-like syntax `(?m)^foo`** — V8 treats it as a literal flag-group, not interpreted; theoretical only.
- **P3.3 — `dropped` byte-count slightly over-counts when truncation lands mid-UTF-8** — applies to diff_files style truncation, not grep.
- **P3.4 — UNC paths on Windows untested** (Kimi theoretical).

## Reviewer-unique findings flagged

All findings above are **single-source** (one reviewer raised), with the exception of P1.1 (deadline race) which appears in both Kimi and Gemini-substituted. Note that Gemini-substituted is Sonnet-driven and may have been primed by similar reasoning paths as the Kimi triage step — convergence is weaker than two independent CLIs would provide.

## Recommended action plan

In severity-then-ease order. Each entry is a candidate `fix(grep): ...` commit. Chat-Claude approval gates before any commit.

1. **`fix(grep): inner-deadline must precede outer-deadline by ≥ 2 s` (P1.1)** — recompute clamp order. Add test asserting partial-result path wins at `timeout_ms = maxTimeoutMs`. Two-line change.
2. **`fix(grep): defense-in-depth guard for negative context_lines` (P1.3)** — add early `EINVAL` at impl entry. One-liner.
3. **`fix(grep): cap match.match line length` (P1.2 + P2.7 combined)** — introduce per-line scan cap (default 16 KB), surface `truncated_long_line: true` per Match. Closes the ReDoS-on-long-line stall AND the 10 MB-match-string memory bloat in one change.
4. **`fix(grep): stream pagination — discard pre-offset matches` (P2.1)** — change `searchFileFull` to short-circuit when `index >= offset + limit + buffer`. Bounded memory.
5. **`fix(grep): unify truncated semantics with total_matches_capped + timeout` (P2.2 + P2.4 + P2.9)** — single output-flag redesign covering all three pagination edge cases. One PR, three findings closed.
6. **`fix(grep): defensive re.lastIndex reset on each line/file boundary` (P2.5)** — one-liner.
7. **`fix(grep): assert compileGlob base is absolute non-empty before checkAllowed` (P2.8)** — one-liner + one regression test.
8. **`docs(grep): CRLF normalization caveat + bare-\\r-file limitation` (P2.3 + P2.6)** — tool-description note. No code change.

P3 items defer to v0.7.x cleanup pass.

## Re-run guidance

If Vladimir / chat-Claude wants the missing reviewer confidence:

- **Codex**: install via `npm install -g @openai/codex` after creating `C:\Users\User\AppData\Roaming\npm`. Then re-invoke `codex-reviewer` subagent with the same phase id.
- **DeepSeek**: copy the API key from `C:\Users\User\Desktop\ai\ai-judge\.env` into `C:\Users\User\Desktop\ai\tools\winfs\.env` as `DEEPSEEK_API_KEY=...` or set as a User env var. Then re-invoke `deepseek-reviewer`.
- **Gemini (real, not substituted)**: install `@google/gemini-cli` via npm and authenticate. The current artifact's findings are Sonnet-driven; a real Gemini run would replace them.

Single re-run per missing/substituted cell is sufficient — the wave methodology supports targeted top-ups.
