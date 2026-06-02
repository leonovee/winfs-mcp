# Process suite — residual flakiness notes (v0.9.1)

Phase A of the v0.9.1 patch wave stabilized the process suite from
**10/10 failure** (pre-fix) to **~85% pass rate** in tight-loop runs
on this Windows host. The remaining failures cluster on the tests that
spawn `powershell.exe` and then kill it via `taskkill /F /T`.

## Tests with residual flakiness

When failures occur, they hit one or more of:

- `process_registry.test.ts > timeout_seconds expiry transitions to timed_out`
- `process_registry.test.ts > kill() force=true transitions to killed`
- `start_process.test.ts > timeout_seconds=1 on hang transitions to timed_out`
- `kill_process.test.ts > kill running session with force=true → killed:true, status='killed'`
- `kill_process.test.ts > idempotent: second kill returns was_already_settled:true`
- `kill_process.test.ts > graceful kill (force=false default) eventually transitions to killed`
- `list_process.test.ts > two spawned sessions appear in list sorted by started_at asc`

## Observed failure mode

Symptom: `Hook timed out in 15000ms` (now 30000ms) on `afterEach`, with
the underlying error chain being `EBUSY: resource busy or locked,
rmdir 'C:\Users\.../mcp-winfs-test-XXX'` on an empty tempdir that
formerly held the spawned subprocess's `cwd`.

## Validated root cause

Even with all of:

1. ProcessSession explicitly destroying child stdio pipes on settle
   ([process_registry.ts:147-156](../../../src/core/process_registry.ts#L147))
2. Defensive close-wait + force-settle on timeout
   ([process_registry.ts:401-422](../../../src/core/process_registry.ts#L401))
3. Node's built-in `fs.rm({maxRetries: 10, retryDelay: 200})` retry ladder
4. vitest `hookTimeout` bumped 15s → 30s

…Windows still holds the killed PowerShell process's cwd handle past
the combined budget in pathological cases. Empirical evidence:

- Manually `rmdir`-ing a leaked test temp directory ~15 minutes after
  the test finished succeeds instantly. The handle does eventually
  release; the wait is just longer than vitest's reasonable hook budget.
- Failures cluster on consecutive loops (e.g. loops 7-8 in a 10-loop
  run), consistent with handle-release queue backlog under repeated
  spawn/kill churn.

This is downstream of the `ProcessRegistry` lifecycle — Node's `close`
event fires and the session settles correctly; the kernel-side cleanup
of the dead process record (and the cwd handle it carried) runs on its
own schedule, which is sometimes seconds, sometimes tens of seconds.

## Mitigation

`tests/helpers.ts` `rmdirWithRetry` logs `EBUSY` to stderr and returns
successfully without throwing after retry exhaustion — the test's
logical assertion has already run; %TEMP% gc cleans the leak. This
keeps `afterEach` honest about cleanup failure (visible in logs) but
doesn't fail the test for an OS race outside the suite's control.

## When the rate climbs

If the stderr `rmdirWithRetry: EBUSY ... leaking to %TEMP% gc` rate
goes above ~5 per run (currently 3-6 in a 31-test process-suite run),
investigate:

1. A new defect in `ProcessSession.settle` failing to destroy a stdio
   pipe (close event then doesn't fire → Node holds the process handle
   → Windows holds the cwd handle).
2. A new test pattern that spawns and doesn't await `waitForSettle`
   before cleanup.
3. Antivirus configuration change scanning the test temp dir.

## Why not skip the affected tests

Skipping would lose ~85% of the assertion coverage in exchange for a
clean test run. The underlying invariant (kill cascade + settle event
+ snapshot status) IS validated when the test runs, and the failure
mode (`afterEach` cleanup) is orthogonal to the assertion. The
non-deterministic OS race is documented here for future maintainers
who see the occasional red CI run.
