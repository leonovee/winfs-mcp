# CC prompt — v0.9.1 patch wave: flaky tests + remaining deferred P2 + pwsh cosmetic

## Origin

After v0.9.0 (P1 MCP Roots) shipped, the v0.7-pre-tag review wave's deferred backlog and the 10 Windows-flaky process tests are the remaining known unresolved items. This wave closes both.

**Tag at end: v0.9.1** (patch bump from v0.9.0).

Baseline state (verify before starting):
- `main @ a7bcfcd`
- Tests: 450 passing
- Smoke: 72/72 green
- 10 pre-existing Windows-flaky failures in `tests/unit/process/*` STILL excluded
- Backlog files: `backlog/v0.8-filesystem-mcp-parity.md`, consolidation files at `audit/external_reviews/v0.7-pre-tag/_findings_*.md`

## Phase 0 — re-triage open P2 findings (filesystem-parity wave + v0.9.0 may have closed some)

Some items from the v0.7-pre-tag review consolidation files may have been incidentally closed by:
- **filesystem-parity wave** (P2 annotations, P4.1 head/tail, P4.3 sort_by, P4.2 directory_tree, P4.4 read_media_file)
- **v0.8.0 cut** (CHANGELOG promotions)
- **v0.9.0** (RootsResolver, ToolContext extension)

Re-read each consolidation file at `audit/external_reviews/v0.7-pre-tag/_findings_*.md` and cross-check against current `main` source. For each previously-deferred P2:
- **Still open?** Add to Phase C fix list with current relevance.
- **Closed by intervening wave?** Mark in `audit/external_reviews/v0.7-pre-tag/_post-v0.9.0-status.md` with the SHA that closed it.
- **No longer applicable?** Mark superseded with rationale.

Output the triage as a single file before any fix commits. Commit:
```
chore(audit): re-triage v0.7-pre-tag deferred P2 against v0.9.0 main
```

Expected outcome: some items closed, some still open, some superseded. Phase C scope narrows accordingly.

## Phase A — flaky process tests stabilization

`tests/unit/process/*` has 10 Windows-flaky failures (EBUSY-on-rmdir during cleanup + timing-sensitive process-state assertions). Wave 2c's invariant #41 (settle-by-close-event) addressed the underlying race, but the tests themselves still use brittle assertions.

### A1. EBUSY-on-rmdir during cleanup

Windows holds directory handles after subprocess exits. `fs.rm({recursive: true})` immediately on cleanup hits EBUSY.

Fix: retry helper in `tests/_helpers/fs.ts`:
```typescript
async function rmdirWithRetry(path: string, attempts = 5, delayMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EBUSY" && e.code !== "ENOTEMPTY" && e.code !== "EPERM") throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}
```

Use in `afterEach`/`afterAll` of affected suites.

### A2. Timing-sensitive process-state assertions

