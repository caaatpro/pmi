---
name: memorix-orchestrate
description: Use when a main agent needs Memorix to coordinate explicit subagent work through tasks, handoffs, messages, or file locks.
---

# Memorix Orchestrate

Use Memorix coordination for explicit subagent workflows with joined identities, tasks, handoffs, messages, and file locks.

The standard setup uses the `lite` MCP profile. Coordination MCP tools are exposed only by `team` or `full`; use the CLI fallback for ordinary installations, or explicitly start the server with `--mode team`. Do not probe unavailable team tools in a loop.

## Tool Router

| Situation | Prefer | CLI fallback |
|---|---|---|
| Register coordination identity | `team_manage` action `join` | `memorix team join --agentType <agent>` |
| Create or inspect tasks | `team_task` | `memorix task create|list|claim|complete` |
| Send or read coordination messages | `team_message` | `memorix message send|broadcast|inbox` |
| Share structured handoff | `memorix_handoff` | `memorix handoff send` |
| Avoid file conflicts | `team_file_lock` | `memorix lock lock|unlock|status` |
| Poll joined coordination state | `memorix_poll` | `memorix poll` |

## Boundaries

- For ordinary memory, do not join coordination state.
- In worker prompts, use the worker agent ID returned by session start or team join; never use the coordinator ID as the worker identity.
