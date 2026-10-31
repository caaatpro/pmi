# PMI — интерфейсы: REST, MCP, CLI

Статус: Phase 2 — проект. **Реализовано в Phase 4:** `/health`, `/ready`, `/v1/me`, `GET /v1/projects`, `POST /v1/projects/resolve`, `GET /v1/projects/:id`, `GET /v1/projects/:id/memories`, `GET /v1/projects/:id/conflicts`, `GET /v1/memories/:mid?include=versions`, `POST /v1/sync/push`, `GET /v1/projects/:id/changes`; CLI `pmi login|logout`, `pmi project link|show`, `pmi sync [push|pull|status]`, `pmi-server migrate|serve|create-org|create-user|add-member|issue-token|revoke-token`. **Phase 5:** `PUT /v1/projects/:id/grants` (`{user|team, role|null}`), `POST /v1/orgs/:org/teams`, `POST /v1/orgs/:org/teams/:team/members`, `POST /v1/projects/:id/search`, `POST /v1/search` (кросс‑проектный, по всем читаемым проектам), `POST /v1/memories/:mid/confirm|deprecate` (`{reason?}`), `POST /mcp` (инструменты `project_list`, `memory_search`, `memory_get`), `pmi-server create-team|add-team-member|grant`. Ошибки доступа: 404, если проект пользователю не виден; 403, если роль ниже нужной. **Phase 6:** `POST|GET /v1/projects/:id/sessions` (`?resumable=true`, `?status=a,b`), `GET /v1/sessions/:sid`, `POST /v1/sessions/:sid/checkpoints|heartbeat|handoff|finish|release|resume` (все записи принимают `device_id`; `release` — освобождение без handoff), MCP `session_checkpoint|session_handoff|session_list|session_resume|session_finish`, CLI `pmi session checkpoint|handoff|list|resume|finish|show`, `pmi daemon run|start|stop|status`. **Phase 7:** `POST /v1/projects/:id/blobs/missing`, `PUT|GET /v1/projects/:id/blobs/:sha256` (blobs адресуются через проект), `POST|GET /v1/projects/:id/snapshots`, `GET /v1/snapshots/:id`, `POST /v1/snapshots/:id/restored` (аудит), MCP `workspace_snapshot|workspace_restore`, `session_resume(restore)`, CLI `pmi workspace snapshot|restore|list|show|upload|gc`, `pmi session resume --worktree|--in-place|--no-restore`, `pmi-server gc`. **Phase 8:** `POST /v1/projects/:id/context` (`{task, session_id?, files?, components?, recent_git_files?, budget_tokens?, levels?}` → `{text, included, receipt, search}`), `GET /v1/projects/:id/overview`, `POST /v1/projects/:id/search` и `/v1/search` — hybrid (`mode: hybrid|keyword`, `include_deprecated`), `GET /metrics`; MCP `context_build`, `project_overview`, `memory_search`, `memory_get`, `memory_save`, `decision_log`. **Phase 9:** `GET /v1/projects/:id/git/cursor?root_commit&branch`, `POST /v1/projects/:id/git/commits` (`expected_cursor` / `new_cursor`, `409 cursor_moved`), `GET /v1/projects/:id/git/related-files`, `POST /v1/projects/:id/git/reconcile`, MCP `git_analyze`, CLI `pmi git analyze [--full] [--auto]`, `pmi git-hook` (post-commit, post-merge, post-checkout). Остальное — по фазам ROADMAP.md.

Все три интерфейса вызывают одни и те же сервисы (`src/session`, `src/context`, …). Ни один не содержит собственной бизнес‑логики.

## 1. REST API центрального сервера

База: `https://<server>/v1`. Формат JSON. Аутентификация: `Authorization: Bearer pmi_pat_…`. Ошибки: `{ "error": { "code", "message", "details" } }` с HTTP‑статусом (400 валидация, 401, 403, 404, 409 конфликт версии/lease, 412 precondition, 422 доменная ошибка).

Оптимистическая конкуренция: изменяющие запросы к memory/session принимают `If-Match: <version>`; при несовпадении — `409` с текущим состоянием.

Идемпотентность: все `POST`, создающие сущности, принимают `Idempotency-Key` (клиент передаёт id записи outbox). Повтор возвращает исходный результат.

