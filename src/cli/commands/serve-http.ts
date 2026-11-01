/**
 * baton serve-http - Start MCP Server on Streamable HTTP transport (Control Plane mode)
 *
 * Starts the Baton Control Plane: a single HTTP server that provides:
 *   - MCP endpoint at /mcp (shared, multi-session access)
 *   - Health and protocol diagnostics at /health and /protocol-diagnostics
 *
 * The team web UI lives in baton-server (/ui/), not here.
 *
 * Usage:
 *   baton serve-http                    # default port 3211
 *   baton serve-http --port 3211        # custom port
 *   baton serve-http --cwd /path/to/project
 *
 * IDE config example (Claude Code):
 *   { "transport": "http", "url": "http://localhost:3211/mcp" }
 */

import { defineCommand } from 'citty';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { timingSafeEqual } from 'node:crypto';
import { resolveToolProfile } from '../../server/tool-profile.js';
import { CURRENT_MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, getMcpDiagnostics } from '../../server/mcp-diagnostics.js';
import { createMcpStartupDiscoverResult, getMcpServerInfo } from '../../server/mcp-discovery.js';
import { parseTcpPortOrReport } from '../port.js';
import { mcpFileUriToPath } from '../mcp-root-path.js';

/**
 * HTTP MCP is a shared control plane. A normal thinking break should not
 * silently invalidate a client session. Operators can choose a shorter GC
 * window, or set 0 to disable idle GC entirely.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const EXPIRED_SESSION_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const MAX_HTTP_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
export const MIN_HTTP_BODY_LIMIT_BYTES = 64 * 1024;
export const MAX_PROJECT_CACHE_ENTRIES = 256;
export const MAX_STORE_CACHE_ENTRIES = 32;
export const DEFAULT_MAX_HTTP_SESSIONS = 64;
export const MAX_HTTP_SESSIONS_LIMIT = 512;
/** Pinned SDK protocol accepted internally while the HTTP boundary speaks the current stateless contract. */
export const MCP_SDK_COMPAT_PROTOCOL_VERSION = '2025-11-25';

/** Modern discovery is allowed before a durable project handle exists. */
export function isServerDiscoverRequest(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && (body as { method?: unknown }).method === 'server/discover');
}

export function parseSessionTimeoutMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_SESSION_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SESSION_TIMEOUT_MS;
  return Math.floor(parsed);
}

export function parseHttpBodyLimit(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_HTTP_BODY_LIMIT_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_HTTP_BODY_LIMIT_BYTES) {
    return DEFAULT_HTTP_BODY_LIMIT_BYTES;
  }
  return Math.min(parsed, MAX_HTTP_BODY_LIMIT_BYTES);
}

