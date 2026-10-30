# PMI — Phase 1: аудит Memorix

- Upstream: `https://github.com/AVIDS2/memorix` (remote `upstream`), коммит `ab94cca`, версия `1.10.2`, лицензия Apache‑2.0.
- Рабочая ветка: `pmi/phase-1-audit`.
- Дата аудита: 2026‑10‑31.
- Метод: чтение исходного кода (`src/`, `packages/`, `tests/`), сверка с документацией, сборка и полный прогон тестов. Выводы о поведении подтверждены ссылками на код; утверждения только из README помечены как UNVERIFIED.

Статусы: **IMPLEMENTED** — есть и подтверждено кодом; **PARTIAL** — частично; **MISSING** — отсутствует; **BROKEN** — есть, но работает некорректно для целевого сценария; **UNVERIFIED** — подтвердить нельзя.

---

## 0. Базовая линия (baseline)

| Проверка | Результат |
|---|---|
| Стек | TypeScript (ESM), Node ≥ 22.18, tsup, vitest. ~99 000 строк в `src/`, 357 тестовых файлов. |
| `npm ci` | OK |
| `tsc --noEmit` до сборки | 2 ошибки: `src/media/minimax.ts` импортирует workspace‑пакет `@memorix/ai`, который требует предварительной сборки. После `npm run build` — 0 ошибок. |
| `vitest run` до сборки | 3213 passed / 15 failed / 19 skipped. Все 15 падений — тесты, которым нужен собранный `dist/` или `@memorix/ai`. |
| `vitest run` после `npm run build` (упавшие файлы) | 107 passed / 1 failed. Оставшееся падение — `tests/git/extractor.test.ts` ожидает remote `origin` с именем `*/memorix`; в форке remote переименован в `upstream`, а каталог называется `pmi`. Это не баг кода, но подтверждает зависимость идентичности проекта от `origin` (см. §11). |

Побочный эффект прогона: `tests/memory/reindex-embeddings.test.ts` и `tests/memory/prepare-search-index.test.ts` используют Windows‑путь `E:/tmp/project` и на macOS/Linux создают в корне репозитория каталог `E:/tmp/project/memorix.db`. Исправить в Phase 3.

Вывод: кодовая база в рабочем состоянии, тестовое покрытие плотное. Это сильный аргумент против переписывания.

---

## 1. Текущая архитектура

Memorix — **local‑first однопользовательский MCP‑сервер памяти** для coding‑агентов. Один процесс Node на машине, одна SQLite‑база на машину.

```
Agent (Claude Code, Codex, Cursor, …)
   │  MCP stdio  (memorix serve)            ─┐
   │  MCP HTTP   (memorix serve-http :3211)  │  src/server.ts — 49 MCP‑инструментов
   │  Hooks      (memorix hook <event>)      │  src/hooks/*  — захват событий агента
   │  CLI        (memorix …)                 │  src/cli/*    — ~60 команд
   ▼                                        ─┘
Ядро памяти: src/memory/* (observations, sessions, formation, retention, dedup, graph)
Контекст:    src/knowledge/workset.ts, src/codegraph/*, src/compact/*
Хранилище:   ~/.memorix/data/memorix.db (SQLite, better-sqlite3 → node:sqlite → bun:sqlite)
             + Orama in‑memory индекс + опциональный LanceDB для векторов
Синк:        src/sync/* — опциональная репликация observations через fs/GitHub/S3/Postgres
Dashboard:   src/dashboard/* — статический SPA + JSON API поверх того же процесса
```

Ключевые свойства, подтверждённые кодом:

- **Одна база на машину**, а не на проект: `getProjectDataDir()` игнорирует `projectId` и возвращает общий каталог (`src/store/persistence.ts:60`). `projectId` — это колонка, а не граница хранения.
- **Идентичность проекта** — `owner/repo` из `git remote get-url origin` (`src/project/detector.ts:165`), с fallback `local/<dirname>` и реестром алиасов (`src/project/aliases.ts`).
- **Нет понятия пользователя.** Есть только «agent identity» (`team_agents`), которая создаётся явно через `team_manage join`.

