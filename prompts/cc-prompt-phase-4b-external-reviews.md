# Phase 4b — external review wave (grep + edit_file) — Claude Code Prompt

> **Audience:** Claude Code launched from `C:\Users\Expert\Desktop\AI\ai-judge` (per v0.3 review precedent — subagents live in `.claude/agents/` there). winfs project tree at `C:\Users\Expert\Desktop\AI\tools\winfs\` must also be inside CC's accessible paths.
>
> **Context:** v0.5 cycle Phase 4a complete, pushed (`origin/main = d66dce7`). Phase 4b closes external-review debt from v0.3.x (grep) and v0.4 (edit_file) **before** v0.5 implementation phases begin. Two surfaces × 4 reviewers = 8 subagent invocations.

---

## 0. Preconditions

Verify all of these before starting:

1. `Get-ChildItem .claude/agents/` lists 4 reviewer markdown files: `codex-reviewer.md`, `kimi-reviewer.md`, `gemini-reviewer.md`, `deepseek-reviewer.md`. If any missing — stop, report which.
2. Review prompts exist on disk:
   - `C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_grep.prompt.md` (8765 bytes)
   - `C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_edit_file.prompt.md` (15449 bytes)

   If either missing — stop, report.

3. Both source files exist:
   - `C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\search\grep.ts`
   - `C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\editor\edit_file.ts`

   The review prompts inline these but having direct access lets subagents cross-reference.

---

## 1. Execute the review wave

Run **8 subagent invocations** total. For each, follow the standard `ai-judge-external-review` skill output format (Invocation / Raw output / Summary). Save raw output to a timestamped file alongside the existing audit_tail reviews.

**Timestamp format:** ISO-8601 Zulu, hour+minute, e.g. `2026-05-17T0140Z`. Use the same timestamp for all 4 reviewers of a single surface so grouping is obvious in directory listings.

### grep.ts (4 invocations)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_grep.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_grep_<timestamp>.md

Standard skill format. Return findings summary in chat (P1/P2/P3 counts + headline of each P1).
```

### edit_file.ts (4 invocations)

For each `<reviewer>` in `codex`, `kimi`, `gemini`, `deepseek`:

```
Run the <reviewer>-reviewer subagent on this external review prompt:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\_review_edit_file.prompt.md

Save raw output to:
C:\Users\Expert\Desktop\AI\tools\winfs\audit\external_reviews\<reviewer>_edit_file_<timestamp>.md

Standard skill format. Return findings summary in chat.
```

### Parallelism

Subagent invocations are independent — CC may issue them concurrently if its scheduler supports it. If not, sequential is fine; total wall-clock ~10 min per invocation, ~80 min for all 8.

---

## 2. Consolidate findings

After all 8 raw outputs are on disk, produce **two consolidation files** (one per surface) at the project root or in `audit/external_reviews/`:

### `_findings_grep_<timestamp>.md`

Structure (mirror v0.3 audit_tail consolidation, which lived in chat — same format on disk):

```markdown
# grep.ts external review — findings consolidation — <timestamp>

## Reviewer profiles (recap)
- Codex — tightest, sharp on P1
- Kimi — adversarial process-risk, highest count
- Gemini — Windows-specific (CRLF/BOM/junctions), watch false positives
- DeepSeek — anti-hallucination structural concerns

## P1 findings (4-eyes convergence)

For each P1 issue, list which reviewers raised it, exact quote of the issue title from each, and a single converged description.

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

Each item should be a candidate `fix(grep): <description>` commit. The chat Claude operator will accept/reject each via spec citation before any commits land.
```

### `_findings_edit_file_<timestamp>.md`

Same structure for the 4 edit_file reviews.

---

## 3. Stop here

**Do NOT auto-apply fixes.** Phase 4b review wave produces:
- 8 raw output files (4 per surface × 2 surfaces)
- 2 consolidation files (1 per surface)

That's it. Hand back to chat Claude for sanity check of findings before any `fix(*)` commits land — this is the explicit hand-off point #1 in the v0.5 prompt Step 4.

Chat Claude will then:
- Reject false positives with spec citations (per v0.3.3 «total → entries_returned» precedent)
- Accept genuine findings as P1/P2 patch commits
- Decide whether to ship as `v0.4.1`/`v0.4.2` mini-tags or fold into `v0.5.0`

---

## 4. Optional: commit the methodology trail

After review wave + consolidation, commit the new artifacts:

```powershell
cd C:\Users\Expert\Desktop\AI\tools\winfs
git add audit/external_reviews/
git commit -m "chore(reviews): grep + edit_file external review wave"
git push origin main
```

This preserves the raw-output evidence for repro / future audit-trail purposes.

---

## 5. Out of scope for this prompt

❌ Applying any P1/P2/P3 fix — chat Claude review gate first
❌ Tagging v0.4.1 — only after fixes accepted and tested
❌ Starting Phase 4c (Git RO tools) — only after Phase 4b fully closed
❌ Modifying the review prompts themselves — they're inputs, not outputs

If you find that a review prompt has a bug (typo, broken code reference, missing context), STOP, flag it, and let chat Claude rewrite before re-running. Bad prompt → bad review → wasted reviewer turns.

---

## Готов?

Sequence:

1. Verify preconditions §0
2. Execute 8 subagent invocations §1 (parallel if possible)
3. Write 2 consolidation files §2
4. Commit methodology trail §4 (optional, recommended)
5. Hand off to chat Claude with consolidation paths + brief summary

Estimated wall-clock: 40-80 minutes depending on parallelism + reviewer turnaround.

Поехали.
