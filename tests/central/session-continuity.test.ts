/**
 * Session continuity acceptance tests (SESSION_CONTINUITY.md §9) with the real
 * CLI, real stdio MCP servers launched from the configs `baton setup` writes,
 * the real daemon, baton-server and Postgres.
 *
 * - TEST 2  (CLI): A starts, checkpoints twice, hands off; B (another user,
 *            device and agent) lists and resumes with steps, next action, files.
 * - TEST 10 (MCP via Claude Code and Codex configs): same flow through agents.
 * - TEST 4: the agent is killed (kill -9) without a handoff; the daemon's
 *            automatic checkpoints let B resume. Variant: the whole machine
 *            dies (daemon killed too) and the server's lease expiry frees it.
 * - TEST 7: two users' agents work in one project at the same time.
 *
 * Workspace files are not transferred yet (Phase 7): resume returns the list
 * of changed files and the branch, not their contents.
 */
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import {
  cliBuilt,
  connectAgentWithCommand,
  createRepoPair,
  installCliShims,
  machine,
  baton,
  stopDaemons,
  toolText,
  type Machine,
} from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const LEASE_TTL_SECONDS = 4;

let root = '';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let serverUrl = '';
let alice: Machine;
let bob: Machine;
const tokens: Record<string, string> = {};
const mcpCommand: Record<string, { command: string; args: string[] }> = {};

