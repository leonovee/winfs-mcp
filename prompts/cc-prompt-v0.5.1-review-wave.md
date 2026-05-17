# v0.5.1 review wave — batched 4-surface × 4-reviewer external code review — Claude Code Prompt

> **Audience:** Claude Code launched from `C:\Users\Expert\Desktop\AI\ai-judge` (per v0.3 review precedent — reviewer subagents live in `.claude/agents/` there). winfs project tree at `C:\Users\Expert\Desktop\AI\tools\winfs\` must also be inside CC's accessible paths.
>
> **Context:** v0.5.1 is the canonical v0.5 ship (tag `v0.5.1` → commit `71ad8a6`). The earlier `v0.5.0` tag (commit `2dc2a89`) is a phantom — it predates the 11 v0.5 tool implementations and carries only v0.1–v0.4 surface. **Reviewers MUST clone `--branch v0.5.1`, not `v0.5.0`**, or the source files this prompt references will not be present in their working tree. Per operator directive (2026-05-17): single batched review wave post-tag, **4 surfaces × 4 reviewers = 16 subagent invocations**. Findings → v0.5.2 / v0.5.3 / v0.5.4 patch waves per audit_tail v0.3.x precedent.
>
> **Supersedes:** `prompts/cc-prompt-phase-4b-external-reviews.md` (which covered only grep + edit_file, 2 surfaces × 4 = 8 invocations). This prompt expands scope to all 4 mutation/network surfaces.

---

## 0. Preconditions

**Tag clarification:** reviewers clone `--branch v0.5.1`, not `v0.5.0`, because `v0.5.0` carries only v0.1–v0.4 surface (see context note above). All file paths below refer to a working tree at the `v0.5.1` tag (commit `71ad8a6`) or later.

Verify before starting:

1. **Reviewer subagents present.** `Get-ChildItem .claude/agents/` lists 4 reviewer markdown files: `codex-reviewer.md`, `kimi-reviewer.md`, `gemini-reviewer.md`, `deepseek-reviewer.md`. If any missing — stop, report which.

2. **All 4 review prompts on disk** in `C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\`:
   - `_review_grep.prompt.md` (~8.8 KB)
   - `_review_edit_file.prompt.md` (~15.4 KB)
   - `_review_execute_command.prompt.md` (~22.2 KB)
   - `_review_fetch_url.prompt.md` (~33.0 KB)

   If any missing — stop, report. The chat Claude wrote these post-v0.5.1; they should all be committed on `main` at the `v0.5.1` tag commit (`71ad8a6`) or later.

3. **All 4 source files on disk** (the review prompts inline excerpts, but reviewers may want to cross-reference):
   - `src/tools/search/grep.ts`
   - `src/tools/editor/edit_file.ts`
   - `src/tools/exec/execute_command.ts`
   - `src/tools/network/fetch_url.ts`

4. **Spec on disk** at `docs/design/mcp-winfs-spec.md` — reviewers may cite spec sections.

5. **Existing audit_tail review reports** (v0.3 cycle precedent) in `audit/external_reviews/`:
   - `codex_audit_tail_*.md`
   - `kimi_audit_tail_*.md`
   - `gemini_audit_tail_*.md`
   - `deepseek_audit_tail_*.md`

   These illustrate the expected output format / depth / per-reviewer style.

---

## 1. Execute the review wave (16 invocations)

Use the same timestamp for all 4 reviewers of a single surface so directory grouping is obvious. Use ISO-8601 Zulu hour+minute precision: `2026-05-17T1530Z`.

Subagent invocations are independent — issue them **concurrently if the CC scheduler supports it** (4 parallel reviewers per surface, all 4 surfaces in parallel = up to 16 concurrent if resources allow). Otherwise sequential is fine. Per-invocation wall-clock ~10 min; full wave 40-80 min parallelized, 160+ min sequential.

For each surface × reviewer combination below, follow the standard `ai-judge-external-review` skill output format (Invocation / Raw output / Summary). Save raw output to a timestamped file. Return findings summary in chat (P1/P2/P3 counts + headline of each P1) per invocation.

### Surface 1: `grep.ts` (debt from v0.3.x)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_grep.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_grep_<timestamp>.md

Standard skill format. Return P1/P2/P3 counts + P1 headlines.
```

### Surface 2: `edit_file.ts` (debt from v0.4)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_edit_file.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_edit_file_<timestamp>.md

Standard skill format. Return P1/P2/P3 counts + P1 headlines.
```

### Surface 3: `execute_command.ts` (v0.5 mutation surface)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_execute_command.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_execute_command_<timestamp>.md

Standard skill format. Return P1/P2/P3 counts + P1 headlines.
```

### Surface 4: `fetch_url.ts` (v0.5 network surface — highest review priority)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_fetch_url.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_fetch_url_<timestamp>.md

Standard skill format. Return P1/P2/P3 counts + P1 headlines.
```

### Parallelism guidance

If the CC scheduler supports concurrent subagents:
- **Best**: all 16 in parallel (one wave, ~10-15 min wall-clock).
- **Good**: 4 per surface in parallel, surfaces sequential (4 waves × ~10-15 min = ~40-60 min).
- **Acceptable**: fully sequential (16 × ~10 min = ~2.5-3 hours).

If a reviewer subagent times out or returns malformed output, retry once. After 2 failures, log the gap and move on — don't block the wave on a single reviewer × surface cell.

---

## 2. Consolidate findings (4 consolidation files)

After all 16 raw outputs are on disk, produce **four consolidation files** at `audit/external_reviews/` — one per surface. Use the same timestamp as the raw outputs for grouping.

### Consolidation file structure

Each file: `_findings_<surface>_<timestamp>.md`. Mirror v0.3 audit_tail consolidation format:

```markdown
# <surface>.ts external review — findings consolidation — <timestamp>