Convert `setTimeout(..., 100)`-then-assert to event-driven. ProcessRegistry already drives settle via close-event (invariant #41). Expose `settled: Promise<SettleState>` on the session (if not already present from wave 2b/2c). Tests `await session.settled` instead of fixed timeouts.

### A3. Tight-loop validation

After A1+A2 applied, run process suite in tight loop:
```powershell
for ($i = 0; $i -lt 20; $i++) { npm test -- tests/unit/process }
```
Target 20/20 passes. Any test still flaky after 20-loop validation → leave skipped, document in `tests/unit/process/_known-flaky.md` with hypothesis + reproduction frequency.

Commits:
```
fix(tests): EBUSY-on-rmdir retry helper for process suite cleanup
fix(process): expose settle promise; tests use event-driven waits
```

## Phase B — pwsh.exe over powershell.exe (cosmetic)

In wherever execute_command resolves the PowerShell binary, prefer `pwsh.exe` (PS7) if present, fall back to `powershell.exe` (5.1). Configurable via `config.powershellExePath` (pattern from `sshExePath`).

Test: regression that resolver picks pwsh when present, powershell otherwise.

README §Configuration: document `powershellExePath` field.

Commit:
```
feat(exec): prefer pwsh.exe; configurable via powershellExePath
```

## Phase C — remaining deferred P2 findings, per surface

Apply Phase 0 triage results. For each STILL-OPEN P2, reference the consolidation file and CC's full original context.

Likely-still-open items (verify against Phase 0 output):

### C1. fetch_url P2.1 — truncated flag rewire
Split into named fields: `body_truncated_by_size` (hit `fetchUrlMaxBytes`) + `body_omitted_by_content_type`. Keep `truncated: boolean` as alias one release; deprecate.

### C2. fetch_url P2.3 — gzip/deflate/br
Preferred: transparent zlib decompression before byte-count. Safe minimum: new error `EENCODING_UNSUPPORTED` with `{encoding: "gzip"}`. CC's judgment.

### C3. fetch_url P2.5 — data handler settled guard
`if (settled) return;` at top of `res.on("data", ...)`.

### C4. fetch_url P2.6 — 3xx body early destroy
`res.destroy()` after reading status + Location.

### C5. fetch_url P2.7 — EMAXREDIRECTS new error code
New error code with details `{limit, attempted}`. Update spec registry. Changed in CHANGELOG (callers checking EHOSTNOTALLOWED on redirect limit break).

### C6. fetch_url P2.9 — trailing-dot FQDN (verify-first)
Write failing test that `example.com.` bypasses allowedUrlHosts containing `example.com`. If passes → mark invalid. If fails → strip trailing dot before allowedUrlHosts check.

### C7. execute_command P2.1-P2.8 — structural/docs/blocklist
Re-read consolidation. Apply judgment per item. Skip anything closed by intervening waves (Phase 0 confirms).

### C8. edit_file P2.2 — UTF-8 codepoint boundary in diff truncation
When truncating at byte offset, walk back to nearest UTF-8 codepoint boundary.

### C9. edit_file P2.3 — WeakMap fragility
If real under expected use, fix; if theoretical edge case, document and defer further.

### C10. edit_file P2.4 — TOCTOU on stat-then-read
Open fd at stat time, read via fd, coordinate write ordering. **Largest item** — if it expands beyond one-commit scope, stop and report; chat-Claude decides fold-or-punt to v0.9.2.

### C11. grep P2.1 — streaming pagination
Stop reading once `limit` matches collected from `offset`; return truthy `next_offset`. Bounded memory.

### C12. grep P2.2 + P2.4 + P2.9 — unified truncated semantics
Match C1 pattern: `truncated` boolean + reason-specific subfields across grep/edit_file/fetch_url.

### C13. grep P2.3 + P2.6 — CRLF / bare-`\r` docs
Document grep line-ending normalization in spec + README. No code change.

### C14. Final correctness pass
Run smoke + full tests; fix any red before tag.

Suggested commits (CC may fold per-surface):
```
fix(fetch_url): truncated flag rewire
fix(fetch_url): gzip/deflate/br Content-Encoding handling
fix(fetch_url): settled guard on data handler
fix(fetch_url): 3xx body early destroy
feat(fetch_url): EMAXREDIRECTS error code
fix(fetch_url): normalize trailing-dot FQDN  [if confirmed]
fix(execute_command): structural P2 sweep
fix(edit_file): UTF-8 codepoint boundary in diff truncation
fix(edit_file): WeakMap fragility hardening  [if real]
fix(edit_file): TOCTOU on stat-then-read
fix(grep): streaming pagination
fix(grep): unified truncated semantics
docs: grep line-ending normalization
```

## Phase D — CHANGELOG

`[Unreleased]` → `[0.9.1] — <date>`:

- `Added`: EMAXREDIRECTS error code; powershellExePath config; pwsh.exe auto-detection
- `Changed`: fetch_url truncated flag rewire (back-compat alias one release); grep streaming pagination; redirect-limit code now EMAXREDIRECTS not EHOSTNOTALLOWED
- `Fixed`: gzip silent corruption; data-handler late-chunk race; 3xx body bandwidth waste; trailing-dot FQDN bypass [if confirmed]; UTF-8 codepoint boundary; edit_file TOCTOU; 10 Windows-flaky process tests
- `Docs`: grep CRLF/bare-`\r` semantics

Commit:
```
docs: CHANGELOG [0.9.1] + spec entries
```

## Phase E — version bump + tag + push

```
npm version 0.9.1 --no-git-tag-version
```
Commit:
```
chore(release): bump 0.9.0 -> 0.9.1
```
```
git push origin main
git tag -a v0.9.1 -m "v0.9.1: patch wave — flaky tests stabilized + deferred P2 closed + pwsh"
git push origin v0.9.1
```

## Constraints

- All work on `main`. No branches, no force-push.
- Tests green at every commit boundary.
- Smoke must pass (72/72 + any new probes) before tag.
- Process suite must hit 20/20 in tight loop after A1+A2.
- If a P2 finding (esp. C10 TOCTOU) blows up beyond one-commit scope, stop and report — chat-Claude decides fold-or-punt to v0.9.2.
- pwsh.exe switch must not regress v0.7.2 hardening — all H2 flags work identically under both binaries.
- Previously-flaky tests not unskipped automatically — verify 20/20 in loop before unskipping; still-flaky → document and leave skipped.

## Reporting

```
v0.9.1 patch wave done:
  Phase 0 re-triage: <N> still-open, <M> closed by intervening waves, <K> superseded
  Phase A flaky: <X>/10 now stable in 20-loop; <Y> still skipped
  Phase B pwsh: <found at path | fallback>
  Phase C P2 fixes: <N commits>, <listing>
  Phase D docs+changelog: <sha>
  Phase E bump + tag: <sha> + v0.9.1 tag <tag-sha> -> <commit>, pushed
  main @ <sha>
  tests: <N> passing (was 450)
  smoke: <Y>/<Y> green
  process suite tight-loop: <X>/20 (target 20/20)
  re-triage results: audit/external_reviews/v0.7-pre-tag/_post-v0.9.0-status.md @ <sha>
```

On failure: stop, report step, full output. Phases 0/A/B/C/D pushed = safe checkpoint; tag not yet created.

## After v0.9.1 tag

Stop after v0.9.1 tag. The third item in Vladimir's planned sequence is a separate prompt:
- MCP traffic-log investigation (outside winfs source scope; operator/instrumentation work to localize the 4-min hangs)

Do NOT begin that in this wave.
