# CC prompt — v0.7 tails: docs + cleanup before review wave

## Origin

Wave 2b shipped clean at `main`, 371 tests passing. Before going into review wave + smoke + v0.7.0 tag, sweep up five small items that have accumulated:

1. **CLAUDE.md** — document the MCP transport "hangs then recovers" pattern observed empirically across this session (sequence: 2-3 four-minute timeouts, then the next call returns instantly). It's reproducible enough to be a known operational note.
2. **`configs/default.json`** — currently contains paths from Vladimir's old machine: `C:\Users\Expert\Desktop\eCom`, `C:\Users\Expert\Desktop\AI\ai-judge`, `C:\Users\Expert\Dropbox\Projects`. These are user-specific and unusable for anyone cloning the repo. Replace with an empty `allowedRoots: []` plus a comment explaining that this baseline file should not contain user-specific paths and that real allowedRoots live in `%LOCALAPPDATA%\mcp-winfs\config.json`.
3. **`scripts/restart-winfs.ps1`** — em-dash characters (`—`) appear from line 53 onward and break PowerShell parsing on machines whose default code page isn't UTF-8. Replace each em-dash with an ASCII hyphen-minus (`-`) or a plain word, whichever reads better in context.
4. **README — `sshExePath` override note.** Wave 2a's reporting did not explicitly confirm this paragraph landed. Verify; if absent, add it: "By default `ssh_exec` uses `C:\Windows\System32\OpenSSH\ssh.exe`. To override (Git-bundled OpenSSH at `C:\Program Files\Git\usr\bin\ssh.exe`, MSYS2 at `C:\msys64\usr\bin\ssh.exe`, or any other location), add `sshExePath` to your config file at `%LOCALAPPDATA%\mcp-winfs\config.json`."
5. **Config-location docs.** A new operator running winfs for the first time should not have to read `src/core/config.ts` to learn where the runtime config lives. Three changes:
   - **README** — add a `## Configuration` section near the top of "Getting started" with the exact path (`%LOCALAPPDATA%\mcp-winfs\config.json`), what fields it accepts, and the bootstrapping note that the file may not exist and the server starts with empty allowedRoots (EPERM_ROOT on every path call) until it is created.
   - **Error hint** in `src/core/config.ts` (or wherever the EPERM_ROOT hint string lives) — replace generic "Edit config.json to add one" with the resolved absolute path of the expected config file, computed at startup from `%LOCALAPPDATA%`. Example output: `"No allowedRoots configured. Edit C:\\Users\\User\\AppData\\Local\\mcp-winfs\\config.json to add one. See README §Configuration."`
   - **Spec** — add a short subsection under existing config discussion (find the right § with `grep -n` first) noting that `configs/default.json` in the repo is dev-only and not loaded at runtime; the actual lookup is `%LOCALAPPDATA%\mcp-winfs\config.json`.

## Phase A — CLAUDE.md MCP-hang pattern

Edit `CLAUDE.md`. Find an "Operational notes" or "Known issues" subsection (or add one if absent — under existing development workflow section, not at the top). Add:

> **MCP transport occasional hangs.** Tool calls from Claude Desktop sometimes return `No result received ... after waiting 4 minutes`. Empirically the pattern is: 2-3 four-minute timeouts on the same call, then the next invocation returns instantly. Workaround: retry the call once or twice. If three consecutive timeouts on the same call, full Claude Desktop exit through the system tray (right-click → Exit, not window close) and restart. If timeouts persist after restart, check Task Manager for orphaned `node.exe` processes from prior winfs / Desktop Commander instances and kill them.

Wording can be adjusted, but keep the practical advice (retry → tray exit → kill orphan node) intact.

## Phase B — configs/default.json cleanup

Edit `configs/default.json`. Replace the current `allowedRoots` array with:

```json
"allowedRoots": [],
```

Add a JSON-compatible header comment is not possible (JSON has no comments), so instead add a top-level field that acts as documentation:

```json
"_documentation": "This baseline config is bundled with the repo and must not contain user-specific paths. Real allowedRoots live in %LOCALAPPDATA%\\mcp-winfs\\config.json. See README §Configuration."
```

If the schema in `src/core/config.ts` has `.strict()` (it does), the new `_documentation` field will fail validation. Two options: (a) extend the schema to accept and ignore `_documentation`, (b) put the explanation in a sibling README inside `configs/`. Pick (b) — simpler, doesn't expand the schema. Create `configs/README.md` with the explanation; revert the field plan.

So the actual change:
- `configs/default.json`: only `allowedRoots: []` change (keep all other fields as-is — they are sensible defaults for shellBlocklist, timeouts, etc.).
- New file `configs/README.md`: explain the role of `default.json` (dev baseline, not loaded at runtime) vs `local.json` (dev-time override, also not loaded at runtime) vs `%LOCALAPPDATA%\mcp-winfs\config.json` (real runtime config).

