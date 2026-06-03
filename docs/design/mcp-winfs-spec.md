# MCP-WinFS — Спецификация v1.0

**Назначение.** Один универсальный MCP-сервер для архитекторской работы в Claude Desktop под Windows 10/11. Заменяет нестабильную связку Desktop Commander + Filesystem MCP + windows-mcp одним фокусированным инструментом с предсказуемым поведением, жёсткими таймаутами и атомарными записями.

**Покрытие.** Дизайн универсальный, не содержит проектно-специфичной логики. Под капотом — все необходимые примитивы и операции для двух эталонных проектов (eCom prompt-engineering + AI Judge architect-space), но MCP сам по себе ничего о них не знает. Domain helpers реализуются композицией из примитивов или через `run_python`.

**Не делает (out of scope):**
- Long-running terminal sessions (DC-паттерн `start_command` / `read_output` / `list_sessions`)
- Interactive process stdin (REPL, SSH, DB shells)
- Native Windows UI automation (Click, Type, State, App — это windows-mcp territory)
- Git mutations (commit/push/reset/checkout/stash)
- Native Excel/PDF/DOCX handling
- Polling-based file watching / subscriptions
- Background search engine с индексом

---

## 1. Архитектурные решения

| Решение | Обоснование |
|---|---|
| **TypeScript** | Нативная типизация для structured outputs, лучшая поддержка MCP SDK, нативный MCPB packaging |
| **Node.js ≥18** | Встроен в Claude Desktop после Desktop Extensions; не добавляем второй runtime |
| **stdio transport** | Локальный сервер, нет HTTP-стека, нет портов, нет network surface |
| **Прямой `node dist/index.js`, не `npx`** | Исключаем класс багов с npx-обёрткой на Windows |
| **`@modelcontextprotocol/sdk`** | Официальный SDK, актуальные best practices |
| **Zod** | Input schema + runtime validation в одном месте |
| **`simple-git`** для git RO ops | Типизированный output, mutation-команды просто не экспонируются |
| **Atomic writes через temp + rename** | `fs.promises.rename` атомарен на одном томе NTFS |
| **Audit log в JSONL** | Простой парсинг, ротация по размеру, recovery после краша чата |
| **Конфиг статичен** | Никакого `set_config_value` в runtime — изменения только через restart |

---

## 2. Hard-инварианты

Зашиты в core, не отключаются конфигом, не bypass-ятся через args.

1. **UTF-8 native I/O.** Все text-операции читают/пишут UTF-8. BOM стрипится при чтении, никогда не пишется при записи. PowerShell-выводы форсятся через `chcp 65001` + `[Console]::OutputEncoding = [Text.Encoding]::UTF8` перед каждым вызовом.

2. **Realpath canonicalize → allowed-roots check.** Любой `path` сначала проходит через `fs.realpath()`, потом проверяется на префикс из `config.allowedRoots`. Защита от junction/symlink/`..`-escape.

3. **Bounded timeouts.** Default 10 секунд, max 60 секунд (для shell — отдельный `shellTimeoutMs` до 5 мин). По истечении — `kill` дочернего процесса (если есть) + structured error `ETIMEDOUT`. Никогда не висит.

4. **Structured errors как content, не как throw.** Все ошибки возвращаются как валидный tool response с полем `{code, message, details?, hint?}`. Claude парсит код и решает дальше. Throws — только для programmer errors (неверные args на уровне Zod).

5. **Atomic writes.** `write` и `append` идут через `temp_file → fsync → rename`. Никаких partial writes если процесс упал посередине.

6. **Git mutation hard-deny.** Все git-инструменты строго read-only. Validation на уровне args (никаких `--force`, `-D`, `reset`, `checkout` куда не нужно). На уровне реализации — используем только read-only методы `simple-git`.

7. **execute_command blocklist.** Regex pre-validation перед спавном. Дефолтный blocklist: `Remove-Item.*-Recurse`, `format [A-Za-z]:`, `bcdedit`, `reg delete HKLM`, `shutdown`, `Stop-Process.*-Force`, `cipher /w`, `Clear-Disk`, `Initialize-Disk`. Расширяется в config.

8. **`check_env` safe-prefix only.** Возвращает `{present: bool, length: int, prefix: string (первые 4 chars)}`. Никогда полный value, даже если переменная пустая.

9. **`edit_file` uniqueness check.** `old_text` ДОЛЖЕН встречаться в файле ровно 1 раз. Если 0 — `ENOMATCH`. Если >1 — `EUNIQUE` с подсказкой расширить контекст. Никакого fuzzy matching.

10. **`fetch_url` whitelist.** Hosts из `config.allowedUrlHosts` + deny на internal IP ranges (`127.*`, `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`, `::1`, `localhost`) если хост явно не в whitelist. Hard size limit 5 МБ, hard timeout 15 сек, только http/https.

11. **Audit log.** Каждый tool call логируется в JSONL: `{ts, tool, args (sanitized), result_status, duration_ms}`. Чувствительные args (env values, content тела при write/append) — заменяются на `<redacted: N bytes>`. Ротация при превышении `auditLogMaxBytes`.

12. **No runtime config mutation.** Никаких `set_config_value`, `block_command`, `unblock_command`. Изменения конфига — только через restart процесса. Это убирает поверхность для prompt injection.

---

## 3. Конфигурация

Файл: `%LOCALAPPDATA%\mcp-winfs\config.json` (или `--config <path>` argv).

```json
{
  "allowedRoots": [
    "C:\\Users\\Expert\\Desktop\\eCom",
    "C:\\Users\\Expert\\Desktop\\AI\\ai-judge",
    "C:\\Users\\Expert\\Dropbox\\Projects"
  ],
  "allowedUrlHosts": [
    "nas.local:3000",
    "raw.githubusercontent.com",
    "gitea.example.com"
  ],
  "deniedUrlPatterns": [
    "^https?://(127\\.|10\\.|172\\.(1[6-9]|2\\d|3[01])\\.|192\\.168\\.|169\\.254\\.|\\[::1\\]|localhost)"
  ],
  "shellBlocklist": [
    "Remove-Item\\s+.*-Recurse",
    "\\bformat\\s+[A-Za-z]:",
    "bcdedit",
    "reg\\s+delete\\s+HKLM",
    "shutdown",
    "Stop-Process\\s+.*-Force",
    "Clear-Disk",
    "Initialize-Disk"
  ],
  "defaultTimeoutMs": 10000,
  "maxTimeoutMs": 60000,
  "shellTimeoutMs": 30000,
  "shellMaxTimeoutMs": 300000,
  "fetchUrlMaxBytes": 5242880,
  "fetchUrlTimeoutMs": 15000,
  "readMaxBytes": 10485760,
  "auditLogPath": "%LOCALAPPDATA%\\mcp-winfs\\audit.jsonl",
  "auditLogMaxBytes": 10485760
}
```

**Важно:** конфиг ДОЛЖЕН быть UTF-8 БЕЗ BOM. PowerShell `Set-Content -Encoding UTF8` добавляет BOM — использовать `Out-File -Encoding utf8NoBOM` или текстовый редактор с явным контролем.

### 3.1. Runtime vs dev fixtures

Файлы `configs/default.json` и `configs/local.json` в репозитории — это
**development-time fixtures**, используемые тестами и для документации
схемы. Они **НЕ загружаются runtime-сервером**. Фактический lookup-путь
конфига: `%LOCALAPPDATA%\mcp-winfs\config.json` (разрешается через
переменную окружения `LOCALAPPDATA`, либо через платформенный default —
см. `defaultConfigPath()` в `src/core/config.ts`). Если этот файл
отсутствует, сервер стартует с пустыми `allowedRoots`, и каждый
path-bound вызов возвращает `EPERM_ROOT` с хинтом, указывающим на тот
же ожидаемый путь.

---

## 4. Tool Inventory (29 инструментов)

### 4.1. Core FS (5)

#### `read`
**Описание.** Чтение файла как текста (UTF-8). Поддерживает чтение строкового range и байтовый limit.
**Input:**
```ts
{
  path: string,                    // absolute path внутри allowedRoots
  range?: [number, number],        // [start_line, end_line], 1-based, inclusive
  max_bytes?: number               // default config.readMaxBytes
}
```
**Output:** `{ content: string, lines_returned: number, bytes_returned: number, truncated: boolean }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ENOENT, EISDIR, ETOOLARGE, EENCODING, ETIMEDOUT`

#### `write`
**Описание.** Атомарная запись файла целиком (overwrite). Создаёт parent-директории если `mkdirParents: true`.
**Input:**
```ts
{
  path: string,
  content: string,
  overwrite?: boolean,             // default true
  mkdirParents?: boolean           // default false
}
```
**Output:** `{ bytes_written: number, lines_written: number, created: boolean }`
**Annotations:** `readOnlyHint: false, destructiveHint: true (если overwrite), idempotentHint: true`
**Errors:** `EPERM_ROOT, EEXIST, ENOENT (parent dir), EIO`

#### `append`
**Описание.** Append текста к существующему файлу. UTF-8, atomic.
**Input:** `{ path: string, content: string }`
**Output:** `{ bytes_added: number, new_size: number }`
**Annotations:** `readOnlyHint: false, destructiveHint: false, idempotentHint: false`
**Errors:** `EPERM_ROOT, ENOENT, EIO`

#### `list`
**Описание.** Листинг директории с метаданными. Опциональная глубина и glob-фильтр.
**Input:**
```ts
{
  path: string,
  max_depth?: number,              // default 1, max 5
  glob?: string                    // напр. "*.md"
}
```
**Output:** `Array<{ name: string, path: string, size: number, mtime: string (ISO), is_dir: boolean, depth: number }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ENOENT, ENOTDIR`

#### `stat`
**Описание.** Метаданные пути. Возвращает `{exists: false}` вместо ошибки если не существует.
**Input:** `{ path: string }`
**Output:** `{ exists: boolean, is_dir?: boolean, size?: number, mtime?: string, ctime?: string, mode?: string }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT` (только если path вне allowedRoots)

### 4.2. FS Mutations (3)

#### `move`
**Описание.** Переименование/перемещение файла или директории. Оба пути в allowedRoots.
**Input:** `{ src: string, dst: string, overwrite?: boolean (default false) }`
**Output:** `{ moved: true, src: string, dst: string }`
**Annotations:** `readOnlyHint: false, destructiveHint: true, idempotentHint: false`
**Errors:** `EPERM_ROOT, ENOENT, EEXIST, EBUSY`

#### `copy`
**Описание.** Копирование файла. Для директорий — recursive по умолчанию.
**Input:** `{ src: string, dst: string, overwrite?: boolean (default false), recursive?: boolean (default true) }`
**Output:** `{ copied: true, bytes_copied: number, files_copied: number }`
**Annotations:** `readOnlyHint: false, destructiveHint: false, idempotentHint: false`
**Errors:** `EPERM_ROOT, ENOENT, EEXIST, EIO`

#### `mkdir`
**Описание.** Создание директории. Recursive по умолчанию.
**Input:** `{ path: string, recursive?: boolean (default true) }`
**Output:** `{ created: boolean, path: string }`
**Annotations:** `readOnlyHint: false, destructiveHint: false, idempotentHint: true`
**Errors:** `EPERM_ROOT, EEXIST (если recursive=false и существует)`

### 4.3. Search & Convenience (4)

#### `grep`
**Описание.** Текстовый поиск по файлам с поддержкой glob и контекста.
**Input:**
```ts
{
  path_glob: string,               // напр. "prompts/**/*.md"
  pattern: string,                 // regex
  case_sensitive?: boolean,        // default false
  context_lines?: number,          // default 0, max 10
  max_matches?: number             // default 50
}
```
**Output:** `Array<{ file: string, line: number, match: string, context_before?: string[], context_after?: string[] }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ETIMEDOUT`

#### `glob`
**Описание.** Find files matching glob pattern.
**Input:** `{ pattern: string, max_results?: number (default 200) }`
**Output:** `Array<string>` (абсолютные пути)
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT`

#### `read_json`
**Описание.** Convenience: read + JSON.parse в одном вызове.
**Input:** `{ path: string }`
**Output:** `{ data: unknown, size_bytes: number }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ENOENT, EIO, EBADJSON`

#### `read_multiple_files`
**Описание.** Batch чтение нескольких файлов в одном вызове. Каждый файл — независимый результат, ошибка одного не блокирует остальные.
**Input:** `{ paths: string[], range?: [number, number] }` (range применяется ко всем)
**Output:** `Array<{ path: string, content?: string, error?: { code: string, message: string } }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** возвращаются per-file в массиве

### 4.4. Editor (1)

#### `edit_file`
**Описание.** Surgical edit через массив `{old_text, new_text}` пар. Каждый `old_text` ДОЛЖЕН встречаться ровно 1 раз в файле. Опциональный `dry_run` возвращает diff без записи.
**Input:**
```ts
{
  path: string,
  edits: Array<{ old_text: string, new_text: string }>,
  dry_run?: boolean                // default false
}
```
**Output:** `{ applied: number, dry_run: boolean, diff: string (unified format), would_apply?: Array<{old_text_preview, new_text_preview}> }`
**Annotations:** `readOnlyHint: false (если dry_run=false), destructiveHint: true, idempotentHint: false`
**Errors:** `EPERM_ROOT, ENOENT, EUNIQUE (old_text не уникален), ENOMATCH (old_text не найден)`

### 4.5. Slicing (3)

#### `read_section`
**Описание.** Чтение секции файла между маркерами. Поддерживает markdown headings и regex anchors.
**Input:**
```ts
{
  path: string,
  start_marker: string,            // напр. "## §15" или regex
  end_marker?: string,             // если опущен — до следующего того же уровня (для md) или EOF
  marker_type?: "md_heading" | "regex"   // default "md_heading"
}
```
**Output:** `{ content: string, start_line: number, end_line: number, lines: number }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ENOENT, ENOMATCH (start_marker не найден)`

#### `read_since`
**Описание.** Инкрементальное чтение: возвращает контент от `byte_offset` до конца. Используется для tail'инга растущих логов.
**Input:** `{ path: string, byte_offset: number }`
**Output:** `{ content: string, new_offset: number, bytes_read: number }`
**Annotations:** `readOnlyHint: true, idempotentHint: false (так как offset меняется)`
**Errors:** `EPERM_ROOT, ENOENT, EINVAL (offset > file size)`

#### `diff_files`
**Описание.** Unified diff между двумя файлами на диске (не git, не in-memory).
**Input:** `{ path_a: string, path_b: string, context_lines?: number (default 3) }`
**Output:** `{ diff: string, identical: boolean, lines_added: number, lines_removed: number }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`
**Errors:** `EPERM_ROOT, ENOENT (любой из двух)`

### 4.6. Git Read-Only (5)

Все git-инструменты: hard-deny на mutation args; результат — typed structured output, не raw stdout.

