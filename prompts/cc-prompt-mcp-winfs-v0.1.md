# Build MCP-WinFS v0.1 — Claude Code Prompt

## Контекст

Ты строишь MCP-сервер `mcp-winfs` — универсальный инструмент для работы с файловой системой Windows 10/11 из Claude Desktop. Он заменяет нестабильную связку Desktop Commander + Filesystem MCP + windows-mcp.

**Полная спецификация:** `docs/design/mcp-winfs-spec.md` (29 инструментов, hard-инварианты, error catalog, структура проекта, win-specifics).

**Прочитай спеку целиком перед началом.** Это source of truth. Все архитектурные решения и инварианты — оттуда. Если найдёшь противоречие или пробел — fix не in-place в спеке, а через секцию `## Amendments` в её конце с датой и описанием.

## Scope этого захода: v0.1

Реализуй ТОЛЬКО v0.1 milestone из секции 7 спеки:

- **5 инструментов:** `read`, `write`, `append`, `list`, `stat`
- **Все hard-инварианты** из секции 2 спеки (даже если они затрагивают только 5 инструментов из 29 — реализуй полноценно, потому что v0.2+ будут опираться)
- **Полная инфраструктура core/** — config loader, allowed_roots, utf8, atomic_write, timeouts, errors, audit
- **Tests** — unit per tool + invariant tests из секции 9.2 спеки (те, что применимы к v0.1)

**НЕ реализуй в этом заходе:**
- Mutations (move/copy/mkdir) — будут v0.2
- Search/Edit/Slicing/Git/Exec/System/Network — v0.3+
- MCPB packaging — v1.0
- Plugin mechanism — после v1.0

## Acceptance criteria для v0.1

Перед тем как считать v0.1 готовым, должно выполняться:

1. **Build проходит:** `npm install && npm run build` без ошибок и warnings.
2. **Unit tests зелёные:** `npm test` — все per-tool тесты + invariant tests проходят.
3. **MCP Inspector тест:** `npx @modelcontextprotocol/inspector node dist/index.js --config configs/default.json` — Inspector подключается, видит 5 инструментов, каждый можно вызвать и получить валидный response.
4. **Real Claude Desktop тест:** добавить в `%APPDATA%\Claude\claude_desktop_config.json` (или MSIX path), перезапустить, в чате попросить:
   - "Прочитай `<реальный path>\session_log.md` — последние 50 строк" → `read` с `range`
   - "Что в директории `<path>`?" → `list`
   - "Создай тестовый файл с текстом 'Привет, мир' в `<path>`" → `write` с русским текстом
   - "Покажи метаданные `<path>`" → `stat`
   - "Допиши строку в файл" → `append`
5. **Allowed-roots работает:** попытка `read C:\Windows\System32\drivers\etc\hosts` (или любой path вне allowedRoots) → возвращает `EPERM_ROOT` со списком allowed_roots в hint.
6. **Timeout работает:** искусственный кейс (например, чтение огромного файла > readMaxBytes) → возвращает `ETOOLARGE` или `ETIMEDOUT` (в зависимости от того, что сработает первым), но **никогда не висит**.
7. **UTF-8 round-trip:** записать русский текст через `write`, прочитать через `read` — content идентичен, ни BOM, ни искажений кодировки.
8. **Realpath escape blocked:** создать junction `mklink /J C:\temp\evil C:\Windows`, добавить `C:\temp` в allowedRoots, попытаться `read C:\temp\evil\System32\license.rtf` → `EPERM_ROOT`.
9. **Audit log пишется:** после нескольких вызовов в `%LOCALAPPDATA%\mcp-winfs\audit.jsonl` появляются записи в формате из секции 2.11 спеки.

## Deliverable

В конце v0.1 я ожидаю получить:

1. **Git-репозиторий** с структурой из секции 6 спеки (но только реализованные на v0.1 части) + `evals/` skeleton
2. **README.md** с:
   - Install (npm install, npm run build)
   - Configure (как создать config.json, путь по умолчанию)
   - Setup в Claude Desktop (snippet с правильным `node` invocation, упоминание MSIX path issue)
   - Troubleshooting top-5 (UTF-8 BOM в конфиге, PATH issues, Node version, allowed-roots не работают, audit log не пишется)
3. **CHANGELOG.md** с записью v0.1
4. **Acceptance report** — короткий документ `docs/v0.1-acceptance.md` где для каждого acceptance criterion стоит ✅ + ссылка на test/screenshot/log который доказывает.
5. **Evals scaffolding** (НЕ полная eval suite — это для v1.0):
   - `evals/README.md` — описание подхода, как будем строить полные 10 вопросов к v1.0
   - `evals/v1.0-evaluation.xml` — 1-2 примера в правильном формате (placeholder для остальных)
   - `evals/connections.py` + `evals/requirements.txt` — runner infrastructure из mcp-builder skill scripts (скачать как есть)
6. **Quality checklist completion** — отдельный раздел в acceptance report где прошёл по quality checklist из `node_mcp_server.md` reference-файла и отметил каждый пункт.

## Workflow

0. **Загрузи обязательные reference-файлы ПЕРЕД любым кодингом.** Это требование из amendments 2026-05-16 в спеке. Используй WebFetch:

   - `https://raw.githubusercontent.com/anthropics/skills/main/mcp-builder/reference/mcp_best_practices.md`
   - `https://raw.githubusercontent.com/anthropics/skills/main/mcp-builder/reference/node_mcp_server.md`
   - `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md` (ветка `v1.x`, НЕ `main` — см. SDK lock-in ниже)
   - `https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x/examples` (stdio-server пример с v1.x)

   Извлеки из `node_mcp_server.md` quality checklist — он будет дополнительным gate перед тем как считать v0.1 готовым.

   **SDK target — V1 stable (lock-in от 2026-05-16).** Проверено на день написания: ветка `main` репозитория содержит V2 и помечена в README как "currently in development, pre-alpha". Latest stable релиз на npm — `@modelcontextprotocol/sdk@1.29.0` (2026-03-30). Maintainers явно рекомендуют v1.x для production. Это override предыдущего amendment'а "SDK V2: lock-in" — см. свежий amendment в спеке "SDK V1 stable lock-in". Runtime-verification через `npm view` НЕ нужна — фиксируем V1 детерминистически.

   `package.json` dependencies:
   ```json
   {
     "dependencies": {
       "@modelcontextprotocol/sdk": "^1.29.0",
       "zod": "^3.23.0",
       "simple-git": "^3.0.0"
     }
   }
   ```

   Imports (V1 паттерн):
   ```ts
   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
   import { z } from "zod";
   ```

   Конструктор V1: `new Server({name, version}, {capabilities: {tools: {}}})`.

   Tool registration в V1 — через `server.setRequestHandler(CallToolRequestSchema, ...)` плюс `ListToolsRequestSchema`. Если v1.29.0 даёт высокоуровневый хелпер (типа `server.tool(...)`) — используй его. Сверь с v1.x README, который только что подгрузил.

   Appendix A спеки описывает V2 API — оставляем как reference для будущей миграции, не используем сейчас. Создай в корне `MIGRATION.md` с одним TODO: «когда `npm view @modelcontextprotocol/server dist-tags` покажет `latest` на 2.x.x — отдельный sprint миграции на V2».

   При конфликте reference-файлов и спеки — спека выигрывает.

1. Прочитай `docs/design/mcp-winfs-spec.md` целиком **включая Amendments** (особенно про V2 SDK и Phase 4 evaluations). Если что-то непонятно — задавай вопросы ДО старта кодинга.
2. Создай scaffold: `package.json`, `tsconfig.json`, `src/index.ts`, `src/server.ts`, директории включая `evals/`. Закоммить `feat: project scaffold for v0.1`.
3. Реализуй `src/core/*` целиком. Закоммить `feat(core): hard invariants — allowed_roots, utf8, atomic_write, timeouts, errors, audit`.
4. Реализуй 5 инструментов по одному. После каждого: unit tests + закоммить `feat(tools): <tool_name>`.
5. Создай `evals/` skeleton — README, placeholder v1.0-evaluation.xml с 1-2 примерами в правильном формате, скопируй `connections.py` и `requirements.txt` из skill scripts. Закоммить `chore(evals): scaffolding for v1.0 evaluation suite`.
6. Прогон через MCP Inspector. Закоммить `test(integration): inspector smoke for v0.1`.
7. Прогон в реальном Claude Desktop. Зафиксируй результаты в `docs/v0.1-acceptance.md`. Закоммить `docs: v0.1 acceptance report`.
8. README + CHANGELOG. Закоммить `docs: v0.1 readme and changelog`.
9. Tag `v0.1.0`.

## Конвенции

- **TypeScript strict mode.** `strict: true` в tsconfig, никаких `any` без явного TODO-комментария.
- **Zod для всех input schemas.** Не sloppy `args: any`.
- **Никаких throws в tool handlers.** Все ошибки — через `errors.build(code, details)` → возвращаются как content в response.
- **Conventional Commits.** `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **PR-стиль коммитов даже если работаешь в main:** один логически завершённый шаг — один коммит. Большие коммиты на 20 файлов — нет.
- **No console.log в production code.** Только структурированный audit log.
- **Reference-файлы из skill'а — авторитетны по вопросам стиля и patterns.** При конфликте с моей спекой — спека выигрывает (она конкретнее под наш use case), но при пробеле или неоднозначности — reference.
- **Используй `structuredContent` в tool responses** (TypeScript SDK feature), не только `content: [{type: "text", ...}]`. Это позволяет Claude парсить structured output без JSON-парсинга текста.
- **Output schemas обязательны** для всех tools у которых не trivial возврат (read, list, stat, и далее по списку). Через `outputSchema` field при `registerTool`.

## Что делать если застрял

1. Если непонятно требование спеки — добавь в `## Open Questions` в спеке (через amendment) и спроси меня. НЕ делай по своему усмотрению.
2. Если win-specific квирк ломает план (например, какой-то API ведёт себя не так на Win10) — добавь в секцию 8 спеки через amendment, документируй workaround в коде комментарием.
3. Если acceptance criterion не выполняется и причина непонятна — стоп, не делай rabbit hole больше 30 минут. Зафиксируй симптом, спроси меня.

## Готов?

Начни с того, что прочитаешь полную спеку `docs/design/mcp-winfs-spec.md` и подтвердишь, что нет open questions перед стартом. Если есть — задай их одним сообщением, не по одному.

После моего ответа на вопросы (или подтверждения "вопросов нет") — стартуй с шага 2 (scaffold).