## Reviewer profiles (recap)
- Codex — tightest, sharp on P1, ~4 findings
- Kimi — adversarial process-risk, ~10+ findings
- Gemini — Windows-specific (CRLF/BOM/junctions, PowerShell quoting), ~7 findings (watch false positives)
- DeepSeek — anti-hallucination structural concerns, ~9 findings

## P1 findings (4-eyes convergence)

For each P1 issue:
- Which reviewers raised it
- Exact quote of the issue title from each reviewer
- Single converged description
- Recommended fix (combining best of the per-reviewer fix suggestions)

## P2 findings

Same structure, P2 issues. Note if a reviewer flagged P1 that others flagged P2 (severity disagreement is itself signal).

## P3 findings

Brief list, no convergence required — these are nice-to-fix.

## Reviewer-unique findings

Issues raised by only ONE reviewer. Often these are the most interesting — they're either novel insights or false positives. Flag both.

## Recommended action plan

Numbered list, ordered by severity then by ease-of-fix:
1. P1.X — <converged title> — fix commit message draft
2. ...

Each item should be a candidate `fix(<surface>): <description>` commit. Chat Claude will accept/reject each via spec citation before any commits land.
```

### Expected output shape per audit_tail v0.3.x precedent

- ~5-10 P1/P2 per surface
- ~20-30 P1/P2 total across all 4 surfaces
- 4 consolidation files, ~10-15 KB each (varies with findings count)

---

## 3. Stop here — hand-off to chat Claude

**Do NOT auto-apply fixes.** This wave produces:
- 16 raw output files (4 per surface × 4 surfaces)
- 4 consolidation files (1 per surface)
- = 20 new artifacts in `audit/external_reviews/`

That's it. Hand back to chat Claude for sanity check of findings before any `fix(*)` commits land. This is the explicit hand-off pattern from v0.3.3 (where Kimi+Gemini P3 "rename total → entries_returned" was REJECTED via spec §F citation — that judgment call is chat Claude's responsibility, not CC's).

Chat Claude will:
- Reject false positives with spec citations
- Accept genuine findings as P1/P2 patch commits, grouped per surface
- Decide patch release cadence: v0.5.1 (highest-severity batch) / v0.5.2 (medium batch) / v0.5.3 (cleanup batch)
- Generate per-fix commit messages

After chat Claude approves the fix list, fixes get applied **per-reviewer atomically** (e.g., `fix(execute_command): codex review P1.2`, `fix(execute_command): kimi review P1.5`, etc.) — matches the audit_tail v0.3.1/v0.3.2/v0.3.3 cadence.

---

## 4. Optional: commit the methodology trail

After review wave + consolidation, commit the new artifacts:

```powershell
cd C:\Users\Expert\Desktop\AI\tools\winfs
git add audit/external_reviews/
git status
# Verify 16 raw + 4 consolidation files staged
git commit -m "chore(reviews): batched v0.5.1 review wave — grep + edit_file + execute_command + fetch_url"
git push origin main
```

This preserves the raw-output evidence for repro / future audit-trail purposes. Recommended but not strictly required (consolidation files are the actionable artifacts; raw reports are evidence).

---

## 5. Out of scope for this prompt

❌ Applying any P1/P2/P3 fix — chat Claude review gate first
❌ Tagging v0.5.1 — only after fixes accepted, tested, and committed
❌ Modifying the review prompts themselves — they're inputs, not outputs

If you find that a review prompt has a bug (typo, broken code reference, missing context), STOP, flag it, and let chat Claude rewrite before re-running. Bad prompt → bad review → wasted reviewer turns.

❌ Writing new review prompts for tools not in this wave (e.g., audit_tail re-review, glob, read_section, etc.) — out of v0.5.1 scope per operator directive.

---

## 6. Expected timeline

| Phase | Wall-clock | Output |
|---|---|---|
| §0 Preconditions | 1-2 min | confirmation |
| §1 Wave execution (parallel) | 15-30 min | 16 raw files |
| §1 Wave execution (sequential) | 2-3 hours | 16 raw files |
| §2 Consolidation | 15-30 min | 4 consolidation files |
| §4 Commit (optional) | 1-2 min | 1 commit + push |

Best case end-to-end: ~30-60 min. Worst case: 3-4 hours sequential.

---

## 7. After the wave (chat Claude responsibilities, not CC's)

Once consolidation files exist:

1. Chat Claude reads all 4 consolidation files
2. Per surface, walks through P1 → P2 → P3 findings
3. For each finding: accept / reject with spec citation / defer to v1.0
4. Generate ordered fix-commit list per surface
5. Operator commits fixes (or chat Claude commits directly via winfs:execute_command pattern established in v0.5.1)
6. Re-test (full `npm test`)
7. Tag v0.5.1 / v0.5.2 / v0.5.3 as findings batch closes
8. Inspector smoke run only if mutation-surface findings landed (execute_command, fetch_url fixes); skip for grep/edit_file (read-only enough)

---

## Готов?

Sequence:

1. Verify preconditions §0
2. Execute 16 subagent invocations §1 (4 surfaces, parallel if possible)
3. Write 4 consolidation files §2
4. Commit methodology trail §4 (optional but recommended)
5. Hand off to chat Claude with 4 consolidation paths + brief overall summary

Estimated wall-clock: 30-180 minutes depending on parallelism + reviewer turnaround.

Поехали.