#### `git_log`
**Input:** `{ repo_path: string, range?: string, path_filter?: string, count?: number (default 20) }`
**Output:** `Array<{ hash: string, author: string, email: string, date: string (ISO), message: string, files_changed?: string[] }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `git_status`
**Input:** `{ repo_path: string }`
**Output:** `{ branch: string, ahead: number, behind: number, staged: string[], modified: string[], untracked: string[], conflicted: string[] }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `git_diff`
**Input:** `{ repo_path: string, rev_a?: string (default "HEAD"), rev_b?: string (default uncommitted), path_filter?: string }`
**Output:** `{ diff: string, files_changed: string[], stats: { insertions: number, deletions: number } }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `git_show`
**Input:** `{ repo_path: string, sha: string, path_filter?: string }`
**Output:** `{ hash: string, author: string, date: string, message: string, diff: string, files: Array<{path: string, changes: string}> }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `git_blame`
**Input:** `{ repo_path: string, path: string, line_range?: [number, number] }`
**Output:** `Array<{ line: number, sha: string, author: string, date: string, content: string }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

### 4.7. Execution (3)

#### `execute_command`
**Описание.** Single fire-and-wait shell-команда с bounded timeout. UTF-8 форсится. Blocklist валидируется ДО спавна.
**Input:**
```ts
{
  shell: "powershell" | "cmd",
  command: string,
  cwd?: string,                    // должен быть в allowedRoots
  timeout_ms?: number              // default shellTimeoutMs, max shellMaxTimeoutMs
}
```
**Output:** `{ stdout: string, stderr: string, exit_code: number, duration_ms: number, truncated: boolean }`
**Annotations:** `readOnlyHint: false, destructiveHint: false (если в blocklist — error), idempotentHint: false`
**Errors:** `EBLOCKED_CMD, ETIMEDOUT, EPERM_ROOT (если cwd вне allowed), EIO`

#### `run_python`
**Описание.** Single-shot Python через `uv run python -c` (если в проекте есть .venv/uv) или системный `python`. Structured output.
**Input:** `{ code: string, cwd: string, use_uv?: boolean (default auto-detect), timeout_ms?: number }`
**Output:** `{ stdout: string, stderr: string, exit_code: number, duration_ms: number }`
**Annotations:** `readOnlyHint: false (произвольный код), idempotentHint: false`
**Errors:** `EPERM_ROOT, ETIMEDOUT, EIO`

#### `run_pytest`
**Описание.** Запуск pytest со structured результатом.
**Input:** `{ cwd: string, target?: string, markers?: string, timeout_ms?: number }`
**Output:** `{ passed: number, failed: number, skipped: number, errors: number, duration_ms: number, failures: Array<{test: string, message: string}> }`
**Annotations:** `readOnlyHint: false, idempotentHint: false`
**Errors:** `EPERM_ROOT, ETIMEDOUT, EIO`

### 4.8. System (3)

#### `find_command`
**Описание.** Resolve command в PATH. Альтернатива `where` / `Get-Command`.
**Input:** `{ name: string }`
**Output:** `{ found: boolean, path?: string, version?: string }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `check_env`
**Описание.** Безопасная проверка переменной окружения. Никогда полный value.
**Input:** `{ name: string }`
**Output:** `{ present: boolean, length?: number, prefix4?: string }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

#### `audit_tail`
**Описание.** Чтение последних N записей собственного audit log. Для self-recovery после краша чата.
**Input:** `{ n?: number (default 50, max 500) }`
**Output:** `Array<{ ts: string, tool: string, args_summary: string, result_status: "ok" | "error", error_code?: string, duration_ms: number }>`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

### 4.9. Introspection (1)

#### `list_allowed_directories`
**Описание.** Возвращает текущий список allowedRoots из конфига. Self-orientation для Claude.
**Input:** `{}`
**Output:** `{ allowed_roots: string[], allowed_url_hosts: string[] }`
**Annotations:** `readOnlyHint: true, idempotentHint: true`

### 4.10. Network (1)

#### `fetch_url`
**Описание.** HTTP/HTTPS GET с whitelist хостов, blocklist internal IPs, hard size + timeout.
**Input:**
```ts
{
  url: string,                     // только http:// или https://
  max_bytes?: number,              // default config.fetchUrlMaxBytes, hard cap 5MB
  timeout_ms?: number,             // default config.fetchUrlTimeoutMs, hard cap 30s
  headers?: Record<string, string> // ограниченный allowlist
}
```
**Output:** `{ status: number, headers: Record<string, string>, content: string, content_type: string, bytes: number, truncated: boolean }`
**Annotations:** `readOnlyHint: true, openWorldHint: true, idempotentHint: true`
**Errors:** `EFORBIDDEN_HOST, ETOOLARGE, ETIMEDOUT, EIO`

---

## 5. Error Code Catalog

| Code | Описание | Hint в response |
|---|---|---|
| `EPERM_ROOT` | Path вне allowedRoots | Перечислены allowedRoots для self-orientation |
| `ENOENT` | Файл/директория не существует | — |
| `EISDIR` | Ожидался файл, получена директория | "Use list for directories" |
| `ENOTDIR` | Ожидалась директория, получен файл | — |
| `EEXIST` | Уже существует (при overwrite=false) | "Pass overwrite=true if intended" |
| `ETIMEDOUT` | Превышен timeout | "Configured timeout was N ms" |
| `EUNIQUE` | edit_file: old_text не уникален | Сколько совпадений найдено + предложение расширить контекст |
| `ENOMATCH` | edit_file/read_section: маркер не найден | — |
| `EBLOCKED_CMD` | Команда в blocklist | Какой pattern сработал |
| `EFORBIDDEN_HOST` | Host не в allowlist или в denied | Перечислен allowedUrlHosts |
| `ETOOLARGE` | Превышен size limit | Текущий limit и actual size |
| `EENCODING` | Не UTF-8 / бинарный файл подан как текст | Предложение использовать другой инструмент |
| `EGITMUTATION` | Попытка git mutation | "This server is read-only for git" |
| `EBUSY` | Файл занят другим процессом | Retry-after suggestion |
| `EBADJSON` | read_json: невалидный JSON | Позиция ошибки парсера |
| `EINVAL` | Невалидные args (после Zod валидации) | Что именно не так |
| `EIO` | Generic I/O error | — |

---

## 6. Структура проекта

```
mcp-winfs/
├── package.json
├── tsconfig.json
├── README.md
├── mcpb/                          # MCPB packaging (v0.10.2): manifest.json + launch.mjs shim
├── src/
│   ├── index.ts                   # entry: парсит --config, бутстрапит server
│   ├── server.ts                  # MCP Server setup, registerTool для каждого
│   ├── core/
│   │   ├── config.ts              # load + validate config schema
│   │   ├── allowed_roots.ts       # realpath canonicalize + check
│   │   ├── utf8.ts                # encoding handling, BOM strip
│   │   ├── atomic_write.ts        # temp + fsync + rename
│   │   ├── timeouts.ts            # bounded execution wrapper
│   │   ├── errors.ts              # structured error builder + codes
│   │   └── audit.ts               # JSONL append, rotation
│   ├── tools/
│   │   ├── fs/                    # read, write, append, list, stat, move, copy, mkdir, read_multiple_files, list_allowed_directories
│   │   ├── search/                # grep, glob, read_json
│   │   ├── editor/                # edit_file
│   │   ├── slicing/               # read_section, read_since, diff_files
│   │   ├── git/                   # log, status, diff, show, blame
│   │   ├── exec/                  # execute_command, run_python, run_pytest
│   │   ├── system/                # find_command, check_env, audit_tail
│   │   └── network/               # fetch_url
│   └── schemas/                   # shared Zod schemas
│       ├── common.ts
│       └── results.ts
├── configs/
│   └── default.json
├── tests/
│   ├── unit/                      # vitest, per-tool
│   ├── invariants/                # таргетные тесты hard-инвариантов
│   └── integration/               # MCP Inspector сценарии
└── dist/                          # tsc output
```

---

## 7. Phased Delivery

**Статус: весь функционал поставлен (v0.10.2); v1.0.0-release ещё впереди —
гейт — полный eval suite.** Таблица ниже отражает
**фактическую** поставку (не исходный план — он мапил exec/system/network на
v0.6–v0.7, а по факту они вышли одной волной в v0.5.1). Детальные acceptance —
в `docs/v*-acceptance.md`; пер-волновые поправки спецификации — в §X / §Y / §Z /
§AA / §AB / §AC ниже. Tool surface заморожен на **39 инструментах** с v0.8.

| Версия | Статус | Фактически поставлено |
|---|---|---|
| **v0.1** | ✅ | Core 5 (read/write/append/list/stat) + все hard-инварианты + audit + config |
| **v0.2** | ✅ | Mutations (mkdir/move/copy) + read_multiple_files + list_allowed_directories |
| **v0.3** | ✅ | Search (grep/glob/read_json) + audit_tail |
| **v0.4** | ✅ | Editor (edit_file + dry_run) + Slicing (read_section/read_since/diff_files) |
| **v0.5.1** | ✅ | Git RO (5) + Exec (execute_command/run_python/run_pytest) + System/Network (find_command/check_env/fetch_url) — весь набор «v0.5–v0.7» исходного плана поставлен одной волной. Тег v0.5.0 — фантом. |
| **v0.6** | ✅ | write_chunk + `edit_file.expected_count` + opt-in `unrestrictedFilesystem` (§U, инварианты #28–#30) |
| **v0.7 wave 1** | ✅ | ssh_exec, list_path_dirs, write_json (§X) |
| **v0.7 wave 2a** | ✅ | Улучшения существующих tools: `edit_file` near-miss diff, `grep` pagination, `execute_command` hints (§Y) |
| **v0.7 wave 2b** | ✅ | Process control: start_process / interact / list_process / kill_process — in-memory `ProcessRegistry` (§Z, инварианты #38–#40) |
| **v0.7 wave 2c** | ✅ | Архитектурное закрытие: `ToolContext` refactor, `register*Tool(server, ctx)` (§AB, инвариант #41) |
| **v0.8** | ✅ | Filesystem-MCP parity: directory_tree, read_media_file, `read` head/tail, `list` sort_by → tool surface 37 → **39** |
| **v0.9.0** | ✅ | MCP Roots union mode (§AC, инвариант #42) |
| **v0.9.1 / v0.9.2** | ✅ | Стабилизация 10 flaky process-тестов, `powershellExePath`, `fetch_url` коды (`EMAXREDIRECTS`/`EENCODING_UNSUPPORTED`), `npm audit` 7 → 0 |
| **v0.10.0 / v0.10.1** | ✅ | Child-spawn hardening (explicit PATHEXT — инвариант #43, `GIT_TERMINAL_PROMPT=0`, shell-timeout pair), `allowedRoots` hot-reload, opt-in `WINFS_TRANSPORT_LOG`, timeout-ceiling fix (инвариант #44), ssh auto-detect, `execExtraPathDirs`, deferred-P2 closeout |
| **v0.10.2** | ✅ | MCPB packaging (`winfs-0.10.2.mcpb` + Configure UI, маппинг user_config → runtime config без обхода enforcement, §AD / инвариант #45), production README rewrite. Новых инструментов нет. |
| **v1.0.0** | ⏳ | **Release — планируется.** Гейт: полный eval suite (10 вопросов, ≥ 80 % pass через MCP) + production sign-off. Сейчас в `evals/` — примеры вопросов + драйвер `connections.py`; полный набор и `run.py` ещё впереди. |

---

## 8. Windows 10/11 Specifics

### 8.1. Claude Desktop config location

Стандартный путь: `%APPDATA%\Claude\claude_desktop_config.json`.

**Важно:** если установлен MSIX-вариант Claude Desktop — реальный путь виртуализирован:
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

Кнопка "Edit Config" в самом приложении может открыть **не тот** файл. Проверять явно.

### 8.2. Конфиг MCP-сервера

```json
{
  "mcpServers": {
    "winfs": {
      "command": "node",
      "args": [
        "C:\\tools\\mcp-winfs\\dist\\index.js",
        "--config",
        "C:\\Users\\Expert\\AppData\\Local\\mcp-winfs\\config.json"
      ]
    }
  }
}
```

**Не использовать** `npx` — это источник известных connection failures на Windows. Прямой вызов `node` через абсолютный путь к скомпилированному `dist/index.js`.

### 8.3. UTF-8 в shell

PowerShell в Windows 10 по умолчанию плюёт CP1251/CP866 в stdout. В `execute_command` обязательно префиксить:

```powershell
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
# ... actual command
```

Для `cmd` — `chcp 65001 >nul` перед командой.

### 8.4. Path normalization

Все пути в input приводить к каноническому виду через `path.resolve()` + `fs.realpath()`. На Windows это резолвит:
- Forward/backward slashes
- Junction points (`mklink /J`)
- Symbolic links (если есть права)
- Относительные `.\` и `..\`
- Tilde expansion (если нужно)

Проверка allowed-roots — только после realpath. Иначе junction-escape атака возможна.

### 8.5. Config encoding

Конфиг ДОЛЖЕН быть UTF-8 без BOM. Если открывать в Notepad и пересохранять — добавится BOM, JSON.parse упадёт.

Безопасный способ записи через PowerShell:
```powershell
$json | Out-File -FilePath "config.json" -Encoding utf8NoBOM
```

### 8.6. Node.js requirement

Минимум Node 18. Проверить: `node --version`. В Claude Desktop встроен Node (после Desktop Extensions), но для прямого запуска через `"command": "node"` нужна системная установка либо абсолютный путь к встроенному.

---

## 9. Testing Strategy

### 9.1. Unit tests (vitest)

Per-tool: happy path + каждый error code.

### 9.2. Invariant tests

Отдельный test file на каждый hard-инвариант:
- `invariants/utf8.test.ts` — round-trip русского текста, BOM strip
- `invariants/allowed_roots.test.ts` — junction escape, `..`-escape, symlink escape
- `invariants/timeouts.test.ts` — hang detection, kill verification
- `invariants/atomic_write.test.ts` — partial write recovery, concurrent writes
- `invariants/edit_uniqueness.test.ts` — 0, 1, 2+ matches
- `invariants/git_mutation_deny.test.ts` — пытаемся всеми способами вызвать mutation
- `invariants/shell_blocklist.test.ts` — каждый паттерн блокировки
- `invariants/fetch_url_ssrf.test.ts` — попытки на internal IP, localhost, file://

### 9.3. Integration tests

`@modelcontextprotocol/inspector` — прогнать каждый tool через реальный stdio transport.

### 9.4. Smoke tests на реальных файлах

После каждой версии — прогон в Claude Desktop на реальных файлах:
- Чтение `session_log.md` (русский + английский)
- Чтение `brand_collections.json` (большой JSON)
- Edit handoff с `dry_run`
- Git log в реальном репозитории

---

## 10. Open Questions для v1.0+

Эти решения откладываются до production-опыта, не блокируют v0.1:

- **MCPB packaging.** ✅ Поставлено в v0.10.2: `mcpb/manifest.json` + `mcpb/launch.mjs` (shim user_config → runtime config), сборка `npm run mcpb` → `dist-mcpb/winfs-0.10.2.mcpb`, drag-install в Claude Desktop. См. §AD + инвариант #45.
- **Plugin mechanism.** Если возникнет потребность в domain helpers — добавлять `plugins/` директорию или продолжать через `run_python` композицию?
- **Telemetry.** Нужна ли opt-in anonymous metric collection (как DC) для diagnostics? Скорее нет — privacy-first.
- **Auto-update.** Через npm registry или GitHub releases?

---

## Приложение A: SDK V2 quick reference

**Target: `@modelcontextprotocol/server` V2** (см. amendment 2026-05-16).

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'mcp-winfs',
  version: '0.1.0'
});

server.registerTool(
  'read',
  {
    description: 'Read text file with optional line range. UTF-8, bounded by allowed roots.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path inside allowed roots'),
      range: z.tuple([z.number(), z.number()]).optional()
        .describe('[start_line, end_line], 1-based inclusive'),
      max_bytes: z.number().optional()
    }),
    outputSchema: z.object({
      content: z.string(),
      lines_returned: z.number(),
      bytes_returned: z.number(),
      truncated: z.boolean()
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    }
  },
  async (args) => {
    // Implementation
    const result = await readFileImpl(args);

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result   // V2 feature — клиент может парсить без JSON.parse строки
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

**Ключевые отличия от V1** (для справки на случай fallback):

| Aspect | V1 | V2 |
|---|---|---|
| Package | `@modelcontextprotocol/sdk` | `@modelcontextprotocol/server` |
| Class | `Server` | `McpServer` |
| Constructor | `new Server({name, version}, {capabilities: {tools: {}}})` | `new McpServer({name, version})` |
| Zod import | `import { z } from "zod"` | `import * as z from "zod/v4"` |
| Transport import | `@modelcontextprotocol/sdk/server/stdio.js` | `@modelcontextprotocol/server/stdio` |

---

**Конец спеки v1.0.** Изменения — через amendment-секцию ниже, не in-place правки выше.

## Amendments
<!-- Format: ### YYYY-MM-DD — Title -->
<!-- Содержание amendment -->

### 2026-05-16 — Phase 4 (Evaluations) + mandatory reference files

**Motivation.** Публичная mcp-builder skill (`claudeskills.org/docs/skills-cases/mcp-builder`) выделяет **Phase 4 — Evaluations** как отдельную фазу качества, которую unit и integration тесты не покрывают. Качество MCP измеряется не "компилируется и тесты зелёные", а "Claude через MCP может ответить на реальные многошаговые вопросы". Также skill ссылается на reference-файлы с working examples и quality checklist — они дополняют эту спеку конкретикой по TS-реализации.

**Изменения:**

**A. Mandatory reference loads для CC перед началом любой версии.**

CC обязан подгрузить и интегрировать перед стартом v0.1:

1. https://raw.githubusercontent.com/anthropics/skills/main/mcp-builder/reference/mcp_best_practices.md
2. https://raw.githubusercontent.com/anthropics/skills/main/mcp-builder/reference/node_mcp_server.md
3. https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md

При конфликте между этой спекой и reference — спека выигрывает (она конкретнее под наш use case). При пробеле — reference. Quality checklist из `node_mcp_server.md` интегрируется в acceptance criteria каждой версии как дополнительный gate.

**B. Phase 4 — Evaluations добавляется в Phased Delivery.**

| Версия | Дополнение |
|---|---|
| **v0.1** | Скелет `evals/` директории: `README.md`, заготовка `v1.0-evaluation.xml` с 1-2 примерами (наполняется по мере добавления инструментов в следующих версиях). НЕ требуется реальный прогон. |
| **v0.3–v0.7** | По мере добавления новых инструментов — добавлять 1-2 вопроса в `v1.0-evaluation.xml`, использующих новые tools. К v0.7 должно набраться 10. |
| **v1.0** | Eval suite полностью готова: 10 вопросов, runner на базе `connections.py` + `evaluation.py` из skill'а адаптированных под Anthropic SDK, прогон. **Acceptance: success rate ≥80%** (8 из 10 вопросов Claude отвечает правильно через MCP). |

**C. Eval question requirements** (из skill'а):

Каждый вопрос:
- **Independent** — не зависит от других вопросов
- **Read-only** — никаких mutation операций (`move`, `write`, `mkdir`, `edit_file`, `execute_command`, etc.)
- **Complex** — требует 2+ tool calls и реального exploration
- **Realistic** — отражает реальные задачи архитектора, а не синтетические тесты
- **Verifiable** — единственный clear ответ, проверяется string-comparison
- **Stable** — ответ не меняется со временем (нельзя завязываться на `mtime` или `git_status` текущего состояния)

Формат:
```xml
<evaluation>
  <qa_pair>
    <question>Найди в audit-логах AI Judge все упоминания phase 2.W.6. В каком handoff впервые упомянут OrderWise REST endpoint? Дай имя файла handoff'а.</question>
    <answer>2.W.6.fix.1-handoff.md</answer>
  </qa_pair>
  <!-- ещё 9 -->
