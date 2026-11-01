# Baton — план реализации

Статус: **проект на согласование** (Phase 2).

Каждая фаза — отдельная ветка `pmi/phase-N-<name>` от предыдущей, небольшие логические коммиты, PR в `main` форка после зелёного CI. Фаза считается завершённой, когда её тесты проходят и документация обновлена. Ни одна функция не объявляется готовой без теста (ТЗ правило 10).

## Обзор

| Phase | Ветка | Результат | Acceptance‑тесты |
|---|---|---|---|
| 1 Audit | `pmi/phase-1-audit` | AUDIT.md ✔ | — |
| 2 Architecture | `pmi/phase-2-architecture` | 7 документов (этот набор) | — |
| 3 Cleanup | `pmi/phase-3-cleanup` | Удаление вне‑Baton подсистем, бинарь `baton`, разрезанный `server.ts`, фикс параллельных сессий | регрессия существующих тестов |
| 4 Centralized memory | `pmi/phase-4-central` | `baton-server` + Postgres/pgvector, единая модель Memory, многосущностный sync, Docker Compose | TEST 8 |
| 5 Multi‑user | `pmi/phase-5-rbac` | Org/User/Team/Project/Repository, токены, RBAC, RLS, аудит | TEST 1, TEST 9 |
| 6 Session continuity | `pmi/phase-6-sessions` | Session State, daemon‑checkpointer, handoff/list/resume | TEST 2, TEST 4, TEST 7, TEST 10 |
| 7 Workspace recovery | `pmi/phase-7-workspace` | Snapshots, blobs, restore в worktree | TEST 3 |
| 8 Context engine | `pmi/phase-8-context` | L1/L2/L3, серверный hybrid search, бюджет, метрики токенов | TEST 6 |
| 9 Git intelligence | `pmi/phase-9-git` | Курсоры, классификаторы, устаревание знаний | TEST 5 |
| 10 Hardening | `pmi/phase-10-hardening` | Безопасность, нагрузка, backup/restore, мониторинг, документация | все 10 повторно, end‑to‑end |
| 11 Web UI | `pmi/phase-11-web-ui` | Веб‑интерфейс `baton-server`: проекты, знания и актуальность, сессии, конфликты, аудит, подтверждение знаний людьми | `tests/central/web-ui.test.ts`, проверка в браузере |

Порядок 6 → 7 → 8 → 9 можно частично параллелить после Phase 5, но Phase 7 зависит от daemon из Phase 6.

## Phase 3 — Cleanup

1. Удаления по AUDIT §13 после подтверждения списка — отдельный коммит на каждую подсистему, с удалением её тестов, зависимостей (`package.json`, workspaces, submodules) и документации:
   memcode + `packages/*` + `vendor/*` + TUI → orchestrate (кроме `worktree.ts`, переносится в `src/workspace-snapshot`) → media/multimodal → KG‑compat MCP → mini‑skills/promote → маркетинговые файлы.
2. Бинарь `baton` (+ `baton` алиас), `baton` без аргументов → `status`.
3. Разрезать `src/server.ts` на `src/mcp/tools/<domain>.ts` без изменения поведения (snapshot‑тест списка инструментов и схем).
4. Исправить `startSession` rollover (AUDIT §7) — параллельные сессии; тест.
5. Исправить тесты, пишущие в `E:/tmp`; добавить `pg` в зависимости или убрать Postgres‑relay в пользу Phase 4.
6. CI (GitHub Actions форка): `npm ci`, build, lint, test.

Критерий: все оставшиеся тесты зелёные, `npm pack` не содержит удалённого, MCP smoke‑тесты проходят.

### Итог Phase 3 (ветка `pmi/phase-3-cleanup`)

| Пункт | Результат |
|---|---|
| memcode, `packages/*`, `vendor/*`, TUI, `ask`, `workbench` | Удалены (~247 тыс. строк, вместе с медиа). Зависимости ink/react убраны |
| `src/orchestrate`, `baton orchestrate`, pipeline guards | Удалены; `worktree.ts` → `src/workspace-snapshot/` |
| Медиа: `baton_media`, `baton_ingest_image`, `media` CLI, медиа‑джобы | Удалены. Таблицы `media_*` в существующих БД сохраняются, старые медиа‑джобы больше не берутся в работу |
| KG‑compat MCP (9 инструментов) | Удалены; внутренний граф для auto‑relations сохранён |
| Маркетинг upstream | Удалён; новые README.md и AGENTS.md (CLAUDE.md импортирует AGENTS.md) |
| Бинарь CLI с алиасом | Готово (позже переименован в `baton`, алиасы убраны). Автообновление с npm (там upstream) по умолчанию выключено |
| Параллельные сессии | Rollover ограничен тем же агентом; MCP‑подключение привязывает записи к своей сессии. Тесты: `tests/store/concurrency-atomicity.test.ts`, `tests/server/parallel-sessions.test.ts` |
| Тесты с `E:/tmp`, драйвер `pg` | Исправлено; `pg` — runtime‑зависимость |
| CI | Существующий workflow (Ubuntu/Windows/macOS, typecheck, Docker) запускается и на ветках `baton/**` |

**Перенесено в Phase 4** (с обоснованием):
- **Разрезка `src/server.ts`.** Инструменты используют ~15 изменяемых замыканий (`project`, `projectDir`, `teamStore`, `graphManager`, …), которые меняются при перепривязке проекта. Механический перенос требует общего объекта контекста — его естественно ввести вместе с первыми Baton‑инструментами и сервисным слоем Phase 4. Страховка уже есть: `tests/server/tool-surface-snapshot.test.ts` фиксирует имена и поля всех 37 инструментов.
- **Mini‑skills (`baton_skills`, `baton_promote`, `mini_skills`).** Они встроены в поисковый индекс, session start, dashboard и формат выдачи (25 файлов). В Phase 4 mini‑skills мигрируют в записи категории `coding_convention` единой модели памяти, после чего подсистема удаляется. Удаление сейчас означало бы дважды переписывать один и тот же код.

## Phase 4 — Centralized memory

1. `src/domain/memory.ts`: категории, confidence, статусы, правила переходов (чистые функции + unit‑тесты).
2. Локальная миграция SQLite (DATABASE.md §3, §5) с резервной копией; тест на копии реальной БД upstream из фикстур.
3. `src/server/central`: HTTP‑каркас, zod‑валидация, логирование, health/ready, миграции Postgres (`migrations/pg`).
4. Репозитории Postgres для memory/versions/links/conflicts/changes; порты с реализациями SQLite и Postgres; общие контрактные тесты для обеих.
5. Sync v4: outbox + `push` + `changes` feed + long‑poll; переиспользование `merge.ts`; многосущностность.
6. `baton login`, `baton project link`, `baton sync`.
7. Docker Compose: `postgres` (pgvector), `baton-server`, `caddy`; healthchecks.
8. Тестовая инфраструктура: Postgres в тестах через Docker (testcontainers‑подобный хелпер на `docker run`), пропуск с явным сообщением, если Docker недоступен; в CI — service container.

