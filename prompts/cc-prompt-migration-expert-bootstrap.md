# CC prompt — bootstrap on Expert machine

## Origin

Dev machine switching from User back to Expert. All code + prompts + backlog
+ audit + `docs/BOOTSTRAP.md` are in git (origin/main). This prompt brings
winfs up on Expert by following `docs/BOOTSTRAP.md`, then verifies the
server is functional so workflow resumes with `cc-prompt-v0.9.1-patch-wave.md`.

**No secret values through chat or prompts.** API keys are copied
machine-locally (file→file) or pasted by Vladimir directly — never surfaced
in the conversation.

Expert project root (confirm actual path on this machine; likely
`C:\Users\Expert\Desktop\ai\tools\winfs` — adjust if different):
let `PROJECT_ROOT` = the winfs checkout directory on Expert.

## Phase A — get latest code

If the repo isn't cloned on Expert yet:
```
& 'C:\Program Files\Git\cmd\git.exe' clone https://github.com/leonovee/winfs-mcp.git <PROJECT_ROOT>
```
If already cloned:
```
& 'C:\Program Files\Git\cmd\git.exe' -C '<PROJECT_ROOT>' pull origin main
```

Verify on latest:
```
& 'C:\Program Files\Git\cmd\git.exe' -C '<PROJECT_ROOT>' rev-parse main
```
Compare against origin/main (read `.git\refs\` if stdout silent). Must
include commit `26ffac5` (prompts/backlog/audit) and the BOOTSTRAP.md
commit on top.

Read `docs/BOOTSTRAP.md` — it's the authoritative checklist; this prompt
operationalizes it for Expert.

## Phase B — build

```
cd <PROJECT_ROOT>
npm install
npm run build
```
Confirm `dist/index.js` exists. Report any build errors.

## Phase C — runtime config

Create `%LOCALAPPDATA%\mcp-winfs\config.json` (i.e.
`C:\Users\Expert\AppData\Local\mcp-winfs\config.json`).

allowedRoots with EXPERT paths (not User). Determine the right roots:
- `<PROJECT_ROOT>` (the winfs checkout)
- Any sibling projects Vladimir works on (eCom, ai-judge) under Expert's
  home — confirm with Vladimir if unsure which to include.

Use the full field schema from `configs/default.json` for everything else
(allowedUrlHosts, timeouts, shellBlocklist, etc.). Only allowedRoots is
machine-specific.

Create the `mcp-winfs` directory first if absent (it's a hidden AppData
path):
```
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\mcp-winfs"
```

## Phase D — secrets (.env)

`<PROJECT_ROOT>\.env` with the keys listed in BOOTSTRAP.md §3. Two safe
routes — pick whichever applies:

1. **If `ai-judge\.env` exists on Expert** with the keys: copy the relevant
   vars file→file (this keeps values out of chat). Read ai-judge's .env,
   extract OPENROUTER_API_KEY / MOONSHOT_API_KEY / DEEPSEEK_API_KEY /
   GEMINI_API_KEY, write them to `<PROJECT_ROOT>\.env`.

2. **Otherwise**, create `<PROJECT_ROOT>\.env` with the four key names and
   empty placeholder values, and STOP to ask Vladimir to paste the values
   himself (do not request the values in chat — instruct him to edit the
   file directly).

Verify `.env` is gitignored:
```
& 'C:\Program Files\Git\cmd\git.exe' -C '<PROJECT_ROOT>' check-ignore .env
```
Must report `.env` as ignored. If `.gitignore` somehow lacks it (shouldn't
— landed in v0.8.0), add `.env`, `.env.local`, `.env.*.local` and commit.

## Phase E — reviewer subagents

Target: `C:\Users\Expert\.claude\agents\`.

If the 4 reviewer subagents (codex/gemini/kimi/deepseek-reviewer.md) already
exist on Expert (from prior ai-judge work), apply the pre-flight pattern
from `audit/reviewer-infra/subagent-preflight-pattern.md` (in git) to each
— same edits chat-Claude applied on User.

If they don't exist on Expert, copy them from wherever the ai-judge project
keeps its agent definitions, then apply pre-flight.

If editing user-global `.claude\agents\` is outside CC's allowed scope on
Expert, document the needed edits and let Vladimir apply manually (same as
the User-side handling).

## Phase F — Claude Desktop MCP registration

`%APPDATA%\Claude\claude_desktop_config.json`. Add/update mcpServers.winfs:
```
"winfs": {
  "command": "node",
  "args": ["<PROJECT_ROOT>\\dist\\index.js"]
}
```
Preserve any other existing mcpServers entries (merge, don't overwrite the
file). Vladimir restarts Claude Desktop via tray Exit + relaunch to load it.

## Phase G — verify

```
cd <PROJECT_ROOT>
npm test
node scripts/smoke/v0.7-smoke.mjs
```
Expected: 450 tests passing (10 Windows-flaky process tests may surface —
known limitation); smoke 72/72 green.

Then, after Vladimir restarts Claude Desktop, a `winfs:list` on PROJECT_ROOT
through the chat confirms the server is reachable and allowedRoots resolved.
(CC can't do that itself — it's a Claude-Desktop-side check; note it as the
final manual confirmation step.)

## Phase H — resume point

Once verify passes, the workflow resumes. The next queued wave is
`prompts/cc-prompt-v0.9.1-patch-wave.md` (flaky tests + remaining deferred
P2 + pwsh cosmetic). Do NOT start it as part of bootstrap — report bootstrap
complete and let Vladimir / chat-Claude kick off v0.9.1 explicitly.

## Constraints

- All git via full path `C:\Program Files\Git\cmd\git.exe`, no `&`-pipeline.
- NO secret values in chat or prompts — file→file copy or Vladimir pastes.
- Merge Claude Desktop config, don't clobber other mcpServers.
- config.json allowedRoots use EXPERT paths, not User.
- Don't start v0.9.1 patch wave during bootstrap.

## Reporting

```
Expert bootstrap done:
  code: main @ <sha> (matches origin)
  build: dist/index.js <ok | errors>
  config.json: created at %LOCALAPPDATA%\mcp-winfs\ with <N> Expert allowedRoots
  .env: <copied from ai-judge | created empty, Vladimir to fill>
  reviewer subagents: <pre-flight applied | documented for manual>
  Claude Desktop config: <merged winfs entry>
  npm test: <N> passing
  smoke: <Y>/<Y> green
  reachability: <pending Vladimir restart + winfs:list confirm>

  Ready to resume at: cc-prompt-v0.9.1-patch-wave.md
  Remaining Vladimir manual steps: <list — restart Claude Desktop, fill .env if empty, etc.>
```

On any failure: stop at the step, report full output. Build / test failures
are blockers — report before proceeding to later phases.
