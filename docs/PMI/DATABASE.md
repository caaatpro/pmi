# PMI — модель данных

Статус: Phase 2 — проект; **Phase 4 реализовала** схемы `core` (без команд и грантов), `memory` и `work.changes/project_seq` — миграция `0001-core-memory` в `src/server/central/migrations.ts`. Отличия реализации от черновика ниже перечислены в §6.

## 1. Что хранится централизованно, а что локально

ТЗ требует не переносить всё в Postgres механически. Критерий: **нужно ли это другому человеку, агенту или машине**.

| Сущность (Memorix) | Центр (Postgres) | Локально (SQLite) | Обоснование |
|---|---|---|---|
| `observations` → **memories** | ✔ истина | ✔ кэш + outbox | Общая память проекта |
| История версий памяти | ✔ | последние N | Аудит, откат |
| Связи памяти (`relatedEntities`, `relatedCommits`, claims evidence) | ✔ `memory_links` | ✔ кэш | Граф знаний |
| `sessions`, `task_continuity_events` → **sessions, session_events** | ✔ | ✔ | Handoff между машинами |
| `compaction_checkpoints` → **checkpoints** | ✔ | ✔ | Recovery |
| Workspace snapshots: манифест | ✔ | ✔ | Recovery на другой машине |
| Workspace snapshots: blobs | ✔ blob store | ✔ `~/.pmi/blobs` | Реальные изменения |
| Пользователи, организации, команды, роли, токены | ✔ только центр | токен устройства в keychain | Безопасность |
| Git‑курсоры анализа | ✔ | ✔ | Инкрементальность для всех клиентов |
| Аудит‑журнал | ✔ только центр | — | Неизменяемость |
| Метрики | ✔ агрегаты | ✔ сырые события до отправки | |
| `code_files/symbols/edges` (codegraph) | ✘ | ✔ | Производный индекс, дёшево пересчитать из рабочей копии; передавать по сети дороже |
| Orama/FTS5/LanceDB индексы | ✘ (на центре — tsvector/pgvector) | ✔ | Производные |
| `team_locks` | ✔ → **workspace_leases** | кэш | Блокировка обязана быть общей |
| `team_tasks/messages` | ✔ → **tasks** (упрощённо) | кэш | ТЗ: Projects → Tasks |
| `memory_feedback_*`, `outcome_signals` | ✔ агрегат веса | ✔ события | Ранжирование |
| `chat_transcript` | ✘ | ✔ (опционально) | ТЗ: не грузить истории переписки; не синхронизируется |
| `mcp_bindings`, `maintenance_*`, `agent_effects`, `meta` | ✘ | ✔ | Служебное, локальное |
| `media_*`, `mini_skills`, `knowledge_pages/workflows` | ✘ | ✘ (удаляются по Phase 3) | Вне PMI |

## 2. PostgreSQL: схемы

Три схемы: `core` (организации, доступ, аудит), `memory` (знания), `work` (сессии, снимки, git, задачи). Все id — `uuid` (сервер) или ULID‑текст (созданные клиентом офлайн, `sync_key`). Время — `timestamptz`.

### 2.1 core

```sql
CREATE TABLE core.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  display_name text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.org_members (
  org_id uuid REFERENCES core.organizations ON DELETE CASCADE,
  user_id uuid REFERENCES core.users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE core.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES core.organizations ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (org_id, name)
);
CREATE TABLE core.team_members (
  team_id uuid REFERENCES core.teams ON DELETE CASCADE,
  user_id uuid REFERENCES core.users ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE core.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES core.organizations ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  legacy_project_ids text[] NOT NULL DEFAULT '{}',   -- 'owner/repo' из Memorix
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- Права на проект выдаются пользователю или команде
CREATE TABLE core.project_grants (
  project_id uuid REFERENCES core.projects ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user','team')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('maintainer','developer','viewer')),
  PRIMARY KEY (project_id, principal_type, principal_id)
);

CREATE TABLE core.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  root_commit text,                 -- устойчивый идентификатор репозитория
  remote_urls text[] NOT NULL DEFAULT '{}',  -- нормализованные
  default_branch text,
  UNIQUE (project_id, root_commit)
);

CREATE TABLE core.devices (
  id uuid PRIMARY KEY,              -- генерируется клиентом
  user_id uuid NOT NULL REFERENCES core.users ON DELETE CASCADE,
  name text NOT NULL,
  last_seen_at timestamptz
);

CREATE TABLE core.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users ON DELETE CASCADE,
  device_id uuid REFERENCES core.devices ON DELETE CASCADE,
  token_sha256 bytea UNIQUE NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',   -- пусто = все права пользователя
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  org_id uuid, project_id uuid,
  actor_user_id uuid, actor_device_id uuid, actor_agent text,
  action text NOT NULL,             -- 'memory.update', 'session.resume', 'snapshot.restore', 'grant.change', ...
  target_type text, target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb   -- без содержимого памяти и секретов
);
REVOKE UPDATE, DELETE ON core.audit_log FROM pmi_app;
```

