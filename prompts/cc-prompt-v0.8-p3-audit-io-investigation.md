# CC prompt — P3 audit log IO investigation (v0.8.0 backlog item)

## Origin

Per `backlog/v0.8-filesystem-mcp-parity.md` P3 (escalated to "do before P5"). Three observations need explanation:

1. **`winfs:write` on 10-13 KB payloads timed out 4 minutes** repeatedly during session prompt-writing today, while `Filesystem:write_file` on the same payloads completed in <1s on the same machine.
2. Same `4-minute hang` pattern was observed in bug #1 (EPERM_ROOT) and bug #2 (silent stdout) — both disproven as winfs source defects, both localized to MCP transport / environmental causes.
3. The two differences between `winfs:write` and `Filesystem:write_file` are: (a) winfs does atomic write (tmp + fsync + rename = 2 syscalls vs 1), (b) winfs appends to audit log on every mutation.

**Hypothesis to test:** is the slowdown caused by atomic-write 2-syscall overhead, audit IO, or neither (i.e. transport)?

This is an **investigation**, not a fix. Output is a report. No code changes outside test/benchmark scaffold. Subsequent action depends on what the report finds.

## Phase A — instrumentation scaffold

Create `tests/perf/audit_io_investigation.bench.ts` (or under `scripts/perf/` — wherever fits the existing project layout best).

Instrument `writeFileImpl` with timestamp captures at:

- `t0` — handler enter
- `t1` — path validation complete
- `t2` — pre-write (just before `fs.writeFile` tmp / direct)
- `t3` — write complete (tmp file written + fsync)
- `t4` — rename complete (atomic step done) — N/A in non-atomic mode
- `t5` — audit-entry enqueued (`appendAudit` returns)
- `t6` — handler return

Track separately on a side channel (event listener on the audit queue):
- `t7` — audit-entry flushed to disk (the actual `fs.appendFile` resolves)

In real production, `appendAudit` is fire-and-forget (per wave 2c report), so `t6 - t5` is small and `t7` may happen well after `t6`. Both timings interesting.

If instrumenting the production code path violates current invariants, use a parallel `writeFileImplInstrumented` that the benchmark imports directly — duplicates behavior, adds metrics, lives only in tests/scripts.

## Phase B — three test conditions

Compare three variants of the write path:

1. **`A_full`** — full winfs:write (validation + atomic write + audit, current production behavior)
2. **`B_no_audit`** — validation + atomic write, audit pipeline stubbed (no-op appendAudit)
3. **`C_raw`** — validation + raw `fs.writeFile` (no atomic, no audit) — i.e. matches Filesystem MCP style

Same harness, same payload, same path, three different invocations.

This isolates contributions of audit (A vs B) and atomicity (B vs C).

## Phase C — payload size sweep

For each variant, run with payloads of size:

- 1 KB (small, config-like)
- 10 KB (prompt-sized — matches the observed hangs)
- 100 KB (large doc)
- 1 MB (edge case)
- 10 MB (stress; skip if takes >60s per iteration even at this point)

For each (variant × size) combination:
- 5 warmup iterations (discarded)
- 30 measured iterations
- Capture `t0..t7` per iteration
- Compute per-phase duration mean, p50, p95, p99

Use `process.hrtime.bigint()` for sub-millisecond resolution.

Output raw data to `audit/investigations/v0.8-audit-io-raw.csv`:
```
variant,size_bytes,iteration,phase,duration_ns
A_full,10240,0,t0_t1_validation,1500
A_full,10240,0,t1_t2_pre_write,3000
A_full,10240,0,t2_t3_write,12000
...
```

## Phase D — analysis

In `audit/investigations/v0.8-audit-io.md`:

### Section 1: Methodology
- Describe scaffold, three variants, payload sizes, iteration counts, what the t0..t7 phases mean.

### Section 2: Results
- Per-phase mean durations table (rows: phase; columns: payload size × variant)
- Where is time spent in each variant?
- At which payload size do the three variants diverge significantly?

### Section 3: Bottleneck localization
- Variance attributable to each component (audit, atomic-rename, write itself, validation)
- If `A_full - B_no_audit` is the bulk of latency at 10KB+ → audit is the bottleneck
- If `B_no_audit - C_raw` is the bulk → atomicity 2-syscall is the bottleneck
- If both are negligible and `winfs:write` *in benchmark* completes in <100ms even at 1MB → the observed 4-minute session hangs are NOT in impl; they're transport / environmental (matches bug #1 + #2 pattern)

### Section 4: Reproducer for the session hangs
- Attempt to reproduce the 4-minute hang in this benchmark using realistic payload sizes (10-15 KB, similar to my session prompts)
- If reproducible → impl issue, recommendation involves a fix
- If NOT reproducible → transport / Claude Desktop integration issue, recommendation closes source-code suspect line and points to MCP traffic-log investigation as next step

### Section 5: Recommendation
Exactly one of:
- **"No action"** — atomic write + audit perform within reasonable budget at all tested sizes; observed hangs are not impl
- **"Audit flush change X"** — specific batched-flush or async-flush proposal with expected reduction
- **"P5 (non-atomic opt-in) justified"** — atomic write overhead measurable beyond a useful threshold, opt-in non-atomic write would meaningfully help workloads above that threshold
- **"P5 not justified — root cause environmental"** — benchmarks show impl performs fine, hangs localize elsewhere; close P5 permanently; document need for MCP traffic-log investigation as separate work

If recommendation suggests a code change, output a follow-up prompt at `prompts/cc-prompt-<next>.md`. Do NOT apply the fix in this wave — investigation only.

## Phase E — commit

Single commit:
```
docs(investigation): v0.8 audit IO investigation report + raw data
```

Files:
- `audit/investigations/v0.8-audit-io.md` (report)
- `audit/investigations/v0.8-audit-io-raw.csv` (raw timings)
- `tests/perf/audit_io_investigation.bench.ts` (or wherever, the scaffold itself)

Push to origin/main.

## Constraints

- All work on `main`. No branches.
- No production code changes — only the instrumented parallel impl in tests/scripts.
- No version bump.
- Smoke must remain 66/66 green after this wave (we touched only test/benchmark scaffold).
- If a sub-condition produces no measurable difference at any tested size, report that as a useful finding (null result is data).
- If the benchmark itself hangs > 60s on any iteration, abort that iteration, mark as `INF`, and note in report — that's a more interesting finding than "slow but completed".

## Reporting

```
v0.8 audit-IO investigation done:
  scaffold @ <sha>
  report @ <sha>, raw csv @ <sha>
  main @ <sha>, pushed

  Bottleneck localization:
    audit contribution (A - B) at 10KB: <X ms mean, Y ms p95>
    atomicity contribution (B - C) at 10KB: <X ms mean, Y ms p95>
    same at 100KB, 1MB: <…>

  4-min session hang reproducer in benchmark: <reproduced | not reproduced>

  Recommendation: <one of the four listed in §5>

  Follow-up prompt: <prompts/cc-prompt-XXX.md | none>
```

On any failure: stop, report step, full output. Phase A scaffold pushed = safe checkpoint even if later phases incomplete.
