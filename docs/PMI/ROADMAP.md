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

## Phase 5 — Multi‑user

Схема `core`, токены (`pmi-server issue-token`), `authorize()`, RLS, `audit_log`, гранты проектов, кросс‑проектный поиск с учётом прав, MCP HTTP с per‑user токеном. Замена `team_*` идентичности агентов на пользователей (агент — атрибут).

TEST 1, TEST 9 (пользователь без гранта получает 403/404 на memory, sessions, snapshots, search, MCP; прямой SQL под его `app.user_id` не видит строк).

## Phase 6 — Session continuity

Session State, статусы, lease, checkpoints, `session_events` (+ миграция `task_continuity_events`), daemon (watcher, таймер, git‑события, IPC, автозапуск), handoff brief, `pmi session *`, MCP `session_*`, серверный джоб истечения lease.

TEST 2, 4, 7, 10. Для TEST 10 — два реальных адаптера (Claude Code hooks/MCP config и Codex MCP config из `src/workspace/mcp-adapters`) в e2e с симулированными MCP‑клиентами; ручная проверка на живых агентах описывается в чек‑листе.

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
