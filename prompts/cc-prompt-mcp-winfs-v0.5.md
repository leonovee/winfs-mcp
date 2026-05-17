# Build mcp-winfs v0.5 — Claude Code Prompt
## (collapses v0.5 Git + v0.6 Exec + v0.7 System/Network into one cycle)

## Контекст

Ты продолжаешь mcp-winfs с **v0.4.0** (18 tools, 179 tests, 33 test files, spec §I–§L amendments shipped, multi-LLM external-review pipeline established and exercised through audit_tail v0.3.x patch waves).

**Решение оператора:**
- Collapse оставшиеся три phases (v0.5 Git RO, v0.6 Exec, v0.7 System+Network) в один cycle к target tag **`v0.5.0`** (semver minor bump).
- **Tests run ONCE** на end of cycle — не interleaved per-phase. Цель: full `npm test` против final 29-tool surface, единый pass/fail signal. Если что-то red — fix → re-run → tag.
- **Inspector smoke run ONCE** на end of cycle — full probe sweep против всех 29 tools одной session'ой, не batched per-phase.
- External reviews — **NOT batched на end**: каждая mutation surface (edit_file carryover, execute_command, fetch_url) reviewed индивидуально через terminal-CC immediately after implementation, fixes commit'ятся per-reviewer atomically. Review is **gate**, не post-mortem.

Целевой surface после этого cycle = **29 tools** = full spec §4 set. После остаётся только v1.0 polish (MCPB packaging + evals + comprehensive README rewrite).

**Источники истины:**

- `docs/design/mcp-winfs-spec.md`:
  - §2 invariant #7 — execute_command blocklist regex (`Remove-Item.*-Recurse`, `format [A-Za-z]:`, `bcdedit`, `reg delete HKLM`, `shutdown`, `Stop-Process.*-Force`, `cipher /w`, `Clear-Disk`, `Initialize-Disk`)
  - §2 invariant #8 — `check_env` safe-prefix only (`{present, length, prefix[0:4]}` — NEVER full value)
  - §2 invariant #10 — `fetch_url` whitelist + internal-IP deny + 5 MB / 15 s hard caps + http/https only
  - §2 invariant #11 — audit redaction (env values, write/append content → `<redacted: N bytes>`)
  - §2 invariant #12 — no runtime config mutation (никаких `block_command` / `set_config_value`)
  - §4.6 Git Read-Only (5 tools): `git_log`, `git_status`, `git_diff`, `git_show`, `git_blame`
  - §4.7 Exec (3 tools): `execute_command`, `run_python`, `run_pytest`
  - §4.8 System (2 tools): `find_command`, `check_env`
  - §4.9 Network (1 tool): `fetch_url`
  - §5 error catalog — новые коды: `EBLOCKED` (execute_command blocklist hit), `ETIMEDOUT` (exec/network timeout), `ENOTREPO` (git_*), `EHOSTNOTALLOWED` (fetch_url), `ESIZE` (fetch_url > 5 MB), `ENOTFOUND` (find_command miss)
  - §7 phased delivery — three rows collapsed
  - §F envelope amendment (v0.3) — `total === array.length` для plural-output. Применяется к `git_log` (Array of commits) и `git_blame` (Array of blame entries). `git_status` substrings (modified/staged/untracked) — Arrays внутри single-object envelope, **не** wrap с top-level total
- `docs/v0.4-acceptance.md` — шаблон acceptance report
- `prompts/cc-prompt-mcp-winfs-v0.4.md` — предыдущий phase prompt, многие cross-cutting lessons переиспользуются
- `CHANGELOG.md` — `[0.4.0]` entry как пример depth/формата

V1 SDK lock-in остаётся (`@modelcontextprotocol/sdk@^1.29.0`, Zod v3). Не менять: `src/core/tool_wrapper.ts`, `src/core/atomic_write.ts`, `src/core/config.ts` schemas (только добавления через нормальный Zod merge).

## Scope v0.5 (collapsed)

### Новые tools (11)

#### Git Read-Only (5) — §4.6

