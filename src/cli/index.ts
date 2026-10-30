/**
 * Memorix CLI
 *
 * Command-line interface for Memorix management.
 * Built with: citty (1.1K stars, zero-deps) + @clack/prompts (7.4K stars)
 *
 * Commands:
 *   memorix         — Usage summary (TTY) or MCP stdio server (piped)
 *   memorix serve   — Start MCP Server on stdio
 *   memorix status  — Show project info + rules sync status
 *   memorix sync    — Interactive cross-agent rule sync
 */

import { defineCommand, runMain } from 'citty';
import { getCliVersion } from './version.js';
import { installCliPipeErrorGuard } from './pipe-errors.js';
import { normalizeCliInvocation } from './invocation.js';
import { printCliGuideForHelp, renderCliGuide } from './command-guide.js';
import { shouldDefaultToMcp } from './default-mode.js';

installCliPipeErrorGuard();

const NO_GIT_MSG = 'Memorix requires a git repo to establish project identity. Run `git init` in this workspace first.';

// ============================================================
// Main command
// ============================================================

async function runMemoryShortcut(action: string, args: Record<string, unknown>): Promise<void> {
  const { detectProject } = await import('../project/detector.js');
  if (!detectProject(process.cwd())) {
    console.log(NO_GIT_MSG);
    process.exitCode = 1;
    return;
  }
  const memory = await import('./commands/memory.js');
  await memory.default.run?.({
    args: { ...args, _: [action] },
    rawArgs: [],
    cmd: memory.default,
  } as any);
}