### 1.1 Служебные

| Метод | Путь | Описание |
|---|---|---|
| GET | `/health` | liveness (без `/v1`, без auth) |
| GET | `/ready` | Postgres, миграции, blob store |
| GET | `/metrics` | Prometheus (auth: отдельный токен `PMI_METRICS_TOKEN`) |
| GET | `/v1/me` | Пользователь, организации, проекты и роли |
| GET | `/`, `/ui/` | Веб‑интерфейс (без auth на сами файлы; данные — через `/v1` с токеном), [WEB_UI.md](WEB_UI.md). `PMI_UI=0` отключает |

### 1.2 Организации, доступ

| Метод | Путь | Роль |
|---|---|---|
| POST | `/v1/orgs` | системный admin (bootstrap) |
| GET/POST | `/v1/orgs/:org/members` | admin |
| GET/POST | `/v1/orgs/:org/teams`, `/v1/teams/:id/members` | admin |
| POST | `/v1/auth/tokens` | сам пользователь (выпуск токена устройства) |
| DELETE | `/v1/auth/tokens/:id` | владелец / admin |
| POST | `/v1/devices` | сам пользователь |

### 1.3 Проекты и репозитории

| Метод | Путь | Описание |
|---|---|---|
| GET/POST | `/v1/projects` | список доступных / создать (admin) |
| GET | `/v1/projects/:id` | проект + репозитории + роль вызывающего |
| PUT | `/v1/projects/:id/grants` | выдать/отозвать роль (maintainer) |
| POST | `/v1/projects/:id/repositories` | привязать репозиторий `{root_commit, remote_urls}` |
| POST | `/v1/projects/resolve` | найти проект по `{root_commit, remote_urls, legacy_project_id}` — используется `pmi project link` |
| GET | `/v1/projects/:id/status` | сводка: активные сессии, открытые конфликты, git‑курсор, свежесть overview |
| GET | `/v1/projects/:id/stats` | реализованная сводка (Phase 11): знания по категориям, доверию и статусу, `needsReview`, `unconfirmed`, сессии по статусам, открытые конфликты, курсоры git; считается под RLS (viewer+) |
| GET | `/v1/projects/:id/audit` | журнал аудита проекта, новые сверху, `?limit=&before=<id>` (maintainer+) |

### 1.4 Память

| Метод | Путь | Описание |
|---|---|---|
| GET | `/v1/projects/:id/memories` | фильтры: `category`, `status`, `confidence`, `component`, `file`, `since_seq`, `limit`, `cursor`; реализованы `category`, `status`, `confidence`, `component`, `file`, `limit`, `offset`. Записи содержат `authorEmail`, версии — `changedByEmail` |
| POST | `/v1/projects/:id/memories` | создать; если активная запись с тем же `topic_key` есть — новая версия (как upsert в Memorix) |
| GET | `/v1/memories/:mid` | запись; `?include=versions,links,conflicts` |
| PATCH | `/v1/memories/:mid` | изменить поля, `If-Match`; создаёт версию |
| POST | `/v1/memories/:mid/confirm` | → `confirmed` (developer+, человек) |
| POST | `/v1/memories/:mid/deprecate` | → `deprecated`, `{reason, superseded_by?}` |
| POST | `/v1/memories/:mid/links` | `{to_id, kind}` |
| GET | `/v1/memories/:mid/versions` | история |
| POST | `/v1/projects/:id/search` | `{query, mode: keyword|semantic|hybrid, filters, limit}` |
| GET | `/v1/projects/:id/conflicts` | открытые конфликты |
| POST | `/v1/conflicts/:cid/resolve` | `{keep: a|b|merge, merged?}` |
| GET | `/v1/search` | кросс‑проектный поиск по доступным проектам, только `visibility=organization` |

### 1.5 Контекст

| Метод | Путь | Описание |
|---|---|---|
| GET | `/v1/projects/:id/overview` | L1, кэшированный |
| POST | `/v1/projects/:id/context` | `{task, session_id?, files?, budget_tokens, levels: ["L1","L2"], filters}` → пакет контекста + receipt |
| POST | `/v1/projects/:id/context/history` | L3 по запросу: `{topic|file|memory_id, budget_tokens}` |

