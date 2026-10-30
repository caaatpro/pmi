# PMI — план реализации

Статус: **проект на согласование** (Phase 2).

Каждая фаза — отдельная ветка `pmi/phase-N-<name>` от предыдущей, небольшие логические коммиты, PR в `main` форка после зелёного CI. Фаза считается завершённой, когда её тесты проходят и документация обновлена. Ни одна функция не объявляется готовой без теста (ТЗ правило 10).

## Обзор

| Phase | Ветка | Результат | Acceptance‑тесты |
|---|---|---|---|
| 1 Audit | `pmi/phase-1-audit` | AUDIT.md ✔ | — |
| 2 Architecture | `pmi/phase-2-architecture` | 7 документов (этот набор) | — |
| 3 Cleanup | `pmi/phase-3-cleanup` | Удаление вне‑PMI подсистем, бинарь `pmi`, разрезанный `server.ts`, фикс параллельных сессий | регрессия существующих тестов |
| 4 Centralized memory | `pmi/phase-4-central` | `pmi-server` + Postgres/pgvector, единая модель Memory, многосущностный sync, Docker Compose | TEST 8 |
| 5 Multi‑user | `pmi/phase-5-rbac` | Org/User/Team/Project/Repository, токены, RBAC, RLS, аудит | TEST 1, TEST 9 |
| 6 Session continuity | `pmi/phase-6-sessions` | Session State, daemon‑checkpointer, handoff/list/resume | TEST 2, TEST 4, TEST 7, TEST 10 |
| 7 Workspace recovery | `pmi/phase-7-workspace` | Snapshots, blobs, restore в worktree | TEST 3 |
| 8 Context engine | `pmi/phase-8-context` | L1/L2/L3, серверный hybrid search, бюджет, метрики токенов | TEST 6 |
| 9 Git intelligence | `pmi/phase-9-git` | Курсоры, классификаторы, устаревание знаний | TEST 5 |
| 10 Hardening | `pmi/phase-10-hardening` | Безопасность, нагрузка, backup/restore, мониторинг, документация | все 10 повторно, end‑to‑end |

Порядок 6 → 7 → 8 → 9 можно частично параллелить после Phase 5, но Phase 7 зависит от daemon из Phase 6.

## Phase 3 — Cleanup

1. Удаления по AUDIT §13 после подтверждения списка — отдельный коммит на каждую подсистему, с удалением её тестов, зависимостей (`package.json`, workspaces, submodules) и документации:
   memcode + `packages/*` + `vendor/*` + TUI → orchestrate (кроме `worktree.ts`, переносится в `src/workspace-snapshot`) → media/multimodal → KG‑compat MCP → mini‑skills/promote → маркетинговые файлы.
2. Бинарь `pmi` (+ `memorix` алиас), `pmi` без аргументов → `status`.
3. Разрезать `src/server.ts` на `src/mcp/tools/<domain>.ts` без изменения поведения (snapshot‑тест списка инструментов и схем).
4. Исправить `startSession` rollover (AUDIT §7) — параллельные сессии; тест.
5. Исправить тесты, пишущие в `E:/tmp`; добавить `pg` в зависимости или убрать Postgres‑relay в пользу Phase 4.
6. CI (GitHub Actions форка): `npm ci`, build, lint, test.

Критерий: все оставшиеся тесты зелёные, `npm pack` не содержит удалённого, MCP smoke‑тесты проходят.

### Итог Phase 3 (ветка `pmi/phase-3-cleanup`)

