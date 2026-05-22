# Reviewer subagent pre-flight pattern

Documentation produced by Phase D3 of `prompts/cc-prompt-v0.8.0-cut-and-reviewer-restore.md` (2026-05-22).

## Context

The v0.7 pre-tag external review wave surfaced that several reviewer subagents
silently fell back to Sonnet-substituted analysis when their underlying CLI or
API key was unavailable. The substitution corrupted the multi-reviewer
convergence signal — what looked like "4 eyes agreed on finding X" was
sometimes "1 real model + 3 Sonnet substitutions, all priming on the same
inputs." Reference: `audit/external_reviews/v0.7-pre-tag/_findings_*.md` —
where most reviewers were Sonnet-substituted on this machine because CLIs
and API keys hadn't been wired in after the User-account migration.

All 4 reviewer subagents already include the "Never substitute manual review"
invariant **at the END** of their definitions, but the rule was violated in
practice. The pre-flight pattern moves the check to the **START** of the
invocation procedure where the agent is forced to halt on missing infra
before generating any output.

This file documents the required edit to each subagent. The reviewer
subagents are user-global at `C:\Users\User\.claude\agents\` and outside
winfs project scope, so live edits aren't applied here — Vladimir applies
manually or in a separate session.

## Required pre-flight block — add to EACH reviewer subagent

Insert the block below as the **first** subsection under the existing
"## When the architect invokes you" / "## Invocation protocol" / equivalent
section. The block runs BEFORE any work — no source reading, no commit-range
parsing, no model invocation — until the infrastructure check passes.

### codex-reviewer.md

Insert AFTER the existing "# When the architect invokes you" header,
BEFORE the existing "# Invocation protocol":

```markdown
## Pre-flight infrastructure check (run BEFORE anything else)

1. `Get-Command codex` — confirm the CLI is reachable.
2. If NOT found, output exactly:

   ```
   PRE-FLIGHT FAIL: codex CLI not installed.
   Cannot run a Codex review. Subagent halting.

   To fix:
   - Install: npm install -g @openai/codex  (creates the npm global dir if absent)
   - Authenticate: codex login  (uses your OpenAI subscription)
   - Re-invoke this subagent.
   ```

   Then RETURN. Do NOT proceed to "Invocation protocol" below. Do NOT
   substitute Sonnet-driven static analysis — that violates trust-model
   invariant #3 and corrupts the multi-reviewer convergence signal.

3. If found, proceed to the existing "# Invocation protocol" section.
```

### gemini-reviewer.md

Same pattern, substituting `gemini` for `codex` and the appropriate install
hint:

```markdown
## Pre-flight infrastructure check (run BEFORE anything else)

1. `Get-Command gemini` — confirm the CLI is reachable.
2. If NOT found, output exactly:

   ```
   PRE-FLIGHT FAIL: gemini CLI not installed.
   Cannot run a Gemini review. Subagent halting.

   To fix:
   - Install via Google's official package (npm install -g @google/gemini-cli
     or via winget; check Google's docs for the current path).
   - Authenticate: gemini auth  (uses Google subscription).
   - Re-invoke this subagent.
   ```

   Then RETURN. Do NOT proceed. Do NOT substitute Sonnet-driven analysis.

3. If found, proceed to the existing "# Invocation protocol" section.
```

### kimi-reviewer.md (Moonshot API direct — CLI optional)

```markdown
## Pre-flight infrastructure check (run BEFORE anything else)

The kimi subagent prefers the `kimi` CLI when present; falls back to the
Moonshot API direct otherwise.

1. `Get-Command kimi` — if found, mark `path = CLI`.
2. Otherwise check `MOONSHOT_API_KEY` env var. The agent MUST load this
   from the CURRENT PROJECT'S `.env` file (e.g. `<project_root>\.env`),
   never from a different project's `.env` (cross-project credential
   leak risk). Use the project-root resolution that the architect's
   tooling uses (typically the cwd or git-root of the calling session).
