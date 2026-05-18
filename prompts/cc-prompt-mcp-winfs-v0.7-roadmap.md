# winfs v0.7.0 Roadmap — DC Parity Wave

> **Audience:** Claude Code (and chat-Claude planning v0.7) AFTER v0.6.0 ships and Inspector smoke is clean.
> Status: roadmap only. NOT an executable prompt. When v0.6.0 is tagged and pushed, chat-Claude will produce a detailed implementation prompt (`cc-prompt-mcp-winfs-v0.7.md`) similar in shape to the v0.6 cycle prompt.

---

## Mission

winfs ставит цель быть **лучше** чем Desktop Commander и `@modelcontextprotocol/server-filesystem` по совокупности:
- безопасность (allowedRoots + audit log + atomic writes + SSRF defense + blocklist) — мы УЖЕ впереди;
- эргономика (persistent shells, async grep с pagination, diff на near-miss, process management) — **отстаём, в v0.7 догоняем**.

После v0.7 winfs должен покрывать всё что у пользователя есть в DC сегодня, плюс свои safety-инварианты.

---

## Scope summary

**Четыре фичи:**

- **A — `edit_file` char-level diff on EUNIQUE** (UX-улучшение существующего инструмента)
- **B — `start_process` + `interact_with_process`** (persistent shells, новые инструменты)
- **C — `grep` async + pagination** (расширение существующего инструмента)
- **D — `list_processes` + `kill_process`** (process management, gated config flag)

**Net surface delta:** 30 (v0.6) → 33 (v0.7). Три новых инструмента (`start_process`, `interact_with_process` объединены в одну логическую пару, плюс отдельный `list_processes` и `kill_process` — итого +3 счёт по public API), плюс расширения на `edit_file` и `grep`, плюс один config knob `processManagement: bool`.

---

## Feature A — `edit_file` char-level diff on EUNIQUE

**Текущая боль:** когда `edit_file` фейлится на uniqueness check (нашёл 0, или нашёл больше 1, или нашёл не то количество что в expected_count), пользователь получает только число и edit_index. Дальше — самостоятельно искать почему не нашлось. Часто причина — лишний пробел, табы vs spaces, CRLF vs LF, или подобное.

**DC-аналог:** `edit_block` показывает unified character-diff на ближайший nearest match с маркерами `{-removed-}{+added+}`.

**Контракт расширения:**
- При EUNIQUE с `occurrences_found === 0`, response.details приобретает поле `closest_match: {at_offset: number, diff: string}` где diff — это `common_prefix{-old_str_chars-}{+actual_file_chars+}common_suffix`.
- Для `occurrences_found > expected_count` — diff не нужен (есть полное совпадение, просто много).
- Поиск closest_match через простой sliding-window similarity score, отсечка ≥0.7 (иначе закрашен — diff не показываем, поле опускается).
- Длина diff капается в 512 символов вокруг точки расхождения (не возвращать весь файл).

**Тесты:** unit тесты на 5 случаев (точное совпадение, near-miss whitespace, near-miss CRLF, near-miss completely-different, far-miss где diff не показывается).

**Инвариант:** не ослабляет уникальность, только улучшает диагностику.

---

## Feature B — `start_process` + `interact_with_process`

**Текущая боль:** `execute_command` одноразовый. Многошаговые сценарии (npm install → ждать → npm test → анализ ошибки → правка → npm test ещё раз) превращаются в 4 отдельных PowerShell-сессии без shared state.

**DC-аналог:** `start_process` запускает persistent shell, возвращает `process_id`. `interact_with_process(process_id, input)` шлёт строку и читает следующий ответ.

**Контракт:**

`start_process`:
```
input: {
  command: string                    // "pwsh", "python", "node", etc.
  args?: string[]                    // CLI args
  cwd?: AbsolutePath                 // must be inside allowedRoots
  env?: Record<string, string>       // safe-prefix applied like check_env
  timeout_idle_ms?: number           // default 60000, max config.processIdleTimeoutMs
}
output: {
  process_id: string                 // server-generated UUID
  pid: number                        // OS pid for forensics
  cwd: string
  started_at: ISO8601
}
```

