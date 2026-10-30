# PMI — Session Continuity

Статус: **реализовано в Phase 6** (кроме переноса файлов рабочей копии — Phase 7). Отличия реализации от этого проекта перечислены в ROADMAP.md, «Итог Phase 6». Критический приоритет ТЗ (§7).

Цель: разработчик может остановиться в **любой** момент — штатно, по лимиту модели или при падении процесса, — а другой разработчик с другой моделью на другой машине продолжает с последнего сохранённого состояния, не повторяя сделанное.

## 1. Что меняется относительно Memorix

| Memorix (AUDIT §7–8) | PMI |
|---|---|
| `sessions`: id, project, agent, status active/completed, summary | Полный Session State + 8 статусов + lease |
| Новая сессия закрывает все активные в проекте | Параллельные сессии; каждая — своя задача и lease |
| Ход задачи — `task_continuity_events`, не связан с сессией | `session_events` привязаны к сессии; continuity‑журнал мигрирует |
| Сохранение только через агента/хуки | Локальный daemon делает checkpoints сам |
| Handoff — текстовая заметка | Handoff = state + snapshot рабочей копии + brief + next action + снятие lease |
| `resume` — общий brief проекта | `resume <id>` — пакет конкретной сессии + восстановление workspace |

## 2. Session State

```ts
interface SessionState {
  schema: 1;
  sessionId: string;              // ULID
  projectId: string;
  userId: string;
  deviceId: string;
  agent: string;                  // 'claude-code' | 'codex' | 'cursor' | ...
  modelProvider?: string;         // 'anthropic' | 'openai' | ...
  model?: string;
  status: SessionStatus;

  task: string;                   // текущая задача (коротко)
  objective: string;              // критерий завершения
  progress: { percent?: number; summary: string };
  completedSteps: Step[];         // { id, text, at, evidence?: string[] }  — evidence: коммиты, файлы, тесты
  pendingSteps: Step[];
  decisions: Ref[];               // ссылки на memories категории architecture_decision
  observations: Ref[];            // существенные наблюдения сессии
  problems: Problem[];            // { text, status: open|worked_around|resolved, ref? }
  nextAction: string | null;

  git: {
    repositoryId: string;
    branch: string | null;        // null = detached
    head: string;                 // последний коммит
    baseRemoteRef?: string;       // ближайший коммит, который есть в remote
    unpushedCommits: string[];
    dirty: boolean;
    modifiedFiles: FileChange[];  // { path, status: A|M|D|R|U(untracked), oldPath? }
  };
  workspaceSnapshotId: string | null;
  lastCheckpoint: { id: string; seq: number; at: string; trigger: CheckpointTrigger } | null;
  updatedAt: string;
}
```

Источники полей:

| Поле | Кто заполняет |
|---|---|
| task, objective, steps, decisions, problems, nextAction | Агент через MCP (`session_start`, `session_checkpoint`, `decision_log`, `memory_save`) |
| git.*, modifiedFiles, workspaceSnapshotId | **Daemon** — сам читает рабочую копию, агент не нужен |
| observations | Хуки агента (существующий pipeline Memorix) + MCP |
| progress.summary при отсутствии данных от агента | Daemon строит детерминированно: последние шаги + изменённые файлы + последние коммиты |

Не сохраняется: скрытые рассуждения модели и полные транскрипты (ТЗ §10, правило 14). `chat_transcript` Memorix не синхронизируется и не входит в state.

## 3. Статусы и переходы

```
            start
 CREATED ───────────► IN_PROGRESS ◄──────────────┐
                        │   │  ▲                 │ resume (lease захвачен)
             checkpoint │   │  │ активность      │
                        ▼   │  │                 │
                   CHECKPOINTED                  │
                        │   │                    │
  lease истёк / процесс │   │ handoff            │
  умер / нет heartbeat  ▼   ▼                    │
                 INTERRUPTED  WAITING_HANDOFF    │
                        │          │             │
           есть checkpoint         │             │
                        ▼          ▼             │
                      RESUMABLE ─────────────────┘
                        │
   finish ──► COMPLETED │ FAILED ◄── finish --failed / неустранимая ошибка
```

