# Baton — целевая архитектура

Статус: **проект на согласование** (Phase 2). Основание — [AUDIT.md](AUDIT.md).

Связанные документы: [DATABASE.md](DATABASE.md) · [API.md](API.md) · [SESSION_CONTINUITY.md](SESSION_CONTINUITY.md) · [WORKSPACE_RECOVERY.md](WORKSPACE_RECOVERY.md) · [CONTEXT_ENGINE.md](CONTEXT_ENGINE.md) · [ROADMAP.md](ROADMAP.md)

## 1. Принятые решения

| # | Решение | Основание |
|---|---|---|
| D1 | Стек остаётся **TypeScript / Node ≥ 22** | Утверждено. 99K строк и 3.2K тестов upstream; MCP SDK, хуки, адаптеры агентов и sync‑движок уже на TS |
| D2 | Центральное хранилище — **PostgreSQL 16 + pgvector**, драйвер `pg` | Требование ТЗ; Postgres закрывает FTS (`tsvector`), векторы, `LISTEN/NOTIFY`, транзакции и RLS |
| D3 | Локально — **SQLite** (существующий слой upstream) | Офлайн‑работа, кэш, outbox |
| D4 | **Модульный монолит**, без микросервисов | ТЗ §13. Один процесс `baton-server`, один процесс `baton` daemon на машину |
| D5 | **Redis не вводится** в первой версии | Очереди и уведомления — таблица `jobs` + `LISTEN/NOTIFY`. Пересмотр при > 1 инстанса сервера |
| D6 | **Git — источник истины о коде**, Baton — источник истины о знаниях и состоянии работы | ТЗ §9 |
| D7 | **Локальная запись первична**: каждая запись сначала коммитится в SQLite + outbox, затем асинхронно уходит на сервер | Офлайн‑режим (TEST 8), отсутствие задержек для агента |
| D8 | **Сохранение не зависит от агента**: локальный daemon делает checkpoints сам | TEST 4 |
| D9 | Новая CLI `baton`, MCP‑инструменты `baton_*`; `baton` / `baton_*` — алиасы на переходный период | Совместимость (ТЗ §11). *Требует подтверждения* |
| D10 | Модель знаний объединяется вокруг одной сущности **Memory** (бывшие observations) | Устранение 6 параллельных моделей (AUDIT §11.8) |

## 2. Общая схема

```
 Разработчик A (Claude Code)                    Разработчик B (Codex)
 ┌──────────────────────────────┐               ┌──────────────────────────────┐
 │ Agent ── MCP stdio ──► baton mcp│               │ Agent ── MCP stdio ──► baton mcp│
 │ Agent hooks ──► baton hook      │               │ git hooks ──► baton git-event   │
 │                               │               │                               │
 │  baton daemon (Local Client)    │               │  baton daemon (Local Client)    │
 │  ├ SQLite cache + outbox      │               │  ├ SQLite cache + outbox      │
 │  ├ checkpointer (watch/timer) │               │  ├ checkpointer               │
 │  ├ snapshot builder + blobs   │               │  ├ snapshot builder + blobs   │
 │  └ sync worker                │               │  └ sync worker                │
 └──────────────┬────────────────┘               └───────────────┬───────────────┘
                │  HTTPS  /v1 REST + changes feed  (Bearer user token)
                ▼                                                ▼
        ┌───────────────────────────────────────────────────────────────┐
        │ baton-server (Central Baton Server, один Node‑процесс)            │
        │  auth+RBAC │ projects │ memory │ sessions │ snapshots │ git   │
        │  context engine │ search │ sync/changes │ audit │ metrics      │
        │  MCP HTTP endpoint (для агентов без локального клиента)       │
        └───────────────┬───────────────────────────┬───────────────────┘
                        ▼                           ▼
                PostgreSQL + pgvector        Blob store (FS volume; S3 позже)
```

## 3. Режимы работы

| Режим | Что запущено | Где данные | Когда |
|---|---|---|---|
| **Local** | `baton` (CLI/MCP) + опционально daemon | только SQLite | Один разработчик без сервера. Это нынешнее поведение upstream — сохраняется |
| **Connected** | `baton` + daemon + `baton-server` | SQLite (кэш, outbox) + Postgres (истина) | Основной режим Baton |
| **Server‑only** | `baton-server` | Postgres | Агент в облаке/CI подключается к MCP HTTP напрямую, без локального клиента; workspace snapshots недоступны |

Переход Local → Connected: `baton login <server-url>` + `baton project link`. Существующая локальная память выгружается через outbox (DATABASE.md §5).

## 4. Компоненты и размещение в репозитории

Код остаётся в одном пакете `baton` → `baton`. Новая раскладка `src/` (существующие модули переезжают постепенно, без переписывания):

