import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalizeDawnPartitionReports } from '../run-dawn-partitions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dawn-evidence-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, 'forgeax-dawn-partitions-owner');
  mkdirSync(temporary);
  return { root, temporary };
}

test('retains failed and completed partition bytes before reclaiming the owner directory', (t) => {
  const { root, temporary } = fixture(t);
  const failed = '{"success":false,"message":"Test timed out in 120000ms."}\n';
  const passed = '{"success":true,"numPassedTests":3}\n';
  writeFileSync(join(temporary, '0.json'), failed);
  writeFileSync(join(temporary, '1.json'), passed);
  const evidence = join(root, 'evidence');
  finalizeDawnPartitionReports(temporary, evidence);
  assert.equal(readFileSync(join(evidence, basename(temporary), '0.json'), 'utf8'), failed);
  assert.equal(readFileSync(join(evidence, basename(temporary), '1.json'), 'utf8'), passed);
  assert.equal(existsSync(temporary), false);
});

test('default finalization reclaims only its temporary owner', (t) => {
  const { root, temporary } = fixture(t);
  const sibling = join(root, 'other-owner.json');
  writeFileSync(sibling, 'untouched');
  finalizeDawnPartitionReports(temporary);
  assert.equal(existsSync(temporary), false);
  assert.equal(readFileSync(sibling, 'utf8'), 'untouched');
});

test('a conflicting evidence destination preserves the original failure report', (t) => {
  const { root, temporary } = fixture(t);
  writeFileSync(join(temporary, '0.json'), 'original failure');
  const evidence = join(root, 'evidence');
  mkdirSync(join(evidence, basename(temporary)), { recursive: true });
  writeFileSync(join(evidence, basename(temporary), '0.json'), 'previous receipt');
  assert.throws(() => finalizeDawnPartitionReports(temporary, evidence));
  assert.equal(readFileSync(join(temporary, '0.json'), 'utf8'), 'original failure');
  assert.equal(
    readFileSync(join(evidence, basename(temporary), '0.json'), 'utf8'),
    'previous receipt',
  );
});

test('rejects checkout and relative evidence paths before removing raw reports', (t) => {
  const { temporary } = fixture(t);
  const checkout = fileURLToPath(new URL('../../..', import.meta.url));
  for (const evidence of ['relative-evidence', checkout, join(checkout, '.tmp')])
    assert.throws(() => finalizeDawnPartitionReports(temporary, evidence), /outside the checkout/);
  assert.equal(existsSync(temporary), true);
});
