# CC prompt — copy reviewer subagents to global .claude/agents

## Context

The v0.5.x review wave (defined in `prompts/cc-prompt-v0.5.1-review-wave.md`) requires specialized reviewer subagents to be available to Claude Code in the current session.

Per Vladimir's design, these reviewer subagents currently live inside the `ai-judge` project at `<ai-judge-root>/.claude/agents/`. CC only discovers subagents from two places: the per-project `.claude/agents` of the currently-open project, and the user's global `<home>/.claude/agents`. Since we're working on winfs-mcp (not ai-judge), the agents are invisible from this session.

Decision: **copy** the reviewer agents from the ai-judge project to the user's global `.claude/agents` directory so they become available across all projects (including winfs-mcp). Copy, not symlink — more robust on Windows and survives source-project moves.

Source: `<ai-judge-root>/.claude/agents/` (path to be located in Step 1)
Destination: `C:/Users/Expert/.claude/agents/`

## Task

Execute steps in order. Stop at the first failure or ambiguity and report.

### Step 1 — locate the ai-judge project root

Try these candidate paths in order. The correct one contains a non-empty `.claude/agents/` subdirectory:

```
C:/Users/Expert/Desktop/AI/tools/ai-judge
C:/Users/Expert/Desktop/AI/ai-judge
C:/Users/Expert/Desktop/ai-judge
C:/Users/Expert/ai-judge
```

For each, check `Test-Path "<candidate>/.claude/agents"` and report which (if any) matches.

If none match, fall back to a recursive search:

```
Get-ChildItem -Path C:\Users\Expert -Filter ".claude" -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path "$($_.FullName)\agents" } |
  Select-Object FullName
```

Report all candidates. If more than one `.claude/agents` directory exists across the system, **stop and wait** — do not guess which is the right ai-judge one.

### Step 2 — inspect source contents

Once `<ai-judge-root>` is identified, list the agents directory:

```
ls "<ai-judge-root>/.claude/agents"
```

Report file names and sizes.

### Step 3 — prepare destination

```
mkdir -p C:/Users/Expert/.claude/agents
ls C:/Users/Expert/.claude/agents
```

Report whether the destination already existed, and what (if anything) is in it.

### Step 4 — collision check

If any source file has the same name as a file already in the destination, **stop and report each collision**. Do not overwrite anything without explicit instruction.

If no collisions, proceed.

### Step 5 — copy

Use a copy command that fails (rather than silently overwrites) on collision. PowerShell:

```
Copy-Item -Path "<ai-judge-root>\.claude\agents\*" -Destination "C:\Users\Expert\.claude\agents\" -ErrorAction Stop
```

### Step 6 — verify

```
ls C:/Users/Expert/.claude/agents
```

Confirm the destination now contains every file from the source (same names). Compute a quick diff: do the two directories have the same file set?

## Constraints

- Do not overwrite existing files in the destination.
- Do not move, modify, or delete anything in the source.
- Do not create symlinks — make a real copy.
- No git operations. This is filesystem only; nothing is committed in any repository.
- If discovery finds multiple `.claude/agents` candidates, stop and report all of them — do not pick one.

## Reporting

Per-step status as you go. Final summary on success:

```
copied <N> agents from <ai-judge-root>/.claude/agents to C:/Users/Expert/.claude/agents
files: <comma-separated names>
```

On any failure (not found / multiple candidates / collision / copy error), stop at that step and report stdout/stderr.
