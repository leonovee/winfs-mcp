# Build mcp-winfs v0.3 — Claude Code Prompt

## Контекст

Ты продолжаешь mcp-winfs с v0.2.0 (10 tools, hard-invariants pinned тестами, schema contract enforced). Цель v0.3 — добавить **search + self-recovery surface**: первый шаг к тому, чтобы Claude могла исследовать сама без shell.

**Источники истины:**

- `docs/design/mcp-winfs-spec.md` — спека (§4.3 grep/glob/read_json, §4.8 audit_tail, §5 error catalog, §7 phased delivery)
- `docs/v0.2-acceptance.md` "Open questions for v0.3" — 3 carryover items, см. ниже
- `docs/v0.2-backlog.md` — общий статус
- `docs/v0.1-acceptance.md` и `docs/v0.2-acceptance.md` — шаблон acceptance report

V1 SDK lock-in остаётся в силе (`@modelcontextprotocol/sdk@^1.29.0`, Zod v3). `src/core/tool_wrapper.ts` менять не нужно (v0.1.1 hotfix корректен, v0.2 это подтвердил).

## Scope v0.3

### Новые tools (4)

| Tool | Спека ref | Notes |
|---|---|---|
| `grep` | §4.3 | Regex-search по glob с context lines и max_matches. Output: `Array<{file, line, match, context_before?, context_after?}>` |
| `glob` | §4.3 | Find files matching glob pattern. Output: `Array<string>` (absolute paths), capped by `max_results` |
| `read_json` | §4.3 | Convenience: read + JSON.parse. Output: `{data, size_bytes}`. Distinct `EBADJSON` для parse errors |
| `audit_tail` | §4.8 | Read last N audit log entries для self-recovery. Output: `Array<{ts, tool, args_summary, result_status, error_code?, duration_ms}>` |

### v0.2 carryover items (3 — закрыть в v0.3 как часть scope)

Эти зафиксированы в `docs/v0.2-acceptance.md` "Open questions for v0.3":

1. **Cross-volume `move` opt-in fallback.** Добавить arg `allow_cross_volume: boolean` (default false) в `move`. Когда true и target на другом томе — выполняет `copy + delete` non-atomically, явно документирует в response (`{moved: true, atomic: false, src, dst}`). Тест: смоделировать EXDEV через mock fs (или skip если нет второго диска на test runner).

2. **`copy` symlink-skip telemetry в audit.** Когда `copy` skipped paths > 10 (cap response) — audit log должен записать полный count в `args_summary.files_skipped_total`. Сейчас audit видит только то что в response. Patch в `src/tools/fs/copy.ts` + `src/core/audit.ts`. Тест: synthetic tree с 15 bad symlinks → response показывает 10 + count=15, audit показывает 15.

3. **Spec amendment: `read_multiple_files` envelope.** Спека §4.3 говорит `Output: Array<...>`. Реальный v0.2 schema — `{files, total, ok_count, error_count}`. Добавь amendment в `docs/design/mcp-winfs-spec.md` formalizing envelope. Не код-change, doc-change. Пометь дату.

### Out of scope (v0.4+)

❌ `edit_file` с dry_run — v0.4
❌ `read_section`, `read_since`, `diff_files` — v0.4
❌ Git, Exec, System, Network — v0.5–v0.7

## Step 0 — Подготовка

Свежая CC сессия — подгрузи:
- `mcp_best_practices.md`
- `node_mcp_server.md`
- v1.x SDK README (если не в контексте)

Прочитай `docs/v0.2-acceptance.md` и `docs/v0.2-backlog.md` чтобы понять текущее state.

## Step 1 — Hard invariants новые для v0.3

К 14 уже зафиксированным (12 из спеки + 2 из v0.2 amendments) добавляются:

### grep

1. **Bounded execution.** `grep` ходит по файлам по glob — может быть медленно на больших деревьях. Default timeout = `config.defaultTimeoutMs` (10s), max = `config.maxTimeoutMs` (60s). При истечении — partial results + `truncated: true, reason: "timeout"`, НЕ throw.
2. **Per-file read через тот же allowed_roots check.** Каждый matched file — checked, EPERM_ROOT pre-filters до regex.
3. **Regex compilation in sandbox.** Pattern это user input. Если regex невалидный → `EINVAL` с сообщением парсера, не throw. Никаких eval/Function — только `new RegExp(pattern, flags)`.
4. **max_matches cap.** Default 50, hard cap 500 (предотвращает unbounded output). При cap — `truncated: true`.
5. **Context lines bounded.** Default 0, max 10 (per спеке). Никаких unbounded context window.

