# Changelog

All notable changes to mcp-winfs are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com).

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