TEST 8: клиент пишет при остановленном сервере → outbox растёт → старт сервера → данные на сервере и у второго клиента.

### Итог Phase 4 (ветка `pmi/phase-4-central`)

| Пункт | Результат | Проверка |
|---|---|---|
| 1. Доменная модель | `src/domain/memory.ts`: 16 категорий, 5 уровней confidence, статусы, отображение типов upstream, правила переходов (агент не может подтвердить знание или изменить `confirmed`) | `tests/domain/memory.test.ts` |
| 2. Миграция SQLite | `baton-1-memory-classification`: колонки `category`/`confidence` (NULL = значение по умолчанию для типа, строки не переписываются). Перед первой Baton‑миграцией непустая БД копируется `VACUUM INTO` в `baton.db.pre-baton-<ts>` с `integrity_check` | `tests/store/baton-migration.test.ts` |
| 3. `baton-server` | `src/server/central`: `node:http` + zod, JSON‑логи, `/health`, `/ready` (Postgres + миграции), миграции под advisory lock, CLI `migrate/serve/create-org/create-user/add-member/issue-token/revoke-token` | `tests/central/server.test.ts` |
| 4. Хранилище Postgres | `memory.memories` (+ tsvector, `vector(384)` HNSW), `memory_versions`, `memory_links`, `conflicts`, `work.changes`, `work.project_seq`, `core.*` для пользователей, организаций, токенов, проектов, репозиториев, аудита | тот же набор, реальный Postgres 17 + pgvector |
| 5. Sync v4 | Центральный сервер подключён к существующему sync‑движку как `SyncRemote` (`src/sync/adapters/baton-server.ts`). Переиспользованы diff по `sync_row_state`, `sync_outbox`, курсор, порядок `(revision, writer)` из `merge.ts`. Сервер материализует записи, ведёт историю версий, фиксирует конфликты одновременной правки, хранит tombstones, отклоняет записи с секретами | `tests/central/server.test.ts`, `tests/client/config.test.ts` |
| 6. CLI | `baton login`, `baton logout`, `baton project link|show`, `baton sync [push|pull|status]`; код возврата 3 при недоступном сервере | TEST 8 |
| 7. Docker Compose | `deploy/compose.yaml`: `postgres` (pgvector), `baton-server` (миграции при старте), `caddy` (TLS); healthchecks у всех трёх | ручной `docker compose up --wait`, см. ниже |
| 8. Тестовая инфраструктура | `tests/central/pg-helper.ts`: одноразовый контейнер pgvector или `BATON_TEST_PG_URL`; явный skip без Docker. CI: обязательная задача `central-postgres` с service container | |
| **TEST 8** | Реальный CLI двух «машин» (отдельные HOME, данные, клоны), реальный сервер и Postgres: запись при остановленном сервере → `baton sync status` показывает 2 ожидающих изменения и код 3 → сервер стартует → `baton sync` выгружает → второй клиент получает | `tests/central/offline-sync.test.ts` ✔ |

**Решения, принятые по ходу** (зафиксированы в DATABASE.md и API.md):
- Отдельная таблица `outbox` не создавалась: у sync‑движка upstream уже есть `sync_outbox` и вычисление изменений по `sync_row_state`, второй механизм нарушил бы правило «без дублирования». Офлайн‑записи не теряются: они лежат в `observations`, а неотправленные пакеты — в `sync_outbox`.
- Доступ в Phase 4 — членство в организации проекта; создавать проекты могут owner/admin. Гранты на проекты, команды, RBAC и RLS — Phase 5, единая точка `assertProjectAccess` будет заменена `authorize()`.
- Один проект сервера = один upstream project id (`owner/repo`). Если рабочая копия с тем же root commit имеет другой id, `project link` отвечает `409 identity_mismatch`, а не делит память молча. Сопоставление идентичностей — Phase 5 вместе с `.baton/project.json` как источником идентичности. После Phase 11: форк с `--create` получает свой проект (раньше `identity_mismatch` блокировал и создание), проект с точным совпадением id выбирается сам, а при нескольких таких проектах `baton project link --project <org/slug>` выбирает один; ошибки перечисляют подходящие видимые проекты (`tests/central/project-resolve.test.ts`).
- Long‑poll `/changes/wait` перенесён в Phase 6: его потребитель — daemon.

**Не выполнено в Phase 4 и перенесено** (с обоснованием):
- **Разрезка `src/server.ts` и миграция mini‑skills в `coding_convention`.** Не начаты. Ни одна функция Phase 4 от них не зависит: центральный сервер работает через sync‑движок, а не через MCP‑сервер. Делаются отдельным шагом перед Baton‑инструментами MCP, которым и нужен общий объект контекста.

## Phase 5 — Multi‑user

Схема `core`, токены (`baton-server issue-token`), `authorize()`, RLS, `audit_log`, гранты проектов, кросс‑проектный поиск с учётом прав, MCP HTTP с per‑user токеном. Замена `team_*` идентичности агентов на пользователей (агент — атрибут).

TEST 1, TEST 9 (пользователь без гранта получает 403/404 на memory, sessions, snapshots, search, MCP; прямой SQL под его `app.user_id` не видит строк).

### Итог Phase 5 (ветка `pmi/phase-5-rbac`)

