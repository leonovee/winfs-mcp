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

## Configuration

The server reads its runtime config from
`%LOCALAPPDATA%\mcp-winfs\config.json` (typically
`C:\Users\<USER>\AppData\Local\mcp-winfs\config.json`); override with
`--config <path>`. **The file is not created automatically** — until it
exists, the server starts with empty `allowedRoots` and every path-bound
tool returns `EPERM_ROOT` with a hint pointing at this same path.

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
for the full schema and `configs/README.md` for the dev-fixture vs runtime
distinction.

**`configs/default.json` and `configs/local.json` in the repository are
development-time fixtures and are NOT loaded at runtime** — they exist for
tests and as a schema reference. Do not edit them expecting changes to take
effect; edit `%LOCALAPPDATA%\mcp-winfs\config.json` instead.

**The config file MUST be UTF-8 without a BOM.** `Set-Content -Encoding UTF8`
in PowerShell adds a BOM and breaks `JSON.parse`. Safe write:

```powershell
$json | Out-File -FilePath "$env:LOCALAPPDATA\mcp-winfs\config.json" -Encoding utf8NoBOM
```

**Hot-reload of `allowedRoots` (v0.10).** The runtime config file (the
`--config` path when given, otherwise `%LOCALAPPDATA%\mcp-winfs\config.json`)
is watched live: edit `allowedRoots` and the new roots take effect **without
restarting** the server. The edit is **validated before being applied** — a
malformed change (bad JSON, unknown key, failed validation such as
`shellMaxTimeoutMs < shellTimeoutMs`) is logged to stderr and the previous
config stays in force, so a bad edit never bricks the running server. The
reload preserves any MCP-Roots client roots (union semantics). **Only
`allowedRoots` hot-reloads**; all other fields (timeouts, byte caps,
blocklist, mode) still require a restart. When the server is running on
synthesised defaults (no config file on disk), nothing is watched.

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

### Stateful process management (v0.7 wave 2b)

The first long-lived shared mutable state in the server: an in-memory
`ProcessRegistry` plus four tools that operate on it. Sessions are
identified by uuidv4. Lifecycle: `running → exited | killed | timed_out
| spawn_failed`, then held for `processSessionTtlMs` (default 60 s)
before GC. Children are SIGKILL'd on SIGINT/SIGTERM via the
`registry.shutdown()` drain hook in `src/index.ts` (10 s hard
deadline). Sessions do NOT survive server restart — registry is
process-local in-memory only. See spec amendment §Z.

| Tool            | Read-only | What it does                                                              |
|-----------------|-----------|---------------------------------------------------------------------------|
| `start_process` | no        | `child_process.spawn(argv[0], argv.slice(1), { shell: false })` — returns immediately with `session_id`. Defenses parity with `execute_command`: composed argv blocklist, cwd in allowedRoots, sanitized exec env, per-session deadline (default 300 s / max 3600 s). Concurrency cap: 17th simultaneous running session → `EBUSY`. |
| `interact`      | no        | Long-poll read of session stdout/stderr from caller-supplied `*_since` offsets, optional `input` to stdin first, optional `finalize` to close stdin. `max_wait_ms` default 5 000 / max 60 000. Errors: `ENOSESSION` (id not in registry), `EPIPE_CLOSED` (input after finalize/settle). `input` is in `SENSITIVE_ARG_KEYS` — never persisted to audit. |
| `list_process`  | yes       | Enumerate sessions (both running and recently-settled within TTL). Returns `{ sessions, total }` sorted by `started_at` ASC. Useful for `kill_process` candidate discovery and for debugging stuck sessions. |
| `kill_process`  | no        | Terminate a session. `force: false` (default) → Windows `taskkill /T` / POSIX SIGTERM with 5 s grace before SIGKILL escalation. `force: true` → immediate `taskkill /F /T` / SIGKILL. Idempotent: already-settled session returns `was_already_settled: true` with `exit_code` preserved. |

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

### Process registry is in-memory only (v0.7 wave 2b)

The `ProcessRegistry` that backs `start_process` / `interact` /
`list_process` / `kill_process` lives entirely in the server process's
heap. Server restart **loses every session_id** — there is no
durable store. SIGINT / SIGTERM trigger a 10-second drain that
SIGKILLs every running child via `registry.shutdown()`, so workloads
don't leak past server exit, but in-flight session ids become
permanently invalid.

A second consequence: a single mcp-winfs process is the unit of
sharing. Spawning two server instances (e.g. one in Inspector + one
in Claude Desktop) means each has its own registry — a session
started in one is invisible to the other. This is by design (no
locking on a shared on-disk store), but worth flagging if you script
across multiple clients.

### Windows-flaky process tests (v0.7.1 patch scope)

10 tests under `tests/unit/process/*` exhibit intermittent failures on
Windows due to EBUSY-on-rmdir during `afterEach` cleanup races (the
test's temp directory is removed before the child process has fully
released its handles) and timing-sensitive process-state assertions
(`expected 'running' to be 'timed_out'` — a 1-second
`Start-Sleep` deadline that V8 sometimes evaluates a few ms early).
Production code is correct: the v0.7 smoke harness exercises
`start_process` / `interact` / `list_process` / `kill_process` at the
wire level and all 9 wave-2b probes pass deterministically. The
flakiness is a test-side reliability issue scheduled for the v0.7.1
patch wave (EBUSY retry with backoff on Windows tempdir removal,
event-driven `waitForStatus` assertions in place of timeout-driven
ones). **CI workaround:** rerun the affected suite; failures do not
indicate a regression in production behavior.