| Пункт | Результат |
|---|---|
| memcode, `packages/*`, `vendor/*`, TUI, `ask`, `workbench` | Удалены (~247 тыс. строк, вместе с медиа). Зависимости ink/react убраны |
| `src/orchestrate`, `memorix orchestrate`, pipeline guards | Удалены; `worktree.ts` → `src/workspace-snapshot/` |
| Медиа: `memorix_media`, `memorix_ingest_image`, `media` CLI, медиа‑джобы | Удалены. Таблицы `media_*` в существующих БД сохраняются, старые медиа‑джобы больше не берутся в работу |
| KG‑compat MCP (9 инструментов) | Удалены; внутренний граф для auto‑relations сохранён |
| Маркетинг upstream | Удалён; новые README.md и AGENTS.md (CLAUDE.md импортирует AGENTS.md) |
| Бинарь `pmi` + алиас `memorix` | Готово. Автообновление с npm (там upstream Memorix) по умолчанию выключено |
| Параллельные сессии | Rollover ограничен тем же агентом; MCP‑подключение привязывает записи к своей сессии. Тесты: `tests/store/concurrency-atomicity.test.ts`, `tests/server/parallel-sessions.test.ts` |
| Тесты с `E:/tmp`, драйвер `pg` | Исправлено; `pg` — runtime‑зависимость |
| CI | Существующий workflow (Ubuntu/Windows/macOS, typecheck, Docker) запускается и на ветках `pmi/**` |

**Перенесено в Phase 4** (с обоснованием):
- **Разрезка `src/server.ts`.** Инструменты используют ~15 изменяемых замыканий (`project`, `projectDir`, `teamStore`, `graphManager`, …), которые меняются при перепривязке проекта. Механический перенос требует общего объекта контекста — его естественно ввести вместе с первыми PMI‑инструментами и сервисным слоем Phase 4. Страховка уже есть: `tests/server/tool-surface-snapshot.test.ts` фиксирует имена и поля всех 37 инструментов.
- **Mini‑skills (`memorix_skills`, `memorix_promote`, `mini_skills`).** Они встроены в поисковый индекс, session start, dashboard и формат выдачи (25 файлов). В Phase 4 mini‑skills мигрируют в записи категории `coding_convention` единой модели памяти, после чего подсистема удаляется. Удаление сейчас означало бы дважды переписывать один и тот же код.

## Phase 4 — Centralized memory

1. `src/domain/memory.ts`: категории, confidence, статусы, правила переходов (чистые функции + unit‑тесты).
2. Локальная миграция SQLite (DATABASE.md §3, §5) с резервной копией; тест на копии реальной БД Memorix из фикстур.
3. `src/server/central`: HTTP‑каркас, zod‑валидация, логирование, health/ready, миграции Postgres (`migrations/pg`).
4. Репозитории Postgres для memory/versions/links/conflicts/changes; порты с реализациями SQLite и Postgres; общие контрактные тесты для обеих.
5. Sync v4: outbox + `push` + `changes` feed + long‑poll; переиспользование `merge.ts`; многосущностность.
6. `pmi login`, `pmi project link`, `pmi sync`.
7. Docker Compose: `postgres` (pgvector), `pmi-server`, `caddy`; healthchecks.
8. Тестовая инфраструктура: Postgres в тестах через Docker (testcontainers‑подобный хелпер на `docker run`), пропуск с явным сообщением, если Docker недоступен; в CI — service container.

TEST 8: клиент пишет при остановленном сервере → outbox растёт → старт сервера → данные на сервере и у второго клиента.

### Итог Phase 4 (ветка `pmi/phase-4-central`)

