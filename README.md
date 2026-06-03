# mcp-winfs

[![CI](https://github.com/leonovee/winfs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/leonovee/winfs-mcp/actions/workflows/ci.yml)

A focused MCP server for the Windows 10/11 filesystem. Built to replace the
Desktop Commander + Filesystem MCP + windows-mcp stack with one tool that
has hard-bounded timeouts, allowed-roots enforcement, atomic writes and a
UTF-8-no-BOM invariant.

**Status:** **v0.10.3** — **39 tools** (5 core from v0.1 + 5 mutations / batch /
introspection from v0.2 + 4 search / self-recovery from v0.3 + 4 editor /
slicing / diff / tail from v0.4 + 11 git / exec / system / network from v0.5 +
1 byte-offset chunked write from v0.6 + 3 consumer-agent adds from v0.7 wave 1
(`ssh_exec`, `list_path_dirs`, `write_json`) + 4 process-control tools from
v0.7 wave 2b (`start_process`, `interact`, `list_process`, `kill_process`) + 2
filesystem-parity tools from v0.8 (`directory_tree`, `read_media_file`)) on top
of the full core/ invariant layer. Also ships MCP-Roots support (v0.9), an
opt-in `unrestrictedFilesystem` mode, and live hot-reload of `allowedRoots`
(v0.10). **542 tests in 98 files, 79/79 wire-level smoke probes.**

## Install

The fastest path is the prebuilt **MCPB bundle** (one file, no Node toolchain
required); a manual clone/build is the alternative for development.

### Option A — MCPB bundle (recommended)

1. Download `winfs-0.10.3.mcpb` (build it with `npm run mcpb`, or grab it from
   the GitHub release).
2. **Drag the `.mcpb` file onto Claude Desktop** (Settings → Extensions). Claude
   Desktop unpacks it with a bundled Node runtime — nothing else to install.
3. In the extension's **Configure** screen, set **Allowed directories** (the
   roots winfs may touch). Optionally set the SSH / PowerShell / Python paths
   and extra PATH dirs. Leave **Unrestricted filesystem mode** OFF for normal
   use.
4. Done — winfs starts and its 39 tools appear in Claude Desktop.

The bundle's Configure UI writes a dedicated
`%LOCALAPPDATA%\mcp-winfs\mcpb-config.json` and never touches a manual
`config.json`, so the two install methods coexist. `allowedRoots` from the UI is
enforced exactly as a manual config; unrestricted mode still requires the
confirm phrase (below).

### Option B — manual clone / build (development)

```powershell
git clone https://github.com/leonovee/winfs-mcp mcp-winfs
cd mcp-winfs
npm install
npm run build
```

Requires Node ≥ 18. Then write a `config.json` and wire it into Claude Desktop
as shown under **Setup in Claude Desktop** below. Build the MCPB bundle yourself
with `npm run mcpb` (output: `dist-mcpb/winfs-0.10.3.mcpb`).

## Configuration

> **MCPB users:** configure everything (allowed directories, SSH/PowerShell/
> Python paths, unrestricted mode) in Claude Desktop's **Configure** screen — the
> bundle maps those fields onto the same runtime config described below. The rest
> of this section is the reference for the **manual** `config.json` (Option B) and
> documents every field the Configure UI exposes.

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

## Setup in Claude Desktop (manual path)

> Skip this section if you installed the MCPB bundle (Option A) — Claude Desktop
> wires the server automatically. This is for the manual clone/build (Option B).

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

## Tools (v0.10.3 — 39 tools)

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
| `ssh_exec`       | no        | First-class SSH. Spawns `ssh.exe` directly via `child_process.spawn` — no shell, no PowerShell wrapper. **Host control:** set `config.allowedSshHosts` to enforce an allowlist (non-member → `EHOST_UNKNOWN` before ssh runs); when unset, `host` is only validated for *resolvability* via `ssh -G` against `~/.ssh/config` (proves the alias resolves, not that it's a configured Host — not a security boundary). Raw `user@host` always rejected. Sidesteps three stacked failures that block ssh through `execute_command` (PATH sanitization, PS document-in-pipeline, silent-stdout bug #2). 4 KB per-stream output cap; `timeout_seconds` default 30 / max 300. Errors: `ESSHNOTFOUND`, `EHOST_UNKNOWN`, `ETIMEDOUT`, `EIO`. See spec amendment §X. |
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

### Filesystem-MCP parity (v0.8)

| Tool              | Read-only | What it does                                                              |
|-------------------|-----------|---------------------------------------------------------------------------|
| `directory_tree`  | yes       | Recursive JSON tree → `{ root: { name, type, children? }, total_nodes, truncated }`. Companion to flat `list`. Args: `path`, `max_depth` (1..8, default 3), `exclude_patterns` (basename globs — `node_modules`, `.git`, `dist`, `*.tmp`). Truncates with `truncated_reason: 'max_depth' \| 'max_nodes'` (10 000 hard cap). Symlinks walked as files, never followed. |
| `read_media_file` | yes       | Base64 reader for binary media (image / audio / video / PDF) — the companion to text-only `read`, which rejects binary with EENCODING. Streams in 64 KB chunks to avoid OOM. Returns `{ base64, content_type, bytes_read, truncated }`; `content_type` is best-effort from extension. Default 16 MB cap; oversize without `max_bytes` → ETOOLARGE. |

v0.8 also extended two existing tools (non-breaking): `read` gained `head: N` /
`tail: N` shortcuts (mutually exclusive with `range`), and `list` gained
`sort_by: 'name' | 'size' | 'mtime'`.

Every tool returns pure-payload `structuredContent` that matches its
declared `outputSchema` 1:1 (no `ok` / `tool` envelope — see [v0.1.1
hotfix](docs/v0.2-backlog.md#1--structuredcontent-validation-mismatch-on-every-tool-response--resolved-in-v011)).
Array-output tools (`glob`, `grep`, `audit_tail`, `read_multiple_files`,
`git_log`, `git_blame`) use a `{<plural>, total, ...flags}` envelope —
see spec amendment §F.

## Known limitations

### Audit-log content redaction

The audit log is a forensic trail, not a content store. User-supplied content is
kept out of it by default:

- **`write` / `append`** — the `content` argument is fully redacted to
  `<redacted: N bytes>`; the bytes never reach the log.
- **`execute_command` / `run_python` / `ssh_exec`** — the composed command /
  inline script body and the subprocess stdout/stderr are recorded as a
  **SHA-256 digest + byte length** (`*_sha256` / `*_bytes`), never the content.
  A prefix would still leak a token or key printed on the first line, so by
  default no prefix is stored. (`run_pytest` keeps its parsed counts only; its
  raw output is not copied into the audit record.)

Set **`config.auditVerbose: true`** to ALSO record short debugging prefixes
(64-char composed command, 256-char script / ssh command, 4-KB stdout/stderr)
next to the digests — opt-in, for when you need to see what actually ran.

Reading the audit log via `audit_tail` therefore tells you **what ran and
roughly how big the result was**, not what was written or printed in full. Do
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
this path by spawning `ssh.exe` via `child_process.spawn` directly. Host access
is gated by the optional `config.allowedSshHosts` allowlist (see below) plus
`ssh -G` resolvability validation. For v0.6.x users: invoke ssh from outside
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

### Process registry, exec, and review-wave findings — resolved since v0.7

The items that earlier README revisions flagged as open are now closed:

- **Windows-flaky process tests — fixed in v0.9.1.** The 10 intermittent
  `tests/unit/process/*` failures were root-caused (ProcessRegistry didn't
  destroy child stdio pipes on settle, so libuv held handles and the tempdir
  `fs.rm` hit EBUSY; the timeout handler didn't force-settle when `taskkill /F /T`
  failed to fire `close`). `ProcessSession.settle` now destroys stdio pipes, the
  timeout handler adds a defensive grace + force-settle, and tempdir removal uses
  a retry ladder. The full suite (542 tests) is green.
- **v0.7 pre-tag external review (~15 P2 findings) — closed across v0.9.1 /
  v0.9.2 / v0.10.x.** `fetch_url` gained `EMAXREDIRECTS` and
  `EENCODING_UNSUPPORTED` (no more silent gzip corruption), late-chunk and 3xx
  bandwidth fixes, and trailing-dot FQDN canonicalisation; `edit_file` got UTF-8
  codepoint-boundary diff truncation and TOCTOU fd-bound reads; `grep` got
  streaming pagination + a per-line length cap; `execute_command` got blocklist
  cache-key hashing and a narrowed `taskkill /F /T` pattern. The one intentional
  non-fix is the `fetch_url` `truncated`-flag rename (P2.1) — a cosmetic
  contract churn with no behaviour change, documented as deferred in
  `audit/external_reviews/v0.7-pre-tag/_post-v0.9.0-status.md`.

### Dependency audit

`npm audit` is at **0 vulnerabilities** as of v0.9.2 (the prior 7 were assessed
0-exposed / dev-only and closed anyway — vitest 2→4, diff 7→9, qs patch). See
`audit/security/v0.9.2-triage.md`.

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

#### `allowedSshHosts` — enforced ssh_exec host allowlist (optional)

`ssh_exec` always validates that `host` is *resolvable* via `ssh -G`, but that
is **not** a security boundary: `ssh -G` echoes `hostname <literal>` even for an
alias that has no `Host` entry, so it proves the name resolves, not that you
configured it. To actually restrict which hosts `ssh_exec` may reach, set
`allowedSshHosts` to an array of exact Host aliases — anything not in the list
is refused with `EHOST_UNKNOWN` **before** ssh is spawned:

```json
{
  "allowedRoots": ["C:\\Users\\me\\src"],
  "allowedSshHosts": ["prod-web", "staging-db"]
}
```

Unset (the default) keeps the resolvability-only behavior. An empty array
(`[]`) is the strictest setting — it blocks every host. Matching is exact and
case-sensitive (as `ssh -G` itself is).

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
npm test          # vitest run — 542 tests in 98 files
npm run test:watch
npm run smoke      # node scripts/smoke/v0.7-smoke.mjs — 79/79 wire-level probes
npm run mcpb       # build dist-mcpb/winfs-0.10.3.mcpb, then:
node scripts/smoke/mcpb-smoke.mjs   # 9/9 bundle-install probes
```

winfs ships **542 tests in 98 files**: per-tool happy path + every error code
across all 39 tools, plus invariants (UTF-8 roundtrip, junction/`..` escape,
timeout abort + grep partial-result + edit_file ETIMEDOUT, atomic-write
integrity + edit_file dry-run-no-temp / rename-failure-no-leak + write_chunk
non-atomic contract, audit redaction, both-roots check for mutations,
structuredContent shape across all tools, audit_tail privileged-read boundary +
TOCTOU close, exec blocklist enforcement, check_env safe-prefix mathematical
bound, fetch_url SSRF defense, unrestricted-mode short-circuit + audit `mode`
field, MCP-Roots union semantics, process-session lifecycle).

A wire-level smoke harness (`scripts/smoke/v0.7-smoke.mjs`) drives the built
server over stdio across both strict and unrestricted modes, MCP-Roots,
transport logging and child-spawn hardening — **79/79 probes green**. A second
harness (`scripts/smoke/mcpb-smoke.mjs`) extracts the packed `.mcpb` and proves
the bundle installs and enforces `allowedRoots` end-to-end — **9/9 green**.

## Acceptance reports

- v0.1: [`docs/v0.1-acceptance.md`](docs/v0.1-acceptance.md)
- v0.2: [`docs/v0.2-acceptance.md`](docs/v0.2-acceptance.md)
- v0.3: [`docs/v0.3-acceptance.md`](docs/v0.3-acceptance.md)
- v0.4: [`docs/v0.4-acceptance.md`](docs/v0.4-acceptance.md)
- v0.5.1: [`docs/v0.5.1-acceptance.md`](docs/v0.5.1-acceptance.md) (the `v0.5.0` tag is a phantom — reviewers should clone `--branch v0.5.1`)
- v0.6: [`docs/v0.6-acceptance.md`](docs/v0.6-acceptance.md)
- v0.7: [`docs/v0.7-acceptance.md`](docs/v0.7-acceptance.md) (waves 1 / 2a / 2b / 2c + pre-tag bug-fix)
- v0.8: [`docs/v0.8-acceptance.md`](docs/v0.8-acceptance.md) (filesystem parity + ToolContext)
- v0.9: [`docs/v0.9-acceptance.md`](docs/v0.9-acceptance.md) (MCP Roots + flaky-test stabilisation + security audit 7 → 0)
- v0.10: [`docs/v0.10-acceptance.md`](docs/v0.10-acceptance.md) (child-spawn hardening + timeout-ceiling polish; v0.10.2 MCPB packaging follows)

## Roadmap

`docs/design/mcp-winfs-spec.md` §7 has the full phasing. The tool surface is
**39 tools** as of v0.8 (the §4 v0.6 surface of 30, plus 3 from v0.7 wave 1, 4
from v0.7 wave 2b, and 2 from v0.8).

- ✅ **v0.1** — `read`, `write`, `append`, `list`, `stat`
- ✅ **v0.2** — `mkdir`, `move`, `copy`, `read_multiple_files`, `list_allowed_directories`
- ✅ **v0.3** — `grep`, `glob`, `read_json`, `audit_tail`
- ✅ **v0.4** — `read_section`, `diff_files`, `edit_file` (with `dry_run`), `read_since`
- ✅ **v0.5.1** — `git_status`, `git_log`, `git_show`, `git_diff`, `git_blame`, `execute_command`, `run_python`, `run_pytest`, `find_command`, `check_env`, `fetch_url` (the v0.5.0 tag is a phantom; see acceptance doc for reconciliation)
- ✅ **v0.6** — `write_chunk` + `edit_file.expected_count` extension + `unrestrictedFilesystem` mode
- ✅ **v0.7 wave 1** — `ssh_exec`, `list_path_dirs`, `write_json` (consumer-agent feedback adds; spec §X)
- ✅ **v0.7 main wave (wave 2b) — process control** — `start_process`, `interact`, `list_process`, `kill_process` (in-memory `ProcessRegistry`; spec §Z). Wave 2a improved existing tools (`edit_file` near-miss diff, `grep` pagination, `execute_command` hints); wave 2c was the ToolContext refactor.
- ✅ **v0.8 — filesystem-MCP parity** — `directory_tree`, `read_media_file`, `read` head/tail, `list` sort_by, `register*Tool(server, ctx)` refactor (invariant #41, spec §AB).
- ✅ **v0.9.x — MCP Roots + security** — MCP-Roots union mode (spec §AC, invariant #42), flaky-test stabilisation, `powershellExePath`, `fetch_url` error-code hardening, `npm audit` 7 → 0.
- ✅ **v0.10.x — child-spawn hardening + polish** — explicit PATHEXT on every spawn, `GIT_TERMINAL_PROMPT=0`, shell-timeout pair, `allowedRoots` hot-reload, opt-in `WINFS_TRANSPORT_LOG`, timeout-ceiling fix, ssh auto-detect, `execExtraPathDirs`, deferred-P2 closeout.
- ✅ **v0.10.2 — MCPB packaging** — drag-install bundle for Claude Desktop (`winfs-0.10.2.mcpb` + Configure UI). `mcpb/manifest.json` + `mcpb/launch.mjs` map the install-time `user_config` onto the same runtime config with enforcement fully intact (spec §AD, invariant #45); `npm run mcpb` builds and `scripts/smoke/mcpb-smoke.mjs` proves the packed bundle installs and refuses out-of-root reads. No new tools.
- ✅ **v0.10.3 — GPT-review fix wave** — enforced `allowedSshHosts` ssh allowlist (the `ssh -G` check is honestly relabelled *resolvability validation*, not a whitelist — invariant #35 corrected), `copy` honors unrestricted mode, audit logs store SHA-256 + byte length of script / command / output by default with opt-in `auditVerbose` prefixes (invariant #46), GitHub Actions CI (windows, Node 18/20/22), and v0.9 / v0.10 acceptance backfills. No new tools.
- ⏳ **v1.0 — release (planned)** — gated on the full 10-question eval suite (≥ 80 % pass through MCP) plus production sign-off. The eval harness (`evals/`) currently ships example questions and the `connections.py` driver; the complete question set and the `run.py` runner are still to come.
