import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildBatonServer, installPiPackage } from '../../src/cli/commands/setup.js';
import { installAgentGuidance } from '../../src/hooks/installers/index.js';
import { TOOL_PROFILES, isToolInProfile, countToolsInProfile, describeProfile } from '../../src/server/tool-profile.js';
import { OFFICIAL_BATON_SKILLS } from '../../src/hooks/official-skills.js';

/**
 * Profile-parity exam: the tools an agent is taught must exist in the profile
 * the installed MCP server actually exposes. A taught-but-missing tool is a
 * broken promise that degrades the memory-native experience. Deterministic,
 * offline.
 */

const MICRO_TOOLS = [
  'baton_store',
  'baton_search',
  'baton_detail',
  'baton_project_context',
  'baton_context_pack',
  'baton_codegraph_status',
  'baton_resolve',
  'baton_session_start',
];

describe('profile parity exam', () => {
  let sandbox = '';

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = '';
  });

  it('installed stdio server exposes lite, so taught tools are reachable', () => {
    const stdio = buildBatonServer('stdio');
    expect(stdio.args).toEqual(['serve', '--mode', 'lite']);
    expect(stdio.command).toBe('baton');
  });

  it('micro stays the documented 8-tool default surface', () => {
    expect(countToolsInProfile('micro')).toBe(8);
    for (const name of MICRO_TOOLS) {
      expect(isToolInProfile(name, 'micro'), name).toBe(true);
    }
  });

  it('keeps profile descriptions tied to the actual profile map', () => {
    expect(describeProfile('micro')).toContain('8 tools');
    expect(describeProfile('lite')).toContain('34 tools');
    expect(describeProfile('team')).toContain('36 tools');
    expect(describeProfile('full')).toContain('43 tools');
  });

  it('keeps packaged memory skills aware of the reachable lite surface', () => {
    for (const agent of ['claude', 'codebuddy', 'codex', 'copilot', 'cursor']) {
      const content = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../plugins/${agent}/baton/skills/baton-memory/SKILL.md`),
        'utf8',
      );
      expect(content, `${agent} memory skill`).toContain('baton_evidence');
      expect(content, `${agent} memory skill`).toContain('baton_feedback');
    }
  });

  it('Pi installs shared memory guidance for the reachable lite surface', async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'baton-profile-parity-'));
    const { packagePath } = await installPiPackage({ packageDir: path.join(sandbox, 'baton') });
    const content = readFileSync(path.join(packagePath, 'skills', 'baton-memory', 'SKILL.md'), 'utf-8');
    expect(content).toBe(OFFICIAL_BATON_SKILLS.find(skill => skill.name === 'baton-memory')?.content);
    for (const tool of ['baton_evidence', 'baton_feedback']) {
      expect(content).toContain(tool);
      expect(isToolInProfile(tool, 'lite'), `${tool} must be reachable`).toBe(true);
    }
  });

  it('every MCP tool taught in generated guidance is visible under lite', async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'baton-profile-parity-'));
    const rulesPath = await installAgentGuidance('codex', sandbox, false);
    const content = readFileSync(rulesPath, 'utf-8');
    const taught = [...content.matchAll(/baton_([a-z_]+)/g)].map((match) => `baton_${match[1]}`);
    const toolNames = taught.filter((name) => name in TOOL_PROFILES);
    expect(toolNames.length, 'guidance should teach MCP tools').toBeGreaterThan(0);
    for (const name of toolNames) {
      expect(isToolInProfile(name, 'lite'), `${name} must be in the lite profile`).toBe(true);
    }
  });
});
