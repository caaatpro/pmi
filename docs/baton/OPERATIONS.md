# Baton — эксплуатация сервера

Первая установка шаг за шагом (сервер, пользователи, машины разработчиков, агенты, проверка) — [INSTALL.md](INSTALL.md). Здесь — конфигурация и эксплуатация.

Документ для того, кто разворачивает и сопровождает центральный сервер Baton (`baton-server`). Пользовательская часть — [USER_GUIDE.md](USER_GUIDE.md), модель угроз и итоги проверки безопасности — [SECURITY.md](SECURITY.md).

## 1. Состав

| Сервис | Образ | Назначение |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Вся общая память, сессии, снимки (метаданные и blobs < 256 KiB), git‑курсоры, аудит |
| `baton-server` | `registry.caaat.pro/baton` (CI собирает из `Dockerfile`, см. §2.1) | HTTP API `/v1`, MCP `/mcp`, `/health`, `/ready`, `/metrics`; применяет миграции при старте |
| `caddy` | `caddy:2.10-alpine` | TLS (Let's Encrypt для публичного домена, локальный CA для `localhost`), единственный открытый порт |

Тома: `pg-data` (Postgres), `blob-data` (blobs ≥ 256 KiB, `/data/blobs`), `caddy-data`, `caddy-config`.

## 2. Развёртывание

```bash
cp deploy/.env.example deploy/.env
# POSTGRES_PASSWORD, BATON_DOMAIN; рекомендуется также:
#   BATON_BLOB_KEY=$(openssl rand -base64 32)       шифрование blobs
#   BATON_METRICS_TOKEN=$(openssl rand -hex 24)     доступ к /metrics
docker login registry.caaat.pro
docker compose -f deploy/compose.yaml pull
docker compose -f deploy/compose.yaml up -d --wait
```

Без доступа к registry образ можно собрать из рабочей копии: `docker compose -f deploy/compose.yaml up -d --build --wait`.

### 2.1. Образ

Job `publish-image` в CI собирает `Dockerfile` и публикует `registry.caaat.pro/baton` после того, как прошли все остальные проверки. Публикуются только push в `main` и теги `v*`, PR и ветки `baton/**` — никогда.

| Событие | Теги |
|---|---|
| push в `main` | `latest`, `sha-<короткий sha>` |
| тег `v1.2.3` | `1.2.3`, `1.2`, `sha-<короткий sha>` |

По умолчанию Compose берёт `latest`. Чтобы обновления шли только по вашей команде, закрепите тег в `deploy/.env`: `BATON_IMAGE=registry.caaat.pro/baton:sha-0757b66` или `…:1.2.3`. Платформа — только `linux/amd64`.

Для публикации в репозитории нужны секреты Actions `REGISTRY_USERNAME` и `REGISTRY_PASSWORD`.

Первичная настройка (токен выводится один раз):

```bash
alias pmis='docker compose -f deploy/compose.yaml exec baton-server node dist/server/central/main.js'
pmis create-org acme
pmis create-user lead@acme.com --org acme --role admin
pmis issue-token lead@acme.com --name laptop --days 90
```

Веб‑интерфейс открывается по `https://<BATON_DOMAIN>/ui/` с тем же токеном ([WEB_UI.md](WEB_UI.md)).

## 3. Конфигурация `baton-server`

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `BATON_DATABASE_URL` | — (обязательна) | Строка подключения Postgres |
| `BATON_HOST`, `BATON_PORT` | `127.0.0.1`, `7420` | Адрес HTTP; в Compose `0.0.0.0` внутри сети |
| `BATON_TRUST_PROXY` | выкл. | `1` — брать адрес клиента из `X-Forwarded-For` (только за Caddy) |
| `BATON_LEASE_TTL` | `600` | Секунды аренды сессии без продления; затем сессия становится `resumable` |
| `BATON_BLOB_DIR` | `./data/blobs` | Каталог крупных blobs |
| `BATON_BLOB_KEY` | выкл. | 32 байта base64: AES‑256‑GCM для blobs на диске и в БД |
| `BATON_BLOB_KEYS_OLD` | — | Предыдущие ключи через запятую (на время ротации) |
| `BATON_METRICS_TOKEN` | выкл. | Bearer‑токен для `/metrics`; без него эндпоинт отвечает 404 |
| `BATON_UI` | вкл. | `0` — отключить веб‑интерфейс (`/ui/`, [WEB_UI.md](WEB_UI.md)); API не меняется |
| `BATON_EMBEDDING` | `off` | `fastembed` / `transformers` / `api`: семантический поиск (384 измерения) |

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
deploy/backup.sh /backups/baton-$(date +%F)        # pg_dump + архив тома blobs + MANIFEST с SHA-256
deploy/restore.sh /backups/baton-2026-10-31        # проверка контрольных сумм, замена БД и blobs, verify-blobs
```

- Резервная копия делается на работающем сервере: `pg_dump` даёт согласованный снимок, blobs неизменяемы.
- `restore.sh` сохраняет текущую БД в `<dir>/pre-restore.dump`, создаёт роль `baton_app`, восстанавливает БД и том blobs, затем `baton-server verify-blobs` проверяет каждый blob по хэшу; ненулевой код — восстановление не принимать.
- Ключи `BATON_BLOB_KEY`/`BATON_BLOB_KEYS_OLD` в копию не входят: храните их отдельно (без ключа зашифрованные blobs не прочитать).
- Учения проводятся автоматически: `deploy/acceptance.sh` делает backup → удаление томов → restore → восстановление рабочей копии с новой машины.

Локальное хранилище разработчика: `baton backup <dir>` / `baton restore <dir> [--force]` (текущее хранилище не удаляется, а переносится в `<data>.pre-restore-<время>`; токены в копию не входят).

## 6. Обновление

1. `deploy/backup.sh …`
2. `docker compose -f deploy/compose.yaml pull`, `docker compose -f deploy/compose.yaml up -d --wait` (при закреплённом теге сначала поменяйте `BATON_IMAGE` в `deploy/.env`; при сборке из исходников — `git pull` и `up -d --build --wait`)
3. Миграции применяются при старте `serve` под advisory lock (несколько реплик безопасно); статус — `GET /ready` (`pendingMigrations`).

Миграции только добавляют; откат — восстановление из копии.

## 7. Ротация ключа шифрования blobs

```bash
# 1. новый ключ текущим, старый — в BATON_BLOB_KEYS_OLD; перезапуск
# 2. перешифровать всё под новым ключом
pmis reencrypt-blobs
pmis verify-blobs
# 3. убрать старый ключ из BATON_BLOB_KEYS_OLD; перезапуск
```

Включение шифрования на работающем сервере: задать `BATON_BLOB_KEY`, перезапустить, `reencrypt-blobs` (старые незашифрованные blobs читаются и до этого).

## 8. Мониторинг

`GET /metrics` (Prometheus, `Authorization: Bearer $BATON_METRICS_TOKEN`):

| Метрика | Что смотреть |
|---|---|
| `baton_http_requests_total{route,status}` | рост 5xx, 429 (подбор токенов) |
| `baton_context_builds_total`, `baton_context_tokens_sum`, `baton_context_build_ms_sum`, `baton_context_cache_hits_total` | объём и цена контекста |
| `baton_memories{category}`, `baton_sessions{status}` | состояние базы знаний и сессий |
| `baton_session_recovery_total{result}`, `baton_workspace_recovery_total{result}` | продолжения сессий и восстановления рабочих копий (`conflict` — повод разобраться) |
| `baton_git_commits_analyzed_total`, `baton_blobs`, `baton_blob_bytes` | git‑анализ, объём снимков |

`/health` — процесс жив; `/ready` — Postgres доступен и миграции применены (healthcheck Compose).

Аудит: `core.audit_log` (вход, выдача/отзыв токенов, гранты, push, подтверждение знаний, resume, restore, git‑анализ, отказы в доступе); приложение может только добавлять записи.

## 9. Фоновые задачи сервера

| Задача | Период |
|---|---|
| Истечение аренды сессий → `resumable`/`interrupted` | 30 с (и перед list/resume) |
| Retention снимков и GC blobs (WORKSPACE_RECOVERY.md §7) | 6 ч; вручную `pmis gc` |
| Эмбеддинги новых и изменённых записей | 10 с, если включены |

## 10. Производительность

Нагрузочный тест (`BATON_LOAD_TEST=1 npx vitest run tests/load`, результаты — [LOAD_TEST.md](LOAD_TEST.md)): 100 000 записей, 20 одновременных клиентов — p95 context 358 мс, search 156 мс, push 253 мс, feed 57 мс, без ошибок. Пул соединений по умолчанию — 10; при большом числе клиентов увеличьте `max` в `openDatabase` и `max_connections` Postgres.

## 11. Чек‑лист эксплуатации

- [ ] `POSTGRES_PASSWORD` случайный; `deploy/.env` не в git
- [ ] `BATON_DOMAIN` — публичное имя, порт 443 доступен Caddy для выпуска сертификата
- [ ] `BATON_BLOB_KEY` задан и сохранён отдельно от резервных копий
- [ ] `BATON_METRICS_TOKEN` задан, `/metrics` подключён к мониторингу
- [ ] Токены выдаются с `--days`; раз в квартал `list-tokens` и отзыв неиспользуемых
- [ ] Ежедневный `deploy/backup.sh` и ежеквартальные учения восстановления (`deploy/acceptance.sh` или вручную)
- [ ] Postgres не опубликован наружу (только сеть Compose); `compose.test.yaml` — только для тестов
- [ ] Роль сервера в Postgres в продакшене — не суперпользователь (DATABASE.md §4)