| Пункт | Результат | Проверка |
|---|---|---|
| 1. Доменная модель | `src/domain/memory.ts`: 16 категорий, 5 уровней confidence, статусы, отображение типов Memorix, правила переходов (агент не может подтвердить знание или изменить `confirmed`) | `tests/domain/memory.test.ts` |
| 2. Миграция SQLite | `pmi-1-memory-classification`: колонки `category`/`confidence` (NULL = значение по умолчанию для типа, строки не переписываются). Перед первой PMI‑миграцией непустая БД копируется `VACUUM INTO` в `memorix.db.pre-pmi-<ts>` с `integrity_check` | `tests/store/pmi-migration.test.ts` |
| 3. `pmi-server` | `src/server/central`: `node:http` + zod, JSON‑логи, `/health`, `/ready` (Postgres + миграции), миграции под advisory lock, CLI `migrate/serve/create-org/create-user/add-member/issue-token/revoke-token` | `tests/central/server.test.ts` |
| 4. Хранилище Postgres | `memory.memories` (+ tsvector, `vector(384)` HNSW), `memory_versions`, `memory_links`, `conflicts`, `work.changes`, `work.project_seq`, `core.*` для пользователей, организаций, токенов, проектов, репозиториев, аудита | тот же набор, реальный Postgres 17 + pgvector |
| 5. Sync v4 | Центральный сервер подключён к существующему sync‑движку как `SyncRemote` (`src/sync/adapters/pmi-server.ts`). Переиспользованы diff по `sync_row_state`, `sync_outbox`, курсор, порядок `(revision, writer)` из `merge.ts`. Сервер материализует записи, ведёт историю версий, фиксирует конфликты одновременной правки, хранит tombstones, отклоняет записи с секретами | `tests/central/server.test.ts`, `tests/client/config.test.ts` |
| 6. CLI | `pmi login`, `pmi logout`, `pmi project link|show`, `pmi sync [push|pull|status]`; код возврата 3 при недоступном сервере | TEST 8 |
| 7. Docker Compose | `deploy/compose.yaml`: `postgres` (pgvector), `pmi-server` (миграции при старте), `caddy` (TLS); healthchecks у всех трёх | ручной `docker compose up --wait`, см. ниже |
| 8. Тестовая инфраструктура | `tests/central/pg-helper.ts`: одноразовый контейнер pgvector или `PMI_TEST_PG_URL`; явный skip без Docker. CI: обязательная задача `central-postgres` с service container | |
| **TEST 8** | Реальный CLI двух «машин» (отдельные HOME, данные, клоны), реальный сервер и Postgres: запись при остановленном сервере → `pmi sync status` показывает 2 ожидающих изменения и код 3 → сервер стартует → `pmi sync` выгружает → второй клиент получает | `tests/central/offline-sync.test.ts` ✔ |

**Решения, принятые по ходу** (зафиксированы в DATABASE.md и API.md):
- Отдельная таблица `outbox` не создавалась: у sync‑движка Memorix уже есть `sync_outbox` и вычисление изменений по `sync_row_state`, второй механизм нарушил бы правило «без дублирования». Офлайн‑записи не теряются: они лежат в `observations`, а неотправленные пакеты — в `sync_outbox`.
- Доступ в Phase 4 — членство в организации проекта; создавать проекты могут owner/admin. Гранты на проекты, команды, RBAC и RLS — Phase 5, единая точка `assertProjectAccess` будет заменена `authorize()`.
- Один проект сервера = один Memorix project id (`owner/repo`). Если рабочая копия с тем же root commit имеет другой id, `project link` отвечает `409 identity_mismatch`, а не делит память молча. Сопоставление идентичностей — Phase 5 вместе с `.pmi/project.json` как источником идентичности.
- Long‑poll `/changes/wait` перенесён в Phase 6: его потребитель — daemon.

**Не выполнено в Phase 4 и перенесено** (с обоснованием):
- **Разрезка `src/server.ts` и миграция mini‑skills в `coding_convention`.** Не начаты. Ни одна функция Phase 4 от них не зависит: центральный сервер работает через sync‑движок, а не через MCP‑сервер. Делаются отдельным шагом перед PMI‑инструментами MCP, которым и нужен общий объект контекста.

## Phase 5 — Multi‑user

Схема `core`, токены (`pmi-server issue-token`), `authorize()`, RLS, `audit_log`, гранты проектов, кросс‑проектный поиск с учётом прав, MCP HTTP с per‑user токеном. Замена `team_*` идентичности агентов на пользователей (агент — атрибут).

TEST 1, TEST 9 (пользователь без гранта получает 403/404 на memory, sessions, snapshots, search, MCP; прямой SQL под его `app.user_id` не видит строк).

### Итог Phase 5 (ветка `pmi/phase-5-rbac`)

