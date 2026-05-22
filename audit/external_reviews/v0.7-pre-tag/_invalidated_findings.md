# v0.7 pre-tag review wave — invalidated findings

Findings that did NOT reproduce when subjected to a verify-first test during
the v0.7 pre-tag bug-fix wave (2026-05-22). The originating reviewer claim is
kept here for the audit trail; the test that disproved it is referenced.

## grep P1.2 + P2.7 — ReDoS within single line beyond deadline (invalidated 2026-05-22)

**Source:** Kimi review F2 file artifact, items C1 + D4 (combined into P1.2 +
P2.7 in `_findings_grep_2026-05-22T0859Z.md`).

**Claim:** `re.test(line)` runs to completion; the deadline-driven abort is
checked between lines, so a pathological pattern like `(a+)+$` on a long line
of 'a' can stall V8's regex engine for many seconds despite the deadline
firing.

**Test:** `tests/unit/search/grep_redos_line_scan.test.ts` — 10 000-character
line of 'a' + pattern `(a+)+$` with 500 ms deadline.

**Result:** elapsed ~10 ms (consistently). V8 returns within 2 % of the
deadline, not 2 000 % of it. V8 has hardened common ReDoS-bait patterns
against catastrophic backtracking at the regex-compiler level on the Node
version used here.

**Verdict:** finding does NOT reproduce. No `LINE_SCAN_CAP` introduced in
this wave. The Phase 0 test stays in the suite, flipped to pin the observed
fast behavior — if a future Node regression reintroduces the stall, the test
re-opens the discussion automatically.

**Caveat:** other pathological patterns (e.g., `(a|a)+b` with the right
input) could still stall a different V8 version. The general line-scan-cap
fix is reserved for a future wave if any such regression surfaces. Phase 0
test does not exhaustively probe; it pins this one bait.