| Пункт | Результат | Проверка |
|---|---|---|
| Команды, гранты | Миграция `0002-rbac-rls`: `core.teams`, `core.team_members`, `core.project_grants` (пользователю или команде; `maintainer`/`developer`/`viewer`). Owner/admin организации — роль `admin` во всех её проектах; остальным нужен грант. При обновлении с Phase 4 участники организаций получают явный `developer` на существующие проекты, доступ не теряется | `tests/central/rbac.test.ts` (в т.ч. обновление со схемы `0001`) |
| `authorize()` | Единственная точка проверки в сервисном слое, матрица DATABASE.md §4 (`memory.read/write/confirm`, `project.manage`). Невидимый проект → 404, недостаточная роль → 403 и запись `access.denied` в аудит | там же |
| RLS | Роль `baton_app` (NOLOGIN) и политики на `memory.*`, `work.changes`, `work.project_seq` через `core.can()` — ту же функцию роли, что и в сервисе. Все запросы к данным проектов идут в `db.asUser()` (`SET LOCAL ROLE baton_app` + `app.user_id`). `core.audit_log` для приложения только на вставку | TEST 9, прямой SQL |
| Защита знаний | `POST /v1/memories/:id/confirm|deprecate` (developer+, только явный вызов человека, с причиной в истории и аудите). Сервер создаёт новую ревизию (writer `baton-server`), клиенты получают её через feed. Синхронизация (то, что записали агенты и хуки) не может подтвердить знание, изменить или удалить `confirmed` | `rbac.test.ts`, TEST 1 |
| Поиск | `POST /v1/projects/:id/search` и кросс‑проектный `POST /v1/search` по всем проектам, где у пользователя есть чтение (tsvector; гибридный поиск — Phase 8) | `rbac.test.ts` |
| MCP с токеном пользователя | `POST /mcp` (Streamable HTTP, без состояния): `project_list`, `memory_search`, `memory_get`; каждый вызов через `authorize()` и RLS; без токена 401 | `rbac.test.ts` |
| Администрирование | REST: `PUT /v1/projects/:id/grants`, `POST /v1/orgs/:org/teams`, `POST /v1/orgs/:org/teams/:team/members`. CLI: `baton-server create-team`, `add-team-member`, `grant` | `rbac.test.ts` |
| **TEST 9** | Участник организации без гранта и пользователь другой организации: 404 на проект, память, feed, конфликты, поиск, запись, подтверждение, гранты, `project link`; кросс‑проектный поиск пуст; MCP‑инструменты отказывают; под их `app.user_id` SQL видит 0 строк, `UPDATE` ничего не меняет, `INSERT` отклоняется RLS, `DELETE` из аудита запрещён | ✔ |
| **TEST 1** | Alice (Claude Code, машина A) сохраняет решение через реальный stdio MCP → `baton sync` → Bob (Codex, машина B, другой пользователь с грантом) после `baton sync` получает решение в `baton_project_context` по связанной задаче, не обращаясь к файлам. Подтверждение Боба доходит до машины Алисы | `tests/central/cross-user-context.test.ts` ✔ |

**Ограничения и перенос** (с обоснованием):
- **Sessions и snapshots в TEST 9** проверяются по мере появления этих эндпоинтов (Phase 6, 7): тест расширяется теми же пользователями. Политики RLS для `work.sessions`/`work.snapshots` пишутся в их миграциях по образцу `0002`.
- **Замена `team_*`‑идентичности агентов на пользователей** перенесена в Phase 6: она касается локальной координации сессий (`team_agents`, `team_locks`), которую Phase 6 заменяет session leases.
- **`core.devices`, scopes токенов** — Phase 6 вместе с lease устройств; сейчас устройство идентифицируется `deviceId` sync‑пакета в аудите и истории версий.
- **Кросс‑проектный поиск** ищет по всем проектам, где у пользователя есть чтение. Флаг `visibility = organization` (доступ к записи без гранта на проект) не нужен, пока такой сценарий не появится: RBAC уже ограничивает выдачу.
- **TEST 1 использует нынешние MCP‑инструменты** (`baton_store`, `baton_project_context`); `decision_log` и `context_build` появятся в Phase 8 и будут проверены тем же тестом.
- **Ключи памяти глобальны.** Два серверных проекта с одинаковым upstream id (например, `local/app` у репозиториев без remote) могут столкнуться на одинаковых topic key; такая запись отклоняется с причиной, а не перезаписывает чужую. Решается переходом на `.baton/project.json` как источник идентичности.
- **Разрезка `src/server.ts` и миграция mini‑skills** по‑прежнему не сделаны; их черёд — перед Baton‑инструментами MCP (Phase 8).

## Phase 6 — Session continuity

Session State, статусы, lease, checkpoints, `session_events` (+ миграция `task_continuity_events`), daemon (watcher, таймер, git‑события, IPC, автозапуск), handoff brief, `baton session *`, MCP `session_*`, серверный джоб истечения lease.

TEST 2, 4, 7, 10. Для TEST 10 — два реальных адаптера (Claude Code hooks/MCP config и Codex MCP config из `src/workspace/mcp-adapters`) в e2e с симулированными MCP‑клиентами; ручная проверка на живых агентах описывается в чек‑листе.

### Итог Phase 6 (ветка `pmi/phase-6-sessions`)

| Пункт | Результат | Проверка |
|---|---|---|
| Session State, статусы | `src/domain/session.ts`: `SessionState` (SESSION_CONTINUITY.md §2), 8 статусов, переходы, ограничение 64 KiB со сворачиванием длинных списков, детерминированный Handoff Brief через secret‑filter | `tests/domain/session.test.ts` |
| Локальное хранение | Миграция `baton-2-session-continuity`: `baton_sessions`, `session_checkpoints` (неизменяемые), `session_outbox` (упорядоченная доставка) | `tests/session/daemon.test.ts` |
| Сервер | Миграция `0003-sessions`: `work.sessions`, `work.checkpoints` с RLS (state — только developer+); lease с продлением; истечение lease → `resumable` (`interrupted` без checkpoint) периодически и перед list/resume; handoff с адресным резервом на 24 ч; resume: тот же пользователь — та же сессия, другой — дочерняя (`parent_session_id`), родитель закрывается как продолженный; `--force` — maintainer, в аудит; checkpoint от устройства, потерявшего сессию, сохраняется как `orphan` | `tests/central/sessions.test.ts` |
| Daemon | `baton daemon run|start|stop|status`, автозапуск в Connected mode из `session start`/`resume` и MCP. Без участия агента: `fs_change` (изменения улеглись `BATON_CHECKPOINT_DEBOUNCE_MS`), `commit` (сдвинулся HEAD), `timer` (непрерывные изменения дольше `BATON_CHECKPOINT_INTERVAL_MS`); агент умер (pid процесса MCP‑сервера) или молчит `BATON_AGENT_IDLE_MS` → `exit` checkpoint и освобождение; SIGTERM → `exit` checkpoint; продление lease, доставка outbox | `tests/session/daemon.test.ts`, TEST 4 |
| CLI | `baton session start --task --objective --model`, `checkpoint`, `handoff [--to]`, `list [--all]`, `resume <id>`, `finish [--failed]`, `show`; код 3 — сервер недоступен, данные в очереди | TEST 2 |
| MCP | `session_checkpoint`, `session_handoff`, `session_list`, `session_resume`, `session_finish` (`src/mcp/tools/session.ts` — первый модуль инструментов вне `server.ts`, с явным контекстом); `baton_session_start` принимает `task/objective/model` и показывает сессии, ждущие продолжения; любой вызов инструмента — активность агента | TEST 10 |
| **TEST 2** | CLI: Alice (claude-code) start → 2 checkpoint → handoff; Bob (codex, другой пользователь и устройство) list → resume получает выполненные шаги, pending, next action, objective, изменённые файлы | ✔ |
| **TEST 10** | Конфиги, записанные `baton setup` для Claude Code (`.claude/settings.json`) и Codex (`~/.codex/config.toml`), запускают MCP‑сервер; Claude Code передаёт сессию через `session_handoff`, Codex видит её в `baton_session_start`, продолжает через `session_resume` | ✔ |
| **TEST 4** | Агент убит `kill -9` без handoff: daemon уже сделал checkpoint по изменениям файлов, освободил сессию; Bob продолжает с шагами и файлами. Вариант «машина потеряна»: убиты агент и daemon, сервер по истечении lease делает сессию `resumable` | ✔ (оба) |
| **TEST 7** | Агенты двух пользователей одновременно в одном проекте: обе сессии активны, у каждой свои checkpoints и шаги | ✔ |

