# Build mcp-winfs v0.2 — Claude Code Prompt

## Контекст

Ты продолжаешь mcp-winfs с v0.1.1 (5 tools, hard-invariants, audit, structured_content hotfix). Цель v0.2 — добавить **mutations + batch read + introspection**, чтобы versioning workflow можно было делать без shell.

**Источники истины:**

- `docs/design/mcp-winfs-spec.md` — спека (особенно §4.2, §4.3 read_multiple_files, §4.9, §7 phased delivery, §5 error catalog)
- `docs/v0.2-backlog.md` — что закрыто из v0.1, что carried over
- `docs/v0.1-acceptance.md` — паттерн acceptance report, скопируй структуру для v0.2

V1 SDK lock-in остаётся в силе (`@modelcontextprotocol/sdk@^1.29.0`, Zod v3). Не пересматривать.

## Scope v0.2

### В scope

| Tool | Спека ref | Notes |
|---|---|---|
| `move` | §4.2 | src+dst оба в allowedRoots. Destructive (source исчезает). Возвращает `{moved, src, dst}` |
| `copy` | §4.2 | Файлы и директории. Recursive default. Возвращает `{copied, bytes_copied, files_copied}` |
| `mkdir` | §4.2 | Recursive default. `EEXIST` если `recursive=false` и существует |
| `read_multiple_files` | §4.3 | Batch read. Per-file результат, ошибка одного НЕ блокирует остальные. Range применяется ко всем |
| `list_allowed_directories` | §4.9 | Empty input, возвращает `{allowed_roots, allowed_url_hosts}`. Self-orientation для Claude |

### Out of scope (v0.3+)

❌ Search: `grep`, `glob`, `read_json` — v0.3
❌ Editor: `edit_file` — v0.4
❌ Slicing: `read_section`, `read_since`, `diff_files` — v0.4
❌ Git/Exec/System/Network — v0.5–v0.7

## Step 0 — Подготовка (короче чем в v0.1)

Эти reference уже подгружались для v0.1, не подгружай заново если контекст в свежей сессии. Если новая сессия:

- `mcp_best_practices.md`
- `node_mcp_server.md`
- v1.x README (`https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md`)

Прочитай `docs/v0.2-backlog.md` и `docs/v0.1-acceptance.md` чтобы понять что уже стоит, что отложено.

## Step 1 — Hard invariants специфичные для v0.2

Эти инварианты прибавляются к 12 из спеки §2 — пинить тестами.

### Mutation tools (move, copy, mkdir)

1. **Both-roots check для move/copy.** ОБА пути (src и dst) должны быть в allowedRoots после realpath. Не достаточно проверить только один. Тест: src в allowed, dst вне → `EPERM_ROOT` с обоими путями в details.
2. **No overwrite by default.** `move` и `copy` с `overwrite: false` (default) → `EEXIST` если dst существует. С `overwrite: true` — заменяют.
3. **Atomic move на одном томе.** `fs.rename` атомарен внутри одного NTFS-тома. Cross-volume `rename` упадёт с `EXDEV` — для v0.2 это OK, документируй (cross-volume = v0.3 job, как copy+delete fallback).
4. **Recursive copy не следует symlinks.** Подобие realpath check для каждого entry — если внутри source tree есть symlink на что-то вне allowedRoots, скипай или возвращай ошибку с конкретным path. Решение твоё, документируй.
5. **mkdir с recursive=true идемпотентен.** Повторный вызов на существующей директории → `{created: false, path}`, не ошибка. Если recursive=false и существует — `EEXIST`.

### read_multiple_files

6. **Per-file isolation.** Ошибка чтения одного файла не должна влиять на остальные. Структура output: `[{path, content?, error?}, ...]` — успешные имеют `content`, проваленные имеют `error: {code, message}`. Не throw, не isError на уровне всего вызова.
7. **Все paths проверяются через allowed_roots** независимо — нельзя позволить одному "хорошему" пути обмануть остальные.

### list_allowed_directories

8. **Read-only самоописание.** Никакой mutation, никакого file system access. Просто отдаёт текущий config (только `allowedRoots` + `allowedUrlHosts`, не весь конфиг — никаких timeouts, blocklists и т.д., чтобы не утекало внутреннее устройство).
9. **`structuredContent` правильной формы.** Применять hotfix-pattern из `tool_wrapper.ts` — pure payload, никаких envelope-полей. Тесты в `tests/invariants/structured_content.test.ts` должны покрыть все 5 новых tools.

## Step 2 — Acceptance criteria для v0.2

### Сборка и тесты

- [ ] `npm run build` — exit 0, ноль warnings
- [ ] `npm test` — все v0.1 тесты по-прежнему зелёные (48) + новые. Минимум 60+ tests total.
- [ ] `tests/invariants/structured_content.test.ts` расширен: pure payload check для каждого из 5 новых tools

### Per-tool unit tests (минимум)

- `move`: happy path, EPERM_ROOT (src outside), EPERM_ROOT (dst outside), EEXIST, ENOENT (src), cross-volume EXDEV
- `copy`: happy file, happy dir recursive, EPERM_ROOT, EEXIST, ENOENT
- `mkdir`: happy single, happy recursive, idempotent on existing, EEXIST when recursive=false
- `read_multiple_files`: all-good, mixed (1 ok + 1 ENOENT + 1 EPERM_ROOT), all-bad
- `list_allowed_directories`: returns config, structuredContent pure (no extra keys)

