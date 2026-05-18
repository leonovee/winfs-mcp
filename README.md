# mcp-winfs

A focused MCP server for the Windows 10/11 filesystem. Built to replace the
Desktop Commander + Filesystem MCP + windows-mcp stack with one tool that
has hard-bounded timeouts, allowed-roots enforcement, atomic writes and a
UTF-8-no-BOM invariant.

**Status:** v0.7 wave 1 (unreleased) — **33 tools** (5 core from v0.1 + 5
mutations / batch / introspection from v0.2 + 4 search / self-recovery from
v0.3 + 4 editor / slicing / diff / tail from v0.4 + 11 git / exec / system /
network from v0.5 + 1 byte-offset chunked write from v0.6 + 3 consumer-agent
adds from v0.7 wave 1: `ssh_exec`, `list_path_dirs`, `write_json`) and the
full core/ invariant layer. v0.6 also adds the opt-in
`unrestrictedFilesystem` mode (see config reference below) and the
`edit_file.edits[].expected_count` extension (see spec amendment §W).
The main v0.7 DC-parity wave (features A–D in the roadmap) is still
roadmap-only.

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

### ⚠️ Unrestricted filesystem mode (v0.6, opt-in)

For development sandboxes and automated agent VMs where filesystem-wide
access is the explicit goal, v0.6 adds an opt-in mode that bypasses the
`allowedRoots` check entirely. **NEVER use this in production on a
multi-tenant host. NEVER use it when the server is exposed to untrusted
callers.** The magic-confirm mechanism prevents accidental enable; it
does NOT make the mode safe for adversarial environments.

To enable, add BOTH fields to your config (exact match on the confirm
string is required — anything else throws at startup):

```json
{
  "allowedRoots": ["..."],
  "unrestrictedFilesystem": true,
  "unrestrictedFilesystemConfirm": "I-UNDERSTAND-THE-RISK"
}
```

When unrestricted, the server prints a 3-line stderr banner at startup
and the ready line includes `mode=unrestricted`. Every mutation tool's
audit-log entry carries a top-level `mode: "unrestricted"` field so
post-hoc forensic queries can extract every write that ran outside
`allowedRoots`. The first audit-log entry of the session is a
`_server_start` sentinel record carrying `server_mode` in
`args_summary` (the `_` prefix is reserved for audit-subsystem events;
real tools never use it).

**Other defenses stay in force in unrestricted mode**: exec blocklist,
`check_env` safe-prefix, `fetch_url` SSRF defense, audit redaction,
atomic writes, bounded timeouts. Unrestricted only short-circuits the
`allowedRoots` check.

See spec [§U](docs/design/mcp-winfs-spec.md) for the full threat-model
discussion and invariants #28–#30.

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

## Tools (v0.6)

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
| `edit_file`    | no        | Find-and-replace via `{old_str, new_str, expected_count?}` edits, atomic write per edit. **v0.6:** `expected_count` (default 1) supports occurrence-count assertions — 0 = "must be absent" (assertion-only), N ≥ 2 = replace all N occurrences atomically. Mismatch → `EUNIQUE` with `details.{occurrences_found, expected_count}`. `dry_run: true` returns the diff without touching disk. Atomic write (temp + fsync + rename). |
| `read_since`   | yes       | Incremental tail. Caller passes a byte offset from a prior call, gets the delta. Rotation detected when the file shrank (`file_rotated: true`, returns whole file). UTF-8 boundary advance ≤ 3 bytes silent. |

### Git read-only (v0.5)

| Tool         | Read-only | What it does                                                                |
|--------------|-----------|-----------------------------------------------------------------------------|
| `git_status` | yes       | Porcelain v2 parse → `{branch, ahead, behind, staged, modified, untracked, conflicted, detached}`. Mutation flags hard-denied by `git_safety`. |
| `git_log`    | yes       | Up to `count` commits with optional `range` and `path_filter`. Range / pathspec args validated (no leading `-`, no NUL / control chars; pathspec passed after `--`). |
| `git_show`   | yes       | Single revision → metadata + diff + files_changed. **`sha` requires hex (4–64 chars), NOT symbolic names like `HEAD`** — resolve via git_log first. |
| `git_diff`   | yes       | Unified diff + `--numstat`-derived stats between two revs (or rev vs worktree). |
| `git_blame`  | yes       | Per-line blame via `--line-porcelain`. Range capped at 10 000 lines. **`path` must be ABSOLUTE.** |

### Subprocess execution (v0.5)