**Отличия от проекта и перенос** (с обоснованием):
- **Baton‑состояние сессии в отдельной таблице `baton_sessions`**, а не в колонках `sessions`: upstream переписывает `sessions` через `INSERT OR REPLACE`, что стирало бы добавленные колонки. Связь 1:1 по id.
- **Отдельный outbox для сессий** (`session_outbox`), а не sync‑движок памяти: checkpoints — неизменяемые события, а lease/handoff/resume требуют ответа сервера; построчный diff с LWW к ним не подходит. Память по‑прежнему идёт через sync‑движок.
- **Daemon опрашивает рабочую копию** (`git status` + mtime/size), а не подписывается на события файловой системы: одинаково на всех ОС, без зависимостей; триггеры те же. Git‑хуки → IPC не нужны: сдвиг HEAD виден в следующем тике (по умолчанию 5 с).
- **Содержимое файлов при resume не переносится** — это Phase 7 (Workspace Recovery). Resume Package уже содержит ветку, HEAD, список изменённых файлов и `snapshot: null`; CLI и MCP прямо об этом сообщают.
- **`session_events` не выделены в таблицу**: шаги, решения, проблемы и наблюдения живут в state и в каждом checkpoint; миграция `task_continuity_events` — вместе с переносом continuity‑инструментов при разрезке `server.ts`.
- **Path‑leases** — не сделаны; параллельная работа обеспечивается сессионными lease (TEST 7). Локальные `team_file_lock` удалены при очистке после Phase 11.
- **TEST 9 для сессий**: RLS и роли проверены в `sessions.test.ts` (viewer видит список без state, не может читать детали и писать; чужие сессии недоступны для записи). Полное расширение TEST 9 на snapshots — в Phase 7.

## Phase 7 — Workspace recovery

Snapshot builder, blob store (локальный и серверный), инкрементальная загрузка, restore в worktree / in‑place, проверки конфликтов, страховочные snapshot, retention/GC, исключение секретов.

TEST 3 + негативные тесты из WORKSPACE_RECOVERY.md §10.

### Итог Phase 7 (ветка `pmi/phase-7-workspace`)

| Пункт | Результат | Проверка |
|---|---|---|
| Snapshot | `src/workspace-snapshot/snapshot.ts`: манифест + полные тела всех изменённых, удалённых, переименованных и неотслеживаемых файлов (SHA‑256, content‑addressed), staged‑содержимое из индекса (по `git status --porcelain=v2`, без применения патчей), права и симлинки, `git bundle` незапушенных коммитов, патчи для просмотра. Секреты (по имени и содержимому) и файлы > 50 MiB исключаются и перечисляются; исключённое не попадает и в патчи. Рабочая копия не меняется | `tests/workspace-snapshot/snapshot-restore.test.ts` |
| Restore | `src/workspace-snapshot/restore.ts`: сначала проверяются все blobs; импорт base и незапушенных коммитов из bundle; по умолчанию новый worktree (своя ветка, если исходная уже есть у получателя); in place — только чистая копия на том же HEAD; файл, отличающийся от base snapshot, не перезаписывается (версия snapshot рядом, `.baton-<id>`); точный индекс; пересчёт SHA‑256 каждого файла; пути вне рабочей копии и в `.git` отклоняются | там же |
| Локально | Миграция `baton-3-workspace-snapshots`, blobs в `<data>/blobs` (gzip); одинаковый snapshot сессии не создаётся повторно; retention и GC | там же |
| Сервер | Миграция `0004-workspace-snapshots`: `work.blobs` (< 256 KiB в Postgres, больше — том `BATON_BLOB_DIR`), `work.project_blobs` (blob виден проекту только после загрузки его участником — нет оракула «есть ли у кого‑то такой хэш»), `work.snapshots`, `work.snapshot_blobs`; RLS (developer+); регистрация проверяет хэш манифеста и наличие всех blobs (412); retention §7 и GC (`baton-server gc`, каждые 6 ч); restore пишется в аудит | `tests/central/workspace-recovery.test.ts` |
| Сессии | Checkpoints с триггерами `timer/fs_change/commit/manual/exit/handoff` прикладывают snapshot (если есть незакоммиченное или незапушенное); handoff‑snapshot закреплён; загрузка инкрементальная через outbox перед checkpoint; Resume Package содержит snapshot; `baton session resume` и MCP `session_resume` восстанавливают в новый worktree, daemon дальше следит за ним | там же, `tests/session/daemon.test.ts` |
| CLI / MCP | `baton workspace snapshot|restore|list|show [--patch]|upload|gc`; MCP `workspace_snapshot`, `workspace_restore`; коды 2 — отказ/конфликты (ничего не перезаписано), 3 — сервер недоступен | |
| **TEST 3** | 3 изменённых файла, удалённый, неотслеживаемый, бинарный, переименование, staged + unstaged в одном файле, исполняемый, симлинк, незапушенный коммит, игнорируемый артефакт, `.env` с ключом → snapshot → чистый клон Боба с отдельным каталогом данных: все пути совпадают побайтно, совпадают HEAD, `git status`, `git diff --cached`, `git diff`; рабочая копия Боба не тронута; `.env` исключён | ✔ (модуль и e2e) |
| Негативные (§10) | Повторный snapshot после изменения одного файла загружает 2 blob (файл + патч); испорченный на сервере blob → отказ, на диске ничего; `--in-place` в грязную копию → код 2, файлы целы; конфликт с base → файл получателя цел, `.baton-<id>` создан; `.env` исключён; большой файл в томе восстанавливается точно; чужой проект — 404, viewer — 403/404 | ✔ |

