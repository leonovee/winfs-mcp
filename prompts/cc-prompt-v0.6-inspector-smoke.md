# Inspector smoke — winfs v0.6.0 RC — Claude in Chrome prompt

> **Audience:** Claude in Chrome (browsing agent). winfs v0.6.0 release candidate, **30 tools** shipped, working tree at `C:\Users\Expert\Desktop\AI\tools\winfs\` on branch `v0.6`, post-commit pre-tag.
>
> **Purpose:** Phase 6d Inspector smoke probe sweep. ~46 probes total: 30 happy-path + 7 v0.6 red-team + 9 v0.5 red-team carryover + skipped-unit-test coverage. After this passes, HAND-OFF #3 to chat Claude, then chore(release) bump + tag v0.6.0.
>
> **Mandatory gate:** if any probe red, do NOT tag. Report findings to chat Claude, fix-iterate, re-run smoke.
>
> **Two server-mode passes required:** §2–§4 run against the default `strict` mode. §5 (unrestricted-mode probes) requires a separate Inspector session started from a config with `unrestrictedFilesystem: true` + magic confirm. Don't tag until BOTH passes are green.

---

## 0. Setup — strict mode pass

Before opening the browser, operator (manual, one-off):

```powershell
cd C:\Users\Expert\Desktop\AI\tools\winfs
npm run build
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

`configs/local.json` MUST NOT set `unrestrictedFilesystem: true` for this pass. Verify with:

```powershell
Select-String -Path configs/local.json -Pattern "unrestrictedFilesystem"
```

If a match returns `true`, comment it out (or use a separate `configs/local-strict.json` file) before this pass.

The `--` separator between `inspector` and the server's own args is mandatory per README troubleshooting (Inspector consumes its own `--config` otherwise).

Inspector opens at `http://localhost:5173` (or printed URL). Claude in Chrome navigates there.

---

## 1. Pre-flight verification (strict pass)

In the Inspector UI:

- [ ] **Tool list shows 30 tools.** Count them. If ≠ 30 — stop, report which are missing.

  Expected tool names (grouped, but Inspector lists alphabetically):
  - v0.1 (5): `read`, `write`, `append`, `list`, `stat`
  - v0.2 (5): `mkdir`, `move`, `copy`, `read_multiple_files`, `list_allowed_directories`
  - v0.3 (4): `grep`, `glob`, `read_json`, `audit_tail`
  - v0.4 (4): `edit_file`, `read_section`, `read_since`, `diff_files`
  - v0.5 Git (5): `git_status`, `git_log`, `git_show`, `git_diff`, `git_blame`
  - v0.5 Exec (3): `execute_command`, `run_python`, `run_pytest`
  - v0.5 System (2): `find_command`, `check_env`
  - v0.5 Network (1): `fetch_url`
  - **v0.6 File (1): `write_chunk`** ← new

- [ ] **Schema panel shows zero warnings.** Click into each tool, verify the Inspector doesn't display "additional properties not allowed" or schema-mismatch banners. Special attention to `edit_file` schema — it should show the new `expected_count` optional field per edit.