| Переход | Условие | Кто |
|---|---|---|
| CREATED → IN_PROGRESS | первая активность (MCP‑вызов, изменение файлов) | клиент |
| IN_PROGRESS ↔ CHECKPOINTED | checkpoint создан / новая активность | клиент |
| * → INTERRUPTED | lease не продлён `PMI_LEASE_TTL` (по умолчанию 10 мин) | **сервер** (джоб) или локальный daemon при старте, найдя «осиротевшую» сессию |
| INTERRUPTED → RESUMABLE | есть хотя бы один checkpoint | сервер, сразу |
| IN_PROGRESS/CHECKPOINTED → WAITING_HANDOFF | `pmi session handoff` | клиент |
| WAITING_HANDOFF → RESUMABLE | автоматически после записи handoff (статус отражает «явно передана») | сервер |
| RESUMABLE → IN_PROGRESS | `resume`: новый lease, при другом пользователе — новая дочерняя сессия (`parent_session_id`) | клиент |
| * → COMPLETED / FAILED | `finish` | клиент |

Решение: при resume **другим пользователем** создаётся новая сессия с `parent_session_id`, состояние копируется. Так сохраняется авторство и аудит («кто что сделал»), а цепочка сессий даёт полную историю задачи. Тот же пользователь на другом устройстве продолжает ту же сессию.

## 4. Automatic Checkpointing

Checkpoint = неизменяемая запись `{seq, trigger, state, snapshotId?}`. Создаётся **локально** (SQLite + outbox) и отправляется на сервер, когда есть сеть.

| Триггер | Источник | Snapshot рабочей копии |
|---|---|---|
| `timer` | daemon, каждые `PMI_CHECKPOINT_INTERVAL` (5 мин), **только если** изменился fingerprint (HEAD + `git status` + mtime/size изменённых файлов) | да, инкрементальный |
| `fs_change` | daemon, watcher рабочей копии, debounce 60 с после последнего изменения, порог: ≥ 3 файлов или ≥ 200 изменённых строк с прошлого checkpoint | да |
| `commit` | git `post-commit` / `post-merge` / `post-checkout` хуки → `pmi git-event` → IPC daemon; fallback — daemon опрашивает HEAD каждые 30 с | да (если остались незакоммиченные) |
| `decision` | MCP `decision_log` / `memory_save` категории `architecture_decision` | нет (только state) |
| `manual` | MCP `session_checkpoint`, `pmi session checkpoint` | да |
| `compact` | хуки pre/post compact (существующая логика Memorix `compaction_checkpoints`) | нет |
| `exit` | daemon получил SIGTERM/SIGINT; хук агента `session_end`/`Stop` | да, с таймаутом 5 с |
| `handoff` | `session handoff` | да, **pinned** |

Почему это работает при обрыве по лимиту (TEST 4): ни один триггер, кроме `manual`/`decision`, не требует, чтобы агент что‑то сделал. Daemon видит изменения файлов и коммиты сам. Худший случай потери — изменения за последние ≤ 5 минут **описания** прогресса; сами изменения файлов попадают в snapshot по `fs_change`/`timer`.

Восстановление после аварии:
- **Daemon упал / машина выключилась**: при следующем старте daemon находит в SQLite сессии в статусе `in_progress/checkpointed` своего устройства без живого lease, делает финальный checkpoint `exit` из текущего состояния рабочей копии (если она есть) и отправляет. Сервер независимо переводит сессию в `INTERRUPTED → RESUMABLE` по истечении lease.
- **Процесс агента умер, daemon жив**: heartbeat от агента (MCP‑вызовы) прекратился → через `PMI_AGENT_IDLE` (15 мин) daemon делает checkpoint и отпускает lease → `RESUMABLE`.
- **Нет сети**: всё пишется в outbox; на сервере сессия станет `INTERRUPTED` по lease, а после восстановления сети придут накопленные checkpoints (сервер принимает checkpoint от владельца lease с `seq` больше последнего, даже если lease уже истёк, при условии что никто другой не захватил сессию; иначе checkpoint сохраняется как ветка `orphan` и порождает конфликт для ручного решения).

Ограничения объёма: state ≤ 64 KiB (длинные списки шагов сворачиваются в summary), хранятся все checkpoints последних 7 дней + каждый 10‑й старше + все pinned (`workspace gc`).

## 5. `pmi session handoff`

Шаги (ТЗ §7, пункты 1–7), атомарность обеспечивается порядком «сначала данные, потом статус»:

1. **Сохранить состояние** — собрать актуальный `SessionState` (git — из рабочей копии).
2. **Сохранить незакоммиченные изменения** — `workspace snapshot` (WORKSPACE_RECOVERY.md), включая незапушенные коммиты.
3. **Checkpoint** с `trigger=handoff`, snapshot pinned.
4. **Handoff Brief** — детерминированный шаблон (без LLM; LLM‑сжатие — опция `--summarize`):
   ```
   # Handoff: <task>
   Objective · Status · Progress
   Done (n): шаги с доказательствами (коммиты/тесты)
   Next action: <одно конкретное действие>
   Pending (n)
   Decisions: id + заголовок (детали — memory_get)
   Open problems
   Workspace: branch, head, snapshot id, изменённые файлы (A/M/D), незапушенные коммиты
   Files to read first: ≤ 10 путей (изменённые + связанные с решениями)
   Do NOT redo: список завершённых шагов одной строкой каждый
   ```
   Пропускается через `secret-filter`. Целевой размер ≤ 800 токенов.
5. **Next action** — берётся из state; если агент его не задал, `handoff` требует `--next` (в интерактивном режиме) или ставит первый pending step с пометкой `inferred`.
6. **Статус** → `WAITING_HANDOFF` → `RESUMABLE`.
7. **Освобождение** — lease снимается; рабочая копия остаётся как есть (handoff не трогает файлы).

Если сервер недоступен, шаги 1–5 выполняются локально, статус и данные уходят через outbox; команда сообщает, что передача завершится после синхронизации, и `pmi status` показывает это.

## 6. Recovery: `pmi session list` / `pmi session resume <id>`

`list` по умолчанию показывает `resumable`, `interrupted` и `waiting_handoff` сессии проекта (все пользователи, если есть права), с задачей, автором, агентом, возрастом последнего checkpoint и наличием snapshot.

`resume <id>`:

1. `POST /sessions/:id/resume` — захват lease (409, если сессию держит живой lease другого устройства; `--force` только maintainer или при истёкшем lease).
2. Получение **Resume Package**:
   ```
   { session (state последнего checkpoint), brief,
     context: L1 overview + L2 под task (CONTEXT_ENGINE.md),
     decisions: [{id,title,summary}], problems,
     snapshot: { id, base_commit, branch, files: [...] },
     filesToRead: [...], doNotRedo: [...], nextAction }
   ```
3. **Workspace**: если есть snapshot — восстановление по WORKSPACE_RECOVERY.md (по умолчанию — в новый worktree; `--in-place` — только в чистую рабочую копию на совпадающем base; `--no-restore` — пропустить).
4. Новая сессия (другой пользователь) или продолжение (тот же), статус `IN_PROGRESS`.
5. Вывод: brief для человека; агенту через MCP `session_resume` — тот же пакет в компактной форме.

Через MCP агент делает то же самое: `session_list` → `session_resume(id)`; восстановление файлов — `workspace_restore` (требует подтверждения пользователя, если целевая рабочая копия не пуста).

## 7. Параллельные сессии (TEST 7)

- Rollover из Memorix удаляется: `session_start` создаёт новую сессию, не трогая чужие.
- У каждой сессии свой lease `session:<id>`.
- Рекомендуемая изоляция — отдельный worktree на сессию (`pmi session start --worktree`); daemon отслеживает каждый worktree как отдельную рабочую копию.
- Две сессии в одной рабочей копии допустимы, но daemon предупреждает и снимает snapshot общий; при resume такой сессии восстановление идёт только в новый worktree.
- Опциональные path‑leases (`path:<glob>`) — замена `team_file_lock`, теперь общие через сервер.

## 8. Безопасность и права

- Читать список сессий — viewer+; state, brief и snapshot — developer+.
- Resume чужой сессии — только из статусов `resumable/waiting_handoff/interrupted` или maintainer с `--force`; всё — в `audit_log`.
- Handoff адресный (`--to <user>`) — сессию может забрать только адресат в течение `PMI_HANDOFF_RESERVE` (24 ч), затем любой developer.

## 9. Тесты (связь с acceptance)

| Acceptance | Проверка |
|---|---|
| TEST 2, 10 | e2e: клиент A (`agent=claude-code`) start → 2 checkpoint → handoff; клиент B (`agent=codex`, другой user/device, другой data dir) list → resume → получает completedSteps, nextAction, файлы |
| TEST 4 | e2e: start → изменения файлов → `kill -9` процесса агента, без handoff → истечение lease (ускоренное) → B resume получает state и файлы последнего автоматического checkpoint |
| TEST 7 | две сессии разных пользователей в одном проекте одновременно, обе остаются `in_progress`, checkpoints не смешиваются |
| TEST 8 | checkpoints при недоступном сервере копятся в outbox, после восстановления — на сервере в правильном порядке |
