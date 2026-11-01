---
name: baton
description: Use when Claude Code needs Baton shared memory, reasoning, Git Memory, session handoff, orchestration coordination, or integration troubleshooting.
---

# Baton

Baton is a shared memory layer for the active workspace when Baton tools are available. Use this root skill as a router, then prefer the focused skill for the task.

## Skill Router

| Task | Use |
|---|---|
| Recall/store durable workspace context | `baton-memory` |
| Record or recover why a decision was made | `baton-reasoning` |
| Resume sessions, bind HTTP projects, or prepare handoff | `baton-sessions` |
| Use commit history as evidence | `baton-git-memory` |
| Diagnose MCP/setup/hooks/control-plane issues | `baton-troubleshooting` |

## Default Loop

1. For broad continuation, first call `baton_project_context` with the user's actual task so Baton can choose a task-lensed brief.
2. Search only when more prior context would materially help.
3. Fetch detail before relying on a specific memory.
4. Store decisions, fixes, gotchas, and handoff context that future sessions should not rediscover.
5. Use CLI fallbacks only after MCP tools are confirmed unavailable.

Claude Code can report MCP servers as `pending` during print-mode startup. That
is not a failure by itself. Claude Code supports MCP tool search, and the
Baton Claude plugin asks Claude to eagerly load its small core tool set. In
headless/print-mode, if Baton tools are not in the first visible tool list,
search/select `baton_project_context` before using shell fallback. Run
`baton context --task "<task>" --fallback --brief-json` only after MCP is unavailable, disabled, or
not discoverable, and pass the user's real task text.

Do not store secrets, credentials, raw private transcripts, or trivial one-off actions. Treat memory as context, not as a substitute for reading code and verifying behavior.
