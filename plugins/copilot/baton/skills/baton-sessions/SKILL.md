---
name: baton-sessions
description: Use when resuming work, preparing handoff context, binding an HTTP control-plane project, or deciding whether session_start is useful.
---

# Baton Sessions

`baton_session_start` is optional. Use it when session semantics help; do not make memory-only work heavier than needed.

## Tool Router

| Situation | Prefer | CLI fallback |
|---|---|---|
| Resume a prior long-running task | `baton_session_start` | `baton session start --agent <name>` |
| HTTP control plane needs project binding | `baton_session_start` with `projectRoot` | `baton session start --projectRoot <absolute-path>` |
| Need recent handoff/session summaries | `baton_session_context` | `baton session context` |
| End a real working session | `baton_session_end` | `baton session end --sessionId <id> --summary "<summary>"` |
| Need explicit subagent coordination identity | `baton_session_start` with `joinTeam: true` | `baton session start --joinTeam --agentType <agent>` |

## Decision Rules

- For normal memory search/store, do not require session start.
- In HTTP mode, pass the absolute workspace path as `projectRoot` when available.
- `projectRoot` is a detection anchor; Git identity is the final project identity.
- Do not join coordination state unless the user is using tasks, messages, locks, or handoff.
