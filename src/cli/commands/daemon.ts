/**
 * `pmi daemon start|stop|status|run` — the automatic checkpointer
 * (src/session/daemon.ts). `pmi session start` and `pmi session resume`
 * start it on their own in Connected mode.
 */
import { defineCommand } from 'citty';

import { getBaseDataDir } from '../../store/persistence.js';
import { emitError, emitResult } from './operator-shared.js';

export default defineCommand({
  meta: { name: 'daemon', description: 'Automatic session checkpoints, lease renewal and outbox delivery' },
  args: { json: { type: 'boolean', default: false } },
  async run({ args }) {
    const asJson = Boolean(args.json);
    const action = (args._ as string[])?.[0] || 'status';
    const dataDir = getBaseDataDir();
    const daemon = await import('../../session/daemon.js');
    try {
      switch (action) {
        case 'run':
          await daemon.runDaemon(dataDir);
          return;
        case 'start': {
          const pid = daemon.ensureDaemon(dataDir, daemon.currentCliPath(), { ...process.env, PMI_DAEMON: 'on' });
          emitResult({ running: Boolean(pid), pid: pid ?? null }, pid ? `PMI daemon running (pid ${pid})` : 'Could not start the daemon (run it with `pmi daemon run`).', asJson);
          return;
        }
        case 'stop': {
          const pid = daemon.runningDaemonPid(dataDir);
          if (!pid) {
            emitResult({ running: false }, 'PMI daemon is not running.', asJson);
            return;
          }
          process.kill(pid, 'SIGTERM');
          const deadline = Date.now() + 10_000;
          while (daemon.isProcessAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
          emitResult({ running: daemon.isProcessAlive(pid), pid }, daemon.isProcessAlive(pid) ? `PMI daemon ${pid} did not stop in time` : `PMI daemon ${pid} stopped (unsaved changes were checkpointed)`, asJson);
          return;
        }
        case 'status': {
          const pid = daemon.runningDaemonPid(dataDir);
          const { LocalSessionStore } = await import('../../session/local-store.js');
          const { LIVE_STATUSES } = await import('../../domain/session.js');
          const store = new LocalSessionStore(dataDir);
          const live = store.list({ statuses: LIVE_STATUSES, deviceOnly: true });
          const outbox = store.countPendingOps();
          emitResult(
            { running: Boolean(pid), pid: pid ?? null, liveSessions: live.map((session) => session.id), outbox, settings: daemon.daemonSettings() },
            [`PMI daemon: ${pid ? `running (pid ${pid})` : 'not running'}`, `Live sessions on this device: ${live.length}`, `Queued for the server: ${outbox}`].join('\n'),
            asJson,
          );
          return;
        }
        default:
          emitError(`unknown action "${action}" (expected start|stop|status|run)`, asJson);
          process.exitCode = 2;
      }
    } catch (error) {
      emitError((error as Error).message, asJson);
    }
  },
});
