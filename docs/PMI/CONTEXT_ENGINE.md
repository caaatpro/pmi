# PMI — Context Engine, качество знаний и Git Intelligence

Статус: §1–§5, §8 **реализованы в Phase 8** (ROADMAP.md, «Итог Phase 8»); §6 частично; §7 — Phase 9. ТЗ §6, §9, §10, §15.

Принцип: агент получает минимальный достаточный контекст и сам догружает детали по id. Полные истории переписки не загружаются никогда.

## 1. Что переиспользуется из Memorix

| Компонент | Файл | Роль |
|---|---|---|
| Task‑lensed Workset (bugfix/feature/refactor/…), «Start here» файлы | `src/knowledge/workset.ts` (`buildTaskWorkset`) | Основа L2 |
| Progressive disclosure: index → timeline → detail | `src/compact/engine.ts` | Формат выдачи и догрузка |
| Token budget, подсчёт токенов | `src/compact/token-budget.ts`, `gpt-tokenizer` | Бюджет |
| Code graph, task lens, project context overview | `src/codegraph/*` | Компоненты, связанные файлы |
| Intent detector, query expansion, rerank | `src/search/*`, `src/rerank/*` | Ранжирование |
| Feedback weights | `src/memory/feedback.ts` | Понижение бесполезных/конфликтующих записей |
| Context receipt | `src/knowledge/context-receipt.ts` | Метрики размера контекста |

Новое: L1 Overview как отдельный кэшируемый артефакт, серверный hybrid search, учёт сессии и git‑изменений в ранжировании, единые метрики.

## 2. Уровни

| Уровень | Содержимое | Размер по умолчанию | Когда |
|---|---|---|---|
| **L1 — Project Overview** | Назначение проекта, архитектура (компоненты и связи), ключевые соглашения, текущее состояние, активные задачи/сессии, топ‑N подтверждённых решений (заголовки) | ≤ 800 токенов | Всегда при `session_start` / `context_build` |
| **L2 — Relevant Context** | Записи памяти, ранжированные под задачу; решения и ограничения по затронутым компонентам; последние изменения git по затронутым файлам; состояние сессии | ≤ 1 500 токенов (параметр `budget_tokens`) | По умолчанию, под задачу |
| **L3 — Historical Context** | История версий записей, устаревшие (`deprecated`) знания, история сессий, полная git‑история файла/компонента | по запросу | `context_build(levels:[L3])`, `/context/history` |

### L1: построение

Собирается из памяти категорий `project_overview`, `architecture`, `component`, `coding_convention`, `current_state`, `active_task` с `confidence ∈ {confirmed, observed}` в приоритете, `inferred` — с пометкой. Если записей мало (новый проект) — из `buildProjectContextOverview` (codegraph) + README. Кэш `memory.overviews` пересобирается, когда `max(server_seq)` релевантных категорий вырос, не чаще раза в 10 минут. Сборка детерминированная (шаблон); LLM‑сжатие — опция с учётом стоимости.

## 3. Поиск

| Режим | Сервер (Postgres) | Локально (SQLite) |
|---|---|---|
| Keyword | `tsvector` + `websearch_to_tsquery`, `ts_rank_cd` с весами title (A) / content (B) | FTS5 / Orama BM25 (как сейчас) |
| Semantic | `pgvector` cosine, HNSW | Orama vectors / LanceDB (если включены эмбеддинги) |
| Hybrid | Reciprocal Rank Fusion: `score = Σ 1/(60 + rank_i)` по двум спискам | То же |

Эмбеддинги: провайдер — существующий `src/embedding` (off / fastembed / transformers / api). На сервере эмбеддинг считает сервер (один профиль на проект; размерность фиксируется в настройках проекта; смена профиля — фоновый re‑embed). Если эмбеддинги выключены — hybrid деградирует в keyword без ошибки.

Офлайн клиент ищет локально; при наличии сети `context_build` выполняется на сервере (полная общая память), с fallback на локальный кэш.

## 4. Ранжирование (L2)

Итоговый вес кандидата:

```
score = rrf_relevance
      × category_weight(task_lens)      // bugfix → issue/solution/known_limitation выше; feature → architecture/decision/convention
      × confidence_weight               // confirmed 1.0, observed 0.9, inferred 0.7, proposed 0.5, deprecated 0 (только L3)
      × freshness                       // exp-затухание по updated_at; needs_review × 0.6
      × feedback_weight                 // из memory_feedback (Memorix)
      + file_affinity                   // пересечение related_files с изменёнными файлами сессии / файлами задачи / «Start here»
      + component_affinity              // совпадение component
      + decision_link_bonus             // запись связана (memory_links) с решением, уже попавшим в контекст
      + recent_git_bonus                // related_files затронуты в последних K коммитах ветки
```

