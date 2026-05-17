# v0.5.0 execution directive — implement-all-then-test

> **Operator directive (2026-05-17):** «Реализуем всё до конца. Потом общий тест.»
>
> **Audience:** Claude Code working in `C:\Users\Expert\Desktop\AI\tools\winfs\` on `main` after Phase 4a (HEAD = `d66dce7`, origin/main = `d66dce7`).
>
> **Base prompt:** `prompts/cc-prompt-mcp-winfs-v0.5.md` — read it first, then apply the deviations below.

---

## Deviations from base v0.5 prompt

### SKIP Phase 4b (external reviews) entirely

The v0.5 base prompt has Phase 4b — external review wave for `grep.ts` + `edit_file.ts` via terminal-CC subagents — listed as a prerequisite before Phase 4c. **For this execution: skip Phase 4b.** Reviews land as post-v0.5.0 patch waves (`v0.5.1`, `v0.5.2`, etc.) per the v0.3.x cadence precedent.

Rationale: operator directive prioritizes shipping the full 29-tool surface over upfront review gating. Audit-trail of the v0.3.x cycle proves that post-tag review waves yield productive patch releases without compromising stability.

### SKIP per-surface immediate reviews in Phase 4d / 4e

Base prompt has «mandatory 4-LLM review for `execute_command` (Phase 4d step 10) and `fetch_url` (Phase 4e step 16) before v0.5.0 tag». **For this execution: skip these mid-cycle reviews too.** They land as post-v0.5.0 patch waves alongside grep + edit_file reviews.

Rationale: same as above. Single-eye-on-code accepted as risk for shipping speed; review findings absorbed as v0.5.x patch waves.

### Phase 4f stays as written

Full test sweep, Inspector smoke run, spec amendments, README/CHANGELOG/acceptance, tag, push — **all retained**. Single batched `npm test` against the 29-tool surface is the **gate**: if red, fix-iterate before tag. If Inspector probes find regression, fix-iterate. Tag only on full green.

---

## Execution sequence (overrides base prompt §4)

### Phase 4cde — implement 11 tools

Per base prompt §4 Phase 4c/4d/4e structure, **no review pauses**:

1. **Phase 4c — Git Read-Only (5 tools)** per base prompt §4 Phase 4c. Commit per tool. New error codes added to spec §5 in the same commit as the tool that introduces them.
2. **Phase 4d — Exec (3 tools)** per base prompt §4 Phase 4d. **Skip step 10** (immediate execute_command review). Continue straight to `run_python` then `run_pytest`.
3. **Phase 4e — System + Network (3 tools)** per base prompt §4 Phase 4e. **Skip step 16** (immediate fetch_url review). Continue straight to Phase 4f.

CC may sanity-check subset tests while building (`npm test -- src/tools/git/git_log.test.ts`) per base prompt lesson #16. Full test sweep deferred to Phase 4f.

### Phase 4f — close out

Per base prompt §4 Phase 4f, executed in order:

17. **Full test sweep:** `npm run build && npm test`. Expected: 240+ tests passing, zero TS warnings. If red — `fix(<tool>): <issue>` commit, re-run. **Iterate until green** before proceeding to docs.
18. **Spec amendments §M–§P+** (continuation of existing letter sequence; §M is already used by Phase 4a entries_seen_total — next available letter is §N): `docs(spec): §N–§<X> amendments for v0.5 invariants`. Cover:
    - Git RO mutation-flag denylist + structured output policy
    - Exec blocklist extensibility (additive-only config)
    - Exec PATH sanitization + python binary discovery via `config.pythonHome`
    - check_env safe-prefix mathematical bound (`max(prefix_length) = 4`)
    - fetch_url SSRF defense layers (whitelist → DNS → IP deny → connect-by-IP + Host header rewrite)
    - fetch_url redirect chain re-validation (3 hops, each through both layers)
    - Audit redaction extensions (exec stdout/stderr 4KB cap, run_python script 256-char cap, fetch_url URL query string redaction past `?`)
19. **README + CHANGELOG + `docs/v0.5-acceptance.md`** — `docs: v0.5 readme, changelog, acceptance`. Acceptance report flags **deferred external reviews** as known follow-up work (matches v0.3.0 pattern).
20. **Inspector smoke run.** Single session, all 29 tools, all v0.4-deferred + v0.5-new red-team probes from base prompt §2 Inspector section. If probes red — fix, repeat #17 sweep, back to #20. **Mandatory before tag.**
21. **Tag** `v0.5.0` annotated.
22. **Push** `git push origin main v0.5.0`.

### Hand-off to chat Claude

After #22 (push complete), hand back to chat Claude with status:
- Final commit SHA
- Total test count (vs target 240+)
- List of any deferred work (external reviews, any tests skipped, any spec items not amended)
- Confirmation that `git ls-remote origin` shows `main = <SHA>` and `v0.5.0 = <tag SHA>`

Chat Claude will then schedule the v0.5.x review patch wave (grep + edit_file + execute_command + fetch_url, four 4-LLM review surfaces) as post-tag work.

---

## Carryover from base prompt — still active

Items from base prompt that **stay** in scope for this execution:

✅ All 27 hard invariants (Step 1)
✅ All per-tool unit tests (written commit-by-commit alongside impl)
✅ All invariant test files (`exec_blocklist`, `check_env_safe_prefix`, `fetch_url_ssrf`, `audit_redaction` extended, `structured_content` extended, `timeouts` extended)
✅ Audit redaction extensions per Step 1 cross-cutting #26
✅ AbortSignal threading through all new I/O (Step 1 cross-cutting #24)
✅ Structured EIO error pattern with `details.cause` (Step 1 cross-cutting #23)
✅ structuredContent contract pin in `structured_content.test.ts` (Step 1 cross-cutting #25)
✅ Spec amendments for new invariants

---

## Risk acknowledgment (for chat Claude hand-off)

Skipping external reviews trades upfront safety for shipping speed. The risks accepted:

1. **`execute_command` ships without 4-LLM review.** New mutation surface, spawns external processes. Process tree management (lesson #11), PowerShell argument quoting (lesson #12), exec result determinism (lesson #14) — all single-eye-on-code. Real possibility of v0.5.1+ findings.

2. **`fetch_url` ships without 4-LLM review.** SSRF / DNS rebinding (lesson #13) — classical attack-vector territory. Single-eye-on-code on a network surface. Real possibility of v0.5.1+ findings, possibly P1.

3. **`grep.ts` and `edit_file.ts` ship as-is** with pre-existing review prompts unused. Deferred to v0.5.x post-tag review wave (4 prompts × 4 reviewers = 16 subagent invocations total when batched).

Mitigation: test coverage ≥240 tests, invariant tests for SSRF / blocklist / safe-prefix / audit redaction provide first-line defense. External reviews catch what tests don't.

---

## Готов?

Read base prompt `prompts/cc-prompt-mcp-winfs-v0.5.md` for full context. Then start Phase 4c step 6 (scaffold `src/tools/git/` + `src/core/git_safety.ts`). Proceed through Phase 4cde without test pauses, then Phase 4f sequentially.

Hand-off back to chat Claude only at:
- **Phase 4f #17 green** → before #18 docs (sanity check 240+ pass + zero warnings)
- **Phase 4f #20 green** → before #21 tag (sanity check Inspector clean + docs complete)

These are the two **mandatory** review gates that remain. Everything in between is autonomous CC execution.

Поехали.
