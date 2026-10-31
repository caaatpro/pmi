import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCliVersion } from '../../src/cli/version.js';

import setupCommand, {
  buildSetupPlan,
  getSetupIntegrationRows,
  installAntigravityPluginPackage,
  installMcpConfig,
  installGeminiExtensionPackage,
  installHermesPluginPackage,
  installAgentSetup,
  installCodeBuddyPluginPackage,
  migrateLegacyCodexIntegration,
  parseCodexPluginState,
  installOmpPackage,
  installOpenClawBundlePackage,
  installPiPackage,
  installPluginPackage,
  removeLegacyCodexBatonMcpConfig,
  getSetupAgentTargets,
  rewriteBundledBatonMcpToHttp,
} from '../../src/cli/commands/setup.js';

function makeTmpDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'baton-setup-test-'));
}

const OFFICIAL_SKILL_NAMES = [
  'baton-memory',
  'baton-reasoning',
  'baton-sessions',
  'baton-git-memory',
  'baton-troubleshooting',
];

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function expectOfficialSkills(skillsRoot: string): Promise<void> {
  for (const name of OFFICIAL_SKILL_NAMES) {
    const skillPath = path.join(skillsRoot, name, 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf-8');
    expect(content).toContain(`name: ${name}`);
    expect(content).toContain('CLI fallback');
  }
}

describe('setup command planning', () => {
  it('does not modify the project during setup dry-run', async () => {
    const tmpDir = makeTmpDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      await setupCommand.run?.({
        args: { agent: 'claude', mcp: 'stdio', dryRun: true },
        rawArgs: ['--agent', 'claude', '--dry-run'],
        cmd: setupCommand,
      } as any);

      expect(fsSync.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await cleanup(tmpDir);
    }
  });

  it('does not modify user-level Codex files during global setup dry-run', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = path.join(tmpDir, 'home');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      await setupCommand.run?.({
        args: { agent: 'codex', mcp: 'stdio', global: true, dryRun: true },
        rawArgs: ['--agent', 'codex', '--global', '--dry-run'],
        cmd: setupCommand,
      } as any);

      expect(fsSync.existsSync(path.join(homeDir, 'plugins', 'baton'))).toBe(false);
      expect(fsSync.existsSync(path.join(homeDir, '.agents', 'plugins', 'marketplace.json'))).toBe(false);
      expect(fsSync.existsSync(path.join(homeDir, '.codex', 'config.toml'))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      await cleanup(tmpDir);
    }
  });

  it('keeps Codex project setup plugin-only and leaves .codex untouched', () => {
    const plan = buildSetupPlan({ agent: 'codex', mcp: 'stdio' });
    expect(plan.mcp).toBe('stdio');
    expect(plan.actions).not.toContain('plugin-package');
    expect(plan.actions).not.toContain('project-guidance');
    expect(plan.actions).not.toContain('hooks');
    expect(plan.actions).not.toContain('http-control-plane');
  });

  it('does not create project-local Codex config during non-global setup', async () => {
    const tmpDir = makeTmpDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      await installAgentSetup('codex', buildSetupPlan({ agent: 'codex', mcp: 'stdio' }), false);

      await expect(fs.access(path.join(tmpDir, '.codex', 'config.toml'))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, 'AGENTS.md'))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await cleanup(tmpDir);
    }
  });

  it('uses the user-level plugin package only when --global is requested', () => {
    for (const agent of ['claude', 'codex', 'copilot'] as const) {
      expect(buildSetupPlan({ agent, mcp: 'stdio', global: true }).actions).toContain('plugin-package');
      expect(buildSetupPlan({ agent, mcp: 'stdio', global: false }).actions).not.toContain('plugin-package');
    }
  });

  it('treats HTTP as an explicit advanced transport', () => {
    const plan = buildSetupPlan({ agent: 'codex', mcp: 'http' });
    expect(plan.mcp).toBe('http');
    expect(plan.actions).toContain('http-control-plane');
  });

  it('keeps Claude guidance while honoring --noHooks', async () => {
    const tmpDir = makeTmpDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const plan = buildSetupPlan({
        agent: 'claude',
        mcp: 'none',
        hooks: false,
        plugin: false,
      });

      await installAgentSetup('claude', plan, false);

      await expect(fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8'))
        .resolves.toContain('Baton');
      await expect(fs.access(path.join(tmpDir, '.claude', 'settings.local.json')))
        .rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await cleanup(tmpDir);
    }
  });

  it('lists plugin-capable setup targets', () => {
    expect(getSetupAgentTargets()).toContain('claude');
    expect(getSetupAgentTargets()).toContain('codex');
    expect(getSetupAgentTargets()).toContain('codebuddy');
    expect(getSetupAgentTargets()).toContain('copilot');
    expect(getSetupAgentTargets()).toContain('cursor');
    expect(getSetupAgentTargets()).toContain('gemini-cli');
    expect(getSetupAgentTargets()).toContain('openclaw');
    expect(getSetupAgentTargets()).toContain('hermes');
    expect(getSetupAgentTargets()).toContain('omp');
    expect(getSetupAgentTargets()).toContain('opencode');
    expect(getSetupAgentTargets()).toContain('pi');
  });

  it('uses official package or extension lanes where supported', () => {
    expect(buildSetupPlan({ agent: 'copilot', mcp: 'stdio', global: true }).actions).toContain('plugin-package');
    expect(buildSetupPlan({ agent: 'cursor', mcp: 'stdio' }).actions).not.toContain('plugin-package');
    expect(buildSetupPlan({ agent: 'gemini-cli', mcp: 'stdio' }).actions).toContain('extension-package');
    expect(buildSetupPlan({ agent: 'opencode', mcp: 'stdio' }).actions).toContain('opencode-local-plugin');
    expect(buildSetupPlan({ agent: 'pi', mcp: 'none' }).actions).toContain('pi-package');
    expect(buildSetupPlan({ agent: 'windsurf', mcp: 'stdio' }).actions).not.toContain('plugin-package');
    expect(buildSetupPlan({ agent: 'codebuddy', mcp: 'stdio', global: true }).actions).toContain('codebuddy-plugin');
    expect(buildSetupPlan({ agent: 'codebuddy', mcp: 'stdio', global: false }).actions).not.toContain('codebuddy-plugin');
  });

  it('keeps Grok MCP host-owned while installing its hooks and guidance', () => {
    const plan = buildSetupPlan({ agent: 'grok', mcp: 'stdio', global: true });
    expect(plan.mcp).toBe('none');
    expect(plan.actions).not.toContain('mcp-stdio');
    expect(plan.actions).not.toContain('http-control-plane');
    expect(plan.actions).toContain('project-guidance');
    expect(plan.actions).toContain('hooks');
  });

  it('honors explicit --mcp http for Grok', () => {
    const plan = buildSetupPlan({ agent: 'grok', mcp: 'http', global: true });
    expect(plan.mcp).toBe('http');
    expect(plan.actions).toContain('http-control-plane');
    expect(plan.actions).not.toContain('mcp-stdio');
    expect(plan.actions).toContain('project-guidance');
    expect(plan.actions).toContain('hooks');
  });

  it('uses native package lanes for Antigravity, OpenClaw, Hermes, and Oh-my-Pi', () => {
    expect(buildSetupPlan({ agent: 'antigravity', mcp: 'stdio' }).actions).toContain('antigravity-plugin');
    expect(buildSetupPlan({ agent: 'openclaw', mcp: 'stdio' }).actions).toContain('openclaw-bundle');
    expect(buildSetupPlan({ agent: 'hermes', mcp: 'stdio' }).actions).toContain('hermes-plugin');
    expect(buildSetupPlan({ agent: 'omp', mcp: 'stdio' }).actions).toContain('omp-package');

    for (const agent of ['antigravity', 'openclaw', 'hermes', 'omp'] as const) {
      const plan = buildSetupPlan({ agent, mcp: 'stdio' });
      expect(plan.actions).toContain('mcp-stdio');
      expect(plan.actions).not.toContain('project-guidance');
      expect(plan.actions).not.toContain('hooks');
    }
  });

  it('exposes a user-facing setup integration matrix', () => {
    const rows = getSetupIntegrationRows();
    expect(rows.find((row) => row.agent === 'copilot')).toMatchObject({
      entry: 'official-plugin',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'cursor')).toMatchObject({
      entry: 'official-config',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'codebuddy')).toMatchObject({
      entry: 'official-plugin',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'gemini-cli')).toMatchObject({
      entry: 'official-extension',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'antigravity')).toMatchObject({
      entry: 'official-plugin',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'pi')).toMatchObject({
      entry: 'official-package',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'openclaw')).toMatchObject({
      entry: 'official-bundle',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'hermes')).toMatchObject({
      entry: 'official-plugin',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'omp')).toMatchObject({
      entry: 'official-package',
      status: 'ready',
    });
    expect(rows.find((row) => row.agent === 'windsurf')).toMatchObject({
      entry: 'official-config',
      status: 'ready',
    });
  });
});