Коэффициенты — конфигурация, калибруются существующими гейтами `tests/evaluation/context-task-matrix.test.ts` и `memory-quality-gate`.

Фильтры: `project` (всегда), `component`, `category`, `confidence ≥`, `version` (`valid_from_commit` — предок текущего HEAD; записи, привязанные к коммитам вне текущей истории, понижаются), `status=active`.

## 5. Бюджет и сжатие

Упаковка — жадная по `score / tokens` с гарантиями:
1. L1 целиком (или его усечённая версия, если бюджет < 800).
2. Состояние сессии (next action, pending steps, открытые проблемы) — всегда, если есть сессия.
3. Решения по затронутым компонентам — минимум заголовок + одна строка.
4. Остальное.

Сжатие по ступеням для каждой записи: полная → `title + facts` → `title` + id. Записи, не поместившиеся даже заголовком, перечисляются числом («ещё 12 записей: memory_search <query>»). Дубли (одинаковый `content_hash` / одна цепочка `supersedes`) схлопываются.

Ответ всегда содержит receipt: `{tokens_total, tokens_by_level, candidates, included, truncated, build_ms, cache_hit}`.

## 6. Качество знаний

| Механизм | Реализация |
|---|---|
| **Версионирование** | Каждое изменение → `memory_versions` (DATABASE.md §2.2). Topic‑key upsert Memorix больше не теряет старое содержимое |
| **Дедупликация** | При записи: точное совпадение `content_hash` в проекте → `duplicate` (возврат существующего id); похожие (trigram ≥ 0.85 или cosine ≥ 0.92 в той же категории/компоненте) → запись создаётся, создаётся `conflicts(kind=duplicate)` на review. Существующая LLM‑дедупликация Memorix — опциональный фоновый проход |
| **Противоречия** | Правила: (1) две `active` записи с одним `topic_key` после конкурентных правок (sync) → `concurrent_edit`; (2) `architecture_decision`/`coding_convention` по одному компоненту с высоким сходством и отрицанием/антонимом в ключевых фактах → `contradiction` (эвристика, `detected_by=rule`); (3) опционально LLM‑проверка новых `confirmed`‑кандидатов. Противоречие **никогда не разрешается автоматически** — обе записи получают пометку, в контексте выдаются с флагом ⚠ |
| **Устаревание** | (1) Git: изменение/удаление файла из `related_files` → `status=needs_review` для `inferred/observed` записей (не `confirmed` — для них создаётся задача review); удаление всех `related_files` → предложение `deprecated`; (2) время: `current_state`, `active_task` без обновлений 14 дней → `needs_review`; (3) существующий retention Memorix (архивация эфемерного) сохраняется |
| **Связи** | `memory_links`: relates, supersedes, contradicts, depends_on, explains, derived_from. Автосвязи — существующий `auto-relations.ts` + общие `related_files`/`related_commits` |
| **Запрет автоподтверждения** | Ни один автоматический процесс не выставляет `confirmed`; сервер отклоняет `confirmed` от агента без пользовательского подтверждения (ARCHITECTURE.md §9) |

## 7. Git Intelligence

### Инкрементальный конвейер

```
триггер (post-commit / post-merge / post-checkout хук, daemon видит новый HEAD, pmi git analyze)
  → cursor = GET /repositories/:rid/cursor?branch
  → commits = git rev-list --reverse --first-parent? cursor..HEAD   (если cursor не предок HEAD — rebase/force: merge-base + пометка rewritten)
  → для каждого коммита (батчами по 50):
       git show --no-renames? --name-status -M --numstat --format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b
       ограниченный diff по файлам, нужным классификаторам (≤ 20 KiB на коммит)
  → классификация (§ ниже) → предложения изменений памяти
  → POST /repositories/:rid/commits (If-Match: старый cursor) — сервер атомарно записывает git_commits, изменения памяти, двигает cursor
```

Существующие `src/git/extractor.ts` и `noise-filter.ts` расширяются (`--name-status`, parents); `ingest commit --auto` становится тонкой обёрткой над конвейером. Полного сканирования нет: обрабатываются только коммиты `cursor..HEAD`. Пропущенные коммиты (хук не стоял, pull) догоняются автоматически, потому что база — курсор, а не «текущий HEAD».

### Классификаторы (детерминированные, без LLM)