**Отличия от проекта** (с обоснованием):
- **Индекс восстанавливается по содержимому, а не патчем** (`git update-index --cacheinfo` со staged‑телами): patch не применяется при расхождениях, тела — всегда. Патчи сохраняются для просмотра.
- **Сжатие gzip, а не zstd**: zstd в Node появился только в 23.8, проект поддерживает 22.18.
- **Нет таблицы `blobs_index`**: наличие blob — это файл в хранилище, загрузку отслеживает сервер (`blobs/missing`).
- **Страховочный snapshot перед `--in-place` не нужен**: in place разрешён только на чистой копии на том же HEAD, её состояние полностью в git.
- **Workspace lease `branch:<repo>/<branch>` и `--via-branch`** не сделаны: restore по умолчанию идёт в новый worktree со своей веткой, а in place требует чистую копию, поэтому перезаписи чужой ветки не бывает. Шифрование blobs — Phase 10.
- **Viewer получает 404 на детали snapshot** (RLS скрывает строку) и 403 на blobs проекта (проверка роли) — оба запрещают доступ к содержимому.

## Phase 8 — Context engine

L1 overview + кэш, серверный hybrid search (tsvector + pgvector + RRF), ранжирование с учётом сессии/файлов/git, упаковка в бюджет, L3, метрики и `/metrics`, оценка экономии токенов + бенчмарк.

TEST 6, существующие evaluation‑гейты не деградируют.

### Итог Phase 8 (ветка `pmi/phase-8-context`)

| Пункт | Результат | Проверка |
|---|---|---|
| Ядро | `src/context/engine.ts` (без I/O, общее для сервера и клиента): L1 overview по шаблону (≤ 800 токенов, confirmed/observed первыми, inferred помечены), L2‑ранжирование по формуле §4 (task lens из codegraph, confidence, свежесть, `needs_review` × 0.6, file/component/git‑affinity), упаковка в бюджет с гарантиями §5 и ступенями сжатия full → title + facts → title + id, указатель «+N not shown», дедупликация, пометка [CONFLICT] для конфликтов, L3 только по запросу (упорядочен по релевантности), secret‑filter, receipt | `tests/context/engine.test.ts` |
| Сервер | Hybrid search: tsvector (`ts_rank_cd`) + pgvector cosine, RRF; без эмбеддингов — keyword без ошибки. Эмбеддинги — провайдеры upstream (`BATON_EMBEDDING`, 384 измерения), фоновое заполнение, сброс вектора при правке. Миграция `0005-context`: кэш L1 `memory.overviews` (пересборка при изменении overview‑категорий, не чаще раза в 10 минут), `work.metrics_events`. `POST /v1/projects/:id/context`, `GET /v1/projects/:id/overview`; `/v1/.../search` теперь hybrid | `tests/central/context.test.ts` |
| Метрики | `/metrics` (Prometheus, `BATON_METRICS_TOKEN`): HTTP‑запросы по маршрутам, время и число сборок контекста, токены, попадания в кэш L1, извлечения памяти, память по категориям, сессии по статусам, `session_recovery_total`, `workspace_recovery_total`, blobs; `context_tokens` по сессиям в `work.metrics_events` | там же |
| Экономия токенов | `src/context/local.ts`: оценка baseline (README, манифесты, файлы задачи и сессии, `git log -n 50 --stat`) и `savings = 1 − delivered / baseline` в каждом receipt `context_build` | `tests/server/baton-context-tools.test.ts` |
| MCP | `context_build`, `project_overview`, `memory_search`, `memory_get`, `memory_save`, `decision_log` (`src/mcp/tools/context.ts`). В Connected mode — сервер (вся общая память), иначе тот же движок над локальной памятью. `memory_save`/`decision_log` пишут категорию и confidence (агент — только observed/inferred/proposed; `storeObservation` понижает иное до `proposed`); решение добавляется в state сессии и даёт checkpoint `decision` | там же |
| Daemon | Синхронизирует память проекта для рабочих копий живых сессий (`BATON_MEMORY_SYNC_MS`, 60 с) под общим с `baton sync` файловым замком | TEST 1 (Baton‑инструменты) |
| **TEST 6** | 500 записей и 200 сессий: на сервере (Postgres) и локально (MCP без сервера) `session_start` + `context_build` — receipt ≤ 2300 токенов, нет записей session_history, устаревших знаний и секции History; нужное для задачи (подтверждённое решение, исправление, соглашение, next action) на месте | ✔ (оба режима) |
| **TEST 1** на Baton‑инструментах | Claude Code Алисы: `decision_log` → daemon сам отправляет → Codex Боба: `context_build` (server) содержит решение, `decision_log list` его находит; без ручного `baton sync` | ✔ |

**Отличия и перенос** (с обоснованием):
- **Измеренная экономия на живых агентах** (бенчмарк «с Baton / без Baton» на реальной модели) не выполнена: в этой среде нет запуска агентов с замером их токенов. Есть оценочная цифра в каждом receipt и проверка, что она положительна на фикстуре. Бенчмарк — Phase 10.
- **Дедупликация похожих записей, эвристика противоречий, устаревание по времени** (CONTEXT_ENGINE.md §6) — не новые механизмы этой фазы: точные дубли схлопываются при упаковке, конфликты одновременной правки помечаются [CONFLICT]; правила устаревания по git — Phase 9.
- **Офлайн‑поиск** `memory_search` использует лексическое ранжирование движка над локальной памятью, а не BM25/векторный поиск upstream (`baton_search` остаётся доступен).
- **Разрезка `src/server.ts` и миграция mini‑skills в `coding_convention`** по‑прежнему не выполнены. Все новые Baton‑инструменты живут в отдельных модулях `src/mcp/tools/*` с явным контекстом; перенос 37 унаследованных инструментов — отдельная задача без изменения поведения (страховка — snapshot‑тест поверхности). Выполнено — см. следующий раздел.

### Итог: отложенные рефакторинги Phase 3–8 (ветка `baton/refactor-deferred`, поверх `pmi/phase-8-context`)

