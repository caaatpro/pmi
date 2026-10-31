import { describe, expect, it } from 'vitest';

import { getCliVersion } from '../../src/cli/version.js';

describe('CLI version wiring', () => {
  it('returns a valid semver string', () => {
    expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
