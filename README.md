# mcp-winfs

A focused MCP server for the Windows 10/11 filesystem. Built to replace the
Desktop Commander + Filesystem MCP + windows-mcp stack with one tool that
has hard-bounded timeouts, allowed-roots enforcement, atomic writes and a
UTF-8-no-BOM invariant.

**Status:** v0.1 — 5 tools (`read`, `write`, `append`, `list`, `stat`) and
the full core/ invariant layer. v0.2+ adds the remaining 24 tools per
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

## Tools (v0.1)

| Tool   | Read-only | What it does                                              |
|--------|-----------|-----------------------------------------------------------|
| read   | yes       | Read a UTF-8 file with optional `range:[start,end]` and `max_bytes`. BOM stripped on read. |
| write  | no        | Atomic full-file write (temp + fsync + rename). Never writes a BOM. |
| append | no        | Atomic append. Reads → concatenates → atomic-writes the combined buffer. |
| list   | yes       | Recursive directory listing with `max_depth` ≤ 5 and basename glob. |
| stat   | yes       | Path metadata. Returns `{exists:false}` instead of `ENOENT` for missing paths. |

Every tool returns `structuredContent` so a client can read the result
without re-parsing the textual representation.

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
| Claude Desktop reports "MCP server failed to start", no logs | `"command": "node"` resolved to a `node.exe` that isn't on PATH from the MSIX-virtualised session. | Use the absolute path: `"C:\\Program Files\\nodejs\\node.exe"`. |
| `Cannot find module` or hash-bang errors | Built with the wrong Node version (< 18) or `dist/` not built. | `node --version` → ≥ 18, then `npm run build`. |
| Every call returns `EPERM_ROOT` | No `allowedRoots` configured or paths refer to a drive letter the user lacks read access to. | Run the `list_allowed_directories` tool (v0.2+) or check `configPath` field of the startup log on stderr. |
| Audit log isn't appearing | `%LOCALAPPDATA%` not set (unusual) or path contains literal `%LOCALAPPDATA%`. | Set the env var or use an absolute `auditLogPath` in the config. |

## Tests

```powershell
npm test          # vitest run
npm run test:watch
```

v0.1 ships 44 tests: 27 unit (per-tool happy path + every error code) and
17 invariant (UTF-8 roundtrip, junction/`..` escape, timeout abort,
atomic-write integrity, audit redaction).

## Acceptance report

See [`docs/v0.1-acceptance.md`](docs/v0.1-acceptance.md) for the v0.1
acceptance criteria checklist with evidence per item.

## Roadmap

`docs/design/mcp-winfs-spec.md` §7 has the full phasing:

- **v0.2** — `move`, `copy`, `mkdir`, `read_multiple_files`, `list_allowed_directories`
- **v0.3** — `grep`, `glob`, `read_json`, `audit_tail`
- **v0.4** — `edit_file` (with `dry_run`), `read_section`, `read_since`, `diff_files`
- **v0.5** — git read-only (`log`, `status`, `diff`, `show`, `blame`)
- **v0.6** — `execute_command`, `run_python`, `run_pytest`
- **v0.7** — `find_command`, `check_env`, `fetch_url`
- **v1.0** — MCPB packaging + full eval suite (10 questions, ≥ 80 % pass)
