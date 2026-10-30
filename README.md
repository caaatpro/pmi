# PMI — Project Memory Infrastructure

PMI gives AI coding agents shared, project-owned memory, so an agent does not have to study the project from scratch every time. A developer can stop at any point, and another developer, using a different agent and model on another machine, picks up the same task.

PMI is a fork of [Memorix](https://github.com/AVIDS2/memorix) (Apache-2.0) that is being turned into a multi-user, server-backed system. The work is done in phases; see [docs/PMI/ROADMAP.md](docs/PMI/ROADMAP.md).

## Status

| Area | State |
|---|---|
| Local project memory (SQLite), MCP stdio/HTTP, hooks for 15+ agents, git commit ingest, codegraph, context briefs | Working (inherited from Memorix) |
| Multi-device sync of memory records (fs / S3 / GitHub / Postgres relay) | Working, manual `sync store push/pull` |
| Central PMI server (PostgreSQL + pgvector), users, RBAC | Planned: Phase 4–5 |
| Session checkpoints, handoff, `session resume <id>` | Planned: Phase 6 |
| Workspace snapshots (uncommitted changes across machines) | Planned: Phase 7 |
| L1/L2/L3 context engine, token metrics | Planned: Phase 8 |
| Incremental git intelligence | Planned: Phase 9 |

The design lives in [docs/PMI](docs/PMI):
[AUDIT](docs/PMI/AUDIT.md) ·
[ARCHITECTURE](docs/PMI/ARCHITECTURE.md) ·
[DATABASE](docs/PMI/DATABASE.md) ·
[API](docs/PMI/API.md) ·
[SESSION_CONTINUITY](docs/PMI/SESSION_CONTINUITY.md) ·
[WORKSPACE_RECOVERY](docs/PMI/WORKSPACE_RECOVERY.md) ·
[CONTEXT_ENGINE](docs/PMI/CONTEXT_ENGINE.md)

## Requirements

- Node.js 22.18 or newer
- git

## Install from source

```bash
git clone https://github.com/caaatpro/pmi.git
cd pmi
npm ci
npm run build
npm link        # installs the `pmi` and `memorix` commands
```

## Use with an agent

Connect an agent over MCP (stdio). This writes the agent's MCP config, rules and hooks:

```bash
pmi setup --agent claude-code     # or codex, cursor, gemini-cli, copilot, windsurf, ...
```

Useful commands inside a git repository:

```bash
pmi context --task "fix the login redirect"   # bounded project brief for a task
pmi memory search "auth token refresh"
pmi memory store --type decision --title "..." "..."
pmi session start --agent codex
pmi status
pmi doctor
```

`memorix` is kept as an alias of `pmi` during the transition, and MCP tools keep their `memorix_*` names until the PMI tool set lands (see [API.md](docs/PMI/API.md)).

## HTTP control plane and Docker

`pmi serve-http` runs the MCP Streamable HTTP endpoint and the dashboard on port 3211. The repository ships a Dockerfile and `compose.yaml`:

```bash
docker compose up -d
curl http://127.0.0.1:3211/health
```

Outside loopback the server refuses to start without `MEMORIX_HTTP_AUTH_TOKEN` (Bearer). Per-user authentication arrives with the central server in Phase 5.

## Development

```bash
npm run build
npm run lint      # tsc --noEmit
npm test          # vitest
```

Work happens on one branch per phase (`pmi/phase-N-*`) with small commits; see [AGENTS.md](AGENTS.md).

## License and attribution

Apache-2.0, see [LICENSE](LICENSE). PMI is derived from Memorix by AVIDS2; the original history is preserved in this repository and the upstream remote is `https://github.com/AVIDS2/memorix`.