| Пункт | Результат | Проверка |
|---|---|---|
| Команды, гранты | Миграция `0002-rbac-rls`: `core.teams`, `core.team_members`, `core.project_grants` (пользователю или команде; `maintainer`/`developer`/`viewer`). Owner/admin организации — роль `admin` во всех её проектах; остальным нужен грант. При обновлении с Phase 4 участники организаций получают явный `developer` на существующие проекты, доступ не теряется | `tests/central/rbac.test.ts` (в т.ч. обновление со схемы `0001`) |
| `authorize()` | Единственная точка проверки в сервисном слое, матрица DATABASE.md §4 (`memory.read/write/confirm`, `project.manage`). Невидимый проект → 404, недостаточная роль → 403 и запись `access.denied` в аудит | там же |
| RLS | Роль `pmi_app` (NOLOGIN) и политики на `memory.*`, `work.changes`, `work.project_seq` через `core.can()` — ту же функцию роли, что и в сервисе. Все запросы к данным проектов идут в `db.asUser()` (`SET LOCAL ROLE pmi_app` + `app.user_id`). `core.audit_log` для приложения только на вставку | TEST 9, прямой SQL |
| Защита знаний | `POST /v1/memories/:id/confirm|deprecate` (developer+, только явный вызов человека, с причиной в истории и аудите). Сервер создаёт новую ревизию (writer `pmi-server`), клиенты получают её через feed. Синхронизация (то, что записали агенты и хуки) не может подтвердить знание, изменить или удалить `confirmed` | `rbac.test.ts`, TEST 1 |
| Поиск | `POST /v1/projects/:id/search` и кросс‑проектный `POST /v1/search` по всем проектам, где у пользователя есть чтение (tsvector; гибридный поиск — Phase 8) | `rbac.test.ts` |
| MCP с токеном пользователя | `POST /mcp` (Streamable HTTP, без состояния): `project_list`, `memory_search`, `memory_get`; каждый вызов через `authorize()` и RLS; без токена 401 | `rbac.test.ts` |
| Администрирование | REST: `PUT /v1/projects/:id/grants`, `POST /v1/orgs/:org/teams`, `POST /v1/orgs/:org/teams/:team/members`. CLI: `pmi-server create-team`, `add-team-member`, `grant` | `rbac.test.ts` |
| **TEST 9** | Участник организации без гранта и пользователь другой организации: 404 на проект, память, feed, конфликты, поиск, запись, подтверждение, гранты, `project link`; кросс‑проектный поиск пуст; MCP‑инструменты отказывают; под их `app.user_id` SQL видит 0 строк, `UPDATE` ничего не меняет, `INSERT` отклоняется RLS, `DELETE` из аудита запрещён | ✔ |
| **TEST 1** | Alice (Claude Code, машина A) сохраняет решение через реальный stdio MCP → `pmi sync` → Bob (Codex, машина B, другой пользователь с грантом) после `pmi sync` получает решение в `memorix_project_context` по связанной задаче, не обращаясь к файлам. Подтверждение Боба доходит до машины Алисы | `tests/central/cross-user-context.test.ts` ✔ |

**Ограничения и перенос** (с обоснованием):
- **Sessions и snapshots в TEST 9** проверяются по мере появления этих эндпоинтов (Phase 6, 7): тест расширяется теми же пользователями. Политики RLS для `work.sessions`/`work.snapshots` пишутся в их миграциях по образцу `0002`.
- **Замена `team_*`‑идентичности агентов на пользователей** перенесена в Phase 6: она касается локальной координации сессий (`team_agents`, `team_locks`), которую Phase 6 заменяет session leases.
- **`core.devices`, scopes токенов** — Phase 6 вместе с lease устройств; сейчас устройство идентифицируется `deviceId` sync‑пакета в аудите и истории версий.
- **Кросс‑проектный поиск** ищет по всем проектам, где у пользователя есть чтение. Флаг `visibility = organization` (доступ к записи без гранта на проект) не нужен, пока такой сценарий не появится: RBAC уже ограничивает выдачу.
- **TEST 1 использует нынешние MCP‑инструменты** (`memorix_store`, `memorix_project_context`); `decision_log` и `context_build` появятся в Phase 8 и будут проверены тем же тестом.
- **Ключи памяти глобальны.** Два серверных проекта с одинаковым Memorix id (например, `local/app` у репозиториев без remote) могут столкнуться на одинаковых topic key; такая запись отклоняется с причиной, а не перезаписывает чужую. Решается переходом на `.pmi/project.json` как источник идентичности.
- **Разрезка `src/server.ts` и миграция mini‑skills** по‑прежнему не сделаны; их черёд — перед PMI‑инструментами MCP (Phase 8).

## Phase 6 — Session continuity

