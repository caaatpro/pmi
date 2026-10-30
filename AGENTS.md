# PMI — notes for coding agents

PMI (Project Memory Infrastructure) is a TypeScript/Node fork of Memorix. The target design and the phase plan are in `docs/PMI/`; read `docs/PMI/ROADMAP.md` first to see which phase is in progress.

## Ground rules

- Do not rewrite modules from scratch; evolve the existing Memorix code.
- Every new feature needs tests; never claim a feature works without running them.
- Migrations must be additive and must not lose user data (back up SQLite before schema changes).
- Never persist secrets, API keys or hidden model reasoning in project memory.
- One branch per phase (`pmi/phase-N-<name>`), small logical commits.

## Layout

- `src/server.ts`, `src/server/` — MCP server and tool profiles
- `src/memory/`, `src/store/` — observations, sessions, SQLite schema and migrations
- `src/knowledge/`, `src/compact/`, `src/codegraph/` — context briefs (Workset), progressive disclosure, code index
- `src/domain/` — PMI memory model and session state (pure rules)
- `src/session/` — session continuity client: local store, service, daemon, git state
- `src/mcp/tools/` — MCP tools split out of `src/server.ts` (session continuity so far)
- `src/server/central/` — `pmi-server`: Postgres schema, HTTP API, tokens
- `src/client/` — Connected-mode client config (`~/.pmi`, `.pmi/project.json`) and API client
- `src/sync/` — replication of memory records (PMI server, fs/S3/GitHub/Postgres relays)
- `src/git/` — commit ingest and git hooks
- `src/hooks/`, `src/workspace/` — agent hook normalization and MCP config installers
- `src/workspace-snapshot/` — git worktree helpers (Workspace Recovery, Phase 7)
- `src/cli/` — `pmi` / `memorix` CLI

## Commands

```bash
npm run build       # required before CLI/integration tests that spawn dist/
npm run lint        # tsc --noEmit
npm test            # full vitest suite
npx vitest run tests/<path>
npx vitest run tests/central   # needs Docker or PMI_TEST_PG_URL
```

## Project memory

If the PMI/Memorix MCP tools are available, call `memorix_project_context` with the current task before broad file reading, and store durable decisions with `memorix_store` (type `decision`). The CLI fallback is `pmi context --task "<task>"`.
