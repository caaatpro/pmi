import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '../..');
const dockerfilePath = join(repoRoot, 'Dockerfile');

describe('official Docker deployment artifacts', () => {
  it('ships a Dockerfile that starts the HTTP control plane', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toContain('serve-http');
    expect(dockerfile).toContain('0.0.0.0');
    expect(dockerfile).toContain('3211');
    expect(dockerfile).toMatch(/^USER\s+node\s*$/m);
  });

  it('installs dependencies from the root manifest only', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const dependencyStages = dockerfile.split(/^FROM node:22-bookworm-slim AS /m).slice(1, 3);

    expect(dependencyStages).toHaveLength(2);
    for (const stage of dependencyStages) {
      expect(stage).toContain('COPY package*.json ./');
      expect(stage).toContain('RUN npm ci');
      expect(stage).not.toContain('packages/');
    }
  });
});