Session State, статусы, lease, checkpoints, `session_events` (+ миграция `task_continuity_events`), daemon (watcher, таймер, git‑события, IPC, автозапуск), handoff brief, `pmi session *`, MCP `session_*`, серверный джоб истечения lease.

TEST 2, 4, 7, 10. Для TEST 10 — два реальных адаптера (Claude Code hooks/MCP config и Codex MCP config из `src/workspace/mcp-adapters`) в e2e с симулированными MCP‑клиентами; ручная проверка на живых агентах описывается в чек‑листе.

### Итог Phase 6 (ветка `pmi/phase-6-sessions`)

| Пункт | Результат | Проверка |
|---|---|---|
| Session State, статусы | `src/domain/session.ts`: `SessionState` (SESSION_CONTINUITY.md §2), 8 статусов, переходы, ограничение 64 KiB со сворачиванием длинных списков, детерминированный Handoff Brief через secret‑filter | `tests/domain/session.test.ts` |
| Локальное хранение | Миграция `pmi-2-session-continuity`: `pmi_sessions`, `session_checkpoints` (неизменяемые), `session_outbox` (упорядоченная доставка) | `tests/session/daemon.test.ts` |
| Сервер | Миграция `0003-sessions`: `work.sessions`, `work.checkpoints` с RLS (state — только developer+); lease с продлением; истечение lease → `resumable` (`interrupted` без checkpoint) периодически и перед list/resume; handoff с адресным резервом на 24 ч; resume: тот же пользователь — та же сессия, другой — дочерняя (`parent_session_id`), родитель закрывается как продолженный; `--force` — maintainer, в аудит; checkpoint от устройства, потерявшего сессию, сохраняется как `orphan` | `tests/central/sessions.test.ts` |
| Daemon | `pmi daemon run|start|stop|status`, автозапуск в Connected mode из `session start`/`resume` и MCP. Без участия агента: `fs_change` (изменения улеглись `PMI_CHECKPOINT_DEBOUNCE_MS`), `commit` (сдвинулся HEAD), `timer` (непрерывные изменения дольше `PMI_CHECKPOINT_INTERVAL_MS`); агент умер (pid процесса MCP‑сервера) или молчит `PMI_AGENT_IDLE_MS` → `exit` checkpoint и освобождение; SIGTERM → `exit` checkpoint; продление lease, доставка outbox | `tests/session/daemon.test.ts`, TEST 4 |
| CLI | `pmi session start --task --objective --model`, `checkpoint`, `handoff [--to]`, `list [--all]`, `resume <id>`, `finish [--failed]`, `show`; код 3 — сервер недоступен, данные в очереди | TEST 2 |
| MCP | `session_checkpoint`, `session_handoff`, `session_list`, `session_resume`, `session_finish` (`src/mcp/tools/session.ts` — первый модуль инструментов вне `server.ts`, с явным контекстом); `memorix_session_start` принимает `task/objective/model` и показывает сессии, ждущие продолжения; любой вызов инструмента — активность агента | TEST 10 |
| **TEST 2** | CLI: Alice (claude-code) start → 2 checkpoint → handoff; Bob (codex, другой пользователь и устройство) list → resume получает выполненные шаги, pending, next action, objective, изменённые файлы | ✔ |
| **TEST 10** | Конфиги, записанные `pmi setup` для Claude Code (`.claude/settings.json`) и Codex (`~/.codex/config.toml`), запускают MCP‑сервер; Claude Code передаёт сессию через `session_handoff`, Codex видит её в `memorix_session_start`, продолжает через `session_resume` | ✔ |
| **TEST 4** | Агент убит `kill -9` без handoff: daemon уже сделал checkpoint по изменениям файлов, освободил сессию; Bob продолжает с шагами и файлами. Вариант «машина потеряна»: убиты агент и daemon, сервер по истечении lease делает сессию `resumable` | ✔ (оба) |
| **TEST 7** | Агенты двух пользователей одновременно в одном проекте: обе сессии активны, у каждой свои checkpoints и шаги | ✔ |

