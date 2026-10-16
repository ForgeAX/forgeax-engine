import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseObservedFrameReceipt } from '../../../../scripts/ci/run-dawn-smoke-roster.mjs';

const helper = new URL('../smoke-receipt.mjs', import.meta.url).href;
const run = (count, frames) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { emitSmokeReceipt } from ${JSON.stringify(helper)}; emitSmokeReceipt('test/smoke', ${count});`,
], { encoding: 'utf8', cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
  env: { ...process.env, SMOKE_MIN_FRAMES: frames } });

test('reports 60 and 77 observed frames through the canonical parser', () => {
  for (const count of [60, 77]) {
    const result = run(count);
    assert.equal(result.status, 0, result.stderr);
    const receipt = parseObservedFrameReceipt(result.stdout, { gateId: 'test/smoke', commandId: 'smoke' });
    assert.equal(receipt.framesObserved, count);
    assert.equal(receipt.completed, true);
  }
});

test('short focused runs succeed without a roster admission receipt', () => {
  for (const count of [12, 59]) {
    const result = run(count);
    assert.equal(result.status, 0, count);
    assert.equal(result.stdout, '', count);
    assert.match(result.stderr, /short focused run/);
    assert.match(result.stderr, /canonical roster admission requires >=60 frames/);
  }
});

test('non-positive, non-integer, and non-finite counts are rejected before parsing', () => {
  for (const count of ['0', '300.5', 'NaN', 'Infinity']) {
    const result = run(count);
    assert.notEqual(result.status, 0, count);
    assert.equal(result.stdout, '', count);
    assert.match(result.stderr, /framesObserved must be a positive integer/);
  }
});

test('explicit request is enforced at the producer, without replacing observed frames', () => {
  for (const count of [60, 299]) {
    const result = run(count, '300');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /below requested smoke frame budget 300/);
  }
  const result = run(301, '300');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseObservedFrameReceipt(result.stdout,
    { gateId: 'test/smoke', commandId: 'smoke', frames: 300 }).framesObserved, 301);
  assert.notEqual(run(300, '300x').status, 0);
});
