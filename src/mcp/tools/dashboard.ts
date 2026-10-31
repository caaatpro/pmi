/**
 * memorix_dashboard: starts or reuses the local web dashboard.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerToolContext } from './server-context.js';
import { coerceNumber } from './helpers.js';

export function registerDashboardTools(server: McpServer, ctx: ServerToolContext): void {
  // ============================================================
  // memorix_dashboard — Launch the web dashboard
  // ============================================================

  let dashboardRunning = false;

  server.registerTool(
    'memorix_dashboard',
    {
      title: 'Launch Dashboard',
      description:
        'Launch the Memorix Web Dashboard in the browser. ' +
        'In HTTP control-plane mode, this reuses the current control-plane dashboard. ' +
        'In stdio/standalone mode, it starts the standalone dashboard server.',
      inputSchema: {
        port: z.number().optional().describe('Optional port override for standalone mode. In HTTP control-plane mode, the active dashboard port is reused.'),
      },
    },
    async ({ port: dashboardPort }) => {
      const inControlPlane = ctx.dashboardMode === 'control-plane';
      const portNum = inControlPlane
        ? ctx.configuredDashboardPort
        : (dashboardPort != null ? coerceNumber(dashboardPort, ctx.configuredDashboardPort) : ctx.configuredDashboardPort);
      const url = `http://localhost:${portNum}`;

      if (inControlPlane) {
        const http = await import('node:http');
        const postData = JSON.stringify({ projectId: ctx.project.id, projectName: ctx.project.name });
        await new Promise<void>(resolve => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: portNum,
            path: '/api/set-current-project',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          }, () => resolve());
          req.on('error', () => resolve());
          req.write(postData);
          req.end();
        });

        const projectUrl = `${url}?project=${encodeURIComponent(ctx.project.id)}`;
        const { exec } = await import('node:child_process');
        const cmd =
          process.platform === 'win32' ? `start "" "${projectUrl}"` :
            process.platform === 'darwin' ? `open "${projectUrl}"` :
              `xdg-open "${projectUrl}"`;
        exec(cmd, { windowsHide: true }, () => { });

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Memorix Dashboard opened on the current control plane.`,
              ``,
              `URL: ${url}`,
              `Project: ${ctx.project.name} (${ctx.project.id})`,
              ``,
              `This MCP session is already running in HTTP control-plane mode, so no standalone 3210 dashboard was started.`,
            ].join('\n'),
          }],
        };
      }

      if (dashboardRunning) {
        // Verify the dashboard is actually still listening (process may have been killed externally)
        const { createConnection } = await import('node:net');
        const isAlive = await new Promise<boolean>(resolve => {
          const sock = createConnection(portNum, '127.0.0.1');
          sock.once('connect', () => { sock.destroy(); resolve(true); });
          sock.once('error', () => { sock.destroy(); resolve(false); });
          setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
        });

        if (isAlive) {
          // Update the dashboard server's current project via API
          const http = await import('node:http');
          const postData = JSON.stringify({ projectId: ctx.project.id, projectName: ctx.project.name });
          await new Promise<void>(resolve => {
            const req = http.request({
              hostname: '127.0.0.1', port: portNum,
              path: '/api/set-current-project', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            }, () => resolve());
            req.on('error', () => resolve()); // ignore errors
            req.write(postData);
            req.end();
          });

          // Open browser — the dashboard now serves this project as current
          const projectUrl = `${url}?project=${encodeURIComponent(ctx.project.id)}`;
          const { exec } = await import('node:child_process');
          const cmd =
            process.platform === 'win32' ? `start "" "${projectUrl}"` :
              process.platform === 'darwin' ? `open "${projectUrl}"` :
                `xdg-open "${projectUrl}"`;
          exec(cmd, { windowsHide: true }, () => { });
          return {
            content: [{ type: 'text' as const, text: `Dashboard is already running at ${url}. Switched to project: ${ctx.project.name} (${ctx.project.id}).` }],
          };
        }

        // Dashboard process was killed externally — reset flag and fall through to restart
        console.error('[memorix] Dashboard process no longer running, restarting...');
        dashboardRunning = false;
      }

      try {
        const pathMod = await import('node:path');
        const fsMod = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { startDashboard } = await import('../../dashboard/server.js');

        // Try multiple strategies to find the static files directory
        // When running from CLI (dist/cli/index.js), __dirname = dist/cli/, need to go up
        const candidates = [
          pathMod.default.join(__dirname, '..', 'dashboard', 'static'),
          pathMod.default.join(__dirname, 'dashboard', 'static'),
          pathMod.default.join(pathMod.default.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'static'),
          pathMod.default.join(pathMod.default.dirname(fileURLToPath(import.meta.url)), 'dashboard', 'static'),
        ];

        // Log all candidates for debugging
        for (const [i, c] of candidates.entries()) {
          const hasIndex = fsMod.existsSync(pathMod.default.join(c, 'index.html'));
          console.error(`[memorix] candidate[${i}]: ${c} (has index.html: ${hasIndex})`);
        }

        let staticDir = candidates[0];
        for (const c of candidates) {
          if (fsMod.existsSync(pathMod.default.join(c, 'index.html'))) {
            staticDir = c;
            break;
          }
        }
        console.error(`[memorix] Dashboard staticDir: ${staticDir}`);

        // Start in background (non-blocking), disable auto-open (we'll open it ourselves)
        startDashboard(ctx.projectDir, portNum, staticDir, ctx.project.id, ctx.project.name, false, ctx.project.rootPath, ctx.projectResolved)
          .then(() => { dashboardRunning = true; })
          .catch((err) => { console.error('[memorix] Dashboard error:', err); dashboardRunning = false; });

        // Poll until the server is actually listening (up to 5s)
        const { createConnection } = await import('node:net');
        await new Promise<void>(resolve => {
          const deadline = Date.now() + 5000;
          const tryConnect = () => {
            const sock = createConnection(portNum, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(); });
            sock.once('error', () => {
              sock.destroy();
              if (Date.now() < deadline) setTimeout(tryConnect, 100);
              else resolve(); // give up, return anyway
            });
          };
          tryConnect();
        });
        dashboardRunning = true;

        // Open browser from MCP side
        const { exec: execCmd } = await import('node:child_process');
        const openCmd =
          process.platform === 'win32' ? `start "" "${url}"` :
            process.platform === 'darwin' ? `open "${url}"` :
              `xdg-open "${url}"`;
        execCmd(openCmd, { windowsHide: true }, () => { });

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Memorix Dashboard started!`,
              ``,
              `URL: ${url}`,
              `Project: ${ctx.project.name} (${ctx.project.id})`,
              `Static: ${staticDir}`,
              ``,
              `The dashboard has been opened in your default browser.`,
              `It shows your knowledge graph, observations, retention scores, and project stats.`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to start dashboard: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
