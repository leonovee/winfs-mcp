# Changelog

All notable changes to mcp-winfs are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com).

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