export function parseMaxHttpSessions(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_HTTP_SESSIONS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_MAX_HTTP_SESSIONS;
  return Math.min(parsed, MAX_HTTP_SESSIONS_LIMIT);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function validateHttpBindSecurity(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): { requiresAuth: boolean; explicitlyUnauthenticated: boolean } {
  const hasToken = Boolean(env.BATON_HTTP_AUTH_TOKEN?.trim());
  const explicitlyUnauthenticated = env.BATON_HTTP_ALLOW_UNAUTHENTICATED_BIND === '1';
  if (!isLoopbackHost(host) && !hasToken && !explicitlyUnauthenticated) {
    throw new Error(
      `[baton] Refusing unauthenticated non-loopback HTTP bind on ${host}. `
      + 'Set BATON_HTTP_AUTH_TOKEN or explicitly set BATON_HTTP_ALLOW_UNAUTHENTICATED_BIND=1.',
    );
  }
  return { requiresAuth: hasToken, explicitlyUnauthenticated };
}

function isAuthorizedHttpRequest(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export class HttpPayloadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit.`);
    this.name = 'HttpPayloadTooLargeError';
  }
}

export function parseJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isSafeInteger(contentLength) && contentLength > limitBytes) {
      req.resume();
      reject(new HttpPayloadTooLargeError(limitBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        req.removeAllListeners('data');
        req.resume();
        fail(new HttpPayloadTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', fail);
  });
}

export interface ServeHttpConfiguredDefaults {
  port?: number;
  transport?: 'stdio' | 'http';
  dashboard?: boolean;
  dashboardPort?: number;
}

/**
 * The [server] config section is a real default source, not display-only:
 * `port` becomes the listener default and an explicit `transport: "stdio"`
 * produces a notice (an explicit serve-http command still wins). CLI flags
 * always beat config.
 */
export function resolveServeHttpDefaults(
  argsPort: string | undefined,
  configured: ServeHttpConfiguredDefaults,
): { port: number; transportNotice?: string } {
  const configuredPort = typeof configured.port === 'number' && Number.isFinite(configured.port)
    ? configured.port
    : undefined;
  const port = parseTcpPortOrReport(argsPort, configuredPort ?? 3211);
  if (port === undefined) {
    return { port: 3211 };
  }
  const transportNotice = configured.transport === 'stdio'
    ? '[baton] config server.transport = "stdio"; serve-http continues on HTTP (the explicit command wins).'
    : undefined;
  return { port, transportNotice };
}

export default defineCommand({
  meta: {
    name: 'serve-http',
    description: 'Start the shared Baton MCP control plane over HTTP',
  },
  args: {
    port: {
      type: 'string',
      description: 'HTTP port to listen on (default: 3211)',
      required: false,
    },
    host: {
      type: 'string',
      description: 'Host interface to bind (default: 127.0.0.1)',
      required: false,
    },
    cwd: {
      type: 'string',
      description: 'Project working directory (defaults to process.cwd())',
      required: false,
    },
    mode: {
      type: 'string',
      description: 'Tool profile to expose (micro, lite, team, full; default: team; coordination join remains explicit)',
      required: false,
    },
  },
  run: async ({ args }) => {
    const { createServer } = await import('node:http');
    const { randomUUID } = await import('node:crypto');
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const { isInitializeRequest } = await import(
      '@modelcontextprotocol/sdk/types.js'
    );
    const { createBatonServer } = await import('../../server.js');
    const { createProjectBindingController } = await import('../../server/request-context.js');
    const { findGitInSubdirs } = await import('../../project/detector.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    // Keep SQLite-backed control-plane helpers lazy. Besides reducing the
    // handshake import graph, this prevents agent integration tests that mock
    // node:fs from being evaluated before their mock factories initialize.
    const { McpBindingStore } = await import('../../server/mcp-binding-store.js');
    const { createModernMcpRuntime, ModernMcpRuntimePool, withBusinessRuntimeQueue } = await import('../../server/modern-mcp-bridge.js');
    const { acquireDatabase, evictIdleDatabases, getDatabaseStats } = await import('../../store/sqlite-db.js');
    const { createMcpHandler } = await import('@modelcontextprotocol/server');
    const { toNodeHandler } = await import('@modelcontextprotocol/node');

    // The [server] config section feeds startup defaults; CLI flags win.
    let configuredDefaults: ServeHttpConfiguredDefaults = {};
    try {
      const { getServerConfig } = await import('../../config.js');
      configuredDefaults = getServerConfig();
    } catch { /* config files are optional */ }
    const resolved = resolveServeHttpDefaults(args.port as string | undefined, configuredDefaults);
    if (resolved.transportNotice) console.error(resolved.transportNotice);
    const port = resolved.port;
    const host = args.host || '127.0.0.1';
    const bindSecurity = validateHttpBindSecurity(host);
    const httpAuthToken = process.env.BATON_HTTP_AUTH_TOKEN?.trim() || '';
    if (bindSecurity.explicitlyUnauthenticated && !isLoopbackHost(host)) {
      console.error(`[baton] WARNING: HTTP control plane is unauthenticated on ${host}; keep it behind a private network or authenticated proxy.`);
    }
    if (bindSecurity.requiresAuth) {
      console.error('[baton] HTTP control plane authentication is enabled (Bearer token).');
    }
    const toolProfile = resolveToolProfile({ explicit: args.mode, envValue: process.env.BATON_MODE, fallback: 'team' });

    // Priority: explicit --cwd arg > BATON_PROJECT_ROOT env > process.cwd().
    // $HOME is never a project root; inherit last-project-root instead of creating ~/baton.db.
    let safeCwd: string;
    try { safeCwd = process.cwd(); } catch { safeCwd = homedir(); }
    const { resolveServeProject } = await import('./serve-shared.js');
    const { writeLastProjectRoot } = await import('../../project/launch-root.js');
    const persistMod = await import('../../store/persistence.js');
    const detectorMod = await import('../../project/detector.js');
    const serveResolution = resolveServeProject(
      {
        cwdArg: args.cwd,
        envProjectRoot: process.env.BATON_PROJECT_ROOT,
        processCwd: safeCwd,
        homeDir: homedir(),
      },
      { detectProject: detectorMod.detectProject, findGitInSubdirs: detectorMod.findGitInSubdirs, isSystemDirectory: detectorMod.isSystemDirectory },
    );
    for (const message of serveResolution.messages) {
      console.error(message);
    }
    let projectRoot = serveResolution.projectRoot;
    if (serveResolution.detectedProject) {
      writeLastProjectRoot(serveResolution.detectedProject.rootPath);
    }

    console.error(`[baton] HTTP transport starting on ${host}:${port}`);
    console.error(`[baton] Project root: ${projectRoot}`);
    const sessionTimeoutMs = parseSessionTimeoutMs(process.env.BATON_SESSION_TIMEOUT_MS);
    const httpBodyLimitBytes = parseHttpBodyLimit(process.env.BATON_HTTP_MAX_BODY_BYTES);
    const maxHttpSessions = parseMaxHttpSessions(process.env.BATON_MAX_HTTP_SESSIONS);
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    console.error(
      sessionTimeoutMs === 0
        ? '[baton] HTTP session idle timeout: disabled'
        : `[baton] HTTP session idle timeout: ${Math.round(sessionTimeoutMs / 60000)}min (${sessionTimeoutMs}ms)`,
    );
    console.error(`[baton] HTTP session limit: ${maxHttpSessions}`);

    // TeamStore is resolved per MCP session/project. Sharing one mutable
    // singleton here made project A's coordination state visible to project B
    // after a roots switch. The cache still reuses the same project's SQLite
    // handle without crossing project data directories.
    const controlPlaneBaseDir = persistMod.getBaseDataDir();
    const controlPlaneBaseLease = acquireDatabase(controlPlaneBaseDir);
    const statelessBindingStore = new McpBindingStore();
    await statelessBindingStore.init(controlPlaneBaseDir);
    const modernRuntimePool = new ModernMcpRuntimePool(MAX_STORE_CACHE_ENTRIES);

    async function resolveModernDataDir(root: string, persisted?: { dataDir?: string }): Promise<string> {
      if (persisted?.dataDir) return persisted.dataDir;
      const detected = detectorMod.detectProject(root);
      return detected
        ? persistMod.getProjectDataDir(detected.id)
        : controlPlaneBaseDir;
    }

    // Modern MCP (2026-07-28) is stateless at the protocol layer. The official
    // v2 handler owns discovery, per-request envelopes, result metadata,
    // subscriptions, and version errors. Product tools are bridged to the
    // existing v1 implementation so business semantics stay in one place.
    const modernMcpHandler = createMcpHandler(async ({ requestInfo }) => {
      const handleId = requestInfo?.headers.get('mcp-project-handle') ?? undefined;
      const persisted = handleId ? statelessBindingStore.touch(handleId) : undefined;
      const requestedRoot = requestInfo?.headers.get('mcp-project-root') ?? undefined;
      const root = persisted?.projectRoot ?? requestedRoot ?? projectRoot;
      const dataDir = await resolveModernDataDir(root, persisted);
      const binding = persisted ?? (() => {
        const detected = detectorMod.detectProject(root);
        if (!detected) return undefined;
        const existing = statelessBindingStore.findByProjectRoot(detected.rootPath);
        return existing ? statelessBindingStore.touch(existing.handleId) ?? existing : undefined;
      })();
      const runtimeKey = JSON.stringify([dataDir, root]);
      // The SDK closes the per-request bridge after the response. The pool
      // decrements the runtime reference there; the business runtime remains
      // available for the next request for this project.
      return modernRuntimePool.createBridge(runtimeKey, () => withBusinessRuntimeQueue(async () => {
        const lease = acquireDatabase(dataDir);
        try {
          const runtime = await createModernMcpRuntime({
            projectRoot: root,
            bindingTransport: 'stateless-http',
            ...(binding
              ? {
                bindingHandle: {
                  handleId: binding.handleId,
                  createdAt: binding.createdAt,
                  lastUsedAt: binding.lastUsedAt,
                  ...(binding.expiresAt ? { expiresAt: binding.expiresAt } : {}),
                },
              }
              : {}),
            allowUntrackedFallback: false,
            deferProjectInitUntilBound: true,
            deferProjectRuntimeInit: true,
            dashboardMode: 'control-plane',
            dashboardPort: port,
            toolProfile,
          });
          const close = runtime.close.bind(runtime);
          return {
            ...runtime,
            close: async () => {
              try {
                await close();
              } finally {
                lease.release();
              }
            },
          };
        } catch (error) {
          lease.release();
          throw error;
        }
      }));
    }, {
      // Legacy requests are routed to the existing sessionful implementation
      // below; this handler is strict modern-only by construction.
      legacy: 'reject',
      responseMode: 'auto',
      onerror: error => {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        console.error(`[baton] modern MCP request failed: ${message}${stack ? `\n${stack}` : ''}`);
      },
    });
    const modernNodeHandler = toNodeHandler(modernMcpHandler);

    type SessionState = {
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      server: Awaited<ReturnType<typeof createBatonServer>>['server'];
      activateProjectRuntime: Awaited<ReturnType<typeof createBatonServer>>['activateProjectRuntime'];
      switchProject: Awaited<ReturnType<typeof createBatonServer>>['switchProject'];
      binding: import('../../server/request-context.js').ProjectBindingController;
      leases: Array<{ release: () => void }>;
    };

    // Session map: sessionId → transport + per-session server state
    const sessions = new Map<string, SessionState>();
    let pendingSessionInitializations = 0;

    // Session activity tracking (for GC timeout)
    const sessionLastActivity = new Map<string, number>();
    // Keep a short-lived tombstone so an expired client gets an actionable
    // reinitialize response instead of a generic bad request.
    const expiredSessions = new Map<string, number>();

    // Probe session noise reduction: defer init logs, suppress short-lived sessions
    let suppressedProbeCount = 0;
    let lastProbeSummaryTime = Date.now();
    const PROBE_SUMMARY_INTERVAL_MS = 60_000; // Log summary at most once per minute
    const SESSION_LOG_DELAY_MS = 5_000; // Only log sessions alive > 5 seconds
    const pendingLogTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function maybeProbeSummary() {
      if (suppressedProbeCount > 0 && Date.now() - lastProbeSummaryTime > PROBE_SUMMARY_INTERVAL_MS) {
        console.error(`[baton] ${suppressedProbeCount} probe connection(s) suppressed (short-lived / unresolved)`);
        suppressedProbeCount = 0;
        lastProbeSummaryTime = Date.now();
      }
    }

    function forgetExpiredSessions(now = Date.now()): void {
      for (const [sessionId, expiresAt] of expiredSessions) {
        if (expiresAt <= now) expiredSessions.delete(sessionId);
      }
    }

    function sendUnknownSession(res: ServerResponse, sessionId: string | undefined, jsonRpc = false): void {
      const expired = Boolean(sessionId && expiredSessions.has(sessionId));
      const message = expired
        ? 'MCP session expired after inactivity. Initialize a new session and retry the request.'
        : 'MCP session not found. Initialize a new session and retry the request.';
      if (jsonRpc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message },
          id: null,
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(message);
    }

    /**
     * Patch ServerResponse for MCP compatibility with strict HTTP clients (rmcp/reqwest).
     *
     * Fixes three Hono/Node.js response issues that cause "error decoding response body" in Codex:
     * 1. Empty 202 responses get Transfer-Encoding:chunked instead of Content-Length:0
     * 2. SSE responses (text/event-stream) get Content-Length when the stream completes
     *    quickly, which confuses SSE parsers expecting a streaming response.
     * 3. JSON responses with multi-byte UTF-8 (emoji) get wrong Content-Length because
     *    Hono's listener.js calculates it via value.length (character count) instead of
     *    Buffer.byteLength (byte count). This makes rmcp/reqwest choke on search results.
     */
    function patchMcpResponse(res: ServerResponse): void {
      const origWriteHead = res.writeHead;
      const origWrite = res.write;
      const origEnd = res.end;

      // JSON buffering state — needed because the MCP transport pipes Response body
      // via write(chunk)+end(), and we must set byte-accurate Content-Length before
      // the first byte is sent (chunked encoding confuses rmcp/reqwest in Codex).
      let isJsonResponse = false;
      let deferredWriteHeadArgs: [number, ...any[]] | null = null;
      let bufferedChunks: Buffer[] = [];

      (res as any).writeHead = function (statusCode: number, ...rest: any[]): ServerResponse {
        // Locate headers object in overloaded writeHead(status, headers) or writeHead(status, msg, headers)
        let headers: Record<string, any> | undefined;
        for (let i = rest.length - 1; i >= 0; i--) {
          if (rest[i] && typeof rest[i] === 'object' && !Array.isArray(rest[i])) {
            headers = rest[i];
            break;
          }
        }

        // Fix 1: Empty-body responses (202/204) — set Content-Length: 0, remove chunked
        if (statusCode === 202 || statusCode === 204) {
          if (headers) {
            headers['content-length'] = '0';
            delete headers['transfer-encoding'];
          }
          this.setHeader('content-length', '0');
          this.removeHeader('transfer-encoding');
          return origWriteHead.apply(this, [statusCode, ...rest] as any);
        }

        // Fix 2: SSE responses — must NOT have Content-Length (forces chunked streaming)
        const ct = headers?.['content-type'] ?? headers?.['Content-Type'] ?? this.getHeader('content-type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) {
          if (headers) {
            delete headers['content-length'];
            delete headers['Content-Length'];
          }
          this.removeHeader('content-length');
          return origWriteHead.apply(this, [statusCode, ...rest] as any);
        }

        // Fix 3: JSON responses — defer writeHead AND buffer body via write().
        // The MCP transport pipes the Web Response body as write(chunk)+end().
        // Without buffering, chunked Transfer-Encoding is used (no Content-Length),
        // which rmcp/reqwest fails to decode. We accumulate chunks and flush
        // everything atomically in end() with byte-accurate Content-Length.
        if (typeof ct === 'string' && ct.includes('application/json')) {
          isJsonResponse = true;
          deferredWriteHeadArgs = [statusCode, ...rest];
          return this; // defer — flushed in end()
        }

        return origWriteHead.apply(this, [statusCode, ...rest] as any);
      };

      // Buffer write() calls for JSON responses
      (res as any).write = function (chunk: any, ...args: any[]): boolean {
        if (isJsonResponse) {
          if (chunk != null) {
            bufferedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          // Call the callback if provided (write(chunk, encoding, cb) or write(chunk, cb))
          const cb = args.length > 0 ? args[args.length - 1] : undefined;
          if (typeof cb === 'function') cb();
          return true;
        }
        return origWrite.apply(this, [chunk, ...args] as any);
      };

      // Flush buffered JSON body with correct Content-Length
      (res as any).end = function (chunk?: any, ...args: any[]): ServerResponse {
        if (isJsonResponse && deferredWriteHeadArgs) {
          // Collect final chunk
          if (chunk != null && typeof chunk !== 'function') {
            bufferedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const body = Buffer.concat(bufferedChunks);

          // Set byte-accurate Content-Length in writeHead headers
          const [status, ...whRest] = deferredWriteHeadArgs;
          for (let i = whRest.length - 1; i >= 0; i--) {
            if (whRest[i] && typeof whRest[i] === 'object' && !Array.isArray(whRest[i])) {
              whRest[i]['content-length'] = String(body.length);
              delete whRest[i]['Content-Length'];
              delete whRest[i]['transfer-encoding'];
              break;
            }
          }
          this.setHeader('content-length', String(body.length));
          this.removeHeader('transfer-encoding');

          // Flush atomically: writeHead then end(body)
          origWriteHead.apply(this, [status, ...whRest] as any);
          deferredWriteHeadArgs = null;
          bufferedChunks = [];

          // Resolve the callback from end() args
          const cb = args.length > 0 ? args[args.length - 1] : undefined;
          return origEnd.call(this, body, typeof cb === 'function' ? cb : undefined);
        }

        // Non-JSON: pass through
        if (deferredWriteHeadArgs) {
          origWriteHead.apply(this, deferredWriteHeadArgs as any);
          deferredWriteHeadArgs = null;
        }
        return origEnd.apply(this, [chunk, ...args] as any);
      };
    }

    /**
     * Allowed CORS origins — only localhost variants.
     * Non-browser MCP clients (rmcp, Windsurf, curl) typically send no Origin
     * header at all, so they bypass CORS entirely (browser-only mechanism).
     */
    const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

    function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
      const origin = req.headers['origin'];
      if (origin && ALLOWED_ORIGIN_RE.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      // No Access-Control-Allow-Origin at all for disallowed origins —
      // browser will block the response (fail-closed).
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Project-Handle, Mcp-Project-Root, Mcp-Stateless, Last-Event-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Project-Handle, Mcp-Protocol-Version, Mcp-Method, Mcp-Name');
      res.setHeader('Mcp-Protocol-Version', MCP_SDK_COMPAT_PROTOCOL_VERSION);
      res.setHeader('Mcp-Method', req.method || 'UNKNOWN');
      res.setHeader('Mcp-Name', MCP_SERVER_NAME);
    }

    /**
     * Handle POST /mcp — JSON-RPC requests from agents
     */
    async function handlePost(req: IncomingMessage, res: ServerResponse) {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = await parseJsonBody(req, httpBodyLimitBytes);

      // Keep the pre-2026 startup probe compatible. Older MCP clients sent a
      // claim-less server/discover before initialize and expect a plain JSON
      // response; modern requests carry the _meta envelope and go to v2.
      const params = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { params?: unknown }).params
        : undefined;
      const claimlessDiscovery = !sessionId
        && isServerDiscoverRequest(body)
        && !req.headers['mcp-protocol-version']
        && !req.headers['mcp-method']
        && req.headers['mcp-stateless'] !== 'true'
        && (params === undefined
          || (typeof params === 'object' && params !== null && !Array.isArray(params)
            && !Object.prototype.hasOwnProperty.call(params, '_meta')));
      if (claimlessDiscovery) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: (body as { id?: string | number | null }).id ?? null,
          result: createMcpStartupDiscoverResult(getMcpServerInfo()),
        }));
        return;
      }

      const requestedProtocol = req.headers['mcp-protocol-version'];
      const statelessRequested = req.headers['mcp-stateless'] === 'true'
        || requestedProtocol === CURRENT_MCP_PROTOCOL_VERSION
        || typeof req.headers['mcp-project-handle'] === 'string'
        || isServerDiscoverRequest(body);
      if (!sessionId && statelessRequested) {
        const handleId = typeof req.headers['mcp-project-handle'] === 'string'
          ? req.headers['mcp-project-handle']
          : undefined;
        if (handleId && !statelessBindingStore.touch(handleId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'MCP project handle not found or expired; retry modern discovery with Mcp-Project-Root.' },
            id: null,
          }));
          return;
        }
        // Modern MCP has no protocol handshake or session id. Baton may
        // offer its own optional project handle so a client can stop sending
        // an absolute root on every request. The handle is issued only for a
        // verified Git project and remains a transport-neutral extension.
        if (!handleId) {
          const requestedRoot = typeof req.headers['mcp-project-root'] === 'string'
            ? req.headers['mcp-project-root']
            : projectRoot;
          const detected = detectorMod.detectProject(requestedRoot);
          if (detected) {
            const bindingDataDir = await persistMod.getProjectDataDir(detected.id);
            const binding = statelessBindingStore.findByProjectRoot(detected.rootPath)
              ?? statelessBindingStore.create({
                projectId: detected.id,
                projectRoot: detected.rootPath,
                dataDir: bindingDataDir,
              });
            res.setHeader('Mcp-Project-Handle', binding.handleId);
          }
        }
        await modernNodeHandler(req, res, body);
        return;
      }

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to its transport
        sessionLastActivity.set(sessionId, Date.now());
        patchMcpResponse(res);
        const session = sessions.get(sessionId)!;
        await withBusinessRuntimeQueue(async () => {
          await session.activateProjectRuntime();
          await session.transport.handleRequest(req, res, body);
        });
        return;
      }

      if (sessionId) {
        sendUnknownSession(res, sessionId, true);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        if (sessions.size + pendingSessionInitializations >= maxHttpSessions) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32029, message: `HTTP session limit reached (${maxHttpSessions}). Retry after an existing session closes.` },
            id: (body as { id?: string | number | null }).id ?? null,
          }));
          return;
        }
        pendingSessionInitializations++;
        let pendingReservationReleased = false;
        const releasePendingReservation = () => {
          if (pendingReservationReleased) return;
          pendingReservationReleased = true;
          pendingSessionInitializations = Math.max(0, pendingSessionInitializations - 1);
        };

        // New session — create transport + server
        let createdState: SessionState | null = null;
        const sessionLeases: Array<{ release: () => void }> = [acquireDatabase(defaultDataDir)];
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => {
            releasePendingReservation();
            if (createdState) sessions.set(sid, createdState);
            sessionLastActivity.set(sid, Date.now());
            // Defer log — only emit if session survives past SESSION_LOG_DELAY_MS
            const timer = setTimeout(() => {
              pendingLogTimers.delete(sid);
              console.error(`[baton] HTTP session active: ${sid.slice(0, 8)}…`);
            }, SESSION_LOG_DELAY_MS);
            pendingLogTimers.set(sid, timer);
          },
        });

        transport.onclose = () => {
          releasePendingReservation();
          const sid = transport.sessionId;
          if (sid) {
            // If the deferred init log hasn't fired yet, this was a short-lived probe
            const pending = pendingLogTimers.get(sid);
            if (pending) {
              clearTimeout(pending);
              pendingLogTimers.delete(sid);
              suppressedProbeCount++;
              maybeProbeSummary();
            } else if (sessions.has(sid)) {
              console.error(`[baton] HTTP session closed: ${sid.slice(0, 8)}…`);
            }
            sessions.delete(sid);
            sessionLastActivity.delete(sid);
          }
          handleTransportClose();
          for (const lease of sessionLeases) lease.release();
          evictIdleDatabases(MAX_STORE_CACHE_ENTRIES);
        };

        // Legacy Mcp-Session-Id only routes requests. Project ownership lives
        // in this transport-neutral binding object, ready for stateless MCP.
        const binding = createProjectBindingController(projectRoot);
        // Create a fresh MCP server for this session (with shared team state)
        let server: Awaited<ReturnType<typeof createBatonServer>>['server'];
        let activateProjectRuntime: Awaited<ReturnType<typeof createBatonServer>>['activateProjectRuntime'];
        let handleTransportClose: Awaited<ReturnType<typeof createBatonServer>>['handleTransportClose'];
        let getProjectDataDirForSession: Awaited<ReturnType<typeof createBatonServer>>['getProjectDataDir'];
        let switchProject: Awaited<ReturnType<typeof createBatonServer>>['switchProject'];
        try {
          ({ server, activateProjectRuntime, switchProject, handleTransportClose, getProjectDataDir: getProjectDataDirForSession } = await createBatonServer(
            projectRoot,
            undefined,
            undefined,
            {
              allowUntrackedFallback: false,
              deferProjectInitUntilBound: true,
              // Same as stdio: initialize/tools/list must not hydrate 40k+
              // observations on the HTTP thread. /health and the LaunchAgent
              // watchdog die if createBatonServer blocks here.
              deferProjectRuntimeInit: true,
              dashboardMode: 'control-plane',
              dashboardPort: port,
              toolProfile,
              bindingTransport: 'legacy-http',
              projectBinding: binding,
            },
          ));
        } catch (error) {
          releasePendingReservation();
          for (const lease of sessionLeases) lease.release();
          throw error;
        }
        const switchProjectWithLease = async (newCwd: string, source?: import('../../server/request-context.js').ProjectBindingSource): Promise<boolean> => {
          const before = getProjectDataDirForSession();
          const changed = await switchProject(newCwd, source);
          const after = getProjectDataDirForSession();
          if (changed && after !== before) {
            sessionLeases[0].release();
            sessionLeases[0] = acquireDatabase(after);
          }
          return changed;
        };
        createdState = { transport, server, activateProjectRuntime, switchProject: switchProjectWithLease, binding, leases: sessionLeases };
        await server.connect(transport);

        const tryRootsSwitch = async () => {
          try {
            // If session was explicitly bound via projectRoot in baton_session_start,
            // do NOT allow roots notifications to override the binding.
            if (binding.isExplicit()) {
              console.error(`[baton] Session ${transport.sessionId?.slice(0, 8) ?? 'pending'} roots switch skipped: session was explicitly bound via projectRoot`);
              return;
            }
            const { roots } = await server.server.listRoots();
            if (!roots || roots.length === 0) return;

            for (const root of roots) {
              if (!root.uri.startsWith('file://')) continue;
              const rootPath = mcpFileUriToPath(root.uri);
              if (!rootPath) continue;

              const switched = await switchProject(rootPath);
              if (switched) {
                console.error(`[baton] Session ${transport.sessionId?.slice(0, 8) ?? 'pending'} roots switched to: ${rootPath}`);
                return;
              }

              const subGit = findGitInSubdirs(rootPath);
              if (subGit) {
                const subSwitched = await switchProject(subGit);
                if (subSwitched) {
                  console.error(`[baton] Session ${transport.sessionId?.slice(0, 8) ?? 'pending'} roots switched via subdir: ${subGit}`);
                  return;
                }
              }
            }
          } catch {
            // Client doesn't support roots — keep startup project context.
          }
        };

        try {
          const { RootsListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
          server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
            await tryRootsSwitch();
          });
        } catch { /* optional */ }

        patchMcpResponse(res);
        try {
          await withBusinessRuntimeQueue(async () => {
            await activateProjectRuntime();
            await transport.handleRequest(req, res, body);
          });
        } finally {
          // A malformed probe can finish without creating a session; do not
          // let it consume an admission slot forever.
          if (!transport.sessionId) releasePendingReservation();
        }
        // Do NOT proactively call listRoots() after session establishment —
        // this violates MCP SEP-2260 (server-initiated request must be associated
        // with a client request). Codex and other strict clients treat standalone
        // roots/list as unexpected, which can break MCP tool injection.
        // Project binding relies on:
        //   1. RootsListChangedNotification (client-initiated, then we respond)
        //   2. baton_session_start({ projectRoot }) for explicit binding
        //   3. cwd-based detection as fallback (deferred-binding mode)
        return;
      }

      // Invalid request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided or initialize request required' },
        id: null,
      }));
    }

    /**
     * Handle GET /mcp — SSE stream for server-initiated messages
     */
    async function handleGet(req: IncomingMessage, res: ServerResponse) {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing MCP session ID');
          return;
        }
        sendUnknownSession(res, sessionId);
        return;
      }

      // GET may keep an SSE stream open; it does not enter the business tool
      // layer and must not occupy the singleton runtime gate.
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    }

    /**
     * Handle DELETE /mcp — Session termination
     */
    async function handleDelete(req: IncomingMessage, res: ServerResponse) {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing MCP session ID');
          return;
        }
        sendUnknownSession(res, sessionId);
        return;
      }

      await withBusinessRuntimeQueue(() => sessions.get(sessionId)!.transport.handleRequest(req, res));
    }

    // Create HTTP server
    // Default project for /health and the control-plane maintenance worker
    const { detectProject } = await import('../../project/detector.js');
    const { getProjectDataDir } = await import('../../store/persistence.js');
    const pathModule = await import('node:path');

    const detectedDashboardProject = detectProject(projectRoot);
    const defaultProject = detectedDashboardProject ?? {
      id: '__unresolved__',
      name: pathModule.default.basename(projectRoot),
      rootPath: projectRoot,
    };
    const defaultDataDir = await getProjectDataDir(defaultProject.id);
    const dashboardBinding = createProjectBindingController(defaultProject.rootPath);
    if (defaultProject.id !== '__unresolved__') {
      dashboardBinding.recordResolvedProject(defaultProject.id, defaultProject.rootPath);
    }
    const dashboardBindingReceipt = dashboardBinding.receipt({
      dataDir: defaultDataDir,
      transport: 'dashboard',
      gitRemote: defaultProject.gitRemote,
    });

    // HTTP sessions intentionally keep their own runtime globals. This worker
    // only claims jobs that can run in an isolated process; vector recovery
    // stays with the owning MCP session because Orama is process-local.
    const { createControlPlaneMaintenanceWorker } = await import('../../runtime/control-plane-maintenance.js');
    const controlPlaneMaintenanceWorker = createControlPlaneMaintenanceWorker(defaultDataDir, {
      pollIntervalMs: 2_000,
    });
    controlPlaneMaintenanceWorker.start();

    let httpReadyAt: string | null = null;
    const httpServer = createServer(async (req, res) => {
      setCorsHeaders(req, res);

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (bindSecurity.requiresAuth && url.pathname !== '/health' && !isAuthorizedHttpRequest(req, httpAuthToken)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      // Lightweight health check — responds immediately, no heavy init required.
      // This is the readiness signal for background start / status.
      if (url.pathname === '/health') {
        const { getEmbeddingRuntimeHealth } = await import('../../embedding/provider.js');
        const memory = process.memoryUsage();
        const heap = getHeapStatistics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mode: 'control-plane',
          profile: toolProfile,
          port,
          uptime: Math.round(process.uptime()),
          pid: process.pid,
          projectId: defaultProject?.id ?? '__unresolved__',
          projectName: defaultProject?.name ?? null,
          binding: dashboardBindingReceipt,
          readyAt: httpReadyAt,
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers,
            heapLimit: heap.heap_size_limit,
          },
          sqlite: getDatabaseStats(),
          sessions: {
            active: sessions.size,
            pending: pendingSessionInitializations,
            limit: maxHttpSessions,
          },
          modernRuntime: modernRuntimePool.stats(),
          eventLoop: {
            meanMs: Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1e6 : null,
            p95Ms: eventLoopDelay.percentile(95) / 1e6,
            maxMs: eventLoopDelay.max / 1e6,
          },
          embedding: getEmbeddingRuntimeHealth(),
        }));
        return;
      }

      if (url.pathname === '/protocol-diagnostics') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
        res.end(JSON.stringify(getMcpDiagnostics()));
        return;
      }

      // MCP endpoint
      if (url.pathname === '/mcp') {
        // Ensure Accept header includes both application/json and text/event-stream.
        // Some MCP clients (e.g. rmcp) omit text/event-stream, causing the SDK's
        // StreamableHTTPServerTransport to reject with 406 Not Acceptable.
        // Hono's node-server reads rawHeaders (not req.headers), so we must patch both.
        const accept = req.headers['accept'] || '';
        const needs: string[] = [];
        if (!accept.includes('application/json')) needs.push('application/json');
        if (!accept.includes('text/event-stream')) needs.push('text/event-stream');
        if (needs.length > 0) {
          const patched = accept ? `${accept}, ${needs.join(', ')}` : needs.join(', ');
          req.headers['accept'] = patched;
          // Patch rawHeaders array (Hono reads this for Web Standard Request conversion)
          let found = false;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === 'accept') {
              req.rawHeaders[i + 1] = patched;
              found = true;
              break;
            }
          }
          if (!found) {
            req.rawHeaders.push('Accept', patched);
          }
        }

        try {
          switch (req.method) {
            case 'POST':
              await handlePost(req, res);
              break;
            case 'GET':
              await handleGet(req, res);
              break;
            case 'DELETE':
              await handleDelete(req, res);
              break;
            default:
              res.writeHead(405, { 'Content-Type': 'text/plain' });
              res.end('Method not allowed');
          }
        } catch (err) {
          console.error('[baton] HTTP handler error:', err);
          if (!res.headersSent) {
            const status = err instanceof HttpPayloadTooLargeError ? err.statusCode : 500;
            const message = err instanceof Error ? err.message : 'Internal server error';
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: status === 413 ? -32013 : -32603,
                message: status === 413 ? message : 'Internal server error',
              },
              id: null,
            }));
          }
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    // MCP session continuity is independent from one TCP socket. Keep Node's
    // socket timeout above its 5s default while the session map remains the
    // actual continuity boundary.
    httpServer.keepAliveTimeout = 60_000;
    httpServer.headersTimeout = 65_000;

    const listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        if (typeof (httpServer as any).off === 'function') httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
      if (typeof (httpServer as any).off === 'function') httpServer.off('error', onError);
      httpReadyAt = new Date().toISOString();
      // Write readiness file — background start polls this for out-of-band readiness detection
      try {
        const batonDir = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/') + '/.baton';
        mkdirSync(batonDir, { recursive: true });
        writeFileSync(batonDir + '/background.ready', JSON.stringify({ pid: process.pid, port, readyAt: Date.now() }));
      } catch { /* best-effort — HTTP /health is the primary signal */ }

      console.error(`[baton] ═══════════════════════════════════════════════════`);
      console.error(`[baton] Mode: Control Plane (HTTP MCP, multi-session)`);
      console.error(`[baton] MCP Server listening on http://${host}:${port}/mcp`);
      console.error(`[baton] Port:          ${port}`);
      console.error(`[baton] ═══════════════════════════════════════════════════`);
      console.error(`[baton] Sessions at startup: ${sessions.size} (live count available at /health)`);
      console.error(`[baton] Agents can connect via: { "transport": "http", "url": "http://localhost:${port}/mcp" }`);
        resolve();
      };
      if (typeof (httpServer as any).once === 'function') {
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      } else {
        // Lightweight test doubles may only implement listen(callback).
        httpServer.listen(port, host, onListening);
      }
    });
    try {
      await listenPromise;
    } catch (error) {
      console.error(`[baton] HTTP server failed to listen on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
      controlPlaneBaseLease.release();
      await modernRuntimePool.close();
      eventLoopDelay.disable();
      const { closeAllDatabases } = await import('../../store/sqlite-db.js');
      closeAllDatabases();
      throw error;
    }

    // Session timeout GC — close sessions idle past the configured threshold.
    // BATON_SESSION_TIMEOUT_MS lets operators work around HTTP clients that do
    // not transparently reinitialize after stale session IDs (notably Codex/rmcp).
    const SESSION_TIMEOUT_MS = sessionTimeoutMs;
    const gcInterval = setInterval(() => {
      maybeProbeSummary(); // Flush suppressed probe count periodically
      const now = Date.now();
      forgetExpiredSessions(now);
      statelessBindingStore.cleanupExpired(now);
      evictIdleDatabases(MAX_STORE_CACHE_ENTRIES);
      void modernRuntimePool.evictIdle();
      if (SESSION_TIMEOUT_MS === 0) return;
      for (const [sid, state] of sessions) {
        const lastActive = sessionLastActivity.get(sid) ?? 0;
        if (now - lastActive > SESSION_TIMEOUT_MS) {
          console.error(`[baton] Session ${sid.slice(0, 8)}… timed out (idle ${Math.round((now - lastActive) / 60000)}min), closing`);
          expiredSessions.set(sid, now + EXPIRED_SESSION_TTL_MS);
          state.transport.close().catch(() => {});
          sessions.delete(sid);
          sessionLastActivity.delete(sid);
        }
      }
    }, 60_000); // Check every minute
    gcInterval.unref(); // Don't prevent process exit

    // Graceful shutdown
    let shutdownStarted = false;
    const shutdown = async () => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      if (suppressedProbeCount > 0) {
        console.error(`[baton] ${suppressedProbeCount} probe connection(s) suppressed during this session`);
      }
      console.error('[baton] Shutting down HTTP server...');
      controlPlaneMaintenanceWorker.stop();
      // Clean up readiness and heartbeat files
      try {
        const batonDir = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/') + '/.baton';
        const { unlinkSync } = await import('node:fs');
        try { unlinkSync(batonDir + '/background.ready'); } catch { /* ok */ }
        try { unlinkSync(batonDir + '/background.heartbeat'); } catch { /* ok */ }
      } catch { /* best-effort */ }
      for (const [sid, state] of sessions) {
        try {
          await state.transport.close();
          sessions.delete(sid);
        } catch (err) {
          console.error(`[baton] Error closing session ${sid}:`, err);
        }
      }
      await modernRuntimePool.close();
      clearInterval(gcInterval);
      clearInterval(heartbeatInterval);
      eventLoopDelay.disable();
      await new Promise<void>((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
      const { closeAllDatabases } = await import('../../store/sqlite-db.js');
      controlPlaneBaseLease.release();
      closeAllDatabases();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Prevent unhandled rejections / exceptions from killing the background process.
    // Without these, any unhandled promise rejection in Node.js v20+ terminates the process
    // silently — the background control plane disappears with no log trail.
    process.on('unhandledRejection', (reason) => {
      console.error('[baton] Unhandled rejection in control plane:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[baton] Uncaught exception in control plane:', err);
      // Do NOT exit — log and continue. The process is a long-running service.
      // Only exit on truly catastrophic errors (OOM, stack overflow) which Node handles itself.
    });

    // Self-health watchdog: write heartbeat every 30s so stale detection works
    // even if the process is alive but the HTTP server has hung.
    const _batonDir = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/') + '/.baton';
    const heartbeatFile = _batonDir + '/background.heartbeat';
    const heartbeatInterval = setInterval(() => {
      try {
        writeFileSync(heartbeatFile, JSON.stringify({
          pid: process.pid,
          port,
          uptime: Math.round(process.uptime()),
          heartbeatAt: Date.now(),
        }));
      } catch { /* best-effort */ }
    }, 30_000);
    heartbeatInterval.unref();
    // Write initial heartbeat immediately
    try {
      mkdirSync(_batonDir, { recursive: true });
      writeFileSync(heartbeatFile, JSON.stringify({
        pid: process.pid,
        port,
        uptime: Math.round(process.uptime()),
        heartbeatAt: Date.now(),
      }));
    } catch { /* best-effort */ }
  },
});

// ── Test helpers (exported for testing only) ──────────────────

/** @internal */
export const _testing = {
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  MAX_HTTP_BODY_LIMIT_BYTES,
  MIN_HTTP_BODY_LIMIT_BYTES,
  parseSessionTimeoutMs,
  parseMaxHttpSessions,
  parseHttpBodyLimit,
  isLoopbackHost,
  validateHttpBindSecurity,
  parseTcpPortOrReport,
};