</evaluation>
```

**D. Структура проекта дополняется:**

```
mcp-winfs/
├── ... (предыдущее)
└── evals/
    ├── README.md                   # как прогонять, как интерпретировать
    ├── v1.0-evaluation.xml         # 10 вопросов
    ├── run.py                      # eval runner
    ├── connections.py              # MCPConnectionStdio (адаптация из skill'а)
    └── requirements.txt            # anthropic>=0.39.0, mcp>=1.1.0
```

**E. v0.1 deliverable дополняется:**

- `evals/README.md` — описание подхода и плана
- `evals/v1.0-evaluation.xml` — 1-2 примера в правильном формате (placeholder, наполнение позже)
- `evals/connections.py` — рабочая копия из skill scripts (можно скачать как есть, или адаптировать под TypeScript-клиент если предпочтительнее)
- `evals/requirements.txt` — Python зависимости для runner'а (даже если основной сервер TS — runner может быть Python)

### 2026-05-16 — SDK V2: lock-in и обновления API

**Motivation.** В оригинальной спеке Appendix A и архитектурные решения неявно ссылались на v1 SDK (`@modelcontextprotocol/sdk`). Однако `main` ветка typescript-sdk перешла на **V2** с разделением пакетов и новым API. По состоянию на 2026-05-16 v2 планировалась к стабильному релизу Q1 2026. Принято решение строить на V2.

**Изменения:**

**A. Пакеты.**

Заменяем монолит на split:
- ~~`@modelcontextprotocol/sdk`~~ → `@modelcontextprotocol/server` (только серверная часть нужна)
- Опциональные middleware (`@modelcontextprotocol/node`, `/express`, `/hono`) — НЕ нужны, мы делаем stdio-only

`package.json` dependencies:
```json
{
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.0.0",
    "simple-git": "^3.0.0"
  }
}
```

**B. API.**

- ~~`Server`~~ → `McpServer`
- ~~`new Server({...}, { capabilities: { tools: {} } })`~~ → `new McpServer({ name, version })` (capabilities автоматически)
- ~~`import { z } from "zod"`~~ → `import * as z from "zod/v4"` (Zod v4 синтаксис)
- Standard Schema — V2 поддерживает Zod v4, Valibot, ArkType и др. Мы используем **Zod v4** (стандарт mcp-builder skill, и т.к. AI-модели лучше всего генерируют Zod).

**C. Imports.**

```ts
// V2 (наш target):
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
```

**D. Fallback план.**

Если CC обнаружит, что V2 на день билда нестабилен (выпустил npm install, получил ошибки сборки, баги в SDK runtime) — фиксирует это в acceptance report, временно откатывается на V1 с явной пометкой в коде комментарием `// TODO: migrate to V2 when stable`, и продолжает v0.1 на V1. **Это не блокер**, миграция между V1/V2 при наших 5 инструментах — день работы.

Маркеры "V2 нестабильна":
- `@modelcontextprotocol/server` помечен как `next` или `beta` на npm registry, не `latest`
- TypeScript ошибки сборки внутри node_modules самого SDK
- Runtime ошибки при подключении к MCP Inspector до начала вызова tools

**E. Appendix A обновляется** (см. ниже).

### 2026-05-16 — SDK V1 stable lock-in (override предыдущего V2 amendment'а)

**Motivation.** Предыдущий amendment этой же даты ("SDK V2: lock-in") основывался на ожидании, что V2 будет стабилен к моменту начала работ. Фактическая проверка на 2026-05-16:

- `modelcontextprotocol/typescript-sdk` ветка `main` (V2) помечена в README как "currently in development, pre-alpha"
- `@modelcontextprotocol/server` на npm не имеет stable `latest` тега, указывающего на 2.x
- Latest stable релиз семейства — `@modelcontextprotocol/sdk@1.29.0` (2026-03-30)
- Maintainers явно рекомендуют v1.x для production

Срабатывает fallback из раздела D предыдущего amendment'а ("V2 нестабильна"). Вместо runtime-проверки в момент билда v0.1 — фиксируем V1 детерминистически.

**Изменения:**

**A. Target lock-in.** V0.1 строится на V1 SDK без runtime verification. Conditional decision tree из раздела D предыдущего amendment'а отменяется для v0.1.

