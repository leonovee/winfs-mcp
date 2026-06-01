# CC prompt — v0.7 wave 2b: process control suite (start_process / interact / list_process / kill_process)

## Origin

Building on wave 2a (clean on origin/main, 340 tests passing). Wave 2b is the largest single DC-parity addition: a stateful in-memory process registry plus four tools operating on it. Architecturally distinct from everything winfs has shipped so far — filesystem tools are stateless, one-shot exec tools have no session. ProcessRegistry is the first long-lived shared mutable state in the server.

Source motivation: existing v0.7 roadmap (`prompts/cc-prompt-mcp-winfs-v0.7-roadmap.md`) lists `start_process+interact` and `list/kill_process` as DC-parity items.

## Architecture overview

New core module `src/core/process_registry.ts`:

- `class ProcessSession`: session_id (uuid v4), command (string[]), started_at (ISO), status (`running` | `exited` | `killed` | `timed_out` | `spawn_failed`), exit_code (number | null), stdout_buffer (Buffer, capped 1 MB), stderr_buffer (Buffer, capped 1 MB), truncated_stdout, truncated_stderr (booleans), child (ChildProcess | null), stdin_closed (boolean), settled_at (ISO | null), waiters (array of pending interact long-polls).

- `class ProcessRegistry`: in-memory `Map<session_id, ProcessSession>`. Methods: `spawn(command, cwd, env, timeoutSeconds)`, `get(session_id)`, `list()`, `kill(session_id, force)`, `shutdown()`. Internal periodic GC sweeps settled sessions older than `sessionTtlMs`.

- Singleton per server lifetime. Tests inject a fresh registry to avoid cross-test state leakage.

Session lifecycle:
1. `start_process` calls `registry.spawn(...)`, gets back `ProcessSession`.
2. Child runs. stdout/stderr listeners append to capped buffers. Each chunk wakes any waiting `interact` long-polls whose `_since` offset is now satisfied.
3. Child exits → status transitions to `exited` (or `killed` / `timed_out` / `spawn_failed`), `settled_at` set, exit_code captured. All remaining waiters wake.
4. Session stays in registry for `sessionTtlMs` (default 60 000 ms) after settle, so late `interact` calls can still retrieve final output.
5. After TTL, GC removes session from registry.

Concurrency limit: max 16 simultaneous running sessions (config-tunable). Exceeding → `EBUSY` from `start_process`.

Server shutdown (SIGINT / SIGTERM): `registry.shutdown()` SIGKILLs all running children, awaits their exit, then resolves. If the current server entry point doesn't have a shutdown hook to wire this into, stop and report.

## Phase A — registry + list_process

### A1. Architectural read

```
ls src/core/
cat src/core/config.ts
cat src/server.ts
grep -n 'shutdown\|SIGINT\|SIGTERM' src/server.ts src/index.ts 2>/dev/null
```

Report: any prior stateful module, where ProcessRegistry should live, whether shutdown hook exists.

### A2. ProcessRegistry module

- File: `src/core/process_registry.ts`.
- Exports `ProcessSession` and `ProcessRegistry`.
- Internal state: `sessions: Map<string, ProcessSession>`, `maxConcurrent` (default 16), `bufferCap` (default 1 048 576), `sessionTtlMs` (default 60 000), `gcIntervalMs` (default 10 000).
- `spawn(command, cwd, env, timeoutSeconds)`: generate session_id, set status='running', spawn child via `child_process.spawn(...)` with `shell: false`, `stdio: ['pipe', 'pipe', 'pipe']`. Wire stdout/stderr listeners (append to buffer, drop bytes beyond cap, set truncated flag). Wire `error` listener for spawn-error (mirror v0.6 §U exec_safety fix). Wire `close` listener (set status, exit_code, settled_at, wake waiters). Start timeout timer that calls `kill(session_id, true)` and sets status='timed_out' on fire.
- `get(session_id)` returns session or undefined.
- `list()` returns array of session summaries.
- `kill(session_id, force)`: if force, immediate SIGKILL; else graceful (Windows: `taskkill /T /PID <pid>` without /F via execSync; non-Windows: `child.kill('SIGTERM')`), wait 5 s, if still running → SIGKILL. Update status='killed'.
- `shutdown()`: iterate running sessions, SIGKILL each, await all `close` events with 10 s hard deadline.
- GC: setInterval scanning for `settled_at + sessionTtlMs < now()` and deleting. Started in constructor, cleared in shutdown.