## 2. Основные компоненты

| Модуль | Назначение | Объём | Оценка для PMI |
|---|---|---|---|
| `src/server.ts` | Регистрация 49 MCP‑инструментов | 5 888 строк | Ядро MCP, сохранить; монолит нужно разрезать |
| `src/memory/` | Observations, сессии, formation pipeline, retention, dedup, графовый контекст, secret‑filter | ~8 000 | Ядро, сохранить |
| `src/store/` | SQLite‑схема, миграции, Orama, FTS5, file‑lock | ~6 900 | Сохранить как локальный слой |
| `src/knowledge/` | Workset (контекст), claims, task‑continuity, knowledge workspace/wiki, workflows | ~5 700 | Workset и continuity — сохранить; wiki/workflows — пересмотреть |
| `src/codegraph/` | Индекс файлов/символов, task‑lens, project context | ~6 400 | Сохранить (основа L1/L2) |
| `src/compact/` | Индекс/таймлайн/детали, token budget | ~1 000 | Сохранить |
| `src/search/`, `src/embedding/`, `src/rerank/` | BM25 + опциональные эмбеддинги + LanceDB + rerank | ~3 500 | Сохранить; центральная сторона → pgvector |
| `src/hooks/` | Нормализация хуков 15+ агентов, фильтры значимости | ~4 800 | Сохранить |
| `src/git/` | Извлечение знаний из коммита, post‑commit hook | ~540 | Сохранить и развить |
| `src/sync/` | Репликация observations (LWW, журнал, курсоры) | ~1 900 | Сохранить как основу offline‑sync |
| `src/team/` | Агенты, задачи, сообщения, file locks, handoff‑артефакт | ~1 650 | Переработать под users/RBAC |
| `src/workspace/` | Установка MCP‑конфигов в 18 агентов | ~2 000 | Сохранить (мульти‑агентность) |
| `src/rules/` | Синхронизация rules‑файлов между агентами | ~1 100 | Пересмотреть (не Project Memory) |
| `src/orchestrate/` | Собственный оркестратор: запускает claude/codex/gemini/opencode как воркеры | ~4 900 | Кандидат на удаление |
| `src/media/`, `src/multimodal/` | MiniMax image/audio/video генерация, PDF, ingest картинок | ~3 000 | Кандидат на удаление |
| `src/cli/tui/` + `packages/{memcode,ai,agent-core,tui}` | Собственный терминальный coding‑агент memcode и его TUI | ~5 000 + 11 МБ пакетов | Кандидат на удаление |
| `src/dashboard/` | Веб‑дашборд (vanilla JS) | ~9 400 | Сохранить временно; заменить в Phase 10 |
| `src/runtime/` | Фоновые maintenance‑задачи, backfill векторов | ~2 300 | Сохранить |
| `vendor/opencode`, `vendor/pi` | git submodules для memcode | — | Удалить вместе с memcode |

## 3. Структура хранения данных

SQLite `memorix.db`, 45+ таблиц (`src/store/sqlite-db.ts`). Миграции — смесь идемпотентных `ALTER TABLE … ADD COLUMN` в try/catch и трекаемой таблицы `schema_migrations`.

Сгруппировано по назначению:

