# CC prompt — child-process spawn hardening (the subprocess bugs)

## Origin — real observed symptoms, not theory

Over a full day of driving winfs through Claude Desktop on Windows, every
operation that spawns a child process either returned empty or hung. The
filesystem/cmdlet path is rock-solid; the spawn path is broken. Concretely:

1. **PATHEXT arrives as `.CPL` in the spawned subprocess env.** Bare
   `git`/`node`/`where` -> `CommandNotFoundException` despite the dir being
   on `$env:Path`. Registry PATHEXT is correct (`.COM;.EXE;.BAT;.CMD;...`);
   the spawned process gets `.CPL`. The root leak is the parent env that
   Claude Desktop launched winfs with -- but winfs inherits and forwards it.
2. **Shim binary returns empty stdout.** `& 'exe' args` -> exit 0 in ~150ms,
   stdout empty, even with `> file` redirect (0 bytes).
3. **mingw binary hangs 4 minutes.** Likely waiting on a terminal.
4. **Pipe capture hangs.** `$x = & 'exe'` or `& 'exe' | Out-String` -> hang.
5. **No recovery after any hang.** One hung child wedges the whole server;
   every subsequent call hangs until a full Claude Desktop restart.
6. **Multi-statement (`;`) hangs** though each statement alone is fast.

**Honest reconciliation with prior investigations:** bug #1/#2/P3 concluded
"winfs impl is correct" -- and they were right *for the clean test
environment* (VS Code / CI, normal PATHEXT, in-process). The bug only
manifests in the real Claude-Desktop spawn environment (inherited `.CPL`,
MCP stdio). The fix is **defensive hardening**: don't trust the inherited
env, don't lose child stdio, never let a child wedge the server.

**Scope boundary:** this fixes the *child-process spawn* layer
(`execute_command` and friends). It does NOT fix the separate
Claude-Desktop <-> winfs MCP-transport hangs on large `winfs:write`/`read`
payloads -- that's the upstream transport layer (the #3 investigation
covers it). Don't conflate them.

No version decision yet -- likely v0.10.0 given behavioral spawn changes;
CC proposes at the end.

## Phase A — read current spawn implementation

```
cat src/core/exec_safety.ts        # or wherever execute_command lives
grep -rn 'spawn\|execFile\|child_process' src/
grep -rn 'Out-String\|powershell\|pwsh\|-Command' src/
cat src/core/process_registry.ts   # stateful sessions -- must not regress
```

Report: how does winfs currently invoke the shell? Does it wrap commands
in `powershell -Command "..."`? Does it pass `env`? How does it read child
stdout (pipe? `Out-String`?)? Is there any timeout today? This drives the
exact fixes.

## Phase B — hard timeout + kill on every one-shot spawn (CRITICAL)

The single highest-value fix: a hung child currently wedges the server
forever. Every one-shot spawn gets a timeout that SIGKILLs and returns a
structured timeout error.

```js
const child = spawn(cmd, args, opts);
const timer = setTimeout(() => {
  child.kill('SIGKILL');
}, timeoutMs);
child.on('close', () => clearTimeout(timer));
// on timeout: resolve/reject with a clear ETIMEDOUT-style error,
// do NOT block the event loop, do NOT leave dangling handles/listeners.
```

