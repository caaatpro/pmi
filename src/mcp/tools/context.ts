/**
 * Baton context and memory tools (docs/baton/API.md §2): context_build,
 * project_overview, memory_search, memory_get, memory_save, decision_log.
 *
 * Connected mode asks the Baton server, which holds the whole shared memory
 * (hybrid search, cached overview); when it is unreachable or the working
 * copy is not linked, the same engine runs over the local memory. Writes go
 * to local memory first and reach the server with the next sync.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildContext, buildOverview, rankMemories, type ContextLevel, type ContextPackage } from '../../context/engine.js';
import { estimateSavings, LOCAL_ID_PREFIX, observationToContextMemory, recentGitFiles } from '../../context/local.js';
import { MEMORY_CATEGORIES, type MemoryCategory } from '../../domain/memory.js';
import { getAllObservations, getObservation, storeObservation } from '../../memory/observations.js';
import { LocalSessionStore } from '../../session/local-store.js';
import { checkpointSession, connectedProject, flushOutbox, updateSession } from '../../session/service.js';
import type { ObservationType } from '../../types.js';
import type { SessionToolContext } from './session.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: true };

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

function failure(error: unknown): ToolResult {
  return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
}

/** Baton observation type that carries a Baton category (the category itself is stored explicitly). */
const TYPE_FOR_CATEGORY: Partial<Record<MemoryCategory, ObservationType>> = {
  architecture_decision: 'decision',
  solution: 'problem-solution',
  known_limitation: 'gotcha',
  issue: 'gotcha',
  architecture: 'how-it-works',
  component: 'discovery',
  development_history: 'what-changed',
  git_history: 'what-changed',
  session_history: 'session-request',
};

function isOffline(error: unknown): boolean {
  return Boolean((error as { offline?: boolean })?.offline) || ((error as { status?: number })?.status ?? 0) >= 500;
}