**Отличия от проекта и перенос** (с обоснованием):
- **PMI‑состояние сессии в отдельной таблице `pmi_sessions`**, а не в колонках `sessions`: Memorix переписывает `sessions` через `INSERT OR REPLACE`, что стирало бы добавленные колонки. Связь 1:1 по id.
- **Отдельный outbox для сессий** (`session_outbox`), а не sync‑движок памяти: checkpoints — неизменяемые события, а lease/handoff/resume требуют ответа сервера; построчный diff с LWW к ним не подходит. Память по‑прежнему идёт через sync‑движок.
- **Daemon опрашивает рабочую копию** (`git status` + mtime/size), а не подписывается на события файловой системы: одинаково на всех ОС, без зависимостей; триггеры те же. Git‑хуки → IPC не нужны: сдвиг HEAD виден в следующем тике (по умолчанию 5 с).
- **Содержимое файлов при resume не переносится** — это Phase 7 (Workspace Recovery). Resume Package уже содержит ветку, HEAD, список изменённых файлов и `snapshot: null`; CLI и MCP прямо об этом сообщают.
- **`session_events` не выделены в таблицу**: шаги, решения, проблемы и наблюдения живут в state и в каждом checkpoint; миграция `task_continuity_events` — вместе с переносом continuity‑инструментов при разрезке `server.ts`.
- **Path‑leases и замена `team_*`** — не сделаны; параллельная работа обеспечивается сессионными lease (TEST 7). Замена `team_file_lock` общими path‑leases — следующий шаг после Phase 7, когда restore начнёт писать в рабочие копии.
- **TEST 9 для сессий**: RLS и роли проверены в `sessions.test.ts` (viewer видит список без state, не может читать детали и писать; чужие сессии недоступны для записи). Полное расширение TEST 9 на snapshots — в Phase 7.

## Phase 7 — Workspace recovery

Snapshot builder, blob store (локальный и серверный), инкрементальная загрузка, restore в worktree / in‑place, проверки конфликтов, страховочные snapshot, retention/GC, исключение секретов.

TEST 3 + негативные тесты из WORKSPACE_RECOVERY.md §10.

## Phase 8 — Context engine

L1 overview + кэш, серверный hybrid search (tsvector + pgvector + RRF), ранжирование с учётом сессии/файлов/git, упаковка в бюджет, L3, метрики и `/metrics`, оценка экономии токенов + бенчмарк.

TEST 6, существующие evaluation‑гейты не деградируют.

## Phase 9 — Git intelligence

Курсоры, конвейер `cursor..HEAD`, `--name-status`/parents, классификаторы, устаревание связанных знаний, полная сверка, хуки post‑merge/post‑checkout.

TEST 5.

## Phase 10 — Hardening

Security review (auth, RLS, path traversal в restore, zip‑slip в bundle, размеры тел), шифрование blobs, TLS‑конфигурация, нагрузочный тест (100k записей, 20 клиентов), backup/restore drill, чек‑лист эксплуатации, полная документация пользователя и оператора, финальный прогон всех 10 acceptance‑тестов в Docker Compose‑окружении.

## Риски

| Риск | Митигирующее действие |
|---|---|
| Объём upstream‑кода затрудняет изменения | Phase 3 сокращает кодовую базу до начала новых функций |
| Расхождение с upstream Memorix | Форк не синхронизируется с upstream автоматически после Phase 3; полезные исправления переносятся cherry‑pick вручную |
| Тесты Postgres требуют Docker | Хелпер с явным skip‑сообщением локально, обязательный прогон в CI |
| Хуки агентов различаются | Daemon не зависит от хуков (SESSION_CONTINUITY.md §4) |
| Большие рабочие копии | Лимиты размера, исключения, инкрементальные blobs |
| Ложные противоречия/устаревание | Только пометки и review, никаких автоматических изменений `confirmed`‑знаний |

## Решения, ожидающие подтверждения

1. Список удалений (AUDIT §13).
2. Именование `pmi` / `pmi_*` с алиасами `memorix` / `memorix_*`.
3. При resume другим пользователем — новая дочерняя сессия (SESSION_CONTINUITY.md §3).
4. Восстановление workspace по умолчанию в новый worktree, а не в текущую рабочую копию (WORKSPACE_RECOVERY.md §5).
5. Отсутствие Redis в первой версии (ARCHITECTURE.md D5).
