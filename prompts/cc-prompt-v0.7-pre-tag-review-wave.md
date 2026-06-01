# CC prompt — v0.7 pre-tag review wave (wrapper over v0.5.1 methodology)

## Origin

We're at `main @ a885126`, 372 tests passing (10 pre-existing Windows-flaky in `tests/unit/process/*`). Before v0.7.0 tag, run a focused external-review wave on the four v0.5 mutation/network surfaces — they are the most-trafficked, most-fuzzed entry points and have absorbed wave 2a changes (grep pagination, edit_file diff, execute_command hints). New v0.7 surfaces (ssh_exec, process registry, write_json, list_path_dirs) are explicitly **out of scope for this wave** — they'll get their own review after tag.

Reviewer subagents were copied to `C:\Users\User\.claude\agents\` in the previous step (6 reviewer agents now visible globally). VS Code / CC session has been restarted to refresh the agent list.

## Methodology source

Follow `prompts/cc-prompt-v0.5.1-review-wave.md` for the full procedure: 16 subagent invocations (4 surfaces × 4 reviewers), output format, consolidation file structure, hand-off pattern. **Read that prompt before starting** — this wrapper does not duplicate its body.

This wrapper specifies only the **deltas** vs the v0.5.1 wave.

## Deltas

### D1. Paths

All path references in the methodology prompt say `C:\Users\Expert\Desktop\AI\tools\winfs`. On this machine the project root is `C:\Users\User\Desktop\ai\tools\winfs` (note case: lowercase `ai`, `tools`). Substitute throughout.

Also: `C:\Users\Expert\Desktop\AI\ai-judge` no longer relevant — reviewer subagents are now in `C:\Users\User\.claude\agents\` user-global, not project-local.

### D2. Target commit

The v0.5.1 prompt said `--branch v0.5.1` (commit `71ad8a6`). For this wave: **target current `main`** at commit `a885126`. The four surfaces have absorbed wave 2a edits since v0.5.1; reviewers should see the current code, not the historical v0.5.1 snapshot.

If a reviewer subagent expects a specific commit/branch checkout, point it at `main`. No separate clone needed — review in-place at the existing working tree.

### D3. Review prompts on disk

The four `_review_<surface>.prompt.md` files should already exist under `audit/external_reviews/`. **Spot-check before starting**: if any are absent, missing-content, or have line-number / function-name references that have drifted since wave 2a (e.g. `_review_grep.prompt.md` references the old grep response shape pre-pagination), report and stop — we'll either update the review prompt or accept the drift explicitly before reviewers run.

Specifically wave 2a changes to validate against existing review prompts:
- `grep.ts` — added `offset` / `limit` input fields, `total_matches` / `next_offset` output fields.
- `edit_file.ts` — added `with_diff` input flag, `diff` / `truncated_diff` output fields.
- `execute_command.ts` — added `hints` output field for PowerShell document-in-pipeline diagnostic.
- `fetch_url.ts` — unchanged in wave 2a (v0.5.1 review prompt still aligned).

If any of these new fields are unmentioned in the corresponding review prompt, note it and **proceed anyway** — reviewers should review the current code as-is; the prompt is contextual, not authoritative.

### D4. Output location

Raw outputs and consolidation files go to:

```
audit/external_reviews/v0.7-pre-tag/<surface>/<reviewer>_<surface>_<timestamp>.md
audit/external_reviews/v0.7-pre-tag/_findings_<surface>_<timestamp>.md
```

Keep separate from the v0.5.1 wave outputs (which lived directly under `audit/external_reviews/`) so the two waves don't intermix.

### D5. Reviewer roster

Should be the same 4 (`codex-reviewer.md`, `kimi-reviewer.md`, `gemini-reviewer.md`, `deepseek-reviewer.md`) per the original prompt. Verify with `Get-ChildItem C:\Users\User\.claude\agents` before §0 preconditions.

Per the prior step's report, 6 reviewer agents were copied total — two extra beyond the v0.5.1 set. If those two are also reviewer-class agents (not unrelated tooling), they CAN be invoked alongside as a 5th and 6th opinion per surface — judgment call. If they look unrelated, skip them, use the original 4.

### D6. Scope, explicit

In scope:
- `src/tools/search/grep.ts`
- `src/tools/editor/edit_file.ts` (or wherever it landed; adjust path)
- `src/tools/exec/execute_command.ts`
- `src/tools/network/fetch_url.ts`

Out of scope (deferred for post-tag wave):
- `src/tools/system/ssh_exec.ts`
- `src/tools/system/list_path_dirs.ts`
- `src/tools/file/write_json.ts`
- `src/tools/system/list_process.ts`, `start_process.ts`, `interact.ts`, `kill_process.ts`
- `src/core/process_registry.ts`
- `src/core/exec_safety.ts` (changed in v0.6 §U — get reviewed alongside process_registry post-tag)

If a reviewer surfaces findings about an out-of-scope file while reviewing an in-scope file (e.g. execute_command review notices a smell in process_registry), the finding still goes into the consolidation file under a "cross-surface observations" subsection — don't drop it, just don't proactively run reviewers on out-of-scope code.

## Execution

Follow §0 preconditions → §1 16-invocation execution → §2 consolidation → §3 hand-off, all per `cc-prompt-v0.5.1-review-wave.md`.

Final commit (optional but recommended, per §4 of the methodology prompt):

```
chore(reviews): v0.7 pre-tag review wave — grep + edit_file + execute_command + fetch_url
```

Push to `origin/main`.

## Reporting

On completion:

```
v0.7 pre-tag review wave done: 16 raw + 4 consolidation files at audit/external_reviews/v0.7-pre-tag/
P1 findings total: <N> (codex <a>, kimi <b>, gemini <c>, deepseek <d>)
P2 findings total: <N>
P3 findings total: <N>
methodology trail committed @ <sha>, pushed, main @ <sha>
```

Plus the 4 consolidation file paths. Chat-Claude will sanity-check findings before any `fix(*)` commits land — per the hand-off pattern in the methodology prompt §3.

On any step failure: stop, report which subagent × surface cell failed, save partial raw outputs.
