/**
 * The deployed system end to end (ROADMAP Phase 10): the containerized
 * pmi-server behind Caddy over HTTPS (deploy/compose.yaml), blob encryption
 * on, two developer machines using the real CLI — and a backup -> destroy ->
 * restore drill on the running deployment.
 *
 * Run through deploy/acceptance.sh (sets PMI_COMPOSE=1, PMI_COMPOSE_ARGS,
 * PMI_COMPOSE_ENV_FILE, PMI_COMPOSE_DIR after starting the stack).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cliBuilt, git, machine, pmi, type Machine } from '../central/cli-helper.js';

const ENABLED = process.env.PMI_COMPOSE === '1' && cliBuilt;
const ARGS = (process.env.PMI_COMPOSE_ARGS ?? '').split(' ').filter(Boolean);
const DIR = process.env.PMI_COMPOSE_DIR ?? '';
const ENV: Record<string, string> = {};
let root = '';
let server = '';
let ca = '';
let alice: Machine;
let bob: Machine;
let projectId = '';
const tokens: Record<string, string> = {};

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...ARGS, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function admin(...args: string[]): string {
  return compose('exec', '-T', 'pmi-server', 'node', 'dist/server/central/main.js', ...args).trim();
}

function psql(sql: string): string {
  return compose('exec', '-T', 'postgres', 'psql', '-U', 'pmi', '-d', 'pmi', '-At', '-c', sql).trim();
}

function curl(method: string, pathname: string, token: string | null, body?: unknown): { status: number; body: any } {
  const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '--cacert', ca, '-X', method, `${server}${pathname}`];
  if (token) args.push('-H', `authorization: Bearer ${token}`);
  if (body !== undefined) args.push('-H', 'content-type: application/json', '-H', 'accept: application/json, text/event-stream', '--data-binary', JSON.stringify(body));
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const cut = out.lastIndexOf('\n');
  const text = out.slice(0, cut);
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: Number(out.slice(cut + 1)), body: parsed };
}

function waitHealthy(): void {
  for (let i = 0; i < 90; i++) {
    try {
      if (curl('GET', '/ready', null).status === 200) return;
    } catch { /* not up yet */ }
    execFileSync('sleep', ['1']);
  }
  throw new Error('the deployment did not become ready');
}

