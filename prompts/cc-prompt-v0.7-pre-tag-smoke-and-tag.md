# CC prompt — v0.7 pre-tag smoke + v0.7.0 release tag

## Origin

We're at `main @ 4fe0184`, 416 tests passing (was 372; +44 from bugfix wave). All P1 findings from review wave addressed or invalidated. Bug #1 disproven — winfs impl is clean, the 4-min hangs are MCP transport (independent, documented in CLAUDE.md). One known limitation: 10 Windows-flaky tests in `tests/unit/process/*` (wave 2b inherited; document, defer to v0.7.1 patch wave).

This wave: CLI smoke harness on the v0.7 surface, documentation polish, version bump 0.6.0 → 0.7.0, annotated tag, push.

Inspector-driven smoke (Path A in v0.6 methodology) is **not required** for this wave — operator can run an ad-hoc Inspector pass after tag if desired. Path B (CLI harness) gives reproducible coverage and is what the tag rests on.

## Phase A — CLAUDE.md path fix

CC flagged this in the reviewer-wave reporting: `CLAUDE.md` still says `C:\Users\Expert\Desktop\AI\tools\winfs\` for the project root. That's the old machine.

Edit `CLAUDE.md`. Find every absolute path with `Expert` username and replace with `User`. Common locations:
- Project root mentions
- `%LOCALAPPDATA%` paths if any are absolute
- Any example commands

Also do a sweep for any other stale references that accumulated during sessions: paths in commit-history references, paths in operational notes.

Single commit:

```
docs(claude.md): refresh paths for current machine; sweep stale refs
```

## Phase B — v0.7 smoke harness

Create `scripts/smoke/v0.7-smoke.mjs`. Model on the existing `scripts/smoke/v0.6-smoke.mjs` (read it first to match the harness style — runner, probe registration, assertion format, strict/unrestricted pass loop). Adopt the same exit-code semantics and per-probe report layout.

### Coverage required

**Wave 1 surfaces (3 new tools):**
- `ssh_exec`: probe `EHOST_UNKNOWN` for unconfigured host; `ESSHNOTFOUND` if `sshExePath` fakerouted to nonexistent (set via env override or registry mock); skip happy-path if no real ssh host in config (probe reports `skipped: "no ssh host configured"` rather than fail).
- `list_path_dirs`: happy-path returns non-empty array; consistency invariant — result matches `find_command`'s effective PATH.
- `write_json`: happy create; happy overwrite=true replaces; `EEXT_NOT_JSON` on .txt path; `EEXIST` on overwrite=false existing; round-trip with `read_json` returns equal value.

**Wave 2a surface changes (3 changed tools):**
- `edit_file with_diff`: default false (no `diff` field); `with_diff=true` returns unified diff; truncation flag works on forced large diff.
- `grep` pagination: default returns same matches as pre-wave plus `total_matches`; explicit offset/limit returns correct slice; offset past end returns empty + no next_offset; ceiling cap sets `total_matches_capped`.
- `execute_command` hints: stderr containing document-in-pipeline marker → response has `hints` array with expected text; without marker → empty/absent.

**Wave 2b stateful subsystem (4 new tools + registry behaviors):**
- `start_process` happy: spawn quick `node -e "console.log('hi'); process.exit(0)"`, returns session_id, eventually settles exited 0 with stdout 'hi'.
- `start_process` validation: cwd outside allowedRoots → EPERM_ROOT; bogus binary → spawn_failed.
- `list_process`: returns started session; after settle, includes exit_code + settled_at.
- `interact`: echo case — input='hi\n' to stdin-reading process returns 'saw: hi'; long-poll deadline (max_wait_ms=200, silent process) resolves at ~200ms; ENOSESSION for unknown id.
- `kill_process`: kill running → killed=true, status='killed'; idempotent (second kill = was_already_settled=true).
- Concurrency cap: spawn 16 → 17th returns EBUSY.

**v0.7 bug-fix wave regressions (verify all P1 fixes stay closed):**
- `fetch_url` HTTPS→HTTP downgrade: mock 302 from `https://` to `http://` → EHOSTNOTALLOWED with details.reason="protocol_downgrade".
- `fetch_url` isInternalIP: assert fe90::1, fea0::1, febc::1, ::ffff:c0a8:0101 all classified internal.
- `fetch_url` AbortSignal listener: confirm `removeEventListener` called on safeResolve (test via listener count before/after).
- `fetch_url` trim allowedUrlHosts: config entry with trailing space accepts requests to corresponding host.
- `fetch_url` rejectUnauthorized: explicit true in httpsOpts (assert via inspecting the options object passed).
- `fetch_url` final_url redaction: response final_url has query string redacted (matches audit-log redaction).
- `exec_safety` blocklist: `["powershell", "-EncodedCommand", "<base64>"]` → EBLOCKED; `["rm", "-r", "C:\\foo"]` → EBLOCKED.
- `exec_safety` aborted flag: aborted execution surfaces `aborted: true` in result.
- `exec_hints` document-in-pipeline: hint text matches the new wording (no "try cmd" advice).
- `edit_file` AbortSignal: forwarded through to fs.stat / fs.readFile / atomicWriteFile (test via signal abort during slow write, assert no orphan .tmp).
- `edit_file` EUNIQUE hint: i=0 with occ=0 gives the absence-hint (not the "earlier edit removed it" hint).
- `grep` deadline race: timeout_ms=maxTimeoutMs gives partial-result path (not ETIMEDOUT).
- `grep` negative context_lines: impl-level guard rejects.
- `grep` lastIndex reset: defensive reset works.
- `grep` compileGlob: absolute non-empty base assertion fires on bare wildcards.