| Группа | Таблицы | Комментарий |
|---|---|---|
| Память (основная) | `observations`, `sync_row_state` | Главная сущность. Поля: id (INTEGER, локальный), projectId, entityName, type (11 типов), title, narrative, facts, filesModified, concepts, topicKey, revisionCount, sessionId, status (active/resolved/archived), source (agent/git/manual), commitHash, relatedCommits, relatedEntities, admissionState, visibility, createdByAgentId, writeGeneration |
| Параллельные модели знаний | `long_term_memories` (+evidence/events), `knowledge_claims` (+evidence/events), `mini_skills`, `graph_entities`/`graph_relations`, `knowledge_pages`/`knowledge_proposals`, `evidence_cards` | **Шесть** разных представлений «знания» с собственными жизненными циклами — главный источник дублирования |
| Сессии | `sessions` (id, projectId, startedAt, endedAt, status active/completed, summary, agent), `compaction_checkpoints`, `chat_transcript` | Минимальная модель сессии |
| Непрерывность задач | `task_continuity_events` | Append‑only журнал: task/requirement/decision/verification/risk/outcome |
| Команда | `team_agents`, `team_roles`, `team_tasks`, `team_task_deps`, `team_messages`, `team_locks` | Агентная координация в пределах одной машины/процесса |
| Code graph | `code_files`, `code_symbols`, `code_edges`, `observation_code_refs`, `code_state_snapshots(+_files)` | Снимки — это **метаданные** файлов (hash/size), не содержимое |
| Обратная связь | `memory_feedback_states/events`, `memory_outcome_signals` | Весовая модель полезности памяти |
| Медиа | `media_assets/links/derivations/embeddings/jobs/embedding_profiles` | Не относится к Project Memory |
| Служебные | `meta`, `schema_migrations`, `maintenance_jobs/targets`, `mcp_bindings`, `agent_effects` | |

Индексы поиска: Orama (in‑memory, BM25 + опционально векторы), FTS5, LanceDB (опционально). Эмбеддинги по умолчанию **выключены** (`MEMORIX_EMBEDDING=off`, `src/embedding/provider.ts:9`).

## 4. Возможности MCP

49 инструментов зарегистрировано в `src/server.ts`, видимость управляется профилем (`src/server/tool-profile.ts`): `micro` (stdio по умолчанию, 9 инструментов), `lite`, `team` (HTTP по умолчанию), `full`.

Сопоставление с требуемым набором PMI (§11 ТЗ):

| Требуемый инструмент | Ближайший существующий | Статус |
|---|---|---|
| `project_overview` | `memorix_project_context` (task‑lensed brief) | PARTIAL — есть brief, нет отдельного L1‑обзора |
| `project_status` | `memorix_codegraph_status`, `memorix_dashboard` | PARTIAL |
| `memory_search` | `memorix_search` | IMPLEMENTED |
| `memory_get` | `memorix_detail` | IMPLEMENTED |
| `memory_save` | `memorix_store`, `memorix_store_reasoning` | IMPLEMENTED |
| `memory_update` | upsert по `topicKey` в `memorix_store`; `memorix_resolve` | PARTIAL — нет явного update по id, нет истории версий |
| `memory_conflicts` | `knowledge_claims` (conflictKey, status `disputed`) — только для claims, не для observations | PARTIAL |
| `decision_log` | `type=decision` в observations + `memorix_continuity` (kind `decision`) | PARTIAL — нет отдельного ADR‑журнала |
| `session_start` | `memorix_session_start` | PARTIAL — см. §7 |
| `session_checkpoint` | `memorix_compaction_checkpoint` — только для pre/post compact | PARTIAL |
| `session_finish` | `memorix_session_end` | IMPLEMENTED (минимально) |
| `session_handoff` | `memorix_handoff` — создаёт observation‑заметку для агента | PARTIAL |
| `session_resume` | `memorix_session_context` / `memorix resume` (CLI) — общий brief по проекту, не по конкретной сессии | PARTIAL |
| `session_list` | — (только CLI `memorix session context`, HTTP `/api/sessions`) | MISSING (MCP) |
| `workspace_snapshot` | — | MISSING |
| `workspace_restore` | — | MISSING |
| `git_analyze` | CLI `memorix ingest commit`; MCP‑инструмента нет | PARTIAL |
| `project_sync` | CLI `memorix sync store push/pull`; MCP‑инструмента нет | PARTIAL |
| `context_build` | `memorix_context_pack`, `memorix_project_context` | IMPLEMENTED |

Дополнительно существуют: совместимость с официальным MCP Memory Server (`create_entities`, `read_graph`, … — 9 инструментов), `memorix_rules_sync`, `memorix_workspace_sync`, `memorix_skills`, `memorix_promote`, `memorix_media`, `memorix_ingest_image`, `team_*`, `memorix_poll`, `memorix_feedback`, `memorix_evidence`, `memorix_retention`, `memorix_transfer`, `memorix_timeline`, `memorix_graph_context`, `memorix_knowledge`.