- [ ] **Server info panel.** Verify server name is `winfs` (or `winfs-mcp`), version is **`0.6.0`** (Lesson L6 — version is the cheap gate; if it still shows `0.5.1`, `chore(release)` commit didn't bump `src/core/config.ts` — fix BEFORE continuing further probes).

- [ ] **Stderr console.** Verify the `mcp-winfs vX.Y.Z ready` line includes `mode=strict`. NO 3-line `⚠️` banner should appear (those only print in unrestricted mode).

---

## 2. Happy-path probes (30 tools, one each) — strict pass

For each tool, fill the args panel with the values below, click **Run**, verify the output panel shows:
- `isError: false`
- `structuredContent` populated with expected shape (key spot-check noted per probe)
- No yellow/red banners

If any probe fails, record the tool name + actual output, continue with the rest (don't bail), then report the full red list to chat Claude.

### v0.1 file primitives

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 1 | `read` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\package.json"}` | `content` includes `"name": "winfs-mcp"`, `total_bytes > 0` |
| 2 | `write` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_tmp.txt","content":"hello v0.6"}` | `bytes_written > 0`, file appears on disk |
| 3 | `append` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_tmp.txt","content":"\nappended"}` | `bytes_written > 0` |
| 4 | `list` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs"}` | `entries` array contains `package.json`, `total > 0` |
| 5 | `stat` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\package.json"}` | `is_dir: false`, `size > 0` |

### v0.2 directory + multi

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 6 | `mkdir` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_dir"}` | `created: true` |
| 7 | `move` | `{"src":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_tmp.txt","dst":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_dir\\moved.txt"}` | `moved: true` |
| 8 | `copy` | `{"src":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_dir\\moved.txt","dst":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_dir\\copied.txt"}` | `copied: true` |
| 9 | `read_multiple_files` | `{"paths":["C:\\...\\package.json","C:\\...\\README.md"]}` (full paths) | `files.length === 2`, `total: 2`, `ok_count: 2` |
| 10 | `list_allowed_directories` | `{}` | `roots` array non-empty |

### v0.3 search + recovery

> **Drift fix from v0.5 (Lesson L5):** `read_json` response shape uses `data`, not `value`.

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 11 | `grep` | `{"pattern":"version","path_glob":"C:\\...\\winfs\\*.json"}` | `matches.length > 0`, `total > 0` |
| 12 | `glob` | `{"pattern":"C:\\...\\winfs\\src\\**\\*.ts"}` | `matches.length > 20` |
| 13 | `read_json` | `{"path":"C:\\...\\winfs\\package.json"}` | `data.name === "winfs-mcp"`, `size_bytes > 0` — **field is `data`, not `value`** |
| 14 | `audit_tail` | `{"n":10}` | `entries.length <= 10`, `total === entries.length`, `entries_seen_total >= entries.length` (v0.5 carryover field). First entry near top of log should be `tool: "_server_start"` (v0.6 §U sentinel) with `args_summary.server_mode === "strict"` and `mode === "strict"` — visible confirmation of the new audit field. |

### v0.4 editor + slicing

> **Drift fix from v0.5 (Lesson L5):** `read_section` uses `line_range` / `byte_range`, NOT markers. Spec amendment §J already obsoleted the old §4.5 marker-based design.

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 15 | `edit_file` | `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\moved.txt","edits":[{"old_str":"hello v0.6","new_str":"edited"}],"dry_run":true}` | `dry_run: true`, `replacements_made: 1`, `diff` non-empty, file SHA on disk **unchanged**. Note `replacements_made` now reflects actual replacements per §W (v0.5 was `args.edits.length`). |
| 16 | `read_section` | `{"path":"C:\\...\\winfs\\README.md","line_range":[1,10]}` | `content` non-empty, `range.kind:"line"`, `range.start:1`, `range.end:10`. **Args field is `line_range`, NOT `start_marker` / `end_marker`.** |
| 17 | `read_since` | `{"path":"C:\\...\\winfs\\README.md","since_offset":0}` | `content` non-empty, `new_offset > 0`, `file_rotated: false` |
| 18 | `diff_files` | `{"a":"C:\\...\\package.json","b":"C:\\...\\package.json"}` (same file twice) | `identical: true`, `diff: ""`, both counts 0 |

### v0.5 Git RO

> **Drift fixes from v0.5 (Lesson L5):**
> - `git_show` requires a HEX SHA (4-64 hex chars), NOT the symbolic name `HEAD`. Resolve via `git rev-parse HEAD` first or paste a recent SHA.
> - `git_blame` requires an ABSOLUTE path for `path`, not relative.

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 19 | `git_status` | `{"repo_path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs"}` | `branch: "v0.6"` (or `"main"` if already merged), arrays present |
| 20 | `git_log` | `{"repo_path":"C:\\...\\winfs","count":5}` | `commits.length: 5`, `total: 5`, each commit has hash/author/date/message. Top commit should be Phase 6d work (spec amendments). |
| 21 | `git_show` | `{"repo_path":"C:\\...\\winfs","sha":"<recent hex SHA>"}` — operator pastes a real SHA from `git_log` probe #20 output | `sha`, `diff` non-empty, `files_changed` array. **Cannot pass `"HEAD"`** — schema requires hex. |
| 22 | `git_diff` | `{"repo_path":"C:\\...\\winfs","rev_a":"HEAD~1","rev_b":"HEAD"}` | `diff` non-empty, `stats.insertions >= 0` |
| 23 | `git_blame` | `{"repo_path":"C:\\...\\winfs","path":"C:\\...\\winfs\\package.json","range":"1:10"}` — **absolute path required**, not `"package.json"` | `blame.length: 10`, each entry has sha/author/content |

### v0.5 Exec

> **Drift fix from v0.5 (Lesson L5):** `run_python` requires `{mode, script}` (or `{mode, path}`), NOT `{args: ["-c", "..."]}`.

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 24 | `execute_command` | `{"command":"Get-Date","args":[]}` | `stdout` non-empty (date string), `exit_code: 0`, `truncated_stdout: false` |
| 25 | `run_python` | `{"mode":"inline","script":"print(1+1)"}` — **fields are `mode` and `script`**, not `args: ["-c", "..."]` | `stdout` contains `"2"`, `exit_code: 0` |
| 26 | `run_pytest` | `{"cwd":"C:\\...\\winfs","count_only":true}` | parsed `passed/failed/skipped/errors`, OR `EPARSE`/`EPYTHONNOTFOUND` if pytest missing — accept both per unit-test parity |

### v0.5 System

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 27 | `find_command` | `{"name":"git"}` | `found: true`, `path` non-empty |
| 28 | `check_env` | `{"name":"PATH"}` | `present: true`, `length > 100`, `prefix.length === 4`, prefix matches first 4 chars of actual PATH — **see §4 red-team R13 for safety verification** |

### v0.5 Network

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 29 | `fetch_url` | `{"url":"https://example.com/"}` (must be in `config.allowedUrlHosts`) | `status_code: 200`, `body` non-empty, `final_url` matches input or follows redirect, `truncated: false` for small response |

**If `example.com` is not in `config.allowedUrlHosts`** — probe returns `EHOSTNOTALLOWED`. Use any whitelisted host instead, or temporarily add `example.com` and revert after probe.

### v0.6 File (new)

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 30 | `write_chunk` | First setup: create a sandbox file via `write`: `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\chunk.txt","content":"ABCDEFGHIJ","overwrite":true}`. Then `write_chunk`: `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\chunk.txt","offset":3,"content":"xy","encoding":"utf8","validate_byte_range":true}` | `bytes_written: 2`, `total_bytes_after: 10`, **`atomic: false`** (literal), `offset: 3`. Verify by `read` of same file: content should be `"ABCxyFGHIJ"`. |

---

## 3. v0.5 red-team carryover probes (9)

Same security invariants as v0.5 — re-run because Phase 6a's `checkAllowed` short-circuit only triggers in unrestricted mode (covered in §5); strict mode behavior must be unchanged. Each must produce an **error** with the specified code in `structuredContent.error.code`.

### Exec safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R7 | `execute_command` | `{"command":"Remove-Item","args":["-Recurse","-Force","C:\\"]}` | `EBLOCKED`, `details.matched_pattern` includes `Remove-Item.*-Recurse` |
| R8 | `execute_command` | `{"command":"Get-Date","cwd":"C:\\Windows"}` (cwd outside allowedRoots) | `EPERM_ROOT` |
| R9 | `execute_command` | `{"command":"Start-Sleep","args":["-Seconds","30"],"timeout_ms":1000}` | `ETIMEDOUT`, `truncated_stdout` flag set, subprocess killed (verify via `Get-Process` ad-hoc in another shell — no orphaned `powershell` after probe) |

### Network safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R10 | `fetch_url` | `{"url":"http://127.0.0.1/"}` | `EHOSTNOTALLOWED`, error at Layer 1 (host whitelist) before DNS |
| R11 | `fetch_url` | `{"url":"http://localhost/"}` | `EHOSTNOTALLOWED` (Layer 2 if `localhost` is whitelisted, Layer 1 otherwise) |
| R12 | `fetch_url` | `{"url":"https://<host that 302s to internal IP>"}` if such a target is in whitelist; skip if not | `EHOSTNOTALLOWED` on **hop 2 after redirect**, `final_url` shows the redirect URL not the internal IP |

If R12 has no available test target → skip and flag in HAND-OFF #3 as covered by `tests/invariants/fetch_url_ssrf.test.ts` (unit-test mocked DNS).

### Privacy invariant

| # | Tool | Args | Expected |
|---|---|---|---|
| R13 | `check_env` | `{"name":"PATH"}` | `prefix.length === 4`, `length === <real PATH length>` (compare to `$env:PATH.Length` in external shell), `prefix` contains **only** the first 4 chars of PATH. **This must never return more than 4 chars regardless of value.** Re-run with `{"name":"USERNAME"}` — if USERNAME length ≥ 4, prefix is 4 chars; if < 4 (rare), prefix is empty. |

### Git safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R14 | `git_log` | `{"repo_path":"C:\\Users\\Expert"}` (not a git repo) | `ENOTREPO` |
| R15 | `git_blame` | `{"repo_path":"C:\\...\\winfs","path":"C:\\...\\winfs\\package.json","range":"1:50000"}` | `EINVAL` (range cap > 10000) OR clamp to 10000 with `blame.length: 10000` — both acceptable per spec |

---

## 4. v0.6 red-team probes (7)

The v0.6 features added 7 new security / contract invariants (§U-§W, invariants #28-#34). Each must surface as the expected error / flag at the wire level.

### Feature C — edit_file expected_count (v0.6 §W)

| # | Tool | Args | Expected |
|---|---|---|---|
| R16 | `edit_file` — EUNIQUE rename (v0.5 → v0.6 BREAKING) | Setup: `write` a file with 2 `foo`s: `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\edit.txt","content":"foo and foo","overwrite":true}`. Then: `{"path":"...","edits":[{"old_str":"foo","new_str":"BAR"}]}` (default `expected_count: 1`) | `EUNIQUE`. **`details.occurrences_found === 2`** (NOT `details.occurrences` — that field was renamed). **`details.expected_count === 1`**. File untouched on disk. |
| R17 | `edit_file` — expected_count: 0 assertion succeeds | Same setup. Then: `{"path":"...","edits":[{"old_str":"NEVER_PRESENT_xyz","new_str":"<ignored>","expected_count":0}]}` | `ok`, `replacements_made: 0`. File untouched (zero replacements). |
| R18 | `edit_file` — expected_count: N multi-replace | Same setup. Then: `{"path":"...","edits":[{"old_str":"foo","new_str":"BAR","expected_count":2}]}` | `ok`, `replacements_made: 2`. File content via `read`: `"BAR and BAR"`. |

### Feature B — write_chunk (v0.6 §V)

| # | Tool | Args | Expected |
|---|---|---|---|
| R19 | `write_chunk` — EOFFSET (sparse-file forbidden) | Setup: file with 5 bytes. Then `{"path":"...","offset":100,"content":"x"}` | `EOFFSET`, `details.offset: 100`, `details.file_size: 5`. File untouched. |
| R20 | `write_chunk` — EENCODING (UTF-8 boundary misalign) | Setup: `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\utf.txt","content":"ΠΠΠA","overwrite":true}` (Π is 2 bytes; "ΠΠΠA" is [CE A0 CE A0 CE A0 41] = 7 bytes). Then: `{"path":"...","offset":1,"content":"x","encoding":"utf8","validate_byte_range":true}` (offset 1 lands on a continuation byte) | `EENCODING`. `details.offset: 1`. Hint mentions `validate_byte_range: false` as bypass. |
| R21 | `write_chunk` — atomic: false literal in response | Any successful write_chunk (R30 or fresh). | Response field `atomic` is the literal `false` (not a generic boolean). |

### Feature A — unrestricted mode (negative — strict pass)

| # | Tool | Args | Expected |
|---|---|---|---|
| R22 | `write` / `read` / etc. on path outside allowedRoots | `{"path":"C:\\Windows\\System32\\drivers\\etc\\hosts"}` via `read` | `EPERM_ROOT`. **Confirms strict mode still rejects** out-of-roots paths (Phase 6a short-circuit is mode-gated). The unrestricted-mode positive case is §5 below. |

---

## 5. Unrestricted-mode probes (separate Inspector session)

Stop the strict-mode Inspector. Create a separate config:

```powershell
# Copy the local config and enable unrestricted with magic confirm
$src = "configs\local.json"
$dst = "configs\local-unrestricted.json"
Copy-Item $src $dst
# Manually edit local-unrestricted.json to add:
#   "unrestrictedFilesystem": true,
#   "unrestrictedFilesystemConfirm": "I-UNDERSTAND-THE-RISK"
```

Then start a fresh Inspector session:

```powershell
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local-unrestricted.json
```

### Pre-flight (unrestricted)

- [ ] **3-line stderr banner** appears at startup BEFORE the ready line:
      ```
      ⚠️ ⚠️ ⚠️  UNRESTRICTED FILESYSTEM MODE — all paths accessible
      ⚠️ ⚠️ ⚠️  Confirm: "I-UNDERSTAND-THE-RISK"
      ⚠️ ⚠️ ⚠️  See docs/design/mcp-winfs-spec.md §U
      ```
- [ ] Ready line includes `mode=unrestricted`.
- [ ] Tool list still shows **30 tools** (unrestricted mode doesn't change the surface).

### Probes (unrestricted)

| # | Tool | Args | Expected |
|---|---|---|---|
| U1 | `read` outside allowedRoots | `{"path":"C:\\Windows\\System32\\drivers\\etc\\hosts"}` | `ok`, `content` non-empty. **Confirms allowedRoots short-circuit triggers in unrestricted.** Strict-mode equivalent (R22) returned EPERM_ROOT. |
| U2 | `audit_tail` confirms `_server_start` mode field | `{"n":5}` | Most-recent entry (closest to current call) should be `tool: "_server_start"` with `args_summary.server_mode === "unrestricted"` and `mode === "unrestricted"`. |
| U3 | `write` mutation tool — `mode` field in audit | First do a `write` to an in-roots path. Then `audit_tail`: `{"n":2}` | The `write` entry has `mode: "unrestricted"` (per invariant #30). Read-only `audit_tail` entry omits the `mode` field. |
| U4 | Negative invariant — exec blocklist STILL enforced even in unrestricted | `{"command":"Remove-Item","args":["-Recurse","-Force","C:\\"]}` | `EBLOCKED` (NOT a free pass — invariant #7 applies in all modes). |
| U5 | Negative invariant — SSRF defense STILL enforced even in unrestricted | `fetch_url` to `http://127.0.0.1/` | `EHOSTNOTALLOWED`. Network safety doesn't relax in unrestricted mode. |
| U6 | Negative invariant — check_env safe-prefix STILL enforced | `{"name":"PATH"}` | `prefix.length === 4`. Privacy invariant doesn't relax. |

Stop the unrestricted Inspector after these probes. **Do NOT leave the unrestricted config in `configs/local.json`** — verify by re-checking the original local config before continuing.

---

## 6. Cleanup (after all probes)

Inspector-created test artifacts:

```powershell
Remove-Item -Force C:\Users\Expert\Desktop\AI\tools\winfs\.inspector_smoke_tmp.txt -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\Users\Expert\Desktop\AI\tools\winfs\.inspector_smoke_dir -ErrorAction SilentlyContinue
Remove-Item -Force C:\Users\Expert\Desktop\AI\tools\winfs\configs\local-unrestricted.json -ErrorAction SilentlyContinue
```

Verify working tree clean before tag:

```powershell
git status
```

---

## 7. Reporting format for HAND-OFF #3

After full sweep (BOTH strict pass + unrestricted pass), produce a status block for chat Claude in this exact shape:

```markdown
## Inspector smoke — winfs v0.6.0 RC — <UTC timestamp>

**Strict-mode pre-flight:**
- Tool count: <N>/30 (✓ or ✗)
- Schema warnings: <N> (must be 0)
- Server version: <version> (must be 0.6.0)
- Ready-line mode: <strict|unrestricted> (must be strict here)
- No ⚠️ banner: <yes|no> (must be yes here)

**Happy-path probes (§2):** N/30 passed
- Failed: <list, or "none">
- `read_json` `data` field verified (not `value`): yes/no
- `read_section` `line_range` args verified (not markers): yes/no
- `git_show` hex SHA verified (rejected symbolic HEAD): yes/no
- `git_blame` absolute path verified: yes/no
- `run_python` `{mode, script}` verified (not `{args:["-c",...]}`): yes/no
- `write_chunk` `atomic: false` literal verified: yes/no

**v0.5 red-team carryover (§3):** N/9 passed
- Failed: <list, or "none">
- R12 status: <ran / skipped — no target>

**v0.6 red-team (§4):** N/7 passed
- R16 details.occurrences_found verified (NOT details.occurrences): yes/no
- R16 details.expected_count present: yes/no
- R18 replacements_made === 2 (NOT === 1): yes/no
- R19 EOFFSET verified: yes/no
- R20 EENCODING boundary check verified: yes/no
- R21 atomic field is literal false: yes/no

**Unrestricted pre-flight:**
- ⚠️ banner appeared: <yes|no> (must be yes)
- Ready-line mode: unrestricted (must match)
- Tool count still 30: <yes|no>

**Unrestricted probes (§5):** N/6 passed
- U1 (read outside roots succeeds): yes/no
- U2 (_server_start mode field): yes/no
- U3 (write entry has mode, audit_tail omits): yes/no
- U4 (exec blocklist still fires): yes/no
- U5 (SSRF still fires): yes/no
- U6 (safe-prefix still bounded): yes/no

**Cleanup:**
- working tree clean (`git status` empty): yes/no
- configs/local.json unmodified: yes/no

**Verdict:** GO for chore(release) + tag v0.6.0 / NO-GO, blocking issues below.

**Blocking issues (if any):**
1. <tool> — <expected> — <actual> — <reproduction>
```

---

## 8. Если probe blue/yellow/red

- **Blue (info / warning)** — usually OK, record but don't fail probe. E.g., Inspector showing "tool returned isError: true (expected)" for red-team probes is the **correct** outcome.
- **Yellow (schema mismatch / additional properties)** — failure. Tool's `outputSchema` doesn't match returned `structuredContent`. Record exact field name + tool. This is a `structured_content.test.ts` gap.
- **Red (server error / crash / hang)** — critical failure. Record stack trace if visible, server log lines. Cancel further probes for that tool, continue with others.

---

## Готов?

Открыть strict-mode Inspector (operator §0 setup), navigate to URL в Chrome, выполнить §1 → §2 → §3 → §4. Stop strict Inspector. Setup unrestricted config + open unrestricted Inspector (§5 setup). Run §5. §6 cleanup. §7 hand-off report.

Total estimated wall-clock ~45–60 минут at human-speed clicking; faster if Claude in Chrome batches form-fills.

Hand-off обратно к chat Claude через статус-блок §7. Если verdict = GO — chat Claude approves chore(release) + tag v0.6.0. Если NO-GO — fix-iterate, re-run smoke.

Поехали.