| Tool              | Read-only | What it does                                                                |
|-------------------|-----------|-----------------------------------------------------------------------------|
| `execute_command` | no        | PowerShell dispatch. Pre-spawn blocklist (Remove-Item -Recurse, format, bcdedit, etc.) + sanitized PATH + bounded I/O capture (1 MB / stream default) + process tree kill on timeout. `cwd` must be inside allowedRoots. Hardcoded denylist is additive-only via `config.execExtraBlocklist`. |
| `run_python`      | no        | `{mode: "inline", script}` runs `python -c <script>`. `{mode: "file", path}` runs `python <path>`. **No `args: ["-c", ...]` shape** — that's `execute_command` territory. Python binary resolved via `config.pythonHome` (else falls back to sanitized PATH). |
| `run_pytest`      | no        | `python -m pytest` in `cwd`. Summary line parsed into structured counts; `count_only: true` invokes `--collect-only`. Unrecognized output → `EPARSE`. |

### System + network (v0.5)

| Tool           | Read-only | What it does                                                                |
|----------------|-----------|-----------------------------------------------------------------------------|
| `find_command` | yes       | PowerShell `Get-Command` lookup. `with_version: false` (default) returns only path. `with_version: true` invokes the binary with `--version` (opt-in — extra attack surface). |
| `check_env`    | yes       | Safe-prefix only: `{present, length, prefix}` where `prefix.length ∈ {0, 4}`. Mathematically bounded — the full value NEVER returned regardless of length. |
| `fetch_url`    | yes       | HTTP/HTTPS GET. Two-layer SSRF defense (host whitelist → DNS resolve → internal-IP deny; connect-by-IP + manual Host header against rebinding). 3-redirect chain re-validated at every hop. 5 MB / 15 s hard caps. `User-Agent` / `Accept` / `Accept-Language` only — `Authorization` etc. → `EINVAL`. |

### Byte-offset file I/O (v0.6)

| Tool          | Read-only | What it does                                                                |
|---------------|-----------|-----------------------------------------------------------------------------|
| `write_chunk` | no        | **⚠️ NOT atomic.** Opens with `r+`, writes payload at `offset`, closes — no temp file, no fsync, no rename. Response carries literal `atomic: false`. Designed for surgical edits on huge files. `offset > file_size_before` → `EOFFSET` (no sparse-file creation). UTF-8 boundary check at offset + offset+content_length (toggle via `validate_byte_range: false`). Mid-multibyte → `EENCODING`. Use `write` for atomic whole-file replacement. |

### Consumer-agent feedback adds (v0.7 wave 1)

