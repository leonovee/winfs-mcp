# CLAUDE.md — правила работы над winfs-mcp

Этот файл — справка для всех, кто работает над проектом: для Владимира (заказчика), для чат-Claude (архитектора) и для Claude Code (исполнителя). Читайте его в начале каждой новой сессии.

## Кто что делает

### Владимир (Vladimir Leonov, `leonovee` на GitHub)

— заказчик и оператор машины (Windows, Tallinn);
— запускает Claude Code в VS Code из папки `C:\Users\User\Desktop\ai\tools\winfs\` (на текущей машине; на старой машине было `C:\Users\Expert\Desktop\AI\tools\winfs\`);
— даёт Claude Code название промпта (например: «выполни `prompts/cc-prompt-mcp-winfs-v0.6.md`»);
— копирует вывод Claude Code в чат с Claude для разбора;
— корректирует план, если что-то не так.

### Чат-Claude (архитектор)

— обсуждает с Владимиром, что делать дальше;
— пишет промпты и сохраняет их в папку `prompts/<имя>.md`;
— сообщает Владимиру только имя файла, не вставляет содержимое промпта в чат;
— разбирает вывод Claude Code, готовит следующий промпт или закрывает задачу;
— **не** выполняет git-команды через `winfs:execute_command` для кода проекта — это работа Claude Code;
— **можно** использовать `winfs:write` и мелкие git-команды для самих промптов и мета-файлов (`CLAUDE.md`, файлы в `prompts/`, и т.п.).

### Claude Code (исполнитель)

— запускается через VS Code в папке проекта;
— получает от Владимира имя промпта;
— читает файл из `prompts/` и выполняет всё, что там написано;
— делает коммиты, прогоняет тесты, пушит в remote;
— отдаёт итоговый отчёт Владимиру.

## Как идёт работа

1. Владимир и чат-Claude обсуждают, что делать.
2. Чат-Claude пишет промпт в файл `prompts/<имя>.md`.
3. Чат-Claude сообщает Владимиру имя файла.
4. Владимир в VS Code говорит Claude Code: «выполни `prompts/<имя>.md`».
5. Claude Code выполняет, отдаёт вывод.
6. Владимир копирует вывод в чат.
7. Чат-Claude разбирает, идёт на шаг 1 или закрывает задачу.

## Правила общения чат-Claude → Владимир

— по-русски, простым языком;
— без английского жаргона типа «handoff», «stage», «smoke test», «pre-flight», «rebase» и т.п. — заменять русскими словами или пояснять;
— технические термины из git/npm/dev-сленга (коммит, тег, ветка, билд, тесты) — нормально, привычные;
— короткие сообщения, без полотен текста;
— содержимое промпта — только в файл, в чат идёт только имя файла;
— один вопрос за раз, если нужно уточнение.

## Что чат-Claude НЕ делает

— не вставляет длинные блоки кода или промпты в чат;
— не пишет на смеси русского и английского, где русский язык подменяется кальками;
— не выполняет git-команды для кода проекта напрямую через winfs (этим занимается Claude Code);
— не повторяется и не пересказывает уже написанное в чате.

## Когда чат-Claude всё-таки делает сам через winfs

— создаёт и редактирует файлы промптов в `prompts/`;
— читает состояние репозитория для разбора отчёта Claude Code (`git log`, `git status`, чтение конкретных файлов);
— коммитит мелкие мета-файлы (этот `CLAUDE.md`, файлы в `prompts/`) если Claude Code сейчас не запущен.

## Технические особенности проекта

— основная папка: `C:\Users\User\Desktop\ai\tools\winfs\` (lowercase `ai`, `tools`);
— remote: `https://github.com/leonovee/winfs-mcp`;
— git на Windows вызывать через абсолютный путь: `& "C:\Program Files\Git\cmd\git.exe"`;
— у `winfs:execute_command` исторический "bug #2" из handoff #1 (P2): при вызове `& "git.exe" ...` stdout/stderr якобы пустые. **v0.7.1 (2026-05-22): расследован — на текущем сервере (Node v24, PowerShell, winfs main @ v0.7.1) баг НЕ воспроизводится.** Регрессионные тесты в `tests/unit/exec/stdout_capture.regression.test.ts` пинят инвариант: `node --version`, `& 'git.exe' --version`, `Get-Date` — все три формы корректно ловят stdout. Smoke harness (`scripts/smoke/v0.7-smoke.mjs`) тоже проверяет на wire-level. **v0.7.2 (2026-05-22): применена защитная H2-обвязка PowerShell wrapper'а** — `-OutputFormat Text`, `-InputFormat None`, `[Console]::OutputEncoding = UTF8`, `exit $LASTEXITCODE` — закрывает дверь на предполагаемые environmental причины (CLIXML утечка, stdin-deadlock, OEM code page коррупция). Если симптом всё-таки возникает в чат-Claude / Claude Desktop / browser-mode сессии после v0.7.2 — это **environmental** (другой MCP transport, другой winfs instance, другой PowerShell version), а не дефект серверного кода. Workaround через файлы (`.git/refs/heads/main`, `Start-Process -RedirectStandardOutput`) остаётся как fallback на случай transport-side проблем.
— `winfs` MCP-сервер иногда зависает на 4 минуты (известный баг транспорта). Перезапуск: `.\scripts\restart-winfs.ps1` (если работает) или ручной рестарт Claude Desktop через трей.