## Phase C — restart-winfs.ps1 em-dash fix

Edit `scripts/restart-winfs.ps1`. Scan from line 53 onward. Replace each em-dash (`—`, U+2014) with `-` (hyphen-minus, U+002D), or rephrase the line so a dash isn't needed. Verify file parses by running:

```
powershell -NoProfile -Command "Get-Command -Syntax (Get-Content scripts\restart-winfs.ps1 -Raw)"
```

(If that doesn't work cleanly, just try `powershell -NoProfile -File scripts\restart-winfs.ps1 -WhatIf` or any dry-run variant; goal is to catch parse errors without running the actual restart.)

## Phase D — README sshExePath note

Open `README.md`. Search for `sshExePath` or `ssh_exec`. If a paragraph already documents the override path (`%LOCALAPPDATA%\mcp-winfs\config.json`), skip. If not, add it under the ssh_exec tool description or in the config section, using the wording from origin section above.

## Phase E — config-location docs

### E1. README §Configuration

Add a new section near the top of "Getting started" / "Setup":

```markdown
## Configuration

winfs reads its runtime configuration from `%LOCALAPPDATA%\mcp-winfs\config.json`
(typically `C:\Users\<USER>\AppData\Local\mcp-winfs\config.json`). The file is
not created automatically — until it exists, the server starts with empty
`allowedRoots` and every path-bound tool returns `EPERM_ROOT`.

Minimal example:

[json code block with allowedRoots, mode, etc.]

The files `configs/default.json` and `configs/local.json` in the repository
are development-time fixtures and are NOT loaded at runtime — they exist for
tests and as a schema reference. Do not edit them expecting changes to take
effect; edit `%LOCALAPPDATA%\mcp-winfs\config.json` instead.
```

Use real path values from the existing examples in `configs/default.json` so the minimal example is fully runnable.

### E2. Error hint fix in src/core/config.ts (or wherever EPERM_ROOT message lives)

Find where the `EPERM_ROOT` error includes `hint: "No allowedRoots configured. Edit config.json to add one."` (likely in `src/core/path-check.ts` or `src/tools/...` — `grep -rn "No allowedRoots configured"` to locate). Change the hint to compute the actual expected config path:

```typescript
hint: `No allowedRoots configured. Edit ${defaultConfigPath()} to add one. See README §Configuration.`
```

(Use the existing `defaultConfigPath()` from `src/core/config.ts` — export it if not exported yet.)

### E3. Spec note

Edit `docs/design/mcp-winfs-spec.md`. Find the section discussing config (grep `'config\|allowedRoots'`). Add a short paragraph clarifying:

> The repository contains `configs/default.json` and `configs/local.json` as
> development fixtures used by tests and for documentation purposes. These
> files are NOT loaded by the runtime server. The runtime lookup path is
> `%LOCALAPPDATA%\mcp-winfs\config.json` (resolved via `LOCALAPPDATA` env or
> the platform default).

### E4. Tests

Add at least one regression test covering the new hint: when allowedRoots is empty, the EPERM_ROOT response includes the absolute resolved config path in `hint` (not the literal placeholder string). Match the exact format the new hint produces.

## Commit decomposition

Suggested (CC may fold/split, no force-pushes):

```
docs: CLAUDE.md — MCP transport hang/retry pattern
chore(configs): clean user-specific paths from default.json; add configs/README.md
fix(scripts): replace em-dashes in restart-winfs.ps1 with ASCII hyphens
docs(readme): ssh_exec sshExePath override note
docs+code: config-location clarity — README §Configuration, accurate EPERM_ROOT hint, spec note
```

Push to origin/main at end.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Baseline 371 tests. Expected after this wave: ~372-374 (one regression test for the new hint, possibly one for `configs/default.json` shape if it makes sense).
- No version bump. [Unreleased] only in CHANGELOG.
- Don't expand `CONFIG_SCHEMA` for documentation fields — use a sibling README instead.
- Don't refactor `defaultConfigPath` — just export and use it from the hint site.
- If em-dash replacement requires changing PowerShell logic (not just the character), stop and report — we may need a separate session for the script.

## Reporting

End of wave (single block):

```
v0.7 tails done: claude.md @ <sha>, configs cleanup @ <sha>, ps1 emdash @ <sha>, readme sshExePath @ <sha>, config-location docs @ <sha>, main @ <sha>
tests: <N> passing (was 371)
new error hint format: "<exact rendered string from a real call>"
configs/default.json allowedRoots: [] (was 3 user-specific paths)
em-dashes replaced: <N>
README sshExePath note: <added | already present, unchanged>
```

On failure: stop at the step, report step ID, command, full output. Earlier phases pushed = safe.