Waiter mechanism:
- Each session has `waiters: Array<{ resolve, deadline, stdoutSince, stderrSince }>`.
- On stdout/stderr chunk: scan waiters, resolve any whose `stdoutSince < stdout_buffer.length` or `stderrSince < stderr_buffer.length`.
- On settle: resolve all waiters.
- On deadline: resolve (not reject — long-poll timeout is normal).
- Method: `waitForOutput(stdoutSince, stderrSince, maxWaitMs)` returns Promise resolving to current snapshot.

### A3. Wire singleton + shutdown hook

- In server construction: instantiate `const registry = new ProcessRegistry()` at startup. Pass to four new tool handlers per the project's DI pattern.
- Add SIGINT/SIGTERM handlers (if absent) calling `await registry.shutdown()` then exit. If hook exists, append.

### A4. Implement list_process

- File: `src/tools/system/list_process.ts`.
- Input: none.
- Output: `{ sessions: SessionSummary[] }`. Fields: `session_id`, `command_prefix` (256 chars), `started_at`, `status`, `exit_code`, `stdout_bytes`, `stderr_bytes`, `truncated_stdout`, `truncated_stderr`, `settled_at`.
- Sort by `started_at` asc (stable).
- Read-only: audit omits `mode`.
- Register in server tool list.

### A5. Tests

- Empty registry → empty sessions array.
- Two fake spawns → list contains both running.
- One settles → entry has exit_code + settled_at.
- GC with shortened TTL → settled session removed.
- Buffer cap: >1 MB stdout → truncated_stdout=true, length capped.
- Waiter wake on chunk: resolves with content.
- Waiter wake on settle: resolves with status='exited'.
- Waiter deadline at ~50 ms.

## Phase B — start_process

### B1. Implementation

- File: `src/tools/system/start_process.ts`.
- Input: `{ command: string[] (min 1), cwd?: string, env?: Record<string,string>, timeout_seconds?: number }`.
- Defaults: timeout_seconds=300, max 3600.
- Validation:
  - `command[0]` checked against exec_blocklist for current mode (reuse existing module, no duplication).
  - `cwd` inside allowedRoots → else EPERM_ROOT.
  - `env` merged with sanitized base env.
- Cap: runningCount() >= 16 → EBUSY.
- Call `registry.spawn(...)`.
- Output: `{ session_id, started_at, status, command_prefix }`.
- Audit: mutation. command_prefix, cwd, env_key_count, timeout_seconds, session_id, status. Carries `mode`.
- Register.

### B2. Tests

- Happy: spawn echo → running → settles exited exit_code=0, stdout='hi'.
- cwd outside allowedRoots → EPERM_ROOT.
- command[0] in blocklist → blocked.
- 16 running → 17th = EBUSY.
- timeout_seconds=1 on hang → ~1s status='timed_out'.
- Spawn-error: bogus binary → status='spawn_failed', EIO (regression-style, mirrors v0.6).

## Phase C — interact

### C1. Implementation

- File: `src/tools/system/interact.ts`.
- Input: `{ session_id, input?, stdout_since?, stderr_since?, max_wait_ms?, finalize? }`.
- Defaults: stdout_since=0, stderr_since=0, max_wait_ms=5000 (max 60000), finalize=false.
- Validation:
  - session_id exists → else ENOSESSION.
  - input + stdin_closed → EPIPE_CLOSED (new code).
  - input + status!='running' → EPIPE_CLOSED.
- Flow:
  1. If input: child.stdin.write(input). If finalize: child.stdin.end(), stdin_closed=true.
  2. `session.waitForOutput(stdout_since, stderr_since, max_wait_ms)`.
  3. Capture snapshot.
- Output: `{ session_id, status, exit_code, stdout, stderr, stdout_offset, stderr_offset, truncated_stdout, truncated_stderr, settled_at }`. stdout/stderr sliced from since with UTF-8 boundary safety. offsets = current end.
- Audit: mutation. session_id, input_prefix (256 chars or 'none'), max_wait_ms, finalize, returned bytes. Carries `mode`.
- Register.

### C2. Tests

- Echo: 'hello\n' → stdout='hello\n', status='exited', exit=0, offset=6.
- Stdin: interactive node with input='hi\n' → stdout='saw: hi\n'.
- Long-poll timeout: max_wait_ms=200 on silent process → empty stdout, ~200ms (<400ms).
- Long-poll wake on output: ~100ms.
- ENOSESSION for unknown.
- EPIPE_CLOSED after finalize.
- Two concurrent interact calls wake together.

