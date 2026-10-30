import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

describe('release contract', () => {
  it('publishes only the supported root package', async () => {
    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf-8');
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).not.toContain('npm publish --access public --ignore-scripts');
    expect(workflow).toContain('npm audit signatures');
    expect(workflow).toContain('npm view "memorix@$version" version');
    expect(workflow).toContain('expected_ref="refs/tags/v${version}"');
    expect(workflow).toContain('Wait for npm package visibility');
    expect(workflow).toContain('actions/checkout@v7');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).not.toContain('npm publish --workspace @memorix/');
  });

  it('does not mutate release metadata during npm publish', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts?: { prepublishOnly?: string };
    };
    expect(packageJson.scripts?.prepublishOnly).toBe(
      'npm run check:mcp-registry && npm run check:plugin-release && npm audit signatures && npm run build && npm test',
    );
    expect(packageJson.scripts?.prepublishOnly).not.toContain('sync:mcp-registry');
    expect(packageJson.scripts?.prepublishOnly).not.toContain('sync:plugin-release');
  });

  it('keeps star metrics outside the release PR workflow', async () => {
    await expect(readFile(path.join(repoRoot, '.github', 'workflows', 'star-history.yml'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
