/**
 * The PMI daemon: automatic checkpoints that do not depend on the agent
 * (SESSION_CONTINUITY.md §4, ARCHITECTURE.md D8). One per data directory.
 *
 * Every tick, for each live session of this device:
 *   - reads the working copy fingerprint (HEAD, changed paths, sizes, mtimes);
 *   - checkpoints when a change has settled for the debounce period
 *     (`fs_change`, or `commit` when HEAD moved), or when changes keep coming
 *     and the last checkpoint is older than the interval (`timer`);
 *   - when the agent process is gone or idle too long: a final `exit`
 *     checkpoint and the session is released (resumable for others);
 *   - otherwise renews the server lease.
 * Then it delivers the outbox. Change detection polls instead of using
 * filesystem events: the same behaviour on every OS and file system, and the
 * cost is a `git status` per active session per tick.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { LIVE_STATUSES } from '../domain/session.js';
import { readWorkspace } from './git-state.js';
import { LocalSessionStore } from './local-store.js';
import { checkpointSession, flushOutbox, heartbeatSession, releaseSession, type FlushReport } from './service.js';

export interface DaemonSettings {
  tickMs: number;
  debounceMs: number;
  intervalMs: number;
  agentIdleMs: number;
  heartbeatMs: number;
}

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function daemonSettings(env: NodeJS.ProcessEnv = process.env): DaemonSettings {
  return {
    tickMs: envMs(env, 'PMI_DAEMON_TICK_MS', 5_000),
    debounceMs: envMs(env, 'PMI_CHECKPOINT_DEBOUNCE_MS', 60_000),
    intervalMs: envMs(env, 'PMI_CHECKPOINT_INTERVAL_MS', 300_000),
    agentIdleMs: envMs(env, 'PMI_AGENT_IDLE_MS', 900_000),
    heartbeatMs: envMs(env, 'PMI_HEARTBEAT_MS', 120_000),
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TickReport {
  checkpoints: Array<{ sessionId: string; trigger: string }>;
  released: string[];
  heartbeats: number;
  flush: FlushReport;
}

export async function daemonTick(
  store: LocalSessionStore,
  settings: DaemonSettings,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<TickReport> {
  const report: TickReport = { checkpoints: [], released: [], heartbeats: 0, flush: { sent: 0, rejected: [], pending: 0, offline: false } };
  for (const session of store.list({ statuses: LIVE_STATUSES, deviceOnly: true })) {
    const agentGone = session.agentPid !== null && !isProcessAlive(session.agentPid);
    const idle = now - Date.parse(session.lastActivityAt) > settings.agentIdleMs;
    const reading = session.workspaceRoot ? readWorkspace(session.workspaceRoot) : undefined;

    if (reading && reading.fingerprint !== session.lastFingerprint) {
      let since = session.pendingSince ? Date.parse(session.pendingSince) : now;
      if (session.pendingFingerprint !== reading.fingerprint) {
        since = now;
        store.setFingerprintTracking(session.id, { pendingFingerprint: reading.fingerprint, pendingSince: new Date(now).toISOString() });
      }
      const settled = now - since >= settings.debounceMs;
      const lastCheckpointAt = Date.parse(session.lastCheckpointAt ?? session.createdAt);
      const overdue = now - lastCheckpointAt >= settings.intervalMs;
      if (!agentGone && !idle && (settled || overdue)) {
        const headMoved = Boolean(reading.git.head) && reading.git.head !== session.state.git?.head;
        const trigger = headMoved ? 'commit' : settled ? 'fs_change' : 'timer';
        checkpointSession(store, session.id, trigger);
        report.checkpoints.push({ sessionId: session.id, trigger });
      }
    }

    if (agentGone || idle) {
      const before = store.get(session.id)!.checkpointSeq;
      releaseSession(store, session.id);
      if (store.get(session.id)!.checkpointSeq > before) report.checkpoints.push({ sessionId: session.id, trigger: 'exit' });
      report.released.push(session.id);
      continue;
    }

    const lastBeat = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : 0;
    if (now - lastBeat >= settings.heartbeatMs && await heartbeatSession(store, session.id, env)) report.heartbeats++;
  }
  report.flush = await flushOutbox(store, env);
  return report;
}

/** On SIGTERM: checkpoint unsaved changes (`exit`) and try to deliver them, without releasing leases. */
export async function daemonShutdown(store: LocalSessionStore, env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): Promise<void> {
  for (const session of store.list({ statuses: LIVE_STATUSES, deviceOnly: true })) {
    const reading = session.workspaceRoot ? readWorkspace(session.workspaceRoot) : undefined;
    if (reading && reading.fingerprint !== session.lastFingerprint) checkpointSession(store, session.id, 'exit');
  }
  await Promise.race([flushOutbox(store, env), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

export function pidFilePath(dataDir: string): string {
  return path.join(dataDir, 'pmi-daemon.pid');
}

export function runningDaemonPid(dataDir: string): number | undefined {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(pidFilePath(dataDir), 'utf8')).pid);
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Foreground loop used by `pmi daemon run`. */
export async function runDaemon(dataDir: string, env: NodeJS.ProcessEnv = process.env, log: (line: Record<string, unknown>) => void = (line) => console.log(JSON.stringify(line))): Promise<void> {
  const existing = runningDaemonPid(dataDir);
  if (existing && existing !== process.pid) throw new Error(`[pmi] the daemon is already running (pid ${existing})`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFilePath(dataDir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const store = new LocalSessionStore(dataDir);
  const settings = daemonSettings(env);
  log({ at: new Date().toISOString(), msg: 'pmi daemon started', pid: process.pid, dataDir, settings });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    // The pid file is the daemon's claim on this data directory. If it was
    // removed (data dir deleted, `daemon stop` racing) or another daemon took
    // over, this one steps down instead of running unsupervised.
    if (runningDaemonPid(dataDir) !== process.pid) {
      log({ at: new Date().toISOString(), msg: 'pmi daemon stepping down: pid file is gone or owned by another daemon' });
      break;
    }
    try {
      const report = await daemonTick(store, settings, env);
      if (report.checkpoints.length || report.released.length || report.flush.sent || report.flush.rejected.length) {
        log({ at: new Date().toISOString(), ...report });
      }
    } catch (error) {
      log({ at: new Date().toISOString(), level: 'error', error: (error as Error).message });
    }
    // A referenced timer: it is what keeps the daemon process alive between ticks.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, settings.tickMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await daemonShutdown(store, env);
  try {
    if (runningDaemonPid(dataDir) === process.pid) fs.unlinkSync(pidFilePath(dataDir));
  } catch { /* already gone */ }
  log({ at: new Date().toISOString(), msg: 'pmi daemon stopped' });
}

/**
 * Start the daemon in the background if it is not running. `PMI_DAEMON=off`
 * disables auto-start (the daemon can still be run with `pmi daemon start`).
 */
export function ensureDaemon(dataDir: string, cliPath: string | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.PMI_DAEMON === 'off' || !cliPath) return undefined;
  const running = runningDaemonPid(dataDir);
  if (running) return running;
  fs.mkdirSync(dataDir, { recursive: true });
  const logFd = fs.openSync(path.join(dataDir, 'pmi-daemon.log'), 'a');
  const child = spawn(process.execPath, [cliPath, 'daemon', 'run'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...env, MEMORIX_DATA_DIR: dataDir },
  });
  child.unref();
  fs.closeSync(logFd);
  return child.pid;
}

/** Path of the bundled CLI when running from it (dist/cli/index.js), for spawning the daemon. */
export function currentCliPath(): string | undefined {
  const candidate = process.argv[1];
  if (candidate && /cli[\\/]index\.(js|mjs)$/.test(candidate) && fs.existsSync(candidate)) return candidate;
  return undefined;
}
