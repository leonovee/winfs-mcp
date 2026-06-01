# CC prompt — migration finalize on User machine

## Origin

Vladimir is switching the active dev machine from User (`C:\Users\User\...`)
back to Expert (`C:\Users\Expert\...`). Chat-Claude already committed and
pushed all prompts/backlog/audit (commit `26ffac5`, local main == origin/main
verified via refs). This prompt finalizes the User side: generate a
reusable bootstrap manifest so Expert (and any future machine) can be set
up deterministically, then verify nothing is left uncommitted.

**No secrets in any committed file.** API key VALUES never go into git.

## Phase A — verify git state clean

```
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' status --short
```

(Invoke git via full path WITHOUT a pipeline — `| Out-String` triggers the
PATHEXT "document in pipeline" failure on this machine. Direct
`& 'full\path.exe' args` works; exit_code is reliable even when stdout is
empty.)

Expected: clean working tree (chat-Claude already committed everything).
If anything shows up uncommitted, `git add -A` + commit + push it first
with message `chore: final User-side state before Expert switch`.

Confirm pushed:
```
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' rev-parse main
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' rev-parse origin/main
```

(If stdout is empty due to the silent-output quirk, read
`.git\refs\heads\main` and `.git\refs\remotes\origin\main` directly and
compare — they must be equal.)

## Phase B — generate bootstrap manifest

Create `docs/BOOTSTRAP.md` — the canonical "how to run winfs on a fresh
machine" checklist. This is the single source of truth for everything NOT
in git. It is itself committed (contains no secrets, only structure and
sourcing instructions).

Content:

```markdown
# winfs-mcp — fresh machine bootstrap

Everything needed to run winfs on a machine that isn't captured in git.
Run after `git clone`. NO SECRET VALUES live here — only structure and
where to source them.

## 1. Build
    npm install
    npm run build
Produces `dist/index.js`. Requires Node.js (project built on v24.x).

## 2. Runtime config — %LOCALAPPDATA%\mcp-winfs\config.json
NOT in git (machine-specific paths). The server reads ONLY this path at
runtime; `configs/default.json` and `configs/local.json` in the repo are
dev fixtures, never loaded (see README §Configuration).

Minimal shape (fill machine-specific allowedRoots):
    {
      "allowedRoots": [
        "<PROJECT_ROOT>",
        "<additional project roots as needed>"
      ],
      "allowedUrlHosts": ["raw.githubusercontent.com"],
      ... full field list: reference configs/default.json
    }

If allowedRoots is empty/missing, every path-bound tool returns EPERM_ROOT
with a hint pointing back to this file's path.

As of v0.9.0, MCP Roots protocol also feeds allowedRoots — a client
(Claude Desktop / VS Code) that advertises roots will union them with this
config. config.json remains the fallback / always-trusted base.

## 3. Secrets — <PROJECT_ROOT>\.env
NOT in git (.gitignore excludes .env, .env.local, .env.*.local). Keys:
    OPENROUTER_API_KEY    # DeepSeek reviewer via OpenRouter
    MOONSHOT_API_KEY      # Kimi reviewer (Moonshot direct)
    DEEPSEEK_API_KEY      # DeepSeek direct fallback
    GEMINI_API_KEY        # reserved for future Gemini-API-direct path
Source: copy from `<sibling>\ai-judge\.env` on the same machine, or from
password manager. NEVER commit. NEVER paste values into chat or prompts.

## 4. Reviewer subagents — <USERHOME>\.claude\agents\
User-global, outside the winfs repo. Files:
    codex-reviewer.md, gemini-reviewer.md, kimi-reviewer.md,
    deepseek-reviewer.md  (+ physics-reviewer.md, spec-drift-checker.md)
Each of the 4 reviewers needs the pre-flight infrastructure check applied
— pattern documented in `audit/reviewer-infra/subagent-preflight-pattern.md`
(IN git). Pre-flight makes a reviewer fail-fast if its CLI/key is missing
rather than silently substituting Sonnet (which corrupts the 4-eyes signal).

## 5. External reviewer CLIs (only needed for full review waves)
    Codex:  npm install -g @openai/codex   then  codex login
    Gemini: npm install -g @google/gemini-cli  then  gemini auth
Kimi + DeepSeek need no CLI — they run via API keys from §3.

## 6. Claude Desktop MCP registration — %APPDATA%\Claude\claude_desktop_config.json
Add under mcpServers:
    "winfs": {
      "command": "node",
      "args": ["<PROJECT_ROOT>\\dist\\index.js"]
    }
Restart Claude Desktop via tray Exit + relaunch (window close alone leaves
orphaned node.exe — see CLAUDE.md operational notes).

## 7. Verify
    npm test
        -> 450 passing (10 Windows-flaky tests/unit/process/* may surface;
           known-limitation, see README)
    node scripts/smoke/v0.7-smoke.mjs
        -> 72/72 green (3 documented skips)
Then in Claude Desktop, a winfs:list on PROJECT_ROOT confirms the server
is reachable and allowedRoots resolved.

## Operational notes worth re-reading on a new machine
- MCP transport occasional 4-minute hangs: retry, then tray-restart if
  3 in a row. See CLAUDE.md.
- silent-output / PATHEXT environment quirk on some Windows setups:
  `execute_command` may return exit 0 with empty stdout, and `| pipeline`
  on a full-path .exe fails with "document in pipeline". Workaround:
  `& 'full\path.exe' args` without pipeline. See CLAUDE.md bug #2 history.
```

Replace `<PROJECT_ROOT>`, `<USERHOME>`, `<sibling>` with literal
placeholder tokens (keep them as placeholders — the manifest is
machine-agnostic; Expert setup fills them).

## Phase C — commit + push

```
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' add docs/BOOTSTRAP.md
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' commit -m 'docs: fresh-machine bootstrap manifest'
& 'C:\Program Files\Git\cmd\git.exe' -C 'C:\Users\User\Desktop\ai\tools\winfs' push origin main
```

Verify refs equal after push (read `.git\refs\heads\main` and
`.git\refs\remotes\origin\main`).

## Constraints

- All git invocations via full path `C:\Program Files\Git\cmd\git.exe`,
  no `&`-pipeline. Read refs directly to verify when stdout is silent.
- NO secret values in BOOTSTRAP.md — structure and sourcing only.
- All work on `main`. No branches, no force-push.

## Reporting

```
migration finalize (User) done:
  git state: <clean | committed N files>
  BOOTSTRAP.md @ <sha>, pushed
  local main == origin/main: <yes, sha>
  User side ready for Expert switch: <yes>
```