| Пункт | Результат | Проверка |
|---|---|---|
| Разрезка `src/server.ts` | 37 унаследованных инструментов перенесены в модули `src/mcp/tools/`: `memory`, `retrieval`, `project-brief`, `maintenance`, `integrations`, `baton-session`, `dashboard`, `team` (и `skills` до удаления ниже); каждый экспортирует `registerXTools(server, ctx)`. Изменяемое состояние подключения (`project`, `projectDir`, `projectResolved`, `graphManager`, `teamStore`, `currentAgentId`, `connectionSessionId`, граница Autopilot) и связанные с ним помощники передаются через `ServerToolContext` (`src/mcp/tools/server-context.ts`) — аксессоры вместо замыканий, поэтому перепривязка проекта (`switchProject`) по‑прежнему видна всем инструментам. Чистые помощники — `src/mcp/tools/helpers.ts`. `server.ts`: 5,4 тыс. → 1,1 тыс. строк, остался жизненный цикл | `tests/server/tool-surface-snapshot.test.ts` проходит **без обновления** снимка; перед переносом добавлен второй снимок — полный `tools/list` (title, description, annotations и JSON Schema каждого инструмента); весь `npm test` |
| Миграция mini‑skills | Аддитивная миграция `baton-5-mini-skills-to-conventions` (`src/store/sqlite-db.ts`, с резервной копией, как у всех `baton-`): каждая строка `mini_skills` (или ещё не импортированный `mini-skills.json`) один раз копируется в `observations` — `type how-it-works`, `category coding_convention`, `confidence observed` (подтверждает человек, не миграция), `valueCategory core` (не стареет, как и mini‑skill), `topicKey mini-skill/<id>/<fingerprint>`; инструкция, условие применения и исходные наблюдения — в narrative, факты и теги сохраняются. Таблица `mini_skills` не меняется. id выделяются после всех занятых, включая ещё не импортированный `observations.json` | `tests/store/baton-migration.test.ts`: хранилище со строками `mini_skills`, JSON‑источник, идемпотентность, mini‑skills с одним id на двух машинах |
| Удаление подсистемы | Удалены `baton_skills`, `baton_promote`, `src/skills/mini-skills.ts`, `src/store/mini-skill-store.ts`, `baton memory promote`, официальный skill `baton-mini-skills` (и в шаблонах `plugins/*`), индексация mini‑skills в Orama и freshness, provenance‑вывод, проверка в `doctor`. Замены: `baton_session_start` внедряет активные `coding_convention` проекта (до 20, с прежним фильтром шума) вместо mini‑skills; ссылка `skill:<id>` в `baton_detail` открывает сконвертированную запись; в dashboard раздел «Promoted Skills» стал «Coding Conventions». Профили, `capability-map`, счётчик profile‑parity (full: 50 → 48) и снимок поверхности обновлены намеренно — из снимка удалены только эти два инструмента | `tests/server/baton-context-tools.test.ts` (внедрение конвенций), `tests/compact/engine.test.ts` (`skill:<id>`), `tests/wiki/*`, весь `npm test` |

**Отличия и перенос** (с обоснованием):
- **Порядок `tools/list`** изменился: инструменты регистрируются по модулям, а не в прежнем порядке файла. Клиенты MCP от порядка не зависят; содержимое каждого инструмента не изменилось (снимок сравнивает инструменты по имени).
- **Описание `baton_detail`** по‑прежнему упоминает mini‑skill и `skill:3`: такие ссылки работают через сконвертированную запись, а правка описания вышла бы за рамки намеренного изменения снимка (только два удалённых инструмента).
- **CLI `baton skills`** (генерация `SKILL.md` из паттернов памяти, `src/skills/engine.ts`) оставлен: это интеграция с агентами, а не mini‑skills.
- **Таблица `mini_skills`** остаётся в схеме как источник миграции; удалить её можно только отдельной миграцией после выпуска версии с `baton-5`.

## Phase 9 — Git intelligence

Курсоры, конвейер `cursor..HEAD`, `--name-status`/parents, классификаторы, устаревание связанных знаний, полная сверка, хуки post‑merge/post‑checkout.

TEST 5.

### Итог Phase 9 (ветка `pmi/phase-9-git`)

| Пункт | Результат | Проверка |
|---|---|---|
| Конвейер | `src/git/pipeline.ts`: читается только `cursor..HEAD` (`rev-list --reverse --topo-order`); переписанная история (rebase, force push, reset) — от merge‑base с пометкой `rewritten`; первый запуск — окно последних `BATON_GIT_INITIAL_COMMITS` (50) коммитов; один `git log --raw -M --numstat` на 50 коммитов; diff манифестов и дерево верхнего уровня родителя — только для коммитов, которым они нужны; root commit вычисляется один раз и кэшируется; git‑раннер внедряемый | `tests/git/analyze-local.test.ts` (перехват всех вызовов git) |
| Классификаторы | `src/git/classify.ts`, без LLM: зависимости (npm, pip, go, cargo, pyproject, composer, gem — добавлено/удалено/обновлено), API/контракты, структура (новые части верхнего уровня, Docker/CI/сборка), удалённые файлы, исправления (conventional `fix:`, `fixes #N`), ограничения рантайма, бизнес‑логика по `domainPaths` из `.baton/project.json`; merge‑коммиты не классифицируются повторно | там же |
| Знания | На каждый коммит — `git_history` (observed); на каждый сработавший класс — `inferred`‑запись нужной категории, связь `derived_from` с коммитом; topic key на коммит — повторный анализ обновляет, а не дублирует | там же, `tests/central/git-analyze.test.ts` |
| Устаревание | Коммит изменил, переименовал или удалил связанные файлы → `observed/inferred` знание получает пометку review (статус Baton `needs_review`, хранится отдельно от статуса upstream — `observations.review`, локальная миграция `baton-4-git-intelligence`; снимается при перезаписи памяти); удалены все файлы → «рассмотреть deprecate»; `confirmed` не меняется — создаётся задача review (`active_task`); записи моложе 24 ч до коммита (о самом изменении) не помечаются | оба теста |
| Полная сверка | `baton git analyze --full`: все `related_files` активного знания проверяются в дереве HEAD; отсутствующие → review; отметка `last_full_reconcile_at` | оба теста |
| Connected mode | Миграция `0006-git-intelligence`: `work.git_cursors` (общий курсор на репозиторий и ветку), `work.git_commits`; RLS. Клиент анализирует диапазон и отправляет результат; сервер атомарно (ожидаемый курсор, иначе `409 cursor_moved` и повтор) записывает коммиты, сам создаёт записи (writer `baton-server`, клиенты получают их через sync), помечает устаревшее, двигает курсор, пишет аудит. `GET /v1/projects/:id/git/cursor`, `POST .../git/commits`, `GET .../git/related-files`, `POST .../git/reconcile` | `tests/central/git-analyze.test.ts` |
| Запуск | `baton git analyze [--full] [--auto] [--json]`; хуки `post-commit`, `post-merge`, `post-checkout` (`baton git-hook`) вызывают `baton git analyze --auto` в фоне; ранее установленный `ingest commit --auto` стал обёрткой над тем же анализом; daemon анализирует рабочие копии живых сессий в Connected mode перед синхронизацией памяти; MCP `git_analyze`; метрика `baton_git_commits_analyzed_total` | `tests/git/hooks.test.ts` |
| **TEST 5** | 5 коммитов (зависимость, API, удаление, fix, rename): обработано ровно 5, курсор сдвинут, записи по классам, связанная запись о переименованном файле — needs_review, повтор — 0 коммитов; git вызывается только для коммитов `cursor..HEAD` (перехват раннера). В Connected mode две машины запускают анализ одновременно — суммарно 5, без повторов; знание и пометка доходят до второй машины через sync | ✔ (оба режима) |

