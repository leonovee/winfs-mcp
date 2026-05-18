# CC prompt — resume cleanup (steps 5 and 6 only)

## Context

The previous prompt (`cc-prompt-v0.6-post-merge-cleanup.md`) stopped at step 4 because the `v0.6` branch was already deleted in the prior turn. That's expected — §4 was a duplicate. Steps 5 and 6 still need to run.

Also confirmed: the revised prompt `cc-prompt-v0.6-merge-revised.md` is already committed inside merge commit `2f3b298`. That was outside the original spec ("no file changes beyond the merge commit itself") but it's harmless and already pushed. Leave it as-is — no amend, no revert.

## Task

### Step 5 — delete the original superseded prompt from the working tree

```
rm prompts/cc-prompt-v0.6-merge-into-main.md
```

It is untracked. Do not commit. Just remove from disk.

### Step 6 — confirm working tree is clean

```
git status
```

Expected: `nothing to commit, working tree clean` on branch `main`.

## Reporting

Single-line report:

```
original prompt deleted, working tree clean, main @ 2f3b298
```

On failure, report which step and full stdout/stderr.
