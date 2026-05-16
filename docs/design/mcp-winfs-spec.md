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
├── manifest.json                  # MCPB packaging (v1.1+)
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

| Версия | Содержание | Acceptance criteria |
|---|---|---|
| **v0.1** | Core 5 (read/write/append/list/stat) + все hard-инварианты + audit + config | Один tool работает end-to-end в Claude Desktop. allowed-roots блокирует попытку вне whitelist. Timeout 10s ловится. UTF-8 round-trip на файле с русским текстом без потери. |
| **v0.2** | + Mutations (move/copy/mkdir) + read_multiple_files + list_allowed_directories | Versioning workflow можно делать без shell |
| **v0.3** | + Search (grep/glob/read_json) + audit_tail | Поиск + self-recovery |
| **v0.4** | + Editor (edit_file с dryRun) + Slicing (read_section/read_since/diff_files) | Surgical edits + инкрементальное чтение |
| **v0.5** | + Git RO (log/status/diff/show/blame) | Architect git inspection |
| **v0.6** | + Exec (execute_command/run_python/run_pytest) | Shell + Python probes с bounded timeouts |
| **v0.7** | + System (find_command/check_env) + Network (fetch_url) | Полный набор 29 |
| **v1.0** | Polish + MCPB packaging + README + comprehensive test suite | Production-ready |

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

- **MCPB packaging.** Когда упаковываем в `.mcpb` для one-click install? Вероятно после v1.0 и недели стабильной работы.
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