export function registerContextTools(server: McpServer, ctx: Omit<SessionToolContext, 'setConnectionSessionId' | 'openBatonSession' | 'agentPid'>): void {
  const localMemories = () => getAllObservations()
    .filter((obs) => obs.projectId === ctx.project().id && (obs.visibility ?? 'project') === 'project' && (obs.sharedWithAgentIds?.length ?? 0) === 0)
    .map(observationToContextMemory);
  const sessionState = () => {
    const id = ctx.connectionSessionId();
    return id ? new LocalSessionStore(ctx.dataDir()).get(id) : undefined;
  };

  server.registerTool('context_build', {
    title: 'Build Context',
    description:
      'Get the minimal sufficient project context for a task, within a token budget: L1 project overview, the current session ' +
      '(next action, open problems) and the most relevant memories (L2). Ask for L3 to include history. Call it before reading ' +
      'files broadly; fetch details of any listed memory with memory_get(id).',
    inputSchema: {
      task: z.string().max(2000).optional(),
      files: z.array(z.string().max(1024)).max(100).optional().describe('Files the task touches'),
      components: z.array(z.string().max(200)).max(20).optional(),
      budget_tokens: z.number().int().min(200).max(32_000).optional().describe('Default 2300'),
      levels: z.array(z.enum(['L1', 'L2', 'L3'])).optional(),
    },
  }, async ({ task, files, components, budget_tokens, levels }) => {
    try {
      const project = ctx.project();
      const session = sessionState();
      const sessionFiles = session?.state.git?.modifiedFiles.map((file) => file.path) ?? [];
      const taskFiles = [...new Set([...(files ?? []), ...sessionFiles])];
      const gitFiles = recentGitFiles(project.rootPath);
      const effectiveTask = task ?? session?.state.task;
      let pkg: ContextPackage | undefined;
      let source: 'server' | 'local' = 'local';
      const connection = connectedProject(project.rootPath);
      if (connection) {
        try {
          if (session) await flushOutbox(new LocalSessionStore(ctx.dataDir()));
          pkg = await connection.api.post<ContextPackage>(`/v1/projects/${connection.link.projectId}/context`, {
            ...(effectiveTask ? { task: effectiveTask } : {}),
            ...(session ? { session_id: session.id } : {}),
            files: taskFiles,
            components: components ?? [],
            recent_git_files: gitFiles,
            ...(budget_tokens ? { budget_tokens } : {}),
            ...(levels ? { levels } : {}),
          });
          source = 'server';
        } catch (error) {
          if (!isOffline(error) && (error as { status?: number }).status !== 404) throw error;
        }
      }
      pkg ??= buildContext(localMemories(), {
        task: effectiveTask,
        files: taskFiles,
        components,
        recentGitFiles: gitFiles,
        budgetTokens: budget_tokens,
        levels: levels as ContextLevel[] | undefined,
        session: session?.state ?? null,
        projectName: project.id,
      });
      const savings = estimateSavings(project.rootPath, taskFiles, pkg.receipt.tokensTotal);
      const receipt = { ...pkg.receipt, source, ...(savings ? { estimatedSavings: savings } : {}) };
      const footer = `\n\n— ${receipt.tokensTotal} tokens (${source}${receipt.cacheHit ? ', cached overview' : ''})${savings ? `; reading the files instead: ~${savings.baselineTokens} tokens` : ''}`;
      return ok(pkg.text + footer, { receipt, included: pkg.included });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('project_overview', {
    title: 'Project Overview',
    description: 'L1 overview of the project: purpose, architecture, conventions, current state and confirmed decisions (≤ 800 tokens).',
    inputSchema: {},
  }, async () => {
    try {
      const project = ctx.project();
      const connection = connectedProject(project.rootPath);
      if (connection) {
        try {
          const overview = await connection.api.get<{ overview: string; tokens: number; cacheHit: boolean }>(`/v1/projects/${connection.link.projectId}/overview`);
          return ok(overview.overview, { tokens: overview.tokens, cacheHit: overview.cacheHit, source: 'server' });
        } catch (error) {
          if (!isOffline(error)) throw error;
        }
      }
      const overview = buildOverview(localMemories(), { projectName: project.id });
      return ok(overview.text, { memoryIds: overview.ids, source: 'local' });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('memory_search', {
    title: 'Memory Search',
    description: 'Search project memory (hybrid keyword + semantic on the Baton server; local when offline). Returns ids for memory_get.',
    inputSchema: {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional(),
      category: z.enum(MEMORY_CATEGORIES).optional(),
    },
  }, async ({ query, limit, category }) => {
    try {
      const project = ctx.project();
      const connection = connectedProject(project.rootPath);
      type Row = { id: string; title: string; category: string; confidence: string };
      let rows: Row[] | undefined;
      let source = 'local';
      if (connection) {
        try {
          const response = await connection.api.post<{ results: Row[]; mode: string }>(`/v1/projects/${connection.link.projectId}/search`, { query, limit: limit ?? 10 });
          rows = response.results.filter((row) => !category || row.category === category);
          source = `server/${response.mode}`;
        } catch (error) {
          if (!isOffline(error)) throw error;
        }
      }
      rows ??= rankMemories(localMemories().filter((m) => !category || m.category === category), { task: query })
        .filter((item) => item.score > 0.2)
        .slice(0, limit ?? 10)
        .map(({ memory }) => ({ id: memory.id, title: memory.title, category: memory.category, confidence: memory.confidence }));
      const text = rows.length ? rows.map((row) => `- [${row.category}/${row.confidence}] ${row.title} — ${row.id}`).join('\n') : 'No matching memories.';
      return ok(text, { results: rows, source });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('memory_get', {
    title: 'Memory Get',
    description: 'Full content of a memory by the id returned from context_build or memory_search.',
    inputSchema: { id: z.string().min(1).max(1024) },
  }, async ({ id }) => {
    try {
      if (id.startsWith(LOCAL_ID_PREFIX) || /^\d+$/.test(id)) {
        const obs = getObservation(Number(id.replace(LOCAL_ID_PREFIX, '')), ctx.project().id);
        if (!obs) throw new Error(`memory ${id} not found`);
        const memory = observationToContextMemory(obs);
        return ok([`# ${memory.title}`, `${memory.category} · ${memory.confidence} · ${memory.status}`, '', memory.content, ...memory.facts.map((fact) => `- ${fact}`)].join('\n'), { memory });
      }
      const connection = connectedProject(ctx.project().rootPath);
      if (!connection) throw new Error(`memory ${id} is a server id and this working copy is not linked`);
      const { memory } = await connection.api.get<{ memory: { title: string; category: string; confidence: string; status: string; content: string; facts: string[]; version: number } }>(`/v1/memories/${encodeURIComponent(id)}`);
      return ok([`# ${memory.title}`, `${memory.category} · ${memory.confidence} · ${memory.status} · v${memory.version}`, '', memory.content, ...memory.facts.map((fact) => `- ${fact}`)].join('\n'), { memory });
    } catch (error) {
      return failure(error);
    }
  });

  const save = async (input: {
    title: string;
    content: string;
    category: MemoryCategory;
    confidence?: 'observed' | 'inferred' | 'proposed';
    facts?: string[];
    files?: string[];
    component?: string;
    topicKey?: string;
  }) => {
    const project = ctx.project();
    const sessionId = ctx.connectionSessionId();
    const { observation, upserted } = await storeObservation({
      entityName: input.component ?? input.category,
      type: TYPE_FOR_CATEGORY[input.category] ?? 'discovery',
      title: input.title,
      narrative: input.content,
      facts: input.facts,
      filesModified: input.files,
      projectId: project.id,
      topicKey: input.topicKey,
      sessionId,
      sourceDetail: 'explicit',
      category: input.category,
      confidence: input.confidence ?? (input.category === 'architecture_decision' ? 'proposed' : 'observed'),
    });
    const ref = { id: `${LOCAL_ID_PREFIX}${observation.id}`, title: observation.title };
    if (sessionId) {
      const store = new LocalSessionStore(ctx.dataDir());
      if (store.get(sessionId)) {
        if (input.category === 'architecture_decision') checkpointSession(store, sessionId, 'decision', { decisions: [ref] });
        else updateSession(store, sessionId, { observations: [ref] });
      }
    }
    return { ref, upserted };
  };

  server.registerTool('memory_save', {
    title: 'Memory Save',
    description:
      'Save durable project knowledge: what you observed (observed), concluded (inferred) or suggest (proposed). Only people ' +
      'confirm knowledge. Pick the category; use topicKey to update the same fact instead of duplicating it. Never save secrets.',
    inputSchema: {
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(20_000),
      category: z.enum(MEMORY_CATEGORIES),
      confidence: z.enum(['observed', 'inferred', 'proposed']).optional(),
      facts: z.array(z.string().max(500)).max(20).optional(),
      files: z.array(z.string().max(1024)).max(50).optional(),
      component: z.string().max(200).optional(),
      topicKey: z.string().max(200).optional(),
    },
  }, async (args) => {
    try {
      const { ref, upserted } = await save(args);
      return ok(`${upserted ? 'Updated' : 'Saved'} ${ref.id}: ${ref.title} [${args.category}/${args.confidence ?? 'default'}]. It reaches the team with the next sync.`, { id: ref.id, upserted });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('decision_log', {
    title: 'Decision Log',
    description:
      'Record an architecture decision in ADR form (context, decision, alternatives, consequences) — it becomes a proposed ' +
      'architecture_decision until a person confirms it — or list the project\'s decisions (action "list").',
    inputSchema: {
      action: z.enum(['add', 'list']).default('add'),
      title: z.string().max(300).optional(),
      context: z.string().max(5000).optional(),
      decision: z.string().max(5000).optional(),
      alternatives: z.array(z.string().max(1000)).max(10).optional(),
      consequences: z.string().max(5000).optional(),
      component: z.string().max(200).optional(),
      files: z.array(z.string().max(1024)).max(50).optional(),
      query: z.string().max(500).optional().describe('list: filter decisions by topic'),
    },
  }, async (args) => {
    try {
      if (args.action === 'list') {
        const project = ctx.project();
        const connection = connectedProject(project.rootPath);
        if (connection) {
          try {
            const path = args.query
              ? `/v1/projects/${connection.link.projectId}/search`
              : `/v1/projects/${connection.link.projectId}/memories?category=architecture_decision&limit=50`;
            const rows = args.query
              ? (await connection.api.post<{ results: Array<{ id: string; title: string; category: string; confidence: string }> }>(path, { query: args.query, limit: 30 })).results.filter((row) => row.category === 'architecture_decision')
              : (await connection.api.get<{ memories: Array<{ id: string; title: string; confidence: string }> }>(path)).memories;
            return ok(rows.map((row) => `- ${row.title} [${row.confidence}] — ${row.id}`).join('\n') || 'No decisions recorded.', { decisions: rows, source: 'server' });
          } catch (error) {
            if (!isOffline(error)) throw error;
          }
        }
        const decisions = rankMemories(localMemories().filter((m) => m.category === 'architecture_decision'), { task: args.query })
          .map(({ memory }) => ({ id: memory.id, title: memory.title, confidence: memory.confidence }));
        return ok(decisions.map((row) => `- ${row.title} [${row.confidence}] — ${row.id}`).join('\n') || 'No decisions recorded.', { decisions, source: 'local' });
      }
      if (!args.title || !args.decision) throw new Error('decision_log add needs `title` and `decision`.');
      const content = [
        args.context ? `Context: ${args.context}` : '',
        `Decision: ${args.decision}`,
        args.alternatives?.length ? `Alternatives considered: ${args.alternatives.join('; ')}` : '',
        args.consequences ? `Consequences: ${args.consequences}` : '',
      ].filter(Boolean).join('\n');
      const facts = [`Decision: ${args.decision}`, ...(args.alternatives ?? []).map((alt) => `Rejected: ${alt}`), ...(args.consequences ? [`Consequence: ${args.consequences}`] : [])];
      const { ref } = await save({ title: args.title, content, category: 'architecture_decision', confidence: 'proposed', facts, files: args.files, component: args.component });
      return ok(`Decision recorded as ${ref.id} (proposed — a person confirms it). It reaches the team with the next sync.`, { id: ref.id });
    } catch (error) {
      return failure(error);
    }
  });
}