Транспорт: stdio через `@modelcontextprotocol/sdk` 1.x и HTTP (Streamable HTTP) через `@modelcontextprotocol/server` 2.x с bridge (`src/server/modern-mcp-bridge.ts`). Оба поддержаны тестами (`scripts/mcp-*-smoke.mjs`).

## 5. Возможности CLI

`src/cli/index.ts` — около 60 подкоманд на `citty`. Релевантные PMI:

| Команда | Действия | Оценка |
|---|---|---|
| `memorix session` | `start`, `end`, `context` | Нет `list`, `resume <id>`, `handoff`, `checkpoint` |
| `memorix resume` | Алиас `context --resume`: общий brief проекта | Не возобновляет конкретную сессию |
| `memorix handoff send` | Создаёт observation‑handoff от агента к агенту; требует team identity | Не сохраняет состояние/workspace |
| `memorix checkpoint` | `list/show/context/archive` — только compaction checkpoints | Ручного checkpoint нет |
| `memorix continuity` | Журнал задачи: requirement/decision/verification/risk/outcome | Хорошая основа для Session State |
| `memorix memory` | search/store/detail/timeline/resolve/dedup/consolidate/long‑term … | Сохранить |
| `memorix context` | Memory Autopilot brief | Сохранить |
| `memorix ingest commit/log/image` | Git → memory | Сохранить (image — удалить) |
| `memorix git-hook` / `git-hook-uninstall` | post‑commit hook | Сохранить |
| `memorix sync store push/pull/status` | Репликация | Сохранить |
| `memorix sync rules/workspace` | Rules/MCP‑конфиги | Пересмотреть |
| `memorix team/task/message/lock/poll` | Агентная координация | Переработать |
| `memorix orchestrate` | Запуск агентов‑воркеров | Удалить |
| `memorix media` | Генерация медиа | Удалить |
| `memorix` (без аргументов), `memcode` | TUI coding‑агент | Удалить |
| `memorix serve`, `serve-http`, `background` | Серверы | Сохранить |
| `memorix setup/init/integrate/hooks/doctor/repair/uninstall` | Установка в агентов | Сохранить |

Имя бинаря `pmi` отсутствует.

## 6. Git Integration

| Требование | Статус | Доказательство |
|---|---|---|
| Ingest одного коммита (hash, author, subject, body, numstat, diff‑фрагмент) | IMPLEMENTED | `src/git/extractor.ts:getCommitInfo` |
| post‑commit hook | IMPLEMENTED | `src/cli/commands/git-hook-install.ts`, вызывает `memorix ingest commit --auto` |
| Шумовой фильтр (lockfiles, merge, bump) | IMPLEMENTED | `src/git/noise-filter.ts` |
| Разделение added/modified/deleted файлов | MISSING | используется `--numstat` без `--name-status` |
| Parent commit | MISSING | не извлекается |
| Классификация изменений (архитектура, API, зависимости, бизнес‑логика, удаление функционала) | PARTIAL | `inferType()` — регэкспы по subject/body; diff ограничен 500 символами |
| Обновление связанных знаний при изменении файлов | PARTIAL | `codegraph` переиндексирует изменённые файлы и помечает stale‑ссылки (`src/codegraph/freshness.ts`); существующие observations не пересматриваются |
| Инкрементальность (только новые коммиты с последнего обработанного) | PARTIAL | hook обрабатывает HEAD; курсора «последний проанализированный коммит» нет — пропущенные коммиты (rebase, pull, hook не установлен) не догоняются |
| Периодическая полная сверка | PARTIAL | `memorix ingest log` (≤100 коммитов), `codegraph` refresh |

## 7. Session Management

