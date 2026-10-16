// @perf-budget-skip: intentional generated-artifact freshness subprocess gate.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('generated profile types freshness', () => {
  it('matches the current profile capture schema', () => {
    const result = spawnSync(process.execPath, ['scripts/generate-profile-types.mjs', '--check'], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