```
src/
  domain/            # чистые типы и правила, без I/O: Memory, Session, Snapshot, Role, статусы, переходы
  memory/            # (существует) формирование, дедупликация, retention, secret-filter
  store/             # (существует) SQLite; + outbox, session_state, snapshot index
  sync/              # (существует) merge/journal; + многосущностный протокол changes feed
  context/           # Context Engine: L1/L2/L3, ранжирование, бюджет (поверх knowledge/workset, compact)
  git/               # (существует) + курсор анализа, классификаторы
  session/           # Session State, checkpoint, handoff, resume
  workspace-snapshot/# снимки рабочей копии, blobs, restore  (не путать с src/workspace — MCP‑адаптеры)
  client/            # daemon: watcher, checkpointer, sync worker, IPC
  server/            # (существует MCP) + central/: http, auth, rbac, repos(pg), routes, jobs
  mcp/tools/         # MCP‑инструменты, вынесенные из server.ts по доменам
  cli/               # (существует) + команды baton
```

Правило слоёв: `domain` ← `memory|session|context|git|workspace-snapshot` ← `store|server/central` ← `cli|mcp|client`. Бизнес‑логика не зависит от транспорта (CLI, MCP и REST вызывают одни и те же сервисы).

Доступ к данным через порты (интерфейсы репозиториев) с двумя реализациями — SQLite и Postgres. Так один и тот же сервис работает в Local‑режиме и на сервере. Это развитие подхода `SyncStorePort` из upstream.

## 5. Central Baton Server

| Функция ТЗ | Реализация |
|---|---|
| Хранение знаний, проекты, пользователи, команды | Postgres, схемы `core`, `memory`, `work` (DATABASE.md) |
| Сессии, события, решения | `work.sessions`, `work.checkpoints`, `work.session_events`; решения — Memory категории `architecture_decision` |
| Семантический поиск | `tsvector` + `pgvector`, RRF‑слияние (CONTEXT_ENGINE.md) |
| Формирование контекста | `POST /v1/projects/:id/context` |
| Git Intelligence | Анализ присылается клиентом (у сервера нет рабочей копии); сервер хранит курсоры и применяет обновления знаний |
| Синхронизация | `changes` feed с монотонным `seq` на проект + приём outbox‑батчей |
| Session / Workspace Recovery | Хранение состояний, checkpoints, манифестов snapshot и blobs; lease‑механизм сессий |
| Аудит | `core.audit_log`, append‑only, пишется в той же транзакции, что и изменение |
| Права | RBAC на уровне сервиса + Row Level Security как вторая линия защиты (DATABASE.md §4) |

HTTP: встроенный `node:http` (как в upstream) с тонким роутером; валидация — `zod` (уже в зависимостях). Новый web‑фреймворк не вводится.

## 6. Local Baton Client (daemon)

Один процесс на машину: `baton daemon start` (автозапуск через `baton setup` — launchd/systemd user unit/Windows Task; при отсутствии — ленивый старт из `baton mcp`).

| Обязанность | Механизм |
|---|---|
| Локальный кэш, индекс | SQLite + существующий Orama/FTS5 |
| Сохранение событий, буфер офлайн | Таблица `outbox` (DATABASE.md §3), отправка с экспоненциальным backoff |
| Checkpoints | Таймер + наблюдение за рабочей копией + git HEAD + IPC‑сигналы от MCP/хуков (SESSION_CONTINUITY.md §4) |
| Workspace snapshots | `src/workspace-snapshot`, content‑addressed blobs `~/.baton/blobs` |
| Синхронизация | pull `changes?after=seq`, push outbox; `LISTEN`‑аналог — long‑poll `GET /v1/changes/wait` |
| IPC | Unix socket / named pipe `~/.baton/daemon.sock`; `baton mcp` и `baton hook` пишут в SQLite напрямую и только «толкают» daemon, чтобы не зависеть от его доступности |

Если daemon не запущен, CLI и MCP продолжают работать (запись в SQLite + outbox); теряется только автоматический checkpoint по таймеру — об этом предупреждает `baton status`.

## 7. Идентичность

| Сущность | Идентификатор |
|---|---|
| Пользователь | UUID на сервере; локально — из `baton login` |
| Устройство | UUID, генерируется при первом запуске (существующий `deviceId` из sync) |
| Проект | UUID на сервере. Связь с рабочей копией — файл **`.baton/project.json`** в репозитории (`{ "projectId", "server" }`), коммитится. Fallback — существующий детектор `owner/repo` из remote |
| Репозиторий | UUID + нормализованные URL всех remotes + хэш корневого коммита (устойчив к форкам и переименованию remote — устраняет AUDIT §11.10) |
| Сессия | ULID (сортируемый по времени) |
| Memory | ULID (`sync_key`), локальный INTEGER id остаётся для совместимости MCP |
| Агент | строка `{agent}@{version}` + `model_provider`/`model`; не является субъектом прав — права у пользователя |

