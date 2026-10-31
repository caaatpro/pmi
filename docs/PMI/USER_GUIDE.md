# PMI — руководство пользователя

PMI хранит знания о проекте и состояние работы так, чтобы любой разработчик, агент и модель продолжали с того места, где остановились другие. Ниже — повседневное использование; развёртывание сервера — [OPERATIONS.md](OPERATIONS.md).

## 1. Установка и подключение агента

```bash
git clone https://github.com/caaatpro/pmi.git && cd pmi && npm ci && npm run build && npm link
cd ~/work/my-project
pmi setup --agent claude          # или codex, cursor, gemini-cli, copilot, windsurf, …
```

`setup` прописывает MCP‑сервер (`memorix serve --mode lite`), правила и хуки агента. Без сервера PMI работает локально (Local mode).

## 2. Подключение к серверу команды (Connected mode)

```bash
pmi login https://pmi.example.com --token pmi_pat_…   # токен выдаёт администратор
pmi project link --create --org acme                    # первый в команде; остальные: pmi project link
pmi sync                                                # выгрузить свою память, получить командную
```

`.pmi/project.json` можно закоммитить — в нём нет секретов. Токены хранятся в `~/.pmi/credentials.json` (0600). В CI: `PMI_SERVER=https://pmi.example.com PMI_TOKEN=…` (токен уходит только на этот сервер).

После `link` фоновой daemon (запускается сам при старте сессии) раз в минуту синхронизирует память и анализирует новые коммиты.

## 3. Что делает агент

| Ситуация | Инструмент MCP |
|---|---|
| Начало работы | `memorix_session_start` (с `task`) — покажет сессии, которые ждут продолжения |
| Нужен контекст под задачу | `context_build` (≈ 2 300 токенов: обзор, текущая сессия, нужные знания); детали — `memory_get(id)` |
| Архитектурное решение | `decision_log` (контекст, решение, альтернативы, последствия) — `proposed`, пока человек не подтвердит |
| Другое знание | `memory_save` (категория, `observed` / `inferred` / `proposed`) |
| Сделан шаг | `session_checkpoint` (готово, осталось, следующее действие) |
| Передать работу | `session_handoff` (`next` — одно конкретное действие) |
| Продолжить чужую работу | `session_list` → `session_resume(id)` — незакоммиченная работа восстанавливается в новый worktree |
| Новые коммиты | `git_analyze` (обычно не нужно: хуки и daemon делают это сами) |

Checkpoints по изменениям файлов и коммитам daemon делает сам; если агент упал или закончились лимиты модели, сессия освобождается и её можно продолжить.

## 4. То же из терминала

```bash
pmi context --task "fix the refund rounding bug"
pmi session start --agent claude-code --task "Refund rounding" --objective "partial refunds exact"
pmi session checkpoint --done "Reproduced; wrote failing test" --pending "Fix; release note"
pmi session handoff --next "Switch rounding to banker's rounding in refund.ts"
pmi session list
pmi session resume <id> --agent codex --model gpt-5        # --worktree <path> | --in-place | --no-restore
pmi workspace snapshot | restore <id> | list | show <id> [--patch]
pmi git analyze [--full]
pmi git-hook                                             # хуки post-commit, post-merge, post-checkout
pmi backup ~/pmi-backup && pmi restore ~/pmi-backup --force
```

Коды возврата: `0` — успех, `1` — ошибка, `2` — отказ или конфликт (ничего не перезаписано), `3` — сервер недоступен (всё сохранено локально и уйдёт при следующей синхронизации).

## 5. Подтверждение знаний

Агенты не могут сделать знание `confirmed`. Человек подтверждает или помечает устаревшим через API (`POST /v1/memories/:id/confirm` / `deprecate` с причиной). Подтверждённое знание не меняется синхронизацией; если коммит затронул его файлы, создаётся задача на проверку. Неподтверждённые знания о изменённых файлах получают статус `needs_review` и в контексте идут ниже.

## 6. Чего PMI не делает

- Не сохраняет переписку с агентом и скрытые рассуждения модели.
- Не загружает в память секреты: такие записи отклоняются, `.env` и ключи не попадают в снимки.
- Не перезаписывает ваши файлы при восстановлении: по умолчанию — новый worktree; при конфликте версия из снимка кладётся рядом (`<file>.pmi-<id>`).