describe('plugin package installer', () => {
  it('installs the Codex plugin into a local marketplace', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installPluginPackage({
        agent: 'codex',
        homeDir: tmpDir,
      });

      const pluginManifest = path.join(tmpDir, 'plugins', 'baton', '.codex-plugin', 'plugin.json');
      const hooksConfig = path.join(tmpDir, 'plugins', 'baton', 'hooks', 'hooks.json');
      const marketplace = path.join(tmpDir, '.agents', 'plugins', 'marketplace.json');
      const skillsRoot = path.join(tmpDir, 'plugins', 'baton', 'skills');

      expect(result.pluginPath).toBe(path.join(tmpDir, 'plugins', 'baton'));
      expect(result.marketplacePath).toBe(marketplace);
      const manifest = JSON.parse(await fs.readFile(pluginManifest, 'utf-8'));
      const hooks = JSON.parse(await fs.readFile(hooksConfig, 'utf-8'));
      expect(manifest.name).toBe('baton');
      expect(manifest.version).toBe(getCliVersion());
      expect(manifest.hooks).toBe('./hooks/hooks.json');
      expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
        command: 'baton hook --agent codex',
        commandWindows: 'baton.cmd hook --agent codex',
      });
      expect(hooks.hooks).toHaveProperty('PreCompact');
      expect(hooks.hooks).toHaveProperty('Stop');
      await expectOfficialSkills(skillsRoot);
      expect(await fs.readFile(path.join(skillsRoot, 'baton-git-memory', 'SKILL.md'), 'utf-8')).toContain('Git Memory');

      const catalog = JSON.parse(await fs.readFile(marketplace, 'utf-8'));
      expect(catalog.name).toBe('personal');
      expect(catalog.plugins[0]).toMatchObject({
        name: 'baton',
        source: { source: 'local', path: './plugins/baton' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Claude plugin package as a local marketplace', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installPluginPackage({
        agent: 'claude',
        homeDir: tmpDir,
      });

      const marketplaceRoot = path.join(tmpDir, '.claude', 'plugins', 'marketplaces', 'baton-local');
      const marketplace = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
      const manifest = path.join(marketplaceRoot, 'plugins', 'baton', '.claude-plugin', 'plugin.json');
      const mcpConfig = path.join(marketplaceRoot, 'plugins', 'baton', '.mcp.json');
      const skillsRoot = path.join(marketplaceRoot, 'plugins', 'baton', 'skills');

      expect(result.pluginPath).toBe(path.join(marketplaceRoot, 'plugins', 'baton'));
      expect(result.marketplacePath).toBe(marketplace);
      expect(result.marketplaceRoot).toBe(marketplaceRoot);
      const pluginManifest = JSON.parse(await fs.readFile(manifest, 'utf-8'));
      expect(pluginManifest.name).toBe('baton');
      expect(pluginManifest.skills).toContain('./skills/baton-troubleshooting');
      expect(JSON.parse(await fs.readFile(mcpConfig, 'utf-8')).mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
        alwaysLoad: true,
      });
      await expectOfficialSkills(skillsRoot);

      const catalog = JSON.parse(await fs.readFile(marketplace, 'utf-8'));
      expect(catalog.name).toBe('baton-local');
      expect(catalog.plugins[0]).toMatchObject({
        name: 'baton',
        source: './plugins/baton',
        category: 'development',
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the CodeBuddy plugin package as a local marketplace without touching settings', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installCodeBuddyPluginPackage({ homeDir: tmpDir });
      const marketplaceRoot = path.join(tmpDir, '.codebuddy', 'baton-local');
      const manifestPath = path.join(marketplaceRoot, 'plugins', 'baton', '.codebuddy-plugin', 'plugin.json');
      const hooksPath = path.join(marketplaceRoot, 'plugins', 'baton', 'hooks', 'hooks.json');
      const mcpPath = path.join(marketplaceRoot, 'plugins', 'baton', '.mcp.json');

      expect(result.pluginPath).toBe(path.join(marketplaceRoot, 'plugins', 'baton'));
      expect(result.marketplacePath).toBe(path.join(marketplaceRoot, '.codebuddy-plugin', 'marketplace.json'));
      expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8'))).toMatchObject({
        name: 'baton', hooks: './hooks/hooks.json', mcpServers: './.mcp.json', skills: './skills',
      });
      expect(JSON.parse(await fs.readFile(mcpPath, 'utf-8')).mcpServers.baton).toMatchObject({
        type: 'stdio', command: 'baton', args: ['serve', '--mode', 'lite'],
      });
      expect(JSON.parse(await fs.readFile(hooksPath, 'utf-8')).hooks.SessionStart[0].hooks[0]).toMatchObject({
        command: 'baton hook --agent codebuddy', timeout: 10,
      });
      await expectOfficialSkills(path.join(result.pluginPath, 'skills'));
      await expect(fs.access(path.join(tmpDir, '.codebuddy', 'settings.json'))).rejects.toThrow();
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the GitHub Copilot CLI plugin package', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installPluginPackage({
        agent: 'copilot',
        homeDir: tmpDir,
      });

      const pluginPath = path.join(tmpDir, '.copilot', 'plugins', 'local', 'baton');
      const manifest = path.join(pluginPath, 'plugin.json');
      const mcpConfig = path.join(pluginPath, '.mcp.json');
      const hooksConfig = path.join(pluginPath, 'hooks', 'hooks.json');
      const skillsRoot = path.join(pluginPath, 'skills');

      expect(result.pluginPath).toBe(pluginPath);
      expect(JSON.parse(await fs.readFile(manifest, 'utf-8')).name).toBe('baton');
      await expectOfficialSkills(skillsRoot);
      expect(JSON.parse(await fs.readFile(mcpConfig, 'utf-8')).mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
      });
      expect(JSON.parse(await fs.readFile(hooksConfig, 'utf-8')).hooks.postToolUse[0]).toMatchObject({
        type: 'command',
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('can install plugin packages without hook capture files', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installPluginPackage({
        agent: 'copilot',
        homeDir: tmpDir,
        includeHooks: false,
      });

      const pluginPath = result.pluginPath;
      const manifest = JSON.parse(await fs.readFile(path.join(pluginPath, 'plugin.json'), 'utf-8'));

      expect(manifest.hooks).toBeUndefined();
      await expect(fs.access(path.join(pluginPath, 'hooks', 'hooks.json'))).rejects.toThrow();
      await expectOfficialSkills(path.join(pluginPath, 'skills'));
      expect(JSON.parse(await fs.readFile(path.join(pluginPath, '.mcp.json'), 'utf-8')).mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('rewrites bundled plugin MCP from stdio to HTTP', async () => {
    const tmpDir = makeTmpDir();
    try {
      const mcpPath = path.join(tmpDir, '.mcp.json');
      const extensionPath = path.join(tmpDir, 'gemini-extension.json');
      await fs.writeFile(mcpPath, JSON.stringify({
        mcpServers: {
          baton: { command: 'baton', args: ['serve', '--mode', 'lite'], alwaysLoad: true },
          other: { command: 'keep-me', args: [] },
        },
      }, null, 2), 'utf-8');
      await fs.writeFile(extensionPath, JSON.stringify({
        name: 'baton',
        mcpServers: {
          baton: { type: 'stdio', command: 'baton', args: ['serve', '--mode', 'lite'] },
        },
        contextFileName: 'GEMINI.md',
      }, null, 2), 'utf-8');

      const rewritten = await rewriteBundledBatonMcpToHttp(tmpDir);
      const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf-8'));
      const extension = JSON.parse(await fs.readFile(extensionPath, 'utf-8'));

      expect(rewritten).toEqual(expect.arrayContaining([mcpPath, extensionPath]));
      expect(mcp.mcpServers.baton).toEqual({
        url: 'http://localhost:3211/mcp',
        alwaysLoad: true,
      });
      expect(mcp.mcpServers.other).toEqual({ command: 'keep-me', args: [] });
      expect(extension).toMatchObject({
        name: 'baton',
        contextFileName: 'GEMINI.md',
        mcpServers: {
          baton: { type: 'http', url: 'http://localhost:3211/mcp' },
        },
      });
      expect(extension.mcpServers.baton.command).toBeUndefined();
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('rewrites installed Claude plugin MCP to HTTP when setup uses --mcp http', async () => {
    const tmpDir = makeTmpDir();
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalCwd = process.cwd();
    try {
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      process.chdir(tmpDir);
      const plan = buildSetupPlan({ agent: 'claude', mcp: 'http', global: true });
      await installAgentSetup('claude', plan, true);

      const mcpPath = path.join(
        tmpDir,
        '.claude',
        'plugins',
        'marketplaces',
        'baton-local',
        'plugins',
        'baton',
        '.mcp.json',
      );
      const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf-8'));
      expect(mcp.mcpServers.baton).toEqual({
        url: 'http://localhost:3211/mcp',
        alwaysLoad: true,
      });
      // A real Claude CLI may create its own user config while registering the
      // local marketplace. Baton must not add a second standalone MCP entry.
      const claudeConfig = await fs.readFile(path.join(tmpDir, '.claude.json'), 'utf8').catch(() => null);
      if (claudeConfig) {
        expect(JSON.parse(claudeConfig)).not.toHaveProperty('mcpServers.baton');
      }
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      await cleanup(tmpDir);
    }
  });

});

describe('Codex legacy integration migration', () => {
  it('requires the exact Personal marketplace plugin to be enabled before migration', () => {
    expect(parseCodexPluginState(JSON.stringify({
      installed: [{ pluginId: 'baton@personal', installed: true, enabled: true }],
    }))).toBe('ready');
    expect(parseCodexPluginState(JSON.stringify({
      installed: [{ pluginId: 'baton@personal', installed: true, enabled: false }],
    }))).toBe('disabled');
    expect(parseCodexPluginState(JSON.stringify({
      installed: [{ pluginId: 'baton@other', installed: true, enabled: true }],
    }))).toBe('missing');
    expect(parseCodexPluginState(`warning from Codex\n${JSON.stringify({
      installed: [{ pluginId: 'baton@personal', installed: true, enabled: true }],
    })}`)).toBe('ready');
    expect(parseCodexPluginState('not json')).toBe('unknown');
  });

  it('removes only Baton-owned legacy MCP, hooks, and plugin files', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = path.join(tmpDir, 'home');
    const projectRoot = path.join(tmpDir, 'project');
    try {
      const configPath = path.join(homeDir, '.codex', 'config.toml');
      const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
      const legacyPluginPath = path.join(homeDir, '.codex', 'plugins', 'baton');
      const canonicalPluginPath = path.join(homeDir, 'plugins', 'baton');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(hooksPath), { recursive: true });
      await fs.mkdir(path.join(legacyPluginPath, '.codex-plugin'), { recursive: true });
      await fs.mkdir(canonicalPluginPath, { recursive: true });
      await fs.writeFile(configPath, [
        '[mcp_servers.other]',
        'command = "other"',
        'args = []',
        '',
        '[mcp_servers.baton]',
        'command = "node"',
        'args = ["e:/projects/baton/dist/cli/index.js", "serve"]',
        '',
      ].join('\n'), 'utf-8');
      await fs.writeFile(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [{ type: 'command', command: 'baton hook' }],
          Stop: [{ type: 'command', command: 'baton hook' }],
        },
      }), 'utf-8');
      await fs.writeFile(path.join(legacyPluginPath, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name: 'baton',
        repository: 'https://github.com/caaatpro/pmi',
      }), 'utf-8');

      const result = await migrateLegacyCodexIntegration({ homeDir, projectRoot });
      const config = await fs.readFile(configPath, 'utf-8');

      expect(result).toEqual({ mcp: 'removed', projectHooks: 'removed', pluginFolder: 'removed' });
      expect(config).toContain('[mcp_servers.other]');
      expect(config).not.toContain('[mcp_servers.baton]');
      await expect(fs.access(hooksPath)).rejects.toThrow();
      await expect(fs.access(legacyPluginPath)).rejects.toThrow();
      await expect(fs.access(canonicalPluginPath)).resolves.toBeUndefined();
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('preserves Codex entries that contain user customization or foreign hooks', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = path.join(tmpDir, 'home');
    const projectRoot = path.join(tmpDir, 'project');
    try {
      const configPath = path.join(homeDir, '.codex', 'config.toml');
      const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(hooksPath), { recursive: true });
      await fs.writeFile(configPath, [
        '[mcp_servers.baton]',
        'command = "baton"',
        'args = ["serve"]',
        '',
        '[mcp_servers.baton.env]',
        'BATON_MODE = "team"',
        '',
      ].join('\n'), 'utf-8');
      await fs.writeFile(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [{ type: 'command', command: 'baton hook' }],
          Stop: [{ type: 'command', command: 'other-agent hook' }],
        },
      }), 'utf-8');

      const result = await migrateLegacyCodexIntegration({ homeDir, projectRoot });

      expect(result.mcp).toBe('preserved');
      expect(result.projectHooks).toBe('preserved');
      await expect(fs.readFile(configPath, 'utf-8')).resolves.toContain('BATON_MODE');
      await expect(fs.readFile(hooksPath, 'utf-8')).resolves.toContain('other-agent hook');
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('preserves an all-Baton legacy hooks file when the user added hook options', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = path.join(tmpDir, 'home');
    const projectRoot = path.join(tmpDir, 'project');
    try {
      const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
      await fs.mkdir(path.dirname(hooksPath), { recursive: true });
      await fs.writeFile(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [{ type: 'command', command: 'baton hook', timeout: 10 }],
        },
      }), 'utf-8');

      const result = await migrateLegacyCodexIntegration({ homeDir, projectRoot });

      expect(result.projectHooks).toBe('preserved');
      await expect(fs.readFile(hooksPath, 'utf-8')).resolves.toContain('"timeout":10');
    } finally {
      await cleanup(tmpDir);
    }
  });
});