## 8. Безопасность (сводно)

- **Аутентификация**: персональные токены `baton_pat_…` (на сервере хранится только SHA‑256), отзыв, срок жизни; токен устройства выдаётся при `baton login`. OIDC — позже, через тот же слой.
- **RBAC**: роли на уровне организации (`owner`, `admin`, `member`) и проекта (`maintainer`, `developer`, `viewer`). Матрица прав — DATABASE.md §4.
- **Изоляция**: каждый запрос несёт `project_id`, сервис проверяет членство; Postgres RLS по `app.user_id`. Кросс‑проектный поиск — только по проектам, где у пользователя есть `read`, и только по записям с `visibility = 'organization'`.
- **Сессии и workspace**: возобновить/забрать сессию может владелец, либо `developer+` проекта при истёкшем lease или явной передаче (handoff). Snapshot читает только `developer+`.
- **Транспорт**: сервер требует TLS вне loopback (существующая защита upstream от небезопасного bind сохраняется); в Compose — за reverse‑proxy (Caddy) с автоматическим сертификатом.
- **Секреты**: существующий `secret-filter` применяется при записи памяти, при формировании handoff brief и к **содержимому snapshot** (файлы с найденными секретами не загружаются без явного `--include-secrets`, см. WORKSPACE_RECOVERY.md §6). Секреты сервера — только через env/Docker secrets.
- **Защита памяти**: изменение `confidence → confirmed` и `deprecated` — только `developer+` и только явным действием человека или агента от имени пользователя с записью в аудит; агент не может подтвердить собственное `inferred`/`proposed` утверждение (§9).

## 9. Модель достоверности знаний

```
observed ─┐
inferred ─┼─► (явное подтверждение пользователем/review) ─► confirmed ─► deprecated
proposed ─┘                                                      ▲
                             противоречие / устаревание ─────────┘ (через review)
```

- Автоматические источники (git‑анализ, хуки) пишут только `observed` (факт события: «файл X изменён в коммите Y») или `inferred` (интерпретация: «изменился публичный API»).
- MCP `memory_save` от агента — `proposed` или `observed`; `confirmed` агент выставить не может (сервер отклоняет).
- `confirmed` — только через `baton memory confirm` / UI / MCP `memory_update` с флагом `confirmedBy` = текущий пользователь при `developer+`.
- Конфликты и устаревание — CONTEXT_ENGINE.md §6.

## 10. Удаляемые подсистемы (Phase 3)

По AUDIT §13: memcode и workspace‑пакеты, TUI, `orchestrate`, медиа, KG‑compat MCP, mini‑skills. `src/orchestrate/worktree.ts` переиспользуется в Workspace Recovery. Окончательный список подтверждается до начала Phase 3.

## 11. Наблюдаемость и эксплуатация

- **Логи**: JSON‑строки в stderr (`level`, `ts`, `req_id`, `user_id`, `project_id`, `op`, `ms`). Без содержимого памяти.
- **Health**: `GET /health` (liveness), `GET /ready` (Postgres, миграции, blob store).
- **Метрики**: `GET /metrics` в формате Prometheus + таблица `metrics_events` для продуктовых метрик (§15 ТЗ, CONTEXT_ENGINE.md §8).
- **Миграции**: версионированные SQL‑файлы `migrations/pg/NNNN_*.sql`, применяются при старте под advisory lock; для SQLite — существующий механизм `schema_migrations`.
- **Backup/Restore**: `baton-server backup` = `pg_dump` + архив blob store + манифест с хэшами; `restore` проверяет хэши. Локально `baton backup` копирует SQLite через `VACUUM INTO`.
- **Docker Compose**: `postgres` (pgvector/pgvector:pg16), `baton-server`, `caddy` (TLS), том для blobs, healthchecks.

## 12. Альтернативы, рассмотренные и отклонённые

| Вариант | Почему нет |
|---|---|
| Python/FastAPI сервер + TS‑клиент | Два языка, дублирование доменной логики и схем; отклонено пользователем |
| Оставить Postgres как relay батчей (как в upstream) | Нельзя искать, проверять права и строить контекст на сервере |
| Перенести всё в Postgres, отказаться от SQLite | Ломает офлайн‑режим и скорость локального агента |
| Сохранять незакоммиченные изменения во временные ветки и пушить в origin | Засоряет общий репозиторий, требует push‑прав, утечка незавершённой работы; оставлено как опция (WORKSPACE_RECOVERY.md §9) |
| CRDT для текстовой памяти | Избыточно: записи памяти короткие, достаточно версий + явного разрешения конфликтов |