| Требование PMI | Статус | Комментарий |
|---|---|---|
| Session ID, Project ID, Agent | IMPLEMENTED | `sessions` |
| User ID, Model Provider | MISSING | |
| Current Task / Objective / Progress / Completed & Pending Steps | PARTIAL | есть в `task_continuity_events`, но **не связано с сессией** (связь только по `taskId`) |
| Decisions / Observations / Problems | PARTIAL | observations имеют `sessionId`; decisions/risks — в continuity |
| Modified Files | PARTIAL | `filesModified` в observations; агрегата по сессии нет |
| Git Branch / Last Commit / Uncommitted Changes | MISSING | |
| Workspace Snapshot | MISSING | |
| Next Action | MISSING | |
| Last Checkpoint | PARTIAL | только compaction checkpoints |
| Статусы CREATED … FAILED | MISSING | только `active` / `completed` |
| **Параллельные сессии в одном проекте** | **BROKEN** | `startSession()` делает «atomic rollover»: закрывает **все** активные сессии проекта (`src/memory/session.ts:468`). Второй разработчик/агент, начавший сессию, молча завершает сессию первого. Прямо противоречит TEST 7. |

### Automatic Checkpointing

| Требование | Статус | Комментарий |
|---|---|---|
| Периодическое сохранение | MISSING | |
| После существенных изменений | PARTIAL | hooks `post_tool` пишут observations, если агент поддерживает хуки и событие прошло фильтр значимости |
| После важных решений | PARTIAL | только если агент сам вызвал `memorix_store` |
| После Git‑коммита | PARTIAL | post‑commit hook пишет observation, но не checkpoint сессии |
| При завершении процесса | PARTIAL | hook `session_end` (`src/hooks/handler.ts:536`) — только у агентов с таким хуком; при обрыве по лимиту не срабатывает |
| Восстановление после аварии | MISSING | |
| Независимость от хуков агента | MISSING | всё сохранение инициируется либо агентом, либо его хуками |

## 8. Handoff и Recovery

| Требование | Статус | Комментарий |
|---|---|---|
| `pmi session handoff` | MISSING | `memorix handoff send` — только текстовая заметка (`src/team/handoff.ts`) с summary/context, требует team identity |
| Сохранение незакоммиченных изменений | MISSING | нигде в `src/` нет `git stash`, `git diff --binary`, `git apply` |
| Handoff Brief | PARTIAL | `renderSessionResumeCard()` (`src/memory/session.ts:358`) — brief по проекту, а не по сессии |
| Определение следующего шага | MISSING | |
| Освобождение сессии | MISSING | |
| `pmi session list` | MISSING (CLI) | данные есть (`listSessions()`), команды нет |
| `pmi session resume <id>` | MISSING | `memorix resume` не принимает id сессии |
| Compaction continuity (контекст переживает /compact) | IMPLEMENTED | `compaction_checkpoints`, `memorix checkpoint context` |

## 9. Синхронизация между устройствами

| Требование | Статус | Комментарий |
|---|---|---|
| Локальный SQLite как основное хранилище | IMPLEMENTED | |
| Репликация observations | IMPLEMENTED | `src/sync/engine.ts` — журнал изменений, per‑row Lamport `(revision, writer)`, LWW, tombstones, курсоры, очередь неотправленных батчей, тесты сходимости |
| Бэкенды | IMPLEMENTED | fs, GitHub, S3, Postgres (`src/sync/remote-factory.ts`) |
| Postgres как реальное хранилище | PARTIAL | Postgres используется только как **relay батчей** (`memorix_sync_batches(payload jsonb)`), не как запрашиваемая БД. Драйвер `pg` **не объявлен в зависимостях** (`node_modules/pg` отсутствует) — провайдер `postgres` упадёт без ручной установки |
| Синхронизация сессий, continuity, решений, claims, long‑term | MISSING | `syncEligibility()` пропускает только `observations` с `visibility=project` |
| Автоматическая синхронизация | MISSING | только вручную `memorix sync store push/pull` |
| Работа офлайн | IMPLEMENTED | синк вне горячего пути; при недоступности remote локальная работа не затрагивается |
| Обнаружение клонированного каталога данных | IMPLEMENTED | `assertCanPublish()/rotateDevice()` |