### Invariant tests

- `tests/invariants/both_roots.test.ts` — новый файл. src+dst combinations для move/copy.
- Расширить `tests/invariants/allowed_roots.test.ts` — добавить proof что mkdir на путь вне allowed → EPERM_ROOT, не silent create.

### Inspector smoke

```
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

- [ ] Все 10 tools видны (5 v0.1 + 5 v0.2)
- [ ] Каждый из новых отрабатывает happy path
- [ ] Schema validation чистая (нет warnings о additional properties)

### Claude Desktop probes

После Inspector — отдай мне (operator), я прогоняю 5 проб через UI. Кейсы:

1. "Создай директорию `<allowedRoot>\test-v02\nested`" → `mkdir` recursive
2. "Переименуй `test-cyrillic.txt` в `archived.txt`" → `move`
3. "Скопируй `archived.txt` в `archived.backup.txt`" → `copy`
4. "Прочитай разом `README.md`, `CHANGELOG.md`, `package.json`" → `read_multiple_files`
5. "Какие директории мне сейчас разрешены?" → `list_allowed_directories`

### Документация

- [ ] `CHANGELOG.md` — секция v0.2.0 с per-tool кратким описанием и breaking changes (если есть)
- [ ] `README.md` — обновить таблицу tools (10 вместо 5), добавить v0.1.1 troubleshooting carryover из v0.1-acceptance §4 (MSIX `node.exe` absolute path + `configs/local.json` workflow)
- [ ] `docs/v0.2-acceptance.md` — новый файл, шаблон из v0.1-acceptance, заполни per criterion
- [ ] `docs/v0.2-backlog.md` — обнови struck-through статусы по закрытым carryover'ам

## Step 3 — Lessons learned из v0.1 (НЕ повторять)

### 1. Schema validation strict с самого начала

v0.1 шипал tools с envelope-полями (`ok`, `tool`, `hint`) в `structuredContent`, что не матчилось с `outputSchema`. Inspector только warning'овал, но Claude Desktop strict-валидировал и марил успешные вызовы как failed.

**Для v0.2:** каждый новый tool должен с первой попытки иметь `structuredContent` равный pure payload, описанному в `outputSchema`. Тест `structured_content.test.ts` поймает регресс.

Используй обновлённый `tool_wrapper.ts` из v0.1.1 — он уже правильный.

### 2. Strict Zod config не любит `_comment`

Это всё ещё в силе. Если будешь расширять config schema (например, для новых v0.2 features), не добавляй comment-like fields — JSON не поддерживает, схема режет. Если очень надо документировать конфиг — отдельный markdown в `configs/README.md`.

### 3. MSIX node PATH

В readme-troubleshooting (Step 2 deliverables выше) явно прописать что MSIX-установка Claude Desktop требует абсолютного пути к `node.exe` в `claude_desktop_config.json`. Это сэкономит следующему пользователю час.

### 4. configs/local.json gitignored

Уже сделано в .gitignore. Не коммитить.

## Step 4 — Workflow

Тот же что в v0.1, conventional commits:

1. Чтение спеки и backlog (если в свежей сессии).
2. Per-tool: scaffold → impl → unit tests → invariant tests → commit `feat(tools): <tool_name>`.
3. После всех 5 tools: integration sweep через Inspector. Commit `test(integration): v0.2 inspector smoke`.
4. README + CHANGELOG + v0.2-acceptance.md. Commit `docs: v0.2 readme, changelog, acceptance`.
5. Tag `v0.2.0`.
6. Hand-off operator (мне) для acceptance #4 Claude Desktop probes.

## Step 5 — Open Questions (заведи если возникнут)

Возможные неоднозначности в спеке:

- **Cross-volume move.** Спека не уточняет — fail-fast с `EXDEV` или transparent copy+delete fallback? Моя рекомендация: v0.2 fail-fast, fallback в v0.3 (или явный flag `allow_cross_volume: boolean`).
- **Copy of broken symlinks.** Если в source tree висит dangling symlink — копировать link as-is, копировать target, или error? Рекомендация: skip + warning в результирующий counter, документировать.
- **read_multiple_files concurrency.** Sequential или Promise.all? Спека молчит. Sequential безопаснее для timeout-budgeting (общий timeout vs per-file timeout), но Promise.all быстрее. Рекомендация: Promise.all с per-file timeout = config.defaultTimeoutMs.
- **list_allowed_directories output shape.** Спека: `{allowed_roots, allowed_url_hosts}`. Стоит ли отдавать также `auditLogPath` для self-orientation, или это утечка? Рекомендация: не отдавать, минимизировать surface.

Любую открывшуюся неоднозначность фиксируй amendment'ом в спеке + Open Question в acceptance report.

## Готов?

Начни с краткой проверки backlog'а и acceptance.md — подтверди что нет blockers с v0.1.1, потом scaffold первого инструмента (рекомендую `list_allowed_directories` — самый простой, разогрев под pattern, потом mkdir, потом move, потом copy, потом read_multiple_files). После каждого: commit.

Поехали.
