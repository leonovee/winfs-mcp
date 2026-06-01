# CC prompt — v0.8.0 cut + reviewer infrastructure restore

## Origin

Current state at `main @ 636aae0`:

- `[Unreleased]` in CHANGELOG contains **two distinct content sections**, both valid but not yet promoted to a date:
  - Wave 2c (ToolContext refactor, invariant #41, methodology notes)
  - filesystem-MCP parity (P2 annotation fix, P4.1 head/tail, P4.2 directory_tree, P4.3 sort_by, P4.4 read_media_file)
- Last released tag: `v0.7.2` (1dbf1a3). Since then: ToolContext breaking internal API + 4 new/extended tools. Justifies a **minor version bump**: 0.7.2 → 0.8.0.

After cut, restore reviewer infrastructure (Codex CLI, Gemini CLI, OpenRouter API key for DeepSeek) into winfs project scope. Currently the v0.7 pre-tag review wave only had Kimi as a real external reviewer (API key bled in from ai-judge `.env`); the rest were Sonnet-substituted because CLIs/keys weren't wired in the new machine setup after the User-account migration. Subscriptions exist (Codex, Gemini), but winfs scope can't reach them.

## Phase A — CHANGELOG cleanup

`CHANGELOG.md` has two `## [Unreleased]` headings. Merge them into a single new dated section:

```markdown
## [0.8.0] — 2026-05-22

### Added
- (filesystem-parity items: directory_tree tool, read_media_file tool, head/tail in read, sort_by in list)
- (any Added items from wave 2c)

### Changed
- (wave 2c: register*Tool signature now takes (server, ctx: ToolContext); createServer return type)
- (any Changed items from filesystem-parity)

### Fixed
- (any from either section)

### Docs
- (wave 2c: invariant #41, ToolContext extension rule, blocklist verify-then-smoke methodology, symptom-vs-source discipline methodology)
- (any from filesystem-parity)
```

Keep `## [Unreleased]` heading at top, empty content body — for v0.8.1+ work.

Commit:
```
docs(changelog): promote [Unreleased] x2 to [0.8.0]
```

## Phase B — version bump

```
npm version 0.8.0 --no-git-tag-version
```

Commit:
```
chore(release): bump 0.7.2 -> 0.8.0
```

## Phase C — push + tag + push tag

```
git push origin main
```

Verify pushed.

```
git tag -a v0.8.0 -m "v0.8.0: filesystem-MCP parity + ToolContext refactor

Highlights:
- ToolContext consolidates per-server state; uniform register*Tool signature (wave 2c)
- Invariant #41: stateful sessions settle by close-event only
- 2 new tools: directory_tree (JSON tree view), read_media_file (base64 binary)
- Extended tools: read.head/read.tail, list.sort_by
- Tool surface: 37 -> 39
- Methodology notes captured: blocklist verify-then-smoke; symptom-vs-source discipline"
```

```
git push origin v0.8.0
```

Verify:
```
git rev-parse v0.8.0
git ls-remote --tags origin v0.8.0
```

## Phase D — reviewer infrastructure restore

### D1. Verify CLI reachability

```
where codex
where gemini
```

For each:
- Found → record path. Test invocation: `codex --version`, `gemini --version`. Capture stdout.
- Not found → report which CLI is missing. Vladimir reinstalls; this phase pauses on that CLI until restored.

### D2. API keys for external models

DeepSeek goes through OpenRouter; Kimi through Moonshot direct.

Check what currently exists:
```
Test-Path C:\Users\User\Desktop\ai\ai-judge\.env
Test-Path C:\Users\User\Desktop\ai\tools\winfs\.env
```

If `ai-judge\.env` exists and contains `OPENROUTER_API_KEY` and `MOONSHOT_API_KEY` (or whichever vars the reviewer subagents expect — read the subagent prompts to confirm var names), copy those vars to `winfs\.env`.

Create `winfs\.env` if absent. Ensure `.env` is in `.gitignore` (verify with `grep -n '\.env' .gitignore`; add if missing).

If `ai-judge\.env` doesn't exist on this machine either, report — Vladimir restores from password manager / cloud sync.

### D3. Reviewer subagent pre-flight checks

For each reviewer subagent at `C:\Users\User\.claude\agents\`:
- `codex-reviewer.md`
- `gemini-reviewer.md`
- `kimi-reviewer.md`
- `deepseek-reviewer.md`

Read each. Confirm or add at the start of the subagent's procedure a **pre-flight check** that:
1. Verifies the relevant CLI is reachable (`codex`, `gemini`) OR API key is set (`OPENROUTER_API_KEY` for DeepSeek, `MOONSHOT_API_KEY` for Kimi).
2. If absent, the subagent must **fail-fast with a clear error message** stating exactly what's missing.
3. The subagent MUST NOT silently fall back to Sonnet-substituted analysis — Sonnet substitution is what made the v0.7 review wave's 4-eyes signal weaker than it appeared.

If a subagent already has this pattern, leave it. If absent, edit it in.

If editing subagent files in `C:\Users\User\.claude\agents\` is outside winfs project scope (likely — they're user-global), document the required edit in a new file `audit/reviewer-infra/subagent-preflight-pattern.md` and skip the live edit. Vladimir applies manually or in a separate session.

### D4. Dry-run smoke

Invoke each reviewer subagent with a trivial test query (e.g. "Reply with exactly the word: live"). Confirm:
- Codex returns "live" via real Codex CLI (not Sonnet-formatted output)
- Gemini returns "live" via real Gemini CLI
- Kimi returns "live" via Moonshot API call
- DeepSeek returns "live" via OpenRouter API call

For each, capture the raw response, and note whether it bears markers of the real external model (latency, response shape, model-name field if returned).

Output: `audit/reviewer-infra/dry-run-2026-05-22.md` with one row per reviewer: CLI/key status, dry-run response, real-vs-substituted verdict.

Commit:
```
chore(reviewers): infrastructure restore — CLI/key verification + dry-run + pre-flight pattern docs
```

## Phase E — push final

```
git push origin main
```

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green throughout.
- Smoke green throughout (66/66).
- If Phase D1 finds a CLI missing, **do not block tag** — Phase A-C complete the cut regardless. Phase D becomes partial; report what's missing.
- Do NOT modify subagent files in `C:\Users\User\.claude\agents\` if they're user-global and outside winfs project tree. Document the needed change in `audit/reviewer-infra/` and let Vladimir apply.
- `.env` MUST be in `.gitignore`. If we create `winfs\.env`, double-check it doesn't accidentally land in git.
- Tag message multi-line is fine (use `-a` not lightweight tag).

## Reporting

```
v0.8.0 cut + reviewer infra restore done:

  Phase A CHANGELOG merge: <sha>
  Phase B version bump:    <sha>
  Phase C tag + push:      v0.8.0 -> <tag-sha> -> <commit-sha>, pushed
  Phase D reviewer infra:  <sha>
  Phase E final push:      main @ <sha>

  v0.8.0 STATE:
    tests: 433 passing
    smoke: 66/66 green
    tool surface: 39
    diff v0.7.2..v0.8.0: <git diff --stat summary>

  Reviewer infrastructure:
    Codex CLI:    <found at path | NOT FOUND>
    Gemini CLI:   <found at path | NOT FOUND>
    OpenRouter key: <found in winfs/.env | copied from ai-judge | NOT FOUND>
    Moonshot key:   <same>
    Subagent pre-flight pattern: <inline-edited | documented in audit/reviewer-infra/>
    Dry-run results: <listing>

  Action items for Vladimir if any infra was missing:
    <list>
```

On any failure: stop, report step, full output. Phases A-C pushed = safe checkpoint (tag exists, release out). Phase D failure doesn't roll back tag.
