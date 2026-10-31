/**
 * Tool Profile System — Progressive Disclosure for MCP tools
 *
 * The full tool set contains 43 tools, but most users only ever
 * use a small subset (store / search / detail). Exposing all of them at
 * tools/list time causes cognitive overload.
 *
 * We provide four profiles:
 *   - "micro" (stdio default): Agent-ready project context + bounded recovery controls — 8 tools.
 *     Suitable for normal MCP clients where every tool schema costs context tokens.
 *   - "lite": Core memory CRUD, sessions, reasoning, continuity, retention, backup, Baton context, git, sessions and workspace recovery — 34 tools.
 *     Suitable for solo users who want the full memory surface without team tools.
 *   - "team" (HTTP default): lite + agent identity (team_manage) and Knowledge Workspace — 36 tools.
 *     Suitable when agents join with an explicit identity for personal/team memory.
 *   - "full": Everything, including niche / advanced tools (consolidate, dedup,
 *     formation metrics, rules/workspace sync).
 *     Opt in via `BATON_MODE=full` or `--mode full`.
 *
 * Users can override at any time via the `BATON_MODE` env var, the `--mode`
 * CLI flag, or programmatically via `createBatonServer({ toolProfile: ... })`.
 */

export type ToolProfile = 'micro' | 'lite' | 'team' | 'full';

/**
 * Canonical tool name → which profile(s) include it.
 * Every `registerTool` call in server.ts MUST consult this map.
 */
export const TOOL_PROFILES: Record<string, ReadonlyArray<ToolProfile>> = Object.freeze({
  // ── micro: default agent-facing surface — keep tools/list tiny ────
  baton_store:              ['micro', 'lite', 'team', 'full'],
  baton_search:             ['micro', 'lite', 'team', 'full'],
  baton_detail:             ['micro', 'lite', 'team', 'full'],
  baton_project_context:    ['micro', 'lite', 'team', 'full'],
  baton_context_pack:       ['micro', 'lite', 'team', 'full'],
  baton_codegraph_status:   ['micro', 'lite', 'team', 'full'],
  baton_resolve:            ['micro', 'lite', 'team', 'full'],
  // A fail-closed stdio server needs an explicit recovery path when a client
  // did not launch it from the workspace.
  baton_session_start:      ['micro', 'lite', 'team', 'full'],
  // Evidence and feedback are deliberate operator/context-control surfaces;
  // keep the default micro profile at its eight-tool token budget.
  baton_evidence:           ['lite', 'team', 'full'],
  baton_feedback:           ['lite', 'team', 'full'],
  baton_continuity:         ['lite', 'team', 'full'],

  // ── lite: extended solo memory surface ────────────────────────────
  baton_graph_context:      ['lite', 'team', 'full'],
  baton_timeline:           ['lite', 'team', 'full'],
  baton_suggest_topic_key:  ['lite', 'team', 'full'],
  baton_session_end:        ['lite', 'team', 'full'],
  baton_session_context:    ['lite', 'team', 'full'],
  baton_store_reasoning:    ['lite', 'team', 'full'],
  baton_search_reasoning:   ['lite', 'team', 'full'],
  baton_transfer:           ['lite', 'team', 'full'],
  baton_retention:          ['lite', 'team', 'full'],
  // Baton context and memory (src/mcp/tools/context.ts)
  context_build:              ['lite', 'team', 'full'],
  project_overview:           ['lite', 'team', 'full'],
  memory_search:              ['lite', 'team', 'full'],
  memory_get:                 ['lite', 'team', 'full'],
  memory_save:                ['lite', 'team', 'full'],
  decision_log:               ['lite', 'team', 'full'],
  git_analyze:                ['lite', 'team', 'full'],
  // Baton session continuity (src/mcp/tools/session.ts)
  session_checkpoint:         ['lite', 'team', 'full'],
  session_handoff:            ['lite', 'team', 'full'],
  session_list:               ['lite', 'team', 'full'],
  session_resume:             ['lite', 'team', 'full'],
  session_finish:             ['lite', 'team', 'full'],
  // Baton workspace recovery (src/mcp/tools/workspace.ts)
  workspace_snapshot:         ['lite', 'team', 'full'],
  workspace_restore:          ['lite', 'team', 'full'],

  // ── team: orchestration coordination surfaces — HTTP default ──────
  baton_knowledge:          ['team', 'full'],
  team_manage:                ['team', 'full'],

  // ── full: advanced / specialized — opt-in only ───────────────────
  baton_audit_project:      ['full'],
  baton_deduplicate:        ['full'],
  baton_consolidate:        ['full'],
  baton_formation_metrics:  ['full'],
  baton_rules_sync:         ['full'],
  baton_workspace_sync:     ['full'],
  baton_compaction_checkpoint: ['full'],
});

/**
 * Check whether a tool should be registered under the given profile.
 *
 * Unknown tool names default to `full` (so accidentally-unlisted tools
 * remain available via full mode but are hidden by default).
 */
export function isToolInProfile(toolName: string, profile: ToolProfile): boolean {
  const profiles = TOOL_PROFILES[toolName];
  if (!profiles) {
    // Unknown tool: conservative default — only show under 'full'
    return profile === 'full';
  }
  return profiles.includes(profile);
}

export interface ResolveToolProfileOpts {
  /** Explicit profile from caller (highest priority). */
  explicit?: ToolProfile | string | null;
  /** Raw env var value, e.g. from process.env.BATON_MODE. */
  envValue?: string | null;
  /** Default when nothing is set — typically 'lite' for stdio, 'team' for HTTP. */
  fallback: ToolProfile;
}

/**
 * Resolve the effective tool profile.
 *
 * Priority: explicit option > BATON_MODE env > fallback.
 * Invalid values fall through to the next level so users never silently
 * lose tools due to a typo.
 */
export function resolveToolProfile(opts: ResolveToolProfileOpts): ToolProfile {
  const normalize = (v: string | null | undefined): ToolProfile | null => {
    if (!v) return null;
    const s = String(v).trim().toLowerCase();
    if (s === 'micro' || s === 'lite' || s === 'team' || s === 'full') return s;
    return null;
  };

  return (
    normalize(opts.explicit as string | null | undefined) ??
    normalize(opts.envValue) ??
    opts.fallback
  );
}

/**
 * Human-readable description for logs / diagnostics.
 */
export function describeProfile(profile: ToolProfile): string {
  const count = countToolsInProfile(profile);
  switch (profile) {
    case 'micro': return `micro (agent-ready context + bounded recovery, ${count} tools)`;
    case 'lite': return `lite (core memory + sessions, ${count} tools)`;
    case 'team': return `team (lite + agent identity + knowledge workspace, ${count} tools)`;
    case 'full': return `full (all tools including advanced, ${count} tools)`;
  }
}

/**
 * Count tools registered under each profile — useful for docs and tests.
 */
export function countToolsInProfile(profile: ToolProfile): number {
  let n = 0;
  for (const name of Object.keys(TOOL_PROFILES)) {
    if (isToolInProfile(name, profile)) n++;
  }
  return n;
}