**B. Пакеты:**
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.0",
    "simple-git": "^3.0.0"
  }
}
```

**C. Imports:**
```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
```

**D. Конструктор:**
```ts
const server = new Server(
  { name: "mcp-winfs", version: "0.1.0" },
  { capabilities: { tools: {} } }
);
```

**E. `structuredContent` convention остаётся в силе.** V1 SDK поддерживает поле `structuredContent` в tool response (доступно начиная с поздних v1.x минор-релизов; v1.29.0 гарантированно). Convention из cc-prompt не пересматривается.

**F. Migration trigger.** При появлении на npm `@modelcontextprotocol/server` со стабильным `latest` тегом на 2.x.x — отдельный migration sprint (отслеживается в `MIGRATION.md` репо). Не блокирует v0.1.

**G. Appendix A статус.** Описывает целевой V2 API. Используется как reference для будущей миграции, не как ground truth для v0.1. Quick reference для v0.1 — секция C выше этого amendment'а.

### 2026-05-16 — v0.2 open-question decisions (mutations + batch read)

**Motivation.** §4.2 (move/copy/mkdir), §4.3 (read_multiple_files) и §4.9 (list_allowed_directories) оставляют четыре поведенческих развилки, которые имплементация v0.2 должна решить детерминистически. Фиксируем без переписывания первоначальных §§ — все четыре правила добавляются как уточнения.

**A. Cross-volume move — fail-fast EXDEV (v0.2).**

`move` использует только `fs.rename`. На NTFS rename atomарен **внутри одного тома**; cross-volume вызов вернёт `EXDEV` (Node-level errno). v0.2 пробрасывает это как структурированную ошибку:

```ts
buildError("EIO", "cross-volume move is not supported in v0.2", {
  hint: "Source and destination must be on the same drive. v0.3 will add an opt-in copy+delete fallback.",
  details: { src, dst, errno: "EXDEV" }
})
```

Не реализуем silent copy+delete fallback в v0.2 — он скрывает non-atomicity и ломает contract "move = атомарный". В v0.3 добавим явный flag `allow_cross_volume: boolean`.

**B. Copy + dangling/escape symlinks — skip + counter.**

В рамках recursive copy:
- Каждый entry внутри source tree проходит через `fs.realpath`. Если realpath возвращает path **вне** allowedRoots, entry **скипается**.
- Dangling symlink (realpath → ENOENT) тоже скипается.
- Результат включает `files_skipped: number` и (опционально, до 10) `skipped_paths: string[]` для трассируемости.

Это безопасное поведение по умолчанию. Альтернативу "follow symlinks even outside allowedRoots" не реализуем — она ломает spec §2.2. Альтернативу "fail на первом skip" — не реализуем, потому что recursive copy на большой директории не должен валиться из-за одного линка.

**C. `read_multiple_files` — Promise.all с per-file timeout.**

- `paths` обрабатываются параллельно через `Promise.all`.
- Каждый file inherits `config.defaultTimeoutMs` (clamped by `config.maxTimeoutMs`) индивидуально через тот же `withTimeout` wrapper, который используют одноэлементные tools.
- Per-file ошибка → `{path, error: {code, message}}`, успех → `{path, content, lines_returned, bytes_returned, truncated}`.
- Top-level вызов **никогда** не isError — даже если все файлы упали, response shape единообразен.

Sequential альтернатива отвергнута: при 10 файлах × 10 с timeout мы получим худший случай 100 с, что превышает спецификационные default timeouts.

**D. `list_allowed_directories` — минимальная surface.**

Output: ровно `{allowed_roots: string[], allowed_url_hosts: string[]}`. **Не** возвращаем:
- `auditLogPath` — leaks внутреннее устройство.
- `blocklist`, `denied_url_patterns` — даёт атакующему карту того, что фильтруется.
- `timeouts`, `max_bytes` — нерелевантно для self-orientation.

Если будущему tool понадобится экспонировать конфиг шире (например, для `health` или `selftest`), создаём отдельный tool с явной целью, чтобы surface был осознанным.

**E. Existing-target idempotence для mkdir.**

`mkdir(path, {recursive: true})` на существующей директории возвращает `{created: false, path}` без ошибки. Это согласуется с POSIX-семантикой `mkdir -p`. Только `recursive: false` + path существует → `EEXIST`.

### 2026-05-16 — v0.3 envelopes + move cross-volume opt-in + copy audit telemetry

**Motivation.** §4.3 и §4.8 определяют outputs нескольких search/system tools как `Array<...>`. MCP V1 SDK требует, чтобы `outputSchema` был объектом (JSON Schema `type: "object"`), поэтому фактический wire-shape для array-результатов — envelope. Зафиксируем шаблон явно, формализуем v0.3 move/copy расширения и закроем три open question из v0.2 acceptance report.

**F. Envelope для tools с array-выходом.**

Для tools, у которых §4 определяет `Output: Array<T>`, реальный schema — `{<plural>: T[], total: number, ...flags}`. Это применяется единообразно:

| Tool | §4 nominal | Wire shape (envelope) |
|---|---|---|
| `read_multiple_files` | `Array<{path, content?, error?}>` | `{files, total, ok_count, error_count}` |
| `glob` | `Array<string>` | `{matches: string[], total, truncated}` |
| `grep` | `Array<{file, line, ...}>` | `{matches, total, truncated, reason?}` |
| `audit_tail` | `Array<{ts, tool, ...}>` | `{entries, total}` |

Правила envelope:
- Плюральное имя массива (`files`/`matches`/`entries`) — first, потому что это смысловой payload.
- `total: number` — всегда `array.length`. Удобно для UI без `.length` дереференса.
- Flags: `truncated`, `ok_count`, `error_count`, `reason` — только если они *часть контракта* tool, а не cosmetic. Не добавлять `success: true` или `tool: "..."` (envelope антипаттерн из v0.1.1 backlog #1).
- `additionalProperties: false` (через `z.object(...).strict()`) — для предотвращения envelope-расползания.

Если будущему tool из §4 нужно вернуть массив без полезных flags, envelope сводится к `{<plural>, total}`.

**G. `move` cross-volume opt-in fallback.**

Дополняет амендмент A (v0.2): `move` теперь принимает `allow_cross_volume: boolean` (default `false`).

- `false` (default) + EXDEV → `EIO` с `errno: "EXDEV"` в details, как в v0.2. Поведение неизменно для существующих callers.
- `true` + EXDEV → `copyImpl(src, dst, {recursive:true})` затем `fs.rm(src, {recursive:true})`. Операция **не атомарна** — возможна race-окно после успешного copy, до завершения delete, где src и dst оба существуют.

Response envelope расширен полем `atomic: boolean`:
- `atomic: true` — успешный `fs.rename` (single-volume).
- `atomic: false` — fallback copy+delete сработал, источник удалён.

Если copy в fallback падает, ошибка возвращается as-is (с code из copy). Если copy успешен, но delete src падает (rare: permission, lock) → `EIO` с `phase: "delete"` в details; destination содержит данные, source остался — caller должен решить дальнейшую судьбу.

**H. `copy` symlink-skip telemetry в audit.**

Response для `copy` уже cap'ает `skipped_paths` до 10 entries (per амендмент B), но `files_skipped` всегда отражает full count. v0.3 добавляет в audit log дополнительный full-count бит: `args_summary.files_skipped_total` записывается даже если response capped. Реализация через `auditExtras` hook в `tool_wrapper.ts`, который merge'ит metadata из impl в audit-only слой без exposure в user-visible payload. Чисто observability-fix; user-facing response unchanged.

### 2026-05-16 — v0.4 Editor + Slicing surface (§I–§L)

**Motivation.** §4.4 `edit_file` и §4.5 `read_section` / `read_since` / `diff_files` определяют tool surface на высоком уровне, оставляя поведенческие развилки (что считать "уникальным", как считать строки, что делать при rotation log файла, как обрабатывать inline-input для diff). v0.4 фиксирует эти решения детерминистически — четыре амендмента ниже.

**Pivot для `read_section`.** §4.5 описывает marker-based slicing (md-headings или regex anchors). v0.4 реализация **отходит от этой схемы** в пользу range-based (line_range / byte_range) по следующим причинам:

- Marker-based blurs into `grep` territory — поиск по контенту это уже отдельный tool.
- Range-based композируется с `read_multiple_files` semantics (`range: [start, end]`), сохраняя единый ментальный шаблон.
- Marker positioning внутри документа нестабилен между правками (Claude отредактировал заголовок → следующий `read_section` промазал), что делает marker-output непригодным для round-trip workflow.
- Marker-based может вернуться как отдельный tool `read_marked_section` в v0.5+, если real use surfaces need.

**I. `edit_file` semantics.**

- **Uniqueness invariant.** Каждый `old_str` в `edits[]` ДОЛЖЕН встречаться ровно 1 раз в текущем буфере. 0 occurrences → `EUNIQUE` с `details: {edit_index, occurrences: 0}`. 2+ → `EUNIQUE` с `details: {edit_index, occurrences: <count>}`. Не используем `ENOMATCH` — кодов слишком много, `EUNIQUE` покрывает оба случая через `occurrences` поле.
- **Sequential application.** Edits применяются по порядку к in-memory буферу. Edit N проверяется против буфера ПОСЛЕ edits 0..N-1. Это корректное поведение, не баг: если `edit[0]` убирает строку, на которую таргетится `edit[1]`, второй edit получает `EUNIQUE` (occurrences=0).
- **`dry_run: true` не трогает диск.** Никакого temp файла, никакого `fsync`. Implementation forks до atomic-write этапа.
- **`diff` field в response всегда populated.** Both `dry_run` и real edits — unified diff (3 lines context) pre/post буфера. Caller всегда имеет visibility в "что было бы записано".
- **`atomic: true` всегда.** Same atomic-write path как `write` (temp + fsync + rename). Mirror'им `move` v0.2.x решение exposed-explicitly-even-when-tautological — future failure mode может перевернуть это значение.
- **Audit redaction.** `args_summary` записывает `{path, edits_count, dry_run, bytes_before, bytes_after}` — никаких `old_str`/`new_str` content (continuation of `content`-field redaction principle).
- **Refused edge cases.** Empty `old_str` → `EINVAL` (защита от accidental whole-file overwrite). Binary file → `EENCODING`. `edit_file` не создаёт файл — `ENOENT` если path отсутствует (use `write` instead).

**J. `read_section` slice semantics.**

- **Mutually exclusive selectors.** Exactly one of `line_range: [start, end]` / `byte_range: [start, end]` required. Both или neither → `EINVAL`.
- **Line counting.** Split on `\n` без normalization. `\r` остаётся прикреплённым к строке. `"a\nb\n"` = 2 строки, `"a\nb"` = 2 строки, `"a\nb\nc"` = 3 строки.
- **UTF-8 boundary trim.** При `byte_range` + `encoding: "utf8"`, если границы slice падают в середину multi-byte sequence, slice сжимается с обеих сторон до largest valid UTF-8 substring; response получает `adjusted: true`.
- **Interior decode failure ≠ boundary trim.** Если slice содержит invalid UTF-8 в *interior* (не на границах) → `EENCODING`. Boundary trimming — это `adjusted: true`, не error.
- **Output envelope.** `{ content, range: {kind: "line"|"byte", start, end}, total_lines?, total_bytes, adjusted?, encoding }`. `total_lines` присутствует только для `line_range` (требует full scan). `total_bytes` всегда — cheap via `fstat`.
- **Errors.** `EPERM_ROOT`, `ENOENT`, `EISDIR`, `EINVAL` (mutual exclusion / range bounds), `ETOOLARGE` (slice > `config.readMaxBytes`), `EENCODING` (interior corruption), `ETIMEDOUT`.

**K. `read_since` rotation semantics.**

- **Steady-state.** `since_offset === total_bytes` → empty `content`, `new_offset === since_offset`, `truncated: false`, `file_rotated: false`. Poll-loop friendly.
- **Append.** `total_bytes > since_offset` → reads delta, returns up to `max_bytes` (default 64 KB, hard cap 1 MB). `truncated: true` if delta exceeded cap.
- **Rotation detection.** `total_bytes < since_offset` → `file_rotated: true`, response содержит **whole file** content, `new_offset === total_bytes`. Caller acknowledges by passing new offset on next call.
- **UTF-8 boundary advance.** Если `since_offset` падает mid-multibyte, чтение продвигается вперёд до next valid UTF-8 boundary (max 4 байта). Skipped bytes silent. Если skip > 4 → real corruption signal → `EENCODING` с `details: {skipped_bytes}`.
- **Output envelope.** `{ content, new_offset, total_bytes, mtime, truncated, file_rotated }`.
- **Errors.** `EPERM_ROOT`, `ENOENT`, `EISDIR`, `EINVAL` (negative/non-integer offset), `EENCODING`, `ETIMEDOUT`.

**L. `diff_files` text-only с inline support.**

- **Inline-or-path per side.** Exactly one of `a` / `a_inline` required; same для `b`. Both или neither (per side) → `EINVAL`.
- **BOM stripping.** UTF-8 BOM на любой стороне strip'ается до diff — никогда не leak'ает в output.
- **Binary input → `EENCODING`.** `diff_files` text-only (UTF-16 BOM, NUL byte → reject).
- **`format` options.** `"unified"` (default, full unified diff с `context_lines` default 3, max 10) и `"minimal"` (changed-line counts + first 20 changed lines). `"minimal"` для fast same/different checks без полной diff передачи.
- **`identical: true`** iff `diff === ""` and `lines_added === 0` and `lines_removed === 0`.
- **`a_label` / `b_label`.** Basename для file inputs, `"<inline>"` для inline. Surfaced в response для audit-trail.
- **Output envelope.** `{ diff, identical, lines_added, lines_removed, format, a_label, b_label, truncated }`. `truncated: true` если diff превысил `config.maxDiffBytes` (новый knob, default 256 KB).
- **Errors.** `EPERM_ROOT` (any side), `ENOENT`, `EISDIR` per side, `EINVAL` (mutex), `EENCODING` (binary), `ETOOLARGE` (input > `readMaxBytes`).

### 2026-05-17 — v0.5 carryover: §M `audit_tail.entries_seen_total` diagnostic field

**Motivation.** v0.3.x audit_tail responses surface `total === entries.length` (envelope §F). Kimi + Gemini P3 reviews suggested renaming `total` to `entries_returned` to clarify the post-filter shrinkage when scan-time self-dedup drops `audit_tail` records. The rename was rejected per §F (renaming `total` would break the envelope contract for every plural-tool response). Instead, v0.5 adds a supplementary diagnostic that answers the same question without contract churn.

**M. `audit_tail.entries_seen_total`.**

New field in the `audit_tail` output envelope, alongside `entries` and `total`:

```ts
{
  entries: AuditEntry[],          // up to n records, oldest-first
  total: number,                  // === entries.length (envelope §F invariant)
  entries_seen_total: number      // §M: scanned during the backward walk
}
```

Semantics:

- **What counts.** Every structurally-valid `AuditEntry` line observed during the backward scan, including records dropped by scan-time self-dedup (`tool === "audit_tail"`) and records skipped after the n-cap was hit mid-chunk. Malformed lines (JSON parse failure, missing required field) do **not** count.
- **What does NOT count.** Records past the read ceiling (`MAX_TOTAL_READ_BYTES = 64 MB`) or before the start of the file. The field is *scan-bounded*, not *file-bounded* — it reflects what this call walked, not what the file contains.
- **Diagnostic only.** When `entries_seen_total > total`, the gap is filtered `audit_tail` records or post-cap overflow. The caller can use it to detect "the log has more activity than what I got" without having to call with progressively higher `n`.
- **`{kind: "missing"}` path.** Returns `entries_seen_total: 0` (file does not exist; nothing was walked).
- **`n: 0` path.** Returns `entries_seen_total: 0` (early-out before any read).

Implementation: `tailLinesFromHandle` now returns `{entries, scanned}` instead of just `entries`; `auditTailImpl` plumbs `scanned` into the output envelope. The path-based `tailLines` wrapper preserves its previous `Promise<AuditEntry[]>` signature for test back-compat.

### 2026-05-18 — v0.6 §U–§W: configurable scope, write_chunk, edit_file.expected_count

**Motivation.** v0.6 ships three orthogonal additions on top of the v0.5 29-tool surface: (a) opt-in "unrestricted" mode that bypasses `allowedRoots` for agent-sandbox / dev-VM deployments, (b) a byte-offset surgical write tool for huge files, and (c) an occurrence-count assertion extension to `edit_file`. Net +1 tool (30 total) + 1 schema extension. The three sit under §U / §V / §W in chronological-amendment order.

**Cross-cutting BREAKING CHANGES from v0.5.** v0.6 includes two wire-format changes relative to v0.5. Both are flagged in the [0.6.0] CHANGELOG as well:

- **`edit_file` EUNIQUE details field renamed.** v0.5 returned `details: {edit_index, occurrences, path}`. v0.6 returns `details: {edit_index, occurrences_found, expected_count, path}`. Old `occurrences` field removed; no back-compat shim. Justification: occurrence-count assertion semantics (§W) require an `expected_count` field; renaming `occurrences` → `occurrences_found` keeps the new pair symmetric ("how many we found" / "how many you expected") and avoids verbal collision.
- **`edit_file.replacements_made` semantics changed.** v0.5 returned `args.edits.length` (a value the caller already knew). v0.6 returns the actual sum of replacements performed across all edits. Justification: returning input back to the caller was zero-information; new semantics make the field useful for verifying mixed-mode batches.

**§U. Configurable filesystem scope (`unrestrictedFilesystem` + magic confirm).**

Config additions (`config.ts` Zod schema):

- `unrestrictedFilesystem: boolean` (default `false`).
- `unrestrictedFilesystemConfirm: string` (optional). Required when `unrestrictedFilesystem === true`, must equal exactly `"I-UNDERSTAND-THE-RISK"`.

Post-parse validator (invariant #28): if `unrestrictedFilesystem === true` and `unrestrictedFilesystemConfirm !== "I-UNDERSTAND-THE-RISK"` → `loadConfig` throws at startup. Accidental enable structurally impossible.

`ResolvedConfig` gains a derived field `serverMode: "strict" | "unrestricted"`, set from `raw.unrestrictedFilesystem` after validation. All call sites that need to distinguish the two modes read `config.serverMode`, not the raw boolean.

**`checkAllowed` short-circuit.** When `config.serverMode === "unrestricted"`, the allowedRoots prefix check is SKIPPED. The path is still canonicalised via `fs.realpath` (handles symlinks, relative→absolute, `..` resolution), and `allowMissing` semantics + `ENOENT` rejection on missing files are preserved. No `EPERM_ROOT` is ever returned in unrestricted mode.

All other security defenses stay in force regardless of mode: exec blocklist (#7), `check_env` safe-prefix (#8), `fetch_url` SSRF defense (#10), audit redaction (#11), atomic writes, bounded timeouts.

**Startup banner (invariant #29).** When `serverMode === "unrestricted"`, `index.ts` prints a 3-line stderr banner BEFORE server connect:

```
⚠️ ⚠️ ⚠️  UNRESTRICTED FILESYSTEM MODE — all paths accessible
⚠️ ⚠️ ⚠️  Confirm: "I-UNDERSTAND-THE-RISK"
⚠️ ⚠️ ⚠️  See docs/design/mcp-winfs-spec.md §U
```

The ready line printed after `server.connect` always includes `mode=strict|unrestricted` so the mode is visible in any stderr-tailing dashboard.

**Audit `_server_start` sentinel record (invariant #29).** After `server.connect`, `index.ts` calls `appendServerStartAudit(config)`, writing one record with `tool: "_server_start"`, `args_summary: {server_mode, version, pid}`, `result_status: "ok"`, `duration_ms: 0`, `mode: <serverMode>`.

The `_` prefix on `tool` marks this as a system event (not a registered tool). **Convention:** tool names beginning with `_` are RESERVED for audit-subsystem events. Real tools never use this prefix. `audit_tail` surfaces these alongside regular tool entries; consumers filtering by tool name should treat the `_` prefix as the discriminator.

**Audit `mode` field on mutation tools (invariant #30).** `AuditRecord` gains an optional top-level `mode?: "strict" | "unrestricted"` field. The wrapper (`tool_wrapper.ts`) sets it for every tool in `MUTATION_TOOLS = {"write", "append", "mkdir", "move", "copy", "edit_file", "write_chunk", "execute_command", "run_python", "run_pytest"}`. Read-only tools (`read`, `list`, `stat`, `grep`, `glob`, `git_*`, `read_*`, etc.) omit the `mode` field for log brevity. Post-hoc forensic queries can filter on `mode === "unrestricted"` to extract every mutation that ran outside allowedRoots.

**Security note.** Unrestricted mode is for development sandboxes, automated agent VMs, and environments where filesystem-wide access is the explicit goal. **NEVER** use in production on a multi-tenant host. **NEVER** use when the server is exposed to untrusted callers. The magic-confirm mechanism prevents accidental enable; it does NOT make the mode safe for adversarial environments.

**§V. `write_chunk` tool contract.**

New tool under `src/tools/file/write_chunk.ts`. Companion to v0.1 `read` (which supports `range`). Designed for surgical edits on large files without loading them whole. **Explicitly non-atomic** — see invariant #31.

**Input schema:**

- `path: string` (absolute, inside allowedRoots in strict mode / anywhere in unrestricted).
- `offset: number` (≥ 0, byte offset).
- `content: string` (payload, decoded per `encoding`).
- `encoding?: "utf8" | "base64"` (default `"utf8"`).
- `validate_byte_range?: boolean` (default `true`, UTF-8 boundary check; ignored when `encoding === "base64"`).

**Output schema:**

- `path: string` (resolved real path).
- `offset: number` (echo of input).
- `bytes_written: number` (per `fileHandle.write` return).
- `total_bytes_after: number` (post-write `fs.stat.size`).
- `atomic: false` (literal — pinned by invariant #31).

**Behavior.** `fs.stat(path)` → check `offset <= file_size_before` (else `EOFFSET`) → if `encoding=utf8` + `validate_byte_range`: probe byte at `offset` and byte at `offset + content_length` in the existing file, reject if either is a UTF-8 continuation byte (`(byte & 0xC0) === 0x80`) → `fs.open(path, "r+")` → `fileHandle.write(buf, 0, len, offset)` → `fileHandle.close()` → re-stat for `total_bytes_after`.

The write may naturally extend the file when `offset + content_length > file_size_before`. Sparse-file creation is forbidden by invariant #32 — the offset must always be `<= file_size_before`.

**Errors.**

- `EPERM_ROOT` — strict mode + path outside allowedRoots.
- `ENOENT` — file does not exist. `write_chunk` does **not** create files. Use `write` for new files.
- `EISDIR` — path is a directory.
- `EOFFSET` — `offset > file_size_before` (invariant #32). New error code in v0.6 catalog.
- `EENCODING` — content is not valid UTF-8 (utf8 mode + content round-trip fails), OR boundary at `offset` / `offset + content_length` lands mid-multibyte (invariant #33). Hint suggests `validate_byte_range: false` to bypass the boundary check when binary-into-utf8 splice is intentional.
- `ETOOLARGE` — `max(file_size_before, offset + content_length) > readMaxBytes`.
- `ETIMEDOUT` — wrapper deadline.

**Invariant #31 — non-atomicity is explicit.** Response carries `atomic: false` as a literal (not a generic boolean). No temp file is created; no `fsync` is called; no atomic rename is performed. The mutation happens on the original inode directly. Pinned by `tests/invariants/write_chunk_nonatomic.test.ts`. Future refactoring cannot silently introduce atomic-write semantics without breaking the contract.

**Invariant #32 — offset bounded; no sparse-file creation.** `offset > file_size_before` → `EOFFSET` before any write attempt. `offset === file_size_before` is the append-at-EOF path and is allowed. `offset < file_size_before` overwrites bytes in place and may extend the file if `content_length` is large enough.

**Invariant #33 — UTF-8 boundary check.** When `encoding === "utf8"` (default) and `validate_byte_range === true` (default), both the boundary at `offset` and the boundary at `offset + content_length` in the EXISTING file must NOT be UTF-8 continuation bytes (`0x80..0xBF`). Mid-multibyte boundaries → `EENCODING` with the offending byte in `details`. Prevents producing a file that is valid UTF-8 before and after the chunk but corrupted at the seam. Skipped when `validate_byte_range === false` or `encoding === "base64"`.

**Audit redaction.** The `content` field is redacted in `args_summary` per the v0.4 sensitive-args sanitizer (`<redacted: N bytes>`). The `auditExtras` callback adds: `offset` (full), `content_sha256`, `content_bytes`, `mode` (per invariant #30). Content is stored as a SHA-256 digest + byte length, NEVER a prefix (GPT-review #3 / invariant #46 — a prefix can leak a secret on line 1). The written byte count is also in the response as `bytes_written`. `config.auditVerbose=true` additionally records a 256-char `content_prefix` for debugging.

**§W. `edit_file.edits[].expected_count` extension.**

New optional field on each edit:

- `expected_count?: number` (non-negative integer, default `1`).

**Three modes** (invariant #34 — count match is exact, not minimum):

- `expected_count: 1` (default). Preserves the v0.5 contract: `old_str` must appear EXACTLY once; replace the single occurrence. 0 occurrences or 2+ → `EUNIQUE`.
- `expected_count: 0`. ASSERTION-ONLY mode. Verify `old_str` is ABSENT from the buffer (count must equal 0); no replacement is performed. Any occurrence → `EUNIQUE`. Useful for "ensure this code is removed" assertions in mixed-mode batches.
- `expected_count: N` (N ≥ 2). Multi-occurrence replace. `old_str` must appear EXACTLY N times; all occurrences replaced atomically within the edit (impl: `buffer.split(old).join(new)`). Mismatch → `EUNIQUE`.

**Sequential application unchanged.** Edits apply in array order; edit K is checked against the buffer AFTER edits 0..K-1. A multi-replace edit (N ≥ 2) performs all its replacements before the next edit is checked.

**`EUNIQUE` error details shape (BREAKING from v0.5).**

```ts
details: {
  edit_index: <0-based index into edits[]>,
  occurrences_found: <actual count in buffer>,
  expected_count: <what was requested, default 1>,
  path: <resolved>,
}
```

v0.5 field `occurrences` removed; no back-compat shim. Callers parsing the old field name must migrate.

**`replacements_made` semantics (BREAKING from v0.5).**

- v0.5: `replacements_made === args.edits.length` (a value the caller already knew).
- v0.6: `replacements_made === sum of actual replacements performed across all edits`. Per-edit contribution: `expected_count: 0` → 0; `expected_count: 1` → 1; `expected_count: N` (N ≥ 2) → N.

Example: a 3-edit batch with `expected_count` of `[2, 1, 5]` reports `replacements_made: 8`, not `3`.

`dry_run: true` still reports `replacements_made` matching what would have been written. The diff is computed against the post-replacement buffer regardless of `dry_run`.

### 2026-05-19 — v0.7 wave 1: §X ssh_exec + list_path_dirs + write_json

**Motivation.** Three additions surfaced by the 2026-05-18 ecom-session consumer-agent report (archived verbatim in the appendix of `prompts/cc-prompt-v0.7-wave1-ssh-listpath-writejson.md`). Each one is independent of the main v0.7 DC-parity wave (features A–D in the roadmap) and ships ahead of it. Net surface delta: 30 (v0.6) → 33 (v0.7 wave 1). New error codes: `ESSHNOTFOUND`, `EHOST_UNKNOWN`, `EEXT_NOT_JSON` (catalog §5 entries appended below). Three new MUTATION_TOOLS members: `ssh_exec`, `write_json` (mutation), plus `list_path_dirs` (read-only).

**§X.1. `ssh_exec` tool contract.**

New tool under `src/tools/system/ssh_exec.ts`. First-class SSH remote execution via direct `child_process.spawn` on the OpenSSH binary. Designed to sidestep three stacked failures that make `execute_command` unreliable for ssh on Windows hosts: (a) the sanitized PATH excludes `C:\Windows\System32\OpenSSH`; (b) PowerShell's pipeline parser rejects `ssh.exe` with `Cannot run a document in the middle of a pipeline`; (c) v0.5.x known bug #2 (empty stdout + exit 0 on direct `& 'ssh.exe' -V` through execute_command).

**Input schema:**

- `host: string` (1..256 chars). When `config.allowedSshHosts` is set, MUST be an exact member (the enforced allowlist). Always validated for resolvability via `ssh -G <host>` against `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`) — resolvability is NOT membership (see invariant #35). Strings containing `@` are rejected up-front as raw `user@host` form.
- `command: string` (1..8 KB). Verbatim remote command; passed as a single argv element to ssh.
- `timeout_seconds?: number` (1..300, default 30). Effective max is also clamped by `config.maxTimeoutMs` via the standard `runTool` wrapper; raise the config knob if longer ssh sessions are required.

**Output schema:**

- `host: string` (echo of input).
- `stdout: string` (decoded UTF-8, capped at 4 KB).
- `stderr: string` (decoded UTF-8, capped at 4 KB).
- `exit_code: number | null` (null on spawn failure / pre-exit kill).
- `timed_out: boolean` (always present; `true` only on the no-error path).
- `truncated_stdout?: boolean` (present only when set).
- `truncated_stderr?: boolean` (present only when set).
- `duration_ms: number`.

**Behavior.** `fs.stat(sshExePath)` → fail-fast `ESSHNOTFOUND` if absent → host validation via `spawnSubprocess(sshExePath, ["-G", host], { deadlineMs: 5000, maxOutputBytes: 64 KB })` → require `exitCode === 0` AND stdout contains a non-empty `hostname <value>` line → cache `host` in a module-level `Map` for the server lifetime → spawn `sshExePath` with `[host, command]` as argv, `maxOutputBytes: 4096` per stream, `deadlineMs: timeout_seconds * 1000`. No shell, no PowerShell wrapper. Standard `spawnSubprocess` semantics for SIGTERM → SIGKILL escalation, process-tree kill on Windows via `taskkill /F /T /PID`.

**Errors.**

- `ESSHNOTFOUND` — `sshExePath` does not exist on disk (new error code; spec §5 catalog entry below).
- `EHOST_UNKNOWN` — host rejected: not in `config.allowedSshHosts` (when set), raw `user@host` form, `ssh -G` non-zero exit, validation timeout, or missing `hostname` line in `ssh -G` stdout. Details carry the exact reason (new error code).
- `ETIMEDOUT` — child exceeded `timeout_seconds`. Details include `partial_stdout` / `partial_stderr` (each capped at 1 KB) for diagnostic value.
- `EIO` — child failed to start asynchronously (`spawn` succeeded synchronously but the OS rejected the process). Mirror of the v0.6 §U `exec_safety` fix — `spawnFailed: true` flag in details, plus the OS error code in `errno`.

**Mode behavior.** Allowed in both `strict` and `unrestricted` server modes. ssh_exec is deliberate network egress, independent of `allowedRoots`; gate it with `config.allowedSshHosts` (the enforced host allowlist — invariant #35) rather than relying on `~/.ssh/config` resolvability alone. The mutation-tool audit-record carries `mode` per invariant #30.

**Audit redaction.** `command` is in `SENSITIVE_ARG_KEYS` — sanitizer replaces it with `<redacted: N bytes>`. `auditExtras` adds: `host` (full), `command_sha256`, `command_bytes`, plus on success `exit_code`, `timed_out`, `duration_ms`. The command is stored as a SHA-256 digest + byte length, NEVER a prefix (GPT-review #3 / invariant #46). `config.auditVerbose=true` additionally records a 256-char `command_prefix`.

**Documented prerequisite (not enforced).** Working ssh-agent or passphrase-less key. Non-interactive subprocesses on Windows don't inherit Pageant / agent state from interactive sessions; if your key has a passphrase, ssh_exec will hang waiting for stdin (which is `ignore`d) until the deadline.

**Configuration.** `sshExePath?: string` (optional; since v0.10.1 auto-detected when unset — Git-bundled ssh preferred over System32, then PATH). `allowedSshHosts?: string[]` (optional; when set, the enforced host allowlist — invariant #35; an empty array blocks every host). No magic-confirm gate.

**Invariant #35 — ssh_exec host validation is two-layer; `ssh -G` is NOT a whitelist.** (1) When `config.allowedSshHosts` is set, `host` MUST be an exact member — the enforced, operator-controlled allowlist, checked BEFORE any ssh.exe spawn; a non-member returns `EHOST_UNKNOWN`, and an empty array blocks every host. (2) `ssh -G <host>` resolvability validation always runs (`exitCode === 0` AND a non-empty `hostname` line). This proves the alias is syntactically resolvable, NOT that it is defined in `~/.ssh/config` — ssh echoes `hostname <literal>` even for an unknown alias — so on its own it is resolvability validation, NOT a security boundary. No regex bypass, no `user@host` raw-string acceptance. Validated hosts are cached for the server lifetime (process-local, cleared on restart). *(Corrected at v0.10.3: the original wording called the `ssh -G` check a "whitelist", which it never was; `allowedSshHosts` is the real allowlist added in the same patch.)*

**§X.2. `list_path_dirs` tool contract.**

New tool under `src/tools/system/list_path_dirs.ts`. Read-only introspection of the sanitized PATH that subprocesses inherit (`execute_command`, `find_command`, `run_python`, `run_pytest`, and now `ssh_exec` host validation). Lets agents debug "why is binary X invisible" without trial-and-error.

**Input schema:** none (empty object, strict).

**Output schema:** `{ path_dirs: string[], total: number }`. Envelope conforms to §F (`total === path_dirs.length`).

**Implementation.** Returns `sanitizedPathDirs(config)` — the single-source-of-truth helper extracted from `src/core/exec_safety.ts`. `sanitizedPath(config)` (used by `buildExecEnv`) now joins this array with `;`. Order: System32, PowerShell 5.1, Windows, PowerShell 7, Git CLI, Git bin, Node, and (when configured) `pythonHome`.

**Errors.** No tool-specific codes. `ETIMEDOUT` from the wrapper is theoretically reachable but effectively unreachable for an in-memory constant-time operation.

**Mode behavior.** Read-only — audit entry omits `mode` per invariant #30.

**§X.3. `write_json` tool contract.**

New tool under `src/tools/file/write_json.ts`. Atomic JSON write, symmetric to v0.3 `read_json`. Closes the read-mutate-write round-trip workflow.

**Input schema:**

- `path: string` (absolute, inside allowedRoots in strict mode / anywhere in unrestricted). MUST end in `.json` (case-insensitive) on both the caller-supplied path AND the realpath-resolved path.
- `value: unknown` (any JSON-serialisable value).
- `indent?: number` (0..10, default 2). `0` produces compact output (no whitespace).
- `overwrite?: boolean` (default `false`). Safer default than v0.1 `write` (which defaults to `true`) — JSON files are more often configuration than scratch data.
- `mkdirParents?: boolean` (default `false`).

**Output schema:** identical to v0.1 `write`: `{ bytes_written, lines_written, created }`.

**Behavior.** Extension check on the caller-supplied path → `checkAllowed` with `allowMissing: true` → extension re-check on `realPath` (defense-in-depth against a `.json`-named symlink/junction pointing at a non-.json target) → parent existence check (+ optional `mkdir -p`) → existing-file check vs `overwrite` → `JSON.stringify(value, null, indent === 0 ? undefined : indent)` → append trailing newline → `atomicWriteFile` (the same temp + fsync + rename primitive as `write` and `edit_file`, via `src/core/atomic_write.ts`).

**Errors.**

- `EEXT_NOT_JSON` — caller-supplied path or resolved real path does not end in `.json` (new error code; spec §5 catalog entry below). Caught before any disk I/O.
- `EPERM_ROOT` — strict mode + path outside allowedRoots.
- `EEXIST` — file exists and `overwrite: false`.
- `ENOENT` — parent directory missing and `mkdirParents: false`.
- `EINVAL` — value is not JSON-serialisable (BigInt, cycle, function), OR `JSON.stringify` returned `undefined` (top-level function/symbol/undefined).
- `EIO` — atomic write failed (most often a Windows file lock).
- `ETIMEDOUT` — wrapper deadline.

**Mode behavior.** Mutation; audit record carries `mode` per invariant #30. `value` is in `SENSITIVE_ARG_KEYS` — `sanitizeArgs` redacts it (string → byte count, array → item count, object → key count, primitives passed through).

**Sanitizer object-key extension.** `sanitizeArgs` is extended to redact `object`-typed values at sensitive keys as `<redacted: N keys>`, symmetric with the existing `array → <redacted: N items>` rule. This extension is safe for existing tools because none of them passed an object at a sensitive key (all existing sensitive keys held strings or arrays). The change supports `write_json.value` carrying free-form JSON.

**§X.4. Error code catalog additions.**

| Code | Tool | Meaning |
|---|---|---|
| `ESSHNOTFOUND` | `ssh_exec` | `config.sshExePath` does not exist on disk. Install OpenSSH client or set the config field. |
| `EHOST_UNKNOWN` | `ssh_exec` | `host` not in `config.allowedSshHosts` (when set), not resolvable via `ssh -G`, or raw `user@host` form rejected. Set an allowlist and/or add a `Host` entry in `~/.ssh/config`. |
| `EEXT_NOT_JSON` | `write_json` | Path does not end in `.json` (case-insensitive). Use `write` for non-JSON files. |

**§X.5. `MUTATION_TOOLS` extension.**

`MUTATION_TOOLS` (audit.ts) grows from 10 to 12 members: `+ write_json + ssh_exec`. `list_path_dirs` is read-only and is NOT added.

### 2026-05-19 — v0.7 wave 2a: §Y existing-tool improvements

**Motivation.** A compact follow-up to wave 1: four improvements to tools already in the surface, plus two documentation hangovers. No new tools. No version bump. Driven by the same ecom-session feedback report (the diff-self-verification entry) plus DC-parity polish items.

**§Y.1. `edit_file` diff opt-out + 16 KB body cap.**

Wave 2a adds an optional `with_diff: boolean` input field (default `true`) plus an optional `truncated_diff: boolean` output field. The `diff` field semantics (v0.4 §I "diff field always populated") are preserved by the default — explicit `with_diff: false` is the new opt-out path, yielding an empty `diff` string for response-size control on large multi-edit batches.

When the unified diff body exceeds 16 384 bytes (UTF-8), it is truncated with a trailing `... [N more bytes truncated]\n` marker and the response carries `truncated_diff: true`. The cap is hardcoded (not configurable) — it bounds the response payload regardless of caller intent. Audit log is unchanged: diff is never persisted.

**§Y.2. `grep` pagination.**

`grep` gains two input fields and three output fields. Inputs: `offset?: number` (default 0) and `limit?: number` (default `MAX_MATCHES_DEFAULT` = 50, hard cap `MAX_MATCHES_HARD_CAP` = 500). `max_matches` is retained as a v0.6 legacy alias — if both `limit` and `max_matches` are supplied, `limit` wins.

Outputs gain `total_matches: number` (count across the entire search, not just the page) and an optional `next_offset?: number` (present iff more results follow the current page). To bound the count work, `total_matches` is capped at a hard ceiling of 10 000; on overflow the response carries `total_matches_capped: true` and the count is a lower bound rather than an exact total. The walk now enumerates all matching files until the ceiling or the deadline is hit — but only the page slice `[offset, offset + limit)` is materialised in the response, so memory stays bounded even with high `total_matches`.

Existing behaviour at defaults is preserved: `offset=0, limit=MAX_MATCHES_DEFAULT` returns the same first-page envelope (plus the new `total_matches` field) as v0.6.

**§Y.3. `execute_command` hints registry.**

A new optional `hints: string[]` output field surfaces short diagnostic paragraphs when child stderr matches a known cryptic-failure pattern. First entry covers PowerShell's `Cannot run a document in the middle of a pipeline` error — agents trying to invoke `ssh.exe` (or other non-PE binaries) through `powershell.exe` get a one-paragraph hint explaining the likely cause (PATHEXT / file association) and a workaround (`cmd`, full path, or a passthrough tool).

Match is case-insensitive substring on the literal phrase. Registry lives in `src/core/exec_hints.ts` and is intentionally append-only: future hints add a new entry with one `marker` + one `hint` string. Raw stderr is NEVER mutated — the hint is purely additive. The `hints` field is OMITTED entirely when no marker matched (envelope cleanliness; not an empty array). The audit log is unchanged — hints are NOT persisted (`stderr_prefix` already captures the verbatim failure).

**§Y.4. ETIMEDOUT response shape examples.**

The timeout-capable tools — `execute_command`, `ssh_exec`, `run_python` — share a common ETIMEDOUT response envelope shape. For agent-side prediction, here is the exact shape each tool returns when the deadline fires.

`execute_command` (timeout surfaces as a flag, not an error — partial output is preserved):

```json
{
  "stdout": "first 1234 bytes of stdout...",
  "stderr": "first 567 bytes of stderr...",
  "exit_code": null,
  "duration_ms": 5002,
  "truncated_stdout": false,
  "truncated_stderr": false,
  "timed_out": true
}
```

`ssh_exec` (timeout IS an error code, with partial-output details for diagnostics):

```json
{
  "ok": false,
  "error": {
    "code": "ETIMEDOUT",
    "message": "ssh_exec exceeded timeout_seconds (30)",
    "details": {
      "timeout_seconds": 30,
      "duration_ms": 30005,
      "partial_stdout": "first 1024 bytes of partial stdout...",
      "partial_stderr": "first 1024 bytes of partial stderr..."
    }
  }
}
```

`run_python` (same envelope shape as `execute_command` — timeout surfaces as a flag plus `duration_ms` near the requested timeout):

```json
{
  "stdout": "",
  "stderr": "partial captured stderr...",
  "exit_code": null,
  "duration_ms": 5001,
  "timed_out": true
}
```

Agents predicting timeout shape should switch on tool: `execute_command` and `run_python` return `ok: true` with `timed_out: true`; `ssh_exec` returns `ok: false` with `error.code: "ETIMEDOUT"`. The split mirrors the underlying design intent — interactive shells need partial diagnostics; remote-exec calls fail fast and explicit.

**§Y.5. `sshExePath` override discoverability.**

Wave 1 wired `config.sshExePath` (default `C:\Windows\System32\OpenSSH\ssh.exe`) but did not surface a commented override example, since `configs/local.json` is gitignored. The README "Local working config" section now documents the override explicitly so operators on non-standard ssh installations (Git-bundled at `C:\Program Files\Git\usr\bin\ssh.exe`, MSYS2 at `C:\msys64\usr\bin\ssh.exe`, etc.) know where to put it. No code change — documentation polish only.

### 2026-05-19 — v0.7 wave 2b: §Z process control suite

**Motivation.** Largest single DC-parity addition. Filesystem and one-shot exec tools are stateless — the server held no long-lived state across calls. Wave 2b introduces the first long-lived shared mutable state via an in-memory `ProcessRegistry`, plus four tools that operate on it: `start_process`, `interact`, `list_process`, `kill_process`. Net surface delta: 33 (wave 2a) → 37. Three new error codes: `ENOSESSION`, `EPIPE_CLOSED`, plus reuse of the existing `EBUSY` for the concurrency cap.

**§Z.1. ProcessRegistry — the shared state.**

Module `src/core/process_registry.ts`. Two classes:

- `ProcessSession`: one long-running child. Owns its capped stdout/stderr buffers, the status state machine (`running → exited | killed | timed_out | spawn_failed`), the `child` reference, the waiter queue, and helpers `appendStdout` / `appendStderr` / `settle` / `snapshot` / `summary` / `waitForOutput` / `waitForSettle` / `writeStdin` / `closeStdin`.
- `ProcessRegistry`: the `Map<session_id, ProcessSession>`. Constructor takes a `ResolvedConfig` and starts a periodic GC sweep on the `processGcIntervalMs` cadence. Methods: `spawn(command, cwd, extraEnv, timeoutSeconds)`, `get(session_id)`, `list()`, `runningCount()`, `kill(session_id, force)`, `shutdown()`.

The registry is a singleton per-process — instantiated in `createServer` and shared across the four tool registrations. Tests inject a fresh `ProcessRegistry(config)` per `beforeEach` so cross-test leakage is impossible. `createServer` now returns `{ server, registry }` (was: `McpServer` only) so `src/index.ts` can wire the shutdown hook.

**§Z.2. Session lifecycle.**

```
created ──spawn()──▶ running ──┬── child close ──▶ exited (exit_code captured)
                               ├── deadline      ──▶ timed_out
                               ├── kill(force=*) ──▶ killed
                               └── spawn error   ──▶ spawn_failed
                                                       │
                                                       ▼
                                                  settled_at set
                                                       │
                                          (held for processSessionTtlMs)
                                                       │
                                                       ▼
                                                  GC removes