### 1.6 Сессии

| Метод | Путь | Описание |
|---|---|---|
| GET | `/v1/projects/:id/sessions` | `status`, `user`, `resumable=true` |
| POST | `/v1/projects/:id/sessions` | создать (`created` → `in_progress`), получить lease |
| GET | `/v1/sessions/:sid` | state, последний checkpoint, snapshot |
| POST | `/v1/sessions/:sid/heartbeat` | продление lease |
| POST | `/v1/sessions/:sid/checkpoints` | `{trigger, state, snapshot_id?}` |
| POST | `/v1/sessions/:sid/events` | пакет `session_events` |
| POST | `/v1/sessions/:sid/handoff` | `{brief, next_action, snapshot_id}` → `waiting_handoff`, lease снимается |
| POST | `/v1/sessions/:sid/resume` | захват lease новым пользователем/устройством; возвращает **Resume Package** (SESSION_CONTINUITY.md §6); 409 если lease активен |
| POST | `/v1/sessions/:sid/finish` | `{status: completed|failed, summary}` |
| GET | `/v1/sessions/:sid/brief` | Handoff Brief (markdown + json) |

### 1.7 Workspace snapshots

| Метод | Путь | Описание |
|---|---|---|
| POST | `/v1/projects/:id/blobs/missing` | `{sha256: [...]}` → какие отсутствуют на сервере (инкрементальная загрузка) |
| PUT | `/v1/blobs/:sha256` | загрузка тела; сервер сверяет хэш |
| GET | `/v1/blobs/:sha256` | скачивание |
| POST | `/v1/projects/:id/snapshots` | регистрация манифеста (все blobs должны быть загружены, иначе 412) |
| GET | `/v1/snapshots/:snap` | манифест |
| GET | `/v1/projects/:id/snapshots` | список, `session_id` |
| POST/DELETE | `/v1/projects/:id/leases` | захват/освобождение workspace lease |

### 1.8 Git

| Метод | Путь | Описание |
|---|---|---|
| GET | `/v1/repositories/:rid/cursor?branch=` | последний проанализированный коммит |
| POST | `/v1/repositories/:rid/commits` | пакет проанализированных коммитов + предлагаемые изменения памяти; сервер двигает курсор транзакционно (`If-Match` по старому курсору) |
| POST | `/v1/repositories/:rid/reconcile` | запрос полной сверки (выполняет клиент, сервер фиксирует отчёт) |

### 1.9 Синхронизация

| Метод | Путь | Описание |
|---|---|---|
| POST | `/v1/sync/push` | `{project_id, batch}`, где `batch` — пакет sync‑движка формата 3 (`ChangeBatch`). Результат по каждой записи: `applied` (+`conflict: true`, если перезаписана одновременная правка) / `duplicate` / `stale` (на сервере версия новее) / `rejected` (`reason`: секрет в тексте, чужой проект, та же версия с другим содержимым). Повтор пакета идемпотентен |
| GET | `/v1/projects/:id/changes?after=<seq>&limit=&legacy=<memorix project id>` | `{changes:[{seq, entry}], hasMore, lastSeq}`; только последнее изменение каждой записи |
| GET | `/v1/projects/:id/changes/wait?after=<seq>` | long‑poll до 25 с (через `LISTEN/NOTIFY`) |

## 2. MCP

Транспорты: stdio (`pmi mcp`, работает через локальный клиент) и Streamable HTTP (`/mcp` на центральном сервере, аутентификация тем же Bearer‑токеном).

Профили видимости из Memorix сохраняются. Профиль по умолчанию для PMI — **`core`** (замена `micro`): 12 инструментов ниже, помеченные ★. Остальные — в `full`.