describe('extension package installer', () => {
  it('installs the Antigravity plugin package into the official plugin folder', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installAntigravityPluginPackage({
        homeDir: tmpDir,
        global: true,
      });
      const pluginPath = path.join(tmpDir, '.gemini', 'config', 'plugins', 'baton');
      const hooks = JSON.parse(await fs.readFile(path.join(pluginPath, 'hooks.json'), 'utf-8'));

      expect(result.pluginPath).toBe(pluginPath);
      expect(JSON.parse(await fs.readFile(path.join(pluginPath, 'plugin.json'), 'utf-8'))).toMatchObject({
        name: 'baton',
      });
      expect(JSON.parse(await fs.readFile(path.join(pluginPath, 'mcp_config.json'), 'utf-8')).mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
      });
      expect(hooks.baton.PreInvocation[0].command).toContain('--event PreInvocation');
      expect(hooks.baton.PreToolUse[0].hooks[0].command).toContain('--event PreToolUse');
      const rules = await fs.readFile(path.join(pluginPath, 'rules', 'baton.md'), 'utf-8');
      expect(rules).toContain('baton_search');
      expect(rules).toContain('baton_evidence');
      expect(rules).toContain('baton_feedback');
      await expectOfficialSkills(path.join(pluginPath, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Antigravity plugin package into the workspace plugin folder', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installAntigravityPluginPackage({
        projectRoot: tmpDir,
        global: false,
        includeHooks: false,
      });
      const pluginPath = path.join(tmpDir, '.agents', 'plugins', 'baton');

      expect(result.pluginPath).toBe(pluginPath);
      await expect(fs.access(path.join(pluginPath, 'hooks.json'))).rejects.toThrow();
      await expectOfficialSkills(path.join(pluginPath, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Gemini CLI extension package into the official extension folder', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installGeminiExtensionPackage({
        homeDir: tmpDir,
      });

      const extensionPath = path.join(tmpDir, '.gemini', 'extensions', 'baton');
      const manifest = path.join(extensionPath, 'gemini-extension.json');
      const contextFile = path.join(extensionPath, 'GEMINI.md');

      expect(result.extensionPath).toBe(extensionPath);
      expect(JSON.parse(await fs.readFile(manifest, 'utf-8'))).toMatchObject({
        name: 'baton',
        contextFileName: 'GEMINI.md',
      });
      expect(await fs.readFile(contextFile, 'utf-8')).toContain('Baton');
      expect(await fs.readFile(contextFile, 'utf-8')).toContain('baton_evidence');
      expect(await fs.readFile(contextFile, 'utf-8')).toContain('baton_feedback');
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Pi coding-agent package template', async () => {
    const tmpDir = makeTmpDir();
    try {
      const packageDir = path.join(tmpDir, 'baton-pi-package');
      const result = await installPiPackage({ packageDir });

      const manifest = path.join(packageDir, 'package.json');
      const extension = path.join(packageDir, 'extensions', 'baton.js');
      const skill = path.join(packageDir, 'skills', 'baton-memory', 'SKILL.md');
      const skillsRoot = path.join(packageDir, 'skills');

      expect(result.packagePath).toBe(packageDir);
      expect(JSON.parse(await fs.readFile(manifest, 'utf-8'))).toMatchObject({
        name: 'baton-pi-package',
        pi: {
          extensions: ['./extensions'],
          skills: ['./skills'],
        },
      });
      expect(await fs.readFile(extension, 'utf-8')).toContain("hook_event_name: 'pi.tool_result'");
      expect(await fs.readFile(skill, 'utf-8')).toContain('name: baton-memory');
      await expectOfficialSkills(skillsRoot);
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the OpenClaw-compatible bundle package', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installOpenClawBundlePackage({ homeDir: tmpDir });
      const bundlePath = path.join(tmpDir, '.openclaw', 'extensions', 'baton');
      const manifest = JSON.parse(await fs.readFile(path.join(bundlePath, '.codex-plugin', 'plugin.json'), 'utf-8'));
      const hookMetadata = await fs.readFile(path.join(bundlePath, 'hooks', 'baton', 'HOOK.md'), 'utf-8');
      const hookHandler = await fs.readFile(path.join(bundlePath, 'hooks', 'baton', 'handler.ts'), 'utf-8');

      expect(result.bundlePath).toBe(bundlePath);
      expect(manifest.name).toBe('baton');
      expect(manifest.interface.capabilities).toContain('Hooks');
      expect(hookMetadata).toContain('name: baton');
      expect(hookMetadata).toContain('agent:bootstrap');
      expect(hookHandler).toContain("baton hook --agent openclaw");
      await expectOfficialSkills(path.join(bundlePath, 'skills'));
      expect(JSON.parse(await fs.readFile(path.join(bundlePath, '.mcp.json'), 'utf-8')).mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('can install the OpenClaw-compatible bundle without hook capture files', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installOpenClawBundlePackage({ homeDir: tmpDir, includeHooks: false });
      const manifest = JSON.parse(await fs.readFile(path.join(result.bundlePath, '.codex-plugin', 'plugin.json'), 'utf-8'));

      expect(manifest.interface.capabilities).not.toContain('Hooks');
      await expect(fs.access(path.join(result.bundlePath, 'hooks'))).rejects.toThrow();
      await expectOfficialSkills(path.join(result.bundlePath, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Hermes plugin package and enables it in config.yaml', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installHermesPluginPackage({ homeDir: tmpDir });
      const pluginPath = path.join(tmpDir, '.hermes', 'plugins', 'baton');
      const manifest = await fs.readFile(path.join(pluginPath, 'plugin.yaml'), 'utf-8');
      const pluginCode = await fs.readFile(path.join(pluginPath, '__init__.py'), 'utf-8');
      const config = await fs.readFile(path.join(tmpDir, '.hermes', 'config.yaml'), 'utf-8');

      expect(result.pluginPath).toBe(pluginPath);
      expect(manifest).toContain('name: baton');
      expect(manifest).toContain('provides_hooks:');
      expect(pluginCode).toContain('ctx.register_hook("pre_llm_call"');
      expect(pluginCode).toContain('ctx.register_command("baton"');
      expect(pluginCode).toContain('ctx.register_cli_command("baton"');
      expect(pluginCode).toContain('ctx.register_skill(child.name, str(skill_path))');
      expect(pluginCode).not.toContain('skill_path.read_text');
      expect(manifest).toContain('  - baton-troubleshooting');
      expect(config).toContain('enabled:');
      expect(config).toContain('- baton');
      await expectOfficialSkills(path.join(pluginPath, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('installs the Oh-my-Pi extension package template with omp manifest fields', async () => {
    const tmpDir = makeTmpDir();
    try {
      const packageDir = path.join(tmpDir, 'baton-omp-package');
      const result = await installOmpPackage({ packageDir });
      const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8'));
      const extension = await fs.readFile(path.join(packageDir, 'extensions', 'baton.js'), 'utf-8');

      expect(result.packagePath).toBe(packageDir);
      expect(manifest).toMatchObject({
        name: 'baton-omp-package',
        omp: {
          extensions: ['./extensions/baton.js'],
        },
      });
      expect(extension).toContain("hook_event_name: 'omp.tool_result'");
      expect(extension).toContain("pi.registerCommand('baton'");
      await expectOfficialSkills(path.join(packageDir, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('uses the Pi user package directory for global setup', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installPiPackage({ homeDir: tmpDir, global: true });
      const packageDir = path.join(tmpDir, '.pi', 'agent', 'packages', 'baton');

      expect(result.packagePath).toBe(packageDir);
      expect(result.installHint).toContain('pi install');
      expect(result.installHint).not.toContain(' -l ');
      expect(JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8')).name).toBe('baton-pi-package');
      await expectOfficialSkills(path.join(packageDir, 'skills'));
    } finally {
      await cleanup(tmpDir);
    }
  });
});

describe('setup MCP config installer', () => {
  it('writes Claude stdio MCP config with official eager tool loading', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installMcpConfig({ agent: 'claude', projectRoot: tmpDir, mcp: 'stdio' });
      const config = JSON.parse(await fs.readFile(result.configPath, 'utf-8'));

      // Claude Code reads project MCP servers from .mcp.json, not .claude/settings.json.
      expect(result.configPath).toBe(path.join(tmpDir, '.mcp.json'));
      expect(config.mcpServers.baton).toMatchObject({
        command: 'baton',
        args: ['serve', '--mode', 'lite'],
        alwaysLoad: true,
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('moves a Claude entry left in .claude/settings.json by older setups, keeping everything else', async () => {
    const tmpDir = makeTmpDir();
    try {
      const legacyPath = path.join(tmpDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        mcpServers: { baton: { command: 'node', args: ['old/dist/cli/index.js', 'serve'] }, other: { command: 'other' } },
      }), 'utf-8');

      await installMcpConfig({ agent: 'claude', projectRoot: tmpDir, mcp: 'stdio' });
      const legacy = JSON.parse(await fs.readFile(legacyPath, 'utf-8'));
      expect(legacy).toEqual({ permissions: { allow: ['Bash(npm test)'] }, mcpServers: { other: { command: 'other' } } });
      const config = JSON.parse(await fs.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(config.mcpServers.baton.command).toBe('baton');

      // Our entry alone: the now empty mcpServers key goes as well.
      await fs.writeFile(legacyPath, JSON.stringify({ mcpServers: { baton: { command: 'baton' } } }), 'utf-8');
      await installMcpConfig({ agent: 'claude', projectRoot: tmpDir, mcp: 'stdio' });
      expect(JSON.parse(await fs.readFile(legacyPath, 'utf-8'))).toEqual({});
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('writes Cursor stdio MCP config without removing existing servers', async () => {
    const tmpDir = makeTmpDir();
    try {
      const configPath = path.join(tmpDir, '.cursor', 'mcp.json');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ mcpServers: { context7: { command: 'context7', args: [] } } }, null, 2),
        'utf-8',
      );

      const result = await installMcpConfig({ agent: 'cursor', projectRoot: tmpDir, mcp: 'stdio' });
      const config = JSON.parse(await fs.readFile(result.configPath, 'utf-8'));

      expect(result.configPath).toBe(configPath);
      expect(config.mcpServers.context7.command).toBe('context7');
      expect(config.mcpServers.baton).toMatchObject({ command: 'baton', args: ['serve', '--mode', 'lite'] });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('writes OpenCode local MCP config in opencode.json', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await installMcpConfig({ agent: 'opencode', projectRoot: tmpDir, mcp: 'stdio' });
      const config = JSON.parse(await fs.readFile(result.configPath, 'utf-8'));

      expect(result.configPath).toBe(path.join(tmpDir, 'opencode.json'));
      expect(config.mcp.baton).toMatchObject({
        type: 'local',
        command: ['baton', 'serve', '--mode', 'lite'],
      });
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('replaces only the Codex baton TOML block', async () => {
    const tmpDir = makeTmpDir();
    try {
      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        [
          '[mcp_servers.other]',
          'command = "other"',
          'args = []',
          '',
          '[mcp_servers.baton]',
          'command = "old"',
          'args = ["old"]',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = await installMcpConfig({ agent: 'codex', projectRoot: tmpDir, mcp: 'stdio' });
      const content = await fs.readFile(result.configPath, 'utf-8');

      expect(result.configPath).toBe(configPath);
      expect(content).toContain('[mcp_servers.other]');
      expect(content).toContain('command = "other"');
      expect(content).toContain('[mcp_servers.baton]');
      expect(content).toContain('command = "baton"');
      expect(content).toContain('args = ["serve", "--mode", "lite"]');
      expect(content).not.toContain('command = "old"');
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('writes Grok HTTP MCP into config.toml', async () => {
    const tmpDir = makeTmpDir();
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalGrokHome = process.env.GROK_HOME;
    try {
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      delete process.env.GROK_HOME;

      const result = await installMcpConfig({ agent: 'grok', mcp: 'http', global: true });
      const content = await fs.readFile(result.configPath, 'utf-8');

      expect(result.configPath).toBe(path.join(tmpDir, '.grok', 'config.toml'));
      expect(content).toContain('[mcp_servers.baton]');
      expect(content).toContain('url = "http://localhost:3211/mcp"');
      expect(content).not.toContain('command = "baton"');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = originalGrokHome;
      await cleanup(tmpDir);
    }
  });

  it('honors GROK_HOME when writing Grok HTTP MCP', async () => {
    const tmpDir = makeTmpDir();
    const grokHome = path.join(tmpDir, 'custom-grok');
    const originalGrokHome = process.env.GROK_HOME;
    try {
      process.env.GROK_HOME = grokHome;
      const result = await installMcpConfig({ agent: 'grok', mcp: 'http', global: true });
      expect(result.configPath).toBe(path.join(grokHome, 'config.toml'));
      expect(await fs.readFile(result.configPath, 'utf-8')).toContain('url = "http://localhost:3211/mcp"');
    } finally {
      if (originalGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = originalGrokHome;
      await cleanup(tmpDir);
    }
  });

  it('writes Grok HTTP MCP to user config even without --global', async () => {
    const tmpDir = makeTmpDir();
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalGrokHome = process.env.GROK_HOME;
    try {
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      delete process.env.GROK_HOME;
      const projectRoot = path.join(tmpDir, 'repo');
      await fs.mkdir(projectRoot, { recursive: true });

      const result = await installMcpConfig({
        agent: 'grok',
        mcp: 'http',
        global: false,
        projectRoot,
      });

      expect(result.configPath).toBe(path.join(tmpDir, '.grok', 'config.toml'));
      await expect(fs.access(path.join(projectRoot, '.grok', 'config.toml'))).rejects.toThrow();
      expect(await fs.readFile(result.configPath, 'utf-8')).toContain('url = "http://localhost:3211/mcp"');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = originalGrokHome;
      await cleanup(tmpDir);
    }
  });

  it('migrates only the legacy Codex source-path MCP server after plugin setup', async () => {
    const tmpDir = makeTmpDir();
    try {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        [
          '[mcp_servers.other]',
          'command = "other"',
          'args = []',
          '',
          '[mcp_servers.baton]',
          'command = "node"',
          'args = ["E:/work/baton/dist/cli/index.js", "serve"]',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = await removeLegacyCodexBatonMcpConfig(configPath);
      const content = await fs.readFile(configPath, 'utf-8');

      expect(result).toMatchObject({ configPath, removed: true });
      expect(content).toContain('[mcp_servers.other]');
      expect(content).not.toContain('[mcp_servers.baton]');
    } finally {
      await cleanup(tmpDir);
    }
  });

  it('does not remove a user-managed Codex baton MCP server', async () => {
    const tmpDir = makeTmpDir();
    try {
      const configPath = path.join(tmpDir, 'config.toml');
      const customConfig = [
        '[mcp_servers.baton]',
        'command = "node"',
        'args = ["C:/tools/custom-baton-server.js", "serve"]',
        '',
        '[mcp_servers.baton.env]',
        'BATON_MODE = "team"',
        '',
      ].join('\n');
      await fs.writeFile(configPath, customConfig, 'utf-8');

      const result = await removeLegacyCodexBatonMcpConfig(configPath);

      expect(result).toMatchObject({ configPath, removed: false });
      expect(await fs.readFile(configPath, 'utf-8')).toBe(customConfig);
    } finally {
      await cleanup(tmpDir);
    }
  });
});
