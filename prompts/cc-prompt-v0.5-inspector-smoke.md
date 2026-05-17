# Inspector smoke — winfs v0.5.0 RC — Claude in Chrome prompt

> **Audience:** Claude in Chrome (browsing agent). winfs v0.5.0 release candidate, 29 tools shipped, working tree at `C:\Users\Expert\Desktop\AI\tools\winfs\`, post-commit pre-tag.
>
> **Purpose:** Phase 4f #20 — Inspector smoke probe sweep. ~45 probes total: 29 happy-path + 6 v0.4-deferred red-team + 9 v0.5 red-team + 1 skipped-unit-test coverage. After this passes, HAND-OFF #2 to chat Claude, then tag v0.5.0.
>
> **Mandatory gate:** if any probe red, do NOT tag. Report findings to chat Claude, fix-iterate, re-run smoke.

---

## 0. Setup

Before opening the browser, operator (manual, one-off):

```powershell
cd C:\Users\Expert\Desktop\AI\tools\winfs
npm run build
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

Note the `--` separator between `inspector` and the server's own args — this is mandatory per README troubleshooting (Inspector consumes its own `--config` otherwise).

Inspector opens at `http://localhost:5173` (or printed URL). Claude in Chrome navigates there.

---

## 1. Pre-flight verification

In the Inspector UI:

- [ ] **Tool list shows 29 tools.** Count them. If ≠ 29 — stop, report which are missing.

  Expected tool names (grouped, but Inspector lists alphabetically):
  - v0.1 (5): `read`, `write`, `append`, `list`, `stat`
  - v0.2 (5): `mkdir`, `move`, `copy`, `read_multiple_files`, `list_allowed_directories`
  - v0.3 (4): `grep`, `glob`, `read_json`, `audit_tail`
  - v0.4 (4): `edit_file`, `read_section`, `read_since`, `diff_files`
  - v0.5 Git (5): `git_status`, `git_log`, `git_show`, `git_diff`, `git_blame`
  - v0.5 Exec (3): `execute_command`, `run_python`, `run_pytest`
  - v0.5 System (2): `find_command`, `check_env`
  - v0.5 Network (1): `fetch_url`

- [ ] **Schema panel shows zero warnings.** Click into any tool, verify the Inspector doesn't display "additional properties not allowed" or schema-mismatch banners. If any tool's schema fails to render — stop, report.

- [ ] **Server info panel.** Verify server name is `winfs` (or `winfs-mcp`), version is `0.5.0`. If version still shows `0.4.0`, `chore(release)` commit didn't bump `src/core/config.ts` — fix before continuing.

---

## 2. Happy-path probes (29 tools, one each)

For each tool, fill the args panel with the values below, click **Run**, verify the output panel shows:
- `isError: false`
- `structuredContent` populated with expected shape (key spot-check noted per probe)
- No yellow/red banners