`interact_with_process`:
```
input: {
  process_id: string
  input: string                      // line to send to stdin
  read_timeout_ms?: number           // default 30000, max config.processReadTimeoutMs
  read_until?: "newline" | "prompt_regex" | "eof"  // default "newline"
  prompt_regex?: string              // when read_until === "prompt_regex"
}
output: {
  process_id: string
  stdout: string                     // accumulated since last call
  stderr: string
  alive: boolean
  exit_code?: number                 // only if alive === false
}
```

**Invariants:**
- **#35** — process spawns under allowedRoots cwd unless unrestricted mode
- **#36** — каждый turn (start + interact) пишет audit entry с input + stdout/stderr (capped 4KB per stream, same as execute_command)
- **#37** — процесс убивается автоматически если idle > timeout_idle_ms ИЛИ если total lifetime > config.maxProcessLifetimeMs (default 10 минут, max 1 час)
- **#38** — на server shutdown все persistent processes гарантированно завершаются (SIGTERM → 5s grace → SIGKILL); это происходит и при `_server_start` нового instance после crash
- **#39** — process pool capped at config.maxConcurrentProcesses (default 5)

**Tests:** 12-15 unit тестов, 5-7 invariant тестов (lifetime cap, idle timeout, shutdown cleanup, concurrent cap, audit redaction).

**Сложность:** самая большая фича в v0.7. ~6-8 часов CC.

---

## Feature C — `grep` async + pagination

**Текущая боль:** `grep` возвращает все matches разом. На большом репо может упереться в response size limit. Plus нет способа «прервать» поиск — он либо завершился, либо TIMEDOUT.

**DC-аналог:** `start_search` запускает поиск async, возвращает `search_id`. `get_more_search_results(search_id)` читает следующую партию.

**Контракт расширения существующего `grep`:**
- Новый optional input: `page_size?: number` (default unlimited, max 1000 matches per page)
- Новый optional input: `continuation_token?: string` (opaque cursor)
- Response расширяется: `has_more: boolean`, `continuation_token?: string` (только если has_more)
- Когда `continuation_token` передан в input, новый поиск НЕ стартует — продолжается старый. Server держит state поиска до config.grepCacheMs (default 5 минут).

**Это back-compat:** старые вызовы без `page_size` и `continuation_token` работают как раньше (всё возвращается разом). Расширение опциональное.

**Invariants:**
- **#40** — continuation_token opaque, не парсится клиентом, не угадывается (UUID + HMAC of search params, чтобы нельзя было подсунуть чужой cursor)
- **#41** — search state TTL: после grepCacheMs unused — удаляется. Возврат с истёкшим token = `ESEARCH_EXPIRED`

**Tests:** 6-8 unit, 2-3 invariant (TTL expiry, token tampering rejection).

---

## Feature D — `list_processes` + `kill_process`

**Текущая боль:** транспорт зависает — хочется увидеть зависший node-процесс и завершить его. Сейчас это делается через DC `start_process` + manual `Stop-Process`.

**Контракт:**

`list_processes`:
```
input: {
  filter?: "winfs_managed" | "all"  // default "winfs_managed"
  name_pattern?: string              // regex on process name
}
output: {
  processes: Array<{
    pid: number
    name: string
    command_line: string             // truncated to 256 chars
    started_at: ISO8601
    cpu_seconds: number
    memory_mb: number
    managed_by_winfs: boolean        // true если start_process'ом нашим
  }>
}
```

`kill_process`:
```
input: {
  pid: number
  signal?: "SIGTERM" | "SIGKILL"     // default SIGTERM
  managed_only?: boolean             // default true — kill только если managed_by_winfs
}
output: {
  pid: number
  was_alive: boolean
  killed: boolean
  signal_sent: string
}
```

