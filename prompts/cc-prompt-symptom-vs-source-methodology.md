# CC prompt — methodology note: symptom-vs-source discipline

## Origin

Two consecutive bug investigations in v0.7 (bug #1 EPERM_ROOT hang in pre-tag bug-fix wave, bug #2 silent stdout / PATHEXT in v0.7.1 hotfix) followed the same anti-pattern: caller-side symptom → confident source-code hypothesis → fix prompt written → CC investigates → in-process reproducer test passes → no source-code defect → defensive coverage shipped instead of fix.

Wave 2c added the blocklist verify-then-smoke methodology note to CLAUDE.md. This follow-up adds the second methodology lesson from the same v0.7 cycle — they were originally meant to land together (drafted as Phase D in the wave 2c prompt), but the wave 2c prompt update couldn't be written due to MCP transport stalls, so it lands as a single-commit follow-up here.

Pure docs commit. No code touched.

## Phase A — locate the section

```
grep -n '^## \|^### ' CLAUDE.md
```

Find where the wave 2c blocklist methodology note landed in `CLAUDE.md`. Add the new note as a sibling subsection — same section, immediately after the blocklist one (they're both "methodology procedures for bug investigation" and belong together).

## Phase B — add the note

Add subsection. Title: **"Symptom-driven hypotheses require in-process reproducer FIRST."**

Body:

> When a symptom is observed in a chat-Claude session (or any caller-side context), the temptation is to formulate a source-code hypothesis ("resource leak in X", "wrong env var Y", "spawn pipe broken") and write a fix prompt directly. This bypassed an essential verification step in two consecutive v0.7 cases.
>
> **Caller-side context can include any number of layers between the symptom and the server code** — MCP transport between Claude Desktop and the spawned winfs process, JSON-RPC framing, the specific winfs binary/version mounted by the Claude Desktop instance, parent process environment that differs from system default, ad-hoc PowerShell session state, etc. Any of these layers can produce a symptom indistinguishable from a source-code defect.
>
> Procedure for any bug investigation triggered by a caller-side symptom:
>
> 1. **Symptom observed.** Record it precisely — exact command, expected vs actual output, error code if any. Do NOT yet formulate a source-code hypothesis.
>
> 2. **Phase 0 — write in-process reproducer test against impl layer.** Direct call to e.g. `executeCommandImpl({ command: ["node", "--version"] }, ctx)`, NOT via MCP wrapper. Run.
>
> 3. **If reproducer FAILS** (test surfaces the symptom against impl layer): the bug IS in source code. Formulate hypothesis, write fix prompt, apply fix, verify reproducer now passes, ship.
>
> 4. **If reproducer PASSES** (no bug at impl layer): the symptom is environmental. Two follow-up actions:
>    - **Ship defensive coverage** as a tagged release. Regression tests pin the invariant at impl layer so any future drift surfaces immediately. Smoke probes added to the wire-level harness for additional cover.
>    - **Investigate environment separately.** If symptom continues to reproduce in chat-Claude / CC sessions, gather traffic-log evidence (request bytes + response bytes as seen by the transport) to localize whether the request even reaches the spawned winfs process. Do NOT speculate further about source-code defects.
>
> 5. **Optional defensive hardening.** If the suspected environmental cause has a known mitigation that is independently good practice (e.g. PowerShell subprocess hardening: `-NoProfile`, `-InputFormat None`, explicit UTF-8 encoding), ship as belt-and-suspenders in a separate release. This is not a fix in the prompt's sense — it's general hygiene that happens to close one possible environmental cause.
>
> References:
> - Bug #1 (EPERM_ROOT hang) — investigated v0.7 pre-tag bug-fix wave, no source-code defect, regression test in `tests/unit/exec/bug1_eperm_root_hang.test.ts` pins invariant.
> - Bug #2 (silent stdout / PATHEXT) — investigated v0.7.1 hotfix, no source-code defect, regression tests in `tests/unit/exec/stdout_capture.regression.test.ts` + smoke probes pin invariant. v0.7.2 added H2 defensive hardening separately.

Adjust prose to match the voice of the wave 2c blocklist methodology note already in CLAUDE.md. Test-file paths and commit references must be accurate — if any path has drifted or the test file lives elsewhere, use the actual location.

## Phase C — commit + push

Commit:

```
docs(claude.md): methodology — symptom-driven hypotheses require in-process reproducer first
```

Push to `origin/main`.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green (no code touched, so test count stays at 408).
- No version bump. `[Unreleased]` may gain a `Docs` line if CHANGELOG conventions call for it; CC's judgment.
- Reference test paths and commit SHAs must be real — they're for future operators to actually find.

## Reporting

```
symptom-vs-source methodology note done:
  @ <sha>, pushed, main @ <sha>
  tests: 408 (no change)
```

On any failure: stop, report, full output.