**Critical constraint -- do NOT regress stateful sessions.** `start_process`
/ `interact` (ProcessRegistry, invariant #41) are *intentionally*
long-running. The timeout applies to ONE-SHOT `execute_command`, never to
registry-managed session processes. Keep the two paths distinct.

Timeout value: from config (existing `shellTimeoutMs` / `shellMaxTimeoutMs`
if present), with the per-call `timeout_ms` override still honored.

After this fix, the "no recovery after hang" / "multi-statement hang" /
"CIM hang" / "mingw-git hang" symptoms all become a clean timeout error
instead of a dead server.

## Phase C — explicit PATHEXT in spawn env (fixes "git not recognized")

Never forward the inherited (possibly `.CPL`) PATHEXT. Set it explicitly:

```js
const env = { ...process.env,
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC' };
spawn(cmd, args, { ...opts, env });
```

Do this for every spawn (one-shot and session). Document why (inherited
PATHEXT observed as `.CPL` under Claude Desktop).

Add a regression test: spawn a child, assert its `PATHEXT` contains `.EXE`
even if `process.env.PATHEXT` is mangled (temporarily set
`process.env.PATHEXT='.CPL'` and verify the spawned env is corrected).

## Phase D — direct stdio capture (fixes empty output + capture hang)

If Phase A reveals a double layer (winfs runs `powershell -Command "... |
Out-String"` and parses PowerShell's stdout, which itself loses the
grandchild's output) -- switch to direct capture:

- `stdio: ['ignore', 'pipe', 'pipe']`
- accumulate `child.stdout`/`child.stderr` via `.on('data', ...)` into
  buffers
- resolve on `.on('close', ...)` with collected output + exit code
- do NOT rely on `| Out-String` inside the PowerShell command for capture

winfs's purpose is running PowerShell, so the *shell host* is still
PowerShell -- but winfs should capture the host's stdio directly via the
pipe, not through a nested `Out-String` round-trip. Confirm in Phase A.

Add a test: command emitting a known string to stdout -> assert exact bytes
come back (catches the "empty stdout" regression).

## Phase E — git/terminal-friendly spawn (fixes mingw hang)

For spawns: close stdin and suppress terminal/pager waits.

- `stdio[0] = 'ignore'` (no stdin) -- a child waiting on stdin can't hang.
- For git: set `env.GIT_TERMINAL_PROMPT = '0'`, recommend `--no-pager` in
  docs. (winfs can't force flags on user commands, but the env helps, and
  the Phase B timeout is the real safety net.)

## Phase F — pwsh 7 over 5.1 (partially done in v0.9.1)

v0.9.1 already added `config.powershellExePath` + auto-detect preferring
`pwsh.exe`. **Verify it's actually wired into the spawn path** (not just a
resolver nothing calls). If the one-shot `execute_command` path still
hardcodes `powershell.exe`, route it through the resolver. PS7 gives proper
UTF-8 and `$proc.Parent` without the CIM call that hangs.

If already fully wired, no-op this phase and say so.

## Phase G — hot-reload runtime config (quality of life)

Runtime config is `%LOCALAPPDATA%\mcp-winfs\config.json` (note: on at least
one machine Claude Desktop launches winfs with `--config <repo>/configs/
local.json` -- Phase A confirms which path is authoritative at runtime; the
answer goes in README).

Add `fs.watch` on the resolved runtime config path; on change, reload
`allowedRoots` (and other hot-reloadable fields) without a full restart.
Debounce (editors fire multiple events), validate the new config before
applying (don't apply a malformed edit -- keep old config + log error on
failure), and log the reload.

Document in README which config file is runtime vs dev-fixture.

## Tests + verify

- Unit: timeout kills a hung child + returns structured error; PATHEXT
  corrected in spawned env; direct stdio returns exact bytes; session
  processes (start_process) NOT affected by the one-shot timeout.
- Smoke: existing 76 probes green; add a probe running a real quick command
  (e.g. `node --version` via full path) asserting non-empty stdout + zero
  exit, to catch the empty-output regression at the wire level.
- Full suite green (was 501). Build clean.

## Constraints

- All work on `main`. No branches, no force-push.
- **Do NOT regress ProcessRegistry sessions** (invariant #41) -- the
  one-shot timeout must not touch long-running registered sessions.
- PATHEXT set explicitly on ALL spawns; full standard list.
- Don't duplicate the v0.9.1 pwsh resolver -- verify and route, don't rebuild.
- Hot-reload must validate-before-apply and debounce; a bad edit must not
  brick the running server.
- This wave does NOT address the CD<->winfs MCP-transport large-payload
  hangs (separate layer). Stay in the child-spawn lane.
- git via full-path-no-pipeline in the MCP env if CC hits it; CC's own
  terminal is fine.

## Reporting

```
child-spawn hardening done:
  Phase A current impl: <how winfs spawns today -- PS wrapper? env? stdio? timeout?>
  Phase B timeout+kill @ <sha> -- one-shot only, sessions untouched (invariant #41 verified)
  Phase C explicit PATHEXT @ <sha> -- regression test: mangled .CPL corrected
  Phase D direct stdio @ <sha> -- exact-bytes test passes (was empty)
  Phase E git/terminal-friendly @ <sha>
  Phase F pwsh routing: <newly wired | already wired in v0.9.1, verified>
  Phase G hot-reload config @ <sha> -- debounced, validate-before-apply
  tests: <N> (was 501) | smoke: <Y>/<Y> (added wire-level non-empty-stdout probe)
  build: clean
  proposed version: <v0.10.0 | other>
  NOT addressed (out of scope): CD<->winfs transport large-payload hangs
```

On failure: stop, report step, full output. Phase A findings first before
B-G -- the exact fixes depend on the current spawn implementation.