| Tool             | Read-only | What it does                                                                |
|------------------|-----------|-----------------------------------------------------------------------------|
| `ssh_exec`       | no        | First-class SSH. Spawns `ssh.exe` directly via `child_process.spawn` — no shell, no PowerShell wrapper. `host` must be a Host alias resolvable via `ssh -G` against `~/.ssh/config`; raw `user@host` rejected. Sidesteps three stacked failures that block ssh through `execute_command` (PATH sanitization, PS document-in-pipeline, silent-stdout bug #2). 4 KB per-stream output cap; `timeout_seconds` default 30 / max 300. Errors: `ESSHNOTFOUND`, `EHOST_UNKNOWN`, `ETIMEDOUT`, `EIO`. See spec amendment §X. |
| `list_path_dirs` | yes       | Returns the sanitized PATH array that `execute_command` / `find_command` / `run_python` / `run_pytest` / `ssh_exec` inherit. Use it to debug "why is binary X invisible" — if a directory isn't in this list, subprocesses can't see binaries in it. No input args. |
| `write_json`     | no        | Atomic JSON write, symmetric to v0.3 `read_json`. `path` must end in `.json` (case-insensitive, validated on both supplied path and realpath). `value: unknown` is `JSON.stringify`-d (with `indent` 0..10, default 2); trailing newline appended; atomic temp + fsync + rename. `overwrite: false` by default (safer than v0.1 `write`). New error: `EEXT_NOT_JSON`. |

Every tool returns pure-payload `structuredContent` that matches its
declared `outputSchema` 1:1 (no `ok` / `tool` envelope — see [v0.1.1
hotfix](docs/v0.2-backlog.md#1--structuredcontent-validation-mismatch-on-every-tool-response--resolved-in-v011)).
Array-output tools (`glob`, `grep`, `audit_tail`, `read_multiple_files`,
`git_log`, `git_blame`) use a `{<plural>, total, ...flags}` envelope —
see spec amendment §F.

## Known limitations

### Audit-log content truncation

The audit log is a forensic trail, not a content store. To keep secrets out of
the log, every mutation entry truncates user-supplied content before write:
`write` / `append` payloads are recorded as a 256-character prefix
(`content_prefix`) plus a full byte count (`content_length`); `execute_command`
/ `run_python` / `run_pytest` stdout and stderr are recorded as 4-KB prefixes
per stream. Reading the audit log via `audit_tail` therefore tells you **what
ran and roughly what came back**, not what was written or printed in full. Do
not use the audit log as a verification channel for "did file X end up with the
exact bytes I sent" — re-`read` the file instead.

### Remote command execution gap (resolved in v0.7)

`execute_command` cannot reliably invoke `ssh.exe` on this Windows host. Three
problems stack: (1) the sanitized PATH does not include
`C:\Windows\System32\OpenSSH`, so `find_command name="ssh"` returns
`{found: false}`; (2) PowerShell rejects `& 'C:\Windows\System32\OpenSSH\ssh.exe' ...`
in pipelines with `Cannot run a document in the middle of a pipeline`
(file-association quirk); (3) even direct invocation produces empty stdout
with exit 0 — known bug #2 in `CLAUDE.md`. The v0.7 `ssh_exec` tool replaces
this path by spawning `ssh.exe` via `child_process.spawn` directly, with hosts
whitelisted from `~/.ssh/config`. For v0.6.x users: invoke ssh from outside
the MCP server.

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

v0.6 ships 293 tests in 52 files: per-tool happy path + every error code
across 30 tools, plus invariants (UTF-8 roundtrip, junction/`..` escape,
timeout abort + grep partial-result + edit_file ETIMEDOUT, atomic-write
integrity + edit_file dry-run-no-temp / rename-failure-no-leak +
write_chunk non-atomic contract, audit redaction, both-roots check for
mutations, structuredContent shape across all 30 tools, audit_tail
privileged-read boundary + TOCTOU close, exec blocklist enforcement,
check_env safe-prefix mathematical bound, fetch_url SSRF defense,
unrestricted-mode short-circuit + audit `mode` field).

## Acceptance reports

- v0.1: [`docs/v0.1-acceptance.md`](docs/v0.1-acceptance.md)
- v0.2: [`docs/v0.2-acceptance.md`](docs/v0.2-acceptance.md)
- v0.3: [`docs/v0.3-acceptance.md`](docs/v0.3-acceptance.md)
- v0.4: [`docs/v0.4-acceptance.md`](docs/v0.4-acceptance.md)
- v0.5.1: [`docs/v0.5.1-acceptance.md`](docs/v0.5.1-acceptance.md) (the `v0.5.0` tag is a phantom — reviewers should clone `--branch v0.5.1`)
- v0.6: [`docs/v0.6-acceptance.md`](docs/v0.6-acceptance.md)

## Roadmap

`docs/design/mcp-winfs-spec.md` §7 has the full phasing. The §4 tool
surface is COMPLETE at v0.6 (30 tools); v0.7+ adds no new tools.

- ✅ **v0.1** — `read`, `write`, `append`, `list`, `stat`
- ✅ **v0.2** — `mkdir`, `move`, `copy`, `read_multiple_files`, `list_allowed_directories`
- ✅ **v0.3** — `grep`, `glob`, `read_json`, `audit_tail`
- ✅ **v0.4** — `read_section`, `diff_files`, `edit_file` (with `dry_run`), `read_since`
- ✅ **v0.5.1** — `git_status`, `git_log`, `git_show`, `git_diff`, `git_blame`, `execute_command`, `run_python`, `run_pytest`, `find_command`, `check_env`, `fetch_url` (the v0.5.0 tag is a phantom; see acceptance doc for reconciliation)
- ✅ **v0.6** — `write_chunk` + `edit_file.expected_count` extension + `unrestrictedFilesystem` mode
- 🟡 **v0.7 wave 1** (unreleased, on `main`) — `ssh_exec`, `list_path_dirs`, `write_json`. Consumer-agent feedback adds from the 2026-05-18 ecom session. Spec amendment §X.
- **v0.7 main wave** — roadmap: DC-parity features (persistent shells via `start_process` + `interact_with_process`, async `grep` pagination, `list_processes` + `kill_process`, `edit_file` char-level diff on near-miss `EUNIQUE`). See [`prompts/cc-prompt-mcp-winfs-v0.7-roadmap.md`](prompts/cc-prompt-mcp-winfs-v0.7-roadmap.md).
- **v1.0** — MCPB packaging + full eval suite (10 questions, ≥ 80 % pass) + production README rewrite. No new tools.
