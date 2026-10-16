import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/ci/resolve-vitest-workers.mjs');

function run(value) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, FORGEAX_VITEST_MAX_WORKERS: value },
    encoding: 'utf8',
  });
}

test('accepts a bounded worker override for natural-main A/B validation', () => {
  const result = run('5');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '5\n');
  assert.match(result.stderr, /maxWorkers=5/);
});

test('rejects an unsafe worker override', () => {
  const result = run('7');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an integer from 1 to 6/);
});