| Признак | Правило |
|---|---|
| Зависимости | изменены манифесты (`package.json`, `*.lock`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, …): парсинг diff → добавлены/удалены/обновлены пакеты |
| API | изменены файлы роутинга/контрактов (`openapi*`, `*.proto`, `*.graphql`, `routes/`, `controllers/`) или публичные экспорты (через codegraph symbols: изменилась сигнатура экспортируемого символа) |
| Архитектура / новые компоненты | новый каталог верхнего уровня или модуль в codegraph; новый Dockerfile/compose‑сервис; изменения конфигов сборки |
| Удалённый функционал | `D` файлов с экспортируемыми символами; удаление экспортов |
| Бизнес‑логика | изменения в каталогах, помеченных в настройках проекта как domain (`pmi.yml: domainPaths`), исключая тесты |
| Исправленные проблемы | conventional commit `fix:` / ссылки `fixes #N` / сопоставление с открытыми `issue` по related_files |
| Изменения ограничений | изменения `engines`, версий рантайма, лимитов в конфиге |

Результаты:
- **Всегда** — запись `git_history` с `confidence=observed` (факты: файлы A/M/D, автор, parent, классы изменений).
- При срабатывании классификатора — запись соответствующей категории (`dependency`, `architecture`, `component`, …) с `confidence=inferred`, связь `derived_from` → коммит.
- Устаревание связанных знаний — §6.
- LLM‑обобщение коммита — опционально (`PMI_GIT_LLM=1`), ограничено бюджетом, учитывается в метрике `ai_analysis_cost`.

### Полная сверка

`pmi git analyze --full` / серверное расписание (по умолчанию раз в неделю, только по запросу клиента с рабочей копией): проверяет существование всех `related_files` всех активных записей, пересобирает codegraph, сравнивает список компонентов с памятью категории `component`. Отчёт → `needs_review` и предложения. `last_full_reconcile_at` в курсоре.

## 8. Метрики и экономия токенов

| Метрика | Источник |
|---|---|
| `tokens_per_session` | сумма receipt всех `context_build` / `session_resume` / `memory_get` в сессии |
| `context_size_tokens{level}` | receipt |
| `memory_retrieval_count` | вызовы search/get |
| `context_build_ms` | receipt |
| `cache_hit_rate` | L1 overview cache, локальный кэш клиента vs запрос к серверу |
| `git_analysis_ms`, `git_commits_analyzed` | конвейер |
| `ai_analysis_cost_usd`, `ai_tokens` | любые LLM‑вызовы (эмбеддинги API, LLM‑дедуп, summarize) |
| `session_recovery_total{result}` | resume: success / conflict / failed |
| `workspace_recovery_total{result}` | restore: success / conflict / integrity_failed |
| `sync_latency_ms` | время от записи в outbox до подтверждения сервером; от `server_seq` до появления у другого клиента |
| `outbox_depth` | клиент |

**Экономия токенов.** Базовая линия — «агент изучает проект заново». Оценка на сессию:

```
baseline_tokens = tokens(README + manifest файлов) + Σ tokens(файлы из «Start here» + файлы, изменённые в сессии + их прямые соседи по codegraph)
                  + tokens(git log -n 50 --stat)
delivered_tokens = Σ receipt.tokens_total за сессию
savings = 1 − delivered / baseline
```

Модель baseline консервативна (агент обычно читает больше). Для честной проверки — бенчмарк на фикстурах: прогон сценария TEST 6 с замером фактических токенов агента с PMI и без (существующий `scripts/benchmark-retrieval.mjs` расширяется). В отчёт идут обе цифры: оценочная (на каждой сессии) и измеренная (бенчмарк).

## 9. Тесты

| Acceptance | Проверка |
|---|---|
| TEST 1 | A (Claude Code, user A) `decision_log` → sync → B (Codex, user B, другой клиент) `context_build` по связанной задаче содержит решение; B не делал поиск по файлам |
| TEST 5 | Фикстура‑репозиторий, 5 коммитов (зависимость, API, удаление, fix, rename) → `git analyze` обрабатывает ровно 5 коммитов (счётчик), курсор сдвинут, записи созданы по классам, связанная `inferred` запись → `needs_review`; повторный вызов — 0 коммитов; `git` вызывается только для `cursor..HEAD` (проверка через перехват runGit) |
| TEST 6 | Проект с 500 записями и 200 сессиями: `session_start` + `context_build` ≤ бюджета, не содержит записей session_history/L3, receipt `tokens_total ≤ 2 300` |
