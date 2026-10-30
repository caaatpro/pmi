/**
 * Connection state shared by the inherited Memorix MCP tools.
 *
 * `createMemorixServer` owns this state and changes it when the connection is
 * rebound to another project (`switchProject`) or an agent joins the team.
 * Tool modules read it through accessors on this object instead of closures,
 * so a value read inside a handler is always the current one.
 */
import type { KnowledgeGraphManager } from '../../memory/graph.js';
import type { TeamStore } from '../../team/team-store.js';
import type { ObservationReader, ProjectInfo } from '../../types.js';
import type {
  ProjectBindingController,
  ProjectBindingHandle,
  ProjectBindingSource,
  ProjectBindingTransport,
} from '../../server/request-context.js';

/** Plain text answer a guard returns in place of running the tool (a type alias, so it fits CallToolResult). */
export type ToolNotice = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

/** Set by memorix_project_context: the brief bounds retrieval for one coding turn. */
export interface AutopilotRetrievalBoundary {
  projectId: string;
  issuedAt: number;
  coveredObservationIds: Set<number>;
  readOnly: boolean;
}

export interface ServerToolContext {
  // ── Mutable connection state ──
  readonly project: ProjectInfo;
  readonly projectDir: string;
  readonly projectResolved: boolean;
  readonly graphManager: KnowledgeGraphManager;
  readonly teamStore: TeamStore;
  /** Coordination identity after an explicit team join. */
  currentAgentId: string | undefined;
  /** Session opened through this connection (preferred for attribution). */
  connectionSessionId: string | undefined;
  autopilotRetrievalBoundary: AutopilotRetrievalBoundary | null;

  // ── Fixed for the lifetime of the server ──
  readonly teamFeaturesEnabled: boolean;
  readonly projectBinding: ProjectBindingController;
  readonly bindingTransport: ProjectBindingTransport | undefined;
  readonly bindingHandle: ProjectBindingHandle | undefined;
  readonly dashboardMode: 'standalone' | 'control-plane';
  readonly configuredDashboardPort: number;

  // ── Helpers bound to the current state ──
  requireResolvedProject(action: string): ToolNotice | null;
  getObservationReader(scope?: 'project' | 'global'): ObservationReader;
  resolveConnectionSessionId(): Promise<string | undefined>;
  getActiveAutopilotRetrievalBoundary(): AutopilotRetrievalBoundary | null;
  requireExplicitAutopilotExpansion(toolName: string, purpose?: string): ToolNotice | null;
  blockCoveredAutopilotEvidence(toolName: string, observationIds: number[], force?: boolean): ToolNotice | null;
  blockReadOnlyAutopilotWrite(overrideReadOnly?: boolean): ToolNotice | null;
  switchProject(newCwd: string, source?: ProjectBindingSource): Promise<boolean>;
}
