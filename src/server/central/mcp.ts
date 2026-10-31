/**
 * MCP over Streamable HTTP on the central server (`POST /mcp`), for agents
 * that reach PMI without a local client (Server-only mode, ARCHITECTURE.md §3).
 *
 * Stateless: every request is authenticated with the caller's personal access
 * token, gets its own McpServer bound to that user, and every tool runs
 * through `authorize()` and inside `db.asUser()`, so row-level security
 * applies to MCP exactly as to REST. Tool names follow the PMI surface
 * (docs/PMI/API.md §2); the rest of that surface lands with later phases.
 */
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { Database } from './db.js';
import { HttpError, authorize, listProjects, type AuthUser } from './identity.js';
import { getMemory, listVersions, memoriesByIds } from './memory-repo.js';
import { hybridSearch } from './context-repo.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof HttpError ? `${error.code}: ${error.message}` : 'internal error';
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createUserMcpServer(db: Database, user: AuthUser, version: string): McpServer {
  const server = new McpServer({ name: 'pmi-server', version });

  server.registerTool('project_list', {
    description: 'List the PMI projects you can access, with your role in each.',
    inputSchema: {},
  }, async () => {
    try {
      const projects = await listProjects(db, user.id);
      const text = projects.length
        ? projects.map((p) => `- ${p.slug} (${p.id}) — ${p.role}`).join('\n')
        : 'You have no project access.';
      return ok(text, { projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name, role: p.role })) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('memory_search', {
    description: 'Keyword search over project memory. Omit project_id to search every project you can read.',
    inputSchema: {
      query: z.string().min(1).max(500),
      project_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async ({ query, project_id, limit }) => {
    try {
      const projectIds = project_id
        ? [(await authorize(db, user, project_id, 'memory.read')).id]
        : (await listProjects(db, user.id)).map((p) => p.id);
      const hits = await db.asUser(user.id, async (tx) => memoriesByIds(tx, (await hybridSearch(tx, projectIds, query, { limit: limit ?? 10 })).map((hit) => hit.id)));
      const text = hits.length
        ? hits.map((m) => `- [${m.category}/${m.confidence}] ${m.title} — id ${m.id}`).join('\n')
        : 'No matching memories.';
      return ok(text, { results: hits.map((m) => ({ id: m.id, projectId: m.projectId, title: m.title, category: m.category, confidence: m.confidence })) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('memory_get', {
    description: 'Full content of one memory by id, optionally with its version history.',
    inputSchema: { id: z.string().min(1).max(1024), versions: z.boolean().optional() },
  }, async ({ id, versions }) => {
    try {
      const memory = await db.asUser(user.id, (tx) => getMemory(tx, id));
      if (!memory || memory.deleted) throw new HttpError(404, 'memory_not_found', 'memory not found');
      await authorize(db, user, memory.projectId, 'memory.read');
      const history = versions ? await db.asUser(user.id, (tx) => listVersions(tx, id)) : undefined;
      const text = [
        `# ${memory.title}`,
        `${memory.category} · ${memory.confidence} · ${memory.status} · v${memory.version}`,
        '',
        memory.content,
        ...(memory.facts.length ? ['', ...memory.facts.map((fact) => `- ${fact}`)] : []),
      ].join('\n');
      return ok(text, { memory, ...(history ? { versions: history } : {}) });
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}

export async function handleMcpRequest(
  db: Database,
  user: AuthUser,
  version: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createUserMcpServer(db, user, version);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