### glob

6. **max_results cap.** Default 200, hard cap 2000. Larger queries требуют переписать.
7. **No traversal escape.** Glob внутри allowed roots only. Pattern `..\..\windows\system32\*.dll` после resolve должен EPERM_ROOT.

### read_json

8. **EBADJSON distinct error code.** Parse errors возвращают `EBADJSON` с position info из парсера (`{code: "EBADJSON", message, details: {line, column, snippet}}`). Не путать с EIO.
9. **Size cap pre-check.** До `JSON.parse` — проверить `bytes_returned <= config.readMaxBytes`. Default 10MB. Большие JSON просят grep/streaming, не одношаговое чтение.

### audit_tail

10. **Privileged read of own audit log.** Path = `config.auditLogPath`, который обычно ВНЕ allowedRoots (LOCALAPPDATA). Это **legitimate exception** — пишется как explicit override в `src/tools/system/audit_tail.ts`, явно проверяется что path === resolved `auditLogPath`, любые другие пути → EPERM_ROOT. Не отдавать функционал "читай любой файл, если назовёшь его audit log".
11. **Read-only on audit log.** Никаких write/modify/rotate через этот tool. Только tail.
12. **n bounded.** Default 50, max 500 (per spec). Иначе при огромном audit log можно затопить context window.
13. **Self-deduplication safety.** При чтении audit_tail сам по себе пишет audit record. Чтобы не было бесконечной самоссылки — last record в output никогда не сам этот audit_tail call (можно тривиально: записать audit ПОСЛЕ чтения файла, не до).

### Cross-cutting

