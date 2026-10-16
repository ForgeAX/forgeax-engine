import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildProfileModel } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

// @perf-budget-skip: intentional public-entry subprocess smoke gate.
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = fileURLToPath(new URL('../../scripts/consume-smoke.mjs', import.meta.url));
const fixturePath = fileURLToPath(
  new URL('./fixtures/profile-capture/model-input.json', import.meta.url),
);

describe('consumer smoke', () => {
  it('consumes a fixture through the public package entry', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: packageRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);

    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    const model = buildProfileModel(fixture);
    expect(model.ok).toBe(true);
    if (!model.ok) throw new Error(model.error.code);
    expect(output).toEqual({
      query: 'summary',
      ...model.value.summary,
      phases: model.value.phases,
    });
  });
});
