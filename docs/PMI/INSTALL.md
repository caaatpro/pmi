# PMI — установка с нуля

Пошаговая инструкция: сервер команды, пользователи, машина разработчика, подключение агента и проверка, что всё работает. Каждая команда здесь выполнена на чистом окружении (Docker Compose, две машины разработчиков, Claude Code, Cursor и Codex). Подробности эксплуатации — [OPERATIONS.md](OPERATIONS.md), повседневная работа — [USER_GUIDE.md](USER_GUIDE.md).

## Что получится

- **Сервер команды** (один на компанию): Postgres с pgvector, `pmi-server` и Caddy с TLS — три контейнера Docker Compose. Хранит общую память проектов, сессии, снимки рабочих копий; отдаёт веб‑интерфейс `https://<сервер>/ui/`.
- **На каждой машине разработчика**: команда `pmi` (она же `memorix`) и подключённый к ней агент (Claude Code, Cursor, Codex и другие). Память сначала пишется локально, поэтому работа не останавливается без сети.

## 1. Требования

| Где | Что нужно |
|---|---|
| Сервер | Linux или macOS, Docker с Compose v2; для публичного адреса — DNS‑имя, указывающее на сервер, и открытые порты 80 и 443 (сертификат Let's Encrypt Caddy получит сам) |
| Машина разработчика | Node.js 22.18 или новее, git, агент с поддержкой MCP |

## 2. Сервер

### 2.1. Конфигурация

```bash
git clone https://github.com/caaatpro/pmi.git
cd pmi
cp deploy/.env.example deploy/.env
```

Откройте `deploy/.env` и задайте:

| Переменная | Значение |
|---|---|
| `POSTGRES_PASSWORD` | Длинный случайный пароль: `openssl rand -hex 16` |
| `PMI_DOMAIN` | Имя сервера, например `pmi.example.com`; для пробы на своей машине — `localhost` |

Рекомендуется добавить:

```bash
echo "PMI_BLOB_KEY=$(openssl rand -base64 32)" >> deploy/.env       # шифрование снимков рабочих копий
echo "PMI_METRICS_TOKEN=$(openssl rand -hex 24)" >> deploy/.env     # доступ к /metrics
```

Сохраните `PMI_BLOB_KEY` в менеджере паролей: без него зашифрованные снимки не прочитать. `deploy/.env` в git не попадает (он в `.gitignore`).

### 2.2. Запуск

```bash
docker compose -f deploy/compose.yaml up -d --build --wait
```

Первая сборка занимает 2–3 минуты. Команда завершается, когда все три контейнера здоровы. Проверка:

```bash
curl https://pmi.example.com/ready
# {"status":"ready","postgres":"up","pendingMigrations":[]}
```

**Проба на `localhost`.** Caddy выдаёт сертификат своего локального центра сертификации, которому система не доверяет. Достаньте его корневой сертификат и укажите Node и curl:

```bash
docker compose -f deploy/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
export NODE_EXTRA_CA_CERTS=$PWD/caddy-root.crt          # для pmi; добавьте в профиль оболочки
curl --cacert caddy-root.crt https://localhost/ready
```

Браузер покажет предупреждение о сертификате; для пробы его можно принять или добавить `caddy-root.crt` в доверенные.

### 2.3. Первый администратор

Команды сервера выполняются внутри контейнера. Удобно завести короткое имя:

```bash
alias pmis='docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js'
pmis create-org acme --name "Acme"
pmis create-user lead@acme.com --name "Lead" --org acme --role admin
pmis issue-token lead@acme.com --name laptop --days 90
```

Токен (`pmi_pat_…`) печатается один раз — передайте его владельцу. Администратор организации видит все её проекты и может их создавать.

### 2.4. Веб‑интерфейс

Откройте `https://pmi.example.com/ui/` и войдите с токеном. Пока проектов нет, список пуст. Описание страниц — [WEB_UI.md](WEB_UI.md).

## 3. Пользователи и доступ

Каждому участнику — пользователь и токен:

```bash
pmis create-user dev@acme.com --name "Dev" --org acme
pmis issue-token dev@acme.com --name laptop --days 90
```

Обычный участник (`member`) видит только проекты, к которым ему выдан доступ. Доступ выдаётся после того, как проект создан (раздел 4.3):

```bash
pmis grant acme/acme-shop --user dev@acme.com --role developer     # viewer | developer | maintainer
```

`acme-shop` — slug проекта: его печатает `pmi project link --create`, он же виден в веб‑интерфейсе. Права можно выдавать командам: `pmis create-team acme backend`, `pmis add-team-member acme backend dev@acme.com`, `pmis grant acme/acme-shop --team backend --role developer`.

| Роль | Может |
|---|---|
| viewer | Читать знания, видеть список сессий (без подробностей) |
| developer | Всё, что viewer, плюс писать память, вести и продолжать сессии, восстанавливать снимки, подтверждать знания |
| maintainer | Плюс выдавать права на проект, принудительно забирать сессию, видеть журнал аудита |

## 4. Машина разработчика

### 4.1. Установка `pmi`

```bash
git clone https://github.com/caaatpro/pmi.git
cd pmi
npm ci
npm run build
npm link                      # команды pmi, memorix и pmi-server в PATH
pmi --version
```

Агенты запускают MCP‑сервер командой `memorix`, поэтому она должна быть в `PATH` того окружения, из которого стартует агент.

### 4.2. Вход на сервер

```bash
pmi login https://pmi.example.com --token pmi_pat_…
# Logged in to https://pmi.example.com as lead@acme.com (acme:admin)
```

Токен сохраняется в `~/.pmi/credentials.json` (права 0600) и отправляется только на этот сервер.

### 4.3. Подключение репозитория

Проект PMI соответствует git‑репозиторию. **Первый человек** (администратор организации) создаёт проект:

```bash
cd ~/work/shop
pmi project link --create --org acme
# Created and linked project acme-shop on https://pmi.example.com.
git add .pmi/project.json && git commit -m "Connect PMI" && git push
```

`.pmi/project.json` — адрес сервера и id проекта, секретов в нём нет. **Остальные** после выдачи доступа (раздел 3) просто клонируют репозиторий и выполняют:

```bash
pmi project link
pmi sync                      # отправить свою память, получить командную
```

### 4.4. Подключение агента

Выполняется в корне репозитория. После настройки перезапустите агента.

| Агент | Команда | Что пишет |
|---|---|---|
| Claude Code | `pmi setup --agent claude` | `.mcp.json` (MCP‑сервер проекта), `CLAUDE.md` (правила), `.claude/settings.local.json` (хуки) |
| Cursor | `pmi setup --agent cursor` | `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/rules/memorix.mdc`, `.cursor/skills/` |
| Codex | `pmi setup --agent codex --global --noPlugin` | `~/.codex/config.toml` (`[mcp_servers.memorix]`); без `--noPlugin` ставится плагин Codex, его затем включают в самом Codex |
| Другие | `pmi setup --list` | Список поддерживаемых агентов (Gemini CLI, Windsurf, Copilot, Kiro и др.) |

Для Claude Code и Cursor закоммитьте `.mcp.json` / `.cursor/mcp.json` и правила, чтобы команда получила их с репозиторием, а личные файлы добавьте в `.gitignore`:

```bash
echo ".claude/settings.local.json" >> .gitignore
git add .gitignore .mcp.json CLAUDE.md && git commit -m "PMI for Claude Code"
```

Claude Code при первом запуске в проекте спросит, доверять ли MCP‑серверу из `.mcp.json`, — ответьте «да».

## 5. Проверка

**Память доходит до другого человека.** На первой машине:

```bash
pmi remember --type decision --title "Prices are integer cents" "All money is integer cents; never floats."
pmi sync
```

На второй:

```bash
pmi sync
pmi memory search "integer cents"        # запись первой машины
```

**Работу можно передать.** На первой машине:

```bash
pmi session start --agent claude-code --task "Discount codes" --objective "codes apply before tax"
pmi session checkpoint --done "Discount model" --pending "Validation; UI field"
pmi session handoff --next "Validate discount codes before tax"
```

На второй:

```bash
pmi session list
pmi session resume <id> --agent codex --model gpt-5
```

`resume` печатает следующее действие, сделанное и оставшееся, а незакоммиченные файлы первой машины восстанавливает в новый worktree рядом с репозиторием (`shop-pmi-…`) и проверяет каждый по SHA‑256.

**Агент видит память.** Попросите агента: «вызови `context_build` для задачи …» — в ответе будут знания проекта и текущая сессия. Без просьбы агент обращается к памяти по правилам, которые записал `pmi setup` (`CLAUDE.md`, `.cursor/rules/`).

**Всё видно в интерфейсе.** В `https://pmi.example.com/ui/` у проекта появятся знания, обе сессии (переданная — «завершена», продолжение — «в работе») и курсор анализа git.

## 6. Дальше само

- **Daemon** запускается при старте сессии: делает checkpoints по изменениям файлов и коммитам, продлевает аренду сессии, доставляет очередь на сервер. Если агент упал, сессия освобождается и её можно продолжить.
- **Коммиты** анализируются инкрементально (новые записи, пометки «на проверку» у устаревших знаний); хуки git ставит `pmi git-hook`.
- **Без сети** всё копится локально и уходит при следующем `pmi sync` или работе daemon.

## 7. Частые проблемы

| Симптом | Причина и решение |
|---|---|
| `pmi: command not found`, агент не видит MCP‑сервер `memorix` | Не выполнен `npm link`, или агент запускается из окружения без вашего `PATH` (GUI‑приложения на macOS). Проверьте `which memorix`; в крайнем случае укажите в конфиге агента полный путь к `memorix` |
| `unable to verify the first certificate` / `self-signed certificate` | Сервер на `localhost` или с внутренним CA: задайте `NODE_EXTRA_CA_CERTS` (раздел 2.2) |
| `no project on the server matches this repository` | Нет доступа к проекту или проект не создан: попросите администратора выдать роль (раздел 3) или создайте `--create`, если вы администратор организации |
| `ambiguous_project` | Несколько проектов на сервере совпали с репозиторием (например, форк с тем же первым коммитом). `pmi project link` пока не умеет выбирать проект: обратитесь к администратору организации |
| `401 unauthorized` | Токен истёк или отозван: новый токен (`pmis issue-token`), затем `pmi login` |
| Код выхода `3` у `pmi sync` / `session` | Сервер недоступен; всё сохранено локально и уйдёт позже |
| Caddy не получает сертификат | DNS‑имя не указывает на сервер или закрыты порты 80/443: `docker compose -f deploy/compose.yaml logs caddy` |
| `/ready` отвечает 503 | Postgres не готов или есть невыполненные миграции: `docker compose -f deploy/compose.yaml logs pmi-server` |

Обновление сервера, резервные копии, ротация ключей и мониторинг — [OPERATIONS.md](OPERATIONS.md).