### Deferred v0.7 review-wave findings (v0.7.1 patch scope)

The v0.7 pre-tag external review wave produced ~15 P2 findings (full
consolidation files at `audit/external_reviews/v0.7-pre-tag/`) that
are deferred to v0.7.1. None are production-blocking; all are
quality-of-implementation hardening. Highlights:

- `fetch_url` truncated-flag rewire (currently dead code in success path).
- `fetch_url` gzip silent-corruption when server ignores
  `Accept-Encoding: identity` — surface an `EENCODING` instead.
- `fetch_url` `EMAXREDIRECTS` code (currently reuses `EHOSTNOTALLOWED`
  for redirect-chain overflow — semantically wrong).
- `fetch_url` 3xx body early-destroy (saves up to 15 MB per chain).
- `edit_file` UTF-8 boundary in diff truncation (cuts mid-multibyte
  sequence on non-ASCII content).
- `edit_file` TOCTOU fd-bound read side (apply audit_tail v0.3.2
  pattern to the read leg of edit_file).
- `grep` stream pagination memory (`searchFileFull` accumulates all
  matches before slicing — moderate refactor).
- `grep` unified `truncated` semantics across timeout / max_matches /
  ceiling (design call needed first).

See `audit/external_reviews/v0.7-pre-tag/_findings_*.md` for the
per-surface consolidation, including which reviewer(s) raised each
finding and the recommended fix sketch.

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
| `No result received … after waiting 4 minutes` on a tool call | Intermittent stall in the Claude Desktop ↔ winfs stdio transport (not winfs processing — ruled out 3×). Recovery pattern: 2–3 timeouts then instant success. | Retry once or twice; if it persists, fully exit Claude Desktop via the tray and relaunch. To diagnose, enable `WINFS_TRANSPORT_LOG` (below). |

### Diagnosing the 4-minute transport hang (`WINFS_TRANSPORT_LOG`)

Set the `WINFS_TRANSPORT_LOG` environment variable to a file path to enable
opt-in, **metadata-only** request/response logging at the transport boundary:

```jsonc
// in claude_desktop_config.json, on the winfs mcpServers entry:
"env": { "WINFS_TRANSPORT_LOG": "C:\\path\\to\\winfs\\.transport.log" }
```

When set, winfs appends one line per inbound request and outbound response:

```
<ISO ts> RECV <id> <method> <bytes>
<ISO ts> SEND <id> <status> <bytes> <duration-ms>
```

- **Off by default.** Unset → zero overhead, no behavior change.
- **Never logs bodies** — only timestamp, JSON-RPC id, method, byte count,
  status, and winfs processing duration. No file contents, no command output,
  no secrets.
- Correlate it with Claude Desktop's own `%APPDATA%\Claude\logs\mcp-server-winfs.log`
  using `node scripts/analyze-transport-hang.mjs <winfs-log> <cd-log>` to see the
  per-leg timeline and localize which leg of the transport stalls. Full
  protocol: [`audit/investigations/v0.9-transport-hang.md`](audit/investigations/v0.9-transport-hang.md).

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

#### `sshExePath` — ssh binary (auto-detected; override for non-standard installs)

Since v0.10.1 `sshExePath` is **optional**. When unset, `ssh_exec`
**auto-detects** the ssh binary, preferring the Git-bundled
`C:\Program Files\Git\usr\bin\ssh.exe` over `C:\Windows\System32\OpenSSH\ssh.exe`
(the System32 client exits 255 on some hosts), then PATH. Set `sshExePath`
explicitly to pin a specific binary — for example MSYS2 at
`C:\msys64\usr\bin\ssh.exe`:

```json
{
  "allowedRoots": ["C:\\Users\\me\\src"],
  "sshExePath": "C:\\Program Files\\Git\\usr\\bin\\ssh.exe"
}
```

Note that `configs/local.json` is gitignored; create or edit it as
needed for your machine. An explicitly-set `sshExePath` is used strictly:
`ssh_exec` returns `ESSHNOTFOUND` if it does not exist on disk, so a typo is
caught at the first call rather than silently falling back to auto-detect.

#### `execExtraPathDirs` — extra PATH dirs for non-standard tool installs

`execute_command` / `run_python` / `run_pytest` run with a **sanitized** PATH
(System32, the standard Git/Node/PowerShell locations, optional `pythonHome`) —
the user's `$PATH` is deliberately not inherited. If a tool lives elsewhere
(portable Git, MSYS2, a chocolatey shim), add its directory to
`execExtraPathDirs` so bare-name resolution finds it:

```json
{
  "allowedRoots": ["C:\\Users\\me\\src"],
  "execExtraPathDirs": ["C:\\tools\\git\\cmd", "C:\\msys64\\usr\\bin"]
}
```

#### `powershellExePath` override (PowerShell binary selection)

By default `execute_command` and `find_command` resolve the PowerShell
binary in this order:

1. `config.powershellExePath` if set and the file exists
2. `pwsh.exe` (PowerShell 7+) auto-detected via `where pwsh` — the
   Microsoft Store shim (`WindowsApps\pwsh.exe`) is skipped
3. `powershell.exe` (Windows PowerShell 5.1, always present)

To pin a specific install:

```json
{
  "allowedRoots": ["C:\\Users\\me\\src"],
  "powershellExePath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
}
```

All hardening flags (`-NoProfile`, `-NonInteractive`, `-OutputFormat Text`,
`-InputFormat None`) are honored identically by both binaries, so the
swap is transparent. If the configured path doesn't exist, a warning is
written to stderr and auto-detect runs as a fallback.

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