14. **Audit log получает полный `files_skipped_total`** на `copy` (carryover #2). Argument size still capped в audit redaction для других tool args.
15. **structuredContent contract для всех 4 новых tools.** Pure payload через тот же `tool_wrapper.ts`. Никаких envelope keys.

## Step 2 — Acceptance criteria для v0.3

### Сборка и тесты

- [ ] `npm run build` exit 0, ноль warnings
- [ ] `npm test` — все v0.2 тесты по-прежнему зелёные (84) + новые. Минимум 110+ tests total.
- [ ] `tests/invariants/structured_content.test.ts` расширен для 4 новых tools

### Per-tool unit tests

- `grep`: happy match, no-match (empty array, not error), regex compile error (EINVAL), timeout (mock long search), max_matches cap, context_before/after correctness, EPERM_ROOT on glob escape
- `glob`: happy match, no-match, max_results cap, EPERM_ROOT, malformed pattern (EINVAL)
- `read_json`: happy parse, invalid JSON (EBADJSON with position), large file (ETOOLARGE), EPERM_ROOT, ENOENT
- `audit_tail`: happy last N, n>file size (returns all available), n=0 (returns []), records correctly parsed, **EPERM_ROOT if path differs from configured auditLogPath** (red team test — fabricate request with auditLogPath = arbitrary file)

### Invariant tests

- Новый файл `tests/invariants/audit_tail_privileged.test.ts` — multiple attempts to read paths claiming to be audit log; only configured path resolves
- Расширить `tests/invariants/structured_content.test.ts` — 4 новых tool entries
- `tests/invariants/timeouts.test.ts` — добавить случай `grep` timeout с partial results

### Carryover items tests

- `tests/unit/fs/move.test.ts` — добавить case для `allow_cross_volume: true` (mock or skip)
- `tests/unit/fs/copy.test.ts` — добавить case для skipped > 10 → audit records full count
- Spec amendment — проверить через `winfs:read` что amendment появился

### Inspector smoke

```
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

- [ ] 14 tools видны (5 v0.1 + 5 v0.2 + 4 v0.3)
- [ ] Каждый новый tool happy path probe
- [ ] `audit_tail` red-team probe: попытка path выходящего за auditLogPath → EPERM_ROOT
- [ ] `grep` partial result probe: запустить с очень коротким `timeout_ms` (например 1ms) на большом дереве → `{matches, truncated: true, reason: "timeout"}`
- [ ] Schema validation чистая (нет additional properties warnings)

### Документация

- [ ] `CHANGELOG.md` — v0.3.0 entry. Включая 3 carryover items
- [ ] `README.md` — таблица tools (14 вместо 10), новая секция "Search tools" между v0.2 mutations и Hard invariants
- [ ] `docs/v0.3-acceptance.md` — новый, по шаблону v0.2
- [ ] `docs/v0.2-backlog.md` — strikethrough на закрытых items если ещё не сделано
- [ ] **Spec amendment** для `read_multiple_files` envelope (carryover #3) — добавь в spec amendment секцию

## Step 3 — Lessons learned из v0.1 и v0.2 (не повторять)

### 1. structuredContent pure payload с первой попытки

`tool_wrapper.ts` уже правильный. Каждый новый tool должен иметь `outputSchema` 1:1 с payload, без envelope-полей. Pin tests в `structured_content.test.ts`.

### 2. Audit flush race в test teardown

`tests/helpers.ts > cleanupTempConfig` должен `await flushAudit()` перед `fs.rm`. Иначе ENOTEMPTY на Windows при многих audit writes в tests (v0.2 поймал это на read_multiple_files + structured_content тестах).

`grep` и `audit_tail` тоже могут писать много audit'ов — особенно если test setup делает grep на большом deps tree. Прогон тестов с `--reporter verbose` поможет поймать race до commit'а.

### 3. Strict Zod config не любит `_comment`

Не добавлять comment-like fields в новые config sections (если grep будет требовать config fields типа `maxGrepResults` — добавляй без префиксов `_`).

### 4. MSIX node PATH

Уже в README troubleshooting. Не нужно повторять, но не сломай эту секцию при rewrite.

### 5. Both-roots check для mutation tools

Новый `move` опция `allow_cross_volume: true` — оба пути все равно через `checkAllowed`. Cross-volume не значит cross-sandbox. Если dst вне allowed roots — EPERM_ROOT даже с этим флагом.

## Step 4 — Workflow

Conventional commits, tight scoping:

1. Чтение спеки и backlog (если новая сессия).
2. Скаффолд `src/tools/search/` директории.
3. Per-tool: scaffold → impl → unit tests → commit `feat(tools): <tool_name>`.
4. Carryover #1 (allow_cross_volume) → commit `feat(move): cross-volume opt-in fallback`.
5. Carryover #2 (copy symlink telemetry) → commit `feat(copy,audit): full skip count in audit when response capped`.
6. Carryover #3 (spec amendment) → commit `docs(spec): read_multiple_files envelope amendment`.
7. New invariant test files → commit `test(invariants): audit_tail privileged read + grep timeout partial`.
8. Расширение structuredContent invariant → commit `test(invariants): v0.3 structured_content extensions`.
9. README + CHANGELOG + v0.3-acceptance.md → commit `docs: v0.3 readme, changelog, acceptance`.
10. Tag `v0.3.0`.
11. Hand-off operator для Inspector probes + 4 red-team probes ("чужой" путь в audit_tail, timeout in grep, malformed JSON, glob escape).

## Step 5 — Open Questions (заведи если возникнут)

Возможные неоднозначности:

- **`grep` regex flags surface.** Спека говорит `case_sensitive: boolean (default false)`. Это всё, что нужно exposed? Или также `multiline`, `dotall`? Рекомендация: только `case_sensitive` в v0.3 для minimal surface. Multiline можно через regex синтаксис самого pattern (`(?m)...`).
- **`glob` syntax.** Какие глоб-синтаксисы поддерживаем? Just `*`/`?`/`[...]` (minimatch / picomatch defaults)? Или brace expansion `{a,b}`? Рекомендация: picomatch defaults — `*`, `?`, `[...]`, `**` (recursive). Brace expansion опционально, document.
- **`read_json` для больших JSON.** ETOOLARGE при > readMaxBytes. Но JSON может быть валидным "большим" (10MB+ data dump). Альтернатива — `JSONPath`-like extraction. Это v0.4+, не блокер.
- **`audit_tail` filter by tool/status.** Спека ничего не говорит — только last N. Можно добавить `tool_filter?: string` и `status_filter?: "ok" | "error"`. Рекомендация: НЕ добавлять в v0.3, добавим если real use surfaces need.

Любую открывшуюся фиксируй amendment в спеке + Open Question в acceptance report.

## Готов?

Начни с скаффолда `src/tools/search/`. Порядок реализации (от простого к сложному):

1. `glob` — простейший, fast feedback loop
2. `read_json` — wrapper над `read`, error handling focus
3. `audit_tail` — privileged read, security focus
4. `grep` — самый сложный (timeout + partial results + per-file checks)
5. Carryover items
6. Documentation + invariants

Hand-off ко мне (Claude в чате) после build+tests ready, до Inspector probes — sanity check как в v0.1, v0.2.

Поехали.
