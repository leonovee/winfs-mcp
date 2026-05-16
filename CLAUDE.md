# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This is a **spec-and-prompts-only** repository — no code, package.json, build, or test infrastructure exists yet. The deliverable is an MCP server (`mcp-winfs`) targeting Windows 10/11, intended to replace the Desktop Commander + Filesystem MCP + windows-mcp stack with one focused tool.

Two files matter:

- [docs/design/mcp-winfs-spec.md](docs/design/mcp-winfs-spec.md) — the v1.0 specification (29 tools, hard invariants, error catalog, project structure, win-specifics). **Source of truth.**
- [prompts/cc-prompt-mcp-winfs-v0.1.md](prompts/cc-prompt-mcp-winfs-v0.1.md) — the build prompt for the v0.1 milestone. Read this first if asked to start implementing.

Both files are written in Russian. Implementation code, commit messages, and identifiers should be in English; user-facing messages and prompts follow the spec's language conventions.

## Spec amendment protocol

The spec is append-only above the `## Amendments` marker. **Never edit sections 1–10 in place** — record changes as dated entries at the bottom under `## Amendments` using the format `### YYYY-MM-DD — Title`. Later amendments can explicitly override earlier ones (see the two 2026-05-16 SDK amendments — the second overrides the first). When current behavior conflicts with an early section, check Amendments before assuming the section is authoritative.

When reference files (e.g., mcp-builder skill, SDK README) conflict with this spec, **the spec wins** — it is more specific to this use case. Use reference docs only to fill gaps.

## Architecture locks (do not relitigate without an amendment)

- **SDK: V1 stable.** `@modelcontextprotocol/sdk@^1.29.0`, Zod v3, V1 import paths (`@modelcontextprotocol/sdk/server/index.js`, `/server/stdio.js`, `/types.js`). V2 is pre-alpha as of 2026-05-16 — Appendix A in the spec describes V2 as a future migration target only.
- **Transport: stdio only.** No HTTP, no ports.
- **Runtime: Node ≥18, invoked as `node dist/index.js` directly.** Never `npx` — known Windows breakage.
- **Language: TypeScript strict mode**, Zod for all input schemas, no untagged `any`.
- **Error model: structured errors as tool-response content, never throws** in tool handlers. Throws are only for Zod-level programmer errors. Use `errors.build(code, details)` (see error catalog in spec §5).
- **Atomic writes:** temp file → fsync → rename. NTFS-atomic on a single volume.
- **Config is static.** No runtime mutation tools (`set_config_value`, `block_command`, etc.) — this is an explicit anti-prompt-injection decision.

## Hard invariants (spec §2)

These are enforced in `core/`, not per-tool, and cannot be bypassed via args:

1. UTF-8 native I/O; BOM stripped on read, never written.
2. `fs.realpath()` → `allowedRoots` prefix check on every path. Protects against junction/symlink/`..` escape.
3. Bounded timeouts (default 10s, max 60s; shell 30s/5min). On timeout: kill child + return `ETIMEDOUT`. Never hang.
4. `edit_file` requires `old_text` to match exactly once — no fuzzy matching.
5. Git tools are hard read-only (argument-level deny + `simple-git` read-only methods only).
6. `execute_command` regex blocklist validated **before** spawn.
7. `check_env` returns only `{present, length, prefix4}` — never full value.
8. `fetch_url`: host allowlist + internal-IP denylist + 5MB / 15s hard caps + http(s) only.
9. Audit log (JSONL) with arg sanitization (write/append bodies → `<redacted: N bytes>`).

## Phased delivery

Current target is v0.1 (per the build prompt): tools `read`, `write`, `append`, `list`, `stat`, plus the full `core/` infrastructure and all hard invariants. **Do not implement v0.2+ tools** (move/copy/mkdir, grep/glob, edit_file, git, exec, network) unless explicitly asked — the spec's §7 phasing exists to keep scope bounded.

Project structure when scaffolded follows spec §6 exactly (`src/core/`, `src/tools/{fs,search,editor,slicing,git,exec,system,network}/`, `src/schemas/`, `tests/{unit,invariants,integration}/`, `evals/`, `configs/`).

## Windows-specific gotchas the spec already calls out

- Claude Desktop MSIX install virtualizes the config path to `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` — the in-app "Edit Config" button may open the wrong file.
- `config.json` must be UTF-8 **without** BOM. PowerShell's `Set-Content -Encoding UTF8` adds a BOM and breaks `JSON.parse`. Use `Out-File -Encoding utf8NoBOM` or an editor with explicit control.
- For `execute_command` PowerShell calls, prefix every command with `chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8` — Win10 PowerShell defaults to CP1251/CP866 in stdout.

## Workflow conventions (from the build prompt)

- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). One logical step = one commit; no 20-file commits.
- Use `structuredContent` in tool responses alongside `content: [{type: "text", ...}]` so the client can read structured output without re-parsing the text payload.
- `outputSchema` is mandatory for any tool with non-trivial return (read, list, stat, …).
- No `console.log` in production code — only the structured audit log.
- If a spec requirement is ambiguous, add an entry under `## Open Questions` in the spec via an amendment and ask. Do not silently pick an interpretation.
- If stuck on an acceptance criterion for >30 min, stop and report the symptom rather than rat-holing.