### 2.2 memory

```sql
CREATE TYPE memory.category AS ENUM (
  'project_overview','architecture','component','dependency','architecture_decision',
  'business_logic','coding_convention','issue','solution','known_limitation',
  'development_history','current_state','active_task','completed_task',
  'session_history','git_history'
);
CREATE TYPE memory.confidence AS ENUM ('observed','inferred','proposed','confirmed','deprecated');
CREATE TYPE memory.status AS ENUM ('active','needs_review','resolved','archived');

CREATE TABLE memory.memories (
  id text PRIMARY KEY,                  -- ULID (= sync_key Memorix)
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  category memory.category NOT NULL,
  title text NOT NULL,
  content text NOT NULL,                -- narrative
  facts jsonb NOT NULL DEFAULT '[]',
  component text,                       -- для component filtering
  topic_key text,                       -- upsert‑ключ Memorix
  source text NOT NULL CHECK (source IN ('agent','git','manual','hook','import','system')),
  source_ref text,                      -- commit sha, session id, url
  author_user_id uuid REFERENCES core.users,
  author_agent text,                    -- 'claude-code', 'codex', ...
  session_id text,
  confidence memory.confidence NOT NULL,
  confirmed_by uuid REFERENCES core.users,
  confirmed_at timestamptz,
  status memory.status NOT NULL DEFAULT 'active',
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('personal','project','organization')),
  version int NOT NULL DEFAULT 1,
  related_files text[] NOT NULL DEFAULT '{}',
  related_commits text[] NOT NULL DEFAULT '{}',
  related_tasks text[] NOT NULL DEFAULT '{}',
  valid_from_commit text,               -- version filtering: знание верно начиная с коммита
  superseded_by text REFERENCES memory.memories,
  content_hash bytea NOT NULL,          -- дедупликация
  tokens int NOT NULL,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content,'')), 'B')) STORED,
  embedding vector(384),                -- размерность = профиль эмбеддингов проекта
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  server_seq bigint NOT NULL            -- позиция в changes feed
);
CREATE UNIQUE INDEX ON memory.memories (project_id, topic_key) WHERE topic_key IS NOT NULL AND status = 'active';
CREATE INDEX ON memory.memories USING gin (search);
CREATE INDEX ON memory.memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON memory.memories (project_id, category, status);
CREATE INDEX ON memory.memories USING gin (related_files);
CREATE INDEX ON memory.memories (project_id, content_hash);

CREATE TABLE memory.memory_versions (     -- история изменений (append‑only)
  memory_id text REFERENCES memory.memories ON DELETE CASCADE,
  version int NOT NULL,
  snapshot jsonb NOT NULL,              -- полная запись на момент версии
  changed_by_user uuid, changed_by_agent text,
  change_reason text,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (memory_id, version)
);

CREATE TABLE memory.memory_links (
  from_id text REFERENCES memory.memories ON DELETE CASCADE,
  to_id text REFERENCES memory.memories ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('relates','supersedes','contradicts','depends_on','explains','derived_from')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE memory.conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  memory_a text NOT NULL, memory_b text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('concurrent_edit','contradiction','duplicate')),
  detected_by text NOT NULL,            -- 'sync', 'rule:topic_key', 'llm'
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory.overviews (            -- кэш L1 Project Overview
  project_id uuid PRIMARY KEY,
  content text NOT NULL, tokens int NOT NULL,
  source_max_seq bigint NOT NULL,        -- пересобирается, когда memories ушли дальше
  built_at timestamptz NOT NULL
);
```