## 10. Механизмы командной работы

| Требование | Статус | Комментарий |
|---|---|---|
| Пользователи / организации / команды | MISSING | `TEAM.md` прямо говорит: «NOT an organization backend» |
| Аутентификация | PARTIAL | один общий Bearer‑токен `MEMORIX_HTTP_AUTH_TOKEN` на весь HTTP‑сервер (`serve-http.ts:97‑115`); нет идентичности вызывающего |
| RBAC | MISSING | `team_roles` — роли агентов для маршрутизации задач, не права доступа |
| Изоляция проектов | PARTIAL | фильтрация по `projectId` в запросах; физически одна база; HTTP‑клиент с токеном может переключиться на любой проект (`/api/set-current-project`) |
| Видимость записей | IMPLEMENTED | `visibility` personal/project/team + `sharedWithAgentIds` (`src/memory/visibility.ts`) |
| Задачи, зависимости, сообщения | IMPLEMENTED (локально) | `team_tasks`, `team_task_deps`, `team_messages` |
| Блокировки файлов | IMPLEMENTED (локально) | `team_locks` с TTL; работают только в пределах одной базы |
| Аудит операций | MISSING | `src/audit/index.ts` — журнал **файлов, записанных установщиком** (для uninstall), не аудит действий |

## 11. Ограничения текущей архитектуры

1. **Однопользовательская модель.** Нет User/Org/Team, нет per‑user аутентификации и RBAC. Добавление этого — не надстройка, а новая ось во всех запросах.
2. **Одна SQLite на машину.** Центрального запрашиваемого хранилища нет; Postgres — только транспорт батчей.
3. **Синхронизируется только один тип сущности** (observations). Сессии, continuity, claims, long‑term memories, code graph — локальны.
4. **Сессия — тонкая запись.** Нет состояния задачи, git‑состояния, next action; continuity‑журнал не привязан к сессии.
5. **Одна активная сессия на проект** — rollover убивает параллельную работу.
6. **Нет переноса реальных изменений рабочей копии.**
7. **Сохранение зависит от агента/хуков.** При обрыве по лимиту теряется всё, что агент не успел записать.
8. **Шесть параллельных моделей знаний** (observations, long‑term memories, claims, mini‑skills, KG entities, knowledge pages) с разными статусами. Нет единой модели `confidence` (Observed/Inferred/Proposed/Confirmed/Deprecated).
9. **Нет истории версий записи.** `topicKey`‑upsert перезаписывает observation и увеличивает `revisionCount`; прошлое содержимое теряется (claims и long‑term ведут events, observations — нет).
10. **Идентичность проекта завязана на remote `origin`.** Форк или другой remote меняют `projectId` (подтверждено падением теста в baseline). Для мульти‑репо и мульти‑разработчика нужна явная регистрация проекта на сервере.
11. **Монолиты:** `src/server.ts` (5 888 строк), `serve-http.ts` (2 328), `dashboard/static/app.js` (4 043).
12. **Объём не относящейся к PMI функциональности**: собственный coding‑агент (memcode + 4 workspace‑пакета + 2 submodule), оркестратор агентов, генерация медиа.
13. **Метрики токенов** — частичные: `BoundedContextReceipt` считает токены brief‑а, `orchestrate/cost-tracker.ts` — стоимость воркеров; сводных метрик экономии нет.

## 12. Необходимые изменения (сводно, детализация — в Phase 2)

