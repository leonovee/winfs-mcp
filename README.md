# mcp-winfs

A focused MCP server for the Windows 10/11 filesystem. Built to replace the
Desktop Commander + Filesystem MCP + windows-mcp stack with one tool that
has hard-bounded timeouts, allowed-roots enforcement, atomic writes and a
UTF-8-no-BOM invariant.

**Status:** v0.4 — 18 tools (5 core from v0.1 + 5 mutations / batch /
introspection from v0.2 + 4 search / self-recovery from v0.3 + 4
editor / slicing / diff / tail from v0.4) and the full core/ invariant
layer. v0.5+ adds the remaining 11 tools per
`docs/design/mcp-winfs-spec.md` §7.

## Install

```powershell
git clone <repo-url> mcp-winfs
cd mcp-winfs
npm install
npm run build
```

Requires Node ≥ 18.

## Configure

The server reads its config from a JSON file. By default it looks at
`%LOCALAPPDATA%\mcp-winfs\config.json`; override with `--config <path>`.

Minimum viable config:

```json
{
  "allowedRoots": [
    "C:\\Users\\you\\Desktop\\my-project"
  ]
}
```

Every other field defaults to spec §3 values (10s timeouts, 10 MB read cap,
audit at `%LOCALAPPDATA%\mcp-winfs\audit.jsonl`, …). See `configs/default.json`
for the full schema.

**The config file MUST be UTF-8 without a BOM.** `Set-Content -Encoding UTF8`
in PowerShell adds a BOM and breaks `JSON.parse`. Safe write:

```powershell
$json | Out-File -FilePath "$env:LOCALAPPDATA\mcp-winfs\config.json" -Encoding utf8NoBOM
```

## Setup in Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (or, on MSIX installs,
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
— Claude Desktop's "Edit Config" button can open the wrong file):

```json
{
  "mcpServers": {
    "winfs": {
      "command": "node",
      "args": [
        "C:\\tools\\mcp-winfs\\dist\\index.js",
        "--config",
        "C:\\Users\\you\\AppData\\Local\\mcp-winfs\\config.json"
      ]
    }
  }
}
```

Use absolute paths for both `dist/index.js` and the config. **Do not use
`npx`** — it is a known cause of MCP connection failures on Windows.

Restart Claude Desktop. The five v0.1 tools (`read`, `write`, `append`,
`list`, `stat`) should appear in the tools list.

## Tools (v0.4)

### Core FS (v0.1)

| Tool   | Read-only | What it does                                              |
|--------|-----------|-----------------------------------------------------------|
| read   | yes       | Read a UTF-8 file with optional `range:[start,end]` and `max_bytes`. BOM stripped on read. |
| write  | no        | Atomic full-file write (temp + fsync + rename). Never writes a BOM. |
| append | no        | Atomic append. Reads → concatenates → atomic-writes the combined buffer. |
| list   | yes       | Recursive directory listing with `max_depth` ≤ 5 and basename glob. |
| stat   | yes       | Path metadata. Returns `{exists:false}` instead of `ENOENT` for missing paths. |

### Mutations + batch + introspection (v0.2)

| Tool                       | Read-only | What it does                                                                |
|----------------------------|-----------|-----------------------------------------------------------------------------|
| `mkdir`                    | no        | Create a directory. `recursive:true` (default) → `mkdir -p` semantics: idempotent on existing dir. |
| `move`                     | no        | Rename / move within allowedRoots. Atomic `fs.rename` by default; opt in to a non-atomic copy+delete fallback for cross-volume moves with `allow_cross_volume:true` (response `atomic` flag tells you which path ran). |
| `copy`                     | no        | Recursive copy. Each entry realpath-checked; junction/symlink escape or dangling links are skipped and reported in `files_skipped + skipped_paths` (cap 10). Full skip count goes to the audit log even when the user-visible array is capped. |
| `read_multiple_files`      | yes       | Batch read 1..50 paths in parallel with per-file timeout. Per-file errors propagate inside `files[]`; top-level call never `isError`. |
| `list_allowed_directories` | yes       | Self-orientation. Returns `{allowed_roots, allowed_url_hosts}` only — never leaks blocklists, timeouts, or audit path. |