### 2.3 work

```sql
CREATE TABLE work.sessions (
  id text PRIMARY KEY,                   -- ULID
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  repository_id uuid REFERENCES core.repositories,
  user_id uuid NOT NULL REFERENCES core.users,
  device_id uuid REFERENCES core.devices,
  agent text, model_provider text, model text,
  status text NOT NULL CHECK (status IN ('created','in_progress','checkpointed','interrupted',
                                         'waiting_handoff','resumable','completed','failed')),
  task text, objective text,
  state jsonb NOT NULL,                  -- SessionState, SESSION_CONTINUITY.md §2
  parent_session_id text REFERENCES work.sessions,   -- цепочка handoff → resume
  lease_owner_device uuid, lease_expires_at timestamptz,
  last_checkpoint_id text,
  git_branch text, git_head text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX ON work.sessions (project_id, status, updated_at DESC);

CREATE TABLE work.checkpoints (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES work.sessions ON DELETE CASCADE,
  seq int NOT NULL,                      -- порядковый номер в сессии
  trigger text NOT NULL,                 -- 'timer','fs_change','commit','decision','manual','handoff','exit','compact'
  state jsonb NOT NULL,
  snapshot_id text,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE work.session_events (         -- бывший task_continuity_events, привязан к сессии
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES work.sessions ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('step_done','step_planned','decision','observation','problem',
                                     'verification','file_modified','next_action','note')),
  content text NOT NULL,
  ref text, at timestamptz NOT NULL
);

CREATE TABLE work.snapshots (
  id text PRIMARY KEY,                   -- ULID
  project_id uuid NOT NULL, session_id text REFERENCES work.sessions,
  repository_id uuid,
  parent_snapshot_id text REFERENCES work.snapshots,   -- инкрементальность
  base_commit text NOT NULL, branch text,
  manifest jsonb NOT NULL,               -- WORKSPACE_RECOVERY.md §3
  manifest_sha256 bytea NOT NULL,
  total_bytes bigint NOT NULL,
  pinned boolean NOT NULL DEFAULT false, -- handoff‑снимки не удаляются retention
  created_by_user uuid, created_by_device uuid,
  created_at timestamptz NOT NULL
);
CREATE TABLE work.blobs (
  sha256 bytea PRIMARY KEY,
  size bigint NOT NULL,
  storage text NOT NULL CHECK (storage IN ('inline','fs','s3')),
  data bytea,                            -- inline только для < 256 KiB
  ref_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work.snapshot_blobs (
  snapshot_id text REFERENCES work.snapshots ON DELETE CASCADE,
  sha256 bytea REFERENCES work.blobs,
  PRIMARY KEY (snapshot_id, sha256)
);

CREATE TABLE work.workspace_leases (       -- замена team_locks
  project_id uuid NOT NULL,
  scope text NOT NULL,                   -- 'session:<id>' | 'branch:<repo>/<name>' | 'path:<glob>'
  holder_user uuid NOT NULL, holder_device uuid NOT NULL, session_id text,
  acquired_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, scope)
);

CREATE TABLE work.git_cursors (
  repository_id uuid NOT NULL REFERENCES core.repositories ON DELETE CASCADE,
  branch text NOT NULL,
  last_analyzed_commit text NOT NULL,
  last_full_reconcile_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (repository_id, branch)
);
CREATE TABLE work.git_commits (
  repository_id uuid NOT NULL, sha text NOT NULL,
  parents text[] NOT NULL, author text NOT NULL, committed_at timestamptz NOT NULL,
  subject text NOT NULL,
  changes jsonb NOT NULL,                -- [{path,status:A|M|D|R,old_path,add,del}]
  classification jsonb NOT NULL,         -- {api:true, dependencies:[...], ...}
  analyzed_at timestamptz NOT NULL,
  PRIMARY KEY (repository_id, sha)
);

CREATE TABLE work.tasks (
  id text PRIMARY KEY, project_id uuid NOT NULL,
  title text NOT NULL, description text,
  status text NOT NULL CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  assignee_user uuid, session_id text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, server_seq bigint NOT NULL
);

CREATE TABLE work.changes (                -- changes feed для синхронизации
  project_id uuid NOT NULL,
  seq bigint NOT NULL,                   -- монотонен в пределах проекта
  entity text NOT NULL,                  -- 'memory','session','checkpoint','snapshot','task','link','conflict'
  entity_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert','delete')),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);
CREATE TABLE work.project_seq (project_id uuid PRIMARY KEY, next_seq bigint NOT NULL);

CREATE TABLE work.metrics_events (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL,
  project_id uuid, session_id text, user_id uuid,
  name text NOT NULL, value double precision NOT NULL, labels jsonb NOT NULL DEFAULT '{}'
);
```

