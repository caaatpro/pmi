# Baton Hub — notes for coding agents

Baton Hub is shared project memory and session continuity for AI coding agents, in TypeScript/Node: the `baton` CLI/MCP server and the `baton-server` team server. The target design and the phase plan are in `docs/baton/`; read `docs/baton/ROADMAP.md` first to see which phase is in progress.

## Ground rules

- Do not rewrite modules from scratch; evolve the existing code.
- Every new feature needs tests; never claim a feature works without running them.
- Migrations must be additive and must not lose user data (back up SQLite before schema changes).
- Never persist secrets, API keys or hidden model reasoning in project memory.
- One branch per phase (`baton/phase-N-<name>`), small logical commits.

## Layout

- `src/server.ts`, `src/server/` — MCP server and tool profiles
- `src/memory/`, `src/store/` — observations, sessions, SQLite schema and migrations
- `src/knowledge/`, `src/compact/`, `src/codegraph/` — context briefs (Workset), progressive disclosure, code index
- `src/domain/` — Baton memory model and session state (pure rules)
- `src/session/` — session continuity client: local store, service, daemon, git state
- `src/context/` — context engine (L1/L2/L3, ranking, budget) and token-savings estimate
- `src/mcp/tools/` — Baton MCP tools (context, sessions, workspace), split out of `src/server.ts`
- `src/server/central/` — `baton-server`: Postgres schema, HTTP API, tokens; `web/` is its web UI (React + Mantine, `npm run build:ui`)
- `src/client/` — Connected-mode client config (`~/.baton`, `.baton/project.json`) and API client
- `src/sync/` — replication of memory records (Baton server, fs/S3/GitHub/Postgres relays)
- `src/git/` — incremental git analysis (pipeline, classifiers, local sink), commit ingest and hooks
- `src/hooks/`, `src/workspace/` — agent hook normalization and MCP config installers
- `src/workspace-snapshot/` — git worktree helpers (Workspace Recovery, Phase 7)
- `src/cli/` — `baton` / `baton` CLI

## Commands

```bash
npm run build       # required before CLI/integration tests that spawn dist/
npm run lint        # tsc --noEmit (server and web UI)
npm test            # full vitest suite
npx vitest run tests/<path>
npx vitest run tests/central   # needs Docker or BATON_TEST_PG_URL
deploy/acceptance.sh           # all acceptance suites against the Compose deployment
BATON_LOAD_TEST=1 npx vitest run tests/load
```

## Project memory

If the Baton MCP tools are available, call `context_build` with the current task before broad file reading, record architecture decisions with `decision_log`, and other durable knowledge with `memory_save`. The CLI fallback is `baton context --task "<task>"`.