| Tool | Notes |
|---|---|
| `git_log` | `{repo_path, range?, path_filter?, count?: 20}` → `{commits: Array<{hash, author, email, date (ISO), message, files_changed?}>, total}`. Plural envelope per §F |
| `git_status` | `{repo_path}` → `{branch, ahead, behind, staged: string[], modified: string[], untracked: string[], conflicted: string[]}`. Single-object envelope per §I–§L pattern (arrays внутри, not at top) |
| `git_diff` | `{repo_path, rev_a?: "HEAD", rev_b?: uncommitted-default, path_filter?}` → `{diff, files_changed: string[], stats: {insertions, deletions}}` |
| `git_show` | `{repo_path, sha, path_filter?}` → `{sha, author, email, date, message, diff, files_changed}` |
| `git_blame` | `{repo_path, path, range?: "start_line:end_line"}` → `{blame: Array<{line, sha, author, date, content}>, total}` |

#### Exec (3) — §4.7

| Tool | Notes |
|---|---|
| `execute_command` | `{command, args?, cwd?, timeout_ms?}` → `{stdout, stderr, exit_code, duration_ms, truncated_stdout: bool, truncated_stderr: bool}`. PowerShell как dispatch shell. Hard cap stdout/stderr = `config.execMaxOutputBytes` (default 1 MB each). Blocklist invariant #7 — pre-spawn regex check. Bounded timeout per spec |
| `run_python` | Same shape как `execute_command`, но fixed binary `python` / `python3` (config-selectable). Args в массиве — `["-c", "<script>"]` или `["<file.py>"]`. Не PowerShell-проходя — direct spawn |
| `run_pytest` | `{cwd, test_filter?, count_only?: false, timeout_ms?}` → `{passed: number, failed: number, skipped: number, errors: number, duration_ms, raw_output (truncated), test_files: string[]}`. Parser вытаскивает pytest summary line. Если `count_only: true` — `pytest --collect-only` без execution |

#### System (2) — §4.8

| Tool | Notes |
|---|---|
| `find_command` | `{name, with_version?: false}` → `{found: bool, path?: string, version?: string}`. PowerShell `Get-Command` OR `where.exe`. Version invocation gated на `with_version: true` (reduces attack surface) |
| `check_env` | `{name}` → `{present: bool, length: number, prefix: string}`. Safe-prefix invariant #8 ABSOLUTE — `prefix` is first **4** chars of value or empty string if length < 4. Never full value |

#### Network (1) — §4.9

| Tool | Notes |
|---|---|
| `fetch_url` | `{url, headers?, max_bytes?: 5_242_880, timeout_ms?: 15000}` → `{status_code, content_type, body (truncated_to_max_bytes), bytes_received, truncated: bool, final_url (after redirects)}`. Invariant #10 — host whitelist + internal-IP deny + 5 MB / 15 s caps + http/https only |

### v0.3/v0.4 carryover items (закрыть в v0.5)

1. **`audit_tail.entries_seen_total` field** — был deferred с v0.3.3 в v0.4 как Kimi+Gemini P3 carryover. Hand-off v0.4.0 не упоминает что это сделано. **Проверь**: `winfs:read src/tools/system/audit_tail.ts` — есть ли поле в `OutputShape`? Если нет — implement в v0.5 cycle (refactor `tailLinesFromHandle` чтобы вернуть scan count + entries; add field в schema; spec amendment в §F или новый §M).

2. **External review для `grep.ts`** через 4-LLM pipeline (codex / kimi / gemini / deepseek). Prompt уже на диске: `audit/external_reviews/_review_grep.prompt.md`. Запуск через **terminal-CC** subagents. Findings → fixes commit'ятся как `fix(grep): <reviewer> review P<level>`. Закрыть в **Phase 4b** (раннее) перед exec/network impl — потому что `execute_command` потенциально pipes через grep-like PowerShell utilities, и shared invariants должны быть solid.

3. **External review для `edit_file.ts`** — flagged operator follow-up в v0.4.0 hand-off, deferred. **Trigger before v0.5.0 tag**: edit_file — центральная mutation surface, без review её trust-level ниже чем у audit_tail (который получил 3 patch waves через 4-LLM review). Fix commits как `v0.4.1`/`v0.4.2` patches **до** v0.5.0 tag'а.

4. **External review для `execute_command.ts`** (NEW) — после implementation. Это **вторая** mutation surface за всю историю проекта (edit_file была первой), и она строго **дальше** edit_file по riskology: execute_command spawns external processes. **Mandatory** 4-LLM review до v0.5.0 tag'а, no negotiation.

