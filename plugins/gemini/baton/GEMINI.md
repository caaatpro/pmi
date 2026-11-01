# Baton

This extension adds Baton memory guidance for the active Gemini CLI workspace.

Use Baton when prior workspace context, decisions, fixes, or handoff state would materially help the current task and Baton tools are available.

- Call `baton_project_context` with the user's actual task for continuation, fresh handoff, or unfamiliar coding work so Baton can choose a task-lensed brief.
- If the MCP tool is not visible yet but the client supports tool discovery or dynamic loading, search/select `baton_project_context` first. Run `baton context --task "<task>" --fallback --brief-json` only after MCP is unavailable, disabled, or not discoverable, and pass the user's real task text.
- Use `baton_context_pack` when you need structured refs and freshness for code-bound memories.
- Use `baton_graph_context` for explicit memory graph questions.
- Use `baton_search` for focused lookup.
- Use `baton_detail` before relying on a specific memory.
- Use `baton_store` for durable workspace knowledge.
- Use `baton_evidence` when you need to check a memory's source, freshness, or verification state.
- Use `baton_feedback` when a memory helped, conflicted with current evidence, or was corrected.
- Use `longTerm` on `baton_store` only for a stable fact, reusable procedure, or completed episode that merits explicit review. It creates a candidate, not live context; keep the default project scope and do not use it for routine updates.
- A `user` + `portable` durable memory in a task brief is intentionally reusable across projects. When it matches the task, use it as background even if it originated elsewhere; it is not a current-project fact. Expand it only when needed with `baton_detail` and `typedRefs: ["durable:<id>"]`, stating the missing fact as `purpose`.
- Use `baton_store_reasoning` for the reason behind a technical decision.
- Use `baton_resolve` when completed or outdated memories should stop surfacing.

The standard extension uses the `lite` MCP profile (20 tools). Coordination and advanced tools are opt-in through `--mode team` or `--mode full`; use the CLI fallback instead of repeatedly probing unavailable tools.

Do not store secrets, credentials, raw private transcripts, or trivial one-off actions.
