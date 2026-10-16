import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { importMetricsEvidence, stageMetricsEvidence } from '../metrics-evidence.mjs';

const identity = { runId: '42', runAttempt: '3', headSha: 'a'.repeat(40) };
const files = ['report/pixel-parity.json', 'report/pixel-parity-standard-lanes.json'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'metrics-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [...files, 'report/unowned.json']) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ file }));
  }
  const input = join(root, 'transfer');
  const output = join(root, 'consumer');
  return { root, input, output };
}

test('transfers the complete Browser inventory once without copying unrelated reports', (t) => {
  const { root, input, output } = fixture(t);
  const staged = stageMetricsEvidence({ root, output: input, ...identity });
  assert.equal(staged.producer, 'browser');
  assert.equal(staged.headSha, identity.headSha);
  assert.equal(existsSync(join(input, 'report/unowned.json')), false);
  assert.deepEqual(importMetricsEvidence({ input, output, ...identity }), staged);
  for (const file of files)
    assert.equal(readFileSync(join(output, file), 'utf8'), readFileSync(join(root, file), 'utf8'));
  assert.throws(() => importMetricsEvidence({ input, output, ...identity }), /collision/);
});

test('rejects foreign identity, future attempts and incomplete reports before importing any file', (t) => {
  const { root, input, output } = fixture(t);
  stageMetricsEvidence({ root, output: input, ...identity });
  for (const overrides of [{ runId: '43' }, { headSha: 'b'.repeat(40) }, { runAttempt: '4' }]) {
    const original = JSON.parse(readFileSync(join(input, 'manifest.json')));
    writeFileSync(join(input, 'manifest.json'), JSON.stringify({ ...original, ...overrides }));
    assert.throws(
      () => importMetricsEvidence({ input, output, ...identity, allowEarlierAttempt: true }),
      /mismatch/,
    );
    assert.equal(existsSync(output), false);
    writeFileSync(join(input, 'manifest.json'), JSON.stringify(original));
  }
  rmSync(join(input, files[1]));
  assert.throws(() => importMetricsEvidence({ input, output, ...identity }), /missing/);
  assert.equal(existsSync(output), false);
});

test('failed-job reruns may admit a complete earlier attempt from the same source and run', (t) => {
  const { root, input, output } = fixture(t);
  stageMetricsEvidence({ root, output: input, ...identity, runAttempt: '1' });
  assert.throws(() => importMetricsEvidence({ input, output, ...identity }), /runAttempt mismatch/);
  assert.equal(
    importMetricsEvidence({ input, output, ...identity, allowEarlierAttempt: true }).runAttempt,
    '1',
  );
});

test('imports only source-owned paths even if presentPaths claims an unrelated file', (t) => {
  const { root, input, output } = fixture(t);
  const staged = stageMetricsEvidence({ root, output: input, ...identity });
  writeFileSync(
    join(input, 'manifest.json'),
    JSON.stringify({ ...staged, presentPaths: ['../report/unowned.json'] }),
  );
  importMetricsEvidence({ input, output, ...identity });
  assert.equal(existsSync(join(output, 'report/unowned.json')), false);
  assert.equal(existsSync(join(output, files[0])), true);
});