const main = defineCommand({
  meta: {
    name: 'memorix',
    version: getCliVersion(),
    description: 'Local-first memory control plane for AI coding agents through CLI, MCP, and local workflows',
  },
  subCommands: {
    // One-shot product commands (primary user paths)
    search: () => Promise.resolve(defineCommand({
      meta: { name: 'search', description: 'Shortcut for `memorix memory search`' },
      args: {
        query: { type: 'string', description: 'Search query (also accepts the first positional argument)', required: false },
        limit: { type: 'string', description: 'Maximum results' },
        quality: { type: 'string', description: 'Retrieval profile: fast, balanced (default), or thorough' },
        json: { type: 'boolean', description: 'Emit machine-readable JSON output' },
      },
      async run({ args }) {
        await runMemoryShortcut('search', {
          query: args.query ?? (args._ as string[] | undefined)?.[0],
          limit: args.limit,
          quality: args.quality,
          json: args.json,
        });
      },
    })),
    remember: () => Promise.resolve(defineCommand({
      meta: { name: 'remember', description: 'Shortcut for `memorix memory store`' },
      args: {
        text: { type: 'positional', description: 'Text to remember', required: true },
        title: { type: 'string', description: 'Optional observation title' },
        type: { type: 'string', description: 'Observation type' },
        visibility: { type: 'string', description: 'project (default), personal, or team' },
        json: { type: 'boolean', description: 'Emit machine-readable JSON output' },
      },
      async run({ args }) {
        await runMemoryShortcut('store', {
          text: args.text,
          title: args.title,
          type: args.type,
          visibility: args.visibility,
          json: args.json,
        });
      },
    })),
    recent: () => Promise.resolve(defineCommand({
      meta: { name: 'recent', description: 'Shortcut for `memorix memory recent`' },
      args: {
        limit: { type: 'string', description: 'Maximum results' },
        json: { type: 'boolean', description: 'Emit machine-readable JSON output' },
      },
      async run({ args }) { await runMemoryShortcut('recent', { limit: args.limit, json: args.json }); },
    })),
    help: () => Promise.resolve(defineCommand({
      meta: { name: 'help', description: 'Show action-oriented help for a command group' },
      args: {
        command: { type: 'positional', description: 'Command group to inspect', required: false },
      },
      async run({ args }) {
        console.log(renderCliGuide(args.command as string | undefined));
      },
    })),
    // Infrastructure commands
    init: () => import('./commands/init.js').then(m => m.default),
    setup: () => import('./commands/setup.js').then(m => m.default),
    config: () => Promise.resolve(defineCommand({
      meta: { name: 'config', description: 'Inspect Memorix TOML configuration' },
      subCommands: {
        path: () => import('./commands/config-path.js').then(m => m.default),
        get: () => import('./commands/config-get.js').then(m => m.default),
        migrate: () => import('./commands/config-migrate.js').then(m => m.default),
      },
    })),
    integrate: () => import('./commands/integrate.js').then(m => m.default),
    memory: () => import('./commands/memory.js').then(m => m.default),
    context: () => import('./commands/context.js').then(m => m.default),
    resume: () => import('./commands/resume.js').then(m => m.default),
    explain: () => import('./commands/explain.js').then(m => m.default),
    codegraph: () => import('./commands/codegraph.js').then(m => m.default),
    checkpoint: () => import('./commands/checkpoint.js').then(m => m.default),
    knowledge: () => import('./commands/knowledge.js').then(m => m.default),
    evidence: () => import('./commands/evidence.js').then(m => m.default),
    feedback: () => import('./commands/feedback.js').then(m => m.default),
    continuity: () => import('./commands/continuity.js').then(m => m.default),
    reasoning: () => import('./commands/reasoning.js').then(m => m.default),
    retention: () => import('./commands/retention.js').then(m => m.default),
    formation: () => import('./commands/formation.js').then(m => m.default),
    audit: () => import('./commands/audit.js').then(m => m.default),
    transfer: () => import('./commands/transfer.js').then(m => m.default),
    skills: () => import('./commands/skills.js').then(m => m.default),
    identity: () => import('./commands/identity.js').then(m => m.default),
    session: () => import('./commands/session.js').then(m => m.default),
    team: () => import('./commands/team.js').then(m => m.default),
    task: () => import('./commands/task.js').then(m => m.default),
    message: () => import('./commands/message.js').then(m => m.default),
    lock: () => import('./commands/lock.js').then(m => m.default),
    handoff: () => import('./commands/handoff.js').then(m => m.default),
    poll: () => import('./commands/poll.js').then(m => m.default),
    receipt: () => import('./commands/receipt.js').then(m => m.default),
    serve: () => import('./commands/serve.js').then(m => m.default),
    'serve-http': () => import('./commands/serve-http.js').then(m => m.default),
    status: () => import('./commands/status.js').then(m => m.default),
    sync: () => import('./commands/sync.js').then(m => m.default),
    hook: () => import('./commands/hook.js').then(m => m.default),
    hooks: () => import('./commands/hooks.js').then(m => m.default),
    ingest: () => import('./commands/ingest.js').then(m => m.default),
    'git-hook': () => import('./commands/git-hook-install.js').then(m => m.default),
    'git-hook-uninstall': () => import('./commands/git-hook-uninstall.js').then(m => m.default),
    background: () => import('./commands/background.js').then(m => m.default),
    bg: () => import('./commands/background.js').then(m => m.default),
    bs: () => Promise.resolve(defineCommand({
      meta: { name: 'bs', description: 'Shortcut: background start' },
      args: { port: { type: 'string', description: 'HTTP port (default: 3211)', required: false } },
      async run({ args }) {
        // Directly invoke background start instead of going through citty's CommandContext
        const port = parseInt((args.port as string) || '3211', 10);
        const { doStart } = await import('./commands/background.js');
        await doStart(port);
      },
    })),
    doctor: () => import('./commands/doctor.js').then(m => m.default),
    repair: () => import('./commands/repair.js').then(m => m.default),
    dashboard: () => import('./commands/dashboard.js').then(m => m.default),
    cleanup: () => import('./commands/cleanup.js').then(m => m.default),
    purge: () => import('./commands/purge.js').then(m => m.default),
    uninstall: () => import('./commands/uninstall.js').then(m => m.default),
    orchestrate: () => import('./commands/orchestrate.js').then(m => m.default),
  },
  async run() {
    // Guard: if citty already resolved a subcommand, its run() was called before this.
    // Detect by checking if the first CLI arg matches a registered subcommand name.
    const firstArg = process.argv[2];
    const knownSubs = ['search', 'remember', 'recent', 'help', 'config',
      'init', 'setup', 'integrate', 'memory', 'context', 'resume', 'explain', 'codegraph', 'checkpoint', 'knowledge', 'reasoning', 'retention', 'formation', 'audit', 'transfer', 'skills', 'identity',
      'session', 'team', 'task', 'message', 'lock', 'handoff', 'poll', 'evidence', 'feedback', 'continuity',
      'receipt',
      'serve', 'serve-http', 'status', 'sync',
      'hook', 'hooks', 'ingest', 'git-hook', 'git-hook-uninstall',
      'background', 'bg', 'bs', 'doctor', 'repair', 'dashboard', 'cleanup', 'purge', 'uninstall', 'orchestrate'];
    if (firstArg && knownSubs.includes(firstArg)) return;

    // No subcommand provided — piped launches (MCP hosts, registry probes)
    // become an MCP stdio server; a human terminal gets the usage summary.
    if (!firstArg && shouldDefaultToMcp()) {
      const serve = await import('./commands/serve.js');
      await serve.default.run?.({ args: {}, rawArgs: [], cmd: serve.default } as any);
      return;
    }

    // Fallback: show usage hint
    if (process.stdout.isTTY) {
      import('./update-checker.js').then(m => m.checkForUpdates()).catch(() => {});
    }
    console.error(`Memorix v${getCliVersion()} — Local-first memory control plane\n`);
    console.error('Usage: memorix <command>\n');
    console.error('Commands:');
    console.error('  help       Show action-oriented help (`memorix memory --help`)');
    console.error('  background Start/stop/status background control plane');
    console.error('  session    Start/end/context for coding sessions');
    console.error('  memory     Search/store/detail/timeline/resolve observations');
    console.error('  context    Show the Memory Autopilot brief for this project');
    console.error('  resume     Resume prior work with one bounded project brief');
    console.error('  explain    Explain where Memorix project context comes from');
    console.error('  codegraph  Refresh/status/context-pack for CodeGraph Memory');
    console.error('  checkpoint Inspect native compact continuity checkpoints');
    console.error('  knowledge  Review source-backed knowledge pages and project workflows');
    console.error('  evidence   Inspect source-backed evidence cards');
    console.error('  feedback   Record or audit memory feedback');
    console.error('  continuity Record task requirements, decisions, verification, and outcome');
    console.error('  reasoning  Store/search decision rationale');
    console.error('  retention  Inspect stale/archive status');
    console.error('  formation  Inspect Memory Formation metrics');
    console.error('  audit      Audit trail and project attribution checks');
    console.error('  transfer   Export/import memory snapshots');
    console.error('  skills     List/generate/show project skills');
    console.error('  identity   Select the explicit CLI actor for private/team memory');
    console.error('  team       Join/status/role operations for coordination state');
    console.error('  task       Create/claim/complete/list team tasks');
    console.error('  message    Send/broadcast/read team messages');
    console.error('  lock       Manage advisory file locks');
    console.error('  handoff    Create durable handoff artifacts');
    console.error('  poll       Snapshot project coordination state');
    console.error('  receipt    Privacy-safe memory handoff diagnostic');
    console.error('  serve-http Start HTTP MCP + dashboard control plane');
    console.error('  serve      Start MCP server on stdio');
    console.error('  init       Create global defaults or project config');
    console.error('  setup      Install Memorix plugin/MCP/rules/hooks for an agent');
    console.error('  repair     Repair Memorix-owned agent integration files');
    console.error('  config     Show TOML config paths and resolved values');
    console.error('  integrate  Install one IDE integration into the current repo');
    console.error('  status     Show project info + stats');
    console.error('  dashboard  Open standalone dashboard (read-mostly)');
    console.error('  hooks      Install, inspect, or remove agent hooks');
    console.error('  cleanup    Remove old memories');
    console.error('  purge      Retire all memories (project by default, --all for everything)');
    console.error('  sync       Rules/workspace sync plus interactive wizard');
    console.error('  ingest     Ingest commit, log, or image knowledge');
  },
});

try {
  normalizeCliInvocation();
  if (!printCliGuideForHelp()) {
    runMain(main);
  }
} catch (error) {
  console.error(`Memorix CLI invocation error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