### Search + self-recovery (v0.3)

| Tool          | Read-only | What it does                                                                |
|---------------|-----------|-----------------------------------------------------------------------------|
| `glob`        | yes       | Find files matching an absolute glob (`*`, `?`, `**`, `[...]`; no brace expansion). Pattern's literal prefix must be inside allowedRoots. Default cap 200, hard cap 2000 → `truncated:true`. |
| `grep`        | yes       | Regex search across files matching a glob, with `case_sensitive` flag, `context_lines` (0..10) and `max_matches`. Pattern compiled with `new RegExp` — no `eval`. Deadline returns partial results with `{truncated:true, reason:"timeout"}` instead of erroring. |
| `read_json`   | yes       | Read + `JSON.parse` in one call. Distinct `EBADJSON` code for parse failures (with line / column / snippet). Inherits `read`'s allowedRoots, BOM and `ETOOLARGE` semantics. |
| `audit_tail`  | yes       | Tail the structured audit log for self-recovery after context loss. Reads from `%LOCALAPPDATA%\mcp-winfs\audit.jsonl` (the only legitimate exception to allowedRoots — gated by an absolute-path check, `.jsonl` extension check on both configured and `realpath`-resolved paths, and `fstat` against the bound file descriptor). Default 50, hard cap 500. |

### Editor + slicing + diff + tail (v0.4)

| Tool           | Read-only | What it does                                                                |
|----------------|-----------|-----------------------------------------------------------------------------|
| `read_section` | yes       | Slice a file by `line_range: [start, end]` (1-based) OR `byte_range: [start, end]` (0-based). UTF-8 byte ranges trim to valid boundaries (`adjusted: true`); `encoding: "raw"` returns base64. |
| `diff_files`   | yes       | Unified textual diff between two sides. Each side is exactly one of: file path or inline string. `format: "minimal"` returns a summary + first 20 changed lines. UTF-8 BOM stripped; binary → EENCODING. |
| `edit_file`    | no        | Atomic find-and-replace via `{old_str, new_str}` edits. Each `old_str` MUST appear exactly once (EUNIQUE on 0 or 2+). `dry_run: true` returns the diff without touching disk. Atomic write (temp + fsync + rename). |
| `read_since`   | yes       | Incremental tail. Caller passes a byte offset from a prior call, gets the delta. Rotation detected when the file shrank (`file_rotated: true`, returns whole file). UTF-8 boundary advance ≤ 3 bytes silent. |

