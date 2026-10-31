/**
 * Web UI of the central server (docs/PMI/WEB_UI.md): the React app built by
 * `npm run build:ui` into dist/server/central/ui, served under /ui/. It reads
 * the same /v1 API with the user's personal access token. All files are read
 * once at start into a map, so no request path reaches the file system. The
 * page sends the token as a Bearer header (no cookies, so no CSRF) and runs
 * under a CSP that allows only its own script and style, plus the one style
 * element Mantine creates, which carries a per-request nonce.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const NONCE_PLACEHOLDER = '__CSP_NONCE__';

export const UI_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

export interface WebUi {
  dir: string;
  files: Map<string, { type: string; body: Buffer }>;
}

/**
 * Where the built UI is: next to the server bundle (dist/server/central/ui),
 * or, when the server runs from source (tests), in dist/ of the repository.
 */
export function defaultUiDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'ui'), path.resolve(here, '..', '..', '..', 'dist', 'server', 'central', 'ui')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

export function loadUi(dir: string): WebUi {
  const files = new Map<string, { type: string; body: Buffer }>();
  const walk = (relative: string) => {
    for (const name of readdirSync(path.join(dir, relative))) {
      const rel = relative ? `${relative}/${name}` : name;
      const full = path.join(dir, rel);
      if (statSync(full).isDirectory()) walk(rel);
      else if (TYPES[path.extname(name)]) files.set(rel, { type: TYPES[path.extname(name)], body: readFileSync(full) });
    }
  };
  walk('');
  if (!files.has('index.html')) throw new Error(`the web UI in ${dir} has no index.html; run npm run build:ui`);
  return { dir, files };
}

/** Answer a UI request; false when the path is not the UI's. */
export function serveUi(ui: WebUi | undefined, req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname === '/' || pathname === '/ui') {
    if (!ui) return false;
    res.writeHead(302, { location: '/ui/', ...UI_HEADERS });
    res.end();
    return true;
  }
  if (!pathname.startsWith('/ui/')) return false;
  const name = pathname === '/ui/' ? 'index.html' : pathname.slice('/ui/'.length);
  const file = ui?.files.get(name);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...UI_HEADERS });
    res.end(ui ? 'not found' : 'the web UI is not installed on this server');
    return true;
  }
  const nonce = randomBytes(16).toString('base64');
  const body = name === 'index.html' ? Buffer.from(file.body.toString('utf8').replaceAll(NONCE_PLACEHOLDER, nonce)) : file.body;
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': body.length,
    'content-security-policy': contentSecurityPolicy(nonce),
    // Assets have content hashes in their names; the page itself must always be fresh.
    'cache-control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...UI_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
