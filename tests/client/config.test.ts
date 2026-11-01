import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeServerUrl,
  readCredentials,
  readProjectLink,
  tokenFor,
  writeCredentials,
  writeProjectLink,
} from '../../src/client/config.js';
import { resolveSyncConfig } from '../../src/sync/remote-factory.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('client configuration', () => {
  it('normalizes server URLs and refuses plain HTTP to remote hosts', () => {
    expect(normalizeServerUrl('baton.example.com/')).toBe('https://baton.example.com');
    expect(normalizeServerUrl('https://example.com/baton/')).toBe('https://example.com/baton');
    expect(normalizeServerUrl('http://127.0.0.1:7420')).toBe('http://127.0.0.1:7420');
    expect(() => normalizeServerUrl('http://baton.example.com')).toThrow(/plain HTTP/);
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow(/scheme/);
  });

  it('stores tokens outside the repository with owner-only permissions', () => {
    root = mkdtempSync(path.join(tmpdir(), 'baton-client-'));
    const env = { BATON_HOME: path.join(root, 'home') } as NodeJS.ProcessEnv;
    writeCredentials({ default: 'https://a', servers: { 'https://a': { token: 'baton_pat_x', savedAt: 'now' } } }, env);
    expect(readCredentials(env).default).toBe('https://a');
    expect(tokenFor('https://a', env)).toBe('baton_pat_x');
    // An environment token only goes to the server BATON_SERVER names, never to one a cloned repository's link points at.
    expect(tokenFor('https://a', { ...env, BATON_TOKEN: 'baton_pat_env' })).toBe('baton_pat_x');
    expect(tokenFor('https://a', { ...env, BATON_TOKEN: 'baton_pat_env', BATON_SERVER: 'a' })).toBe('baton_pat_env');
    expect(tokenFor('https://evil.example', { ...env, BATON_TOKEN: 'baton_pat_env', BATON_SERVER: 'https://a' })).toBeUndefined();
    if (process.platform !== 'win32') {
      expect(statSync(path.join(root, 'home', 'credentials.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('reads the project link and makes it the default sync provider', () => {
    root = mkdtempSync(path.join(tmpdir(), 'baton-client-'));
    expect(readProjectLink(root)).toBeUndefined();
    const link = { server: 'https://a', projectId: '00000000-0000-0000-0000-000000000001', slug: 'app', legacyProjectId: 'acme/app', linkedAt: 'now' };
    writeProjectLink(root, link);
    expect(readProjectLink(root)).toEqual(link);
    expect(resolveSyncConfig({}, link)).toEqual({ enabled: true, provider: 'baton' });
    expect(resolveSyncConfig({ BATON_SYNC_PROVIDER: 'fs' }, link)).toEqual({ enabled: true, provider: 'fs' });
    expect(resolveSyncConfig({})).toEqual({ enabled: false });
  });
});