async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${daemonLogs()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function serverSession(id: string) {
  const [row] = await db.query<{ status: string; last_checkpoint_seq: number; state: any }>(
    'SELECT status, last_checkpoint_seq, state FROM work.sessions WHERE id = $1', [id],
  );
  return row;
}

/** Daemon logs of both machines, attached to timeouts so failures explain themselves. */
function daemonLogs(): string {
  return [alice, bob].filter(Boolean).map((m) => {
    try {
      return `\n--- ${m.name} daemon log ---\n${readFileSync(path.join(m.env.BATON_DATA_DIR, 'baton-daemon.log'), 'utf8').slice(-3000)}`;
    } catch {
      return `\n--- ${m.name}: no daemon log ---`;
    }
  }).join('');
}

function daemonPid(m: Machine): number | undefined {
  try {
    return Number(JSON.parse(readFileSync(path.join(m.env.BATON_DATA_DIR, 'baton-daemon.pid'), 'utf8')).pid);
  } catch {
    return undefined;
  }
}

function startedSessionId(result: unknown): string {
  const id = toolText(result).match(/Session started: (\S+)/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

describe.skipIf(!pgAvailable || !cliBuilt)('session continuity end to end', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'baton-sessions-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['alice', 'admin'], ['bob', 'member']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined, leaseTtlSeconds: LEASE_TTL_SECONDS });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const bin = installCliShims(root);
    const tuning = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      BATON_DAEMON_TICK_MS: '250',
      BATON_CHECKPOINT_DEBOUNCE_MS: '500',
      BATON_HEARTBEAT_MS: '1000',
      BATON_AGENT_IDLE_MS: '600000',
    };
    const [repoA, repoB] = createRepoPair(root, 'https://github.com/acme/shop.git');
    alice = machine(root, 'alice', repoA, tuning);
    bob = machine(root, 'bob', repoB, tuning);

    expect((await baton(alice, 'login', serverUrl, '--token', tokens.alice)).code).toBe(0);
    expect((await baton(bob, 'login', serverUrl, '--token', tokens.bob)).code).toBe(0);
    const created = await baton(alice, 'project', 'link', '--create', '--org', 'acme', '--slug', 'shop', '--json');
    expect(created.code, created.stderr).toBe(0);
    await fetch(`${serverUrl}/v1/projects/${created.json.projectId}/grants`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokens.alice}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'bob@acme.test', role: 'developer' }),
    });
    expect((await baton(bob, 'project', 'link')).code).toBe(0);

    // The real adapters: Claude Code (project .mcp.json) on Alice's
    // machine, Codex (~/.codex/config.toml) on Bob's.
    const claudeSetup = await baton(alice, 'setup', '--agent', 'claude', '--noPlugin');
    expect(claudeSetup.code, claudeSetup.stderr).toBe(0);
    const claudeConfig = JSON.parse(readFileSync(path.join(repoA, '.mcp.json'), 'utf8'));
    mcpCommand.claude = claudeConfig.mcpServers.baton;
    const codexSetup = await baton(bob, 'setup', '--agent', 'codex', '--global', '--noPlugin', '--noHooks');
    expect(codexSetup.code, codexSetup.stderr).toBe(0);
    const toml = readFileSync(path.join(bob.home, '.codex', 'config.toml'), 'utf8');
    mcpCommand.codex = {
      command: JSON.parse(toml.match(/^command = (".*")$/m)![1]),
      args: JSON.parse(toml.match(/^args = (\[.*\])$/m)![1]),
    };
  }, 240_000);

  afterAll(async () => {
    await stopDaemons([alice, bob]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('uses the commands the agent configs specify', () => {
    expect(mcpCommand.claude).toMatchObject({ command: 'baton', args: ['serve', '--mode', 'lite'] });
    expect(mcpCommand.codex).toMatchObject({ command: 'baton', args: ['serve', '--mode', 'lite'] });
  });

  it('TEST 2: CLI handoff from one user to another', async () => {
    writeFileSync(path.join(alice.repo, 'cart.ts'), 'export const cart = [];\n');
    const start = await baton(alice, 'session', 'start', '--agent', 'claude-code', '--model', 'claude-opus',
      '--task', 'Shopping cart totals', '--objective', 'cart total includes tax and discounts', '--json');
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.json.baton.sessionId as string;

    expect((await baton(alice, 'session', 'checkpoint', '--done', 'Cart model', '--pending', 'Tax rules; Discount codes')).code).toBe(0);
    expect((await baton(alice, 'session', 'checkpoint', '--done', 'Tax rules', '--progress', 'tax done, discounts next')).code).toBe(0);
    const handoff = await baton(alice, 'session', 'handoff', '--next', 'Implement discount code validation in cart.ts', '--json');
    expect(handoff.code, handoff.stderr || handoff.stdout).toBe(0);
    expect(handoff.json.delivered).toBe(true);

    const list = await baton(bob, 'session', 'list', '--json');
    expect(list.code, list.stderr).toBe(0);
    expect(list.json.offline, JSON.stringify(list.json)).toBe(false);
    expect(list.json.sessions.map((s: { id: string }) => s.id)).toContain(sessionId);

    const resume = await baton(bob, 'session', 'resume', sessionId, '--agent', 'codex', '--model', 'gpt-5', '--json');
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.json).toMatchObject({
      continuation: 'child_session',
      resumedFrom: sessionId,
      nextAction: 'Implement discount code validation in cart.ts',
      doNotRedo: ['Cart model', 'Tax rules'],
    });
    expect(resume.json.filesToRead).toContain('cart.ts');
    expect(resume.json.filesToRead).not.toContain('.baton/project.json');
    expect(resume.json.state.pendingSteps.map((s: { text: string }) => s.text)).toEqual(['Discount codes']);
    expect(resume.json.state.objective).toBe('cart total includes tax and discounts');
    expect(resume.json.session).toMatchObject({ status: 'in_progress', parentSessionId: sessionId, userEmail: 'bob@acme.test' });
    expect(resume.stdout.length).toBeGreaterThan(0);

    const finished = await baton(bob, 'session', 'finish', '--sessionId', resume.json.sessionId, '--summary', 'handed back');
    expect(finished.code, finished.stderr).toBe(0);
  }, 120_000);

  it('TEST 10: Claude Code hands off over MCP, Codex resumes over MCP', async () => {
    const claude = await connectAgentWithCommand(alice, 'claude-code', mcpCommand.claude.command, mcpCommand.claude.args);
    let sessionId = '';
    try {
      sessionId = startedSessionId(await claude.client.callTool({
        name: 'baton_session_start',
        arguments: { agent: 'claude-code', model: 'claude-opus', modelProvider: 'anthropic', task: 'Order export to CSV', objective: 'orders download as CSV from admin' },
      }));
      await claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['CSV serializer'], pending: ['Admin download button', 'Escape commas'] } });
      await claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Escape commas'], progress: 'serializer done' } });
      const handoff = await claude.client.callTool({ name: 'session_handoff', arguments: { next: 'Add the download button to the admin orders page' } });
      expect(handoff.isError, toolText(handoff)).toBeFalsy();
      expect((handoff.structuredContent as { delivered: boolean }).delivered).toBe(true);
    } finally {
      await claude.client.close();
    }

    const codex = await connectAgentWithCommand(bob, 'codex', mcpCommand.codex.command, mcpCommand.codex.args);
    try {
      const card = await codex.client.callTool({ name: 'baton_session_start', arguments: { agent: 'codex', model: 'gpt-5' } });
      expect(toolText(card)).toContain(sessionId);
      const list = await codex.client.callTool({ name: 'session_list', arguments: {} });
      expect(toolText(list)).toContain('Order export to CSV');
      const resumed = await codex.client.callTool({ name: 'session_resume', arguments: { sessionId, agent: 'codex', model: 'gpt-5', modelProvider: 'openai' } });
      expect(resumed.isError, toolText(resumed)).toBeFalsy();
      expect(resumed.structuredContent).toMatchObject({
        resumedFrom: sessionId,
        continuation: 'child_session',
        task: 'Order export to CSV',
        nextAction: 'Add the download button to the admin orders page',
        completedSteps: ['CSV serializer', 'Escape commas'],
        pendingSteps: ['Admin download button'],
      });
      expect(toolText(resumed)).toContain('## Do NOT redo');
      const childId = (resumed.structuredContent as { sessionId: string }).sessionId;
      const child = await serverSession(childId);
      expect(child.status).toBe('in_progress');
      expect(child.state).toMatchObject({ agent: 'codex', model: 'gpt-5', parentSessionId: sessionId });
      await codex.client.callTool({ name: 'session_finish', arguments: { summary: 'export shipped' } });
    } finally {
      await codex.client.close();
    }
  }, 120_000);

  it('TEST 4: the agent is killed mid-task; automatic checkpoints let another user resume', async () => {
    const claude = await connectAgentWithCommand(alice, 'claude-code', mcpCommand.claude.command, mcpCommand.claude.args);
    const sessionId = startedSessionId(await claude.client.callTool({
      name: 'baton_session_start',
      arguments: { agent: 'claude-code', task: 'Refund webhooks', objective: 'refund events update orders' },
    }));
    await claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Webhook route'], pending: ['Signature check', 'Order update'] } });
    await waitFor('daemon', async () => daemonPid(alice));

    // The agent keeps working without telling Baton anything more.
    writeFileSync(path.join(alice.repo, 'refund-webhook.ts'), 'export function handleRefund() {}\n');
    writeFileSync(path.join(alice.repo, 'signature.ts'), 'export const verify = () => true;\n');
    await waitFor('automatic checkpoint on the server', async () => {
      const row = await serverSession(sessionId);
      const files = (row?.state.git?.modifiedFiles ?? []).map((file: { path: string }) => file.path);
      return row && row.last_checkpoint_seq >= 2 && files.includes('signature.ts');
    });

    // Model limit / crash: the agent process dies without handoff.
    process.kill(claude.pid()!, 'SIGKILL');
    await claude.client.close().catch(() => undefined);
    const released = await waitFor('session released by the daemon', async () => {
      const row = await serverSession(sessionId);
      return row?.status === 'resumable' ? row : undefined;
    });
    expect(released.state.lastCheckpoint.trigger).toMatch(/fs_change|timer|exit/);

    const resume = await baton(bob, 'session', 'resume', sessionId, '--agent', 'codex', '--json');
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.json.doNotRedo).toEqual(['Webhook route']);
    expect(resume.json.nextAction).toBe('Signature check');
    expect(resume.json.nextActionInferred).toBe(true);
    expect(resume.json.filesToRead).toEqual(expect.arrayContaining(['refund-webhook.ts', 'signature.ts']));
    await baton(bob, 'session', 'finish', '--sessionId', resume.json.sessionId);
  }, 120_000);

  it('TEST 4 (machine lost): agent and daemon die; the server lease expires and the last checkpoint is resumable', async () => {
    const claude = await connectAgentWithCommand(alice, 'claude-code', mcpCommand.claude.command, mcpCommand.claude.args);
    const sessionId = startedSessionId(await claude.client.callTool({
      name: 'baton_session_start',
      arguments: { agent: 'claude-code', task: 'Inventory sync' },
    }));
    await claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Inventory API client'], next: 'Nightly sync job' } });
    writeFileSync(path.join(alice.repo, 'inventory.ts'), 'export const sync = () => {};\n');
    await waitFor('automatic checkpoint with inventory.ts', async () => {
      const row = await serverSession(sessionId);
      return (row?.state.git?.modifiedFiles ?? []).some((file: { path: string }) => file.path === 'inventory.ts');
    });

    const daemon = daemonPid(alice)!;
    process.kill(daemon, 'SIGKILL');
    process.kill(claude.pid()!, 'SIGKILL');
    await claude.client.close().catch(() => undefined);
    expect((await serverSession(sessionId)).status).not.toBe('resumable');

    const listed = await waitFor('lease expiry', async () => {
      const list = await baton(bob, 'session', 'list', '--json');
      return list.json?.sessions.find((s: { id: string; status: string }) => s.id === sessionId && s.status === 'resumable');
    }, (LEASE_TTL_SECONDS + 10) * 1000);
    expect(listed).toBeTruthy();

    const resume = await baton(bob, 'session', 'resume', sessionId, '--agent', 'codex', '--json');
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.json).toMatchObject({ doNotRedo: ['Inventory API client'], nextAction: 'Nightly sync job' });
    expect(resume.json.filesToRead).toContain('inventory.ts');
    await baton(bob, 'session', 'finish', '--sessionId', resume.json.sessionId);
    rmSync(path.join(alice.home, 'data', 'baton-daemon.pid'), { force: true });
  }, 120_000);

  it('TEST 7: two users\' agents work in parallel without touching each other\'s sessions', async () => {
    const claude = await connectAgentWithCommand(alice, 'claude-code', mcpCommand.claude.command, mcpCommand.claude.args);
    const codex = await connectAgentWithCommand(bob, 'codex', mcpCommand.codex.command, mcpCommand.codex.args);
    try {
      const [aId, bId] = await Promise.all([
        claude.client.callTool({ name: 'baton_session_start', arguments: { agent: 'claude-code', task: 'Search filters' } }).then(startedSessionId),
        codex.client.callTool({ name: 'baton_session_start', arguments: { agent: 'codex', task: 'Email receipts' } }).then(startedSessionId),
      ]);
      await Promise.all([
        claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Price filter'] } }),
        codex.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Receipt template'] } }),
      ]);
      await Promise.all([
        claude.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['Brand filter'] } }),
        codex.client.callTool({ name: 'session_checkpoint', arguments: { completed: ['SMTP sender'] } }),
      ]);
      const a = await waitFor('A on server', async () => { const row = await serverSession(aId); return row?.last_checkpoint_seq >= 2 ? row : undefined; });
      const b = await waitFor('B on server', async () => { const row = await serverSession(bId); return row?.last_checkpoint_seq >= 2 ? row : undefined; });
      expect(['in_progress', 'checkpointed']).toContain(a.status);
      expect(['in_progress', 'checkpointed']).toContain(b.status);
      expect(a.state.completedSteps.map((s: { text: string }) => s.text)).toEqual(['Price filter', 'Brand filter']);
      expect(b.state.completedSteps.map((s: { text: string }) => s.text)).toEqual(['Receipt template', 'SMTP sender']);
      const checkpoints = await db.query<{ session_id: string; n: number }>(
        'SELECT session_id, count(*)::int AS n FROM work.checkpoints WHERE session_id = ANY ($1) AND NOT orphan GROUP BY session_id', [[aId, bId]],
      );
      expect(Object.fromEntries(checkpoints.map((row) => [row.session_id, row.n]))).toEqual({ [aId]: expect.any(Number), [bId]: expect.any(Number) });
      await Promise.all([
        claude.client.callTool({ name: 'session_finish', arguments: {} }),
        codex.client.callTool({ name: 'session_finish', arguments: {} }),
      ]);
    } finally {
      await claude.client.close();
      await codex.client.close();
    }
  }, 120_000);
});

describe.skipIf(pgAvailable && cliBuilt)('session continuity end to end', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
