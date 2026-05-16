# Changelog

All notable changes to mcp-winfs are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com).

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