`seq` выдаётся `UPDATE work.project_seq SET next_seq = next_seq + 1 … RETURNING` в той же транзакции, что и изменение, — это даёт строгий порядок feed без пропусков видимости.

## 3. SQLite (локальный клиент)

Существующая схема `memorix.db` сохраняется. Добавляются (миграциями `schema_migrations`):

| Таблица | Назначение |
|---|---|
| `observations` + колонки `sync_key`, `category`, `confidence`, `version`, `component`, `related_tasks`, `author_user_id`, `remote_project_id` | Локальное представление `memory.memories`; INTEGER id остаётся для MCP‑совместимости |
| `memory_versions` | Последние версии (локальная история) |
| `sessions` + колонки `user_id`, `model_provider`, `model`, `state_json`, `parent_session_id`, `lease_expires_at`, `last_checkpoint_id`, `git_branch`, `git_head`, `remote_seq`; расширение CHECK статусов | Session State |
| `checkpoints`, `session_events` | Как на сервере |
| `snapshots`, `snapshot_blobs`, `blobs_index(sha256, path, size, uploaded)` | Манифесты и локальный индекс blobs (сами blobs — файлы `~/.pmi/blobs/ab/cd…`) |
| `outbox(id, entity, entity_id, op, payload, created_at, attempts, last_error, sent_at)` | Буфер офлайн‑записей |
| `sync_cursors(project_id, server, last_seq)` | Курсор changes feed |
| `git_cursors` | Копия серверных курсоров + локальные незапушенные |
| `metrics_buffer` | Метрики до отправки |

Существующая `sync_row_state` (Lamport‑версии) переиспользуется как база для конфликт‑детекции memory.

## 4. RBAC

| Действие | viewer | developer | maintainer | org admin/owner |
|---|---|---|---|---|
| Читать память, overview, контекст | ✔ | ✔ | ✔ | ✔ |
| Создавать память (`observed/inferred/proposed`) | ✘ | ✔ | ✔ | ✔ |
| Подтверждать (`confirmed`), устаревать (`deprecated`) | ✘ | ✔ свои¹ / чужие через review | ✔ | ✔ |
| Удалять (archive) память | ✘ | свои | ✔ | ✔ |
| Создавать/вести свои сессии | ✘ | ✔ | ✔ | ✔ |
| Видеть список сессий проекта | ✔ (без state) | ✔ | ✔ | ✔ |
| Возобновлять чужую сессию | ✘ | при handoff / истёкшем lease | ✔ | ✔ |
| Читать/восстанавливать snapshot | ✘ | ✔ | ✔ | ✔ |
| Принудительно снимать lease | ✘ | ✘ | ✔ | ✔ |
| Управлять доступом к проекту / репозиториям | ✘ | ✘ | ✔ | ✔ |
| Создавать проекты, команды, пользователей | ✘ | ✘ | ✘ | ✔ |

¹ «Свои» — записи, автором которых является пользователь; подтверждение агентом собственного вывода без явной команды человека запрещено (ARCHITECTURE.md §9).

Реализация (Phase 5): `authorize(user, projectId, action)` в `src/server/central/identity.ts` — единственная точка в сервисном слое; Postgres RLS‑политики на `memory.*` и `work.*` (роль `pmi_app`, `app.user_id`, функция `core.can()`) как вторая линия защиты. Роль вычисляет одна SQL‑функция `core.project_role_of()`, её используют и сервис, и политики. Owner/admin организации получают роль `admin` (≥ maintainer) во всех проектах организации. Personal‑записи на сервер не синхронизируются (политика синхронизации), поэтому отдельной политики для них нет.