**Отличия и перенос** (с обоснованием):
- **Сигнатуры экспортируемых символов через codegraph** для класса API не используются: правило — пути роутинга/контрактов. Подключение codegraph к анализу коммитов — после разрезки `server.ts` (отдельная сессия), где живёт инициализация codegraph.
- **LLM‑обобщение коммитов (`BATON_GIT_LLM`)** не делалось — опция ТЗ, без неё анализ полностью детерминирован.
- **Плановая еженедельная сверка на сервере** не нужна в виде джоба: сервер не видит рабочую копию; сверку запускает клиент (`--full`), сервер хранит `last_full_reconcile_at`.
- **В Local mode daemon не анализирует коммиты** (это делают хуки, CLI и MCP): локальная запись памяти требует инициализации хранилища наблюдений в процессе daemon.

## Phase 10 — Hardening

Security review (auth, RLS, path traversal в restore, zip‑slip в bundle, размеры тел), шифрование blobs, TLS‑конфигурация, нагрузочный тест (100k записей, 20 клиентов), backup/restore drill, чек‑лист эксплуатации, полная документация пользователя и оператора, финальный прогон всех 10 acceptance‑тестов в Docker Compose‑окружении.

### Итог Phase 10 (ветка `pmi/phase-10-hardening`)

| Пункт | Результат | Проверка |
|---|---|---|
| Security review | [SECURITY.md](SECURITY.md): модель угроз, соответствие ТЗ §14, 7 находок с исправлениями. Главные: запись вне рабочей копии через симлинк при restore; `BATON_TOKEN` отправлялся на сервер из чужого `.baton/project.json`; нет защиты от подбора токенов и slow‑loris | `tests/workspace-snapshot/snapshot-restore.test.ts`, `tests/client/config.test.ts`, `tests/central/security.test.ts` |
| Шифрование blobs | AES‑256‑GCM (`BATON_BLOB_KEY`), адрес по содержимому не меняется, старые открытые blobs читаются, ротация (`BATON_BLOB_KEYS_OLD`, `reencrypt-blobs`), `verify-blobs` | `tests/central/security.test.ts`, Compose‑прогон |
| TLS | Caddy (Let's Encrypt / локальный CA), клиент не шлёт токен по HTTP на нелокальный адрес; `BATON_TRUST_PROXY` для адреса клиента | Compose‑прогон (всё по HTTPS) |
| Нагрузочный тест | 100 000 записей, 20 клиентов: найдены и устранены три узких места (RLS на каждую строку, кандидаты контекста, блокировка счётчика ленты); итог p95 — context 358 мс, search 156 мс, push 253 мс, feed 57 мс, 0 ошибок ([LOAD_TEST.md](LOAD_TEST.md)) | `tests/load/central-load.test.ts` (`BATON_LOAD_TEST=1`) |
| Backup/restore | `deploy/backup.sh` / `restore.sh` (pg_dump + том blobs + MANIFEST с SHA‑256, `pre-restore.dump`, проверка каждого blob); `baton backup` / `baton restore` для локального хранилища | `tests/cli/backup.test.ts`, учения в Compose‑прогоне |
| Документация | [OPERATIONS.md](OPERATIONS.md) (развёртывание, конфигурация, доступ, резервные копии, обновление, ротация ключей, мониторинг, чек‑лист), [USER_GUIDE.md](USER_GUIDE.md), [SECURITY.md](SECURITY.md), [LOAD_TEST.md](LOAD_TEST.md) | |
| **Финальный прогон** | `deploy/acceptance.sh`: стек Compose собирается и стартует; все приёмочные наборы `tests/central` (TEST 1–10 и тесты RBAC, сессий, снимков, контекста, git, безопасности) на Postgres развёртывания; затем `tests/compose` — контейнерный `baton-server` за Caddy по HTTPS с шифрованием, две машины с реальным CLI, учения backup → удаление томов → restore → восстановление рабочей копии на новой машине. В CI — задача `compose-acceptance` | ✔ (74 + 5 тестов) |

### Приёмочные тесты ТЗ — сводка

| Тест | Что проверяет | Где | Статус |
|---|---|---|---|
| TEST 1 | Решение агента одного пользователя доходит до агента другого без поиска по файлам | `tests/central/cross-user-context.test.ts` (baton‑ и Baton‑инструменты, без ручного sync) | ✔ |
| TEST 2 | Handoff из CLI другому пользователю: шаги, next action, файлы | `tests/central/session-continuity.test.ts` | ✔ |
| TEST 3 | Незакоммиченная работа восстанавливается побайтно на другой машине | `tests/workspace-snapshot/snapshot-restore.test.ts`, `tests/central/workspace-recovery.test.ts`, Compose | ✔ |
| TEST 4 | Агент убит без handoff (и машина потеряна) — работа продолжается с автоматического checkpoint | `tests/central/session-continuity.test.ts` | ✔ |
| TEST 5 | Инкрементальный git‑анализ: ровно новые коммиты, классы, устаревание, повтор — 0 | `tests/git/analyze-local.test.ts`, `tests/central/git-analyze.test.ts`, Compose | ✔ |
| TEST 6 | 500 записей и 200 сессий — контекст ≤ 2300 токенов без истории | `tests/central/context.test.ts`, `tests/server/baton-context-tools.test.ts`, Compose | ✔ |
| TEST 7 | Параллельные сессии разных пользователей не мешают друг другу | `tests/central/session-continuity.test.ts`, `tests/central/sessions.test.ts` | ✔ |
| TEST 8 | Офлайн‑запись копится и доставляется после восстановления сервера | `tests/central/offline-sync.test.ts`, Compose | ✔ |
| TEST 9 | Без гранта — 404 везде, прямой SQL под пользователем — 0 строк | `tests/central/rbac.test.ts`, Compose | ✔ |
| TEST 10 | Реальные адаптеры Claude Code и Codex: handoff и resume через MCP | `tests/central/session-continuity.test.ts` | ✔ |

**Что остаётся за рамками** (с обоснованием):
- **Экономия токенов на живых агентах не измерена**: в этой среде нельзя запускать агентов с учётом их токенов. Есть оценка в каждом receipt (`estimatedSavings`) и проверка на фикстуре. Бенчмарк «с Baton / без Baton» на реальной модели — следующий шаг эксплуатации.
- **Ручной чек‑лист на живых агентах** (Claude Code, Codex в настоящем IDE) не проводился; TEST 10 запускает MCP‑серверы ровно по конфигам `baton setup`, но клиент MCP — тестовый.
- **Разрезка `src/server.ts` и перенос mini‑skills** выполнены отдельной сессией и слиты в ветку `pmi/integration` вместе со всеми фазами: `server.ts` — 909 строк, инструменты в `src/mcp/tools/*`; mini‑skills — записи `coding_convention` (миграция `baton-5-mini-skills-to-conventions`, ключ с отпечатком навыка, чтобы одинаковые локальные id разных машин не сливались), подсистема и инструменты `baton_skills`/`baton_promote` удалены (full — 49 инструментов).

## Phase 11 — Web UI

Вне исходного ТЗ: просмотр состояния без CLI и `curl`, и место, где люди подтверждают знания (ТЗ требует подтверждения человеком, а до этого оно было доступно только через API). Подробности — [WEB_UI.md](WEB_UI.md).

| Пункт | Результат | Проверка |
|---|---|---|
| Интерфейс | React 19 + Mantine 9, сборка Vite (`npm run build:ui`) в `dist/server/central/ui` |
| Раздача | `/ui/` из `baton-server`: файлы в памяти, CSP без inline‑кода (nonce для стилей Mantine), без cookies; `BATON_UI=0` отключает | `tests/central/web-ui.test.ts` |
| API | `GET /v1/projects/:id/stats` (подсчёты под RLS), `GET /v1/projects/:id/audit` (maintainer+), `offset` у списка знаний, email авторов в записях и версиях | `tests/central/web-ui.test.ts` |
| Страницы | проекты; обзор проекта; знания с фильтрами и поиском; запись с историей и кнопками «Подтвердить» / «Пометить устаревшим»; сессии и сессия (handoff brief, checkpoints, снимки); конфликты; журнал аудита; поиск по всем проектам; RU/EN; светлая и тёмная темы; ширина телефона | ручная проверка на демо‑сервере |

### Очистка после Phase 11 (`pmi/cleanup-2`)

| Удалено | Почему | Что осталось |
|---|---|---|
| Публикация upstream: `publish.yml`, `server.json`, синхронизация манифестов MCP Registry и плагинов, проверка обновлений npm | Workflow публиковал пакет и запись MCP Registry upstream; проверка обновлений предлагала поставить пакет upstream поверх нашего | `package.json` помечен `"private": true` |
| Старый дашборд: `src/dashboard`, `/api/*` и статика в `serve-http`, `baton dashboard`, `baton_dashboard`, `src/wiki` | Заменён веб‑интерфейсом `baton-server` (Phase 11) | `serve-http` отвечает на `/mcp`, `/health`, `/protocol-diagnostics`, остальное — 404 |
| Координация агентов: задачи, сообщения, file locks, роли, `poll`, `handoff`‑заметки, event bus; MCP `team_task`, `team_message`, `team_file_lock`, `baton_poll`, `baton_handoff`; CLI `task`, `message`, `lock`, `poll`, `handoff`; навык `baton-orchestrate`; `TEAM.md` | Работали только внутри одной SQLite; передачу работы делают `session_handoff` / `baton session handoff`, параллельную работу — lease сессий | Реестр агентов (`team_manage join/leave/status`, `baton identity`, `session_start joinTeam`) — от него зависят атрибуция и видимость `personal`/`team`. Таблицы `team_tasks`, `team_messages`, `team_locks`, `team_roles` не удаляются (данные не теряются), код их больше не читает |
| Документация и конфиги upstream: `docs/*` вне `docs/baton`, `CHANGELOG.md`, корневой `compose.yaml`, `examples/`, `.trae/rules`, `.windsurf/workflows`, `bun.lock`, правила игнорирования memcode | Спецификации и история upstream 1.x, одиночный контейнер upstream, ручные конфиги агентов (их пишет `baton setup`), личные настройки авторов upstream; сборка идёт через npm | Документация — `docs/baton`, развёртывание — `deploy/` |
| Временные каталоги в корне репозитория | Тесты конфигурации и backfill писали `.tmp-*-test` и `data/baton` в рабочую копию | Тесты пишут во временный каталог ОС и убирают за собой |

### Переименование в Baton Hub (`baton/rename`)

Проект называется **Baton Hub**. Команды, файлы и переменные — `baton`; старые имена удалены без совместимости, потому что проект ещё нигде не развёрнут.

| Было | Стало |
|---|---|
| CLI `pmi` и `memorix`, сервер `pmi-server` | `baton`, `baton-server` |
| MCP‑сервер `memorix` в конфигах агентов, инструменты `memorix_*`, навыки и плагины `memorix-*` | `baton`, `baton_*`, `baton-*` |
| `~/.pmi`, `~/.memorix`, `.pmi/project.json`, `memorix.yml` / `memorix.toml` | `~/.baton`, `.baton/project.json`, `baton.yml` / `baton.toml` |
| Переменные `PMI_*` и `MEMORIX_*` | `BATON_*` (имена не пересекались) |
| Токены `pmi_pat_…`, метка шифрования блобов `PMIE1` | `baton_pat_…`, `BTNE1` |
| Compose‑проект `pmi`, сервис `pmi-server`, база и пользователь Postgres `pmi`, роль `pmi_app`, таблицы `pmi_*` в SQLite | `baton`, `baton-server`, `baton`, `baton_app`, `baton_*` |
| `docs/PMI` | `docs/baton` |

Без изменений: `LICENSE` и `AUDIT.md` (разбор исходного кода upstream), имена старых веток в этом файле и репозиторий GitHub `caaatpro/pmi`.

## Риски

| Риск | Митигирующее действие |
|---|---|
| Объём upstream‑кода затрудняет изменения | Phase 3 сокращает кодовую базу до начала новых функций |
| Расхождение с upstream | Форк самостоятелен: remote и ветки upstream удалены, исправления оттуда не переносятся |
| Тесты Postgres требуют Docker | Хелпер с явным skip‑сообщением локально, обязательный прогон в CI |
| Хуки агентов различаются | Daemon не зависит от хуков (SESSION_CONTINUITY.md §4) |
| Большие рабочие копии | Лимиты размера, исключения, инкрементальные blobs |
| Ложные противоречия/устаревание | Только пометки и review, никаких автоматических изменений `confirmed`‑знаний |

## Принятые решения

| Решение | Где описано | Как сделано |
|---|---|---|
| Список удалений upstream‑кода | AUDIT §13 | Phase 3, очистки после Phase 11 (`pmi/cleanup-2`) |
| Имя `baton` везде, без алиасов `pmi` и `memorix` | раздел «Переименование в Baton Hub» | `baton/rename` |
| При resume другим пользователем — новая дочерняя сессия | SESSION_CONTINUITY.md §3 | Phase 6: `parent_session_id`, родитель закрывается как продолженный |
| Workspace восстанавливается по умолчанию в новый worktree | WORKSPACE_RECOVERY.md §5 | Phase 7: `--in-place` только в чистую копию на том же HEAD |
| Без Redis в первой версии | ARCHITECTURE.md D5 | Redis не используется; фоновые задачи (embeddings, истечение lease, retention) — таймеры в процессе `baton-server`. Таблица `jobs` и `LISTEN/NOTIFY` из D5 не понадобились, пока инстанс один |