**Invariants:**
- **#42** — `list_processes(filter: "all")` требует `config.processManagement === true` (default false). Иначе только winfs_managed visible.
- **#43** — `kill_process(managed_only: false)` требует `config.processManagement === true`. Это **второй магический флаг** аналогично `unrestrictedFilesystem`: `processManagement: true` требует `processManagementConfirm: "I-UNDERSTAND-THE-RISK"`.
- **#44** — `kill_process` НИКОГДА не убивает PID 0, 4 (System), и текущий winfs server PID. Whitelist exclusions hardcoded.
- **#45** — `kill_process` всегда audit. Mutation tool.

**Tests:** 10-12 unit, 4-6 invariant (managed_only enforcement, PID blacklist, magic confirm gate, audit entries).

---

## Consumer-agent feedback adds (2026-05-18 ecom session)

> Источник: ~1-часовая сессия в ecom-проекте Владимира 2026-05-18, где consumer Chat-Claude использовал winfs + Desktop Commander против Windows-машины и зафиксировал три точки трения. Полный отчёт — в appendix'е промпта `prompts/cc-prompt-v0.7-wave1-ssh-listpath-writejson.md`.
>
> Эти три добавления уезжают как **v0.7 wave 1** ДО основной DC-parity волны (фич A–D выше). Они независимы от A–D и закрывают remote-admin use case (через ssh), который сейчас effectively impossible через `execute_command`.

**Net surface delta после wave 1:** 30 (v0.6) → 33. Главная DC-parity волна потом доводит до 36.

### `winfs:ssh_exec` (first-class SSH)

**Текущая боль:** `execute_command` не может надёжно вызвать `ssh.exe` из-за трёх накладывающихся проблем — sanitized PATH прячет `System32\OpenSSH`; PowerShell режектит ssh.exe в pipeline ("Cannot run a document in the middle of a pipeline"); known bug #2 проекта — silent stdout / empty exit 0 при `& "ssh.exe" -V` через execute_command. Все три обходятся одним решением: spawn'им ssh.exe напрямую через `child_process.spawn`, без shell.

**Контракт:**

- **Input:** `{ host: string, command: string, timeout_seconds?: number }` — default 30 s, max 300 s.
- **Host validation:** `host` ДОЛЖЕН быть `Host` alias'ом, резолвящимся в `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`). Метод: вызывается `ssh -G <host>` с коротким timeout'ом; exit 0 и резолвенная `hostname` строка → alias валиден. Raw `user@host` строки НЕ принимаются. SSH config пользователя — это whitelist; nothing else.
- **Spawn:** `child_process.spawn` напрямую по абсолютному пути к ssh.exe (resolved once at startup; default `C:\Windows\System32\OpenSSH\ssh.exe`, configurable через `config.sshExePath`). Без shell, без PowerShell wrapper'а. Аргументы: `[host, command]`.
- **Output envelope:** `{ host, stdout, stderr, exit_code: number | null, timed_out: boolean, truncated_stdout?: boolean, truncated_stderr?: boolean, duration_ms: number }`. 4-KB truncation per stream, mirrors `execute_command` policy.
- **Error codes:**
  - `EHOST_UNKNOWN` — host не резолвится через `ssh -G`
  - `ESSHNOTFOUND` — ssh.exe не существует по configured/default path
  - `ETIMEDOUT` — превышен `timeout_seconds`
  - `EIO` — child process не стартовал (mirror v0.6 §U exec_safety fix)
- **Audit:** mutation-class entry. host, command prefix (256 chars), exit_code, timed_out, spawnFailed. Carries `mode` per invariant #30.
- **Mode behaviour:** разрешён в обоих режимах (strict + unrestricted) — ssh_exec это deliberate egress gated by ssh config, не allowedRoots.
- **Documented prerequisite (not enforced):** работающий ssh-agent или passphrase-less ключ. Non-interactive subprocesses на Windows не наследуют Pageant/agent state.

### `winfs:list_path_dirs` (sanitized PATH introspection)

