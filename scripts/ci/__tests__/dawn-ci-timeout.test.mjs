import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { planDawnShards } from '../../../config/vitest-dawn-sequencer.ts';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../dawn-gate-roster.mjs';

const root = process.cwd();
const historicalRuns = [
  42726632891, 42746576077, 42778322662, 42786967820, 42797940249, 42835598738, 42929802533,
];
function readReceipt(run) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/dawn-completed-${run}.json`, import.meta.url)),
  );
}

const firstReceipt = readReceipt(historicalRuns[0]);
const historicalFiles = Object.keys({
  ...firstReceipt.reservedFiles,
  ...firstReceipt.files,
}).sort();
function planRecordedFiles(files) {
  return planDawnShards(
    files.map((file) => ({ moduleId: resolve(root, file) })),
    root,
    2,
  );
}

function assertReplay(receipt, files, planned, t) {
  const costs = { ...receipt.reservedFiles, ...receipt.files };
  assert.deepEqual(Object.keys(costs).sort(), files);
  assert.deepEqual(
    planned
      .flat()
      .map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/'))
      .sort(),
    files,
  );
  assert.equal(
    Object.keys(receipt.files).length,
    receipt.ordinaryReceipts.reduce((count, row) => count + row.fileCount, 0),
  );
  const measured = Object.values(receipt.files).reduce((a, b) => a + b, 0);
  const workerCount = receipt.executionPolicy?.ordinaryWorkers ?? 1;
  assert.ok(
    Math.abs(
      measured -
        workerCount * receipt.ordinaryReceipts.reduce((a, b) => a + b.processWallSeconds, 0),
    ) < 0.001,
  );
  const finishes = planned.map(
    (partition, lane) =>
      // Retain raw serial work. Forecast its two-slot execution, including
      // the longest-file list-scheduling tail and sixty-second startup reserve.
      partition.reduce(
        (sum, { moduleId }) => sum + costs[relative(root, moduleId).replaceAll('\\', '/')],
        0,
      ) /
        2 +
      Math.max(...Object.values(costs)) / 2 +
      60 +
      DAWN_GATE_SHARDS[lane]
        .filter((id) => !id.startsWith('ordinary-'))
        .reduce((sum, id) => {
          const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
          return (
            sum +
            (receipt.owners[id] ??
              receipt.reservedOwners[id] ??
              group.files.reduce((n, file) => n + costs[file], 0))
          );
        }, 0),
  );
  t.diagnostic(`complete-process replay seconds: ${finishes.map((v) => v.toFixed(2))}`);
  assert.ok(Math.max(...finishes) <= 2194, `retain preparation headroom: ${finishes}`);
}

const historicalPlan = planRecordedFiles(historicalFiles);
for (const run of historicalRuns) {
  test(`run ${run} retains complete observations within the Dawn execution window`, (t) => {
    assert.equal(historicalFiles.length, 364);
    assertReplay(readReceipt(run), historicalFiles, historicalPlan, t);
  });
}

test('run 43704488189 retains the complete Water-era file roster and freezes GI-4', (t) => {
  const receipt = JSON.parse(
    readFileSync(new URL('../dawn-timing-snapshots/43704488189.json', import.meta.url)),
  );
  assert.equal(Object.keys(receipt.files).length, 190);
  assert.equal(receipt.owners['gi-4'], undefined);
  assert.equal(receipt.reservedOwners['gi-4'], 219.769);
  const files = Object.keys({ ...receipt.reservedFiles, ...receipt.files }).sort();
  assert.equal(files.length, 401);
  assertReplay(receipt, files, planRecordedFiles(files), t);
});

test('the latest serial overload retains full observations and partial-owner identity', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-42797940249.json', import.meta.url)),
  );
  assert.equal(Object.keys(receipt.files).length, 364);
  assert.equal(Object.keys(receipt.owners).length, 23);
  assert.equal(receipt.executionPolicy.ordinaryWorkers, 1);
  for (const [owner, assertions, fullAssertions] of [
    ['feature-depth', 7, 19],
    ['vfx-depth', 11, 26],
  ]) {
    assert.equal(receipt.owners[owner], undefined);
    assert.ok(receipt.reservedOwners[owner] > 0);
    assert.equal(receipt.partialOwnerReceipts[owner].assertions, assertions);
    assert.equal(receipt.partialOwnerReceipts[owner].fullAssertions, fullAssertions);
  }
  const serialWork =
    Object.values(receipt.files).reduce((a, b) => a + b, 0) +
    Object.values({ ...receipt.reservedOwners, ...receipt.owners }).reduce((a, b) => a + b, 0);
  assert.ok(serialWork > 4 * 2194, 'placement alone cannot qualify the retained serial cohort');
});

test('run 42929802533 admits complete Dawn owners and reserves interrupted shadow fields', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-42929802533.json', import.meta.url)),
  );
  assert.equal(receipt.complete, false);
  assert.equal(Object.keys(receipt.files).length, 364);
  assert.equal(Object.keys(receipt.owners).length, 28);
  assert.equal(receipt.owners['shadow-fields'], undefined);
  assert.equal(receipt.reservedOwners['shadow-fields'], 172.358);
  assert.deepEqual(receipt.partialOwnerReceipts['shadow-fields'], {
    processWallSeconds: 75.378,
    assertions: 9,
    fullAssertions: 12,
  });
});