5. **External review для `fetch_url.ts`** (NEW) — после implementation. Single mutation surface на network side. SSRF / DNS rebinding / TOCTOU на whitelist resolve / redirect-following hops — все классические attack vectors. Mandatory 4-LLM review до v0.5.0 tag'а.

### Out of scope (v1.0)

❌ MCPB packaging — отдельный binary deliverable, отдельная phase
❌ Comprehensive evals build-out (per-tool benchmark harness) — v1.0
❌ README rewrite до production-ready prose — v1.0
❌ Any new tools beyond §4 spec set — спека этих не определяет, любое расширение требует amendment first

## Step 0 — Подготовка

Свежая CC сессия — подгрузи:

- `mcp_best_practices.md`
- `node_mcp_server.md`
- v1.x SDK README

Прочитай:

- `docs/v0.4-acceptance.md` — формат acceptance report и v0.4 final state
- `CHANGELOG.md` — последние v0.4.0 entry + предыдущие v0.3.x
- `src/tools/editor/edit_file.ts` целиком — эталонный пример «multi-step transaction + atomic_write reuse + dry-run boundary + audit redaction». Паттерн особенно важен для `execute_command`
- `src/tools/system/audit_tail.ts` целиком — эталонный пример «многослойной валидации + privileged-read с layered defenses». Паттерн для `fetch_url` (whitelist → DNS resolve → re-check → connect)
- `src/core/atomic_write.ts`, `src/core/tool_wrapper.ts`, `src/core/audit.ts` — переиспользовать as-is, не дублировать
- Spec §I–§L (последние amendments) — понять текущий envelope convention drift и где он применяется

## Step 1 — Hard invariants новые для v0.5

К invariants из v0.1–v0.4 (включая `edit_file` invariants из §I–§L) добавляются:

### Git Read-Only (5 tools)

1. **Hard-deny на mutation arg flags.** Никаких опций `--commit`, `--push`, `--reset`, `--checkout`, `--rebase`, etc. в **никакой** form (даже abbreviated `-r`, `-c`). Pre-validation regex списка mutation flags перед спавном git binary'а. Список в `src/core/git_safety.ts` (новый файл), exposed как constant array, hardcoded — **не** config-driven (invariant #12 — no runtime mutation).

2. **Typed structured output, не raw stdout.** Каждый `git_*` парсит git output (через `--format=`/`--porcelain`/`--json` где возможно) в typed Zod schema. Caller никогда не видит raw shell output. Это closes сразу две проблемы: schema stability (git output format может меняться между versions) + escape sanitization (git encodes non-ASCII в octal escapes — нужно decode).

3. **`repo_path` через `checkAllowed`.** Same allowedRoots check как любой fs tool. Plus extra check: `<repo_path>/.git` должен exist (директория или regular file для worktrees) — иначе `ENOTREPO`. Это **до** git spawn, не после, чтобы не потратить timeout на сторонней папке.

4. **Bounded execution.** Git tools запускают subprocess. Default timeout = `config.defaultTimeoutMs` (10 s), max = `config.maxTimeoutMs` (60 s). Per-tool override через `args.timeout_ms`. При истечении — kill subprocess **gracefully** (SIGTERM, then SIGKILL after 2 s grace), return `ETIMEDOUT` + partial output if any.

5. **No path-filter regex injection.** `path_filter` user-controlled. Pass to git via `--` separator (per git CLI standard) чтобы git treat it как pathspec, не как rev. Reject path_filter содержащий `\0` byte или ASCII control chars.

6. **`git_blame` line range bounded.** `range: "start_line:end_line"` parsed strictly как `^(\d+):(\d+)$`. `end_line - start_line + 1` capped at 10000 (предотвращает unbounded blame walk).

### Exec (3 tools — **самые строгие**)