| PMI‑инструмент | Memorix‑алиас (переходный) | Назначение |
|---|---|---|
| ★ `project_overview` | — | L1 обзор проекта |
| `project_status` | `memorix_codegraph_status` | Состояние: сессии, конфликты, свежесть, git‑курсор |
| ★ `context_build` | `memorix_project_context`, `memorix_context_pack` | L1 + L2 под задачу в бюджете токенов; L3 по флагу |
| ★ `memory_search` | `memorix_search` | Hybrid search |
| ★ `memory_get` | `memorix_detail` | Полная запись(и) по id |
| ★ `memory_save` | `memorix_store`, `memorix_store_reasoning` | Новая запись (`observed/inferred/proposed`) |
| `memory_update` | `memorix_resolve` (частично) | Изменение/архивирование, версия, `If-Match` |
| `memory_conflicts` | — | Список/разрешение конфликтов |
| `decision_log` | — | Запись или список архитектурных решений (ADR‑формат: контекст, решение, альтернативы, последствия) |
| ★ `session_start` | `memorix_session_start` | Новая сессия или подключение к своей активной; возвращает L1 + предложение resume, если есть `resumable` |
| ★ `session_checkpoint` | `memorix_compaction_checkpoint` | Явный checkpoint: progress, completed/pending steps, next action |
| ★ `session_finish` | `memorix_session_end` | Завершение |
| ★ `session_handoff` | `memorix_handoff` | Полный handoff (SESSION_CONTINUITY.md §5) |
| ★ `session_resume` | `memorix_session_context` | Resume Package |
| ★ `session_list` | — | Сессии проекта, фильтр `resumable` |
| `workspace_snapshot` | — | Снимок рабочей копии (требует локальный клиент) |
| `workspace_restore` | — | Восстановление (требует локальный клиент; по умолчанию в новый worktree) |
| `git_analyze` | — | Инкрементальный анализ с курсора; `full=true` — полная сверка |
| `project_sync` | — | Принудительный push/pull, статус outbox |

Удаляемые из MCP (Phase 3): `memorix_media`, `memorix_ingest_image`, `memorix_promote`, `memorix_skills` (удалены после миграции mini‑skills в `coding_convention`, `pmi-5`), KG‑compat (9 шт.). Сохраняемые в `full`: `memorix_timeline`, `memorix_graph_context`, `memorix_retention`, `memorix_feedback`, `memorix_evidence`, `memorix_suggest_topic_key`, `memorix_transfer`, `memorix_deduplicate`, `memorix_consolidate`, `memorix_audit_project`, `memorix_rules_sync`, `memorix_workspace_sync`.

`team_*` и `memorix_poll` заменяются `session_*` + `tasks` (Phase 5–6); на переходный период остаются в профиле `team`.

Правила ответов MCP: компактный текст для агента + `structuredContent` с id, чтобы агент мог догрузить детали через `memory_get` (существующий принцип progressive disclosure Memorix).

## 3. CLI `pmi`

`memorix` остаётся алиасом бинаря. Новые и изменённые команды:

```
pmi login <server-url> [--token <pat>]          # выпуск токена устройства, сохранение в keychain/файл 0600
pmi logout
pmi status                                      # режим, daemon, outbox, активная сессия, lease, git-курсор

pmi project link [--project <id|slug>]          # создать .pmi/project.json, привязать репозиторий, выгрузить локальную память
pmi project overview

pmi daemon start|stop|status|install

pmi session start [--task "..."] [--agent codex --model gpt-5]
pmi session checkpoint [--note "..."] [--next "..."]
pmi session handoff [--to <user>] [--note "..."]
pmi session list [--resumable] [--all-users] [--json]
pmi session resume <session_id> [--worktree <path>|--in-place] [--no-restore]
pmi session finish [--failed] [--summary "..."]
pmi session show <session_id>

pmi workspace snapshot [--session <id>]
pmi workspace restore <snapshot_id> [--worktree <path>|--in-place] [--dry-run]
pmi workspace list | gc

pmi memory search|get|save|update|confirm|deprecate|conflicts|history   # поверх существующих memorix memory *
pmi decision add|list
pmi context [--task "..."] [--budget 2000] [--level L1,L2,L3]

pmi git analyze [--full]                         # инкрементально с курсора
pmi git-hook install|uninstall                   # post-commit + post-checkout + post-merge

pmi sync [push|pull|status]
pmi backup | restore <file>
pmi-server migrate | serve | backup | restore | create-org | create-user | issue-token
```

Все команды поддерживают `--json`. Коды возврата: 0 — успех, 1 — ошибка, 2 — конфликт (lease, версия, рабочая копия), 3 — нет сети при операции, требующей сервер.
