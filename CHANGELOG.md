# Changelog

All notable changes to mcp-winfs are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

(Future patch wave: Windows-flaky process tests, deferred P2 review-wave
findings, P1 MCP Roots protocol support, P3 audit-IO investigation.
See README §"Known limitations" and `backlog/v0.8-filesystem-mcp-parity.md`.)

## [0.8.0] — 2026-05-22 — filesystem-MCP parity + ToolContext refactor

First minor bump since v0.7.0. Bundles wave 2c (architectural closure —
ToolContext refactor + invariant #41 + methodology notes) with the v0.8
filesystem-MCP parity sweep (P2 annotation fix + P4 small parity items).
Tool surface 37 → 39. No user-facing tool surface change is breaking;
the internal `register*Tool` signature change is a one-time refactor
flagged in the migration note below.

### Added — new tools (2)

- **`directory_tree`** — recursive JSON tree of a directory:
  `{ root: { name, type: 'directory' | 'file', children?: TreeNode[] },
  total_nodes, truncated, truncated_reason? }`. Companion to flat-array
  `list`; use this when reasoning about project layout in one
  round-trip. Args: `path`, `max_depth` (1..8, default 3),
  `exclude_patterns` (optional basename globs — `'node_modules'`,
  `'.git'`, `'dist'`, `'*.tmp'`). Truncates with
  `truncated_reason: 'max_depth'` or `'max_nodes'` (10 000 hard cap).
  Symlinks walked as files (not followed) to avoid escape paths.

- **`read_media_file`** — base64 reader for binary files (image, audio,
  video, PDF). Companion to text-only `read` (which rejects binary with
  EENCODING). Streams in 64 KB chunks via `createReadStream` to avoid
  OOM on large media. Returns
  `{ base64, content_type, bytes_read, truncated }` where
  `content_type` is best-effort from the file extension (image/png,
  image/jpeg, image/webp, application/pdf, audio/mpeg, video/mp4, …;
  unknown → application/octet-stream). Default 16 MB cap; omitting
  `max_bytes` on an oversize file → ETOOLARGE (caller hasn't opted in
  to truncation).

### Changed — existing tools

- **`read`** — new `head: N` and `tail: N` convenience params. Compose
  internally to the existing range path (head → `[1, N]`; tail →
  `[max(1, total-N+1), total]`). Mutually exclusive with each other and
  with `range`; passing two → EINVAL with discriminating
  `details.{has_range, has_head, has_tail}`. ETOOLARGE hint extended.

- **`list`** — new `sort_by: 'name' | 'size' | 'mtime'` param. `'name'`
  alphabetical (case-insensitive `localeCompare`); `'size'` descending
  (largest first — storage-cleanup ergonomics); `'mtime'` descending
  (newest first — recent-activity ergonomics). Omitted → directory-walk
  order (the prior contract is unchanged for callers that don't pass
  sort_by).

- **`copy`** annotation: `destructiveHint: false → true`. Matches
  `move`'s semantics — copy with `overwrite: true` may overwrite the
  destination, so the conservative MCP annotation is destructive. The
  other 36 register*Tool annotations were spot-checked and found
  correct as-is.

### Changed — internal API (wave 2c refactor)

- **`register*Tool` signature.** All 37 (now 39) tool registrations
  take `(server, ctx: ToolContext)` instead of positional
  `(server, config[, registry])`. Future stateful subsystems
  (FileWatchRegistry, JobQueue, persistent shell, etc.) add a field
  to the `ToolContext` interface instead of a positional parameter
  to every register call site.

- **`createServer` return shape.** Was `{ server, registry }`; now
  `{ server, ctx }` with `ctx.registry` and `ctx.config`. `src/index.ts`
  reaches the registry via `ctx.registry.shutdown()` in its
  SIGINT/SIGTERM handler.

Migration note for downstream consumers of the public exports:

```ts
// before
const { server, registry } = createServer(config);
registerReadTool(server, config);
registerStartProcessTool(server, config, registry);

// after
const { server, ctx } = createServer(config);
registerReadTool(server, ctx);
registerStartProcessTool(server, ctx);
```

Build a custom context in tests via `createToolContext({ config, registry })`
from `src/core/tool_context.js`. No user-facing tool surface change.

### Docs

- **Spec invariant #41 — stateful sessions settle by close-event only.**
  Generalises wave 2b's invariant #38 (ProcessRegistry-specific) to
  every future stateful subsystem. The same close-event-driven settle
  pattern (intent-to-terminate sets a flag; close event drives the
  actual state transition) becomes the reference for any future file
  watcher / network connection / persistent shell / job queue. Spec
  amendment §AB.1.
- **Spec amendment §AB.2 — ToolContext interface and extension rule.**
  Documents the new internal API + the four-step procedure for adding
  a new stateful subsystem (add field → construct in createServer →
  destructure in tools that need it → apply invariant #41).
- **Spec amendment §AB.3 — back-reference to the methodology note in
  CLAUDE.md** for blocklist-fix verify-then-smoke.
- **CLAUDE.md** — new "Blocklist-pattern fixes from external review
  require verify-then-smoke" subsection under Операционные заметки.
  Documents the two-sided risk (under-block + over-block) and the
  pre-fix verify / post-fix smoke procedure that catches both.
  Reference incident: the v0.7 pre-tag `-EncodedCommand` over-block
  caught by smoke + fixed via positive-lookahead context anchor.

### Tests + smoke

- 408 → 433 passing (+25 across 4 new test files; excluding the 10
  pre-existing Windows-flaky `tests/unit/process/*` tests carried
  from v0.7.x):
  - `tests/unit/fs/read_head_tail.test.ts` (+7): head, tail,
    overshoot, head+tail mutex, head+range mutex, tail+range mutex,
    all-three mutex.
  - `tests/unit/fs/list_sort_by.test.ts` (+4): sort_by name / size /
    mtime + omit-preserves-walk-order sentinel.
  - `tests/unit/fs/directory_tree.test.ts` (+7): happy, nested,
    exclude_patterns basename, exclude_patterns glob, max_depth=1
    truncates with `truncated_reason: 'max_depth'`, EPERM_ROOT outside
    roots, ENOTDIR on file path.
  - `tests/unit/file/read_media_file.test.ts` (+7): PNG round-trip,
    content-type mapping (8 extensions), unknown extension → octet-
    stream, ETOOLARGE without max_bytes, max_bytes truncate contract
    (`truncated: true` + exact bytes_read), EPERM_ROOT, EISDIR.
- Wave 2c refactor contributed 0 new tests (mechanical signature
  change; tests call `*Impl` directly, not the register functions).

- Smoke 57 → 66 probes (+9 in new probesV08 section): read head/tail +
  mutex, list sort_by:'size', directory_tree happy + exclude_patterns,
  read_media_file base64+content_type + max_bytes truncate + EISDIR.
  All green on first run.

### Out-of-scope (per backlog `backlog/v0.8-filesystem-mcp-parity.md`)

- **P1 — MCP Roots protocol support.** Largest item; per backlog "should
  be its own wave — don't bundle". Stays in the backlog for a future
  wave.
- **P3 — Audit log IO investigation.** Investigation rather than a fix;
  output would be a report at `audit/investigations/` plus a follow-up
  prompt if action warranted. Stays in backlog.

## [0.7.2] — 2026-05-22 — PowerShell wrapper hardening (H2 from v0.7.1 prompt)

Followup to v0.7.1's bug #2 investigation. v0.7.1 confirmed the
reported symptoms do not reproduce in winfs source code; this release
applies the H2 hardening suggestions from the original hotfix prompt
as defense-in-depth against the suspected environmental causes
(CLIXML leakage on stdout, stdin-deadlock waiting for input, OEM
code page corrupting non-ASCII output, `$LASTEXITCODE` hidden behind
the PowerShell wrapper).

### Changed — execute_command PowerShell wrapper

`src/tools/exec/execute_command.ts` invokes PowerShell with two new
flags and a wrapped composed command:

  Flags:
  - `-OutputFormat Text` — pins plain-text stdout; defends against
    any CLIXML serialization leakage in `-Command` contexts.
  - `-InputFormat None` — PowerShell does not try to read stdin even
    if a child requests input. Closes the "pipe-capture hangs
    PowerShell waiting on stdin" pattern even though stdio[0] is
    already `"ignore"`.

  Composed command:
  - Prefix `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `
    — forces UTF-8 on stdout. The system OEM code page (1252, 437,
    850, 1251 on common Windows installs) would otherwise corrupt
    non-ASCII output and surface as EENCODING in our strict UTF-8
    decoder.
  - Suffix `; exit $LASTEXITCODE` — propagates the last external
    command's exit code through the PowerShell wrapper. Defensive
    against future composed-command shapes where multiple statements
    run.

### Added — regression tests (+6)

`tests/unit/exec/powershell_wrapper_hardening.test.ts` pins the new
wrapper contracts:

- UTF-8 output: `Write-Output 'привет мир ✓'` captured intact
- `exit 7` still preserves exit code 7 (suffix doesn't run after exit)
- `node -e "process.exit(42)"` surfaces exit code 42 through the
  wrapper
- `Get-Date` (cmdlet) still exits 0 with the suffix
- Multi-statement `node --version; Get-Date` exits 0 with combined
  stdout
- No stdin-deadlock: `& 'node' -e ...` completes in <3s

All 42 pre-existing exec tests pass without modification.

### Tests + smoke

- 402 → 408 passing (+6 hardening regression tests; excluding the 10
  pre-existing Windows-flaky `tests/unit/process/*` tests still on
  the future-patch list)
- Smoke 57/57 green — both v0.7.1 stdout-capture probes still pass
  through the hardened wrapper (`v24.15.0`, `git version 2.54.0…`)

### Not changed — source-code defect status

The H2 hardening is defensive; bug #2's reported symptoms still do
not reproduce in winfs source code per the v0.7.1 investigation. If
chat-Claude's environment still exhibits empty stdout / 4-min hangs /
CommandNotFoundException after upgrading to v0.7.2, the root cause is
external to winfs server code (MCP transport, different winfs
instance, PowerShell version mismatch) and would need traffic-log
evidence from the failing call to localise further.

## [0.7.1] — 2026-05-22 — bug #2 investigation + defensive coverage

The v0.7.1 hotfix prompt opened on a P0 report from chat-Claude: that
`execute_command` returns empty stdout for external .exe invocations
(the "bug #2" operational note carried in CLAUDE.md across v0.5.1 →
v0.6 → v0.7 without a fix for five waves).

**Investigation outcome: the bug DOES NOT REPRODUCE at either the
in-process server layer or the wire-level JSON-RPC layer on the
current machine + Node v24 + PowerShell + winfs build.** Same pattern
as bug #1 from the pre-tag bug-fix wave: the reported symptom is
environmental to chat-Claude's MCP transport / winfs instance, not a
defect in winfs source code.

### Added — defensive regression coverage

- **`tests/unit/exec/stdout_capture.regression.test.ts`** (+4 tests,
  398 → 402):
  - A1.1: `execute_command` + `node --version` captures stdout
    matching `/^v\d+\.\d+\.\d+/`
  - A1.2: `execute_command` + `& 'C:\Program Files\Git\cmd\git.exe'
    --version` captures stdout matching `/^git version /` (the exact
    historical-note form)
  - A1.3: `execute_command` + `Get-Date` (PowerShell cmdlet) captures
    non-empty stdout
  - A2: `start_process` + `node --version` (cross-pipeline comparison
    — both spawn pipelines correctly handle stdout)
- **Two new wire-level smoke probes** in `scripts/smoke/v0.7-smoke.mjs`
  (55 → 57 probes; `bugfix v0.7.1: execute_command stdout capture for
  node --version` + `… for direct git path`). Both green on first run.

### Changed — docs

- **CLAUDE.md** — "bug #2" operational note rewritten to past-tense.
  Notes that v0.7.1 investigated the symptom and could not reproduce
  it at the server layer; the file-based workaround
  (`Start-Process -RedirectStandardOutput`) is retained as a fallback
  for any future transport-side recurrence.

### Not changed — no source code fix

Since the bug does not reproduce in source code, no `src/` change ships
in v0.7.1. The defensive coverage (tests + smoke probes) ensures any
future change that DOES break the stdout-capture contract surfaces
immediately at the suite or the smoke wall. The historical operational
workaround is retained as defensive guidance for operator-side issues.

### Tests + smoke

- 398 → 402 passing (+4 reproducer tests; excluding the 10
  pre-existing Windows-flaky `tests/unit/process/*` tests carried over
  from v0.7.0)
- Smoke 55/57 → 57/57 green (+2 stdout-capture probes)



## [0.7.0] — 2026-05-22 — DC-parity wave

Net surface delta vs v0.6: 30 → 37 tools (+7). Three sub-waves landed
in sequence — wave 1 (consumer-agent adds), wave 2a (existing-tool
improvements), wave 2b (process control suite) — followed by a tails
sweep, a pre-tag external review wave, a pre-tag bug-fix wave, and a
wire-level smoke harness. The version bumps from 0.6.0 → 0.7.0 with
no shipped breaking change for callers of the v0.6 surface (the
internal `SpawnSubprocessResult.aborted` field addition is internal
to `exec_safety`; the v0.7 wave 2a `replacements_made` and
`edit_file` EUNIQUE detail renames already shipped in v0.6).

### Smoke + tag-prep changes (this wave)

- **New `scripts/smoke/v0.7-smoke.mjs`** — 55-probe wire-level harness
  covering wave 1, wave 2a, wave 2b, and pre-tag bug-fix regressions.
  Strict + unrestricted passes. Non-zero exit on any red. 3 documented
  skips (ssh_exec happy path needs a real host; concurrency cap
  pinned by unit test; HTTPS→HTTP downgrade needs a controlled
  HTTPS server).
- **Fixed `exec_safety` `-EncodedCommand` over-block** — followup to
  the v0.7 pre-tag P1.1 fix. The original blocklist pattern matched
  any `-e|-en|-enc|…` flag regardless of context, which over-blocked
  legitimate `node -e "..."` / `python -e ...` / `perl -e '...'`
  invocations. New pattern uses a positive lookahead requiring
  `powershell` or `pwsh` to appear in the composed string before
  matching the flag. Surfaced by the smoke harness on first run
  (start_process probes use `node -e` extensively). +3 over-block
  regression tests.

## [0.7.0 wave: pre-tag bug-fix] — v0.7 pre-tag bug-fix wave

Bug fixes and defense-in-depth hardening from the v0.7 pre-tag external
review wave (artifacts at `audit/external_reviews/v0.7-pre-tag/`). 13
fix commits + 1 invariant-test commit + 1 atomicWriteFile precursor.
No version bump — `[Unreleased]` continues.

### Bug #1 investigation outcome

The reported "EPERM_ROOT then 4-minute hang" did NOT localize to winfs
server code. In-process regression tests at
`tests/unit/exec/bug1_eperm_root_hang.test.ts` confirm subsequent tool
calls return within ~10-500 ms after an EPERM_ROOT error. The hang is
in the MCP transport layer between Claude Desktop and the winfs server
— same pattern as the existing CLAUDE.md operational note. Tests stay
in the suite as regression cover for the in-process invariant.

### Fixed — fetch_url

- **P1.1 — HTTPS→HTTP redirect downgrade blocked.** 3/3 reviewer
  convergence. New exported helper `isProtocolDowngrade(from, to)`;
  redirect loop hits `EHOSTNOTALLOWED` with `details.reason:
  "protocol_downgrade"` when the next hop would step from https: to
  http:. Reuses existing error code; no spec contract break.
- **P1.2 — explicit `rejectUnauthorized: true` on HTTPS options.**
  Defense-in-depth: Node's default is `true`, but pinning it explicitly
  prevents a runtime override (test setup, dependency side-effect,
  https.globalAgent reassignment) from silently disabling cert
  validation.
- **P1.3 — `isInternalIP` recognises full fe80::/10 range.**
  Pre-fix `lower.startsWith("fe80")` only caught addresses literally
  starting `fe80`; fe90::, fea0::, febc::, febf:: were classified as
  external. Fix: bitmask the first 16-bit word: `(firstWord & 0xffc0)
  === 0xfe80`.
- **P1.4 — `isInternalIP` recognises IPv4-mapped IPv6 hex-colon
  form.** Pre-fix `::ffff:c0a8:0101` (= ::ffff:192.168.1.1) was
  classified as external because the inner string `c0a8:0101` failed
  `net.isIPv4`. Fix: when the inner is not dotted-decimal, parse as
  two hex groups and convert to dotted-decimal, then recurse.
- **P2.2 — AbortSignal listener removed on `safeResolve`.**
  3/3 reviewer convergence. Long-lived signals reused across many
  requests no longer accumulate one listener per call.
- **P2.4 — `final_url` query string redacted in response.** Audit log
  already redacted via `redactUrlForAudit`; the user-visible
  response now applies the same redaction. Tokens/keys passed in
  URL query strings no longer leak through the tool's return value.
- **P2.8 — `allowedUrlHosts` entries trimmed before lookup.**
  3/3 convergence. Operator misconfiguration (leading/trailing
  whitespace) no longer silently rejects all requests to the host.

### Fixed — exec_safety / execute_command / exec_hints

- **P1.1 — `-EncodedCommand` blocklist bypass closed.** Pre-fix
  `powershell -EncodedCommand <b64>` smuggled base64-encoded payloads
  past every literal-pattern blocklist entry. New explicit-alternation
  pattern catches every PowerShell-accepted prefix from `-e` through
  `-encodedcommand`. Phase 0 verify-first test confirmed bypass.
- **P1.2 — `rm` short-flag blocklist bypass closed.** Pre-fix
  `rm -r C:\foo`, `rm -R`, and `rm -Recurse C:\foo` all passed
  (pattern required combined `-rf`). Two new patterns added:
  `rm\s.*-[rR]\b` and `rm\s.*-Recurse\b`. Phase 0 verify-first test
  confirmed bypass.
- **execute_command P1.3 — `aborted: boolean` field + pid-undefined
  race.** SpawnSubprocessResult gains `aborted: boolean` so callers
  can distinguish caller-initiated cancellation from a clean
  no-output exit (both previously surfaced exit_code: null). Narrow
  pid-undefined race fixed via a latch + `child.on("spawn")` handler.
- **exec_hints P2.6 — document-in-pipeline hint rewritten.** The
  prior "try cmd" advice was inapplicable from inside the tool
  (execute_command runs PowerShell only). New hint surfaces three
  in-this-tool workable paths: direct binary call, Start-Process
  wrapper, or `ssh_exec` for ssh specifically.

### Fixed — edit_file

- **P1.1 — `AbortSignal` forwarded through editFileImpl.** Pre-fix
  the signal passed by `runTool` was silently dropped; `fs.readFile`
  and `atomicWriteFile` ran uninterruptibly past the wall-clock
  deadline. Now threaded through. Depends on the Phase 1
  atomicWriteFile signal-acceptance precursor.
- **P2.1 — `EUNIQUE` absence hint conditional on `i > 0`.** Pre-fix
  the hint always said "An earlier edit may have removed the target."
  For `edit[0]` this is misleading — no prior edit ran. Hint now
  conditional; first-edit absence suggests checking spelling/whitespace.

### Fixed — grep

- **P1.1 — inner-deadline race when `timeout_ms == config.maxTimeoutMs`
  resolved.** Pre-fix `outerDeadline = min(innerDeadline + buffer,
  maxTimeoutMs)` collapsed both deadlines to the same instant when
  the caller requested maxTimeoutMs. Now: outer = requested; inner
  = max(1, outer - buffer). Inner always fires ≥ buffer before outer.
- **P1.3 — defense-in-depth guard for negative `context_lines`.**
  Zod rejects at the registered-tool boundary; direct grepImpl
  callers (unit tests, future internal tools) now hit EINVAL too.
- **P2.5 — defensive `re.lastIndex = 0` reset.** No-op today; future-
  proofs against a `g`/`y` flag pass-through change that would
  silently cause false negatives.
- **P2.8 — defensive `compileGlob.base` absolute non-empty assert.**
  Second layer behind compileGlob's existing "pattern must be
  absolute" throw; catches any future compileGlob change that
  returns an empty/relative base instead of throwing.

### Infrastructure

- **`atomicWriteFile` and `atomicAppend` accept optional `AbortSignal`.**
  Threaded through `fs.open` / `handle.writeFile` / `fs.readFile`
  options. Three abort points handled: pre-aborted (no temp file
  created), abort during writeFile/sync (best-effort temp cleanup),
  abort between close and rename (observed via signal.aborted check
  before rename, unlinks temp). Optional / default undefined; every
  existing caller preserved.
- **`SpawnSubprocessResult.aborted: boolean`** added (non-optional).
  All existing producers updated to set `aborted: false`.
- **New exported helpers** for verify-first testing and reuse:
  `fetch_url.ts` — `isInternalIP`, `redactUrlForAudit`,
  `isProtocolDowngrade`. Pure functions, no API surface change for
  the registered tool.

### Invalidated findings

- **grep P1.2 + P2.7 (ReDoS within line).** V8 returned within ~10 ms
  on the canonical bait pattern `(a+)+$` against a 10 KB 'a' line —
  well within deadline. V8 has hardened common ReDoS bait at the
  regex-compiler level on this Node version. No `LINE_SCAN_CAP`
  introduced; the verify-first test stays as a pin (any future
  regression re-opens the discussion). Details:
  `audit/external_reviews/v0.7-pre-tag/_invalidated_findings.md`.

### Tests

- 372 → 416 passing in this wave's commits (+44 new). Pre-existing
  10 Windows-flaky tests in `tests/unit/process/*` excluded from
  this wave per the prompt; reproduce on `da1eb2a` baseline and are
  unrelated.

### Spec amendment §AA

`docs/design/mcp-winfs-spec.md` gains a §AA "v0.7 pre-tag bug-fix
wave" entry documenting the new fetch_url redirect downgrade
contract, the SpawnSubprocessResult `aborted` field, and the
atomicWriteFile signal contract. No new error codes were added —
EHOSTNOTALLOWED is reused for redirect downgrade with
`details.reason: "protocol_downgrade"` for caller discrimination.

## [0.7.0 wave: tails] — v0.7 tails (docs + cleanup)

Pre-review-wave sweep. Five small items that accumulated across waves
1 / 2a / 2b. No new tools, no version bump, no behaviour change for
existing happy paths.

### Changed — docs

- **CLAUDE.md** — new "Операционные заметки" subsection documenting the
  MCP-transport occasional-hang pattern (2–3 four-minute timeouts on the
  same call, then the next call returns instantly) and the
  retry → tray-exit → kill-orphan-`node.exe` recovery sequence.
- **README** — `## Configure` section renamed to `## Configuration`, with
  an explicit bootstrap note (file is not created automatically; until it
  exists the server starts with empty `allowedRoots` and every path-bound
  tool returns `EPERM_ROOT`) and a new paragraph clarifying that
  `configs/default.json` and `configs/local.json` are dev-time fixtures,
  not loaded at runtime.
- **`docs/design/mcp-winfs-spec.md`** — new §3.1 "Runtime vs dev fixtures"
  paragraph mirroring the README note. Points at `defaultConfigPath()` in
  `src/core/config.ts` as the source of truth for the lookup path.
- **`configs/README.md`** (new) — explains the role of `default.json`
  (baseline / schema reference) vs `local.json` (gitignored dev override
  for Inspector) vs `%LOCALAPPDATA%\mcp-winfs\config.json` (runtime).
  Also documents the no-JSON-comments rationale (`CONFIG_SCHEMA` is
  `.strict()`).

### Changed — code

- **`src/core/allowed_roots.ts`** — when `allowedRoots` is empty the
  `EPERM_ROOT` hint now embeds the resolved absolute config path
  (`No allowedRoots configured. Edit C:\Users\<USER>\AppData\Local\mcp-winfs\config.json to add one. See README §Configuration.`)
  instead of the generic `"Edit config.json to add one"`. Path computed
  via the now-exported `defaultConfigPath()` from `src/core/config.ts`.
- **`src/core/config.ts`** — `defaultConfigPath` is now exported (was
  module-private). Single-line change, no behaviour delta on the
  loadConfig path.

### Cleanup

- **`configs/default.json`** — `allowedRoots` reduced from three
  prior-machine user-specific paths (`C:\Users\Expert\…`) to `[]`. This
  file ships in the repo and must not contain per-machine paths.
- **`scripts/restart-winfs.ps1`** — five em-dash characters (`—`,
  U+2014) replaced with ASCII hyphens (two in comments, three in
  `Write-Host` strings). Avoids PowerShell parser surprises on hosts
  whose default code page isn't UTF-8.

### Tests

- `tests/invariants/allowed_roots.test.ts` (+1): regression for the new
  hint format. When `resolvedAllowedRoots` is empty the `EPERM_ROOT`
  hint must equal the exact `defaultConfigPath()`-embedded string, not
  the legacy `Edit config.json` placeholder.

Net: 371 → 372 passing.

## [0.7.0 wave: 2b] — v0.7 wave 2b (process control suite)

Largest single DC-parity addition. Introduces the first long-lived
shared mutable state in the server (an in-memory `ProcessRegistry`)
plus four tools that operate on it. Net surface delta: 33 (wave 2a)
→ 37. No version bump — `[Unreleased]` continues.

### Added — new tools (4)

- **`start_process`** — `child_process.spawn(argv[0], argv.slice(1),
  { shell: false })` against a register-then-return session model.
  Input: `command: string[]`, `cwd?`, `env?`, `timeout_seconds?`
  (default 300, max 3600). Defenses parity with `execute_command`:
  composed-argv blocklist, `cwd` validated against `allowedRoots`
  (defaults to `allowedRoots[0]`), `env` extends sanitized exec env
  (subprocess PATH = `sanitizedPath`). Concurrency cap (17th
  simultaneous running session → `EBUSY`). Response is intentionally
  tiny: `{ session_id, started_at, status, command_prefix }`. Spec
  §Z.4.
- **`interact`** — long-poll read of session stdout/stderr starting at
  caller-supplied `*_since` offsets, optional `input` to stdin
  beforehand, optional `finalize` to close stdin permanently. The
  pump that drives long-running children forward — typical caller
  loop reads each response's `stdout_offset` / `stderr_offset` back
  into the next call's `*_since`. `max_wait_ms` default 5000 / max
  60000; deadline is normal (resolves with whatever's buffered,
  never raises). Spec §Z.5.
- **`list_process`** — read-only enumeration of every session in the
  registry, both running and recently-settled (within
  `processSessionTtlMs` after settle). Returns `{ sessions, total }`
  sorted by `started_at` ASC. Spec §Z.6.
- **`kill_process`** — terminate a session. `force: false` (default)
  = Windows `taskkill /T` / POSIX SIGTERM with 5 s grace before
  SIGKILL escalation. `force: true` = immediate `taskkill /F /T` /
  SIGKILL. Idempotent — settled session returns
  `was_already_settled: true` with `exit_code` preserved. Spec §Z.7.

### Added — infrastructure

- New module `src/core/process_registry.ts` — `ProcessSession` and
  `ProcessRegistry`. First long-lived shared mutable state in the
  server. Per-session capped output buffers, status state machine,
  waiter queue with `waitForOutput` / `waitForSettle`, periodic GC
  sweep, platform-aware kill helpers, drain via `shutdown()`. Spec
  §Z.1–§Z.3.
- `createServer` signature changed: returns `{ server, registry }`
  (was: `McpServer` only). Only consumers: `src/index.ts` (wires
  shutdown) and the in-tree `createServer` call. No test impact.
- `src/index.ts` gains SIGINT / SIGTERM handlers that call
  `registry.shutdown()` (10 s hard deadline) before
  `process.exit(0)`. Idempotent — second signal during shutdown is
  ignored. Previously the server had no shutdown hook at all.
- New config fields: `processMaxConcurrent` (default 16),
  `processBufferCap` (default 1 MB), `processSessionTtlMs` (default
  60 s), `processGcIntervalMs` (default 10 s).
- `MUTATION_TOOLS` extended: `+ start_process + interact +
  kill_process` (12 → 15). `list_process` is read-only and NOT added.
- `SENSITIVE_ARG_KEYS` extended: `+ input` (interact stdin bytes —
  may carry passwords / interactive secrets, never persisted to
  audit).
- New error codes: `ENOSESSION`, `EPIPE_CLOSED` (catalog spec §Z.8).
  `EBUSY` (existing) gains a new contextual meaning for the
  concurrency cap.

### Tests

- `tests/unit/process/process_registry.test.ts` (10): empty list,
  spawn returns running session, settled has exit_code +
  settled_at, GC removes past TTL, buffer cap truncates,
  waitForOutput resolves on chunk and on deadline, timed_out
  transition, spawn_failed for bogus binary, force-kill transitions
  to killed.
- `tests/unit/process/list_process.test.ts` (3): empty registry,
  two-spawn ordering by started_at, settled session summary carries
  exit_code + settled_at.
- `tests/unit/process/start_process.test.ts` (7): happy echo,
  EPERM_ROOT on outside cwd, EBLOCKED via composed argv, EBUSY at
  cap, spawn_failed for bogus binary, timed_out on 1-second
  deadline, cwd subdirectory works.
- `tests/unit/process/interact.test.ts` (6): happy echo + exited,
  ENOSESSION on unknown id, long-poll deadline empty stdout within
  budget, EPIPE_CLOSED after finalize, EPIPE_CLOSED on settled
  session, paginated reads via stdout_since.
- `tests/unit/process/kill_process.test.ts` (5): force-kill,
  already-settled idempotent, ENOSESSION on unknown id, second kill
  idempotent, graceful kill transitions to killed.

Net: 340 → 371 passing (+31 tests, no regressions).

### Architectural notes

ProcessRegistry is the first long-lived shared mutable state in the
server (invariant #36). Filesystem and one-shot exec tools remained
stateless through v0.6 + wave 1 + wave 2a; persisting children
across calls required a singleton lifecycle that didn't exist.
`createServer` now constructs the registry and `src/index.ts` drains
it on SIGINT/SIGTERM — neither of which were patterns the server
had before. Test isolation is via per-`beforeEach`
`new ProcessRegistry(config)` rather than module-level state, so
parallel test files don't leak children at each other.

The deadline-vs-close race was the only architectural surprise: a
naive timeout handler that calls `settle("timed_out", null)` first
and SIGKILLs the child second leaves a still-alive process attached
to a "settled" session, which blocked tempdir cleanup on Windows.
The fix (`deadlineFired` flag — settle decision is deferred to the
natural `close` event, which checks the flag) is invariant #38.

## [0.7.0 wave: 2a] — v0.7 wave 2a (existing-tool improvements)

Compact follow-up to wave 1: four improvements to tools already in the
surface, plus two documentation hangovers. No new tools. No version
bump — `[Unreleased]` continues. Process-control suite
(start_process / interact / list_process / kill_process) is held for
wave 2b.

### Changed — existing tools

- **`edit_file`** gains an optional `with_diff: boolean` input (default
  `true`, preserving the v0.4 §I "diff field always populated"
  invariant). Pass `with_diff: false` to suppress the response `diff`
  body on large multi-edit batches where only `replacements_made`
  matters. The diff body is also now capped at 16 KB: overflow
  truncates with a trailing `... [N more bytes truncated]\n` marker
  and the response carries `truncated_diff: true`. Spec amendment
  §Y.1.
- **`grep`** gains explicit pagination. New input fields `offset?`
  (default 0) and `limit?` (default 50, hard cap 500) carve a half-open
  window over the match sequence. `max_matches` is retained as a v0.6
  legacy alias — if both `limit` and `max_matches` are supplied, `limit`
  wins. Response gains `total_matches` (count across the whole search,
  capped at 10 000 with `total_matches_capped: true` on overflow) and
  `next_offset?` (set iff more results follow the current page).
  Default-call behaviour is unchanged for callers that didn't paginate.
  Spec amendment §Y.2.
- **`execute_command`** surfaces diagnostic hints when stderr matches a
  known cryptic-failure signature. New optional `hints: string[]`
  envelope field — first entry covers PowerShell's "Cannot run a
  document in the middle of a pipeline" error (cryptic when an agent
  tries to invoke `ssh.exe` or other non-PE binaries through
  powershell). Raw stderr is preserved verbatim; hints are additive
  and NOT persisted to the audit log. Spec amendment §Y.3.

### Added — infrastructure

- New module `src/core/exec_hints.ts` — small registry of
  `{ marker, hint }` entries for the execute_command hints feature.
  Substring-anchored, case-insensitive, intentionally
  append-only. Wave 2a adds 1 entry; future hints add one entry each.

### Docs

- Spec amendment §Y.4 — ETIMEDOUT response shape examples for
  `execute_command`, `ssh_exec`, and `run_python` (the three
  timeout-capable tools). Documents the flag-vs-error envelope split
  side-by-side so agents can predict the shape without trial-and-error.
- Spec amendment §Y.5 + README "Local working config" section — worked
  example of overriding `config.sshExePath` for Git-bundled
  (`C:\Program Files\Git\usr\bin\ssh.exe`) or MSYS2
  (`C:\msys64\usr\bin\ssh.exe`) OpenSSH installs. Wave 1 wired the
  config field but the override syntax was undocumented because
  `configs/local.json` is gitignored.

### Tests

- `tests/unit/editor/edit_file_with_diff.test.ts` (6): default-true
  body, opt-out via `with_diff: false`, dry_run + opt-out, multi-edit
  combined diff, oversized-diff truncation marker, under-cap absence
  of `truncated_diff`.
- `tests/unit/search/grep_pagination.test.ts` (5): default first-page
  semantics, walk-through pages via offset/limit, offset past the end,
  EINVAL on negative offset, legacy `max_matches` alias still works.
- `tests/unit/exec/execute_command_hints.test.ts` (4): hint attached on
  marker, case-insensitive substring match, no-marker absence,
  empty-stderr absence. Spawn is mocked via `vi.spyOn(execSafety,
  "spawnSubprocess")` so the suite doesn't need PowerShell to fail
  this way on the host.
- `tests/invariants/structured_content.test.ts` (+1 key): grep
  envelope grew `total_matches` — invariant updated to match.

Net: 325 → 340 passing (+15 tests, no regressions).

## [0.7.0 wave: 1] — v0.7 wave 1

Three additions from the 2026-05-18 ecom-session consumer-agent feedback
report (full report archived in the appendix of
`prompts/cc-prompt-v0.7-wave1-ssh-listpath-writejson.md`). Net +3 tools
(30 → 33 surface). Ships ahead of the main v0.7 DC-parity wave (features
A–D in the roadmap). No version bump in this wave — `[Unreleased]` only.

### Added — new tools (3)

- **`ssh_exec`** — first-class SSH remote execution. Spawns `ssh.exe`
  directly via `child_process.spawn` against the absolute path in
  `config.sshExePath` (default `C:\\Windows\\System32\\OpenSSH\\ssh.exe`).
  No shell, no PowerShell wrapper. Host whitelist via `ssh -G` against
  `~/.ssh/config`; raw `user@host` rejected. 4 KB per-stream output cap;
  `timeout_seconds` default 30, max 300 (clamped by `config.maxTimeoutMs`).
  Sidesteps three stacked execute_command failures on Windows: PATH
  sanitization hiding `System32\\OpenSSH`, PowerShell rejecting `ssh.exe`
  in pipelines, and known-bug #2 (silent stdout via execute_command).
  Spec amendment §X.1 / invariant #35. New error codes:
  - `ESSHNOTFOUND`: `sshExePath` does not exist on disk.
  - `EHOST_UNKNOWN`: host not resolvable via `ssh -G` (or raw `user@host`
    form rejected).
  - `EIO` + `spawnFailed: true` on async spawn error (mirror of v0.6 §U
    `exec_safety` fix).
- **`list_path_dirs`** — read-only introspection of the sanitized PATH
  array that `execute_command` / `find_command` / `run_python` /
  `run_pytest` / `ssh_exec` inherit. Lets agents debug "why is binary X
  invisible" without trial-and-error. No input args; output
  `{ path_dirs: string[], total: number }`. Backed by a new
  `sanitizedPathDirs(config)` helper extracted from `exec_safety.ts`
  (single source of truth; `sanitizedPath(config)` joins this with `;`).
  Spec §X.2.
- **`write_json`** — atomic JSON write, symmetric to v0.3 `read_json`.
  `path` must end in `.json` (case-insensitive, validated on both
  caller-supplied path and realpath-resolved path). `value: unknown` is
  `JSON.stringify`-d with `indent` 0..10 (default 2); trailing newline
  appended; atomic temp + fsync + rename. `overwrite: false` by default
  (safer than v0.1 `write`). Output `{ bytes_written, lines_written, created }`
  matches `write`. Spec §X.3. New error code:
  - `EEXT_NOT_JSON`: path does not end in `.json` (case-insensitive).
    Caught before any disk I/O. Use `write` for non-JSON files.

### Added — infrastructure

- New config field `sshExePath: string` (Zod schema, default
  `C:\\Windows\\System32\\OpenSSH\\ssh.exe`). No magic-confirm gate —
  ssh_exec's security boundary is the user's ssh config, not the binary
  path.
- `MUTATION_TOOLS` extended with `write_json` and `ssh_exec` (10 → 12).
  `list_path_dirs` is read-only and is NOT added.
- `SENSITIVE_ARG_KEYS` extended with `value` (for `write_json`).
  `sanitizeArgs` redaction extended to handle objects at sensitive keys
  as `<redacted: N keys>`, symmetric with the existing
  `array → <redacted: N items>` rule. Safe for pre-wave tools because
  none of them passed an object at a sensitive key.
- New error codes: `ESSHNOTFOUND`, `EHOST_UNKNOWN`, `EEXT_NOT_JSON`
  (catalog spec §X.4).

### Added — documentation

- README "Known limitations" section (added in the docs-first Phase A
  of this wave): audit-log content-truncation policy + remote-exec gap
  resolved by `ssh_exec`.
- Spec amendment §X (`docs/design/mcp-winfs-spec.md`).
- Roadmap (`prompts/cc-prompt-mcp-winfs-v0.7-roadmap.md`) gained a
  "Consumer-agent feedback adds (2026-05-18 ecom session)" section
  between Feature D and the Hard-invariants preview; planned §X–§AA
  shifted to §Y–§AB to make room.

### Tests

- `tests/unit/system/list_path_dirs.test.ts` (4): non-empty array,
  joins to `sanitizedPath`, `pythonHome` round-trip, omission when
  `pythonHome` unset.
- `tests/unit/file/write_json.test.ts` (14): create new, EEXIST when
  `overwrite=false`, overwrite=true replaces, EEXT_NOT_JSON for
  `.txt`, case-insensitive `.JSON`, round-trip with `read_json`,
  indent 0 compact / indent 2 pretty, EPERM_ROOT outside roots,
  EINVAL for circular ref / BigInt / top-level function, mkdirParents
  on / off.
- `tests/unit/system/ssh_exec.test.ts` (9, all `child_process.spawn`
  mocked via `vi.mock` on `exec_safety`): ESSHNOTFOUND missing binary,
  EHOST_UNKNOWN raw `user@host`, EHOST_UNKNOWN ssh -G non-zero,
  EHOST_UNKNOWN missing hostname line, EIO async spawn error (mirrors
  v0.6 fix), ETIMEDOUT with partial output, happy path
  `[host, command]` argv, truncated_stdout flag, validation cache.
- `tests/invariants/structured_content.test.ts` (+2): wave-1 envelopes
  `{path_dirs, total}` and `{bytes_written, lines_written, created}`.

## [0.6.0] — 2026-05-18

Configurable filesystem scope + chunked I/O + occurrence-count assertions
on top of the v0.5 29-tool surface. Net +1 tool (`write_chunk`, 30 total)
+ 1 schema extension (`edit_file.edits[].expected_count`) + 1
cross-cutting config option (`unrestrictedFilesystem`).

### ⚠️ BREAKING CHANGES from v0.5

Two wire-format changes on existing `edit_file` responses. v0.x semver
explicitly allows breaking changes on minor bumps; no back-compat shim
shipped. Both formalised in spec §W.

- **`edit_file` EUNIQUE `details` field renamed: `occurrences` →
  `occurrences_found`.** Plus a new sibling field `expected_count` (the
  value the caller supplied or the default 1) is now part of the details
  shape. v0.5 callers parsing the old `details.occurrences` will see
  `undefined`. **Migration:** rename to `details.occurrences_found`; also
  read `details.expected_count` if you want to surface the requested
  count alongside the actual one.

- **`edit_file.replacements_made` semantics changed.** v0.5 returned
  `args.edits.length` (the count the caller already knew — zero
  information). v0.6 returns the actual sum of replacements performed
  across all edits: `expected_count: 0` edits contribute 0,
  `expected_count: 1` contribute 1, `expected_count: N` (N ≥ 2)
  contribute N. **Migration:** if you were using the field as
  "how many edits did I send", switch to `args.edits.length`
  directly; if you want "how many bytes/chunks were actually mutated",
  the new semantics give you that.

### Added — new tool (1)

- **`write_chunk`** — byte-offset surgical write tool for huge files.
  Companion to v0.1 `read` (which has range support). Opens with
  `fs.open(path, "r+")`, writes payload at `offset`, closes — **no temp
  file, no fsync, no atomic rename**. Response carries the literal
  `atomic: false`. Designed for in-place edits on files too large to
  reload whole. Spec §V / invariants #31–#33:
  - #31: non-atomicity is explicit and pinned by an invariant test.
  - #32: `offset > file_size_before` → `EOFFSET` (new error code).
    Sparse-file creation forbidden. `offset === file_size_before` is
    the append-at-EOF path.
  - #33: UTF-8 boundary check (default on). Both the boundary at
    `offset` AND the boundary at `offset + content_length` in the
    existing file must NOT be UTF-8 continuation bytes. Mid-multibyte
    → `EENCODING`. Set `validate_byte_range: false` to bypass.
  - Audit redaction: full content NEVER persisted; first 256 chars +
    length + offset + mode (per #30) in `auditExtras`.

### Added — `edit_file.edits[].expected_count` (spec §W / invariant #34)

New optional field on each edit. Default 1 preserves v0.5 contract.
Three modes:

- **`expected_count: 1` (default).** Single-replace, EXACTLY 1
  occurrence required (v0.5 contract).
- **`expected_count: 0`.** Assertion-only mode. Verify `old_str` is
  ABSENT (count must equal 0); no replacement is performed. Useful for
  "ensure this code is removed" assertions in mixed-mode batches.
- **`expected_count: N` (N ≥ 2).** Replace ALL occurrences atomically
  within the edit (impl uses `split(old).join(new)`). Count must equal
  N exactly; mismatch → `EUNIQUE`.

Sequential application unchanged: edit K is checked against the buffer
AFTER edits 0..K-1. `dry_run: true` still reports `replacements_made`
matching what would have been written.

### Added — configurable filesystem scope (spec §U / invariants #28–#30)

Opt-in mode where `checkAllowed` short-circuits and accepts paths
outside `allowedRoots`. Designed for dev sandboxes / agent VMs.
**NEVER for production / multi-tenant hosts.**

- New config knobs:
  - `unrestrictedFilesystem: boolean` (default `false`).
  - `unrestrictedFilesystemConfirm: string` (optional). When
    `unrestrictedFilesystem === true`, must equal exactly
    `"I-UNDERSTAND-THE-RISK"`. Mismatch → `loadConfig` throws at
    startup (invariant #28; accidental enable structurally impossible).
- `ResolvedConfig` gains derived field
  `serverMode: "strict" | "unrestricted"`.
- When unrestricted: 3-line stderr banner at startup (invariant #29)
  + ready-line includes `mode=unrestricted` + sentinel
  `_server_start` audit record carries `server_mode` in
  `args_summary` and `mode` at top level.
- Audit log: every mutation tool's audit entry gains top-level
  `mode: "strict" | "unrestricted"` (invariant #30). Read-only tools
  omit the field. Forensic queries: `mode === "unrestricted"` extracts
  every mutation that ran outside `allowedRoots`.
- **Other defenses stay in force in unrestricted mode**: exec
  blocklist (#7), `check_env` safe-prefix (#8), `fetch_url` SSRF
  defense (#10), audit redaction (#11), atomic writes, bounded
  timeouts. Unrestricted only short-circuits the allowed-roots check.

### Added — infrastructure

- New error code: **`EOFFSET`** (`write_chunk` sparse-file forbidden).
- New audit-event convention: tool names beginning with `_` are
  RESERVED for system events emitted by the audit subsystem itself.
  Real registered tools never use this prefix. `_server_start` is the
  first system event; future system events should follow the
  convention. Documented in `src/core/audit.ts` near `AuditRecord`.
- `MUTATION_TOOLS` set in `audit.ts` (10 names — drives the `mode`
  field injection).

### Added — tests (+32 net new, 293 total)

- `tests/unit/config_unrestricted.test.ts` (5): magic-confirm
  validation truth table.
- `tests/invariants/unrestricted_mode.test.ts` (4): strict mode
  rejects out-of-roots; unrestricted accepts; mutation entry has
  `mode` / read-only omits; `_server_start` carries `server_mode`.
- `tests/unit/file/write_chunk.test.ts` (12): happy in-place,
  base64 encoding, extend beyond EOF, offset 0, offset > size →
  EOFFSET, EPERM_ROOT, ENOENT, EISDIR, lone-surrogate replacement,
  UTF-8 boundary misalign → EENCODING, `validate_byte_range: false`
  bypass, audit extras.
- `tests/invariants/write_chunk_nonatomic.test.ts` (3): `atomic:
  false` literal, no `.tmp` artifact, original-inode mutation.
- `tests/unit/editor/edit_file_expected_count.test.ts` (8): default 1
  back-compat, exact-count match, exact-count mismatch → EUNIQUE,
  `expected_count: 0` assertion succeeds, `expected_count: 0` with
  occurrence → EUNIQUE, `expected_count: 5` multi-replace, mixed batch
  summing `replacements_made`, dry-run with `expected_count: 0`.
- Existing v0.4 `edit_file` EUNIQUE tests updated for the renamed
  details field (`occurrences` → `occurrences_found`).

### Tests

- 293 passing total in 52 files (was 261 in 47 files at v0.5.1).
  +32 net new tests; +5 new files. Build clean (zero TS diagnostics).

### Spec

- Amendments §U–§W appended to `docs/design/mcp-winfs-spec.md`. Spec
  line count: 977 → 1097.

## [0.5.1] — 2026-05-17

Canonical v0.5 ship. Carries the 11 v0.5 tool implementations on top
of v0.4 surface (29 tools total): git RO (5), exec (3), system (2),
network (1). The `v0.5.0` tag on remote (`2dc2a89`) is a phantom — it
predates the 11 tool implementations and carries only v0.1–v0.4
surface; reviewers / downstream consumers should clone `--branch v0.5.1`
(commit `71ad8a6`), not `v0.5.0`.

See `docs/v0.5.1-acceptance.md` for the full reconciliation note +
per-criterion evidence.

## [0.4.0] — 2026-05-16

Editor + slicing + diff + incremental tail. Closes spec §7 v0.4 milestone:
"Claude can modify code without dropping to a shell, slice large files
without blowing context, watch logs/output incrementally, and compare
two versions textually."

### Added — new tools (4)

- **`read_section`** — Slice a file by `line_range: [start, end]` (1-based
  inclusive) OR `byte_range: [start, end]` (0-based inclusive). Exactly
  one selector. Byte-range slices on UTF-8 text trim to the largest valid
  UTF-8 substring within the requested range (`adjusted: true` surfaced).
  `encoding: "raw"` returns the exact byte slice as base64. Line counting
  splits on `\n` without normalization; `\r` stays attached. Pivot from
  spec §4.5's marker-based design recorded in spec amendment §J.
- **`diff_files`** — Unified textual diff between two sides. Each side is
  exactly one of `a` / `a_inline` (and `b` / `b_inline`). Two formats:
  `unified` (default, full unified diff with `context_lines` 0..10) and
  `minimal` (summary header + first 20 changed lines). UTF-8 BOM stripped
  before diff; binary input → `EENCODING`. Diff size capped at the new
  `config.maxDiffBytes` knob (default 256 KB) — oversize → `truncated`.
- **`edit_file`** — Atomic find-and-replace with `dry_run` and a strict
  uniqueness invariant. Each `old_str` MUST appear exactly once in the
  current in-memory buffer (0 occurrences OR 2+ → `EUNIQUE` with
  `details.{edit_index, occurrences}`). Edits apply sequentially; edit N
  is checked against the buffer AFTER edits 0..N-1. `dry_run: true`
  validates + returns the unified diff without touching disk (no `.tmp`
  artifact). Writes go through the existing atomic-write path
  (`temp + fsync + rename`). Audit log records
  `{path, edits_count, dry_run, bytes_before, bytes_after}` — `old_str` /
  `new_str` content is NEVER persisted.
- **`read_since`** — Incremental tail. Caller passes a byte offset from a
  prior call and receives the delta. Rotation detected when
  `total_bytes < since_offset`: response carries `file_rotated: true` and
  returns the whole (smaller) file with `new_offset === total_bytes`.
  UTF-8 boundary: if `since_offset` lands mid-multibyte, the read
  advances forward to the next valid boundary (silent skip ≤ 3 bytes);
  > 3 bytes skipped → `EENCODING`. Default chunk cap 64 KB, hard cap 1 MB.

### Added — infrastructure

- **`diff` npm dependency** (`^7.0.0`) — well-tested unified-diff library
  used by `diff_files` and `edit_file`'s `diff` field. No shell-out.
- **`config.maxDiffBytes`** — new strict-Zod config knob (default 256 KB)
  capping the `diff_files` output. Test helpers updated.
- **`audit.SENSITIVE_ARG_KEYS` extended** with `edits` (array-aware) +
  `a_inline` / `b_inline` (string-aware). `sanitizeArgs` now redacts
  sensitive arrays as `<redacted: N items>` so `edit_file`'s edits never
  leak through the audit log.

### Spec amendments

`2026-05-16 — v0.4 Editor + Slicing surface (§I–§L)`:

- **§I — `edit_file` semantics.** Pins uniqueness invariant, sequential
  application, dry-run-doesn't-touch-disk, diff field always populated,
  audit redaction of `old_str` / `new_str`.
- **§J — `read_section` slice semantics.** Pins mutual exclusion of
  selectors, line-counting rules, UTF-8 boundary trim with `adjusted`
  vs interior-decode `EENCODING`. Records the pivot from §4.5's
  marker-based design to range-based (rationale: marker-based blurs
  into `grep` territory; range-based composes with `read_multiple_files`).
- **§K — `read_since` rotation semantics.** Pins steady-state /
  append / rotation paths, UTF-8 boundary advance (≤ 3 bytes silent,
  > 3 bytes = `EENCODING`).
- **§L — `diff_files` text-only with inline support.** Pins
  inline-or-path mutex per side, BOM stripping, binary → `EENCODING`,
  `unified` vs `minimal` formats.

### Added — tests (+50 net new, 179 total)

- `tests/unit/slicing/read_section.test.ts` — 11 tests (line / byte
  ranges, both / neither selector → EINVAL, line_range past EOF,
  UTF-8 boundary trim, raw encoding, ETOOLARGE, EPERM_ROOT, ENOENT,
  EISDIR).
- `tests/unit/slicing/diff_files.test.ts` — 11 tests (identical,
  file vs inline, inline vs inline, mutex EINVAL, both empty, one
  empty, BOM stripped, binary EENCODING, minimal format, truncated).
- `tests/unit/editor/edit_file.test.ts` — 13 tests (single + multi
  edit, dry_run, EUNIQUE 0× and 2+×, sequential cascade EUNIQUE,
  EPERM_ROOT, ENOENT, EISDIR, EENCODING, BOM round-trip, identity
  edit, audit extras).
- `tests/unit/slicing/read_since.test.ts` — 8 tests (steady-state,
  append, truncated, rotation, UTF-8 boundary advance, EPERM_ROOT,
  ENOENT, mtime).
- `tests/invariants/edit_file_atomic.test.ts` (new) — 2 cases pinning
  the spec §I invariants: `dry_run` produces no `.tmp` artifact; a
  mocked `fs.rename` failure leaves the original file intact and the
  temp cleaned up.
- `tests/invariants/structured_content.test.ts` — extended with the 4
  new tools (now 17 cases total).
- `tests/invariants/timeouts.test.ts` — added an `edit_file` deadline
  case (mocked slow `fs.rename` + 100 ms wrapper deadline →
  `ETIMEDOUT`, original file unchanged).

### Tests

- 179 passing total in 33 files (was 129 in 28 files at v0.3.3).
  +50 net new tests; +5 new files.

## [0.3.3] — 2026-05-16

DeepSeek post-v0.3.2 review polish. All P3 items, `audit_tail`-scoped.

### Changed — security & error hygiene

- **`audit_tail` rejects non-absolute `auditLogPath`** (`EPERM_ROOT`,
  layer 0 of the path-validation stack). A relative path here would
  silently resolve against `process.cwd()` — an operator-controlled
  variable that is not part of the configured contract. Up-front
  assertion makes the rule explicit and uncacheable.
- **Structured EIO error details on `audit_tail`.** Four call sites
  (`realpath` / `open` / `fstat` / tail-from-handle) no longer
  concatenate raw Node.js `error.message` strings into the user-facing
  `message` field. The raw cause now lives in `error.details.cause`
  with the `errno` code in `error.details.errno`. Reduces accidental
  disclosure of internal file paths and OS-specific error wording in
  the human-readable message line; makes the structured `code`/`message`
  surface stable for programmatic dispatch.

### Docs

- `audit_tail` tool description rewritten to call out the absolute-path
  requirement and the new `error.details.cause` location.
- Threat-model docstring on `openAuditLog` extended with layer 0
  (`isAbsolute`) ahead of the existing four-layer stack.
- README post-P1.3 security-stack wording corrected — the old
  "parent dir + .jsonl suffix" sentence (true only in v0.3.0/v0.3.1)
  replaced with the actual v0.3.2+ guarantees (absolute path, `.jsonl`
  on both configured and `realpath`-resolved, `fstat` on bound fd).

### Considered & rejected

- **Rename `audit_tail.total` → `entries_returned`** (kimi + gemini P3).
  Spec amendment §F (`docs/design/mcp-winfs-spec.md` L876) explicitly
  fixes `total: number — always array.length` as the envelope convention
  for every plural-tool response (`read_multiple_files`, `glob`, `grep`,
  `audit_tail`). The reviewers' complaint reads against the spec.
  Renaming would break a documented contract. If a genuine
  "scanned vs returned" diagnostic is wanted, a supplementary
  `entries_seen_total` field can be added in v0.4 — deferred.

### Tests

- 129 passing total (was 128 in v0.3.2). +1 unit test in
  `tests/unit/system/audit_tail.test.ts` for non-absolute path
  rejection asserting `error.code === "EPERM_ROOT"`, message contains
  "absolute", and `error.details` matches `{ configured }`.

## [0.3.0] — 2026-05-16

Search + self-recovery surface. Closes spec §7 v0.3 milestone: "Claude can
explore the codebase without dropping to a shell, and can recover from a
context loss by tailing the audit log."

### Added — new tools (4)

- **`glob`** — Find files matching an absolute glob pattern. Supports `*`,
  `?`, `**` (zero-or-more path segments) and `[...]` character classes.
  Brace expansion is intentionally not supported (issue two calls instead).
  The pattern's literal prefix must lie inside `allowedRoots`; every
  candidate file is realpath-checked so symlink-escape entries never appear
  in results. Default cap 200, hard cap 2000; oversize → `truncated: true`.
- **`read_json`** — Convenience wrapper that reads a file via the v0.1
  `read` tool and `JSON.parse`s the content in one call. Parse failures
  return the distinct `EBADJSON` code with best-effort line / column /
  snippet in `details` so the caller can fix the file without a separate
  read-and-inspect round trip. Inherits `read`'s `EPERM_ROOT`, `ENOENT`,
  `EISDIR`, `ETOOLARGE`, `EENCODING` semantics unchanged.
- **`grep`** — Regex search across files matching a glob, with optional
  context lines and `max_matches` cap. The user pattern is compiled with
  `new RegExp(...)` only — no `eval`, no `Function`. Bad regex → `EINVAL`
  with the parser message. `grep` owns its own deadline: on expiry it
  returns the partial match set with `{truncated: true, reason: "timeout"}`
  instead of synthesising an error (see spec amendment §F).
- **`audit_tail`** — Read the last N entries of the structured audit log
  written by every tool call. Used for self-recovery after a chat
  context loss. The audit log lives OUTSIDE `allowedRoots` by design
  (`%LOCALAPPDATA%\mcp-winfs\audit.jsonl`); this tool is the only
  legitimate exception, gated by a shape check on the configured path
  (parent dir == `mcp-winfs`, filename ends with `.jsonl`). Any other
  shape → `EPERM_ROOT`. Self-deduplicates: trailing `audit_tail` entries
  are dropped from the response.

### Changed — carryover items from v0.2

- **`move`** gained `allow_cross_volume: boolean` (default `false`).
  Default behaviour unchanged: cross-volume rename returns `EIO` with
  `errno: EXDEV`. With the flag set, falls back to a non-atomic
  `copy + delete`. The response envelope now includes `atomic: boolean`
  so callers can audit which moves were race-free (see spec amendment §G).
- **`copy`** writes the full `files_skipped_total` to the audit log even
  when the user-visible `skipped_paths` array is capped at 10. Achieved
  via a new `ToolContext.auditExtras` hook in `tool_wrapper.ts` —
  side-channel metadata that lives in the audit record without leaking
  into the response payload (see spec amendment §H).
- Spec amendment `2026-05-16 — v0.3 envelopes + move cross-volume opt-in
  + copy audit telemetry` (§F/§G/§H): formalises the envelope pattern for
  every array-output tool (`read_multiple_files` was de-facto already
  shipping one; now also `glob`, `grep`, `audit_tail`), records the
  opt-in cross-volume semantics, and documents the audit telemetry hook.

### Added — infrastructure

- `src/core/glob.ts` — minimal path-glob compiler shared by `glob` and
  `grep`. Pure regex, no shell-out, no third-party dependency.
- `src/core/walk.ts` — realpath-aware recursive file walker. Each entry
  is realpath-checked so symlink-escape skips happen at walk time (same
  guard as `copy`'s recursive walker, now extracted).
- `ToolContext.auditExtras` callback on `runTool` — lets a tool inject
  extra fields into `args_summary` on the audit record without changing
  its user-facing schema.

### Added — tests (+36 net new, 120 total)

- `tests/unit/search/glob.test.ts` — 5 tests (happy match, no-match,
  `max_results` cap, `EPERM_ROOT` outside-sandbox, `EINVAL` on relative
  pattern).
- `tests/unit/search/grep.test.ts` — 7 tests (matches, no-match,
  `EINVAL` on bad regex, `max_matches` cap with `reason: "max_matches"`,
  `context_before`/`context_after`, `EPERM_ROOT`, deadline → partial
  result with `reason: "timeout"`).
- `tests/unit/search/read_json.test.ts` — 5 tests (parse, `EBADJSON` +
  snippet, `ETOOLARGE`, `EPERM_ROOT`, `ENOENT`).
- `tests/unit/system/audit_tail.test.ts` — 7 tests (last N, n > total,
  n = 0, empty file, self-deduplication, `EPERM_ROOT` on non-conforming
  audit path, `isAuditLogPathLegitimate` truth table).
- `tests/unit/fs/move.test.ts` — added `allow_cross_volume:false` EXDEV
  test (mocks `fs.rename`), and `allow_cross_volume:true` fallback test
  asserting `atomic:false` + delete-of-source.
- `tests/unit/fs/copy.test.ts` — added carryover #2 test: 15 escaping
  symlinks → response `skipped_paths.length === 10` but
  `files_skipped === 15` and `getFullSkipCountForAudit()` returns 15
  (audit-only telemetry).
- `tests/invariants/audit_tail_privileged.test.ts` — 4 tests pinning the
  privileged-read boundary (parent-dir name, `.jsonl` suffix, plausible
  Win-sensitive paths, plus a legit positive case).
- `tests/invariants/structured_content.test.ts` extended (+4 new tools
  + `move` envelope updated for `atomic`).
- `tests/invariants/timeouts.test.ts` extended with `grep` partial-result
  case.

### Tests

- 120 passing total (was 84 in v0.2). +36 net new across 5 new unit files
  + 1 new invariant file + extensions.

## [0.2.0] — 2026-05-16

Mutations + batch read + introspection. Closes spec §7 v0.2 milestone:
"versioning workflow можно делать без shell".

### Added

- **`mkdir`** — Create a directory. `recursive: true` (default) implements
  `mkdir -p`: idempotent on existing directory (`created: false`, no error).
  `recursive: false` on an existing directory → `EEXIST`.
- **`move`** — Atomic rename / move via `fs.rename`. Both `src` and `dst`
  must be inside `allowedRoots` after realpath. Cross-volume rename
  fails fast with `EIO + errno: EXDEV` (no silent copy+delete fallback —
  see spec amendment §A). Defaults to `overwrite: false`.
- **`copy`** — Recursive file/directory copy. Each entry inside the
  source tree is realpath-checked during the walk; junction/symlink
  escape or dangling-symlink entries are skipped and reported in
  `files_skipped` + `skipped_paths` (cap 10 entries; see spec amendment
  §B).
- **`read_multiple_files`** — Batch-read 1..50 paths in parallel. Each
  file has an independent per-file timeout (`config.defaultTimeoutMs`).
  Per-file errors propagate inside `files[]` as `{path, error: {code,
  message, hint?}}`; the top-level call never returns `isError: true` —
  even an all-failed batch returns a uniform shape (see spec amendment
  §C).
- **`list_allowed_directories`** — Self-orientation tool. Returns
  exactly `{allowed_roots, allowed_url_hosts}` — never leaks blocklists,
  timeouts, or `auditLogPath` (see spec amendment §D).
- `tests/invariants/both_roots.test.ts` (5 tests) — pins the v0.2
  invariant that both `src` and `dst` of `move`/`copy` must be inside
  allowedRoots; one-sided checks are insufficient. Also confirms `mkdir`
  on an outside-sandbox target returns `EPERM_ROOT` without side-effects.
- `tests/invariants/structured_content.test.ts` extended (9 tests
  total) — pure-payload check for each new v0.2 tool.
- Spec amendment `2026-05-16 — v0.2 open-question decisions`: locks the
  four behavioural questions (cross-volume move, broken-symlink copy,
  batch-read concurrency, introspection surface).

### Tests

- 84 passing total (was 48 in v0.1.1). 53 unit + 31 invariant.

### Notes

- v0.1 deferred operator probe (acceptance #4) was completed during v0.1.1
  follow-up — see `docs/v0.1-acceptance.md`.
- README troubleshooting expanded with the MSIX `node.exe` absolute-path
  note, the `configs/local.json` workflow, the Inspector `--` separator
  gotcha, and the strict-config no-`_comment` rule.

## [0.1.1] — 2026-05-16 — Hotfix

### Fixed

- **Release-blocker:** Claude Desktop surfaced every successful tool call
  as failed because `structuredContent` carried an `{ok, tool, ...payload}`
  service envelope that violated the per-tool `outputSchema` contract
  (extra properties on a closed schema). Audit log showed
  `result_status: "ok"` for the same calls, confirming server-side
  correctness — the bug was the response shape.
- `src/core/tool_wrapper.ts`:
  - **Success path:** `structuredContent` is now the pure payload —
    mirrors `outputSchema` field-for-field, no `ok` / `tool` wrapper.
  - **Error path:** omit `structuredContent` entirely; set `isError: true`
    and put the structured error JSON (`{code, message, hint?, details?}`)
    in the text `content` block. Per MCP spec, `outputSchema` is not
    validated when `isError` is true.
- Resolves [`docs/v0.2-backlog.md`](docs/v0.2-backlog.md) #1.

### Added

- `tests/invariants/structured_content.test.ts` — 4 tests pinning the
  v0.1.1 contract: success has pure payload, error has no
  `structuredContent`, timeout shaped as error, real-tool round-trip via
  `write` produces only its declared output fields.

## [0.1.0] — 2026-05-16

First milestone. Implements the spec §7 v0.1 slice.

### Added

- 5 tools: `read`, `write`, `append`, `list`, `stat`. All return
  `structuredContent` so a client can read the result without re-parsing
  the textual representation.
- `src/core/` infrastructure for the hard invariants:
  - `config.ts` — Zod-validated loader, `%ENV%` expansion, UTF-8-no-BOM
    file read with explicit BOM strip.
  - `allowed_roots.ts` — realpath canonicalisation then prefix check;
    walks up to the deepest existing ancestor so `EPERM_ROOT` triggers
    even for non-existent paths outside the sandbox (no existence-leak
    channel).
  - `utf8.ts` — BOM strip on read, no BOM on write, binary heuristic
    (NUL byte / UTF-16 BOM), strict UTF-8 decode that rejects replacement
    characters.
  - `atomic_write.ts` — temp file + `fsync` + `rename`. Cleans up the
    temp file on `rename` failure.
  - `timeouts.ts` — AbortController-backed deadline race. Never hangs
    even if the underlying I/O ignores the signal.
  - `errors.ts` — typed `ErrorCode` union and a `Node errno → structured`
    mapper.
  - `audit.ts` — JSONL append, content-field redaction (`<redacted: N bytes>`),
    long-string truncation, size-based rotation, serialised write queue,
    failures non-fatal.
  - `tool_wrapper.ts` — wraps every tool with timeout + audit + structured
    error envelope. Handlers never throw.
- `configs/default.json` — spec §3 reference config.
- 44 tests across `tests/unit/` (27, per-tool happy path + each error code)
  and `tests/invariants/` (17, UTF-8 roundtrip, junction / `..` escape,
  timeout abort, atomic-write integrity, audit redaction).
- `evals/` skeleton: vendored `connections.py` from upstream mcp-builder,
  `requirements.txt`, 2 placeholder `qa_pair`s in canonical XML format,
  and a README capturing the v0.7 → v1.0 build-out plan.
- `MIGRATION.md` — tracks the V2 SDK migration trigger (post-v1.0).
- `docs/v0.1-acceptance.md` — acceptance report with evidence per criterion.

### Security

- Allowed-roots check runs **after** realpath canonicalisation and
  **before** any existence-revealing error. A path outside the sandbox
  returns `EPERM_ROOT` whether or not it exists on disk.

### Notes

- SDK target: V1 stable (`@modelcontextprotocol/sdk@^1.29.0`,
  Zod v3, `McpServer.registerTool`). V2 was pre-alpha on the day v0.1
  was cut — see `MIGRATION.md` for the trigger that flips us to V2.
