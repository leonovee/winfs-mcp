# CC prompt — merge v0.6 into main (revised, non-ff)

## Context

The previous prompt assumed a fast-forward merge was possible. That assumption was wrong: `main` has one commit (`3ef8f7c` — "docs: v0.7 DC-parity roadmap + CLAUDE.md MCP-tool heuristic") that landed after `v0.6` branched off from common ancestor `af20258`. Histories have diverged.

We keep BOTH histories. Use a merge commit with two parents.

Current state:
- `main` @ `3ef8f7c` (in sync with `origin/main`)
- `v0.6` @ `76b2f3d` (in sync with `origin/v0.6`)
- tag `v0.6.0` → `76b2f3d` (must remain intact)
- common ancestor: `af20258`
- unique commits on main: 1 (v0.7 roadmap docs)
- unique commits on v0.6: 11 (the entire v0.6 cycle)

## Task

Execute exactly the following sequence:

```
git checkout main
git merge --no-ff v0.6 -m "Merge branch 'v0.6' into main (v0.6.0 ship + v0.7 roadmap converge)"
git push origin main
git branch -d v0.6
git push origin --delete v0.6
```

## Constraints

- The merge must be a no-ff merge commit with exactly two parents: `3ef8f7c` (current main HEAD) and `76b2f3d` (v0.6 HEAD). Both histories are preserved.
- Tag `v0.6.0` must remain at commit `76b2f3d` unchanged. After the merge, verify with `git rev-parse v0.6.0` and confirm it still returns `76b2f3d`.
- After merge, commit `76b2f3d` must remain reachable from `main` HEAD via the second parent. Verify with `git merge-base --is-ancestor 76b2f3d HEAD` (exit code 0 = reachable).
- No rebase. No force-push. No cherry-pick. No revert. No history rewrite.
- No file changes beyond the merge commit itself. The two histories should touch mostly disjoint files (main's commit is docs/CLAUDE.md; v0.6's commits are spec/prompts/source). If any conflict appears, stop at the conflict and report — do not auto-resolve.

## Reporting

On success, reply with exactly one line in this format:

```
main @ <merge-sha>, v0.6 deleted local+remote, v0.6.0 intact @ 76b2f3d, ancestor check OK
```

On any failure (conflicts during merge, push rejected, branch delete refused, etc.), stop at the failing step and report which step failed with full stdout/stderr. Do not attempt recovery without explicit instruction.
