/**
 * Memorix MCP Server
 *
 * Registers all MCP tools and handles the server lifecycle.
 *
 * Tool sources:
 * - memorix_store / memorix_search / memorix_detail / memorix_timeline:
 *     Memorix extensions using claude-mem's 3-layer Progressive Disclosure
 *
 * Extensibility:
 * - Tools live in src/mcp/tools/<domain>.ts and receive connection state via ServerToolContext
 * - Rules and workspace sync tools are available only in the explicit full profile
 * - New agent format adapters plug in without changing this file
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KnowledgeGraphManager } from './memory/graph.js';
import { initObservations, prepareSearchIndex, migrateProjectIds, getAllObservations } from './memory/observations.js';
import { initObservationStore, getObservationStore } from './store/obs-store.js';
import { initSessionStore } from './store/session-store.js';
import { detectProject } from './project/detector.js';
import { isHomeDirectory, writeLastProjectRoot } from './project/launch-root.js';
import { registerAlias, initAliasRegistry, autoMergeByBaseName } from './project/aliases.js';
import { getProjectDataDir } from './store/persistence.js';
import type { ObservationReader } from './types.js';
import { WorkspaceSyncEngine } from './workspace/engine.js';
import {
  resolveToolProfile,
  isToolInProfile,
  describeProfile,
  type ToolProfile,
} from './server/tool-profile.js';
import { initLLM } from './llm/provider.js';
import {
  createProjectBindingController,
  type ProjectBindingController,
  type ProjectBindingHandle,
  type ProjectBindingSource,
  type ProjectBindingTransport,
} from './server/request-context.js';
import { getMcpServerInfo, registerMcpDiscovery } from './server/mcp-compat.js';
import { registerSessionTools } from './mcp/tools/session.js';
import { registerWorkspaceTools } from './mcp/tools/workspace.js';
import { registerContextTools } from './mcp/tools/context.js';
import { registerGitTools } from './mcp/tools/git.js';
import type { AutopilotRetrievalBoundary, ServerToolContext } from './mcp/tools/server-context.js';
import { registerMemoryTools } from './mcp/tools/memory.js';
import { registerRetrievalTools } from './mcp/tools/retrieval.js';
import { registerProjectBriefTools } from './mcp/tools/project-brief.js';
import { registerMaintenanceTools } from './mcp/tools/maintenance.js';
import { registerIntegrationTools } from './mcp/tools/integrations.js';
import { registerMemorixSessionTools } from './mcp/tools/memorix-session.js';
import { registerDashboardTools } from './mcp/tools/dashboard.js';
import { registerTeamTools } from './mcp/tools/team.js';

/**
 * Create and configure the Memorix MCP Server.
 */
/** Optional shared TeamStore — passed by serve-http so all sessions share state */
export interface SharedTeamStore {
  teamStore: import('./team/team-store.js').TeamStore;
}

export interface CreateMemorixServerOptions {
  allowUntrackedFallback?: boolean;
  deferProjectInitUntilBound?: boolean;
  /**
   * Register tools and return before loading the full project memory runtime.
   * Intended for stdio clients and registries where MCP initialize/tools/list must
   * complete quickly even when the local memory corpus is large.
   */
  deferProjectRuntimeInit?: boolean;
  dashboardMode?: 'standalone' | 'control-plane';
  dashboardPort?: number;
  toolProfile?: ToolProfile;
  /**
   * Product-scoped project binding. HTTP transports may keep it beside a
   * legacy session adapter today; no project operation reads session headers.
   */
  projectBinding?: ProjectBindingController;
  /** Transport label used only in the privacy-safe binding receipt. */
  bindingTransport?: ProjectBindingTransport;
  /** Active stateless project handle metadata used only for diagnostics. */
  bindingHandle?: ProjectBindingHandle;
}

/**
 * These read-only tools operate directly on the project-scoped SQLite stores.
 * They are safe before the in-memory observation/Orama runtime is hydrated,
 * which keeps the first MCP request from turning deferred initialization into
 * a hidden synchronous barrier.
 */
export const BOOTSTRAP_SAFE_TOOL_NAMES = new Set([
  'memorix_project_context',
  'memorix_codegraph_status',
  'memorix_graph_context',
  'memorix_context_pack',
  'memorix_session_start',
]);

const AUTOPILOT_RETRIEVAL_BOUNDARY_TTL_MS = 2 * 60 * 1000;

export function shouldAwaitProjectRuntime(toolName: string): boolean {
  return !BOOTSTRAP_SAFE_TOOL_NAMES.has(toolName);
}

