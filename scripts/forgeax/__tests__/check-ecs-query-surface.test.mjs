import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'check-ecs-query-surface.mjs');
const fixtures = resolve(here, '..', '__fixtures__', 'ecs-query-surface');

function run(name) {
  return spawnSync(process.execPath, [script, '--root', resolve(fixtures, name)], {
    encoding: 'utf8',
  });
}

describe('ECS query surface census', () => {
  it('accepts the final row iterator surface', () => {
    const result = run('clean');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('rejects a removed query symbol with a stable failure code', () => {
    const result = run('stale');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ECS_QUERY_SURFACE_STALE');
  });
});