| # | Изменение | Phase |
|---|---|---|
| 1 | Удалить memcode/TUI/orchestrate/media и связанные зависимости; разрезать `server.ts` по доменам | 3 |
| 2 | Центральный PMI Server: Postgres (+pgvector) как основное хранилище, REST API + MCP HTTP; SQLite остаётся локальным кэшем | 4 |
| 3 | Расширить sync с одной сущности до набора (memory, sessions, checkpoints, continuity, decisions, snapshots‑метаданные); автоматический фоновый sync с outbox | 4 |
| 4 | Organization/User/Team/Project/Repository, per‑user токены, RBAC, аудит‑журнал | 5 |
| 5 | Унифицированная запись Project Memory: категории, `confidence`, `version`, история версий, связи; миграция observations без потери данных | 4–5 |
| 6 | Session State (полная модель), статусы, параллельные сессии вместо rollover, локальный daemon‑checkpointer, независимый от хуков | 6 |
| 7 | `pmi session handoff/list/resume`, Handoff Brief, захват/освобождение сессии | 6 |
| 8 | Workspace Snapshots: patch + бинарные файлы + untracked, хэши, проверка base commit, восстановление в отдельный worktree, без перезаписи | 7 |
| 9 | Context Engine L1/L2/L3 поверх существующего Workset; hybrid search на сервере | 8 |
| 10 | Git Intelligence: курсор последнего обработанного коммита, name‑status, parent, классификаторы, пересмотр связанных знаний | 9 |
| 11 | Метрики (tokens/session, context size, recovery success…), health, backup/restore, Docker Compose (server + postgres) | 10 |
| 12 | Добавить бинарь `pmi`, сохранив `memorix` как совместимый алиас на переходный период | 3 |

## 13. Функциональность к удалению

Ни одно удаление не выполняется до утверждения. Для каждого пункта — что, почему, зависимости, риски, замена.

| Что | Почему | Зависимости | Что может пострадать | Замена |
|---|---|---|---|---|
| `packages/memcode`, `packages/ai`, `packages/agent-core`, `packages/tui`, `src/cli/tui/`, `src/cli/memcode*.ts`, `src/cli/workbench.ts`, `tsup.memcode.config.ts`, `vendor/opencode`, `vendor/pi` (submodules), `docs/memcode`, `docs/MEMCODE.md`, `docs/PI_UPSTREAM.md` | Собственный coding‑агент. PMI — инфраструктура памяти для **внешних** агентов, а не агент | `src/media/minimax.ts` импортирует `@memorix/ai`; бинарь `memcode`; запуск `memorix` без аргументов открывает TUI; тесты `tests/cli/tui*`, `hello-memcode-intro.test.ts` | Пользователи memcode upstream | Внешние агенты через MCP. `pmi` без аргументов → `status` |
| `src/orchestrate/` (18 файлов), `memorix orchestrate` | Оркестратор, запускающий агентов‑воркеров. Вне концепции Project Memory; дублирует задачу «сессия/handoff» другим способом | `team-store` (задачи), `memorix-bridge.ts` пишет в память; `worktree.ts` | `tests/orchestrate/*` | Session Continuity (Phase 6). Код `worktree.ts` переиспользуется в Workspace Recovery |
| `src/media/`, `src/multimodal/`, `memorix media`, `memorix_media`, `memorix_ingest_image`, `ingest image`, `runtime/media-*-runner.ts`, `media_*` таблицы | Генерация изображений/аудио/видео через MiniMax, медиа‑пайплайн | `observations.attachments`, `ObservationAttachment`; `unpdf` | `tests/media/*`, `tests/multimodal/*` | Колонка `attachments` (ссылки) сохраняется для совместимости; таблицы `media_*` не удаляются из существующих БД (только перестают создаваться) |
| KG‑compat MCP‑инструменты (`create_entities` … `open_nodes`) | Совместимость с референсным MCP Memory Server; дублирует observations | `src/memory/graph.ts`, `graph_entities` | Пользователи, мигрирующие с mcp‑memory | Остаются доступны в профиле `full` до Phase 5, затем удаляются вместе с решением по модели знаний |
| `memorix_promote` / `mini_skills` / `src/skills/` | Шестая модель знаний; генерация «навыков» из паттернов | `memorix_skills`, `mini-skill-store` | — | Категория `Coding Conventions` в единой памяти |
| `src/wiki/`, knowledge workspace pages/proposals/workflows (решение — после Phase 2) | Генерация wiki‑страниц; пересекается с L1 Project Overview | dashboard, `memorix_knowledge` | — | L1 Overview в Context Engine |
| `articles/`, `llms*.txt`, `README.zh-CN.md`, `ACTIVE_WORK.md`, маркетинговые ассеты | Материалы upstream‑проекта | — | — | Документация PMI в `docs/PMI/` |