```

The deadline path uses a `deadlineFired` flag on the session. When the per-session timer fires we mark the flag and call `platformKill(child, force=true)` — the natural `close` event then settles the session as `timed_out` rather than `exited`. This avoids a race where the child terminates cleanly milliseconds after the deadline fires, leaving a "settled" session with a still-alive process attached (which on Windows blocks tempdir cleanup in tests).

**§Z.3. Concurrency, buffer caps, GC, shutdown.**

Bounded by four config fields, all added to `CONFIG_SCHEMA`:

- `processMaxConcurrent` (default 16): `start_process` returns `EBUSY` when `runningCount() >= max`.
- `processBufferCap` (default 1 048 576): per-stream output cap. Overflow drops bytes and sets `truncated_stdout` / `truncated_stderr`. Independent from `execMaxOutputBytes` (which guards `execute_command`); a long-running session can be held for an hour while its capped buffer rolls over many times against the cap.
- `processSessionTtlMs` (default 60 000): how long a settled session stays in the registry so late `interact` calls can fetch the final output.
- `processGcIntervalMs` (default 10 000): GC sweep cadence. Only settled sessions are eligible — running sessions are never GC'd.

`registry.shutdown()`: iterates running sessions, calls `platformKill(child, force=true)` on each, awaits `child.once('close')` per session with a 10 s hard deadline, clears the GC interval. Idempotent. Wired into `src/index.ts` SIGINT / SIGTERM handlers that call `registry.shutdown()` and then `process.exit(0)`. Previously the server had no shutdown hook at all.

**§Z.4. `start_process` tool contract.**

`src/tools/system/start_process.ts`. Returns immediately with a `session_id`.

- Input: `command: string[]` (1..64), `cwd?: string`, `env?: Record<string, string>`, `timeout_seconds?: number` (default 300, max 3600).
- Defenses (parity with `execute_command`):
  - Composed argv is checked against `execExtraBlocklist` (same patterns) — match → `EBLOCKED`.
  - `cwd` validated via `checkAllowed`; default `allowedRoots[0]` when omitted.
  - `env` merged on top of `buildExecEnv(config)`; subprocess PATH stays `sanitizedPath`.
- Output: `{ session_id, started_at, status, command_prefix }`. `status` is `running` on the happy path, `spawn_failed` if the OS rejected the binary synchronously or asynchronously.
- Errors: `EBLOCKED`, `EPERM_ROOT`, `ENOTDIR`, `ENOENT` (cwd missing), `EBUSY` (concurrency cap).
- Audit (mutation, carries `mode`): `command_prefix` (256), `command_length`, `cwd`, `env_key_count`, `timeout_seconds`, `session_id`, `status`. Raw command body NEVER persisted.

**§Z.5. `interact` tool contract.**

`src/tools/system/interact.ts`. The pump that drives a session forward.

- Input: `{ session_id, input?, stdout_since?, stderr_since?, max_wait_ms?, finalize? }`. Defaults: offsets 0, `max_wait_ms` 5000 (max 60000), `finalize` false.
- If `input` is provided AND session is running AND stdin is open → `child.stdin.write(input)`. If `finalize: true` → `child.stdin.end()` and the session's `stdin_closed` flag is set permanently.
- Then `session.waitForOutput(stdout_since, stderr_since, max_wait_ms)` — long-polls until new output past the caller's offset, session settle, or `max_wait_ms` (whichever fires first; deadline is normal, never raises).
- Output: `{ session_id, status, exit_code, stdout, stderr, stdout_offset, stderr_offset, truncated_stdout, truncated_stderr, settled_at }`. Slices are byte-indexed (`Buffer.subarray` + `toString("utf8")`); partial multi-byte sequences degrade to U+FFFD per Node's default decoding.
- Errors:
  - `ENOSESSION` — session_id not in registry (never existed or GC'd past TTL).
  - `EPIPE_CLOSED` — input was supplied but stdin is already closed (prior `finalize` or session settled).
- Outer `runTool` timeout is bumped to `max_wait_ms + 2 000 ms` so the wrapper never short-circuits to `ETIMEDOUT` before the long-poll deadline fires naturally.
- Audit (mutation, carries `mode`): `session_id`, `input_bytes` (count or `'none'`), `max_wait_ms`, `finalize`, `returned_stdout_bytes`, `returned_stderr_bytes`, `session_status`. `input` body is added to `SENSITIVE_ARG_KEYS` and redacted as `<redacted: N bytes>`.

**§Z.6. `list_process` tool contract.**

`src/tools/system/list_process.ts`. Read-only enumeration.

- Input: none.
- Output: `{ sessions: SessionSummary[], total: number }`. Each summary: `session_id`, `command_prefix` (256), `started_at`, `status`, `exit_code`, `stdout_bytes`, `stderr_bytes`, `truncated_stdout`, `truncated_stderr`, `settled_at`. Sorted by `started_at` ascending.
- Errors: none (other than the wrapper's `ETIMEDOUT`).
- Audit: read-only — `mode` field omitted.

**§Z.7. `kill_process` tool contract.**

`src/tools/system/kill_process.ts`. Idempotent.

- Input: `{ session_id, force? }` (force default false).
- Already-settled session → no-op return `{ killed: false, was_already_settled: true, status, exit_code }`.
- Running session → `registry.kill(session_id, force)` which:
  - Windows graceful: `taskkill /T /PID <pid>` (no `/F`). 5 s grace. If still running → escalate to `taskkill /F /T`.
  - Windows forced: `taskkill /F /T /PID <pid>`.
  - POSIX graceful: SIGTERM. 5 s grace. If still running → SIGKILL.
  - POSIX forced: SIGKILL.
  - After kill request, await `child.once('close')` with a 2 s fallback. If still running after the combined wait, defensively settle as `killed` with `exit_code: null`. Race-handling: if `close` already fired with status `exited` just before the kill landed, reclassify as `killed`.
- Output: `{ session_id, killed, was_already_settled, status, exit_code }`.
- Errors: `ENOSESSION`.
- Audit (mutation, carries `mode`): `session_id`, `force`, `killed`, `was_already_settled`, `session_status`.
- Outer `runTool` timeout bumped to ≥ 10 s so the graceful-kill 5+2 grace doesn't synth `ETIMEDOUT`.

**§Z.8. Error code catalog additions.**

| Code | Tool | Meaning |
|---|---|---|
| `ENOSESSION` | `interact`, `kill_process` | `session_id` not in the in-memory registry (never existed, or GC'd past `processSessionTtlMs` after settle). |
| `EPIPE_CLOSED` | `interact` | Input supplied but child stdin is closed (prior `finalize: true`, or the session has already settled). Returned BEFORE the long-poll read so the caller learns the write failed even with a 5-second poll. |
| `EBUSY` | `start_process` | Concurrency cap (`processMaxConcurrent`) reached. Existing code; new context. |

**§Z.9. `MUTATION_TOOLS` extension.**

`MUTATION_TOOLS` (audit.ts) grows from 12 to 15: `+ start_process + interact + kill_process`. `list_process` is read-only and is NOT added.

**§Z.10. `SENSITIVE_ARG_KEYS` extension.**

`+ input` (interact). Redacted by the existing string-bytes / array-items / object-keys rule already in place; reuses the sanitizer that wave 1 extended for `write_json.value`.

**Invariant #36 — process registry is the ONLY long-lived shared mutable state.** No other tool may take a dependency on shared in-memory state across calls. Future stateful tools either add to this registry (process management) or build their own clearly-bounded singleton, instantiated in `createServer` and drained via `shutdown()`.

**Invariant #37 — shutdown drains the registry within 10 s.** SIGINT/SIGTERM handlers in `src/index.ts` call `registry.shutdown()` which SIGKILLs all running children and awaits their `close` event with a 10 s hard deadline. Children never leak past server process exit on the happy path.

**Invariant #38 — every settled session is reapable.** A session whose status flips out of `running` MUST have its child either fully closed or about to close. The `deadlineFired` flag ensures the timed_out path lets the natural close event drive settlement, rather than settling first and leaving a still-alive process attached. **Generalised to all future stateful subsystems by invariant #41 (wave 2c).**

---

### 2026-05-22 — v0.7 pre-tag bug-fix wave: §AA

**Motivation.** The v0.7 pre-tag external review wave (16-cell × 4-surface, artifacts under `audit/external_reviews/v0.7-pre-tag/`) surfaced 13 P1 + ~25 P2 findings. The pre-tag bug-fix wave applied the security-relevant + high-confidence subset, deferred the rest to v0.7.x, and invalidated grep P1.2/P2.7 (line ReDoS) after V8 verify-first showed the bait pattern returns in ~10 ms.

The wave's findings cluster around one systemic weakness: **async cleanup on error paths**. Three of the largest fixes (fetch_url P2.2, execute_command P1.3, edit_file P1.1) all addressed AbortSignal lifetime issues — listeners not removed, abort race during pid materialisation, signal not forwarded through the tool's I/O calls. The atomicWriteFile refactor was a Phase 1 precursor that made the edit_file fix possible without leaking orphan temp files. The pattern is captured as invariant #39 below.

**§AA.1. fetch_url — redirect protocol downgrade refused.**

`fetchUrlImpl`'s redirect loop reuses `validateProtocol` per hop, but that helper accepts both `http:` and `https:`. Pre-fix a 302 from `https://allowed/sso` to `http://allowed/sso` was silently followed — MITM-observable, and a path to probe HTTP-only internal services through a whitelisted CDN/SSO host. The fix adds an `isProtocolDowngrade(from, to)` helper called before advancing `currentUrl`; a downgrade returns `EHOSTNOTALLOWED` with `details.reason: "protocol_downgrade"`, `details.{from, to, from_host, to_host}` for caller discrimination.

