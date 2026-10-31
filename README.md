# PMI — Project Memory Infrastructure

PMI gives AI coding agents shared, project-owned memory, so an agent does not have to study the project from scratch every time. A developer can stop at any point, and another developer, using a different agent and model on another machine, picks up the same task.

PMI is a fork of [Memorix](https://github.com/AVIDS2/memorix) (Apache-2.0) that is being turned into a multi-user, server-backed system. The work is done in phases; see [docs/PMI/ROADMAP.md](docs/PMI/ROADMAP.md).

## Status

| Area | State |
|---|---|
| Local project memory (SQLite), MCP stdio/HTTP, hooks for 15+ agents, git commit ingest, codegraph, context briefs | Working (inherited from Memorix) |
| Central PMI server (PostgreSQL + pgvector): shared project memory, version history, conflicts, offline buffering | Working (Phase 4), `pmi login` / `pmi project link` / `pmi sync` |
| Users, organizations, teams, personal access tokens | Working (Phase 4–5) |
| Per-project grants, RBAC (viewer / developer / maintainer / org admin), Postgres row-level security, audit log | Working (Phase 5) |
| Confirm / deprecate knowledge (people only; agents cannot confirm) | Working (Phase 5): web UI and REST |
| MCP over HTTP on the central server with per-user tokens | Working (Phase 5): `project_list`, `memory_search`, `memory_get` |
| Peer-to-peer sync of memory records (fs / S3 / GitHub / Postgres relay) | Working (inherited), `pmi sync store push/pull` |
| Session state, automatic checkpoints (daemon), handoff, `session list` / `session resume <id>` across users, agents and machines | Working (Phase 6) |
| Workspace snapshots: uncommitted and unpushed work restored byte for byte on another machine (new worktree by default) | Working (Phase 7) |
| Context engine: L1 overview, task-ranked L2 within a token budget, L3 history on request; hybrid search (keyword + pgvector, RRF); Prometheus metrics and token-savings estimate | Working (Phase 8) |
| PMI MCP tools: `context_build`, `project_overview`, `memory_search/get/save`, `decision_log`, `session_*`, `workspace_*` | Working; `memorix_*` tools remain |
| Incremental git intelligence: only new commits are read; dependency, API, structure, deletion, fix and constraint changes become memories; knowledge about changed files is marked for review; one shared cursor per team | Working (Phase 9): `pmi git analyze`, `pmi git-hook` |
| Hardening: security review, encrypted snapshot blobs, TLS, load test, backup/restore, operator docs | Done (Phase 10) |
| Web UI of the central server: projects, knowledge and freshness, sessions, conflicts, audit log, confirming knowledge | Working (Phase 11): `https://<server>/ui/` |

**Installing from scratch** (server, users, developer machines, agents, checks): [INSTALL](docs/PMI/INSTALL.md).

Operators: [OPERATIONS](docs/PMI/OPERATIONS.md) · [SECURITY](docs/PMI/SECURITY.md) · [LOAD_TEST](docs/PMI/LOAD_TEST.md). Users: [USER_GUIDE](docs/PMI/USER_GUIDE.md) · [WEB_UI](docs/PMI/WEB_UI.md).

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
pmi setup --agent claude          # or cursor; codex: --agent codex --global --noPlugin; full list: pmi setup --list
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

`memorix` is kept as an alias of `pmi`. Agents should start with `context_build` (the smallest sufficient context for the task, about 2,300 tokens by default) and fetch details with `memory_get`; architecture decisions go through `decision_log`. The older `memorix_*` tools remain available (see [API.md](docs/PMI/API.md)).

## Central server (Connected mode)

Run the server with Docker Compose (Postgres with pgvector, `pmi-server`, Caddy for TLS):

```bash
cp deploy/.env.example deploy/.env      # set POSTGRES_PASSWORD and PMI_DOMAIN
docker compose -f deploy/compose.yaml up -d --build --wait
```

Create an organization, a user and a token (the token is printed once):

```bash
docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js create-org acme
docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js create-user dev@acme.com --org acme --role admin
docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js issue-token dev@acme.com --name laptop --days 90
```

Organization owners and admins can use every project of their organization. Everyone else needs a grant, directly or through a team:

```bash
docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js create-user bob@acme.com --org acme
docker compose -f deploy/compose.yaml exec pmi-server node dist/server/central/main.js grant acme/billing --user bob@acme.com --role developer
```

Agents without a local client can use the server directly over MCP: `https://<server>/mcp` with `Authorization: Bearer <token>`.

On each developer machine, inside the repository:

```bash
pmi login https://pmi.acme.com --token pmi_pat_...
pmi project link --create --org acme     # first developer; others run `pmi project link`
pmi sync                                 # upload local memory, pull the team's
```

The server's web UI is at `https://<server>/ui/` (sign in with the same token).

For a local trial with `PMI_DOMAIN=localhost`, Caddy serves a certificate from its own CA; point Node at it before `pmi login` (`docker compose -f deploy/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`, then `export NODE_EXTRA_CA_CERTS=$PWD/caddy-root.crt`).

Hand work over between people, agents and machines:

```bash
pmi session start --agent claude-code --task "Cart totals" --objective "tax and discounts included"
pmi session checkpoint --done "Cart model; Tax rules" --pending "Discount codes"
pmi session handoff --next "Validate discount codes in cart.ts"
# another developer, another machine:
pmi session list
pmi session resume <session-id> --agent codex --model gpt-5   # restores the uncommitted work into a new worktree
```

Uncommitted work also moves on its own: `pmi workspace snapshot` on one machine, `pmi workspace restore <id>` on another. Restores go into a new git worktree unless you pass `--in-place`, which works only on a clean working copy; a file that differs from the snapshot's base is never overwritten. Files that look like secrets (`.env`, keys) are left out and listed.

Agents do the same over MCP (`session_checkpoint`, `session_handoff`, `session_list`, `session_resume`). In Connected mode the PMI daemon starts automatically: it checkpoints file changes and commits without the agent, and when the agent process dies it saves a final checkpoint and frees the session for others. If the whole machine is lost, the server frees the session after its lease (`PMI_LEASE_TTL`, 10 minutes) expires.

`pmi sync` keeps working offline: changes stay in the local SQLite store and are sent on the next successful run (exit code 3 means the server was unreachable). `.pmi/project.json` holds no secrets and can be committed; tokens live in `~/.pmi/credentials.json` (mode 0600). Memories containing credential-like values are refused by the server and stay on the machine that wrote them.

## HTTP control plane and Docker

`pmi serve-http` runs the MCP Streamable HTTP endpoint and the dashboard on port 3211. The repository ships a Dockerfile and `compose.yaml`:

```bash
docker compose up -d
curl http://127.0.0.1:3211/health
```

This is the local MCP/dashboard process, not the central server. Outside loopback it refuses to start without `MEMORIX_HTTP_AUTH_TOKEN` (Bearer). For MCP over HTTP with per-user tokens use the central server (`https://<server>/mcp`).

## Development

```bash
npm run build
npm run lint      # tsc --noEmit
npm test          # vitest
```

Central-server tests start a throwaway `pgvector/pgvector:pg17` container (Docker required) or use `PMI_TEST_PG_URL`; without either they are skipped with a message. End-to-end tests need `npm run build`. `deploy/acceptance.sh` runs every acceptance suite against the Docker Compose deployment, including a backup/restore drill; `PMI_LOAD_TEST=1 npx vitest run tests/load` runs the 100k-memory load test.

Work happens on one branch per phase (`pmi/phase-N-*`) with small commits; see [AGENTS.md](AGENTS.md).

## License and attribution

Apache-2.0, see [LICENSE](LICENSE). PMI is derived from Memorix by AVIDS2; the original history is preserved in this repository and the upstream remote is `https://github.com/AVIDS2/memorix`.
