# PMI — эксплуатация сервера

Документ для того, кто разворачивает и сопровождает центральный сервер PMI (`pmi-server`). Пользовательская часть — [USER_GUIDE.md](USER_GUIDE.md), модель угроз и итоги проверки безопасности — [SECURITY.md](SECURITY.md).

## 1. Состав

| Сервис | Образ | Назначение |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Вся общая память, сессии, снимки (метаданные и blobs < 256 KiB), git‑курсоры, аудит |
| `pmi-server` | собирается из `Dockerfile` | HTTP API `/v1`, MCP `/mcp`, `/health`, `/ready`, `/metrics`; применяет миграции при старте |
| `caddy` | `caddy:2.10-alpine` | TLS (Let's Encrypt для публичного домена, локальный CA для `localhost`), единственный открытый порт |

Тома: `pg-data` (Postgres), `blob-data` (blobs ≥ 256 KiB, `/data/blobs`), `caddy-data`, `caddy-config`.

## 2. Развёртывание

```bash
cp deploy/.env.example deploy/.env
# POSTGRES_PASSWORD, PMI_DOMAIN; рекомендуется также:
#   PMI_BLOB_KEY=$(openssl rand -base64 32)       шифрование blobs
#   PMI_METRICS_TOKEN=$(openssl rand -hex 24)     доступ к /metrics
docker compose -f deploy/compose.yaml up -d --build --wait
```

Первичная настройка (токен выводится один раз):

```bash
alias pmis='docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js'
pmis create-org acme
pmis create-user lead@acme.com --org acme --role admin
pmis issue-token lead@acme.com --name laptop --days 90
```

## 3. Конфигурация `pmi-server`

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PMI_DATABASE_URL` | — (обязательна) | Строка подключения Postgres |
| `PMI_HOST`, `PMI_PORT` | `127.0.0.1`, `7420` | Адрес HTTP; в Compose `0.0.0.0` внутри сети |
| `PMI_TRUST_PROXY` | выкл. | `1` — брать адрес клиента из `X-Forwarded-For` (только за Caddy) |
| `PMI_LEASE_TTL` | `600` | Секунды аренды сессии без продления; затем сессия становится `resumable` |
| `PMI_BLOB_DIR` | `./data/blobs` | Каталог крупных blobs |
| `PMI_BLOB_KEY` | выкл. | 32 байта base64: AES‑256‑GCM для blobs на диске и в БД |
| `PMI_BLOB_KEYS_OLD` | — | Предыдущие ключи через запятую (на время ротации) |
| `PMI_METRICS_TOKEN` | выкл. | Bearer‑токен для `/metrics`; без него эндпоинт отвечает 404 |
| `MEMORIX_EMBEDDING` | `off` | `fastembed` / `transformers` / `api`: семантический поиск (384 измерения) |

## 4. Пользователи и доступ

| Команда | Действие |
|---|---|
| `create-org <slug>` | Организация |
| `create-user <email> [--org S] [--role owner\|admin\|member]` | Пользователь и членство |
| `add-member <org> <email> --role R` | Изменить роль в организации |
| `create-team <org> <name>`, `add-team-member <org> <team> <email>` | Команды |
| `grant <org>/<project> (--user E \| --team T) --role maintainer\|developer\|viewer\|none` | Права на проект |
| `issue-token <email> [--name N] [--days D]` | Токен (выводится один раз; храните только у владельца) |
| `list-tokens <email>`, `revoke-token <id>` | Аудит и отзыв токенов |

Owner/admin организации видят все её проекты; остальным нужен грант (напрямую или через команду). Отключение пользователя: `UPDATE core.users SET disabled_at = now() WHERE email = …` — все его токены перестают действовать сразу.

## 5. Резервное копирование и восстановление

```bash
deploy/backup.sh /backups/pmi-$(date +%F)        # pg_dump + архив тома blobs + MANIFEST с SHA-256
deploy/restore.sh /backups/pmi-2026-10-31        # проверка контрольных сумм, замена БД и blobs, verify-blobs
```

- Резервная копия делается на работающем сервере: `pg_dump` даёт согласованный снимок, blobs неизменяемы.
- `restore.sh` сохраняет текущую БД в `<dir>/pre-restore.dump`, создаёт роль `pmi_app`, восстанавливает БД и том blobs, затем `pmi-server verify-blobs` проверяет каждый blob по хэшу; ненулевой код — восстановление не принимать.
- Ключи `PMI_BLOB_KEY`/`PMI_BLOB_KEYS_OLD` в копию не входят: храните их отдельно (без ключа зашифрованные blobs не прочитать).
- Учения проводятся автоматически: `deploy/acceptance.sh` делает backup → удаление томов → restore → восстановление рабочей копии с новой машины.

Локальное хранилище разработчика: `pmi backup <dir>` / `pmi restore <dir> [--force]` (текущее хранилище не удаляется, а переносится в `<data>.pre-restore-<время>`; токены в копию не входят).

## 6. Обновление

1. `deploy/backup.sh …`
2. `git pull`, `docker compose -f deploy/compose.yaml up -d --build --wait`
3. Миграции применяются при старте `serve` под advisory lock (несколько реплик безопасно); статус — `GET /ready` (`pendingMigrations`).

Миграции только добавляют; откат — восстановление из копии.

## 7. Ротация ключа шифрования blobs

```bash
# 1. новый ключ текущим, старый — в PMI_BLOB_KEYS_OLD; перезапуск
# 2. перешифровать всё под новым ключом
pmis reencrypt-blobs
pmis verify-blobs
# 3. убрать старый ключ из PMI_BLOB_KEYS_OLD; перезапуск
```

Включение шифрования на работающем сервере: задать `PMI_BLOB_KEY`, перезапустить, `reencrypt-blobs` (старые незашифрованные blobs читаются и до этого).

## 8. Мониторинг

`GET /metrics` (Prometheus, `Authorization: Bearer $PMI_METRICS_TOKEN`):

| Метрика | Что смотреть |
|---|---|
| `pmi_http_requests_total{route,status}` | рост 5xx, 429 (подбор токенов) |
| `pmi_context_builds_total`, `pmi_context_tokens_sum`, `pmi_context_build_ms_sum`, `pmi_context_cache_hits_total` | объём и цена контекста |
| `pmi_memories{category}`, `pmi_sessions{status}` | состояние базы знаний и сессий |
| `pmi_session_recovery_total{result}`, `pmi_workspace_recovery_total{result}` | продолжения сессий и восстановления рабочих копий (`conflict` — повод разобраться) |
| `pmi_git_commits_analyzed_total`, `pmi_blobs`, `pmi_blob_bytes` | git‑анализ, объём снимков |

`/health` — процесс жив; `/ready` — Postgres доступен и миграции применены (healthcheck Compose).

Аудит: `core.audit_log` (вход, выдача/отзыв токенов, гранты, push, подтверждение знаний, resume, restore, git‑анализ, отказы в доступе); приложение может только добавлять записи.

## 9. Фоновые задачи сервера

| Задача | Период |
|---|---|
| Истечение аренды сессий → `resumable`/`interrupted` | 30 с (и перед list/resume) |
| Retention снимков и GC blobs (WORKSPACE_RECOVERY.md §7) | 6 ч; вручную `pmis gc` |
| Эмбеддинги новых и изменённых записей | 10 с, если включены |

## 10. Производительность

Нагрузочный тест (`PMI_LOAD_TEST=1 npx vitest run tests/load`, результаты — [LOAD_TEST.md](LOAD_TEST.md)): 100 000 записей, 20 одновременных клиентов — p95 context 358 мс, search 156 мс, push 253 мс, feed 57 мс, без ошибок. Пул соединений по умолчанию — 10; при большом числе клиентов увеличьте `max` в `openDatabase` и `max_connections` Postgres.

## 11. Чек‑лист эксплуатации

- [ ] `POSTGRES_PASSWORD` случайный; `deploy/.env` не в git
- [ ] `PMI_DOMAIN` — публичное имя, порт 443 доступен Caddy для выпуска сертификата
- [ ] `PMI_BLOB_KEY` задан и сохранён отдельно от резервных копий
- [ ] `PMI_METRICS_TOKEN` задан, `/metrics` подключён к мониторингу
- [ ] Токены выдаются с `--days`; раз в квартал `list-tokens` и отзыв неиспользуемых
- [ ] Ежедневный `deploy/backup.sh` и ежеквартальные учения восстановления (`deploy/acceptance.sh` или вручную)
- [ ] Postgres не опубликован наружу (только сеть Compose); `compose.test.yaml` — только для тестов
- [ ] Роль сервера в Postgres в продакшене — не суперпользователь (DATABASE.md §4)