Error code reuses `EHOSTNOTALLOWED` (this hop's URL is not allowed) rather than introducing `EPROTOCOL_DOWNGRADE`. Decision rationale: a new code requires audit-surface + caller-mapping changes; the `details.reason` field gives equivalent discrimination without expanding the error vocabulary.

**§AA.2. fetch_url — SSRF guard recognises full fe80::/10 and IPv4-mapped IPv6 hex-colon form.**

`isInternalIP` previously used `lower.startsWith("fe80")` for link-local, which only covered the 16-bit literal prefix. The fe80::/10 range spans `fe80::` through `febf::` (10-bit prefix). Fix: bitmask the first word: `(parseInt(word, 16) & 0xffc0) === 0xfe80`.

For IPv4-mapped IPv6, the inner segment after `::ffff:` was only checked via `net.isIPv4` (dotted-decimal form). The hex-colon form `c0a8:0101` (= 192.168.1.1) returned false from `net.isIPv4`, allowing SSRF to private space through `::ffff:c0a8:0101`. Fix: when the inner segment is two ≤4-char hex groups, convert to dotted-decimal and recurse.

**§AA.3. fetch_url — final_url query redaction matches audit-log behaviour.**

Pre-fix `final_url: currentUrl.toString()` returned the full URL including query string to the caller. Audit log already redacted via `redactUrlForAudit`. The fix applies the same redaction to the response value; user-visible and audit-visible URLs now match.

**§AA.4. fetch_url — explicit `rejectUnauthorized: true`.**

Defense-in-depth. Node's default for HTTPS request options is `true`, so no behavior change today. The explicit assignment prevents a runtime override (test environment, dependency side-effect, `https.globalAgent` reassignment) from silently disabling certificate validation for this codepath.

**§AA.5. fetch_url — AbortSignal listener cleanup on safeResolve.**

The `addEventListener("abort", ..., { once: true })` registration was never explicitly removed on normal completion — `{ once: true }` only auto-removes after the abort event itself fires. Long-lived signals reused across many requests accumulated one listener per call (and per redirect hop). Fix: `safeResolve` calls `removeEventListener` before resolving.

**§AA.6. fetch_url — allowedUrlHosts entries trimmed.**

`validateHostWhitelist` now applies `.trim()` before lowercase comparison. Operator misconfiguration (leading/trailing whitespace in config) no longer silently rejects all requests to that host.

**§AA.7. exec_safety — blocklist closes -EncodedCommand + rm short-flag bypasses.**

Two patterns added to `DEFAULT_EXEC_BLOCKLIST`:
- `(?:^|\\s)-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\\s` — catches every PowerShell-accepted prefix of `-EncodedCommand`, preventing base64-payload smuggling past destructive-verb patterns.
- `rm\\s.*-[rR]\\b` and `rm\\s.*-Recurse\\b` — catches PowerShell's `Remove-Item` aliases with short / long recursive flags. Prior pattern required combined `-rf`.

Both bypasses verified by Phase 0 verify-first tests before the patch landed; tests flipped from failing to passing on application.

**§AA.8. exec_safety — SpawnSubprocessResult gains `aborted: boolean`.**

Pre-fix a caller-initiated abort produced `exit_code: null` indistinguishable from a clean no-output exit. The new field is true iff the `onAbort` handler ran (caller-initiated cancellation). False for every other settle path. A narrow pid-undefined race (abort fires before child.pid materialises) is closed by an `abortRequested` latch + `child.on("spawn", ...)` handler.

**§AA.9. atomicWriteFile signal contract (Phase 1 precursor).**

`atomicWriteFile(destPath, data, options?)` now accepts `options.signal?: AbortSignal`. Threaded through `fs.open` / `handle.writeFile` / `fs.unlink` / `fs.rename` via the options bag (Node 18+). Three abort points handled:

1. **Pre-aborted signal before fs.open** — throws an abort error, no temp file ever created.
2. **Abort during writeFile/sync** — best-effort `handle.close` + `fs.unlink(tmpPath)` before re-throwing the writeFile error.
3. **Abort between close and rename** — explicit `signal.aborted` check before rename; unlinks temp and throws abort error rather than promoting a half-aborted write to the destination.

Optional / default undefined. Every existing caller — `write`, `append`, `edit_file`, `write_json` — preserved without modification (only `edit_file` chose to thread the signal in this wave; the rest remain candidates for v0.7.x).

**§AA.10. edit_file signal forwarding.**

`editFileImpl(args, config, signal?)` signature gains the optional signal. `fs.readFile` and `atomicWriteFile` receive `{ signal }`. The wall-clock deadline in `withTimeout` previously surfaced ETIMEDOUT correctly (via Promise.race) but left orphan I/O running past the deadline; now the underlying operations cooperate with the abort.

**§AA.11. grep deadline-race fix.**

Pre-fix `outerDeadline = Math.min(innerDeadline + OUTER_TIMEOUT_BUFFER_MS, maxTimeoutMs)`. When the caller requested `timeout_ms === maxTimeoutMs`, both deadlines collapsed to the same wall-clock instant; V8 timer ordering is non-deterministic at equal expiry, so the outer wrapper could win, returning ETIMEDOUT instead of grep's partial-result path. Fix: invert the order. Outer = `resolveTimeoutMs(requested, default, max)`; inner = `max(1, outer - OUTER_TIMEOUT_BUFFER_MS)`. Inner always fires ≥ buffer before outer regardless of caller input.

**§AA.12. grep defense-in-depth guards.**

- Negative `context_lines` in direct `grepImpl` callers (bypassing Zod) → `EINVAL` early.
- Wildcards-only glob (e.g. `**/*.ts`) with empty/non-absolute `compiled.base` → `EINVAL` (compileGlob already throws; new assert is a second layer).
- `re.lastIndex = 0` reset at the top of each line iteration. No-op today (no `g`/`y` flags); future-proofs the no-flag invariant.

**§AA.13. exec_hints — document-in-pipeline hint rewritten.**

The prior hint advised "try a different shell (cmd)", but execute_command runs PowerShell only — cmd is not an available dispatch route. New hint surfaces three in-this-tool workable paths: direct binary invocation without `&`, `Start-Process -FilePath ... -Wait`, or `ssh_exec` for the common case of ssh.exe.

**Invariant #39 — error paths must NOT leak async resources past the deadline.** AbortSignal listeners registered for cleanup MUST be removed in the settle path, not merely registered with `{ once: true }`. Process spawns owned by a tool MUST surface caller-cancellation distinguishably (`aborted` flag, not just `exit_code: null`). I/O operations downstream of `runTool` MUST forward the wrapper's signal so the wall-clock deadline actually aborts in-flight work, not merely returns ETIMEDOUT while orphan I/O continues. Closes the systemic gap surfaced by the v0.7 pre-tag review wave.

**Invariant #40 — defense-in-depth on validator boundaries.** Each tool's `Impl` function MUST re-assert inputs that the registered-tool Zod schema validates, when those inputs are also used by structurally adjacent code paths (recursion, walk callbacks, future internal callers). The Zod check is the public boundary; the impl-level assert is the internal contract. Surfaced this wave by grep's negative-context_lines + wildcards-only-glob defense-in-depth.

**Bug #1 outcome (NOT a winfs server-side bug).** The empirically observed "EPERM_ROOT then 4-minute hang" reported in the parallel ai-judge chat does not reproduce at the in-process winfs impl layer (regression tests at `tests/unit/exec/bug1_eperm_root_hang.test.ts`). The hang localises to the MCP transport between Claude Desktop and the winfs server — same pattern as the existing CLAUDE.md operational note. Tests stay in the suite as regression cover for the in-process invariant. Spec: no change required; ops doc already covers the transport workaround.

**Invalidated finding — grep P1.2 / P2.7 (line ReDoS).** Phase 0 verify-first test showed V8 returns within ~10 ms on the canonical bait pattern `(a+)+$` against a 10 KB 'a' line, well within deadline. No `LINE_SCAN_CAP` introduced. Verify-first test stays as a pin (any future regression re-opens the discussion). Detailed in `audit/external_reviews/v0.7-pre-tag/_invalidated_findings.md`.

**No new error codes.** Spec invariant set grew from #38 to #40 (+2). Tool inventory unchanged at 37. CHANGELOG `[Unreleased]` continues; no version bump from this wave.

---

### 2026-05-22 — v0.7 wave 2c: architectural closure (§AB)

**Motivation.** Three architectural / methodological items accumulated during the v0.7 sub-waves that should land while the codebase is fresh and no downstream consumer depends on internal signatures. None are user-facing bugs.

**§AB.1. Invariant #41 — stateful sessions settle by close-event only (generalises #38).**

Wave 2b introduced invariant #38 ("every settled session is reapable") for the ProcessRegistry case: a session whose status flips out of `running` MUST have its child either fully closed or about to close. The `deadlineFired` flag pattern (timed_out is recorded, but the natural close event drives the actual settle) was the concrete fix.

Invariant #41 generalises that ProcessRegistry-specific rule to **every future stateful subsystem** (file watcher, network connection, persistent shell, job queue, etc.):

> Subsystems that manage long-lived OS resources MUST NOT transition session state to a settled value (`exited`, `killed`, `timed_out`, `failed`, `closed`, …) based on intent-to-terminate alone — deadline fires, kill signal sent, cleanup requested, abort received. The final state transition MUST be driven by the actual close-event from the underlying resource. Intent-to-terminate may set per-session flags (`deadlineFired`, `killRequested`, `abortRequested`, etc.) which influence the eventual settle-state classification, but the settle itself happens only when the resource confirms it has released.

**Rationale.** A session marked `settled` while the OS resource is still live causes cleanup races. On Windows the most visible symptom is `EBUSY` on `rmdir` during test cleanup, because the temp directory is still held open by the not-actually-dead subprocess. Wave 2b's ProcessRegistry surfaced this race; the `deadlineFired` flag + close-event-driven settle is the reference pattern.

**Applies to.** ProcessRegistry in `src/core/process_registry.ts` (already conformant via the wave 2b fix that earned invariant #38). All future stateful subsystems by default. Pair with invariant #36 (ProcessRegistry is the ONLY long-lived shared mutable state today) and invariant #39 (error paths must not leak async resources past the deadline).

**§AB.2. ToolContext: uniform register*Tool signature.**

Pre-wave: every `register<Name>Tool` took `(server, config, audit, registry?)` positional arguments, with `registry` added in wave 2b. Each future stateful subsystem would add a positional arg and break every registration site.

Post-wave: a single `ToolContext` interface in `src/core/tool_context.ts` consolidates per-server state. Every `register*Tool` accepts `(server, ctx: ToolContext)`. Extending the context (next stateful subsystem) adds a field to the interface, not a positional parameter.

```typescript
export interface ToolContext {
  readonly config: ResolvedConfig;
  readonly registry: ProcessRegistry;
}

export function createToolContext(parts: {
  config: ResolvedConfig;
  registry: ProcessRegistry;
}): ToolContext { /* ... */ }
```

(Audit is module-level via `appendAudit(config, record)` and stays that way — passing it through context would change a stable single-module surface for no benefit.)

`createServer` constructs the context once and passes it to every register call; the return type changes from `{ server, registry }` to `{ server, ctx }`. `src/index.ts` reaches the registry as `ctx.registry`.

**Rule.** When introducing a new stateful subsystem:
1. Add the field to `ToolContext` and to `createToolContext`'s `parts` parameter.
2. Construct the subsystem in `createServer` and pass it through `createToolContext({ ..., new_field: ... })`.
3. Tools that need the new subsystem destructure it from `ctx`.
4. Apply invariant #41 to the subsystem's settle semantics.

No signature change required for tools that don't use the new subsystem — they ignore the new field.

**§AB.3. Methodology: blocklist-fix verify-then-smoke pattern.**

Documented in `CLAUDE.md` (operational), not in the spec (procedural rather than architectural). Captured here as a back-reference: external-review findings that propose blocklist-pattern changes require BOTH pre-fix verify (demonstrate the under-block via a failing test) AND post-fix smoke against legitimate use cases in the same syntactic neighborhood. The `-EncodedCommand` greedy-pattern over-block in the v0.7 pre-tag bug-fix wave (commit `2bb8a69` over-blocked `node -e` / `python -e` / `perl -e`; fix in `7b7a41c` added PowerShell-context lookahead) is the canonical example.

**Wave summary.** Spec invariant set grew from #40 to #41 (+1). One new internal interface (`ToolContext`) and one register*Tool signature change (`(server, config, audit, registry?)` → `(server, ctx)`). No user-facing behaviour change. No version bump; `[Unreleased]` continues.

---

### 2026-05-22 — v0.9.0: MCP Roots protocol support (§AC)

**Motivation.** Pre-v0.9 winfs read `allowedRoots` once at startup from `%LOCALAPPDATA%\mcp-winfs\config.json` and never updated. Every new project root required editing the file and restarting Claude Desktop — the operational pain that v0.7 hit repeatedly. The Model Context Protocol [Roots](https://modelcontextprotocol.io/docs/specification#roots) protocol lets the client signal its current project roots at connection time and via runtime `notifications/roots/list_changed`. winfs v0.9 subscribes to both.

**§AC.1. Union mode (NOT replace mode).**

The reference `@modelcontextprotocol/server-filesystem` *replaces* its allowed-directory list with client roots. winfs takes the safer union approach:

```
effectiveAllowedRoots = union(config.allowedRoots, clientRoots)
```

**Rationale:**
- winfs's safety posture is "narrow by default". Union widens only when both server-side config AND client-side roots trust a path.
- Replace mode can surprisingly *reduce* allowed access if the client doesn't know about config-supplied roots.
- Empty client roots → config-only access (no regression vs pre-v0.9 behaviour).
- Client roots can only WIDEN access, never silently remove paths the operator explicitly trusted via config.

**§AC.2. Implementation.**

New module `src/core/roots_resolver.ts` owns the live effective set. `RootsResolver` is constructed in `createServer` with a snapshot of `config.resolvedAllowedRoots`; later `setClientRoots(...)` calls compute the union (case-insensitive dedup on Windows; case-sensitive on POSIX) and mutate `config.resolvedAllowedRoots` in place via `length = 0; push(...union)`.

The in-place mutation choice lets all 17 existing readers of `config.resolvedAllowedRoots` (incl. `checkAllowed`, `walkFiles`, `execute_command.cwd-default`, `list_allowed_directories`) automatically pick up the live union — no signature change to `checkAllowed`, no rewrite of any tool's `*Impl`. The previous "config is immutable post-loadConfig" convention is amended: `config.resolvedAllowedRoots` is the SOLE field with a designated mutator (`RootsResolver`). Every other reader treats the array as read-only.

`ToolContext` gains `rootsResolver: RootsResolver` field (per the §AB.2 extension rule). Tools that need direct access (e.g. `list_allowed_directories` for documentation purposes) can call `ctx.rootsResolver.effective()`; most tools continue to read `config.resolvedAllowedRoots` unchanged.

**§AC.3. Client-roots validation.**

`setClientRoots(roots: readonly string[])` is the sole entry point. Each candidate is validated:

1. Non-empty string.
2. Absolute path (per `path.isAbsolute`).
3. `fs.stat` succeeds (path exists).
4. Path is a directory.
5. `fs.realpath` resolves (defeats symlink-escape; falls back to the literal absolute form on permission errors).

Invalid roots are SKIPPED with a stderr warning (`RootsResolver: rejecting <reason> client root: <path>`). Valid roots in the same batch are still applied — partial-success semantics matching the Filesystem-MCP reference. One bad client root does not poison the rest.

Both the realpath-resolved form AND the literal absolute form are stored if they differ (case-insensitive on Windows) — matches the reference server's dual-path-storage pattern. Some clients pass canonicalised paths; others pass paths with symlink segments. Accepting both avoids false `EPERM_ROOT` on either form.

**§AC.4. Server wiring.**

In `createServer`:

- `server.server.oninitialized` — fires once after the `initialize` exchange. If the client advertises `roots` capability via `server.server.getClientCapabilities()`, fire-and-forget call to `listRoots()` populates the initial client-roots set.
- `setNotificationHandler(RootsListChangedNotificationSchema, ...)` — runtime updates re-fetch via `listRoots()`. Same path, same validation, same audit event.

Only `file://` URIs are accepted. Other schemes (`http://`, custom) are logged and skipped. `fileURLToPath` from Node's `url` module handles Windows drive letters and percent-encoding correctly.

Either handler failing is non-fatal: stderr message, fall back to config-only roots, server continues. The handler chain explicitly does NOT throw — degrading to config-only is always preferred over crashing the server on a transient `listRoots` failure.

**§AC.5. Audit record.**

Each successful `setClientRoots` emits one audit record:

```jsonl
{
  "ts": "2026-05-22T22:38:00.000Z",
  "tool": "_client_roots_updated",
  "args_summary": {
    "accepted_count": 1,
    "rejected_count": 0,
    "config_roots_count": 1,
    "effective_count": 2
  },
  "result_status": "ok",
  "duration_ms": 0,
  "mode": "strict"
}
```

**Counts only — NEVER path strings.** Including paths in the audit trail would leak the caller's directory structure into a record that may be transported to a different machine, accidentally archived, etc. The forensic value of "client signalled N new roots; M rejected" is higher than the value of the path content, especially since the live effective set is already discoverable via `list_allowed_directories`.

Per the `_`-prefix convention from spec §U / `_server_start`, system-emitted audit entries use a `_` prefix to distinguish them from registered tools.

**§AC.6. Capability declaration.**

The server does NOT need to declare any capability to RECEIVE client roots — the client-side capability (`roots`) is what gates the protocol. winfs simply checks `getClientCapabilities()` at `oninitialized` and acts accordingly. The MCP SDK auto-fills server-side capabilities derived from registered tools; we don't override.

**Invariant #42 — effective allowed roots are the union of config and client roots.**

`effectiveAllowedRoots = union(config.allowedRoots, RootsResolver.clientRoots())`. Union chosen over replace for safety: client roots can only widen access, never silently remove paths the operator explicitly trusted via config. Empty client root set degrades to config-only access. Client roots validated at `setClientRoots` — absolute, existing directory, symlinks resolved per reference server's dual-path-storage pattern. Invalid roots skipped with warnings; valid ones still apply. Audit records `_client_roots_updated` events with count only, never paths. Applies to all path-bound tools through their unchanged read of `config.resolvedAllowedRoots`, which the resolver mutates in place. Generalises invariant #36 (ProcessRegistry-only shared mutable state): `config.resolvedAllowedRoots` is now also shared mutable state, but with `RootsResolver` as its single owner.

**Wave summary.** Spec invariant set grew from #41 to #42 (+1). One new core module (`RootsResolver`) and one new `ToolContext` field (`rootsResolver`). The `checkAllowed` signature, all 39 register*Tool signatures, and every `*Impl` signature stay unchanged — the resolver mutates the live `config.resolvedAllowedRoots` array so existing readers automatically pick up the union. User-facing behaviour: with an MCP-Roots-aware client, paths inside client-signalled project roots are accessible without `config.json` edit + Claude Desktop restart. Version bump 0.8.0 → 0.9.0.

### 2026-06-02 / 2026-06-03 — v0.10.0 child-spawn hardening + v0.10.1 final polish

**§AB.4. Convention: do not clone `result.value` across the impl→runTool boundary.**

Several tools (`execute_command`, `edit_file`) attach audit-only metadata to the
success value via a module-level `WeakMap<object, …>` keyed by the `result.value`
object identity (`getEditFileAuditExtras` / `getExecuteCommandAuditExtras`). `runTool`
reads it by passing the SAME `result` object to the `auditExtras` callback before
`successResponse(result.value)`. The convention: **no layer between an `*Impl`'s
return and `runTool`'s `auditExtras` callback may clone, spread, or otherwise
replace `result.value`** — doing so breaks the WeakMap lookup and silently drops
the audit extras (deferred finding edit_file P2.3, assessed as theoretical: no
current code violates this; the WeakMap pattern is sound under the convention).
Closes the dangling "Spec §AB sets the rule" reference in `edit_file.ts`.

**Invariant #43 — every spawn sets an explicit standard PATHEXT (v0.10.0).**

Under Claude Desktop on Windows the inherited `PATHEXT` was observed mangled to
`.CPL`, breaking libuv bare-name executable resolution (`git`/`node`/`where`/
`taskkill` → not found) despite the directory being on PATH. **winfs MUST NOT
forward the inherited PATHEXT.** Every spawn pins
`STANDARD_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"`:
`buildExecEnv` (both branches — covers `spawnSubprocess` and `ProcessRegistry.spawn`),
`gitSpawnEnv` (also sets `GIT_TERMINAL_PROMPT=0`), the internal `taskkill` spawns,
and the `where pwsh` resolver probe. Session spawns re-pin PATH/Path/PATHEXT AFTER
the caller's `extraEnv` (`buildSessionEnv`) so a `start_process` caller cannot
clobber the hardening. The sanitized PATH (invariant Step 1 #10 — user `$PATH`
not inherited) is preserved; `execExtraPathDirs` (v0.10.1) appends operator-supplied
dirs for non-standard tool installs without inheriting `$PATH`.

**Invariant #44 — one-shot exec deadlines coordinate outer and inner timers (v0.10.1).**

`runTool` wraps every impl in an OUTER `withTimeout`. For the exec tools
(`execute_command`, `run_python`, `run_pytest`, `ssh_exec`) the registration MUST
set `ctx.timeoutMs` = the resolved per-call deadline and (when it can exceed the
general `config.maxTimeoutMs`) `ctx.maxTimeoutMs` to raise the outer ceiling, and
pass the INNER spawn deadline as `outer − OUTER_TIMEOUT_BUFFER_MS` so the graceful
inner timeout (`timed_out: true` + partial output + tree-kill) always fires before
the outer wrapper's `ETIMEDOUT`. Omitting `ctx.timeoutMs` (the pre-v0.10.1 bug) left
the outer clamped to `defaultTimeoutMs` regardless of `timeout_ms` — "exceeded
10000ms". `execute_command` uses the shell pair (`shellTimeoutMs` 30 s /
`shellMaxTimeoutMs` 600 s hard max) so 6–8 min builds run; the registry session
timeout (300 s / 3600 s) is independent and untouched (invariant #41). The separate
~4-min Claude Desktop MCP-transport ceiling is upstream and out of winfs's scope.

**ssh binary resolution (v0.10.1).** `config.sshExePath` is optional; `resolveSshBin`
honors an explicit value strictly, else auto-detects Git-bundled ssh (preferred over
the often-broken System32 OpenSSH), then System32, then PATH.

**Wave summary.** Spec invariant set grew #42 → #44 (+2). New modules:
`transport_log.ts` (v0.10.0, opt-in `WINFS_TRANSPORT_LOG`), `config_watch.ts`
(v0.10.0, allowedRoots hot-reload), `ssh_resolver.ts` (v0.10.1). Versions
0.9.2 → 0.10.0 → 0.10.1.

### 2026-06-03 — v0.10.2: §AD MCPB packaging

v0.10.2 — упаковочная волна. **Новых инструментов нет** (surface заморожен на 39
с v0.8). Содержание волны: MCPB-упаковка, production README rewrite, §7 приведён
к фактической поставке. (Полный eval suite и сам v1.0.0-release — отдельная
будущая волна; см. §7 и §10.)

**§AD.1. MCPB как дополнительный способ установки (не замена).** Ручной путь
(`--config <path>` либо `%LOCALAPPDATA%\mcp-winfs\config.json`) сохранён без
изменений. MCPB добавляет one-click drag-install в Claude Desktop:

- `mcpb/manifest.json` — manifest v0.4. `server.mcp_config` запускает не сам
  сервер, а **shim** `mcpb/launch.mjs`. `user_config` поля: `allowedRoots`
  (directory, multiple, required), `execExtraPathDirs`, `sshExePath`,
  `powershellExePath`, `pythonHome`, `unrestrictedFilesystem` (bool, default
  false), `unrestrictedFilesystemConfirm` (string).
- `mcpb/launch.mjs` — массивы (`allowedRoots`, `execExtraPathDirs`) приходят
  argv-expansion'ом (`--roots …`, `--extra-path-dirs …`), скаляры — через env;
  shim защитно отбрасывает неподставленные `${…}` плейсхолдеры, накладывает
  значения на baseline `configs/default.json`, атомарно (temp+fsync+rename)
  пишет **выделенный** `%LOCALAPPDATA%\mcp-winfs\mcpb-config.json` (никогда не
  трогает ручной `config.json`) и передаёт серверу через `--config`, импортируя
  `dist/index.js` в том же процессе.
- Сборка: `npm run mcpb` (`scripts/build-mcpb.mjs`) — компиляция, staging
  `dist` + production-only `node_modules` + shim + baseline, синк версии из
  `package.json` в manifest, `mcpb validate`, `mcpb pack` →
  `dist-mcpb/winfs-0.10.2.mcpb`.
- Проверка: `scripts/smoke/mcpb-smoke.mjs` распаковывает реальный `.mcpb` и
  гоняет launcher по stdio как Claude Desktop (9/9).

**Инвариант #45 — MCPB user_config маппится в runtime config БЕЗ обхода
enforcement.** В MCPB-манифесте нет блока разрешений и нет sandbox; всю защиту
несут tool-handlers сервера. Поэтому: (a) `allowedRoots` из Configure UI
проходит ровно ту же realpath→prefix проверку, что и из ручного конфига
(инвариант allowed-roots не ослаблен); (b) shim **не синтезирует**
magic-confirm — `unrestrictedFilesystem: true` без точной строки
`unrestrictedFilesystemConfirm = "I-UNDERSTAND-THE-RISK"` приводит к отказу
старта в `loadConfig` (инвариант #28), как и при ручном конфиге; (c) shim пишет
только ключи, принимаемые строгой Zod-схемой (`.strict()`) — никакого
расширения поверхности конфигурации через упаковку.

**Wave summary.** Spec invariant set grew #44 → #45 (+1). Новых модулей в `src/`
нет (упаковка вне рантайма: `mcpb/`, `scripts/build-mcpb.mjs`,
`scripts/smoke/mcpb-smoke.mjs`). Версия 0.10.1 → 0.10.2.