3. If both paths are unavailable, output exactly:

   ```
   PRE-FLIGHT FAIL: neither kimi CLI nor MOONSHOT_API_KEY found.
   Cannot run a Kimi review. Subagent halting.

   To fix (choose one):
   - Install kimi CLI: <install instructions for current version>
   - Set MOONSHOT_API_KEY in <project_root>\.env (winfs:
     C:\Users\User\Desktop\ai\tools\winfs\.env, already populated as of
     v0.8.0).
   - Re-invoke this subagent.
   ```

   Then RETURN. Do NOT substitute Sonnet-driven analysis.

4. If at least one path works, proceed.
```

### deepseek-reviewer.md (OpenRouter API)

The v0.8.0 prompt clarified that DeepSeek goes through OpenRouter
(`OPENROUTER_API_KEY`), not the direct DeepSeek API. The existing
deepseek-reviewer.md says "API key (DEEPSEEK_API_KEY)" which is the
historical direct-API path. Both keys are present in
`winfs\.env` as of v0.8.0; the pre-flight checks either:

```markdown
## Pre-flight infrastructure check (run BEFORE anything else)

DeepSeek can be reached either via OpenRouter (preferred, single-key
managed by Vladimir's OpenRouter subscription) or via DeepSeek direct
API.

1. Check `OPENROUTER_API_KEY` in the CURRENT PROJECT'S `.env`.
2. If absent, check `DEEPSEEK_API_KEY` in the same `.env` as fallback.
3. If both absent, output exactly:

   ```
   PRE-FLIGHT FAIL: neither OPENROUTER_API_KEY nor DEEPSEEK_API_KEY found
   in <project_root>\.env. Cannot run a DeepSeek review. Subagent halting.

   To fix:
   - Set OPENROUTER_API_KEY (preferred) in <project_root>\.env
   - Or set DEEPSEEK_API_KEY (direct API fallback).
   - winfs as of v0.8.0: both keys already populated in
     C:\Users\User\Desktop\ai\tools\winfs\.env (copied from
     C:\Users\User\Desktop\ai\ai-judge\.env via Phase D2).
   - Re-invoke this subagent.
   ```

   Then RETURN. Do NOT substitute Sonnet-driven analysis.

4. If at least one path works, proceed.
```

## Why these placements

The "Never substitute manual review" rule was already invariant #3 in each
subagent's trust-model section. It was violated in v0.7 because the agent
read the trust-model section AFTER hitting the CLI-missing path and
deciding to "be helpful" by producing analysis. Moving the check to the
top of the invocation procedure removes the temptation: the agent
returns immediately on missing infra, before reading any source code
or composing any output.

## Project-root .env lookup (cross-project leak prevention)

The historical kimi/deepseek subagents say "API key from `.env`" without
specifying which `.env`. In practice the agents have been reading from
`C:\Users\User\Desktop\ai\ai-judge\.env` (cross-project) — convenient,
but a hazard because:

- ai-judge has its own auth surface; cross-project key reads couple
  projects' auth state in ways neither project's reviewer expects.
- If a key is rotated in ai-judge, winfs reviews silently start failing
  with no obvious cause.
- If a winfs-specific key (with different rate limits / billing) is set
  per-project, cross-project reads ignore it.

The pre-flight pattern requires per-project `.env` lookup. winfs got its
own `.env` in v0.8.0 Phase D2 (gitignored; populated from ai-judge for
this initial restoration). Future winfs reviewers should read from
`C:\Users\User\Desktop\ai\tools\winfs\.env` only.

## Out-of-scope for this doc

- The actual CLI install procedures for `codex` and `gemini` (changes
  with version; vendor docs are the source of truth).
- The decision tree of OpenRouter-vs-direct for DeepSeek (operator
  preference; OpenRouter unifies billing, direct may have lower latency).
- Live subagent file edits — applied separately by Vladimir from the
  user-global agents directory.