Every tool returns pure-payload `structuredContent` that matches its
declared `outputSchema` 1:1 (no `ok` / `tool` envelope — see [v0.1.1
hotfix](docs/v0.2-backlog.md#1--structuredcontent-validation-mismatch-on-every-tool-response--resolved-in-v011)).
Array-output tools (`glob`, `grep`, `audit_tail`, `read_multiple_files`)
use a `{<plural>, total, ...flags}` envelope — see spec amendment §F.

## Hard invariants (always on)

- **UTF-8 native I/O.** BOM stripped on read; never written.
- **Realpath → allowed-roots check.** Every path is canonicalised before the
  prefix check, so junction/symlink/`..`-escape attempts resolve to
  `EPERM_ROOT`. Paths *outside* `allowedRoots` get `EPERM_ROOT` regardless
  of whether the file exists — no existence-leak channel.
- **Bounded timeouts.** Default 10 s, max 60 s. On expiry the in-flight
  task is aborted and a structured `ETIMEDOUT` returned. Never hangs.
- **Atomic writes.** `write` and `append` go through `temp → fsync → rename`,
  which is atomic on a single NTFS volume.
- **Structured errors as content.** Tool handlers never throw — every error
  comes back as `{ok:false, error:{code, message, hint?}}` with one of the
  codes from spec §5.
- **Audit log.** Every call appends a JSONL record to `auditLogPath`. The
  `content` field on `write`/`append` is replaced with `<redacted: N bytes>`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Failed to load config at <path>` on startup | Config file has a UTF-8 BOM (Notepad / `Set-Content -Encoding UTF8` writes one). | Re-save with `Out-File -Encoding utf8NoBOM` or an editor that lets you turn the BOM off. |
| Claude Desktop reports "MCP server failed to start", no logs | `"command": "node"` resolved to a `node.exe` that isn't on PATH from the MSIX-virtualised session. The inherited PATH does not resolve `node` for child processes under MSIX virtualisation. | Use the absolute path: `"command": "C:\\Program Files\\nodejs\\node.exe"`. |
| `Cannot find module` or hash-bang errors | Built with the wrong Node version (< 18) or `dist/` not built. | `node --version` → ≥ 18, then `npm run build`. |
| Every call returns `EPERM_ROOT` | No `allowedRoots` configured or paths refer to a drive letter the user lacks read access to. | Call `list_allowed_directories` to see what's actually configured, or check the `configPath` field on the startup log on stderr. |
| Audit log isn't appearing | `%LOCALAPPDATA%` not set (unusual) or path contains literal `%LOCALAPPDATA%`. | Set the env var or use an absolute `auditLogPath` in the config. |
| Inspector says "No servers found" when launched with `--config configs/local.json` | Inspector consumes `--config` as its own flag and expects a list-of-servers JSON. | Add the `--` separator so the flag reaches mcp-winfs: `npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json`. |
| Strict config schema rejects `_comment` keys | The Zod schema is `.strict()` — no JSON-native commentary. | Move documentation to `configs/README.md` or to neighbouring `.md` notes. |

### Local working config

`configs/default.json` ships as a placeholder template. The recommended
dev loop is to copy it to `configs/local.json` (gitignored) with real
`allowedRoots` paths and point both Inspector and Claude Desktop at the
local file:

```powershell
Copy-Item configs/default.json configs/local.json
# edit configs/local.json with your real paths …
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

## Tests

```powershell
npm test          # vitest run
npm run test:watch
```

v0.4 ships 179 tests in 33 files: per-tool happy path + every error code
across 18 tools, plus invariants (UTF-8 roundtrip, junction/`..` escape,
timeout abort + grep partial-result + edit_file ETIMEDOUT, atomic-write
integrity + edit_file dry-run-no-temp / rename-failure-no-leak, audit
redaction, both-roots check for mutations, structuredContent shape across
all 18 tools, audit_tail privileged-read boundary + TOCTOU close).

## Acceptance reports

- v0.1: [`docs/v0.1-acceptance.md`](docs/v0.1-acceptance.md)
- v0.2: [`docs/v0.2-acceptance.md`](docs/v0.2-acceptance.md)
- v0.3: [`docs/v0.3-acceptance.md`](docs/v0.3-acceptance.md)
- v0.4: [`docs/v0.4-acceptance.md`](docs/v0.4-acceptance.md)

## Roadmap

`docs/design/mcp-winfs-spec.md` §7 has the full phasing:

- ✅ **v0.1** — `read`, `write`, `append`, `list`, `stat`
- ✅ **v0.2** — `mkdir`, `move`, `copy`, `read_multiple_files`, `list_allowed_directories`
- ✅ **v0.3** — `grep`, `glob`, `read_json`, `audit_tail`
- ✅ **v0.4** — `read_section`, `diff_files`, `edit_file` (with `dry_run`), `read_since`
- **v0.5** — git read-only (`log`, `status`, `diff`, `show`, `blame`)
- **v0.6** — `execute_command`, `run_python`, `run_pytest`
- **v0.7** — `find_command`, `check_env`, `fetch_url`
- **v1.0** — MCPB packaging + full eval suite (10 questions, ≥ 80 % pass)
