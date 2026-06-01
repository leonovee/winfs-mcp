# CC prompt — v0.7.3 patch wave: flaky tests + deferred P2 findings + pwsh cosmetic

## Origin

v0.7.2 shipped (8a88c53) + wave 2c (f6f74ab) + symptom-vs-source methodology note. Now closing the v0.7.x patch backlog accumulated in README §Known limitations:

1. **10 Windows-flaky process tests** in `tests/unit/process/*` — EBUSY-on-rmdir during cleanup + timing-sensitive process-state assertions.
2. **~15 deferred P2 review findings** from `audit/external_reviews/v0.7-pre-tag/_findings_*.md`.
3. **Cosmetic: pwsh.exe over powershell.exe** — prefer PowerShell 7 when available, fall back to 5.1.

Tag at end: **v0.7.3**.

## Phase 0 — empirical verification for ambiguous P2s

Before applying fixes that depend on assumed behaviour, write failing reproducer tests for any P2 where the consolidation file said "verify-first":

- **fetch_url P2.9 trailing-dot FQDN**: reviewer disagreement on whether `example.com.` (trailing dot) bypasses allowedUrlHosts. Write failing test; if it passes, mark invalid in `_invalidated_findings.md`.
- Any other "verify-first" P2 in the consolidation files.

Commit:
```
chore(tests): v0.7.3 patch wave — verify-first tests for ambiguous P2 findings
```

Report which tests failed (→ Phase C fix) vs passed (→ invalidated, dropped).

## Phase A — flaky process tests stabilization

`tests/unit/process/*` has 10 Windows-flaky failures. Two categories:

### A1. EBUSY-on-rmdir during cleanup

Windows holds dir handles after subprocess exits. `fs.rm({recursive: true})` immediately on cleanup hits EBUSY.

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

`setTimeout(..., 100)` then assert is brittle. Convert to event-driven: expose `settled: Promise<SettleState>` on the session (resolved when close-event handler completes per invariant #41). Tests `await session.settled` instead of fixed timeouts.

Tight-loop validate: `for ($i = 0; $i -lt 20; $i++) { npm test -- tests/unit/process }`. Target 20/20.

Commits:
```
fix(tests): EBUSY-on-rmdir retry helper for process suite cleanup
fix(process): expose settle promise; tests use event-driven waits
```

## Phase B — pwsh.exe over powershell.exe

In wherever execute_command resolves the PowerShell binary, prefer `pwsh.exe` (PS7) if present, fall back to `powershell.exe` (5.1). Configurable via `config.powershellExePath` (pattern from `sshExePath`).

Test: regression that resolver picks pwsh when present, powershell otherwise.

README §Configuration: document `powershellExePath` field.

Commit:
```
feat(exec): prefer pwsh.exe; configurable via powershellExePath
```

## Phase C — deferred P2 findings, per surface

Reference `audit/external_reviews/v0.7-pre-tag/_findings_*.md` for full context.

### C1. fetch_url P2.1 — truncated flag rewire

Split into named fields: `body_truncated_by_size` (hit `fetchUrlMaxBytes`) + `body_omitted_by_content_type` (filtered). Keep `truncated` as alias one release; deprecate.

### C2. fetch_url P2.3 — gzip/deflate/br

Preferred: transparent zlib decompression before byte-count. Safe minimum: new error `EENCODING_UNSUPPORTED` with `{encoding: "gzip"}`. CC's judgment.

### C3. fetch_url P2.5 — data handler settled guard

`if (settled) return;` at top of `res.on("data", ...)`.

### C4. fetch_url P2.6 — 3xx body early destroy

`res.destroy()` after reading status + Location.

### C5. fetch_url P2.7 — EMAXREDIRECTS

New error code with details `{limit, attempted}`. Update spec registry. Changed in CHANGELOG (callers checking EHOSTNOTALLOWED on redirect limit break).

### C6. fetch_url P2.9 — trailing-dot FQDN (if Phase 0 confirmed)

Strip trailing dot before allowedUrlHosts check.

### C7. execute_command P2.1-P2.8 — structural/docs/blocklist

Re-read consolidation. Apply judgment; skip items already addressed by wave 2c or v0.7.2 hardening (e.g. blocklist over-block in `7b7a41c`).

### C8. edit_file P2.2 — UTF-8 codepoint boundary in diff truncation

When truncating at byte offset, walk back to nearest UTF-8 codepoint boundary.

### C9. edit_file P2.3 — WeakMap fragility

If real under expected use, fix; if theoretical edge case, document and defer.

### C10. edit_file P2.4 — TOCTOU on stat-then-read

Open fd at stat time, read via fd, coordinate write ordering. Largest item — if it expands beyond one-commit, stop and report; chat-Claude decides fold-or-punt.

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

`[Unreleased]` → `[0.7.3] — <date>`:

- `Added`: EMAXREDIRECTS error code; powershellExePath config; pwsh.exe auto-detection
- `Changed`: fetch_url truncated flag rewire (back-compat alias one release); grep streaming pagination; redirect-limit code now EMAXREDIRECTS not EHOSTNOTALLOWED
- `Fixed`: gzip silent corruption; data-handler late-chunk race; 3xx body bandwidth waste; trailing-dot FQDN bypass [if confirmed]; UTF-8 codepoint boundary; edit_file TOCTOU; 10 Windows-flaky process tests
- `Docs`: grep CRLF/bare-`\r` semantics

Commit:
```
docs: CHANGELOG [0.7.3] + spec entries
```

## Phase E — version bump + tag + push

```
npm version 0.7.3 --no-git-tag-version
```
Commit:
```
chore(release): bump 0.7.2 -> 0.7.3
```
```
git push origin main
git tag -a v0.7.3 -m "v0.7.3: patch wave — flaky tests + deferred P2 findings + pwsh"
git push origin v0.7.3
```

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary.
- Smoke must pass (57/57 + any new probes) before tag.
- Process suite must hit 20/20 in tight loop after A1+A2.
- If a P2 finding (esp. C10 TOCTOU) blows up beyond one-commit scope, stop and report.
- pwsh.exe switch must not regress v0.7.2 hardening — all H2 flags work identically under both binaries.
- Previously-flaky tests not unskipped automatically — verify 20/20 in loop before unskipping; still-flaky → document and leave skipped.

## Reporting

```
v0.7.3 patch wave done:
  Phase 0 verify: <N> written, <M> invalidated, <K> confirmed
  Phase A flaky: <N now stable>, <M still skipped>
  Phase B pwsh: <found at path | fallback>
  Phase C P2 fixes: <N commits>, <listing>
  Phase D docs+changelog: <sha>
  Phase E bump + tag: <sha> + v0.7.3 tag <tag-sha> -> <commit>, pushed
  main @ <sha>
  tests: <N> passing (was 408)
  smoke: <Y>/<Y> green
  process suite tight-loop: <X>/20 (target 20/20)
  invalidated findings: <list>
```

On failure: stop, report step, full output. Phases 0/A/B/C/D pushed = safe checkpoint; tag not yet created.
