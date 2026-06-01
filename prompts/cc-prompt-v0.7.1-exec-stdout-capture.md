# CC prompt — v0.7.1 hotfix: execute_command PATHEXT=.CPL — PATH resolution broken on Windows

## Origin

**Root cause identified.** `execute_command` subprocess env on this Windows machine has `PATHEXT=.CPL` instead of the standard Windows `PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC`. This means PowerShell's command resolution can only find `.CPL` (Control Panel) files by short name. Anything else — `git`, `node`, `cmd`, `where.exe`, etc. — returns `CommandNotFoundException` because PowerShell appends each PATHEXT extension when searching PATH and only `.CPL` is in the search list.

**Symptom map (now all explained by PATHEXT):**
- `git --version` → CommandNotFoundException (PowerShell searches `git.CPL` in PATH, doesn't find it).
- `where.exe git` → empty (same reason — `where` uses PATHEXT internally for its name lookup).
- `Test-Path 'C:\Program Files\Git\cmd\git.exe'` → True (Test-Path doesn't use PATHEXT, just stats the literal path).
- `& 'C:\full\path\git.exe' --version` → exits 0, empty stdout was misdiagnosed earlier as "output capture broken" — actually output capture works fine; the misdiagnosis came from a chain of failed PATHEXT-dependent commands giving empty results.
- Output capture pipe (`2>&1 | Out-String`) hanging 4 minutes: this is the documented MCP transport 4-min stall, triggered coincidentally by these specific commands but NOT caused by spawn pipe config.

**Historical context:** Handoff #1 (project start) documented this as "bug #2: execute_command silent-output." Survived five waves as a known-issue with a `Start-Process -RedirectStandardOutput` workaround. Root cause was always PATHEXT, never spawn config. Workaround happened to bypass the PATHEXT issue because `Start-Process` accepts a full-path argument and doesn't reroute through PATH+PATHEXT.

**`start_process` doesn't have this bug** because `ProcessRegistry.spawn()` calls `child_process.spawn(command[0], command.slice(1), { shell: false })` — `shell: false` means Node spawns the binary directly without going through PATH resolution. Only `execute_command`'s pipeline (which wraps through PowerShell for blocklist evaluation) routes through PATH and hits the PATHEXT bug.

## Severity

P0. `execute_command` is broken for all bare-name binary invocations on any machine where the system env doesn't already have a correct PATHEXT (i.e. any non-developer Windows setup, or any developer machine where PATHEXT was customized). Hotfix v0.7.1.

## Fix

### F1. Locate the env composition for execute_command's spawn

```
grep -rn 'PATHEXT' src/
```

Expected hits: somewhere in `src/core/exec_safety.ts` or `src/core/env_safety.ts` or similar — wherever the spawn env is built. The bug is one of:

- An explicit `PATHEXT: ".CPL"` literal (likely a placeholder typo that was meant to be filled in)
- An env allowlist that includes `PATHEXT` but rebuilds it from a wrong default
- A spread/merge that overrides system PATHEXT with a smaller value

Read the surrounding code to confirm the mechanism. **If `grep -rn 'PATHEXT' src/` returns NO hits, then PATHEXT is not explicitly set by winfs — the broken value is coming from the parent process env (Claude Desktop / Node itself) and being passed through.** In that case, the fix is to explicitly set the standard PATHEXT in the spawn env regardless of parent.

### F2. Apply the fix

Set PATHEXT explicitly to the standard Windows list in the spawn env for `execute_command`:

```typescript
const STANDARD_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

const subprocessEnv = {
  ...sanitizedBaseEnv,
  PATHEXT: STANDARD_WINDOWS_PATHEXT,
  Path: sanitizedPathString,
};
```

Apply wherever the spawn env is built for execute_command. Audit `start_process` / `ssh_exec` / `run_python` / any other spawn point to confirm they either don't depend on PATHEXT (e.g. `start_process` with `shell: false` doesn't) or also get the corrected value.

### F3. Add invariant

PATHEXT in subprocess env must equal the standard Windows list. Add as a server-startup invariant test in `tests/unit/exec/pathext_invariant.test.ts`:

```typescript
test("execute_command subprocess env carries standard Windows PATHEXT", async () => {
  // Spawn a child that echoes its PATHEXT env back
  const result = await executeCommandImpl({
    command: ["cmd.exe", "/c", "echo %PATHEXT%"],
  }, mockToolContext({ mode: "strict" }));
  
  expect(result.exit_code).toBe(0);
  expect(result.stdout.trim()).toBe(".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC");
});
```

### F4. Add functional regression tests

`tests/unit/exec/stdout_capture.regression.test.ts`:

```typescript
test("execute_command resolves bare-name binary from PATH (node --version)", async () => {
  const result = await executeCommandImpl({
    command: ["node", "--version"],
  }, mockToolContext({ mode: "strict" }));
  
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/);
  expect(result.stderr).toBe("");
});

test("execute_command resolves git from PATH", async () => {
  const result = await executeCommandImpl({
    command: ["git", "--version"],
  }, mockToolContext({ mode: "strict" }));
  
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toMatch(/^git version /);
});

test("execute_command resolves where.exe (PATHEXT-dependent classic)", async () => {
  const result = await executeCommandImpl({
    command: ["where.exe", "git"],
  }, mockToolContext({ mode: "strict" }));
  
  expect(result.exit_code).toBe(0);
  expect(result.stdout.trim()).toMatch(/git\.exe/i);
});
```

These tests fail today on this machine, pass after F2. Run on whatever machine CC is on to confirm — if CC is on a machine where system PATHEXT happens to be set correctly, the tests may pass before the fix (false-pass). To force the bug to reproduce regardless of system env, write a unit-level test that injects a broken PATHEXT into mock parent env and verifies execute_command overrides it.

### F5. Smoke probe addition

`scripts/smoke/v0.7-smoke.mjs`:

```javascript
{
  name: "execute_command resolves bare-name binary via PATH+PATHEXT",
  run: async () => {
    const result = await callTool("execute_command", { command: ["node", "--version"] });
    return result.stdout.match(/^v\d+\./) !== null;
  },
},
{
  name: "execute_command PATHEXT invariant — standard Windows list",
  run: async () => {
    const result = await callTool("execute_command", { command: ["cmd.exe", "/c", "echo %PATHEXT%"] });
    return result.stdout.trim() === ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  },
},
```

Same in both strict and unrestricted passes.

### F6. Docs + CHANGELOG + release

Update `CLAUDE.md`: bug #2 entry in operational notes — mark as resolved in v0.7.1. Note that the root cause was PATHEXT, NOT spawn config — five waves of misdiagnosis. Brief lesson: when a symptom looks like "X is broken" but a non-obvious env variable is part of the resolution chain, dump that env variable before assuming X is broken.

CHANGELOG: new `[0.7.1] — <date>` section.

```
Fixed:
- execute_command: PATHEXT subprocess env defaulted to .CPL on some Windows
  configurations, breaking PATH resolution for bare-name binaries (`git`,
  `node`, `cmd`, `where.exe`). Now explicitly set to standard Windows list.
  Bug #2 from project handoff #1, resolved.

Added:
- Smoke probe for PATHEXT invariant + bare-name resolution.
- Unit test injecting broken parent PATHEXT, asserting subprocess
  override correctness.
```

Version bump:

```
npm version 0.7.1 --no-git-tag-version
```

### F7. Commit decomposition

```
fix(exec_safety): explicit standard PATHEXT in subprocess env (bug #2)
test(exec): PATHEXT invariant + bare-name PATH resolution regressions
chore(smoke): PATHEXT + bare-name execute_command probes
docs: CLAUDE.md mark bug #2 resolved; CHANGELOG [0.7.1]
chore(release): bump 0.7.0 -> 0.7.1
```

5 commits. CC may fold/split with judgment.

### F8. Tag + push

```
git push origin main
git tag -a v0.7.1 -m "v0.7.1: hotfix — execute_command PATHEXT subprocess env (bug #2, since project start)"
git push origin v0.7.1
```

## Cosmetic note (out of scope, post-tag)

CC noted that winfs spawns Windows PowerShell 5.1 (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) even when PowerShell 7 (`pwsh.exe`) is available in PATH. PS7 has better UTF-8 defaults, faster startup, and is the actively-developed line. Switching to `pwsh.exe` when present (fall back to powershell.exe if absent) is a quality-of-implementation improvement worth a v0.7.2 or v0.8 patch. Not blocking; not in this hotfix.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary.
- Smoke must pass — including the two new PATHEXT probes — before tag.
- Do NOT change spawn shell or stdio config; the bug is PATHEXT-only. If F2 isn't sufficient and stdout is still empty after fix, stop and report — there's a second bug we haven't found.
- Audit similar spawn points (`run_python`, `ssh_exec`) — if any of them also explicitly set PATHEXT or strip it, document and fix in the same wave. If only execute_command had the bug, note that in the report.

## Reporting

```
v0.7.1 hotfix shipped:
  fix @ <sha>
  tests @ <sha>
  smoke @ <sha>
  docs @ <sha>
  bump @ <sha>
  tag v0.7.1 -> <tag-sha> -> commit <sha>, pushed
  main @ <sha>

tests: <N> passing (was <baseline>)
smoke: <Y>/<Y> green; PATHEXT + bare-name probes pass
fix location: <file:line where PATHEXT was set/missing>
mechanism: <typo .CPL | missing PATHEXT in env composition | other>
other spawn points audited: <list, with status of each>

bug #2 from handoff #1: RESOLVED after five waves. Root cause: PATHEXT, not spawn config.
```

On any failure: stop, report full output, do NOT tag with red probes.
