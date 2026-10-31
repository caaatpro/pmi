import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_SAFE_TOOL_NAMES, shouldAwaitProjectRuntime } from '../../src/server.js';

describe('MCP bootstrap-safe tools', () => {
  it('allows only project-scoped read tools before full memory hydration', () => {
    expect([...BOOTSTRAP_SAFE_TOOL_NAMES].sort()).toEqual([
      'baton_codegraph_status',
      'baton_context_pack',
      'baton_graph_context',
      'baton_project_context',
      'baton_session_start',
    ]);
    expect(shouldAwaitProjectRuntime('baton_project_context')).toBe(false);
    expect(shouldAwaitProjectRuntime('baton_codegraph_status')).toBe(false);
    expect(shouldAwaitProjectRuntime('baton_graph_context')).toBe(false);
    expect(shouldAwaitProjectRuntime('baton_context_pack')).toBe(false);
    expect(shouldAwaitProjectRuntime('baton_session_start')).toBe(false);
  });

  it('keeps search and writes behind full runtime initialization', () => {
    for (const tool of ['baton_search', 'baton_store']) {
      expect(shouldAwaitProjectRuntime(tool)).toBe(true);
    }
  });
});