## Операционные заметки

### Blocklist-pattern fixes from external review require verify-then-smoke

External-review findings that propose blocklist-pattern changes (typically `exec_safety.ts` regex additions for new dangerous flags / cmdlets / aliases) introduce a **two-sided risk**:

1. **Under-block** — the reviewer's original concern: pattern allows what it shouldn't.
2. **Over-block** — the proposed fix matches legitimate use cases that share the same syntactic neighborhood as the dangerous form.

Both are real defects. Procedure to catch both:

1. **Pre-fix verify** (Phase 0 of any bug-fix wave). Write a failing test that demonstrates the under-block — i.e. the current pattern allows what the reviewer claims it allows. If the test passes against current code, the finding is invalid; close it as a false positive in `_invalidated_findings.md`.

2. **Post-fix smoke** (within the same wave OR before tag). After applying the pattern fix, run the wire-level smoke harness (or a targeted suite) that exercises every legitimate use case in the same syntactic neighborhood as the dangerous form. For `-EncodedCommand` (PowerShell-specific destructive-flag), the over-block check is `node -e "..."`, `python -e ...`, `perl -e '...'`, `ruby -e ...` — short `-e` flags on different binaries that share the prefix but are not the attack path. The smoke MUST NOT trigger the blocklist on any of those.

**Reference incident:** the `-EncodedCommand` greedy-pattern over-block in the v0.7 pre-tag bug-fix wave (commit `2bb8a69`) was caught by the very first start_process smoke probe (`node -e "console.log('hi'); process.exit(0)"` returned `EBLOCKED`). Fix in `7b7a41c` added a positive-lookahead context anchor requiring `powershell` or `pwsh` to appear in the composed string before the `-e` flag matches. Without the smoke harness, the over-block would have shipped to v0.7.0 and silently broken every legitimate `node -e` / `python -e` invocation through `execute_command`.

**When in doubt**: list every binary on PATH that accepts `-<x>` flags resembling the new pattern. If the regex would match any of them in a non-attack context, the pattern needs a context anchor.

### MCP transport — периодические зависания

Вызовы MCP-инструментов из Claude Desktop иногда возвращают `No result received ... after waiting 4 minutes`. Эмпирически паттерн такой: 2–3 четырёхминутных таймаута на одном и том же вызове, затем следующий вызов проходит мгновенно. Рабочая последовательность:

1. **Повторить вызов один-два раза** — часто срабатывает само.
2. Если три таймаута подряд на одном вызове — **полный выход Claude Desktop через системный трей** (правая кнопка → Exit, именно Exit, а не закрытие окна).
3. Если таймауты остались после рестарта — проверить Task Manager на осиротевшие `node.exe`-процессы от предыдущих экземпляров winfs / Desktop Commander и убить их.

## MCP-инструменты: когда какой использовать

В Claude Code и в чат-Claude доступны несколько MCP-серверов, работающих с файлами. У каждого свои сильные стороны.

### winfs (наш собственный, этот репо)

Сильные стороны:
- **атомарная запись** через temp + fsync + rename — целый файл либо записывается, либо нет, без halfway-write при crash;
- **allowedRoots whitelist** — security boundary, нельзя случайно записать вне разрешённых папок;
- **audit log** — каждая мутация записывается с redaction чувствительных данных;
- **SSRF defense** для `fetch_url` (two-layer проверка хостов и IP);
- **edit_file** со строгим uniqueness check (отлавливает неоднозначные правки на ранней стадии).

### Desktop Commander

Сильные стороны:
- **`edit_block`** — surgical find/replace, показывает character-diff при near-miss (там где наш `edit_file` сказал бы EUNIQUE без объяснений);
- **`start_process` + `interact_with_process`** — persistent shell sessions (многошаговые PS/Python REPL);
- **`start_search`** — async grep с pagination для больших репо;
- **`read_multiple_files`** — batch read нескольких файлов одним вызовом;
- **process management** (`list_processes`, `kill_process`);
- **PDF и Excel** манипуляции.

### Filesystem MCP (`@modelcontextprotocol/server-filesystem`)

Архитектурно близок к DC — read/write/edit примитивы, без exec/process, без специальных safety-инвариантов. В этой сессии не использовался.

### Эвристика выбора

| Задача | Инструмент |
|---|---|
| Записать новый `prompts/<имя>.md` | winfs (атомарно) |
| Записать обновлённый `CLAUDE.md` целиком | winfs |
| Прочитать src-файл (один или несколько) | DC `read_multiple_files` |
| Surgical edit в существующем файле | DC `edit_block` (показывает char-diff при near-miss) |
| Удалить файл / kill процесс | DC `start_process` + PS |
| Find / grep по репо | DC `start_search` (pagination на большом репо) |
| Read / list мелочи | любой |

### Наша позиция в roadmap

winfs нацелен в долгосрочной перспективе **превзойти** DC и Filesystem MCP — иначе зачем мы его делаем. Сейчас (после v0.6) winfs впереди по безопасности и атомарности, но позади по эргономике (нет persistent shells, нет async grep с pagination, нет diff на near-miss).

**v0.7 — DC parity wave.** Цели: догнать DC по эргономике, сохранив все наши safety-инварианты. План в файле: `prompts/cc-prompt-mcp-winfs-v0.7-roadmap.md`.

После v0.7 переключение на winfs становится строго better deal — все удобства DC плюс наши защиты.