### Strict + unrestricted passes

Same structure as v0.6: each probe runs in both modes. Mutation tools should carry `mode` in audit; read-only should not.

### Output

End-of-run:

```
v0.7 smoke: <Y>/<Y> probes green (strict <X>/<X>, unrestricted <X>/<X>)
skipped: <N> (ssh_exec happy-path if no host)
duration: <ms>
```

Non-zero exit on any red.

Commit:

```
chore(smoke): v0.7 wire-level smoke harness under scripts/smoke/
```

## Phase C — run smoke locally

```
node scripts/smoke/v0.7-smoke.mjs
```

Expected: all probes green except documented skips (ssh_exec happy-path if no host). If anything red, **stop and report which probe + raw output**. Do not proceed to tag with red smoke.

## Phase D — README + CHANGELOG known limitations

### README

Add to existing `## Known limitations` section (already created in v0.7-tails wave) two new subsections:

**Windows-flaky process tests.** Brief paragraph: 10 tests in `tests/unit/process/*` exhibit intermittent failures on Windows due to EBUSY-on-rmdir during cleanup and timing-sensitive process-state assertions. Production code is correct (verified by smoke harness); test flakiness is a Windows reliability issue scheduled for v0.7.1 patch (EBUSY retry with backoff; event-driven assertions). Workaround for CI: rerun the affected suite.

**Deferred review-wave findings.** Brief paragraph: ~15 P2 findings from the v0.7 pre-tag external review are deferred to v0.7.1 (consolidation files in `audit/external_reviews/v0.7-pre-tag/`). Highlights: fetch_url truncated-flag rewire, fetch_url gzip Content-Encoding check, fetch_url EMAXREDIRECTS code, edit_file UTF-8 boundary in diff truncation, edit_file TOCTOU fd-bound read side, grep stream pagination memory, grep unified truncated semantics. None are production-blocking; all are quality-of-implementation hardening.

### CHANGELOG

Move `[Unreleased]` content to a new `[0.7.0] — 2026-05-22` section (use actual tag date when committing). Keep the existing `[Unreleased]` heading empty for v0.7.1 work.

Group `[0.7.0]` entries under standard headings: `Added` (new tools from wave 1, ProcessRegistry from wave 2b, with_diff/pagination/hints from wave 2a), `Fixed` (all bugfix-wave items), `Changed` (any signature changes — atomicWriteFile signal threading is the only one that comes to mind), `Docs` (config-location, MCP-hang note, sshExePath override).

Single commit:

```
docs: v0.7.0 known limitations + CHANGELOG promote [Unreleased] to [0.7.0]
```

## Phase E — version bump + tag + push

### E1. Bump

```
npm version 0.7.0 --no-git-tag-version
```

(Use `--no-git-tag-version` because we want to control the tag commit explicitly.) Commit:

```
chore(release): bump 0.6.0 -> 0.7.0
```

### E2. Push commits first

```
git push origin main
```

Verify pushed successfully before tagging.

### E3. Tag

Annotated tag with message:

```
git tag -a v0.7.0 -m "v0.7.0: DC-parity wave

Highlights:
- ssh_exec, list_path_dirs, write_json (wave 1)
- edit_file with_diff, grep pagination, execute_command hints (wave 2a)
- Process control suite: start_process, interact, list_process, kill_process + ProcessRegistry (wave 2b)
- Pre-tag bug-fix wave: 4 P1 SSRF/blocklist hardenings + AbortSignal cleanup discipline + 5 single-source findings empirically validated"
```

(Adjust wording if it reads off; keep the highlights factual.)

### E4. Push tag

```
git push origin v0.7.0
```

### E5. Verify

```
git rev-parse v0.7.0
git ls-remote --tags origin v0.7.0
```

Both should return the same commit.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary.
- Smoke must pass before tag commits land. If smoke red, stop, do not version-bump.
- No `npm audit fix --force` — the audit-noise items are out of scope.
- If CHANGELOG promotion conflicts with existing structure, match what's there over what this prompt prescribes.
- Tag is annotated (`-a`), not lightweight. Tag message multi-line is fine.

## Reporting

End of wave (single block):

```
v0.7.0 SHIPPED
  main @ <commit-sha>, pushed (4fe0184..<sha>)
  tag v0.7.0 -> tag-object <sha> -> commit <sha>, pushed
  commits in this wave: <N>

tests: <N> passing (was 416)
smoke: <Y>/<Y> probes green (strict <X>/<X>, unrestricted <X>/<X>); skipped: <listing>

diff v0.6.0..v0.7.0:
  <git diff --stat v0.6.0 v0.7.0 summary>

known limitations documented:
  Windows-flaky process tests (10 tests, v0.7.1 patch scope)
  Deferred P2 review findings (15 items, v0.7.1 patch scope)

claude.md paths: refreshed (Expert -> User), <N> path references updated
```

On failure: stop at the failing step, report which step + step number, full stdout/stderr. Phases A through C are pushed at that point as safe checkpoint; tag is not yet created so we have not committed to release.
