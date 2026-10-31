# Baton — руководство пользователя

Baton хранит знания о проекте и состояние работы так, чтобы любой разработчик, агент и модель продолжали с того места, где остановились другие. Ниже — повседневное использование; развёртывание сервера — [OPERATIONS.md](OPERATIONS.md).

## 1. Установка и подключение агента

Полная пошаговая установка с сервером и проверкой — [INSTALL.md](INSTALL.md). Кратко:

```bash
git clone https://github.com/caaatpro/pmi.git && cd baton && npm ci && npm run build && npm link
cd ~/work/my-project
baton setup --agent claude          # или cursor; Codex: baton setup --agent codex --global --noPlugin; все: baton setup --list
```

`setup` прописывает MCP‑сервер (`baton serve --mode lite`), правила и хуки агента. Без сервера Baton работает локально (Local mode).

## 2. Подключение к серверу команды (Connected mode)

```bash
baton login https://baton.example.com --token baton_pat_…   # токен выдаёт администратор
baton project link --create --org acme                    # первый в команде; остальные: baton project link
baton sync                                                # выгрузить свою память, получить командную
```

`.baton/project.json` можно закоммитить — в нём нет секретов. Токены хранятся в `~/.baton/credentials.json` (0600). В CI: `BATON_SERVER=https://baton.example.com BATON_TOKEN=…` (токен уходит только на этот сервер).

После `link` фоновой daemon (запускается сам при старте сессии) раз в минуту синхронизирует память и анализирует новые коммиты.

## 3. Что делает агент

| Ситуация | Инструмент MCP |
|---|---|
| Начало работы | `baton_session_start` (с `task`) — покажет сессии, которые ждут продолжения |
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
baton context --task "fix the refund rounding bug"
baton session start --agent claude-code --task "Refund rounding" --objective "partial refunds exact"
baton session checkpoint --done "Reproduced; wrote failing test" --pending "Fix; release note"
baton session handoff --next "Switch rounding to banker's rounding in refund.ts"
baton session list
baton session resume <id> --agent codex --model gpt-5        # --worktree <path> | --in-place | --no-restore
baton workspace snapshot | restore <id> | list | show <id> [--patch]
baton git analyze [--full]
baton git-hook                                             # хуки post-commit, post-merge, post-checkout
baton backup ~/baton-backup && baton restore ~/baton-backup --force
```

Коды возврата: `0` — успех, `1` — ошибка, `2` — отказ или конфликт (ничего не перезаписано), `3` — сервер недоступен (всё сохранено локально и уйдёт при следующей синхронизации).

## 5. Подтверждение знаний

Агенты не могут сделать знание `confirmed`. Человек подтверждает или помечает устаревшим в веб‑интерфейсе (раздел 6) или через API (`POST /v1/memories/:id/confirm` / `deprecate` с причиной). Подтверждённое знание не меняется синхронизацией; если коммит затронул его файлы, создаётся задача на проверку. Неподтверждённые знания о изменённых файлах получают статус `needs_review` и в контексте идут ниже.

## 6. Веб‑интерфейс

`https://<сервер>/ui/` — проекты, знания и их актуальность, сессии, конфликты, журнал аудита ([WEB_UI.md](WEB_UI.md)). Вход тем же личным токеном. На странице записи можно подтвердить знание или пометить его устаревшим с причиной — это и есть «подтверждение человеком» из раздела 5.

## 7. Чего Baton не делает

- Не сохраняет переписку с агентом и скрытые рассуждения модели.
- Не загружает в память секреты: такие записи отклоняются, `.env` и ключи не попадают в снимки.
- Не перезаписывает ваши файлы при восстановлении: по умолчанию — новый worktree; при конфликте версия из снимка кладётся рядом (`<file>.baton-<id>`).