export async function createMemorixServer(
  cwd?: string,
  existingServer?: McpServer,
  sharedTeam?: SharedTeamStore,
  options: CreateMemorixServerOptions = {},
): Promise<{
  server: McpServer;
  graphManager: KnowledgeGraphManager;
  projectId: string;
  deferredInit: () => Promise<void>;
  activateProjectRuntime: () => Promise<void>;
  switchProject: (newCwd: string, source?: ProjectBindingSource) => Promise<boolean>;
  getProjectDataDir: () => string;
  isExplicitlyBound: () => boolean;
  getRequestContext: () => import('./server/request-context.js').MemorixRequestContext;
  handleTransportClose: () => void;
}> {
  // Detect current project — strict .git-based detection
  const allowUntrackedFallback = options.allowUntrackedFallback ?? true;
  const deferProjectInitUntilBound = options.deferProjectInitUntilBound ?? false;
  const deferProjectRuntimeInit = options.deferProjectRuntimeInit ?? false;
  const dashboardMode = options.dashboardMode ?? (sharedTeam ? 'control-plane' : 'standalone');
  const configuredDashboardPort = options.dashboardPort ?? (dashboardMode === 'control-plane' ? 3211 : 3210);
  const toolProfile = resolveToolProfile({
    explicit: options.toolProfile,
    envValue: process.env.MEMORIX_MODE,
    fallback: sharedTeam ? 'team' : 'lite',
  });
  const teamFeaturesEnabled = isToolInProfile('team_manage', toolProfile);
  const projectBinding = options.projectBinding ?? createProjectBindingController(cwd ?? process.cwd());
  const detectedProjectRaw = detectProject(cwd);
  const detectedProject = detectedProjectRaw && !isHomeDirectory(detectedProjectRaw.rootPath)
    ? detectedProjectRaw
    : null;
  let rawProject: import('./types.js').ProjectInfo;
  let projectResolved = true;
  let projectResolutionError: string | null = null;
  let currentAgentId: string | undefined; // Session-scoped coordination identity for attribution after explicit join
  // Session opened through this server connection. Several agents may have
  // active sessions in one project, so attribution prefers this one over the
  // most recent active session of the project.
  let connectionSessionId: string | undefined;
  async function resolveConnectionSessionId(): Promise<string | undefined> {
    const { getActiveSession } = await import('./memory/session.js');
    if (connectionSessionId) {
      const { getSessionStore } = await import('./store/session-store.js');
      const own = await getSessionStore().getById(connectionSessionId);
      if (own?.status === 'active') return own.id;
      connectionSessionId = undefined;
    }
    return (await getActiveSession(projectDir, project.id))?.id;
  }
  let teamStore!: import('./team/team-store.js').TeamStore;
  let initTeamStoreForProject: ((dataDir: string) => Promise<import('./team/team-store.js').TeamStore>) | undefined;
  if (detectedProject) {
    rawProject = detectedProject;
  } else {
    const basePath = cwd ?? process.cwd();
    const name = (await import('node:path')).basename(basePath) || 'unknown';
    projectResolved = false;
    projectResolutionError =
      `No git project could be resolved from "${basePath}". ` +
      'This client did not provide a usable workspace root, so project-scoped tools are disabled until a git-backed project is detected.';
    rawProject = allowUntrackedFallback
      ? { id: `untracked/${name}`, name, rootPath: basePath }
      : { id: '__unresolved__', name, rootPath: basePath };
    if (!allowUntrackedFallback && !deferProjectInitUntilBound) {
      console.error(`[memorix] WARNING: ${projectResolutionError}`);
    } else if (allowUntrackedFallback) {
      console.error(`[memorix] WARNING: No .git found in "${basePath}" - project isolation degraded`);
      console.error(`[memorix] Run "git init" in your project for proper isolation.`);
    }
  }

  // Migrate legacy per-project subdirectories into flat base directory (one-time, silent)
  try {
    const { migrateSubdirsToFlat } = await import('./store/persistence.js');
    const migrated = await migrateSubdirsToFlat();
    if (migrated) {
      console.error(`[memorix] Migrated per-project subdirectories into flat storage`);
    }
  } catch { /* migration is optional */ }

  let projectDir = await getProjectDataDir(rawProject.id);

  // Register aliases only for git-backed projects. Unresolved sessions should not
  // silently create canonical IDs or pollute alias mappings.
  let project = rawProject;
  if (projectResolved) {
    initAliasRegistry(projectDir);
    const canonicalId = await registerAlias(rawProject);
    project = { ...rawProject, id: canonicalId };
    if (canonicalId !== rawProject.id) {
      console.error(`[memorix] Alias resolved: ${rawProject.id} -> ${canonicalId}`);
    }
  }
  if (projectResolved) {
    projectBinding.recordResolvedProject(project.id, project.rootPath);
    writeLastProjectRoot(project.rootPath);
  }

  const registerMaintenanceTarget = async (): Promise<void> => {
    if (!projectResolved) return;
    try {
      const { MaintenanceTargetStore } = await import('./runtime/maintenance-targets.js');
      new MaintenanceTargetStore(projectDir).register({
        projectId: project.id,
        projectRoot: project.rootPath,
        dataDir: projectDir,
      });
    } catch {
      // Maintenance target registration is optional until an isolated worker
      // needs it; normal MCP tools must remain usable without it.
    }
  };
  await registerMaintenanceTarget();

  // Initialize project root for YAML config resolution — ensures all config getters
  // (getLLMApiKey, getGitConfig, etc.) pick up project-level memorix.yml, not just user-level.
  // Also load .env from project root for secrets (API keys, base URLs).
  try {
    const { initProjectRoot } = await import('./config/yaml-loader.js');
    initProjectRoot(project.rootPath);
    const { loadDotenv } = await import('./config/dotenv-loader.js');
    loadDotenv(project.rootPath);
  } catch { /* config init is best-effort */ }

  // Initialize lightweight components. Full observation/graph indexing can be
  // deferred for stdio so MCP initialize/tools/list are not blocked by a large
  // local memory corpus or embedding provider startup.
  await initObservationStore(projectDir);
  await initSessionStore(projectDir);
  {
    const store = getObservationStore();
    console.error(`[memorix] ObservationStore backend: ${store.getBackendName()}, generation: ${store.getGeneration()}`);
  }
  let graphManager = new KnowledgeGraphManager(projectDir, project.id);
  if (!deferProjectRuntimeInit) {
    await graphManager.init();
    await initObservations(projectDir);
  }

  const lightweightUnresolvedSession = !projectResolved && deferProjectInitUntilBound;
  let projectRuntimeInitPromise: Promise<void> | null = null;
  let runtimeHydratedForDir: string | null = null;

  const initializeProjectRuntime = async (logPrefix: 'startup' | 'switch'): Promise<void> => {
    await initObservationStore(projectDir);
    await initSessionStore(projectDir);
    graphManager = new KnowledgeGraphManager(projectDir, project.id);
    await graphManager.init();
    await initObservations(projectDir);

    const indexed = await prepareSearchIndex();
    if (indexed > 0) {
      console.error(`[memorix] Prepared search index for ${indexed} observations in project: ${project.id}`);
    }

    const llmConfig = initLLM();
    if (llmConfig) {
      console.error(`[memorix] LLM enhanced mode: ${llmConfig.provider}/${llmConfig.model}`);
    } else {
      console.error(`[memorix] LLM mode: off (set MEMORIX_LLM_API_KEY or OPENAI_API_KEY to enable)`);
    }

    if (logPrefix === 'startup') {
      console.error(`[memorix] Tool profile: ${describeProfile(toolProfile)}`);
    }

    if (logPrefix === 'startup') {
      console.error(`[memorix] Project: ${project.id} (${project.name})`);
      console.error(`[memorix] Data dir: ${projectDir}`);
    } else {
      console.error(`[memorix] Project switched to: ${project.id} (${project.name})`);
      console.error(`[memorix] Data dir: ${projectDir}`);
    }
  };

  if (!lightweightUnresolvedSession && !deferProjectRuntimeInit) {
  // Auto-merge obvious alias groups by scanning observed projectIds in data.
  // This detects splits like local/foo + user/foo (legacy data migration)
  try {
    const { getAllObservations } = await import('./memory/observations.js');
    const store = getObservationStore();
    const observedIds = store.listProjectIds
      ? await store.listProjectIds()
      : [...new Set(getAllObservations().map(o => o.projectId))];
    const merged = await autoMergeByBaseName(observedIds);
    if (merged > 0) {
      console.error(`[memorix] Auto-merged ${merged} alias group(s) by base name`);
    }
  } catch { /* auto-merge is optional */ }

  // Migrate existing observations to canonical project ID for ALL alias groups.
  // This normalizes split projectIds like local/foo + user/foo → canonical.
  try {
    const { getAllAliasGroups } = await import('./project/aliases.js');
    const groups = await getAllAliasGroups();
    let totalMigrated = 0;
    for (const group of groups) {
      if (group.aliases.length > 1) {
        const migrated = await migrateProjectIds(group.aliases, group.canonical);
        if (migrated > 0) {
          console.error(`[memorix] Migrated ${migrated} observations → ${group.canonical}`);
          totalMigrated += migrated;
        }
      }
    }
    if (totalMigrated > 0) {
      console.error(`[memorix] Total migrated: ${totalMigrated} observations across ${groups.filter(g => g.aliases.length > 1).length} project(s)`);
    }
  } catch { /* migration is optional */ }

  await initializeProjectRuntime('startup');
    runtimeHydratedForDir = projectDir;
  } else {
    // Intentionally silent — serve-http.ts deferred logging handles session lifecycle visibility.
    // Noisy per-probe 'awaiting binding' log was removed to reduce terminal spam.
  }

  const ensureProjectRuntimeInitialized = async (): Promise<void> => {
    if (!projectResolved) return;
    if (runtimeHydratedForDir === projectDir) {
      if (projectRuntimeInitPromise) await projectRuntimeInitPromise;
      return;
    }
    if (!projectRuntimeInitPromise) {
      const targetDir = projectDir;
      projectRuntimeInitPromise = (async () => {
        // Auto-merge obvious alias groups by scanning observed projectIds in data.
        try {
          const { getAllObservations } = await import('./memory/observations.js');
          await initObservations(projectDir);
          const store = getObservationStore();
          const observedIds = store.listProjectIds
            ? await store.listProjectIds()
            : [...new Set(getAllObservations().map(o => o.projectId))];
          const merged = await autoMergeByBaseName(observedIds);
          if (merged > 0) {
            console.error(`[memorix] Auto-merged ${merged} alias group(s) by base name`);
          }
        } catch { /* auto-merge is optional */ }

        // Migrate existing observations to canonical project ID for ALL alias groups.
        try {
          const { getAllAliasGroups } = await import('./project/aliases.js');
          const groups = await getAllAliasGroups();
          let totalMigrated = 0;
          for (const group of groups) {
            if (group.aliases.length > 1) {
              const migrated = await migrateProjectIds(group.aliases, group.canonical);
              if (migrated > 0) {
                console.error(`[memorix] Migrated ${migrated} observations → ${group.canonical}`);
                totalMigrated += migrated;
              }
            }
          }
          if (totalMigrated > 0) {
            console.error(`[memorix] Total migrated: ${totalMigrated} observations across ${groups.filter(g => g.aliases.length > 1).length} project(s)`);
          }
        } catch { /* migration is optional */ }

        await initializeProjectRuntime(runtimeHydratedForDir ? 'switch' : 'startup');
        runtimeHydratedForDir = targetDir;
      })().catch((err) => {
        projectRuntimeInitPromise = null;
        throw err;
      });
    }
    await projectRuntimeInitPromise;
  };

  /**
   * Restore process-wide stores/config before a pooled modern runtime handles
   * a tool call. The durable database is shared, but project-root config and
   * the in-memory observation facade are process-global legacy state.
   */
  const activateProjectRuntime = async (): Promise<void> => {
    if (!projectResolved) return;

    await initObservationStore(projectDir);
    await initSessionStore(projectDir);
    await initObservations(projectDir, { skipCorpusLoad: true });

    try {
      const { initProjectRoot } = await import('./config/yaml-loader.js');
      const { resetDotenv, loadDotenv } = await import('./config/dotenv-loader.js');
      initProjectRoot(project.rootPath);
      resetDotenv();
      loadDotenv(project.rootPath);
    } catch {
      // Config activation is best-effort; durable project scoping remains explicit.
    }
    initLLM({ projectRoot: project.rootPath });
  };

  let maintenanceWorker: { stop(): void } | null = null;
  const startProjectMaintenanceWorker = async (autoCleanup = false): Promise<void> => {
    maintenanceWorker?.stop();
    const [{ MaintenanceJobStore, MaintenanceJobWorker }, maintenance, observations, lifecycle] = await Promise.all([
      import('./runtime/maintenance-jobs.js'),
      import('./runtime/project-maintenance.js'),
      import('./memory/observations.js'),
      import('./runtime/lifecycle.js'),
    ]);
    const queue = new MaintenanceJobStore(projectDir);
    const vectorStatus = observations.getVectorStatus(project.id);
    if (vectorStatus.missing > 0) {
      queue.enqueue({
        projectId: project.id,
        kind: 'vector-backfill',
        dedupeKey: 'vector-backfill',
        payload: { limit: 12 },
      });
    }
    if (autoCleanup) {
      queue.enqueue({
        projectId: project.id,
        kind: 'retention-archive',
        dedupeKey: 'startup-retention',
      });
      queue.enqueue({
        projectId: project.id,
        kind: 'consolidation',
        dedupeKey: 'startup-consolidation',
      });
      lifecycle.enqueueLongTermMaintenance({
        dataDir: projectDir,
        projectId: project.id,
        source: 'startup',
        queue,
      });
    }

    // This check is only a small SQLite metadata query. The actual directory
    // walk runs in the isolated maintenance process below.
    try {
      const { CodeGraphStore } = await import('./codegraph/store.js');
      const codeStore = new CodeGraphStore();
      await codeStore.init(projectDir);
      const status = codeStore.status(project.id);
      const indexedAt = status.indexedAt ? Date.parse(status.indexedAt) : Number.NaN;
      const needsRefresh = status.files === 0
        || !Number.isFinite(indexedAt)
        || Date.now() - indexedAt > 10 * 60_000;
      if (needsRefresh) {
        lifecycle.enqueueCodegraphRefresh({
          dataDir: projectDir,
          projectId: project.id,
          source: 'startup',
          maxFiles: 5_000,
          queue,
        });
      }
    } catch {
      // Code Memory is optional; a failed metadata probe must not affect MCP.
    }

    const worker = options.dashboardMode === 'control-plane'
      // Vector embeddings live in this process's Orama index, so a control
      // plane session may only run vector recovery for its own project. The
      // shared HTTP worker handles the other job kinds in isolated processes.
      ? new MaintenanceJobWorker(
        queue,
        maintenance.createProjectMaintenanceHandler(project.id, projectDir, project.rootPath),
        { projectId: project.id, kinds: ['vector-backfill'], pollIntervalMs: 2_000 },
      )
      : new MaintenanceJobWorker(
        queue,
        maintenance.createProjectMaintenanceDispatcher(project.id, projectDir, project.rootPath),
        { projectId: project.id, pollIntervalMs: 2_000 },
      );
    worker.start();
    maintenanceWorker = worker;
  };

  const requireResolvedProject = (action: string) => {
    if (projectResolved) return null;
    return {
      content: [{
        type: 'text' as const,
        text:
          `Cannot ${action} yet.\n` +
          `${projectResolutionError ?? 'No git-backed project is currently bound to this session.'}\n\n` +
          'To bind this session to a project, call memorix_session_start with the projectRoot parameter:\n' +
          '  memorix_session_start({ projectRoot: "/path/to/your/project" })\n\n' +
          'The path should point to a directory containing a .git folder.',
      }],
      isError: true as const,
    };
  };

  // Create MCP server (or use existing one from roots-aware flow)
  const serverInfo = getMcpServerInfo();
  const server = existingServer ?? new McpServer(serverInfo);
  registerMcpDiscovery(server, serverInfo);

  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...args: unknown[]) => {
    if (!isToolInProfile(name, toolProfile)) {
      return undefined as never;
    }
      const maybeConfig = args[0];
      const maybeHandler = args[1];
      if (typeof maybeHandler === 'function' && typeof maybeConfig === 'object' && maybeConfig !== null) {
        const wrappedHandler = async (...handlerArgs: unknown[]) => {
        if (shouldAwaitProjectRuntime(name)) {
          await ensureProjectRuntimeInitialized();
        }
        try {
          return await maybeHandler(...handlerArgs);
        } finally {
          // Any tool call is agent activity: the PMI daemon releases a session
          // only after its agent has been silent for PMI_AGENT_IDLE_MS.
          if (connectionSessionId) await touchPmiSession(projectDir, connectionSessionId);
        }
      };
      return (originalRegisterTool as (...innerArgs: unknown[]) => unknown)(name, maybeConfig, wrappedHandler, ...args.slice(2)) as never;
    }
    return (originalRegisterTool as (...innerArgs: unknown[]) => unknown)(name, ...args) as never;
  }) as typeof server.registerTool;

  const getRequestContext = () => projectBinding.requestContext(currentAgentId);
  const getObservationReader = (scope: 'project' | 'global' = 'project'): ObservationReader => {
    const requestContext = getRequestContext();
    let isTeamMember = false;
    if (teamFeaturesEnabled && requestContext.actorId) {
      try {
        const agent = teamStore.getAgent(requestContext.actorId);
        isTeamMember = agent?.project_id === project.id && agent.status === 'active';
      } catch {
        // A missing coordination store must never grant team visibility.
      }
    }
    return {
      ...(scope === 'project' ? { projectId: requestContext.projectId ?? project.id } : {}),
      ...(requestContext.actorId ? { agentId: requestContext.actorId } : {}),
      isTeamMember,
    };
  };

  // A complete Autopilot brief is the normal retrieval boundary for one coding
  // turn. Keep accidental search/detail loops cheap, while preserving an
  // explicit escape hatch when a caller really needs deeper history.
  let autopilotRetrievalBoundary: AutopilotRetrievalBoundary | null = null;
  const getActiveAutopilotRetrievalBoundary = () => {
    const boundary = autopilotRetrievalBoundary;
    if (!boundary) return null;
    if (boundary.projectId === project.id && Date.now() - boundary.issuedAt <= AUTOPILOT_RETRIEVAL_BOUNDARY_TTL_MS) {
      return boundary;
    }
    autopilotRetrievalBoundary = null;
    return null;
  };
  const requireExplicitAutopilotExpansion = (toolName: string, purpose?: string) => {
    if (!getActiveAutopilotRetrievalBoundary() || purpose?.trim()) return null;

    return {
      content: [{
        type: 'text' as const,
        text:
          'Memorix Autopilot retrieval boundary: the latest `memorix_project_context` already supplied the default bounded brief for this coding turn, so no additional memory was retrieved. ' +
          'Verify the current project first. To intentionally expand beyond that brief, call `' + toolName + '` again with `purpose` naming the specific missing fact or the user\'s explicit request.',
      }],
    };
  };
  const blockCoveredAutopilotEvidence = (toolName: string, observationIds: number[], force?: boolean) => {
    const boundary = getActiveAutopilotRetrievalBoundary();
    if (!boundary || force || observationIds.length === 0 || !observationIds.every(id => boundary.coveredObservationIds.has(id))) {
      return null;
    }
    return {
      content: [{
        type: 'text' as const,
        text:
          'Memorix Autopilot retrieval boundary: every requested memory is already represented in the latest project brief, so no duplicate detail was retrieved. ' +
          'Inspect the current project or seek a new source. Retry with `force: true` only when the user explicitly asks to read the underlying record in full.',
      }],
    };
  };
  const blockReadOnlyAutopilotWrite = (overrideReadOnly?: boolean) => {
    const boundary = getActiveAutopilotRetrievalBoundary();
    if (!boundary?.readOnly || overrideReadOnly) return null;
    return {
      content: [{
        type: 'text' as const,
        text:
          'Memorix write boundary: the latest task is read-only or asks not to modify files, so no memory was stored. ' +
          'Persist a record only when the user explicitly asks to save it, then retry with `overrideReadOnly: true`.',
      }],
    };
  };

  // Use shared TeamStore (from HTTP server) or create new one (stdio mode).
  // All team state is canonical in SQLite — no JSON persistence, no sync/flush.
  if (teamFeaturesEnabled) {
    const { initTeamStore } = await import('./team/team-store.js');
    initTeamStoreForProject = initTeamStore;
    if (sharedTeam?.teamStore) {
      teamStore = sharedTeam.teamStore;
    } else {
      teamStore = await initTeamStore(projectDir);
    }

    // Phase 4b: Wire EventBus for same-process lifecycle notifications.
    // EventBus is process-local only — NOT a cross-process mechanism.
    if (!teamStore.getEventBus()) {
      const { TeamEventBus } = await import('./team/event-bus.js');
      teamStore.setEventBus(new TeamEventBus());
    }
  }

  const ctx: ServerToolContext = {
    get project() { return project; },
    get projectDir() { return projectDir; },
    get projectResolved() { return projectResolved; },
    get graphManager() { return graphManager; },
    get teamStore() { return teamStore; },
    get currentAgentId() { return currentAgentId; },
    set currentAgentId(id) { currentAgentId = id; },
    get connectionSessionId() { return connectionSessionId; },
    set connectionSessionId(id) { connectionSessionId = id; },
    get autopilotRetrievalBoundary() { return autopilotRetrievalBoundary; },
    set autopilotRetrievalBoundary(boundary) { autopilotRetrievalBoundary = boundary; },
    teamFeaturesEnabled,
    projectBinding,
    bindingTransport: options.bindingTransport,
    bindingHandle: options.bindingHandle,
    dashboardMode,
    configuredDashboardPort,
    requireResolvedProject,
    getObservationReader,
    resolveConnectionSessionId,
    getActiveAutopilotRetrievalBoundary,
    requireExplicitAutopilotExpansion,
    blockCoveredAutopilotEvidence,
    blockReadOnlyAutopilotWrite,
    // Declared below the tools; resolved when a tool calls it.
    switchProject: (newCwd, source) => switchProject(newCwd, source),
  };

  registerMemoryTools(server, ctx);
  registerRetrievalTools(server, ctx);
  registerProjectBriefTools(server, ctx);
  registerMaintenanceTools(server, ctx);
  registerIntegrationTools(server, ctx);
  registerMemorixSessionTools(server, ctx);
  registerSessionTools(server, {
    dataDir: () => projectDir,
    project: () => ({ id: project.id, rootPath: project.rootPath }),
    connectionSessionId: () => connectionSessionId,
    setConnectionSessionId: (id) => { connectionSessionId = id; },
    openMemorixSession: async (sessionId, agent) => {
      const { startSession } = await import('./memory/session.js');
      await startSession(projectDir, project.id, { sessionId, agent, reader: getObservationReader() });
    },
    agentPid: process.pid,
  });
  registerContextTools(server, {
    dataDir: () => projectDir,
    project: () => ({ id: project.id, rootPath: project.rootPath }),
    connectionSessionId: () => connectionSessionId,
  });
  registerGitTools(server, {
    dataDir: () => projectDir,
    project: () => ({ id: project.id, rootPath: project.rootPath }),
  });
  registerWorkspaceTools(server, {
    dataDir: () => projectDir,
    project: () => ({ id: project.id, rootPath: project.rootPath }),
    connectionSessionId: () => connectionSessionId,
  });
  registerDashboardTools(server, ctx);
  registerTeamTools(server, ctx);
  // Deferred initialization — runs AFTER transport connect so MCP handshake isn't blocked.
  // Sync advisory scan and file watcher are non-essential for tool functionality.
  const deferredInit = async () => {
    await ensureProjectRuntimeInitialized();

    // Check hook installation status and guide user
    try {
      const { getHookStatus } = await import('./hooks/installers/index.js');
      const workDir = cwd ?? process.cwd();
      const statuses = await getHookStatus(workDir);
      const installedAgents = statuses.filter((s) => s.installed).map((s) => s.agent);

      if (installedAgents.length === 0) {
        console.error('[memorix] No hooks installed. Run "memorix hooks install" to set up auto-capture.');
      } else {
        console.error(`[memorix] Hooks active: ${installedAgents.join(', ')}`);
      }
    } catch { /* skip */ }

    // Git auto-hook: install post-commit hook if memorix.yml has git.autoHook: true
    // Uses worktree-safe hook path resolution (.git may be a file in worktree setups)
    try {
      const { getGitConfig } = await import('./config.js');
      const gitCfg = getGitConfig();
      if (gitCfg.autoHook && project.rootPath) {
        const { ensureHooksDir } = await import('./git/hooks-path.js');
        const resolved = ensureHooksDir(project.rootPath);
        if (resolved) {
          const { existsSync, readFileSync, writeFileSync, chmodSync } = await import('node:fs');
          const { hookPath } = resolved;
          const HOOK_MARKER = '# [memorix-git-hook]';
          const needsInstall = !existsSync(hookPath) || !readFileSync(hookPath, 'utf-8').includes(HOOK_MARKER);
          if (needsInstall) {
            const hookScript = `#!/bin/sh\n${HOOK_MARKER}\n# Memorix: Auto-ingest git commits as memories\nif command -v memorix >/dev/null 2>&1; then\n  memorix ingest commit --auto >/dev/null 2>&1 &\nfi\n`;
            if (existsSync(hookPath)) {
              const existing = readFileSync(hookPath, 'utf-8');
              writeFileSync(hookPath, existing.trimEnd() + '\n\n' + `${HOOK_MARKER}\nif command -v memorix >/dev/null 2>&1; then\n  memorix ingest commit --auto >/dev/null 2>&1 &\nfi\n`, 'utf-8');
            } else {
              writeFileSync(hookPath, hookScript, 'utf-8');
            }
            try { chmodSync(hookPath, 0o755); } catch { /* Windows */ }
            console.error('[memorix] Auto-installed git post-commit hook (git.autoHook: true)');
          }
        }
      }
    } catch { /* git auto-hook is best-effort */ }

    // Read behavior config
    let behaviorConfig: { syncAdvisory: boolean; autoCleanup: boolean } = { syncAdvisory: true, autoCleanup: true };
    try {
      const { getBehaviorConfig } = await import('./config/behavior.js');
      behaviorConfig = getBehaviorConfig({ projectRoot: project.rootPath });
    } catch { /* defaults */ }

    // Sync advisory: compute for diagnostics only.
    // Memory search results must stay pure retrieval content; injecting agent
    // instructions here causes context pollution and tool-loop misbehavior.
    if (!behaviorConfig.syncAdvisory) {
      console.error('[memorix] Sync advisory disabled via config.');
    } else try {
      const engine = new WorkspaceSyncEngine(project.rootPath);
      const scan = await engine.scan();

      const totalMCP = Object.values(scan.mcpConfigs).reduce((sum, arr) => sum + arr.length, 0);
      const totalSkills = scan.skills.length;
      const totalRules = scan.rulesCount;
      const totalWorkflows = scan.workflows.length;
      const hasSyncTargets = totalMCP > 0 || totalSkills > 0 || totalRules > 0 || totalWorkflows > 0;
      console.error(`[memorix] Sync advisory: ${hasSyncTargets ? 'available' : 'nothing to sync'}`);
    } catch { /* sync scan is optional */ }

    if (!behaviorConfig.autoCleanup) {
      console.error('[memorix] Auto-cleanup disabled via config.');
    }

    // Maintenance is durable and leased: retention, consolidation, and vector
    // recovery run outside the MCP request path and survive process restarts.
    try {
      await startProjectMaintenanceWorker(behaviorConfig.autoCleanup);
    } catch {
      // Lexical memory remains available when optional maintenance cannot start.
    }

  };

  // Runtime project switch — called when MCP roots change, projectRoot binding, or new workspace detected.
  // Updates all mutable state; tools read it through `ctx` and pick up new values.
  const switchProject = async (
    newCwd: string,
    source: ProjectBindingSource = 'mcp-roots',
  ): Promise<boolean> => {
    if (source === 'mcp-roots' && projectBinding.isExplicit()) return false;
    const { detectProjectWithDiagnostics } = await import('./project/detector.js');
    if (isHomeDirectory(newCwd)) {
      console.error(`[memorix] Refusing to bind $HOME as a project root: ${newCwd}`);
      return false;
    }
    const result = detectProjectWithDiagnostics(newCwd);
    if (!result.project || isHomeDirectory(result.project.rootPath)) {
      if (result.failure) {
        console.error(`[memorix] Project detection failed for "${newCwd}": [${result.failure.reason}] ${result.failure.detail}`);
      }
      return false;
    }
    const newDetected = result.project;

    // Resolve data dir FIRST (was buggy: used before declaration)
    const newProjectDir = await getProjectDataDir(newDetected.id);
    initAliasRegistry(newProjectDir);
    const newCanonicalId = await registerAlias(newDetected);

    // Allow switch if: different project OR current project is unresolved (__unresolved__)
    if (newCanonicalId === project.id && projectResolved) {
      if (source === 'explicit-project-root') projectBinding.bindExplicit(newDetected.rootPath);
      else if (source === 'mcp-roots') projectBinding.bindFromRoots(newDetected.rootPath);
      else projectBinding.bindStartup(newDetected.rootPath);
      projectBinding.recordResolvedProject(project.id, project.rootPath);
      writeLastProjectRoot(project.rootPath);
      return false; // same project, no-op
    }

    maintenanceWorker?.stop();
    maintenanceWorker = null;

    console.error(`[memorix] Switching project: ${project.id} → ${newCanonicalId}`);

    // Phase 4a: clear agent identity — old project's agent is not valid in new project
    currentAgentId = undefined;
    autopilotRetrievalBoundary = null;

    // Re-resolve data dir with canonical ID (may differ from raw detected ID)
    const canonicalProjectDir = newCanonicalId !== newDetected.id
      ? await getProjectDataDir(newCanonicalId)
      : newProjectDir;

    // Update mutable state — tool modules read it through the `ctx` accessors
    projectResolved = true;
    projectResolutionError = null;
    project = { ...newDetected, id: newCanonicalId };
    projectDir = canonicalProjectDir;
    if (source === 'explicit-project-root') projectBinding.bindExplicit(project.rootPath);
    else if (source === 'mcp-roots') projectBinding.bindFromRoots(project.rootPath);
    else projectBinding.bindStartup(project.rootPath);
    projectBinding.recordResolvedProject(project.id, project.rootPath);
    await registerMaintenanceTarget();

    // Update YAML config root and reload .env for the new project
    try {
      const { initProjectRoot } = await import('./config/yaml-loader.js');
      initProjectRoot(project.rootPath);
      const { resetDotenv, loadDotenv } = await import('./config/dotenv-loader.js');
      resetDotenv();
      loadDotenv(project.rootPath);
    } catch { /* best-effort */ }

    // Reinitialize TeamStore for the new project (per-project isolation)
    // In HTTP mode, the shared TeamStore from serve-http is replaced with
    // a project-specific one. In stdio mode, a fresh one is created.
    try {
      if (!initTeamStoreForProject) throw new Error('Team store init unavailable');
      if (sharedTeam?.teamStore) {
        // HTTP mode: check if the new projectDir already has a cached TeamStore
        // For now, reinitialize since the sharedTeam was for the original project
        teamStore = await initTeamStoreForProject(canonicalProjectDir);
        // Re-attach EventBus if available
        if (!teamStore.getEventBus()) {
          const { TeamEventBus } = await import('./team/event-bus.js');
          teamStore.setEventBus(new TeamEventBus());
        }
      } else {
        // Stdio mode: always reinitialize
        teamStore = await initTeamStoreForProject(canonicalProjectDir);
      }
    } catch { /* best-effort - coordination features degrade gracefully */ }

    writeLastProjectRoot(project.rootPath);
    runtimeHydratedForDir = null;
    projectRuntimeInitPromise = null;
    void ensureProjectRuntimeInitialized().catch((err) => {
      console.error(`[memorix] Background project runtime init failed: ${err instanceof Error ? err.message : err}`);
    });
    try {
      await startProjectMaintenanceWorker();
    } catch {
      // Switching projects must not fail because optional maintenance is unavailable.
    }
    return true;
  };

  const handleTransportClose = (): void => {
    maintenanceWorker?.stop();
    maintenanceWorker = null;
    const agentId = currentAgentId;
    currentAgentId = undefined;
    if (!teamFeaturesEnabled || !agentId) return;

    try {
      teamStore.leaveAgent(agentId);
      teamStore.releaseAllLocks(agentId);
      teamStore.releaseTasksByAgent(agentId);
    } catch { /* best-effort cleanup on transport close */ }
  };

  return {
    server, graphManager, projectId: project.id, deferredInit, activateProjectRuntime, switchProject,
    getProjectDataDir: () => projectDir,
    isExplicitlyBound: () => projectBinding.isExplicit(),
    getRequestContext,
    handleTransportClose,
  };
}

// ── PMI session continuity glue ───────────────────────────────────

/**
 * Record agent activity on the session; never fails a tool call. Awaited by
 * the tool wrapper: a write that outlives the call could reopen the database
 * after its owner closed it (Windows then cannot delete the file).
 */
async function touchPmiSession(dataDir: string, sessionId: string): Promise<void> {
  try {
    const { LocalSessionStore } = await import('./session/local-store.js');
    const store = new LocalSessionStore(dataDir);
    if (store.get(sessionId)) store.touch(sessionId);
  } catch {
    // Activity tracking is best-effort.
  }
}