Эксплуатация: миграция `0002` создаёт роль `pmi_app`, поэтому её применяет пользователь с правом `CREATEROLE` (в Docker Compose это владелец базы). Если сервер работает под ролью без этого права, роль `pmi_app` создаётся администратором заранее (`CREATE ROLE pmi_app NOLOGIN; GRANT pmi_app TO <роль сервера>;`) — миграция пропускает создание существующей роли. Роль сервера не должна быть суперпользователем в продакшене: RLS к суперпользователю не применяется, а `SET ROLE pmi_app` всё равно ограничивает запросы к данным проектов.

## 5. Миграция данных Memorix → PMI

Безопасность — ТЗ правило 7: никакая миграция не удаляет и не переписывает исходные данные на месте.

1. **Резервная копия**: перед первой миграцией `memorix.db` → `memorix.db.pre-pmi-<ts>` через `VACUUM INTO`, проверка `PRAGMA integrity_check`.
2. **Локальная схема**: только `ADD COLUMN` и новые таблицы; колонки заполняются отображением:

| Memorix `type` | PMI `category` | `confidence` |
|---|---|---|
| `decision`, `trade-off`, `why-it-exists`, `reasoning` | `architecture_decision` | `proposed` |
| `problem-solution` | `solution` | `observed` |
| `gotcha` | `known_limitation` | `observed` |
| `how-it-works` | `architecture` | `inferred` |
| `what-changed` (source=git) | `git_history` | `observed` |
| `what-changed` (иначе) | `development_history` | `observed` |
| `discovery` | `component` | `inferred` |
| `session-request` | `session_history` | `observed` |
| `probe` | не переносится на сервер | — |

`status: resolved → resolved`, `archived → archived`. Ничего не помечается `confirmed` автоматически. `long_term_memories` в состоянии `approved` → `confirmed` (это уже было явное одобрение человеком в Memorix).

3. **Выгрузка на сервер**: `pmi project link` ставит все подходящие записи (`syncEligibility` из Memorix) в outbox. Сервер дедуплицирует по `(project_id, content_hash)` и `topic_key`.
4. **Откат**: локальная БД остаётся читаемой версией Memorix (новые колонки игнорируются); сервер можно очистить по `project_id`.

## 6. Отличия реализации Phase 4 от черновика

| Черновик | Реализация | Причина |
|---|---|---|
| `memory.memories.id` — ULID | `id` = `syncKey` клиента (`p:<project>:u:<device>:<id>` или `p:<project>:t:<topicKey>`) | Ключ уже глобально уникален и одинаков на всех репликах; ULID потребовал бы второй таблицы соответствий |
| Нет колонок версии репликации | `revision`, `writer` (порядок `(revision, writer)` из `src/sync/merge.ts`), `deleted_at` (tombstone), `body jsonb` (исходная запись клиента), `content_hash text`, `legacy_project_id` | Сервер применяет тот же LWW, что и клиенты, и отдаёт записи, которые клиент проверяет по хэшу |
| `content_hash bytea` | `text` (hex SHA‑256 из `journal.contentHash`) | Сравнение без преобразований с хэшем пакета |
| Уникальный индекс `(project_id, topic_key)` для active | Обычный индекс | Строки с одним topic key уже совпадают по `id`; уникальность на уровне topic key заблокировала бы push |
| `core.api_tokens.device_id`, `scopes`; `core.devices` | `name`, без устройств и scopes | Устройства и scopes появятся вместе с RBAC (Phase 5); устройство пока идентифицируется `deviceId` sync‑пакета (пишется в аудит и историю версий) |
| `memory.conflicts(memory_a, memory_b)` | `memory_id`, `winner`, `loser` (jsonb с версией и телом) | Конфликт одновременной правки касается одной записи; проигравшая версия сохраняется целиком для ручного разбора |
| SQLite `outbox`, `sync_cursors` | Не созданы: используются существующие `sync_outbox`, `sync_meta` (курсор `applied['pmi-server'] = seq`) и `sync_row_state` | Без дублирования механизмов (правило 4) |
| SQLite `observations` + `category`, `confidence` | Добавлены; `NULL` = значение по умолчанию для типа (`src/domain/memory.ts`) | Существующие строки не переписываются; смена типа не оставляет устаревшую категорию |