7. **Blocklist pre-validation** (spec invariant #7). Regex array hardcoded в `src/core/exec_safety.ts`. Каждая команда проверяется **до** spawn'а. Match → `EBLOCKED` с details containing matched pattern + position. Default list per spec; **extensible через config**, но **только additive** (config может **добавить** rules, не убрать).

8. **PowerShell as `execute_command` dispatch.** Single binary entry — `powershell.exe` (или `pwsh.exe` if config selects). Command + args composed and quoted carefully. **Никогда** `cmd.exe` shell-out, **никогда** `bash` even when WSL'd.

9. **Bounded I/O capture.** stdout + stderr each capped at `config.execMaxOutputBytes` (default 1 MB). When cap hit — kill subprocess, return partial + `truncated_stdout: true` flag.

10. **PATH sanitized.** Subprocess inherits **minimal** PATH: `C:\Windows\System32`, `C:\Windows`, `C:\Program Files\Git\cmd`, `C:\Program Files\nodejs`, `<config.pythonHome>` если задан. **Не** inherit user `$PATH`. All other env vars inherited unless `config.execSanitizeEnv: true` (default false) в каком случае только PATH + USERPROFILE + LOCALAPPDATA.

11. **cwd через `checkAllowed`.** `args.cwd` если задан — must be inside allowedRoots.

12. **`run_python` separate config block.** `config.pythonHome` указывает root — `python.exe` находится через `<pythonHome>\python.exe`, не через PATH. Closes Python-shimming attack vector.

13. **`run_pytest` parses summary line only.** Parser regex для standard pytest summary: `^=+ (\d+) failed,? (\d+) passed,? (?:(\d+) skipped,?)? (?:(\d+) error,?)? in [\d.]+s =+$`. Если parse fails — return `EPARSE` error.

### System (2 tools)

14. **`find_command` does not invoke binary unless `with_version: true`.** Default — just `Get-Command` check + path return.

15. **`check_env` safe-prefix ABSOLUTE** (invariant #8). Implementation:
    ```ts
    const value = process.env[name];
    if (value === undefined) return { present: false, length: 0, prefix: "" };
    return {
      present: true,
      length: value.length,
      prefix: value.length >= 4 ? value.slice(0, 4) : "",
    };
    ```
    **Никогда** не возвращать prefix length > 4. Test: `check_env({name: "PATH"})` returns `{present: true, length: <large>, prefix: "C:\\W"}` — NEVER full PATH.

### Network (1 tool — **строжайший**)

16. **Whitelist + internal-IP deny** (invariant #10). Two-layer check:
    - **Layer 1: host whitelist.** `config.allowedUrlHosts` Array<string>. URL parsed → `url.hostname` matched against whitelist (exact match, case-insensitive). Not in list → `EHOSTNOTALLOWED` **before** DNS resolve.
    - **Layer 2: DNS resolve + IP deny.** Hostname resolved (Node's `dns.lookup`). Resolved IP **не** matched against internal ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`). Match → `EHOSTNOTALLOWED` **after** resolve.
    - **TOCTOU mitigation (rebinding):** resolved IP used для actual connect; HTTP `Host:` header rewritten manually к original hostname.

17. **Hard 5 MB cap.** If `Content-Length` > 5 MB → `ESIZE` **before** body read. If no Content-Length и stream exceeds 5 MB — kill connection.

18. **Hard 15 s timeout.** Wall-clock от request start to response end. Default override через config to LOWER values only.

19. **http/https only.** `url.protocol` checked, anything else → `EHOSTNOTALLOWED`.

20. **No request body в v0.5.** GET only.

21. **No cookie jar, no auth-header pass-through.** `args.headers` whitelist: `User-Agent`, `Accept`, `Accept-Language` only. `Authorization`, `Cookie`, custom `X-*` → `EINVAL`.

22. **Redirect handling.** Follow up to 3 redirects. Each redirect target re-validated через Layer 1 + Layer 2 (#16). `final_url` in response.

### Cross-cutting v0.5

23. **All v0.5 tools use v0.3.3/v0.4 structured-error pattern.** Raw cause → `error.details.cause` + `error.details.errno`.

24. **AbortSignal threading на всех subprocess'ах и network calls.** При server shutdown / timeout — process tree killed, sockets closed.

25. **structuredContent contract.** Все 11 новых tools имеют `outputSchema` 1:1 с payload. Pin в `tests/invariants/structured_content.test.ts`.

26. **Audit redaction extended.** Invariant #11 от спеки уже redacts write/append content. Для v0.5:
    - `execute_command.args` — last 64 chars of each arg (предотвращает password-on-CLI leak); **`stdout`/`stderr`** в audit'е — first 4 KB only (`truncated_at: N`)
    - `run_python` — script content redacted to first 256 chars; full script в `args_summary.script_bytes` (count, not content)
    - `fetch_url.url` — query string redacted past `?` (OAuth tokens / API keys в URL); headers — only whitelist-allowed headers logged
    - `check_env.name` — full env var name OK to log; value never logged

27. **No runtime config mutation** (invariant #12 reinforce).

## Step 2 — Acceptance criteria для v0.5

### Сборка и тесты — **batched at end of cycle**

- [ ] **End-of-cycle:** `npm run build` exit 0, ноль warnings — run **один раз** после всех 11 tools merged + reviews fixed
- [ ] **End-of-cycle:** `npm test` — все v0.4 тесты по-прежнему зелёные (179) + новые. Target минимум **240+** total (~61 new minimum)
- [ ] **End-of-cycle:** `tests/invariants/structured_content.test.ts` расширен для 11 новых tools
- **Within cycle:** Tests written **alongside** each tool impl (commit-by-commit) — но запускаются для verification только в конце. CC может subset sanity-check while building (`npm test -- src/tools/git/git_log.test.ts`) — это не violates "single full run at end" directive, just helps CC self-check без full sweep cost

### Per-tool unit tests (минимумы — written within cycle, run at end)

- **git_log**: happy, with range, with path_filter, count cap, ENOTREPO, EPERM_ROOT
- **git_status**: clean repo, dirty repo (staged + modified + untracked), detached HEAD, conflicted, ENOTREPO
- **git_diff**: rev_a..rev_b, uncommitted vs HEAD, path_filter, stats, ENOTREPO
- **git_show**: valid sha, invalid sha (ENOMATCH), path_filter
- **git_blame**: happy, range subset, ENOMATCH on bogus path, range cap → EINVAL or clamp
- **execute_command**: `Get-Date`, with cwd, with args, blocklist hit (`Remove-Item -Recurse`) → EBLOCKED, timeout truncates + ETIMEDOUT, stdout cap → truncated_stdout, exit_code captured (non-zero), EPERM_ROOT on cwd outside roots
- **run_python**: `-c "print(1)"`, file mode, stderr captured, exit_code non-zero, timeout, missing python → EPYTHONNOTFOUND
- **run_pytest**: collect-only, full run pass+fail+skip mix, parse-fails-gracefully on unexpected output, timeout
- **find_command**: existing (git), missing, with_version flag
- **check_env**: present long var (PATH), present short var (< 4 chars), missing var, **adversarial test** (verify mathematical impossibility of extracting > 4 chars)
- **fetch_url**: happy https whitelist, http whitelist, blocked host → EHOSTNOTALLOWED, internal IP after DNS → EHOSTNOTALLOWED, body > 5 MB declared → ESIZE, body > 5 MB streamed → ESIZE + connection killed, redirect 1-2-3 hops, redirect to blocked host → EHOSTNOTALLOWED hop 2, file:// → EHOSTNOTALLOWED, bad headers (Authorization) → EINVAL

### Invariant tests

- `tests/invariants/exec_blocklist.test.ts` — каждое pattern из default blocklist tested + extensibility
- `tests/invariants/check_env_safe_prefix.test.ts` — adversarial mathematical bound
- `tests/invariants/fetch_url_ssrf.test.ts` — comprehensive SSRF coverage (direct internal IP, DNS resolving to internal, redirect to internal, IPv6)
- `tests/invariants/audit_redaction.test.ts` — extended из v0.4 → exec stdout, run_python script, fetch_url query string, check_env values
- `tests/invariants/structured_content.test.ts` — +11 new tool entries
- `tests/invariants/timeouts.test.ts` — exec subprocess kill, fetch_url socket timeout, git_log long history

### Carryover items tests

- `audit_tail.entries_seen_total` — implement если ещё не сделано, +test
- Tests для review-driven fixes на grep / edit_file / execute_command / fetch_url — natural fallout каждого review wave

### External review (carryovers 2–5) — **NOT batched, per-surface immediately after impl**

- [ ] `grep.ts` review через terminal-CC (Phase 4b), findings → patch commits
- [ ] `edit_file.ts` review (carryover из v0.4) (Phase 4b), findings → v0.4.1+ patch commits **до** v0.5.0 tag'а
- [ ] `execute_command.ts` review (NEW, mandatory) — **immediately после** execute_command impl, перед run_python/run_pytest. Findings → patch commits **до** v0.5.0 tag'а
- [ ] `fetch_url.ts` review (NEW, mandatory) — **immediately после** fetch_url impl. Findings → patch commits **до** v0.5.0 tag'а
- [ ] All review prompts saved в `audit/external_reviews/_review_<tool>.prompt.md`
- [ ] All review raw outputs saved в `audit/external_reviews/<reviewer>_<tool>_<timestamp>.md`

Rationale per-surface immediate review (not end-batched): если execute_command review всплывает major flaw, лучше catch до того как run_python/run_pytest наследуют ту же flawed foundation. Review is **gate**, не post-mortem.

### Inspector smoke — **batched at end of cycle**

Single Inspector session **на самом конце** cycle'а (after all 11 tools, all reviews resolved, all tests green):

```powershell
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

Full probe sweep — **all 29 tools**, не только новые 11. Reasoning: v0.4.0 Inspector probes были skipped per operator directive, v0.5 single Inspector session покрывает both v0.4 deferred set + v0.5 new set.

Probes minimum:

- [ ] **All 29 tools visible** в Inspector tool list
- [ ] Happy-path probe per tool (29 probes total)
- [ ] **v0.4 deferred red-team probes** (from v0.4-acceptance.md §7):
  - `edit_file` outside allowedRoots → EPERM_ROOT
  - `edit_file` multi-edit с edit[2] non-unique → file untouched + error references edit[2]
  - `edit_file` dry_run: same file SHA before/after
  - `read_section` md_heading + regex probes
  - `read_since` cursor round-trip
  - `diff_files` identical short-circuit
- [ ] **v0.5 red-team probes**:
  - `execute_command` blocklist hit (`Remove-Item -Recurse Force` style) → EBLOCKED
  - `execute_command` cwd outside allowedRoots → EPERM_ROOT
  - `execute_command` timeout с long sleep → ETIMEDOUT + truncated_stdout flag
  - `fetch_url` к internal IP (e.g., `http://127.0.0.1`) → EHOSTNOTALLOWED
  - `fetch_url` к non-whitelisted host → EHOSTNOTALLOWED
  - `fetch_url` redirect to internal host → EHOSTNOTALLOWED on hop 2
  - `check_env` для PATH → returns prefix === "C:\\W" (first 4 chars), length === full PATH length, **never** full value
  - `git_log` на non-repo directory → ENOTREPO
  - `git_blame` range cap test (range = "1:50000") → EINVAL or clamp
- [ ] Schema validation clean across all 29 tools (no additional-properties warnings)

### Документация

- [ ] `CHANGELOG.md` — `[0.5.0] — <date>` entry, v0.4.0-comparable depth, plus separate sub-sections per tool group (Git / Exec / System / Network)
- [ ] `README.md` — tools table extended to 29; новые sections (Git / Exec / System+Network), README troubleshooting расширен на exec quirks
- [ ] `docs/v0.5-acceptance.md` — new, по шаблону v0.4
- [ ] Spec amendments §M–§P (или продолжить нумерацию по последней литере в spec) для новых invariants. Каждый amendment dated + signed by impl tag

## Step 3 — Lessons learned (carried + new)

### Из v0.1–v0.4 (не повторять)

1. **structuredContent pure payload с первой попытки.** Pin tests.
2. **Audit flush race в test teardown.** `await flushAudit()` критично — exec/git/fetch_url tests генерируют heavy audit volume. **End-of-cycle test run** делает race поверхность ещё крупнее.
3. **Strict Zod config не любит `_comment`.** Не добавлять comment fields в новые config sections.
4. **MSIX node PATH** — уже в README troubleshooting, не сломать при rewrite.
5. **Both-roots check для multi-path tools.** В v0.5: `git_blame.repo_path + path` — независимо проверять оба.
6. **Layered path/host validation** — паттерн audit_tail для tools читающих/connecting sensitive locations. `fetch_url` особенно.
7. **Structured EIO/EBADCODE с `details.cause`** — никаких raw error messages в user-facing message field.
8. **Envelope convention §F** — `total === array.length` для plural arrays. v0.5 applicable: `git_log` (commits), `git_blame` (blame entries). `git_status` substrings — Arrays внутри single-object envelope, **не** top-level total.
9. **External 4-LLM review pipeline** — для каждой mutation/network surface. v0.5 mandates: edit_file (carryover), execute_command, fetch_url. Reviewer profiles same:
   - **Codex** — tightest, ~4 findings
   - **Kimi** — adversarial process-risk, ~10+ findings
   - **Gemini** — Windows-specific (CRLF/BOM/junctions, PowerShell quoting в exec context), ~7 findings (watch false positives)
   - **DeepSeek** — anti-hallucination structural concerns, ~9 findings
10. **Spec discipline** — каждый reviewer accept должен cite spec section; каждый reject должен cite specific spec text. Reference v0.3.3 case where Kimi+Gemini «total → entries_returned» rejected per §F.

### Новое для v0.5

11. **Process tree management.** Когда `execute_command` spawns powershell.exe, и powershell.exe spawns child (e.g. `git push` через `&` operator) — server's AbortSignal must kill **entire tree**, not just parent. Use Node's `tree-kill` package or Windows-native `taskkill /F /T /PID <pid>`. Test: spawn deep tree, abort, verify no orphaned children via `Get-Process` после.

12. **PowerShell argument quoting hazards.** Single space в args, embedded `"` or `'`, paths с brackets (`C:\Program Files (x86)\...`) — все известные quote-breaking sources. Test matrix mandatory. Если parse-fail — `EINVAL` early.

13. **DNS rebinding TOCTOU on fetch_url.** Между «host resolve to public IP» и «socket connect» — promise that resolve was bound to the IP, not re-resolve. Implementation: resolve hostname → get IP → pass IP directly to `http.request({ hostname: ip, headers: { Host: original_hostname } })`. Test: mock DNS that returns public IP on first call, internal IP on second; verify connection goes to first IP.

14. **Exec result determinism vs concurrency.** Two `execute_command` calls in flight — each gets own process and own audit record. **No** global lock. Caller orchestrates. Test: 5 parallel `Get-Date` calls — все 5 audit records present, all 5 returns coherent stdout.

15. **Spec drift surveillance.** v0.5 adds new error codes (`EBLOCKED`, `EHOSTNOTALLOWED`, `ESIZE`, `ENOTREPO`, etc.) — verify these are added to §5 error catalog **в одном commit'е** с tool that introduces them, not separately.

16. **Batched test runs hide regressions.** Per operator directive tests run **end-of-cycle only**. Risk: regression introduced в Phase 4c surfaces only at Phase 4f, debugging hard because change set wide. Mitigation: write tests **alongside** impl (commit-by-commit), CC может subset-test per tool while building — это не violates directive, just helps self-check.

## Step 4 — Workflow

Conventional commits, atomic per scope, group commits by safety surface:

### Phase 4a — carryover hygiene (do first, before any new tools)

1. **Verify v0.4.0 push** — sanity check `git ls-remote origin refs/heads/main refs/tags/v0.4.0`. If not pushed, push first.
2. **Workspace cleanup commit** — закрыть pending untracked items из v0.3.3 → v0.4 transition (review prompts, asymmetric review reports). Один commit.
3. **`audit_tail.entries_seen_total`** carryover (if not done in v0.4): `feat(audit_tail): entries_seen_total diagnostic field` + spec amendment.

### Phase 4b — external review carryovers (close v0.3.x / v0.4.x debt)

4. **`grep.ts` external review** через terminal-CC. Fix commits per reviewer: `fix(grep): <reviewer> review P<level>`. Tag `v0.4.1` если fixes ship; иначе skip tag.
5. **`edit_file.ts` external review** через terminal-CC. Fix commits as above. Tag `v0.4.2` (или next available) если fixes ship.

### Phase 4cde — implement ALL 11 tools without test pauses (collapsed)

Per operator directive: no full test runs between phases, no Inspector probes mid-cycle. Per-tool unit tests written alongside impl (single commit per tool: code + tests). CC може sanity-check subset tests while building (см. lesson #16), но full test sweep deferred to Phase 4f.

#### Phase 4c — Git Read-Only (5 tools)

6. **Scaffold** `src/tools/git/` directory + `src/core/git_safety.ts` (mutation flag denylist).
7. **Per-tool in order** (simplest to complex), one commit per tool:
   - `git_status` — simplest, single porcelain parse
   - `git_log` — multi-record parse, plural envelope
   - `git_show` — combines log + diff
   - `git_diff` — text diff + stats parse
   - `git_blame` — line-range walker, range cap

   Commits: `feat(git): <tool_name>` (code + tests + new error codes added to §5).

#### Phase 4d — Exec (3 tools — mandatory external review after #1)

8. **Scaffold** `src/tools/exec/` + `src/core/exec_safety.ts` (blocklist + sanitization).
9. **`execute_command`** first (most complex). `feat(exec): execute_command + blocklist + PATH sanitization`.
10. **`execute_command` external review** через terminal-CC **immediately**, before run_python/run_pytest. Fix commits per reviewer.
11. **`run_python`** — `feat(exec): run_python`. Reuses execute_command core.
12. **`run_pytest`** — `feat(exec): run_pytest + summary parser`. Reuses run_python.

#### Phase 4e — System + Network (3 tools — mandatory external review on fetch_url)

13. **`find_command`** — `feat(system): find_command`. Simple.
14. **`check_env`** — `feat(system): check_env + safe_prefix invariant`. Add invariant test в том же commit'е.
15. **`fetch_url`** — `feat(network): fetch_url + SSRF defenses`.
16. **`fetch_url` external review** через terminal-CC **immediately**. Fix commits per reviewer.

### Phase 4f — close out (single test run + single Inspector run + docs + tag)

17. **Full test sweep**: `npm run build && npm test`. Expected: 240+ tests passing, zero TS warnings. If red — fix, commit `fix(<tool>): <issue>`, re-run. Repeat until green.
18. **Spec amendments** — `docs(spec): §M–§P amendments for v0.5 invariants` (или whatever the next letters are).
19. **README + CHANGELOG + `docs/v0.5-acceptance.md`** — `docs: v0.5 readme, changelog, acceptance`.
20. **Inspector smoke run** (single session, all 29 tools, all probes from Step 2 Inspector section). If probes red — fix, repeat full sweep #17, back to Inspector. Iterate.
21. **Tag** `v0.5.0`.
22. **Push** `git push origin main v0.5.0`.

## Step 5 — Open Questions

- **`git_diff` rev_b default semantics.** Spec говорит «default uncommitted». Это `--cached` (staged) vs uncommitted (worktree)? Recommendation: `rev_a: "HEAD"`, `rev_b: null` → worktree diff (i.e., `git diff HEAD`). If staged-only wanted — `rev_b: "--cached"`. Document explicit.

- **`execute_command` working dir defaults.** Spec не fixes. Recommendation: default к `allowedRoots[0]`. Explicit `cwd: ""` или `cwd: null` → same default. Каллер пишет `cwd: "."` относительно serving dir — **reject** as `EINVAL` (relative paths не allowed).

- **`run_pytest` xdist / parallelism.** Spec не fixes. Recommendation: default sequential (`-p no:xdist`); если `args.parallel: N` задан — pass `-n N`. Не блокер для v0.5.0.

- **`fetch_url` HTTP/2 / HTTP/3 support.** Default Node `http`/`https` modules handle HTTP/1.1 only. HTTP/2 requires `http2`. Recommendation: HTTP/1.1 only в v0.5.0.

- **`check_env` prefix length.** Spec hardcoded "first 4 chars" в invariant #8. Should это be config-tunable? Recommendation: **NO**. 4 chars is the bound by spec; tunability would break the invariant contract.

- **`git_blame` for renamed files.** `git blame --follow` walks rename history. Default? Recommendation: **off** in v0.5.0.

## Готов?

Workflow execution order:

1. Phase 4a (carryover hygiene + verify push) — fast, ~30 min
2. Phase 4b (grep + edit_file reviews) — terminal-CC subagent flow
3. Phase 4cde (all 11 tools, no test pauses, immediate review on execute_command + fetch_url) — ~6-8 hr total
4. Phase 4f (full test sweep + Inspector smoke + docs + tag) — ~2 hr (more if test red-fix iterations needed)

**Test runs:** Single full `npm test` at Phase 4f #17. Никаких per-phase test passes — CC может sanity-check subset tests while building (lesson #16), но full sweep batched.

**Inspector probes:** Single session at Phase 4f #20. All 29 tools, all v0.4-deferred + v0.5-new red-team probes covered в одной sweep.

**External reviews:** NOT batched — каждая mutation surface (edit_file, grep, execute_command, fetch_url) reviewed immediately after impl. Review is gate, not post-mortem.

Hand-off ко мне (Claude в чате) в трёх точках:

- **После каждого review wave findings** — sanity check перед apply
- **После Phase 4d step 10 (execute_command merged + reviewed, before run_python/run_pytest)** — это самая опасная mutation surface за весь проект, требует extra eyes
- **После Phase 4f #17 (full test sweep green) до #20 (Inspector)** — sanity check что 240+ tests + zero TS warnings + all docs done, прежде чем prove out через Inspector

Поехали.
