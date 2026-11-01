---
name: baton-memory
description: Use when prior workspace context, past decisions, solved bugs, handoff state, or durable project knowledge would help a coding task.
---

# Baton Memory

Use Baton as the shared memory layer for the active workspace when Baton tools are available.

## Tool Router

| Situation | Prefer | CLI fallback |
|---|---|---|
| Broad continuation, fresh handoff, or "what do we know?" | `baton_project_context` with the user's task | `baton context --task "<topic>" --fallback --brief-json` |
| Need structured refs/freshness for code-bound memories | `baton_context_pack` | `baton codegraph context-pack --task "<topic>"` |
| Specific past decision, bug, file, or change | `baton_search` | `baton memory search --query "<topic>"` |
| Need the full source for a search hit | `baton_detail` | `baton memory detail --id <id>` |
| Need the sequence around one memory | `baton_timeline` | `baton memory timeline --id <id>` |
| Check source and freshness for a memory | `baton_evidence` | `baton evidence list|get|events` |
| Record whether a memory helped, conflicted, or was corrected | `baton_feedback` | `baton feedback record|show|audit` |
| Learned reusable project knowledge | `baton_store` | `baton memory store --type <type> --entity <name> --title "<title>" "<text>"` |
| Stable source-backed fact or procedure needing long-term review | `baton_store` with `longTerm` | `baton memory long-term qualify|approve --id <id> --reason "..."` |
| Task or bug is complete/outdated | `baton_resolve` | `baton memory resolve --ids <ids>` |

## Search Rules

- Search before broad continuation work, before changing unfamiliar code, or when the user asks about prior work.
- For a fresh coding session, use `baton_project_context` with the user's actual task before ad-hoc file reads or dev-log reads. Baton will choose a task-lensed brief.
- Fetch detail before relying on a specific memory.
- Treat memory as background context. Still read the current code and verify behavior.
- Skip memory lookup for greetings, tiny one-off edits, or questions fully answered by the current file.
- If a fresh project has no memories, proceed normally and do not repeat the same empty search in the same turn.
- If Claude Code print-mode shows Baton MCP as pending and the tools are not visible yet, first use Claude Code's MCP tool search/dynamic loading to find `baton_project_context`. Run `baton context --task "<task>" --fallback --brief-json` from the shell only after MCP is unavailable, disabled, or not discoverable, and pass the user's real task text. Do not skip memory, wait indefinitely on `pending`, or hand-write tool-call syntax.

## Store Rules

| What to store | Type |
|---|---|
| Architecture or product decision | `decision` |
| Bug and fix that may recur | `problem-solution` |
| Non-obvious pitfall | `gotcha` |
| How a subsystem works | `how-it-works` |
| Important implementation change | `what-changed` |
| Accepted compromise | `trade-off` |

- Use concise titles, stable entity names, relevant `filesModified`, and `topicKey` for evolving topics.
- Use `longTerm` only for a stable fact, reusable procedure, or completed episode that merits explicit review. It creates a candidate, not live context; keep the default project scope and do not use it for routine updates.
- A `user` + `portable` durable memory in a task brief is intentionally reusable across projects. When it matches the task, use it as background even if it originated elsewhere; it is not a current-project fact. Expand it only when needed with `baton_detail` and `typedRefs: ["durable:<id>"]`, stating the missing fact as `purpose`.
- Do not store secrets, credentials, raw private transcripts, trivial commands, or routine file reads.