Решение по `src/rules/` (синхронизация rules‑файлов между агентами) — отложено до Phase 2: это не память, но полезно для мульти‑агентной работы; вероятно, сохранится в урезанном виде.

## 14. Функциональность, сохраняемая без изменений

| Что | Почему |
|---|---|
| `src/memory/secret-filter.ts` | Редакция секретов при записи и выдаче — прямое требование §14 ТЗ |
| `src/memory/formation/*`, `admission.ts`, `significance-filter.ts` | Отсев шума до записи; уже не превращает «candidate» в факты автоматически |
| `src/sync/merge.ts`, `journal.ts`, `paging.ts` | Корректная сходимая LWW‑модель с тестами — основа offline‑sync |
| `src/compact/*` | Progressive disclosure и token budget — основа L1/L2/L3 |
| `src/codegraph/*` | Инкрементальный индекс файлов/символов и task‑lens |
| `src/hooks/normalizer.ts`, `installers/` | Нормализация событий 15+ агентов |
| `src/workspace/mcp-adapters/*` | Подключение PMI к Claude Code, Codex, Cursor, Gemini CLI и др. — нужно для TEST 10 |
| `src/store/sqlite-*`, `file-lock.ts`, `bun-sqlite-compat.ts` | Надёжный локальный слой (WAL, fallback драйверов) |
| `src/git/noise-filter.ts`, `hooks-path.ts` | Работают корректно, включая worktrees |
| `src/knowledge/task-continuity.ts` | Append‑only журнал, ложится в Session State |
| `src/server/modern-mcp-bridge.ts`, `stdio-startup-gate.ts` | Совместимость с MCP‑клиентами |

## 15. Сверка документации с кодом

| Утверждение в документации | Факт |
|---|---|
| README/`docs/MULTI-DEVICE-SYNC-RESEARCH.md`: Postgres как sync remote | Код есть, но драйвер `pg` не в зависимостях → не работает «из коробки» (**BROKEN** для чистой установки) |
| `CLAUDE.md`: «`memorix_session_start` — Load session context (handoff, team coordination)» | Загружает **проектный** brief; конкретную прерванную сессию не восстанавливает |
| `memorix resume` — «Resume prior project work» | Не принимает id сессии; это brief, а не возобновление |
| `TEAM.md`, «Lock Before Edit» | Блокировки работают в пределах одной SQLite; между машинами не действуют |
| Session «atomic rollover» описан как защита от дублей | Одновременно ломает параллельную работу нескольких агентов |
| HTTP‑режим «team» | Командный режим = несколько агентов **одного** пользователя; пользователей нет |

## 16. Вопросы, требующие решения до Phase 2

1. **Стек.** ТЗ предпочитает Python/FastAPI, но требует сначала изучить текущий стек и не переписывать без веских причин. Memorix — 99K строк TypeScript и 3 200 тестов; MCP SDK, хуки, адаптеры агентов, sync‑движок уже на TS. **Рекомендация:** оставить TypeScript/Node для клиента и центрального сервера; добавить Postgres + pgvector через `pg`; Redis не вводить, пока не понадобится очередь/pub‑sub сверх возможностей Postgres (`LISTEN/NOTIFY`). Переход на Python означает переписывание с нуля, что противоречит правилам 1 и 3 ТЗ.
2. **Удаления из §13** — подтвердить список (особенно memcode и orchestrate — это крупные, активно развиваемые upstream части).
3. **Совместимость имён.** Предлагается бинарь `pmi` + алиас `memorix`, MCP‑инструменты `pmi_*` + алиасы `memorix_*` на переходный период.
4. **Хостинг форка.** `gh` CLI отсутствует; форк на GitHub не создан. Нужен URL репозитория, куда пушить (`origin`), или подтверждение работы локально.