## Phase D — kill_process

### D1. Implementation

- File: `src/tools/system/kill_process.ts`.
- Input: `{ session_id, force? }`. force default false.
- Validation: session_id exists → else ENOSESSION.
- Flow:
  - Already settled: return `{ session_id, killed: false, was_already_settled: true, status, exit_code }`.
  - Else: `registry.kill(session_id, force)`, await transition (5s grace for non-force).
- Output: `{ session_id, killed, was_already_settled, status, exit_code }`.
- Idempotent.
- Audit: mutation. session_id, force, killed, was_already_settled. Carries `mode`.
- Register.

### D2. Windows-specific care

- `child.kill('SIGTERM')` on Windows = immediate TerminateProcess (ungraceful).
- Graceful intent on Windows: `taskkill /T /PID <pid>` (no /F) — WM_CLOSE to GUI, console apps may still terminate immediately. Document in tool description.
- Force on Windows: `taskkill /F /T /PID <pid>` or `child.kill('SIGKILL')`.
- Wrap platform-specific kill in helper inside ProcessRegistry.

### D3. Tests

- Kill running → killed=true, status='killed'.
- Kill already-settled → killed=false, was_already_settled=true, exit_code preserved.
- Force kill of SIGTERM-ignoring process → escalates to SIGKILL within ~6s.
- ENOSESSION for unknown.
- Idempotent: second kill returns was_already_settled=true.

## Phase E — spec, README, CHANGELOG

### E1. Spec

Edit `docs/design/mcp-winfs-spec.md`. Add new § (next letter — confirmed in A1). Title: `§<Y>: v0.7 wave 2b — process control suite`.

Content: ProcessRegistry concept; lifecycle (created → running → settle → TTL → GC); full I/O schemas for all four tools; new error codes ENOSESSION, EBUSY, EPIPE_CLOSED; invariants (max 16 concurrent, TTL 60s, shutdown SIGKILL all within 10s, buffer cap 1MB/stream, audit mode-tagging rules).

### E2. README

- Tool table: four new rows.
- New subsection "Stateful process management".
- Known-limitations: in-memory only, server restart loses all sessions.

### E3. CHANGELOG

Under [Unreleased]:
- `Added`: four new tools.
- `Added`: ProcessRegistry subsystem.
- `Added`: error codes ENOSESSION, EBUSY, EPIPE_CLOSED.

## Commit decomposition

Suggested (CC may fold/split, no force-pushes):

```
feat(core): ProcessRegistry — stateful in-memory session manager
feat(system): list_process — enumerate sessions
feat(system): start_process — spawn long-running child with session id
feat(system): interact — long-poll read/write to session stdio
feat(system): kill_process — graceful or force termination
docs(spec): §<Y> v0.7 wave 2b — process control suite
docs: README + CHANGELOG for wave 2b
```

Push to origin/main at end.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Baseline tests: 340. Expected after wave 2b: ~380-410.
- No version bump. [Unreleased] only.
- ProcessRegistry cleanly testable: fresh per test, no global state.
- Tests do NOT leak long-running children. Quick `process.exit(0)`, afterEach cleanup, or mock spawn for unit-level.
- Race-safe: all four tools handle missing/settled sessions cleanly.
- UTF-8 with replacement on invalid bytes — no crash on binary output.
- exec_blocklist same as execute_command. No separate blocklist.
- If shutdown hook requires invasive refactor, stop and report — minimal infrastructure as prep commit.

## Reporting

End of wave (single block):

```
wave 2b done: registry+list_process @ <sha>, start_process @ <sha>, interact @ <sha>, kill_process @ <sha>, docs @ <sha>, main @ <sha>
tests: <N> passing (was 340)
new error codes: ENOSESSION, EBUSY, EPIPE_CLOSED (any others?)
max concurrent sessions: 16 (configurable: <yes|no>)
session TTL after settle: 60s
shutdown hook: <added new | extended existing>
```

Plus 2-3 sentences on architectural surprises during implementation — server lifecycle rough edges, DI awkwardness, test infra gaps. Feeds into v0.7 wave 2c or v0.8.

On failure: stop, report step, command, output. Earlier phases pushed = safe.