If any probe fails, record the tool name + actual output, continue with the rest (don't bail), then report the full red list to chat Claude.

### v0.1 file primitives

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 1 | `read` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\package.json"}` | `content` includes `"name": "winfs-mcp"`, `total_bytes > 0` |
| 2 | `write` | `{"path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs\\.inspector_smoke_tmp.txt","content":"hello v0.5"}` | `bytes_written > 0`, file appears on disk |
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

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 11 | `grep` | `{"pattern":"version","path_glob":"C:\\...\\winfs\\*.json"}` | `matches.length > 0`, `total > 0` |
| 12 | `glob` | `{"pattern":"C:\\...\\winfs\\src\\**\\*.ts"}` | `matches.length > 20` (many .ts files) |
| 13 | `read_json` | `{"path":"C:\\...\\winfs\\package.json"}` | parsed object, `value.name === "winfs-mcp"` |
| 14 | `audit_tail` | `{"n":10}` | `entries.length <= 10`, `total === entries.length`, `entries_seen_total >= entries.length` (v0.5 carryover field) |

### v0.4 editor + slicing

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 15 | `edit_file` | `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\moved.txt","edits":[{"old_str":"hello v0.5","new_str":"edited"}],"dry_run":true}` | `dry_run: true`, `replacements_made: 1`, `diff` non-empty, file SHA on disk **unchanged** |
| 16 | `read_section` | `{"path":"C:\\...\\winfs\\README.md","line_range":[1,10]}` | `content` non-empty, `range.kind:"line"`, `range.start:1` |
| 17 | `read_since` | `{"path":"C:\\...\\winfs\\README.md","since_offset":0}` | `content` non-empty, `new_offset > 0`, `file_rotated: false` |
| 18 | `diff_files` | `{"a":"C:\\...\\package.json","b":"C:\\...\\package.json"}` (same file twice) | `identical: true`, `diff: ""`, both counts 0 |

### v0.5 Git RO

The winfs repo itself is the test target — has real history.

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 19 | `git_status` | `{"repo_path":"C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs"}` | `branch: "main"`, arrays present (may be empty post-tag) |
| 20 | `git_log` | `{"repo_path":"C:\\...\\winfs","count":5}` | `commits.length: 5`, `total: 5`, each commit has hash/author/date/message |
| 21 | `git_show` | `{"repo_path":"C:\\...\\winfs","sha":"HEAD"}` | `sha`, `diff` non-empty, `files_changed` array |
| 22 | `git_diff` | `{"repo_path":"C:\\...\\winfs","rev_a":"HEAD~1","rev_b":"HEAD"}` | `diff` non-empty, `stats.insertions >= 0` |
| 23 | `git_blame` | `{"repo_path":"C:\\...\\winfs","path":"package.json","range":"1:10"}` | `blame.length: 10`, each entry has sha/author/content |

### v0.5 Exec

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 24 | `execute_command` | `{"command":"Get-Date","args":[]}` | `stdout` non-empty (date string), `exit_code: 0`, `truncated_stdout: false` |
| 25 | `run_python` | `{"args":["-c","print(1+1)"]}` | `stdout` contains `"2"`, `exit_code: 0` |
| 26 | `run_pytest` | `{"cwd":"C:\\...\\winfs","count_only":true}` | one of: parsed `passed/failed/skipped/errors`, OR EPARSE/EPYTHONNOTFOUND if pytest missing — accept both per unit-test parity |

### v0.5 System

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 27 | `find_command` | `{"name":"git"}` | `found: true`, `path` non-empty |
| 28 | `check_env` | `{"name":"PATH"}` | `present: true`, `length > 100`, `prefix.length === 4`, prefix matches first 4 chars of actual PATH (likely `"C:\\W"`) — **see §4 red-team for safety verification** |

### v0.5 Network

| # | Tool | Args | Spot-check |
|---|---|---|---|
| 29 | `fetch_url` | `{"url":"https://example.com/"}` (must be in `config.allowedUrlHosts`) | `status_code: 200`, `body` non-empty, `final_url` matches input or follows redirect, `truncated: false` for small response |

**If `example.com` is not in `config.allowedUrlHosts`** — this probe will return `EHOSTNOTALLOWED`. That's not a happy-path; check `configs/local.json` `allowedUrlHosts` array and use ANY whitelisted host instead. If no public host is whitelisted, this probe is **covered by §5** below (skipped-unit-test coverage section).

---

## 3. v0.4-deferred red-team probes (6)

Earlier acceptance (v0.4.0) skipped Inspector probes per operator directive — these now run as part of v0.5.0 smoke. Each must produce an **error** with the specified code in `structuredContent.error.code`.

| # | Tool | Args | Expected |
|---|---|---|---|
| R1 | `edit_file` | `{"path":"C:\\Windows\\System32\\drivers\\etc\\hosts","edits":[{"old_str":"x","new_str":"y"}]}` (path outside allowedRoots) | `EPERM_ROOT`, file untouched |
| R2 | `edit_file` | `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\moved.txt","edits":[{"old_str":"e","new_str":"X"},{"old_str":"Q","new_str":"Y"},{"old_str":"missing_str_xyz","new_str":"Z"},{"old_str":"a","new_str":"A"},{"old_str":"b","new_str":"B"}]}` (5 edits, edit[2] not in buffer) | `EUNIQUE`, `details.edit_index: 2`, `details.occurrences: 0`, file **untouched on disk** (verify via `read` or `stat` size) |
| R3 | `edit_file` | `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\copied.txt","edits":[{"old_str":"hello","new_str":"goodbye"}],"dry_run":true}` | `dry_run: true`, `diff` non-empty, file SHA before/after via `stat` **unchanged** (re-stat after probe, compare mtime) |
| R4 | `read_section` | `{"path":"C:\\...\\winfs\\README.md","start_marker":"## Nonexistent Heading","marker_type":"md_heading"}` | `ENOMATCH` |
| R5 | `read_since` | `{"path":"C:\\...\\winfs\\.inspector_smoke_dir\\moved.txt","since_offset":999999999}` (offset > file size) | `EINVAL` or `file_rotated: true` (depending on spec interpretation; both acceptable) |
| R6 | `diff_files` | `{"a":"C:\\...\\winfs\\package.json","b":"C:\\...\\winfs\\package.json"}` | `identical: true`, `diff: ""` (this is a happy-path test pinning the identical short-circuit, already covered in §2 probe #18 — re-run для emphasis) |

---

## 4. v0.5 red-team probes (9)

The core security invariants of v0.5 must surface as errors. **These are the most important probes in the sweep** — they prove the spec is honored at the wire level, not just in unit tests.

### Exec safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R7 | `execute_command` | `{"command":"Remove-Item","args":["-Recurse","-Force","C:\\"]}` | `EBLOCKED`, `details.matched_pattern` includes `Remove-Item.*-Recurse` |
| R8 | `execute_command` | `{"command":"Get-Date","cwd":"C:\\Windows"}` (cwd outside allowedRoots) | `EPERM_ROOT` |
| R9 | `execute_command` | `{"command":"Start-Sleep","args":["-Seconds","30"],"timeout_ms":1000}` | `ETIMEDOUT`, `truncated_stdout` flag set, subprocess killed (verify via `Get-Process` ad-hoc in another shell — no orphans named `powershell` after probe) |

### Network safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R10 | `fetch_url` | `{"url":"http://127.0.0.1/"}` | `EHOSTNOTALLOWED`, error at Layer 1 (host whitelist) before DNS |
| R11 | `fetch_url` | `{"url":"http://localhost/"}` (note: literally `localhost`, may pass Layer 1 if whitelisted, must fail Layer 2 after DNS to `127.0.0.1`) | `EHOSTNOTALLOWED` |
| R12 | `fetch_url` | `{"url":"https://<host that 302s to internal IP>"}` (if you have one in whitelist, e.g., a httpbin-like service that redirects to `127.0.0.1`) — skip if no such target available | `EHOSTNOTALLOWED` on **hop 2 after redirect**, with `final_url` showing the redirect URL not the internal IP, error details should mention "redirect target denied" |

If R12 has no available test target → skip and flag in HAND-OFF #2 as "needs httpbin-or-similar in allowedUrlHosts for full redirect re-validation coverage; unit tests in `tests/invariants/fetch_url_ssrf.test.ts` cover this with mocked DNS".

### Privacy invariant (the critical one)

| # | Tool | Args | Expected |
|---|---|---|---|
| R13 | `check_env` | `{"name":"PATH"}` | `prefix.length === 4`, `length === <real PATH length>` (compare to `$env:PATH.Length` in an external shell — must match), `prefix` contains **only** the first 4 chars of PATH (compare to `$env:PATH.Substring(0,4)`). **This must never return more than 4 chars regardless of what PATH contains.** Re-run with a short env var to verify: `{"name":"USERNAME"}` — if USERNAME length ≥ 4, prefix is 4 chars; if < 4 (rare), prefix is empty string |

### Git safety

| # | Tool | Args | Expected |
|---|---|---|---|
| R14 | `git_log` | `{"repo_path":"C:\\Users\\Expert"}` (not a git repo) | `ENOTREPO` |
| R15 | `git_blame` | `{"repo_path":"C:\\...\\winfs","path":"package.json","range":"1:50000"}` | `EINVAL` (range cap > 10000) OR clamp to 10000 with `blame.length: 10000` — both acceptable per spec |

---

## 5. Skipped-unit-test coverage (1)

The fetch_url happy-path unit test was skipped because public-IP whitelist target wasn't reachable in unit-test isolation (per HAND-OFF #1 acceptance notes). Cover that here:

| # | Tool | Args | Expected |
|---|---|---|---|
| S1 | `fetch_url` | `{"url":"https://example.com/"}` or another small public page in `config.allowedUrlHosts` | `status_code: 200`, `body` includes `<title>Example Domain</title>` (or similar), `truncated: false`, `final_url` matches |

If `example.com` not whitelisted in `config.allowedUrlHosts` — temporarily add it for this probe via editing `configs/local.json`, restart Inspector, run probe, revert config. Or use whichever host IS whitelisted.

---

## 6. Cleanup (after all probes)

Inspector-created test artifacts:

```powershell
Remove-Item -Force C:\Users\Expert\Desktop\AI\tools\winfs\.inspector_smoke_tmp.txt -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\Users\Expert\Desktop\AI\tools\winfs\.inspector_smoke_dir -ErrorAction SilentlyContinue
```

Verify working tree clean before tag:

```powershell
git status
```

If artifacts moved/copied into the working tree got accidentally committed, undo before tag.

---

## 7. Reporting format for HAND-OFF #2

After full sweep, produce a status block for chat Claude in this exact shape (copy into the HAND-OFF #2 message):

```markdown
## Inspector smoke — winfs v0.5.0 RC — <UTC timestamp>

**Pre-flight:**
- Tool count: <N>/29 (✓ or ✗)
- Schema warnings: <N> (must be 0)
- Server version: <version> (must be 0.5.0)

**Happy-path probes (§2):** N/29 passed
- Failed: <list, or "none">

**v0.4 red-team probes (§3):** N/6 passed
- Failed: <list, or "none">

**v0.5 red-team probes (§4):** N/9 passed
- Failed: <list, or "none">
- R12 status: <ran / skipped — no target>

**Skipped-unit-test coverage (§5):** N/1 passed
- S1 status: <passed / failed / skipped — host not whitelisted>

**Cleanup:** working tree clean (`git status` empty) — yes / no

**Verdict:** GO for tag v0.5.0 / NO-GO, blocking issues below.

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

Открыть Inspector (operator §0 setup), navigate to URL в Chrome, выполнить §1 → §2 → §3 → §4 → §5 → §6 → §7. Total estimated wall-clock ~30-45 минут at human-speed clicking; faster если Claude in Chrome batches form-fills.

Hand-off обратно к chat Claude через статус-блок §7. Если verdict = GO — chat Claude approves Phase 4f #21 (tag). Если NO-GO — fix-iterate, re-run.

Поехали.