describe.skipIf(!ENABLED)('Compose deployment end to end', () => {
  beforeAll(async () => {
    for (const line of fs.readFileSync(process.env.PMI_COMPOSE_ENV_FILE!, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) ENV[line.slice(0, eq)] = line.slice(eq + 1);
    }
    root = fs.mkdtempSync(path.join(tmpdir(), 'pmi-compose-'));
    server = `https://localhost:${ENV.PMI_HTTPS_PORT}`;
    ca = path.join(root, 'caddy-root.crt');
    compose('cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', ca);
    waitHealthy();

    admin('create-org', 'acme');
    admin('create-org', 'rival');
    admin('create-user', 'alice@acme.test', '--org', 'acme', '--role', 'admin');
    admin('create-user', 'bob@acme.test', '--org', 'acme');
    admin('create-user', 'eve@rival.test', '--org', 'rival', '--role', 'owner');
    for (const name of ['alice@acme.test', 'bob@acme.test', 'eve@rival.test']) {
      tokens[name.split('@')[0]] = admin('issue-token', name, '--name', 'acceptance', '--days', '1').split('\n').at(-1)!;
    }

    const origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const repoA = path.join(root, 'a');
    git(root, 'clone', '-q', origin, repoA);
    git(repoA, 'config', 'user.email', 'a@test.dev');
    git(repoA, 'config', 'user.name', 'A');
    fs.writeFileSync(path.join(repoA, 'app.ts'), 'export const app = 1;\n');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-q', '-m', 'initial');
    git(repoA, 'push', '-q', 'origin', 'main');
    const repoB = path.join(root, 'b');
    git(root, 'clone', '-q', origin, repoB);
    for (const repo of [repoA, repoB]) {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/deployed.git');
      git(repo, 'remote', 'add', 'local', origin);
      git(repo, 'fetch', '-q', 'local');
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.pmi/\n');
    }
    const env = { NODE_EXTRA_CA_CERTS: ca, PMI_DAEMON: 'off' };
    alice = machine(root, 'alice-home', repoA, env);
    bob = machine(root, 'bob-home', repoB, env);

    for (const [m, token] of [[alice, tokens.alice], [bob, tokens.bob]] as const) {
      const login = await pmi(m, 'login', server, '--token', token, '--json');
      expect(login.code, login.stderr).toBe(0);
    }
    const linked = await pmi(alice, 'project', 'link', '--create', '--org', 'acme', '--slug', 'deployed', '--json');
    expect(linked.code, linked.stderr).toBe(0);
    projectId = linked.json.projectId;
    expect(curl('PUT', `/v1/projects/${projectId}/grants`, tokens.alice, { user: 'bob@acme.test', role: 'developer' }).status).toBe(200);
    expect((await pmi(bob, 'project', 'link')).code).toBe(0);
  }, 300_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves health over TLS and keeps the internals private', () => {
    expect(curl('GET', '/health', null)).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(curl('GET', '/v1/me', null).status).toBe(401);
    expect(() => execFileSync('curl', ['-sf', `http://localhost:${ENV.PMI_HTTP_PORT}/v1/me`, '-o', '/dev/null', '-w', '%{http_code}'], { encoding: 'utf8' })).not.toThrow();
  });

  it('shares memory between users (TEST 1/8) and isolates other organizations (TEST 9)', async () => {
    const stored = await pmi(alice, 'memory', 'store', '--type', 'decision', '--entity', 'orders', '--title', 'Orders are immutable after payment', '--text', 'Corrections create a new order revision.', '--json');
    expect(stored.code, stored.stderr).toBe(0);
    expect((await pmi(alice, 'sync', '--json')).json.pushed).toBeGreaterThanOrEqual(1);
    const pulled = await pmi(bob, 'sync', '--json');
    expect(pulled.json.applied).toBeGreaterThanOrEqual(1);

    expect(curl('GET', `/v1/projects/${projectId}`, tokens.eve).status).toBe(404);
    expect(curl('POST', `/v1/projects/${projectId}/search`, tokens.eve, { query: 'orders' }).status).toBe(404);
    const mcp = curl('POST', '/mcp', tokens.eve, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'orders', project_id: projectId } } });
    expect(JSON.stringify(mcp.body)).toContain('project_not_found');
  }, 120_000);

  it('hands a session over with its uncommitted work (TEST 2/3), blobs encrypted at rest', async () => {
    fs.writeFileSync(path.join(alice.repo, 'app.ts'), 'export const app = 2; // in progress\n');
    fs.writeFileSync(path.join(alice.repo, 'notes.md'), '# handoff notes\n');
    const start = await pmi(alice, 'session', 'start', '--agent', 'claude-code', '--task', 'Order revisions', '--json');
    expect(start.code, start.stderr).toBe(0);
    const handoff = await pmi(alice, 'session', 'handoff', '--next', 'Add the revision endpoint', '--json');
    expect(handoff.code, handoff.stderr + handoff.stdout).toBe(0);
    expect(handoff.json.delivered).toBe(true);
    expect(psql("SELECT encode(substr(data, 1, 5), 'escape') FROM work.blobs WHERE storage = 'inline' LIMIT 1")).toBe('PMIE1');

    const target = path.join(root, 'bob-worktree');
    const resume = await pmi(bob, 'session', 'resume', start.json.pmi.sessionId, '--agent', 'codex', '--worktree', target, '--json');
    expect(resume.code, resume.stderr + resume.stdout).toBe(0);
    expect(resume.json).toMatchObject({ nextAction: 'Add the revision endpoint', restore: { verified: true } });
    expect(fs.readFileSync(path.join(target, 'app.ts'), 'utf8')).toBe('export const app = 2; // in progress\n');
    expect(fs.readFileSync(path.join(target, 'notes.md'), 'utf8')).toBe('# handoff notes\n');
  }, 120_000);

  it('analyzes new commits incrementally (TEST 5) and builds context within budget (TEST 6)', async () => {
    expect((await pmi(alice, 'git', 'analyze', '--json')).json.initial).toBe(true);
    git(alice.repo, 'checkout', '-q', '--', 'app.ts');
    fs.rmSync(path.join(alice.repo, 'notes.md'));
    fs.mkdirSync(path.join(alice.repo, 'src', 'routes'), { recursive: true });
    fs.writeFileSync(path.join(alice.repo, 'src/routes/revisions.ts'), 'export const revisions = [];\n');
    git(alice.repo, 'add', '-A');
    git(alice.repo, 'commit', '-q', '-m', 'feat: revisions endpoint');
    fs.writeFileSync(path.join(alice.repo, 'app.ts'), 'export const app = 3;\n');
    git(alice.repo, 'commit', '-q', '-am', 'fix: app version (fixes #7)');
    const analyzed = await pmi(alice, 'git', 'analyze', '--json');
    expect(analyzed.json).toMatchObject({ mode: 'server', commitsAnalyzed: 2 });
    expect((await pmi(alice, 'git', 'analyze', '--json')).json.commitsAnalyzed).toBe(0);

    const context = curl('POST', `/v1/projects/${projectId}/context`, tokens.bob, { task: 'add order revisions endpoint' });
    expect(context.status).toBe(200);
    expect(context.body.receipt.tokensTotal).toBeLessThanOrEqual(2_300);
    expect(context.body.text).toContain('Orders are immutable after payment');

    const metrics = execFileSync('curl', ['-s', '--cacert', ca, '-H', `authorization: Bearer ${ENV.PMI_METRICS_TOKEN}`, `${server}/metrics`], { encoding: 'utf8' });
    expect(metrics).toMatch(/pmi_context_builds_total \d+/);
    expect(metrics).toMatch(/pmi_session_recovery_total\{result="success"\} \d+/);
  }, 120_000);

  it('survives a backup -> destroy -> restore drill with every blob verified', async () => {
    const backupDir = path.join(root, 'backup');
    execFileSync(path.join(DIR, 'backup.sh'), [backupDir, ...ARGS], { encoding: 'utf8', stdio: 'pipe' });
    expect(fs.readFileSync(path.join(backupDir, 'MANIFEST'), 'utf8')).toMatch(/db\.dump/);
    const memoriesBefore = psql('SELECT count(*) FROM memory.memories');

    // Lose the database and the blob volume (Caddy keeps its CA).
    compose('rm', '-sfv', 'pmi-server', 'postgres');
    const project = ARGS[ARGS.indexOf('-p') + 1];
    execFileSync('docker', ['volume', 'rm', `${project}_pg-data`, `${project}_blob-data`], { stdio: 'pipe' });
    compose('up', '-d', '--wait', 'postgres');
    compose('up', '-d', '--wait', 'pmi-server');
    expect(psql('SELECT count(*) FROM memory.memories')).toBe('0');

    const restored = execFileSync(path.join(DIR, 'restore.sh'), [backupDir, ...ARGS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(restored).toMatch(/Checked \d+ blob\(s\); 0 failed/);
    waitHealthy();
    expect(psql('SELECT count(*) FROM memory.memories')).toBe(memoriesBefore);

    // A brand-new machine with Bob's token restores the handed-off work from the restored server.
    const carol = machine(root, 'carol-home', bob.repo, { NODE_EXTRA_CA_CERTS: ca, PMI_DAEMON: 'off' });
    expect((await pmi(carol, 'login', server, '--token', tokens.bob)).code).toBe(0);
    const snapshot = psql("SELECT id FROM work.snapshots WHERE pinned ORDER BY created_at DESC LIMIT 1");
    const target = path.join(root, 'carol-worktree');
    const restoreSnap = await pmi(carol, 'workspace', 'restore', snapshot, '--worktree', target, '--json');
    expect(restoreSnap.code, restoreSnap.stderr + restoreSnap.stdout).toBe(0);
    expect(fs.readFileSync(path.join(target, 'notes.md'), 'utf8')).toBe('# handoff notes\n');
  }, 300_000);
});

describe.skipIf(ENABLED)('Compose deployment end to end', () => {
  it.skip('run deploy/acceptance.sh to test the Docker Compose deployment', () => undefined);
});