**Текущая боль:** агенты не знают, какие директории видит subprocess-окружение (sanitized PATH из `find_command` / `execute_command` / `run_python`). Дебажить "почему binary X не виден" приходится trial-and-error'ом.

**Контракт:**

- **Input:** none.
- **Output:** `{ path_dirs: string[] }` — sanitized PATH в порядке resolution.
- **Read-only:** audit entry omits `mode` field (per invariant #30 read-only convention).
- **No tool-specific error codes** beyond the standard envelope (`ETIMEDOUT` if wrapper deadline hits, etc.).

### `winfs:write_json` (atomic JSON write, symmetric to `read_json`)

**Текущая боль:** `read_json` есть, `write_json` нет. Round-trip workflow (read → mutate → write) приходится собирать вручную через `JSON.stringify` + `write`, без `.json` extension check.

**Контракт:**

- **Input:** `{ path: string, value: unknown, indent?: number, overwrite?: boolean }` — default `indent: 2`, `overwrite: false`.
- **Behaviour:** валидируется `.json` extension (case-insensitive) на canonicalized path, serialize через `JSON.stringify(value, null, indent)`, append trailing newline, atomic write через тот же temp+fsync+rename primitive как у `winfs:write`.
- **Output envelope:** идентичен `winfs:write`: `{ bytes_written, lines_written, created }`.
- **Error codes:** все ошибки `write` (`EPERM_ROOT`, `EEXIST`, `ENOENT`, `EIO`, `ETIMEDOUT`), плюс новый `EEXT_NOT_JSON` когда path не оканчивается на `.json`.
- **Mode behaviour:** mutation, carries `mode`.

---

## Hard invariants — preview сводный список v0.7

- **#35–#39** для Feature B (start_process / interact)
- **#40–#41** для Feature C (grep pagination)
- **#42–#45** для Feature D (process management)
- Feature A не добавляет новых invariants (только улучшает UX существующего)

Plus carry-forward всех v0.5 + v0.6 invariants (#1–#34).

---

## Spec amendments planned

- **§X** — v0.7 wave 1: `ssh_exec` + `list_path_dirs` + `write_json` (consumer-agent feedback)
- **§Y** — `start_process` + `interact_with_process` contract
- **§Z** — `list_processes` + `kill_process` contract + magic-string `processManagement` config
- **§AA** — `grep` pagination extension (back-compat)
- **§AB** — `edit_file` EUNIQUE response shape extension (closest_match field)

---

## Phased delivery (5 phases + wave 1, estimated 18–26 hours CC)

**Phase 7-wave1 — Consumer-agent feedback adds (`ssh_exec` + `list_path_dirs` + `write_json`):** 2–4 hours
- Ships ahead of features A–D; independent of them.
- См. отдельный prompt `prompts/cc-prompt-v0.7-wave1-ssh-listpath-writejson.md`.
- Commits: `feat(system): list_path_dirs`, `feat(file): write_json`, `feat(system): ssh_exec`, plus spec §X + docs.

**Phase 7a — Feature A (edit_file diff):** 1–2 hours
- src/tools/editor/edit_file.ts (add closest_match calculation)
- New tests/unit/editor/edit_file_diff.test.ts (5 cases)
- Commit: `feat(editor): edit_file char-diff on near-miss EUNIQUE`

**Phase 7b — Feature C (grep pagination):** 3–4 hours
- src/tools/search/grep.ts (pagination support)
- New src/core/search_state.ts (search state registry with TTL)
- tests/unit/search/grep_pagination.test.ts (8 cases)
- tests/invariants/grep_pagination_token.test.ts (3 invariants)
- Commit: `feat(search): grep async pagination + continuation tokens`

**Phase 7c — Feature D (process management):** 3–4 hours
- src/tools/system/list_processes.ts (new)
- src/tools/system/kill_process.ts (new)
- src/core/config.ts (add processManagement + processManagementConfirm)
- src/server.ts (register 2 new tools)
- tests + invariants
- Commit: `feat(system): list_processes + kill_process with magic-flag gate`

**Phase 7d — Feature B (persistent processes):** 6–8 hours (самая большая)
- src/core/process_pool.ts (new — managed process registry, lifetime tracking, cleanup)
- src/tools/exec/start_process.ts (new)
- src/tools/exec/interact_with_process.ts (new)
- src/server.ts (register + shutdown hooks for pool cleanup)
- src/index.ts (shutdown signal handlers ensure pool cleanup)
- Tests + invariants extensive
- Commit: `feat(exec): start_process + interact_with_process (persistent shells)`

**Phase 7e — Docs + Inspector + release:** 3–4 hours
- Spec amendments §X–§AA
- CHANGELOG [0.7.0]
- README (33 tools, process management section, persistent shells section)
- docs/v0.7-acceptance.md
- prompts/cc-prompt-v0.7-inspector-smoke.md (с учётом lessons from v0.6 smoke)
- Inspector smoke run (33 tools + magic flag enabled probe)
- chore(release): bump 0.6.0 → 0.7.0
- Tag v0.7.0 + push

---

## Acceptance criteria

1. `npm run build` exit 0, zero TS diagnostics
2. `npm test` ≥ 330 (293 v0.6 baseline + ~40 new for v0.7)
3. structured_content invariant covers новые envelopes (start_process, interact_with_process, list_processes, kill_process)
4. Все v0.7 invariant tests существуют и проходят
5. Inspector smoke probes 33 tools, обе процесс-режимы (default off + processManagement on с magic confirm)
6. Spec amendments §X–§AA appended
7. CHANGELOG [0.7.0] matching depth v0.6 entry
8. README + acceptance.md обновлены
9. Tag v0.7.0 annotated + pushed
10. Fresh clone тест от v0.7.0 tag — `npm test` 330+ passes

---

## Out of scope для v0.7

❌ PDF read/write (DC имеет — отдельный пакет в будущем или v1.0)
❌ Excel/DOCX manipulation (DC имеет через `edit_block` range mode — отдельный пакет)
❌ Cross-session persistent shells (сессии живут только в lifetime winfs server process)
❌ Remote process management (только локальный PS/Python/etc на той же машине)
❌ Process priority / niceness control (низкий приоритет)
❌ Container/sandbox isolation (Windows job objects — v0.8+)

---

## Связь с v0.6 review wave

Если внешние ревьюеры (codex / kimi / gemini / deepseek) на v0.5.1 surface найдут P1 находки на `edit_file` или `grep` — фиксы идут как `v0.5.2` патчи на `main`, **до** старта v0.7. v0.7 ветка ребейзится на post-fix `main` перед слиянием.

То же для v0.6 — если на свежеspawn'ленных `write_chunk` или unrestricted-mode будут P1 находки — фиксятся как `v0.6.1` патчи.

v0.7 НЕ стартует пока:
1. v0.6.0 тегнут и пушнут
2. Никаких P1 не в очереди по v0.5.x / v0.6.x

---

## Next steps after v0.6.0 ships

Чат-Claude:
1. Анализирует ситуацию — что в очереди по review wave, нет ли P1 от v0.6 Inspector smoke
2. Пишет детальный implementation prompt `prompts/cc-prompt-mcp-winfs-v0.7.md` (этот roadmap — план; тот будет шаговая инструкция)
3. CC создаёт ветку `v0.7` от `main` после ребейза на post-v0.6 state
4. Phases 7a → 7e с hand-off points

Hand-off points (предварительно):
- После 7a + 7b + 7c (мелкие фичи зелёные) — sanity check
- После 7d (большая фича зелёная) — sanity check process pool invariants
- После 7e Inspector smoke — перед тегом

Wall-clock estimate: ~2 рабочих дня CC.

---

## Status

🟡 **Roadmap committed, NOT executable.** Detailed implementation prompt будет написан после v0.6.0 ship.

