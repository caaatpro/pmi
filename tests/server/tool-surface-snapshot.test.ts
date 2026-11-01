import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createBatonServer } from '../../src/server.js';
import { resetResolvedConfigCache } from '../../src/config/resolved-config.js';
import { resetTomlConfigCache } from '../../src/config/toml-loader.js';
import { resetDb } from '../../src/store/orama-store.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { resetSessionStore } from '../../src/store/session-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

/**
 * Guards the MCP surface while src/server.ts is split into per-domain modules:
 * tool names, input field names, and which fields are optional must not change
 * by accident. Update the snapshot deliberately when a tool changes.
 */

const originalDataDir = process.env.BATON_DATA_DIR;
let dataDir = '';
let projectDir = '';

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-surface-data-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-surface-project-'));
  await fs.mkdir(path.join(projectDir, '.git'));
  process.env.BATON_DATA_DIR = dataDir;
  resetObservationStore();
  resetSessionStore();
  resetTomlConfigCache();
  resetResolvedConfigCache();
  await resetDb();
});

afterEach(async () => {
  closeAllDatabases();
  resetObservationStore();
  resetSessionStore();
  resetTomlConfigCache();
  resetResolvedConfigCache();
  await resetDb();
  if (originalDataDir === undefined) delete process.env.BATON_DATA_DIR;
  else process.env.BATON_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

function describeInput(schema: any): string[] {
  const shape = schema?.shape ?? schema?._def?.shape?.() ?? {};
  return Object.keys(shape).sort().map((field) => {
    const optional = typeof shape[field]?.isOptional === 'function' && shape[field].isOptional();
    return optional ? `${field}?` : field;
  });
}

describe('MCP tool surface', () => {
  it('keeps the full-profile tool names and input fields stable', async () => {
    const { server } = await createBatonServer(projectDir, undefined, undefined, { toolProfile: 'full' } as any);
    const tools = (server as any)._registeredTools as Record<string, { inputSchema?: unknown }>;
    const surface = Object.fromEntries(
      Object.keys(tools).sort().map((name) => [name, describeInput(tools[name].inputSchema)]),
    );
    expect(surface).toMatchSnapshot();
  }, 30_000);

  it('keeps each tool title, description, annotations and JSON schemas stable', async () => {
    const { server } = await createBatonServer(projectDir, undefined, undefined, { toolProfile: 'full' } as any);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'surface-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      // Registration order is not part of the contract; per-tool content is.
      expect([...tools].sort((a, b) => a.name.localeCompare(b.name))).toMatchSnapshot();
    } finally {
      await client.close();
      await server.close();
    }
  }, 30_000);
});
