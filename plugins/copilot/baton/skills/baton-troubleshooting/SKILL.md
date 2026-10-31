---
name: baton-troubleshooting
description: Use when Baton MCP, setup, project binding, HTTP control plane, hooks, skills, or agent integration is missing, stale, or failing.
---

# Baton Troubleshooting

Prefer direct CLI diagnostics first. MCP is an integration surface, not the only way to operate Baton.

## Diagnostic Router

| Symptom | Check | CLI fallback |
|---|---|---|
| MCP tools missing | host MCP config and restart | `baton setup --agent <agent>` |
| Unsure project is bound | project status | `baton status` and `git status` |
| HTTP MCP stale or unbound | background health and explicit session bind | `baton background status`; then `baton session start --projectRoot <path>` |
| Hooks not firing | hook status | `baton hooks status` |
| Need to inspect generated files | preview | `baton hooks preview --agent <agent>` |
| Setup looks incomplete | reinstall host integration | `baton setup --agent <agent>` |
| Need dashboard/control plane | background service | `baton background start` or `baton serve-http --port 3211` |

## Mode Rules

- Use stdio MCP (`baton serve`) for normal host-launched MCP integration.
- Use HTTP/background only for shared endpoint, dashboard, Docker, multiple clients, or foreground control-plane debugging.
- On Windows, prefer absolute native paths for `projectRoot` and remember that visually similar junction paths may bind different session histories.
- If MCP is unavailable but the CLI works, continue through CLI commands instead of blocking.
