import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { DawnSequencer } from '../../../config/vitest-dawn-sequencer.ts';
import { runGroups } from '../../lib/run-bounded-groups.mjs';

const coldCoverageFiles = [
  'packages/app/__tests__/builtin-systems.test.ts',
  'packages/codec/scripts/__tests__/fetch-basis.test.mjs',
  'packages/three/src/__tests__/api-audit.test.ts',
];
const coldOwnerLabels = [
  `${coldCoverageFiles.map((file) => `@forgeax/engine-${file.split('/')[1]}`).join(',')}:${coldCoverageFiles.join(',')}`,
];

// Preserve the admitted cohort's launch order while substituting each receipt's
// complete costs and explicit reservations. Clearing observations also changes
// coverageGroupOrder and replays an execution order the producer never uses.
test('nightly 42778322662 retains complete children and every unfinished forecast', (t) => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/coverage-completed-42778322662.json', import.meta.url)),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 54);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 7);
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
  assert.ok(Math.max(...finishes) <= receipt.budgetSeconds, `retain setup headroom: ${finishes}`);
  const ledger = JSON.parse(readFileSync('scripts/ci/coverage-completed-child-seconds.json'));
  const replay = ledger.replayRuns.findIndex((run) => run.runId === receipt.runId);
  assert.deepEqual(ledger.replayRuns[replay]?.completedSeconds, receipt.completedSeconds);
  assert.deepEqual(ledger.replayRuns[replay]?.reservedSeconds, receipt.reservedSeconds);
  for (const group of groups) {
    assert.equal(
      group.replaySeconds[replay],
      receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label],
    );
  }
});

test('cold source and TypeScript files drain neighboring instrumented children', async () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const cold = (group) => group.files.some((file) => coldCoverageFiles.includes(file));
  const owners = groups.filter(cold);
  assert.equal(owners.length, 1);
  const active = new Set();
  const results = await runGroups({
    groups,
    concurrency: 2,
    order: scheduledGroupOrder(groups, { coverage: true, localGpuLease: false }),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (cold(group)) assert.equal(active.size, 0, group.label);
      else assert.ok(![...active].some(cold), group.label);
      active.add(group);
      await new Promise(setImmediate);
      if (cold(group)) assert.equal(active.size, 1, group.label);
      active.delete(group);
      return group.label;
    },
  });
  assert.equal(results.length, 61);
  assert.equal(new Set(results).size, 61);
  for (const file of coldCoverageFiles) {
    const [owner] = owners.filter((group) => group.files.includes(file));
    assert.deepEqual(owner.files, coldCoverageFiles);
    assert.ok(
      groups
        .filter((group) => group !== owner)
        .every((group) => group.files.length > 0 || group.excludes.includes(file)),
    );
    assert.ok(
      buildGroupArgs({
        cliPath: 'vitest.mjs',
        group: owner,
        maxWorkers: 1,
        coverage: true,
        coverageDir: 'coverage',
        reportPath: 'vitest.json',
      }).includes('--coverage'),
    );
    assert.equal(owner.observedSeconds, undefined, 'a failed child supplies no timing observation');
    assert.equal(owner.weight, 0, 'historical project receipts already contain this case work');
    assert.equal(
      owner.reservationWeight,
      65,
      'current admission retains one complete cold process',
    );
    const project = `@forgeax/engine-${file.split('/')[1]}`;
    const selected = coverageGroups([project], 8);
    assert.ok(selected.every((group) => group.projects.every((name) => name === project)));
    assert.deepEqual(
      selected.filter((group) => group.files.length).map((group) => group.files),
      [[file]],
    );
  }
});

test('scriptable publication regressions share the existing exclusive Pack owner', async () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const files = [
    'packages/pack/src/__tests__/material-surface-publication.unit.test.ts',
    'packages/pack/src/__tests__/scriptable-pack-json.integration.test.ts',
    'packages/vite-plugin-pack/src/__tests__/authored-pack-serving.regression.test.ts',
  ];
  const owner = groups.find((group) => group.files.includes(files[1]));
  assert.deepEqual(owner.files, files);
  assert.deepEqual(owner.projects, ['@forgeax/engine-pack', '@forgeax/engine-vite-plugin-pack']);
  assert.equal(owner.label, `@forgeax/engine-pack:${files[0]}`);
  assert.equal(owner.reservationWeight, 65, 'reserve all cases and one cold startup');
  assert.equal(owner.observedSeconds, 18.73, 'retain the original complete child observation');
  for (const file of files) {
    assert.equal(groups.filter((group) => group.files.includes(file)).length, 1);
    assert.ok(
      groups
        .filter((group) => group.files.length === 0)
        .every((group) => group.excludes.includes(file)),
    );
  }
  const active = new Set();
  await runGroups({
    groups,
    concurrency: 2,
    order: scheduledGroupOrder(groups, { coverage: true, localGpuLease: false }),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (group === owner) assert.equal(active.size, 0);
      else assert.ok(!active.has(owner));
      active.add(group);
      await new Promise(setImmediate);
      active.delete(group);
    },
  });
});

test('run 42746576077 fits complete coverage children and preserves missing-owner forecasts', (t) => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/coverage-completed-42746576077.json', import.meta.url)),
  );
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  assert.equal(Object.keys(receipt.completedSeconds).length, 54);
  assert.equal(assignment.length, 61);
  for (const group of groups) {
    const seconds = receipt.completedSeconds[group.label];
    if (seconds !== undefined) {
      assert.ok(
        (group.reservationWeight ?? group.weight) >= Math.ceil(seconds / 5) * 5,
        `${group.label}: current capacity retains the later complete measurement`,
      );
    }
  }
  assert.equal(
    Object.keys(receipt.completedSeconds).length +
      Object.keys(receipt.reservedSeconds).length +
      coldOwnerLabels.length,
    groups.length,
  );
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  t.diagnostic(`complete-child replay seconds: ${finishes.map((v) => v.toFixed(2))}`);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `retain the coverage window: ${finishes}`,
  );
});

for (const runId of [
  42606093924, 42625076170, 42646783761, 42833835009, 42877243264, 42891433204,
]) {
  test(`run ${runId} retains complete children and every unfinished reservation`, (t) => {
    const receipt = JSON.parse(
      readFileSync(new URL(`./fixtures/coverage-completed-${runId}.json`, import.meta.url), 'utf8'),
    );
    const groups = coverageGroups(allProjectNames(), 8);
    const missing = [
      ...(receipt.failedGroups ?? []),
      ...(receipt.interruptedGroups ?? []),
      ...(receipt.unstartedGroups ?? []),
    ];
    assert.deepEqual(
      // Older receipts include the cold files in project children. A newer
      // receipt may measure the separately admitted cold owner directly.
      [
        ...new Set([...Object.keys(receipt.completedSeconds), ...missing, ...coldOwnerLabels]),
      ].sort(),
      groups.map((group) => group.label).sort(),
      'every complete owner remains accounted for exactly once',
    );
    for (const label of missing) {
      assert.equal(receipt.completedSeconds[label], undefined);
      assert.ok(receipt.reservedSeconds[label] > 0);
    }
    const assignment = assignCoverageShards(groups, 4, { typecheck: false });
    const observed = groups.map((group) => ({
      ...group,
      replaySeconds: [
        receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label],
      ],
    }));
    const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
    assert.ok(
      Math.max(...finishes) <= receipt.budgetSeconds,
      `retain the original execution bound: ${finishes}`,
    );
    const ledger = JSON.parse(
      readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
    );
    const admitted = ledger.replayRuns.find((run) => run.runId === runId);
    assert.deepEqual(admitted?.completedSeconds, receipt.completedSeconds);
    assert.deepEqual(admitted?.reservedSeconds, receipt.reservedSeconds);
    assert.notEqual(ledger.latestRun, runId, 'a partial run never replaces the seed');
    t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
  });
}

test('forecast seeds require the exact roster, admission and every retained window', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const seed = ledger.placementSeeds.find((seed) => seed.typecheck === false);
  assert.equal(seed.kind, 'forecast-only', 'a placement forecast is not executed CI evidence');
  assert.ok(coveragePlacementSeed(groups, 4, false, seed));
  assert.equal(coveragePlacementSeed(groups, 3, false, seed), null);
  assert.equal(coveragePlacementSeed(groups, 4, true, seed), null);
  assert.equal(coveragePlacementSeed(groups.slice(1), 4, false, seed), null);
  const renamed = groups.map((group, index) =>
    index === 0 ? { ...group, label: `${group.label}-changed` } : group,
  );
  assert.equal(coveragePlacementSeed(renamed, 4, false, seed), null);
  const invalidLane = { ...seed, assignment: { ...seed.assignment, [groups[0].label]: 4 } };
  assert.equal(coveragePlacementSeed(groups, 4, false, invalidLane), null);
  const collapsed = {
    ...seed,
    assignment: Object.fromEntries(groups.map((group) => [group.label, 0])),
  };
  assert.equal(coveragePlacementSeed(groups, 4, false, collapsed), null);
  const slower = groups.map((group) => ({ ...group, observedSeconds: 10_000 }));
  assert.equal(coveragePlacementSeed(slower, 4, false, seed), null);
});

test('run 42411246807 keeps 57 complete children within the unchanged coverage window', (t) => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42411246807.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 57);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups]) {
    assert.equal(receipt.completedSeconds[label], undefined, 'unfinished work supplies no sample');
    assert.ok(receipt.reservedSeconds[label] > 0, 'retain the admitted missing-owner forecast');
  }
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.equal(assignment.length, 61, 'retain every complete coverage owner');
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `fit the original execution window with all measured work and missing forecasts: ${finishes}`,
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const admitted = ledger.replayRuns.find((run) => run.runId === receipt.runId);
  assert.deepEqual(admitted?.completedSeconds, receipt.completedSeconds);
  assert.deepEqual(admitted?.reservedSeconds, receipt.reservedSeconds);
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'a partial run does not replace the complete seed',
  );
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
});

test('nightly 42861855047 rebalances 56 complete children within the unchanged coverage window', (t) => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42861855047.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 56);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 5);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups]) {
    assert.equal(receipt.completedSeconds[label], undefined, 'unfinished work supplies no sample');
    assert.ok(receipt.reservedSeconds[label] > 0, 'retain the admitted missing-owner forecast');
  }

  const groups = coverageGroups(allProjectNames(), 8);
  const accounted = [
    ...Object.keys(receipt.completedSeconds),
    ...receipt.interruptedGroups,
    ...receipt.unstartedGroups,
  ].sort();
  assert.deepEqual(
    accounted,
    groups.map((group) => group.label).sort(),
    'every complete coverage owner is accounted for exactly once',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    observedSeconds: undefined,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.equal(assignment.length, 61, 'retain every complete coverage owner');
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `fit the original execution window with all measured work and missing forecasts: ${finishes}`,
  );

  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const admitted = ledger.replayRuns.filter((run) => run.runId === receipt.runId);
  assert.equal(admitted.length, 1, 'record this partial cohort once');
  assert.deepEqual(admitted[0].completedSeconds, receipt.completedSeconds);
  assert.deepEqual(admitted[0].reservedSeconds, receipt.reservedSeconds);
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'a partial run never replaces the complete seed',
  );
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
});

test('main 42870354116 rebalances 60 complete children within the unchanged coverage window', (t) => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42870354116.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 60);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 1);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 0);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups]) {
    assert.equal(receipt.completedSeconds[label], undefined, 'unfinished work supplies no sample');
    assert.ok(receipt.reservedSeconds[label] > 0, 'retain the admitted missing-owner forecast');
  }

  const groups = coverageGroups(allProjectNames(), 8);
  const accounted = [
    ...Object.keys(receipt.completedSeconds),
    ...receipt.interruptedGroups,
    ...receipt.unstartedGroups,
  ].sort();
  assert.deepEqual(
    accounted,
    groups.map((group) => group.label).sort(),
    'every complete coverage owner is accounted for exactly once',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    observedSeconds: undefined,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.equal(assignment.length, 61, 'retain every complete coverage owner');
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `fit the original execution window with all measured work and the missing forecast: ${finishes}`,
  );

  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const admitted = ledger.replayRuns.filter((run) => run.runId === receipt.runId);
  assert.equal(admitted.length, 1, 'record this partial cohort once');
  assert.deepEqual(admitted[0].completedSeconds, receipt.completedSeconds);
  assert.deepEqual(admitted[0].reservedSeconds, receipt.reservedSeconds);
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'a partial run never replaces the complete seed',
  );
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
});

test('run 42364652946 keeps 56 complete children within the unchanged coverage window', (t) => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42364652946.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 56);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups]) {
    assert.equal(receipt.completedSeconds[label], undefined, 'unfinished work supplies no sample');
    assert.ok(receipt.reservedSeconds[label] > 0, 'retain the admitted missing-owner forecast');
  }
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.equal(assignment.length, 61, 'retain every complete coverage owner');
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `fit the original execution window with all measured work and missing forecasts: ${finishes}`,
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const admitted = ledger.replayRuns.find((run) => run.runId === receipt.runId);
  assert.deepEqual(admitted?.completedSeconds, receipt.completedSeconds);
  assert.deepEqual(admitted?.reservedSeconds, receipt.reservedSeconds);
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'a partial run does not replace the complete seed',
  );
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
});

test('run 42156576858 retains setup headroom after the slow Modeling wave', (t) => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42156576858.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 52);
  for (const label of receipt.interruptedGroups) {
    assert.equal(receipt.completedSeconds[label], undefined, 'interrupted work supplies no sample');
  }
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const admitted = ledger.replayRuns.find((run) => run.runId === receipt.runId);
  assert.deepEqual(admitted?.completedSeconds, receipt.completedSeconds);
  assert.notEqual(ledger.latestRun, receipt.runId, 'a partial replay is not a complete cohort');
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.equal(assignment.length, 61, 'retain every complete coverage owner');
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `retain the original setup headroom with every measured child: ${finishes}`,
  );
  t.diagnostic(`complete-child replay seconds: ${finishes.map((seconds) => seconds.toFixed(2))}`);
});

test('exclusive groups wait for active work and block neighboring launches', async () => {
  const groups = ['first', 'second', 'exclusive', 'fourth', 'fifth'];
  const active = new Set();
  const started = [];
  let peak = 0;
  const results = await runGroups({
    groups,
    concurrency: 2,
    isExclusive: (group) => group === 'exclusive',
    runGroupImpl: async (group) => {
      if (group === 'exclusive') assert.equal(active.size, 0);
      else assert.equal(active.has('exclusive'), false);
      active.add(group);
      started.push(group);
      peak = Math.max(peak, active.size);
      await new Promise(setImmediate);
      if (group === 'exclusive') assert.equal(active.size, 1);
      active.delete(group);
      return group;
    },
  });
  assert.deepEqual(results, groups);
  assert.deepEqual(started, groups);
  assert.equal(peak, 2, 'ordinary groups retain their requested parallelism');
});

test('an exclusive failure stops all subsequent launches', async () => {
  const started = [];
  await assert.rejects(
    runGroups({
      groups: ['before', 'exclusive', 'must-not-start'],
      concurrency: 2,
      isExclusive: (group) => group === 'exclusive',
      runGroupImpl: async (group) => {
        started.push(group);
        if (group === 'exclusive') throw new Error('exclusive failure');
        await new Promise(setImmediate);
      },
    }),
    /exclusive failure/,
  );
  assert.deepEqual(started, ['before', 'exclusive']);
});

test('coverage fills both slots before draining once for exclusive work', async () => {
  const groups = [
    { label: 'long', weight: 300, files: [] },
    { label: 'exclusive', weight: 200, files: ['compiler.test.ts'] },
    { label: 'short', weight: 100, files: [] },
  ];
  const active = new Set();
  const started = [];
  await runGroups({
    groups,
    concurrency: 2,
    order: scheduledGroupOrder(groups, { coverage: true, localGpuLease: false }),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (group.label === 'short') assert.ok(active.has('long'));
      if (group.label === 'exclusive') assert.equal(active.size, 0);
      active.add(group.label);
      started.push(group.label);
      await new Promise(setImmediate);
      active.delete(group.label);
      return group.label;
    },
  });
  assert.deepEqual(started, ['long', 'short', 'exclusive']);
});

import {
  allProjectNames,
  assignCoverageShards,
  buildGroupArgs,
  buildTypecheckArgs,
  coverageAssignmentLaneFinishes,
  coverageGroupMaxWorkers,
  coverageGroupOrder,
  coverageGroups,
  coveragePlacementSeed,
  isExclusiveCoverageGroup,
  parseArgs,
  projectGroups,
  rerootCoverage,
  scheduledGroupOrder,
  validateShardManifests,
} from '../run-split-vitest-coverage.mjs';

test('real generated-game coverage drains compiler children before starting the browser', async () => {
  const groups = coverageGroups(['@forgeax/engine-devkit', 'unit'], 8);
  const active = new Set();
  let browserRuns = 0;
  await runGroups({
    groups,
    concurrency: 2,
    order: coverageGroupOrder(groups),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      const browser = isExclusiveCoverageGroup(group);
      if (browser) {
        assert.equal(active.size, 0);
        browserRuns++;
      } else assert.ok(![...active].some(isExclusiveCoverageGroup));
      active.add(group);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (browser) assert.equal(active.size, 1);
      active.delete(group);
      return group.label;
    },
  });
  assert.equal(
    browserRuns,
    7,
    'native, Vite build and live startup owners drain neighboring coverage work',
  );
  assert.equal(active.size, 0);
});

test('cold compiler file sets keep one owner and drain all neighboring work', async () => {
  const groups = coverageGroups(
    [
      '@forgeax/engine-devkit',
      '@forgeax/engine-modeling',
      '@forgeax/engine-vite-plugin-shader',
      '@forgeax/engine-vite-plugin-pack',
      '@forgeax/engine-pack',
      '@forgeax/engine-render',
      'unit',
    ],
    8,
  );
  for (const file of [
    'packages/modeling/src/__tests__/bake-cage.unit.test.ts',
    'packages/modeling/src/__tests__/subd-crease.unit.test.ts',
    'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts',
    'packages/pack/src/__tests__/material-surface-publication.unit.test.ts',
    'packages/vite-plugin-pack/src/__tests__/declared-standard-material.integration.test.ts',
    'packages/vite-plugin-shader/src/__tests__/vite-plugin-shader.unit.test.ts',
    'packages/vite-plugin-shader/src/__tests__/public-surface.unit.test.ts',
    'packages/devkit/src/__tests__/live-dev-process.integration.test.ts',
    'packages/devkit/src/__tests__/live-dev-client.test.ts',
    'packages/devkit/src/__tests__/worker-module-identity.integration.test.ts',
    'packages/devkit/src/__tests__/project-play.e2e.test.ts',
    'packages/render/src/__tests__/raytracing/diffuse-gi.unit.test.ts',
    'packages/render/src/__tests__/raytracing/gi-view.unit.test.ts',
    'packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
  ]) {
    assert.equal(groups.filter((group) => group.files.includes(file)).length, 1);
    assert.ok(
      groups
        .filter((group) => !group.files.includes(file))
        .every((group) => group.excludes.includes(file) || group.files.length > 0),
    );
  }
  const active = new Set();
  let exclusiveRuns = 0;
  await runGroups({
    groups,
    concurrency: 2,
    order: coverageGroupOrder(groups),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (isExclusiveCoverageGroup(group)) {
        assert.equal(active.size, 0);
        exclusiveRuns++;
      } else assert.ok(![...active].some(isExclusiveCoverageGroup));
      active.add(group);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (isExclusiveCoverageGroup(group)) assert.equal(active.size, 1);
      active.delete(group);
      return group.label;
    },
  });
  assert.equal(exclusiveRuns, 18);
});

test('cold large-scene contracts execute once without competing coverage children', () => {
  const groups = coverageGroups(['@forgeax/engine-scene', '@forgeax/engine-render'], 8);
  for (const file of [
    'packages/scene/src/__tests__/flat-propagation.contract.test.ts',
    'packages/render/src/__tests__/managed-production-batches.unit.test.ts',
  ]) {
    const owners = groups.filter((group) => group.files.includes(file));
    assert.equal(owners.length, 1);
    assert.equal(isExclusiveCoverageGroup(owners[0]), true);
    assert.ok(
      groups
        .filter((group) => !group.files.includes(file))
        .every((group) => group.excludes.includes(file) || group.files.length > 0),
    );
  }
});

test('large-source pipeline identity has one exclusive owner with unchanged coverage and complete shard membership', async () => {
  const file = 'packages/rhi-webgpu/src/__tests__/pipeline-library.unit.test.ts';
  const projects = [
    '@forgeax/engine-render-graph',
    '@forgeax/engine-rhi',
    '@forgeax/engine-rhi-debug',
    '@forgeax/engine-rhi-null',
    '@forgeax/engine-rhi-webgpu',
  ];
  const groups = coverageGroups(projects, 8);
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.deepEqual(owner.files, [file]);
  assert.equal(isExclusiveCoverageGroup(owner), true);
  const ordinary = groups.filter((group) => !group.files.includes(file));
  assert.ok(ordinary.every((group) => group.excludes.includes(file)));
  const argsFor = (group) =>
    buildGroupArgs({
      cliPath: 'vitest.mjs',
      group,
      maxWorkers: 1,
      coverage: true,
      coverageDir: 'coverage-owner',
      reportPath: 'vitest-owner.json',
    });
  const ownerArgs = argsFor(owner);
  assert.ok(ownerArgs.includes(file));
  assert.ok(ownerArgs.includes('--coverage'));
  assert.ok(ownerArgs.includes('--coverage.reporter=json'));
  assert.ok(
    ordinary.every((group) =>
      argsFor(group).includes(`--exclude=${path.resolve(file).replaceAll('\\', '/')}`),
    ),
  );
  assert.ok(!ownerArgs.some((arg) => /testTimeout|hookTimeout|testNamePattern/.test(arg)));
  const active = new Set();
  const results = await runGroups({
    groups,
    concurrency: 3,
    order: scheduledGroupOrder(groups, { coverage: true, localGpuLease: false }),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (group === owner) assert.equal(active.size, 0);
      else assert.equal(active.has(owner), false);
      active.add(group);
      await new Promise(setImmediate);
      if (group === owner) assert.equal(active.size, 1);
      active.delete(group);
      return group.label;
    },
  });
  assert.equal(results.filter((label) => label === owner.label).length, 1);
  const labels = groups.map((group) => group.label);
  const assignment = assignCoverageShards(groups, 3, { typecheck: false });
  const shards = Array.from({ length: 3 }, (_, shardIndex) => ({
    shardIndex,
    shardCount: 3,
    expectedGroups: labels,
    groups: labels.filter((_, index) => assignment[index] === shardIndex),
  }));
  validateShardManifests(shards, labels);
  const missing = shards.map((shard) => ({
    ...shard,
    groups: shard.groups.filter((label) => label !== owner.label),
  }));
  assert.throws(() => validateShardManifests(missing, labels), /ran 0 times/);
  const duplicated = shards.map((shard, index) => ({
    ...shard,
    groups: index === 0 ? [...shard.groups, owner.label] : shard.groups,
  }));
  assert.throws(() => validateShardManifests(duplicated, labels), /ran 2 times/);
});

test('allows CI coverage to reuse the repository-wide typecheck gate', () => {
  const options = parseArgs([
    '--group-size=8',
    '--group-concurrency=auto',
    '--max-workers=1',
    '--skip-typecheck',
  ]);
  assert.equal(options.coverage, true);
  assert.equal(options.typecheck, false);
  assert.equal(options.groupSize, 8);
  assert.equal(options.groupConcurrency, 'auto');
});

test('supports the single standalone Vitest type-test preflight', () => {
  const options = parseArgs(['--typecheck-only', '--max-workers=1']);
  assert.equal(options.typecheckOnly, true);
  assert.equal(options.typecheck, true);
  assert.equal(options.maxWorkers, 1);
  assert.throws(
    () => parseArgs(['--typecheck-only', '--skip-typecheck']),
    /cannot be combined with --skip-typecheck/,
  );
});

test('runs one typecheck-only preflight over the selected project roster', () => {
  assert.deepEqual(
    buildTypecheckArgs({
      cliPath: '/workspace/node_modules/vitest/vitest.mjs',
      projects: ['@forgeax/engine-ecs', 'unit'],
      maxWorkers: 1,
    }),
    [
      '/workspace/node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      '@forgeax/engine-ecs',
      '--project',
      'unit',
      '--maxWorkers=1',
      '--typecheck.only',
      '--reporter=default',
    ],
  );
});

test('coverage workflow downloads every produced matrix shard', () => {
  const workflow = parse(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  const producer = workflow.jobs['coverage-pnpm-shard'];
  const shards = producer.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, index) => index),
  );
  const produce = producer.steps.find((step) => step.run?.includes('--shard-count='));
  const primary = workflow.jobs['primary-pnpm'];
  const typecheck = primary.steps.find((step) => step.name === 'Vitest type-test preflight');
  const consume = workflow.jobs['coverage-pnpm'].steps.find((step) =>
    step.run?.includes('--artifact-pattern "coverage-shard-*"'),
  );
  assert.ok(typecheck?.run.includes('--typecheck-only'));
  assert.ok(produce.run.includes('--skip-typecheck'));
  assert.equal(shards.length, 4, 'retain the existing four-runner coverage limit');
  assert.equal(Number(produce.run.match(/--shard-count=(\d+)/)?.[1]), shards.length);
  assert.equal(Number(consume.run.match(/--expected-count (\d+)/)?.[1]), shards.length);
});

test('two Modeling coverage workers require CPU and measured-memory headroom', () => {
  const group = { projects: ['@forgeax/engine-modeling'], shard: '1/16', files: [] };
  const options = parseArgs(['--modeling-max-workers=2']);
  const resources = { cpus: 8, memoryBytes: 16_000_000_000 };
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const gate = workflow.jobs['coverage-pnpm-shard'].steps.find((step) =>
    step.run?.includes('--shard-count='),
  );
  assert.match(gate.run, /--modeling-max-workers=2/);
  assert.equal(workflow.jobs['coverage-pnpm-shard'].env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.ok(!gate.run.includes('--isolate=false'));
  assert.ok(!gate.run.includes('--coverage.enabled=false'));
  assert.equal(coverageGroupMaxWorkers(group, options, resources, 2), 2);
  assert.equal(coverageGroupMaxWorkers(group, options, { ...resources, cpus: 7 }, 2), 1);
  assert.equal(
    coverageGroupMaxWorkers(group, options, { ...resources, memoryBytes: 12_000_000_000 }, 2),
    1,
  );
  assert.equal(coverageGroupMaxWorkers(group, options, resources, 3), 1);
  assert.equal(coverageGroupMaxWorkers(group, parseArgs([]), resources, 2), 1);
  assert.equal(coverageGroupMaxWorkers(group, { ...options, coverage: false }, resources, 2), 1);
  assert.equal(
    coverageGroupMaxWorkers(
      { ...group, projects: ['@forgeax/engine-render'] },
      options,
      resources,
      2,
    ),
    1,
  );
  assert.equal(
    coverageGroupMaxWorkers(
      { ...group, shard: undefined, files: ['source.test.ts'] },
      options,
      resources,
      2,
    ),
    1,
  );
  for (const count of [0, 3, -1, 1.5]) {
    assert.throws(() => parseArgs([`--modeling-max-workers=${count}`]), /modeling-max-workers/);
  }
});

test('modeling tier budgets remain mandatory and uninstrumented outside coverage children', () => {
  const file = 'packages/modeling/src/__tests__/perf-tiers.unit.test.ts';
  const group = coverageGroups(['@forgeax/engine-modeling'], 4)[0];
  const args = buildGroupArgs({
    cliPath: 'vitest.mjs',
    group,
    maxWorkers: 1,
    coverage: true,
    coverageDir: 'coverage',
    reportPath: 'report.json',
  });
  assert.ok(args.includes(`--exclude=${path.resolve(file).replaceAll('\\', '/')}`));
  const ordinary = buildGroupArgs({ cliPath: 'vitest.mjs', group, maxWorkers: 1, coverage: false });
  assert.ok(!ordinary.includes(`--exclude=${path.resolve(file).replaceAll('\\', '/')}`));
  const workflow = parse(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  assert.ok(
    workflow.jobs['coverage-perf']['runs-on'].includes('heavy'),
    'absolute tier budgets require the admitted heavy runner class',
  );
  const gate = workflow.jobs['coverage-perf'].steps.find((step) => step.run?.includes(file));
  assert.ok(gate, 'the required performance job must run the complete tier-budget file');
  assert.ok(gate.run.includes('--project=@forgeax/engine-modeling'));
  assert.ok(gate.run.includes('--coverage.enabled=false'));
  assert.ok(gate.run.includes('node scripts/ci/run-vitest-projects.mjs run'));
  assert.ok(gate.run.includes('node scripts/ci/run-with-runner-cpu-affinity.mjs --'));
  assert.ok(gate.run.includes('--typecheck.enabled=false'));
  assert.ok(gate.run.includes('--passWithNoTests=false'));
  const capacity = workflow.jobs['coverage-perf'].steps.find(
    (step) => step.run === 'node scripts/ci/verify-runner-pool-capacity.mjs --pool heavy',
  );
  assert.ok(capacity, 'absolute budgets must verify the actual heavy capacity');
  assert.equal(capacity.if, "steps.ci-repair.outputs.reused != 'true'");
  assert.ok(
    workflow.jobs['coverage-perf'].steps.indexOf(capacity) <
      workflow.jobs['coverage-perf'].steps.indexOf(gate),
  );
  assert.notEqual(gate['continue-on-error'], true);
  assert.ok(!/testTimeout|testNamePattern|--exclude/.test(gate.run));
});

test('cold Render cooking stays complete in the existing exclusive owner', () => {
  const files = [
    'packages/render/src/__tests__/gpu-driven-production.integration.test.ts',
    'packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
    'packages/render/src/__tests__/direct-preparation.integration.test.ts',
    'packages/render/src/__tests__/vertex-color-program.integration.test.ts',
  ];
  const groups = coverageGroups(['@forgeax/engine-render'], 8);
  const owner = groups.find((group) => group.files.includes(files[0]));
  assert.deepEqual(owner.files, files);
  assert.equal(owner.label, `@forgeax/engine-render:${files.slice(0, 2).join(',')}`);
  assert.equal(owner.weight, 110, 'retain the larger completed owner observation');
  assert.equal(owner.reservationWeight, 160, 'reserve new work without inventing a sample');
  assert.ok(isExclusiveCoverageGroup(owner));
  for (const partition of groups.filter((group) => group.shard)) {
    assert.ok(files.every((file) => partition.excludes.includes(file)));
  }
});

test('fractional-sharpness subdivision oracle has one exclusive coverage owner', () => {
  const file = 'packages/modeling/src/__tests__/subd-crease.unit.test.ts';
  const sweepFile = 'packages/modeling/src/__tests__/sweep.unit.test.ts';
  const groups = coverageGroups(['@forgeax/engine-modeling'], 4);
  const owner = groups.find((group) => group.files.includes(file));
  assert.ok(owner, 'the complete V8-instrumented file keeps an explicit owner');
  assert.deepEqual(owner.files, [file, sweepFile]);
  assert.equal(owner.label, `@forgeax/engine-modeling:${file}`);
  assert.equal(owner.weight, 60, 'preserve the subd receipt identity and measured cost');
  assert.equal(
    owner.reservationWeight,
    125,
    'reserve both the subd and sweep costs for current runs',
  );
  assert.ok(isExclusiveCoverageGroup(owner), 'preserve the sharpness deadline isolation');
  const partitions = groups.filter((group) => group.shard);
  assert.equal(partitions.length, 16);
  assert.ok(
    partitions.every(
      (group) => group.excludes.includes(file) && group.excludes.includes(sweepFile),
    ),
    'neither file can overlap a native Modeling coverage partition',
  );
});

test('actual Vitest discovery and native partitions conserve the complete coverage roster', async () => {
  const file = path
    .resolve('packages/modeling/src/__tests__/perf-tiers.unit.test.ts')
    .replaceAll('\\', '/');
  const groups = coverageGroups(['@forgeax/engine-modeling'], 4);
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const discover = (args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'list', '--project=@forgeax/engine-modeling', ...args, '--filesOnly', '--json'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).map(({ file }) => file.replaceAll('\\', '/'));
  const ordinary = discover([]);
  const native = groups.filter((group) => group.shard);
  const explicit = groups.filter((group) => group.files.length > 0);
  const args = buildGroupArgs({
    cliPath: 'vitest.mjs',
    group: native[0],
    maxWorkers: 1,
    coverage: true,
    coverageDir: 'coverage',
    reportPath: 'report.json',
  });
  const covered = discover(args.filter((argument) => argument.startsWith('--exclude=')));
  assert.ok(ordinary.includes(file), 'ordinary tests retain the complete performance file');
  // `vitest list --filesOnly` lists the unsharded inventory. Exercise the
  // configured sequencer with actual discovery, including isolated-file excludes.
  const specifications = covered.map((moduleId) => ({
    moduleId,
    project: { name: '@forgeax/engine-modeling' },
  }));
  const partition = (specs, index, count) =>
    new DawnSequencer({
      config: { root: process.cwd(), coverage: { enabled: true }, shard: { index, count } },
    }).shard(specs);
  const partitions = await Promise.all(
    native.map((group) => {
      const [index, count] = group.shard.split('/').map(Number);
      return partition(specifications, index, count);
    }),
  );
  const reversed = await Promise.all(
    native.map((_group, index) =>
      partition([...specifications].reverse(), index + 1, native.length),
    ),
  );
  assert.deepEqual(reversed, partitions, 'placement is independent of discovery order');
  const isolated = explicit.flatMap((group) => discover(group.files));
  assert.deepEqual(
    [...partitions.flat().map(({ moduleId }) => moduleId), ...isolated].toSorted(),
    ordinary.filter((entry) => entry !== file).toSorted(),
    'real native partitions and exclusive owners discover every instrumented file exactly once',
  );
});

test('broad project halves spread across jobs instead of stacking different projects', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const halves = groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => group.shard?.endsWith('/2'));
  assert.equal(halves.length, 4);
  for (const typecheck of [true, false]) {
    const assignment = assignCoverageShards(groups, 4, { typecheck });
    assert.deepEqual(
      Array.from(
        { length: 4 },
        (_value, lane) => halves.filter(({ index }) => assignment[index] === lane).length,
      ),
      [1, 1, 1, 1],
      'each job owns one complete DevKit/Render half, retaining four jobs and every child',
    );
  }
});

test('heavy project partitions cannot recombine on the same coverage lane', () => {
  for (const project of ['@forgeax/engine-devkit', '@forgeax/engine-render']) {
    const groups = coverageGroups([project], 8);
    const native = groups.filter((group) => group.shard);
    assert.equal(native.length, 2, 'the complete ordinary project has two native owners');
    const assignment = assignCoverageShards(groups, 4);
    assert.equal(
      new Set(native.map((group) => assignment[groups.indexOf(group)])).size,
      2,
      'both halves must occupy different jobs instead of reconstructing the long child',
    );
    assert.ok(groups.filter((group) => group.files.length > 0).every((group) => !group.shard));
  }
});

test('fine partitions leave room for a whole exclusive source-production owner', () => {
  const groups = Array.from({ length: 8 }, (_value, index) => ({
    label: `modeling-${index}`,
    projects: ['modeling'],
    shard: `${index + 1}/8`,
    weight: 100,
    files: [],
  }));
  groups.push({ label: 'source', projects: ['shader'], weight: 250, files: ['source.test.ts'] });
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const lanes = Array.from({ length: 4 }, () => ({ slots: [0, 0], exclusive: 0 }));
  for (const index of coverageGroupOrder(groups)) {
    const group = groups[index];
    const lane = lanes[assignment[index]];
    if (group.files.length > 0) lane.exclusive += group.weight;
    else lane.slots[lane.slots[0] <= lane.slots[1] ? 0 : 1] += group.weight;
  }
  assert.equal(Math.max(...lanes.map((lane) => Math.max(...lane.slots) + lane.exclusive)), 350);
  assert.equal(assignment.length, groups.length, 'retain every complete child');
  assert.equal(new Set(assignment.slice(0, 8)).size, 4, 'retain the cost-ranked four-job waves');
});

test('the complete roster leaves early admission headroom for its long exclusive compiler', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const compiler = groups.findIndex((group) =>
    group.files.includes(
      'packages/vite-plugin-shader/src/__tests__/production-resampling-vite.integration.test.ts',
    ),
  );
  assert.ok(compiler >= 0 && groups[compiler].weight >= 900);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const exclusiveNeighbors = groups.filter(
    (group, index) =>
      index !== compiler &&
      isExclusiveCoverageGroup(group) &&
      assignment[index] === assignment[compiler],
  );
  assert.equal(
    exclusiveNeighbors.length,
    0,
    'the long compiler must leave room for its complete tail instead of stacking exclusive owners',
  );
  const criticalLane = assignment[compiler];
  const lane = { slots: [0, 0] };
  for (const index of coverageGroupOrder(groups)) {
    const group = groups[index];
    if (assignment[index] !== criticalLane || isExclusiveCoverageGroup(group)) continue;
    const weight = group.observedSeconds ?? group.weight;
    lane.slots[lane.slots[0] <= lane.slots[1] ? 0 : 1] += weight;
  }
  const reservedFinish = Math.max(...lane.slots) + groups[compiler].weight;
  assert.ok(
    reservedFinish + 180 <= 45 * 60,
    `the retained 15-minute compiler forecast must fit the 45-minute job with setup headroom (finish=${reservedFinish}s)`,
  );
  assert.equal(assignment.length, groups.length);
  assert.ok(assignment.every((shard) => shard >= 0 && shard < 4));
});

test('complete partition receipts raise only their own inherited placement forecasts', () => {
  const completed = {
    latestRun: 1,
    groups: {
      '@forgeax/engine-render:shard-1-of-2': {
        reservedSeconds: 1089,
        latestSeconds: 673.96,
        run: 1,
      },
      '@forgeax/engine-render:shard-2-of-2': {
        reservedSeconds: 1188,
        latestSeconds: 577.03,
        run: 1,
      },
      '@forgeax/engine-devkit:shard-2-of-2': {
        reservedSeconds: 717,
        latestSeconds: 406.14,
        run: 1,
      },
      '@forgeax/engine-modeling:shard-10-of-16': {
        reservedSeconds: 1063,
        latestSeconds: 841.82,
        run: 1,
      },
      '@forgeax/engine-modeling:shard-16-of-16': {
        reservedSeconds: 1006,
        latestSeconds: 841.18,
        run: 1,
      },
    },
  };
  const groups = coverageGroups(allProjectNames(), 8, { completed });
  const weight = (project, shard) =>
    groups.find((group) => group.projects[0] === project && group.shard === shard).weight;
  assert.equal(weight('@forgeax/engine-render', '1/2'), 1090);
  assert.equal(weight('@forgeax/engine-render', '2/2'), 1190);
  assert.equal(weight('@forgeax/engine-devkit', '2/2'), 720);
  assert.ok(weight('@forgeax/engine-modeling', '16/16') >= 1010);
  const historicallyMeasuredModeling = groups.find(
    (group) => group.projects[0] === '@forgeax/engine-modeling' && group.shard === '10/16',
  );
  assert.equal(historicallyMeasuredModeling.observedSeconds, 841.82);
  assert.equal(historicallyMeasuredModeling.weight, 1065);
  assert.ok(
    groups
      .filter((group) => group.projects[0] === '@forgeax/engine-modeling' && group.shard)
      .every((group) => group.weight >= 945),
  );
});

test('partial observations cannot optimize a current roster with stale samples', () => {
  const key =
    '@forgeax/engine-devkit:packages/devkit/src/__tests__/new-project-workers.e2e.test.ts';
  const completed = {
    latestRun: 2,
    groups: { [key]: { reservedSeconds: 150, latestSeconds: 60, run: 1 } },
  };
  const worker = coverageGroups(['@forgeax/engine-devkit'], 8, { completed }).find((group) =>
    group.files.includes('packages/devkit/src/__tests__/new-project-workers.e2e.test.ts'),
  );
  assert.ok(worker.weight >= 150);
  assert.equal(worker.observedSeconds, undefined);
});

test('current and retained complete coverage receipts bound all four replay forecasts', () => {
  const latestReceipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-41828488495.json', import.meta.url),
      'utf8',
    ),
  );
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  assert.equal(assignment.length, groups.length, 'retain every complete child');
  const baselineGroups = groups.map(({ reservationWeight: _reservationWeight, ...group }) => group);
  const baselineAssignment = assignCoverageShards(baselineGroups, 4, { typecheck: false });
  const currentReserved = coverageAssignmentLaneFinishes(groups, assignment, 4, false);
  const currentBaseline = coverageAssignmentLaneFinishes(groups, baselineAssignment, 4, false);
  assert.ok(
    Math.max(...currentReserved) <= Math.max(...currentBaseline),
    `the reserved sweep owner does not worsen the best retained baseline lane: ${currentReserved} vs ${currentBaseline}`,
  );
  const lanes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true);
  assert.ok(
    Math.max(...lanes) <= 2300,
    `the runtime-only four-job replay must stay below 2300s before remaining setup; got ${lanes}`,
  );
  assert.equal(groups.length, 61, 'retain every reserved complete child');
  assert.equal(
    groups.filter((group) => group.observedSeconds !== undefined).length,
    Object.keys(latestReceipt.completedSeconds).length,
    'observations match the latest complete-child receipt while unfinished work keeps reservations',
  );
});

test('retained partial receipts rebalance every complete-owner replay scenario', () => {
  const completed = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.ok(completed.replayRuns.length >= 4, 'retain distinct historical replay windows');

  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  assert.equal(assignment.length, groups.length);

  for (const group of groups) {
    if (!group.replaySeconds) continue;
    assert.equal(group.replaySeconds.length, completed.replayRuns.length);
    for (const [index, run] of completed.replayRuns.entries()) {
      const expected = run.completedSeconds?.[group.label] ?? run.reservedSeconds?.[group.label];
      assert.equal(group.replaySeconds[index], expected, `${group.label} replay ${index}`);
      assert.equal(
        group.replayReserved[index],
        run.completedSeconds?.[group.label] === undefined &&
          run.reservedSeconds?.[group.label] !== undefined,
      );
      assert.equal(group.replayTypechecks[index], run.typecheck);
    }
  }

  const scenarios = [
    { name: 'latest', replay: -1, budget: 2300 },
    ...completed.replayRuns.map((run, index) => ({
      name: String(run.run ?? run.runId),
      replay: index,
      budget: run.budgetSeconds ?? 2300,
    })),
  ].map(({ name, replay, budget }) => ({
    name,
    budget,
    lanes: coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay),
  }));
  for (const scenario of scenarios) {
    assert.ok(
      Math.max(...scenario.lanes) <= scenario.budget,
      `${scenario.name} must leave setup headroom: ${scenario.lanes}`,
    );
  }
});

test('completed run 41828488495 leaves the interrupted compiler its full reserved window', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-41828488495.json', import.meta.url),
      'utf8',
    ),
  );
  const groups = coverageGroups(allProjectNames(), 8);
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    [...Object.keys(receipt.completedSeconds), receipt.interruptedGroup, ...coldOwnerLabels].sort(),
    'retain all complete owners and the interrupted compiler without inventing a sample',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const lanes = Array.from({ length: 4 }, () => ({ parallel: [0, 0], exclusive: 0 }));
  for (const index of coverageGroupOrder(groups)) {
    const group = groups[index];
    const seconds = receipt.completedSeconds[group.label] ?? group.weight;
    const lane = lanes[assignment[index]];
    if (isExclusiveCoverageGroup(group)) lane.exclusive += seconds;
    else lane.parallel[lane.parallel[0] <= lane.parallel[1] ? 0 : 1] += seconds;
  }
  const finishes = lanes.map((lane) => Math.max(...lane.parallel) + lane.exclusive);
  assert.ok(
    Math.max(...finishes) <= 2300,
    `completed work plus the unchanged compiler reservation must fit 2300s: ${finishes}`,
  );
});

test('run 41840653604 stays bounded without discarding the preceding complete cohort', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-41840653604.json', import.meta.url),
      'utf8',
    ),
  );
  const completedCoverage = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 48);
  assert.ok(!Object.hasOwn(receipt.completedSeconds, '@forgeax/engine-modeling:shard-13-of-16'));
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const partialReplayIndex = completedCoverage.replayRuns.findIndex(
    (run) => run.run === receipt.run,
  );
  assert.notEqual(partialReplayIndex, -1);
  const finishes = coverageAssignmentLaneFinishes(
    groups,
    assignment,
    4,
    false,
    true,
    partialReplayIndex,
  );
  assert.ok(
    Math.max(...finishes) <= 2300,
    `retain setup headroom in the partial-run replay: ${finishes}`,
  );
});

test('complete children from a cancelled coverage parent rebalance the heavy lane', () => {
  const receipts = new Map([
    ['@forgeax/engine-modeling:shard-2-of-16', [465.84, 855]],
    ['@forgeax/engine-modeling:shard-7-of-16', [316.62, 849]],
    ['@forgeax/engine-modeling:shard-9-of-16', [563.9, 1095]],
    ['@forgeax/engine-modeling:shard-16-of-16', [841.18, 1006]],
    ['@forgeax/engine-render:shard-1-of-2', [673.96, 1089]],
  ]);
  // Exercise the partial refresh itself, independent of later complete runs.
  const completed = {
    latestRun: 1,
    groups: Object.fromEntries(
      [...receipts].map(([label, [latestSeconds, reservedSeconds]]) => [
        label,
        { latestSeconds, reservedSeconds, run: 1 },
      ]),
    ),
  };
  const groups = coverageGroups(allProjectNames(), 8, { completed });
  const assignment = assignCoverageShards(groups, 4);
  const placements = Array(4).fill(0);
  for (const [label, [latest, reserved]] of receipts) {
    const index = groups.findIndex((group) => group.label === label);
    assert.notEqual(index, -1, `retain completed owner ${label}`);
    assert.equal(groups[index].observedSeconds, latest);
    assert.ok(groups[index].weight >= reserved, `retain reservation for ${label}`);
    placements[assignment[index]] += 1;
  }
  assert.ok(
    Math.max(...placements) <= 2,
    `the five slow completed owners must span the four jobs; got ${placements.join('/')}`,
  );
});

test('single-job coverage retains all children without cross-job placement constraints', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  assert.deepEqual(assignCoverageShards(groups, 1), Array(groups.length).fill(0));
});

test('broad DevKit and Render halves do not accumulate on one coverage lane', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4);
  const broad = groups.filter((group) => group.shard?.endsWith('/2'));
  assert.equal(broad.length, 4);
  assert.equal(
    new Set(broad.map((group) => assignment[groups.indexOf(group)])).size,
    4,
    'run 41539054992 stranded both broad projects behind four slow Modeling children',
  );
});

test('each Modeling cost-ranked wave spans all four coverage jobs', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4);
  const modeling = groups.filter(
    (group) => group.shard && group.projects[0] === '@forgeax/engine-modeling',
  );
  for (let start = 0; start < modeling.length; start += 4) {
    const wave = modeling.slice(start, start + 4);
    assert.equal(
      new Set(wave.map((group) => assignment[groups.indexOf(group)])).size,
      wave.length,
      'run 41548412739 clustered the first and third costly waves on two slow jobs',
    );
  }
});

for (const { runId, completedCount } of [
  { runId: 42049090931, completedCount: 56 },
  { runId: 42076518011, completedCount: 50 },
  { runId: 42112381149, completedCount: 50 },
  { runId: 42122803571, completedCount: 60 },
  { runId: 42139091052, completedCount: 59 },
]) {
  test(`slow completed children in run ${runId} leave room for every unfinished owner`, () => {
    const receipt = JSON.parse(
      readFileSync(new URL(`./fixtures/coverage-completed-${runId}.json`, import.meta.url), 'utf8'),
    );
    assert.equal(Object.keys(receipt.completedSeconds).length, completedCount);
    const groups = coverageGroups(allProjectNames(), 8);
    const pending = groups.filter(
      (group) =>
        !(group.label in receipt.completedSeconds) && !coldOwnerLabels.includes(group.label),
    );
    assert.deepEqual(
      pending.map((group) => group.label).sort(),
      Object.keys(receipt.reservedSeconds).sort(),
    );
    const typecheck = receipt.typecheck ?? true;
    const assignment = assignCoverageShards(groups, 4, { typecheck });
    const lanes = Array.from({ length: 4 }, (_, lane) => ({
      parallel: Array(2).fill(lane === 0 && typecheck ? 185 : 0),
      exclusive: 0,
    }));
    for (const index of coverageGroupOrder(groups, typecheck)) {
      const group = groups[index];
      const seconds =
        receipt.completedSeconds[group.label] ??
        receipt.reservedSeconds[group.label] ??
        group.weight;
      const lane = lanes[assignment[index]];
      if (isExclusiveCoverageGroup(group)) lane.exclusive += seconds;
      else lane.parallel[lane.parallel[0] <= lane.parallel[1] ? 0 : 1] += seconds;
    }
    const finishes = lanes.map((lane) => Math.max(...lane.parallel) + lane.exclusive);
    assert.ok(
      Math.max(...finishes) <= Math.min(2450, receipt.budgetSeconds ?? 2450),
      `${completedCount} completed children plus unchanged unfinished reservations retain setup headroom: ${finishes}`,
    );
    const replay = JSON.parse(
      readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
    ).replayRuns.findIndex((run) => run.runId === runId);
    for (const group of pending) {
      assert.equal(group.replaySeconds[replay], receipt.reservedSeconds[group.label]);
    }
  });
}

test('complete fine waves admit unequal forecasts without a greedy placement dead end', () => {
  const groups = [
    500, 800, 610, 900, 720, 660, 400, 510, 650, 610, 490, 950, 750, 810, 920, 1000,
  ].map((weight, index) => ({
    label: `fine-${index + 1}`,
    projects: ['fine'],
    shard: `${index + 1}/16`,
    weight,
    files: [],
  }));
  for (const typecheck of [true, false]) {
    const assignment = assignCoverageShards(groups, 4, { typecheck });
    for (let offset = 0; offset < 4; offset++) {
      assert.equal(new Set(assignment.slice(offset * 4, offset * 4 + 4)).size, 4);
      assert.equal(assignment.filter((lane) => lane === offset).length, 4);
    }
    assert.deepEqual(assignCoverageShards(groups, 4, { typecheck }), assignment);
  }
});

test('runtime child CLI typecheck override retains the complete central typecheck owner', () => {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const discover = (args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'list', '--project=@forgeax/engine-render', ...args, '--filesOnly', '--json'],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).map(({ file }) => file);
  const all = discover([]);
  const typeTests = all.filter((file) => file.includes('.test-d.'));
  assert.ok(typeTests.length > 0, 'exercise the real package declaration, not a mock config');
  const preflight = discover(['--typecheck.only']);
  assert.deepEqual(
    preflight.filter((file) => file.includes('.test-d.')).toSorted(),
    typeTests.toSorted(),
    'the central preflight retains every original type test',
  );
  const runtime = discover(['--typecheck.enabled=false']);
  assert.deepEqual(
    runtime.filter((file) => file.includes('.test-d.')),
    [],
    'explicit CLI false must override the package default in runtime children',
  );
  assert.deepEqual(
    runtime.toSorted(),
    all.filter((file) => !file.includes('.test-d.')).toSorted(),
    'retain every ordinary runtime file',
  );
});

test('ordinary Shader placement excludes the isolated source-production cost', () => {
  const groups = coverageGroups(['@forgeax/engine-vite-plugin-shader'], 8);
  const ordinary = groups.find((group) => group.files.length === 0);
  const source = groups.find((group) =>
    group.files.includes(
      'packages/vite-plugin-shader/src/__tests__/production-resampling-vite.integration.test.ts',
    ),
  );
  assert.ok(ordinary && source);
  assert.ok(source.files.every((file) => ordinary.excludes.includes(file)));
  assert.ok(
    ordinary.weight < source.weight / 2,
    'the ordinary child must not retain the full-project forecast after source production moves out',
  );
  assert.ok(source.weight >= 760, 'retain the complete measured source-production reservation');
});

test('actual DevKit and Render discovery conserves both native halves and exclusive owners', async () => {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  for (const project of ['@forgeax/engine-devkit', '@forgeax/engine-render']) {
    const groups = coverageGroups([project], 8);
    const native = groups.filter((group) => group.shard);
    const explicit = groups.filter((group) => group.files.length > 0);
    const commonArgs = buildGroupArgs({
      cliPath: cli,
      group: { ...native[0], excludes: [] },
      maxWorkers: 1,
      coverage: true,
      coverageDir: 'coverage',
      reportPath: 'report.json',
    }).filter(
      (argument) => argument.startsWith('--exclude=') || argument === '--typecheck.enabled=false',
    );
    const discover = (args) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [cli, 'list', `--project=${project}`, ...args, '--filesOnly', '--json'],
          { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      ).map(({ file }) => file.replaceAll('\\', '/'));
    const expected = discover(commonArgs);
    const covered = discover([
      ...commonArgs,
      ...native[0].excludes.map((file) => `--exclude=${path.resolve(file).replaceAll('\\', '/')}`),
    ]);
    const specifications = covered.map((moduleId) => ({ moduleId, project: { name: project } }));
    const partitions = await Promise.all(
      native.map((group) => {
        const [index, count] = group.shard.split('/').map(Number);
        return new DawnSequencer({
          config: { root: process.cwd(), coverage: { enabled: true }, shard: { index, count } },
        }).shard(specifications);
      }),
    );
    assert.ok(partitions.every((partition) => partition.length > 0));
    assert.deepEqual(
      [
        ...partitions.flat().map(({ moduleId }) => moduleId),
        ...explicit.flatMap((group) => discover(group.files)),
      ].toSorted(),
      expected.toSorted(),
      `${project}: every complete instrumented file still runs exactly once`,
    );
  }
});

test('completed modeling children retain measured file and process work', () => {
  const timings = JSON.parse(
    readFileSync('scripts/ci/modeling-coverage-file-seconds.json', 'utf8'),
  );
  assert.ok(timings.runs.includes(42877243264));
  // All sixteen partitions and three isolated Modeling owners completed in
  // run 42877243264 despite an unrelated coverage shard reaching its deadline.
  for (const [file, seconds] of [
    ['packages/modeling/examples/mech-gt/__tests__/s6c.unit.test.ts', 233.607],
    [
      'packages/modeling/examples/maid-whale/__tests__/g6-faceted.import.integration.test.ts',
      275.552,
    ],
    ['packages/modeling/examples/case/__tests__/materials.unit.test.ts', 37.565],
    ['packages/modeling/src/__tests__/material-id-slots.unit.test.ts', 1.19],
    ['packages/modeling/examples/scifi-mech/__tests__/scifi-mech.watertight.unit.test.ts', 118.96],
    ['packages/modeling/examples/joint-boot/__tests__/boot.pack.integration.test.ts', 133.492],
    ['packages/modeling/src/__tests__/bake-parallel.integration.test.ts', 61.812],
    ['packages/modeling/examples/hood-linkage/__tests__/hood.unit.test.ts', 832.166],
    ['packages/modeling/examples/__tests__/scene-components.unit.test.ts', 756.707],
  ]) {
    assert.ok(timings.files[file] >= seconds, `retain completed file share: ${file}`);
  }
});

test('modeling reservations charge separately owned source work once', () => {
  const project = '@forgeax/engine-modeling';
  const covered = coverageGroups([project], 4).filter((group) => group.shard);
  const complete = coverageGroups([project], 4, { isolateFiles: false }).filter(
    (group) => group.shard,
  );
  const unchanged = covered.filter((group) => !['9/16', '10/16'].includes(group.shard));
  assert.ok(
    new Set(unchanged.map((group) => group.weight)).size > 1,
    'complete child receipts retain per-partition reservations',
  );
  assert.equal(covered.find((group) => group.shard === '10/16').weight, 1065);
  assert.equal(covered.find((group) => group.shard === '9/16').weight, 1095);
  assert.equal(new Set(complete.map((group) => group.weight)).size, 1);
  const coveredFloor = Math.min(...unchanged.map((group) => group.weight));
  assert.ok(
    complete[0].weight > coveredFloor,
    'separately owned source files must not be charged to ordinary coverage partitions',
  );
});

test('modeling partitions retain the complete native shard roster and bounded workers', () => {
  const project = '@forgeax/engine-modeling';
  for (const isolateFiles of [true, false]) {
    const groups = coverageGroups(['@forgeax/engine-math', project], 4, { isolateFiles });
    const modeling = groups.filter((group) => group.projects.includes(project));
    assert.equal(modeling.length, isolateFiles ? 19 : 16);
    const native = modeling.filter((group) => group.shard);
    const isolated = modeling.filter((group) => group.files.length > 0);
    const timings = JSON.parse(
      readFileSync(new URL('../modeling-coverage-file-seconds.json', import.meta.url), 'utf8'),
    );
    const omitted = new Set([
      ...native[0].excludes,
      ...(isolateFiles ? ['packages/modeling/src/__tests__/perf-tiers.unit.test.ts'] : []),
    ]);
    const averageForecast =
      Object.entries(timings.files).reduce(
        (sum, [file, seconds]) => sum + (omitted.has(file) ? 0 : seconds),
        0,
      ) / native.length;
    assert.ok(
      native.every((group) => group.weight >= averageForecast),
      'partition reservations cover their retained file forecast without charging separate owners',
    );
    assert.equal(isolated.length, isolateFiles ? 3 : 0);
    for (const group of isolated) {
      assert.equal(group.shard, undefined, 'an explicit file is never partitioned again');
      assert.equal(isExclusiveCoverageGroup(group), true);
    }
    assert.deepEqual(
      native.map((group) => group.shard),
      Array.from({ length: 16 }, (_, index) => `${index + 1}/16`),
    );
    for (const group of native) {
      assert.deepEqual(group.projects, [project]);
      assert.deepEqual(group.files, []);
      const args = buildGroupArgs({
        cliPath: 'vitest.mjs',
        group,
        maxWorkers: 1,
        coverage: isolateFiles,
        coverageDir: 'coverage',
        reportPath: 'report.json',
      });
      assert.ok(args.includes(`--shard=${group.shard}`));
      assert.ok(args.includes('--maxWorkers=1'));
      assert.ok(!args.some((arg) => /testTimeout|hookTimeout|testNamePattern/.test(arg)));
    }
    const assignment = assignCoverageShards(groups, 4);
    const manifests = Array.from({ length: 4 }, (_, shardIndex) => ({
      shardIndex,
      shardCount: 4,
      expectedGroups: groups.map((group) => group.label),
      groups: groups
        .filter((_group, index) => assignment[index] === shardIndex)
        .map((group) => group.label),
    }));
    validateShardManifests(
      manifests,
      groups.map((group) => group.label),
    );
    assert.throws(
      () =>
        validateShardManifests(
          manifests.map((manifest) => ({
            ...manifest,
            groups: manifest.groups.filter((label) => label !== modeling[0].label),
          })),
          groups.map((group) => group.label),
        ),
      /ran 0 times/,
    );
  }
});

test('isolates heavy projects while preserving bounded project order', () => {
  const groups = projectGroups(
    [
      '@forgeax/engine-before',
      '@forgeax/engine-devkit',
      '@forgeax/engine-rhi-wgpu',
      '@forgeax/engine-runtime',
      '@forgeax/engine-scene',
      '@forgeax/engine-shader',
      '@forgeax/engine-after',
      '@forgeax/engine-last',
    ],
    5,
  );

  assert.deepEqual(groups, [
    ['@forgeax/engine-before'],
    ['@forgeax/engine-devkit'],
    ['@forgeax/engine-rhi-wgpu'],
    ['@forgeax/engine-runtime'],
    ['@forgeax/engine-scene'],
    ['@forgeax/engine-shader', '@forgeax/engine-after', '@forgeax/engine-last'],
  ]);
  assert.ok(groups.every((group) => group.length <= 5));
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-rhi-wgpu')).length, 1);
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-runtime')).length, 1);
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-devkit')).length, 1);
  assert.equal(
    groups.some(
      (group) =>
        group.includes('@forgeax/engine-rhi-wgpu') && group.includes('@forgeax/engine-runtime'),
    ),
    false,
  );
  assert.equal(
    groups.some(
      (group) =>
        group.includes('@forgeax/engine-devkit') &&
        (group.includes('@forgeax/engine-rhi-wgpu') || group.includes('@forgeax/engine-runtime')),
    ),
    false,
  );
});

test('prioritizes long coverage groups and preserves canonical order for ties', () => {
  const groups = [10, 100, 100, 20].map((weight) => ({ weight }));
  assert.deepEqual(coverageGroupOrder(groups), [1, 2, 3, 0]);
});

test('coverage order averages budget-normalized costs across applicable replay windows', () => {
  const groups = [
    {
      weight: 100,
      replaySeconds: [100],
      replayBudgetSeconds: [2300],
      replayTypechecks: [false],
    },
    {
      weight: 90,
      replaySeconds: [300],
      replayBudgetSeconds: [2300],
      replayTypechecks: [false],
    },
    {
      weight: 1,
      startEarly: true,
      replaySeconds: [1],
      replayBudgetSeconds: [2300],
      replayTypechecks: [false],
    },
  ];
  assert.deepEqual(coverageGroupOrder(groups, false), [2, 1, 0]);
  assert.deepEqual(coverageGroupOrder(groups, true), [2, 0, 1]);
});

test('coverage shard scheduling preserves the full-roster replay order', () => {
  const groups = [
    { weight: 1, files: [] },
    { weight: 100, files: [] },
  ];
  assert.deepEqual(
    scheduledGroupOrder(groups, {
      coverage: true,
      localGpuLease: false,
      coverageOrder: [0, 1],
    }),
    [0, 1],
  );
});

test('each complete broad project half starts before fine-partition backfill', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  for (const typecheck of [true, false]) {
    const assignment = assignCoverageShards(groups, 4, { typecheck });
    for (let shard = 0; shard < 4; shard++) {
      const children = groups.filter((_group, index) => assignment[index] === shard);
      const order = scheduledGroupOrder(children, {
        coverage: true,
        localGpuLease: false,
        typecheck,
      });
      assert.ok(
        children[order[0]].shard?.endsWith('/2'),
        'run 41579286478 started Render half two after 25 minutes of Modeling backfill',
      );
      assert.equal(new Set(order).size, children.length, 'retain every complete child');
    }
  }
});

test('whole-child refinement removes a stranded parallel tail before exclusive work', () => {
  const groups = [50, 10, 50, 50, 10, 70, 30].map((weight, index) => ({
    label: `group-${index}`,
    weight,
    files: index === 1 || index === 5 ? [`fixture-${index}.test.ts`] : [],
  }));
  const assignment = assignCoverageShards(groups, 2, { typecheck: false });
  const lanes = Array.from({ length: 2 }, () => ({ slots: [0, 0], exclusive: 0 }));
  for (const index of coverageGroupOrder(groups)) {
    const group = groups[index];
    const lane = lanes[assignment[index]];
    if (group.files.length > 0) lane.exclusive += group.weight;
    else lane.slots[lane.slots[0] <= lane.slots[1] ? 0 : 1] += group.weight;
  }
  // The old greedy placement leaves 30 units before an 80-unit exclusive tail.
  // A complete-child move fits the same work into the other lane's spare slot.
  assert.equal(Math.max(...lanes.map((lane) => Math.max(...lane.slots) + lane.exclusive)), 100);
  assert.equal(assignment.length, groups.length);
  assert.deepEqual(assignCoverageShards(groups, 2, { typecheck: false }), assignment);
});

test('delegated native preparation runs without an outer GPU lease and stays native-last', () => {
  for (const isolateFiles of [false, true]) {
    const groups = coverageGroups(['@forgeax/engine-devkit'], 8, { isolateFiles });
    const worker = groups.find((group) =>
      group.files.includes('packages/devkit/src/__tests__/new-project-workers.e2e.test.ts'),
    );
    const scene = groups.find((group) =>
      group.files.includes('packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts'),
    );
    assert.notEqual(worker, scene);
    assert.equal(worker.gpuLease, false);
    assert.equal(scene.gpuLease, true);
    const order = scheduledGroupOrder(groups, { coverage: isolateFiles, localGpuLease: true });
    const native = new Set([groups.indexOf(worker), groups.indexOf(scene)]);
    assert.ok(order.slice(-2).every((index) => native.has(index)));
  }
});

test('local GPU admission queues native unit groups after every CPU group', () => {
  const groups = [
    { label: 'cpu-heavy', weight: 200, gpuLease: false, files: [] },
    { label: 'native', weight: 250, gpuLease: true, files: [] },
    { label: 'cpu-light', weight: 50, gpuLease: false, files: [] },
  ];
  assert.deepEqual(
    scheduledGroupOrder(groups, { coverage: true, localGpuLease: false }),
    [1, 0, 2],
  );
  assert.deepEqual(scheduledGroupOrder(groups, { coverage: true, localGpuLease: true }), [0, 2, 1]);
  assert.deepEqual(
    scheduledGroupOrder(groups, { coverage: false, localGpuLease: true }),
    [0, 2, 1],
  );
});

test('isolates a heavy test file into its own child and excludes it elsewhere', () => {
  const nativeFiles = [
    'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
    'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
  ];
  const liveProcessFile = 'packages/devkit/src/__tests__/live-dev-process.integration.test.ts';
  const liveClientFile = 'packages/devkit/src/__tests__/live-dev-client.test.ts';
  const workerIdentityFile =
    'packages/devkit/src/__tests__/worker-module-identity.integration.test.ts';
  const playFile = 'packages/devkit/src/__tests__/project-play.e2e.test.ts';
  const sceneFile = 'packages/scene/src/__tests__/flat-propagation.contract.test.ts';
  const bootstrapFile =
    'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts';
  const allFiles = [
    bootstrapFile,
    sceneFile,
    ...nativeFiles,
    liveProcessFile,
    liveClientFile,
    workerIdentityFile,
    playFile,
  ];
  const groups = coverageGroups(['@forgeax/engine-scene', '@forgeax/engine-devkit'], 8);
  assert.deepEqual(
    groups.map(({ projects, files, excludes, gpuLease }) => ({
      projects,
      files,
      excludes,
      gpuLease,
    })),
    [
      { projects: ['@forgeax/engine-scene'], files: [], excludes: allFiles, gpuLease: false },
      { projects: ['@forgeax/engine-scene'], files: [sceneFile], excludes: [], gpuLease: false },
      { projects: ['@forgeax/engine-devkit'], files: [], excludes: allFiles, gpuLease: false },
      { projects: ['@forgeax/engine-devkit'], files: [], excludes: allFiles, gpuLease: false },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [bootstrapFile],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [nativeFiles[0]],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [nativeFiles[1]],
        excludes: [],
        gpuLease: true,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [liveProcessFile],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [liveClientFile],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [workerIdentityFile],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [playFile],
        excludes: [],
        gpuLease: false,
      },
    ],
  );
  const unit = coverageGroups(['@forgeax/engine-devkit'], 8, { isolateFiles: false });
  assert.deepEqual(
    unit.map(({ files, excludes, gpuLease }) => [files, excludes, gpuLease]),
    [
      [[], nativeFiles, false],
      [[nativeFiles[0]], [], false],
      [[nativeFiles[1]], [], true],
    ],
  );
  assert.equal(unit.filter((group) => group.files.includes(nativeFiles[0])).length, 1);
  assert.equal(unit.filter((group) => group.files.includes(nativeFiles[1])).length, 1);
  assert.ok(isExclusiveCoverageGroup(unit[1]));
  assert.ok(isExclusiveCoverageGroup(unit[2]));
  assert.equal(
    unit[1].gpuLease,
    false,
    'Prepared Worker owner must not wait for its own launcher lease',
  );
  assert.equal(unit[2].gpuLease, true, 'Direct Scene owner still requires launcher admission');
  const ordinaryArgs = buildGroupArgs({
    cliPath: '/workspace/scripts/run-vitest-projects.mjs',
    group: unit[0],
    maxWorkers: 1,
    coverage: false,
  });
  for (const file of nativeFiles)
    assert.ok(ordinaryArgs.includes(`--exclude=${path.resolve(file).replaceAll('\\', '/')}`));
  for (const [index, file] of nativeFiles.entries()) {
    const nativeArgs = buildGroupArgs({
      cliPath: '/workspace/scripts/run-vitest-projects.mjs',
      group: unit[index + 1],
      maxWorkers: 1,
      coverage: false,
    });
    assert.ok(nativeArgs.includes(file));
    assert.equal(nativeFiles.filter((candidate) => nativeArgs.includes(candidate)).length, 1);
    assert.equal(
      nativeArgs.some((argument) => argument.startsWith('--exclude=')),
      false,
    );
  }
});

test('isolates the live ECS repository scan once and excludes it elsewhere', () => {
  const scanFile = 'packages/ecs/scripts/__tests__/grep-no-string-view-import.test.mjs';
  const scanFiles = [
    'packages/ecs/src/__tests__/errors.unit.test.ts',
    'packages/ecs/src/__tests__/source-scan.unit.test.ts',
    scanFile,
  ];
  const groups = coverageGroups(['@forgeax/engine-ecs', '@forgeax/engine-scene'], 8);
  const owners = groups.filter((group) => group.files.includes(scanFile));
  assert.equal(owners.length, 1);
  const {
    weight: _weight,
    observedSeconds,
    replaySeconds: _replaySeconds,
    replayReserved: _replayReserved,
    replayBudgetSeconds: _replayBudgetSeconds,
    replayTypechecks: _replayTypechecks,
    ...owner
  } = owners[0];
  assert.ok(Number.isFinite(observedSeconds) && observedSeconds > 0);
  assert.deepEqual(owner, {
    label: `@forgeax/engine-ecs:${scanFiles.join(',')}`,
    projects: ['@forgeax/engine-ecs'],
    files: scanFiles,
    excludes: [],
    gpuLease: false,
  });
  assert.ok(
    groups
      .filter((group) => !group.files.includes(scanFile))
      .every((group) => group.excludes.includes(scanFile) || group.files.length > 0),
  );

  const unsplit = coverageGroups(['@forgeax/engine-ecs'], 8, { isolateFiles: false });
  assert.deepEqual(
    unsplit.map(({ projects, files, excludes }) => ({ projects, files, excludes })),
    [{ projects: ['@forgeax/engine-ecs'], files: [], excludes: [] }],
  );
});

test('plans coverage shards by longest processing time with typecheck on shard 0', () => {
  const groups = [100, 90, 80, 70, 10].map((weight, index) => ({
    label: `g${index}`,
    projects: [`p${index}`],
    files: [],
    excludes: [],
    weight,
  }));
  assert.deepEqual(assignCoverageShards(groups, 3), [1, 2, 2, 1, 2]);
  assert.deepEqual(assignCoverageShards(groups, 3, { typecheck: false }), [0, 1, 2, 2, 2]);
  assert.deepEqual(assignCoverageShards(groups, 1), [0, 0, 0, 0, 0]);
  // The two ordinary children can overlap. The exclusive compiler cannot, so
  // placing it after either child would lengthen that shard from 300 s to 500 s.
  assert.deepEqual(
    assignCoverageShards(
      [
        { weight: 300, files: [] },
        { weight: 200, files: ['compiler.test.ts'] },
        { weight: 300, files: [] },
      ],
      2,
      { typecheck: false },
    ),
    [1, 0, 1],
  );
});

test('merges only an exact partition of the recomputed coverage roster', () => {
  const expectedGroups = ['a', 'b', 'c'];
  const shard = (shardIndex, groups) => ({ shardIndex, shardCount: 2, expectedGroups, groups });
  validateShardManifests([shard(1, ['c']), shard(0, ['a', 'b'])], expectedGroups);
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b'])], expectedGroups),
    /expected 2 shard manifests, found 1.*group c ran 0 times/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(1, ['b', 'c'])], expectedGroups),
    /group b ran 2 times/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(0, ['c'])], expectedGroups),
    /shard indexes must be 0\.\.1 exactly once/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(1, ['c'])], ['a', 'b', 'c', 'd']),
    /planned a different coverage group roster/,
  );
});

test('re-roots shard coverage so runners with different checkouts merge per file', () => {
  const entry = (root) => ({
    [`${root}/packages/math/src/vec3.ts`]: {
      path: `${root}/packages/math/src/vec3.ts`,
      s: { 0: 1 },
    },
  });
  const portable = rerootCoverage(entry('/runner-a/work'), '/runner-a/work', '');
  assert.deepEqual(portable, {
    'packages/math/src/vec3.ts': { path: 'packages/math/src/vec3.ts', s: { 0: 1 } },
  });
  const mergedFile = path.join('/merge/work', 'packages/math/src/vec3.ts');
  assert.deepEqual(rerootCoverage(portable, '', '/merge/work'), {
    [mergedFile]: { path: mergedFile, s: { 0: 1 } },
  });
  assert.deepEqual(
    rerootCoverage(rerootCoverage(entry('/runner-b/x'), '/runner-b/x', ''), '', '/merge/work'),
    rerootCoverage(portable, '', '/merge/work'),
  );
  assert.throws(
    () => rerootCoverage(entry('/elsewhere'), '/runner-a/work', ''),
    /outside \/runner-a\/work/,
  );
});

test('re-roots the FileCoverage instances an istanbul CoverageMap serializes', () => {
  const rootRequire = createRequire(import.meta.url);
  const providerRequire = createRequire(rootRequire.resolve('@vitest/coverage-v8'));
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
  const file = '/runner-a/work/packages/math/src/vec3.ts';
  const map = createCoverageMap({
    [file]: {
      path: file,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: 1 },
      f: {},
      b: {},
    },
  });
  const portable = rerootCoverage(map.toJSON(), '/runner-a/work', '');
  const merged = createCoverageMap({});
  merged.merge(JSON.parse(JSON.stringify(rerootCoverage(portable, '', '/merge/work'))));
  assert.deepEqual(merged.files(), [path.join('/merge/work', 'packages/math/src/vec3.ts')]);
  assert.equal(merged.getCoverageSummary().statements.covered, 1);
});

test('requires a shard output directory and rejects mixed shard modes', () => {
  const options = parseArgs(['--shard-index=2', '--shard-count=3', '--shard-output-dir=out']);
  assert.equal(options.shardIndex, 2);
  assert.equal(options.shardCount, 3);
  assert.throws(() => parseArgs(['--shard-count=3']), /requires --shard-output-dir/);
  assert.throws(
    () => parseArgs(['--shard-index=3', '--shard-count=3', '--shard-output-dir=out']),
    /below --shard-count/,
  );
  assert.throws(() => parseArgs(['--shard-count=5']), /--shard-count must be an integer/);
  assert.throws(
    () => parseArgs(['--merge-shards=in', '--shard-output-dir=out']),
    /cannot be combined/,
  );
});

test('runs coverage groups at the requested bound and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const groups = [['slow'], ['fast'], ['middle'], ['last']];
  const delays = [30, 5, 15, 1];

  const results = await runGroups({
    groups,
    concurrency: 2,
    runGroupImpl: async (group, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      active -= 1;
      completed.push(group[0]);
      return `${group[0]}-result`;
    },
  });

  assert.equal(peak, 2);
  assert.notDeepEqual(completed, groups.flat());
  assert.deepEqual(
    results,
    groups.map(([name]) => `${name}-result`),
  );
});

test('executes weighted order while preserving canonical result order', async () => {
  const completed = [];
  const groups = [['small'], ['long'], ['middle']];
  const results = await runGroups({
    groups,
    concurrency: 1,
    order: [1, 2, 0],
    runGroupImpl: async (group, index) => {
      completed.push(index);
      return group[0];
    },
  });

  assert.deepEqual(completed, [1, 2, 0]);
  assert.deepEqual(results, ['small', 'long', 'middle']);
});

test('stops scheduling new groups after the first failure', async () => {
  const started = [];

  await assert.rejects(
    runGroups({
      groups: [['fail'], ['in-flight'], ['must-not-start'], ['also-must-not-start']],
      concurrency: 2,
      runGroupImpl: async ([name]) => {
        started.push(name);
        if (name === 'fail') throw new Error('expected failure');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return name;
      },
    }),
    /expected failure/,
  );

  assert.deepEqual(started, ['fail', 'in-flight']);
});

test('repository scan files have one exclusive coverage owner and remain in the complete roster', async () => {
  const files = [
    'packages/ecs/src/__tests__/errors.unit.test.ts',
    'packages/ecs/src/__tests__/source-scan.unit.test.ts',
    'packages/ecs/scripts/__tests__/grep-no-string-view-import.test.mjs',
  ];
  const groups = coverageGroups(['@forgeax/engine-ecs', '@forgeax/engine-scene'], 8);
  for (const file of files) {
    assert.equal(groups.filter((group) => group.files.includes(file)).length, 1);
    assert.ok(
      groups
        .filter((group) => !group.files.includes(file))
        .every((group) => group.excludes.includes(file) || group.files.length > 0),
    );
  }
  const active = new Set();
  let scanRuns = 0;
  await runGroups({
    groups,
    concurrency: 2,
    order: coverageGroupOrder(groups),
    isExclusive: isExclusiveCoverageGroup,
    runGroupImpl: async (group) => {
      if (group.files.length > 0) {
        assert.equal(active.size, 0);
        scanRuns++;
      } else assert.ok(![...active].some(isExclusiveCoverageGroup));
      active.add(group);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (group.files.length > 0) assert.equal(active.size, 1);
      active.delete(group);
      return group.label;
    },
  });
  assert.equal(scanRuns, 2);
});

test('cold Standard compilation and worker parity each have one exclusive instrumented owner', () => {
  const cases = [
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/node-program-compiler.integration.test.ts',
    ],
    [
      '@forgeax/engine-vite-plugin-pack',
      'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
    ],
    [
      '@forgeax/engine-vite-plugin-pack',
      'packages/vite-plugin-pack/src/__tests__/declared-standard-material.integration.test.ts',
    ],
  ];
  const groups = coverageGroups(
    [
      '@forgeax/engine-shader-compiler',
      '@forgeax/engine-vite-plugin-pack',
      '@forgeax/engine-naga',
      'unit',
    ],
    8,
  );
  for (const [project, file] of cases) {
    const owners = groups.filter((group) => group.files.includes(file));
    assert.equal(owners.length, 1, file);
    assert.ok(isExclusiveCoverageGroup(owners[0]));
    assert.deepEqual(owners[0].projects, [project]);
    assert.ok(
      groups
        .filter((group) => group !== owners[0])
        .every((group) => group.files.length > 0 || group.excludes.includes(file)),
    );
  }
});

test('large source and production recovery files have one exclusive instrumented owner', () => {
  const expected = new Map([
    [
      'packages/render/src/__tests__/gpu-driven-batch-topology-pbr.unit.test.ts',
      '@forgeax/engine-render',
    ],
    [
      'packages/render/src/__tests__/direct-shadow-preparation.integration.test.ts',
      '@forgeax/engine-render',
    ],
    [
      'packages/render/src/__tests__/gpu-driven-production.integration.test.ts',
      '@forgeax/engine-render',
    ],
    [
      'packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
      '@forgeax/engine-render',
    ],
    [
      'packages/shader/src/__tests__/default-standard-pbr-transmission.unit.test.ts',
      '@forgeax/engine-shader',
    ],
    ['packages/shader/src/__tests__/material-program.test.ts', '@forgeax/engine-shader'],
    [
      'packages/rhi-webgpu/src/__tests__/pipeline-library.unit.test.ts',
      '@forgeax/engine-rhi-webgpu',
    ],
  ]);
  const groups = coverageGroups(
    ['@forgeax/engine-render', '@forgeax/engine-shader', '@forgeax/engine-rhi-webgpu', 'unit'],
    8,
  );
  for (const [file, project] of expected) {
    const owners = groups.filter((group) => group.files.includes(file));
    assert.equal(owners.length, 1, file);
    assert.ok(isExclusiveCoverageGroup(owners[0]), file);
    assert.deepEqual(owners[0].projects, [project]);
    assert.ok(
      groups
        .filter((group) => group !== owners[0])
        .every((group) =>
          group.files.length > 0 ? !group.files.includes(file) : group.excludes.includes(file),
        ),
      file,
    );
  }
});

test('run 41970460421 fits the original job window using its completed compiler receipt', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-41970460421.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 44);
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const replay = ledger.replayRuns.findIndex(
    (run) => (run.runId ?? run.run) === (receipt.runId ?? receipt.run),
  );
  assert.ok(replay >= 0, 'retain the original completed-child replay');
  assert.deepEqual(ledger.replayRuns[replay].completedSeconds, receipt.completedSeconds);
  const groups = coverageGroups(allProjectNames(), 8);
  // Primary owns the complete typecheck preflight; coverage executes runtime children.
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay);
  assert.ok(
    Math.max(...finishes) <= 2450,
    `44 completed children plus unchanged forecasts must leave setup headroom: ${finishes}`,
  );
  const source = groups.find((group) =>
    group.files.includes(
      'packages/vite-plugin-shader/src/__tests__/direct-dfg-manifest.integration.test.ts',
    ),
  );
  assert.ok(source.weight >= 920, 'retain the conservative source reservation');
  assert.equal(
    receipt.completedSeconds[source.label],
    413.3,
    'only the complete source child supplies a measured replay cost',
  );
});

test('coverage admission bounds child-process tails when completed forecasts understate a lane', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4);
  const counts = Array.from(
    { length: 4 },
    (_, lane) => assignment.filter((value) => value === lane).length,
  );
  assert.ok(
    Math.max(...counts) <= 16,
    `retain setup/serial-tail headroom instead of stranding 21 children: ${counts}`,
  );
});

test('run 41987337840 retains every completed child and leaves room for the six unfinished owners', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-41987337840.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 54);
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const replay = ledger.replayRuns.findIndex(
    (run) => (run.runId ?? run.run) === (receipt.runId ?? receipt.run),
  );
  assert.ok(replay >= 0, 'retain the original completed-child replay');
  assert.deepEqual(ledger.replayRuns[replay].completedSeconds, receipt.completedSeconds);
  const groups = coverageGroups(allProjectNames(), 8);
  // Primary owns the complete typecheck preflight; coverage executes runtime children.
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay);
  assert.ok(
    Math.max(...finishes) <= 2300,
    `the interrupted lane retains every unmeasured owner inside the original job window: ${finishes}`,
  );
});

test('coverage qualification retains raw reservations and admits their larger current forecasts', () => {
  const groups = [
    {
      label: 'unfinished',
      files: ['unfinished.test.ts'],
      weight: 30,
      replaySeconds: [10],
      replayReserved: [true],
    },
    {
      label: 'complete',
      files: ['complete.test.ts'],
      weight: 100,
      replaySeconds: [5],
      replayReserved: [false],
    },
  ];
  const assignment = [0, 0];
  assert.deepEqual(coverageAssignmentLaneFinishes(groups, assignment, 1, false, true, 0), [15]);
  assert.deepEqual(
    coverageAssignmentLaneFinishes(groups, assignment, 1, false, true, 0, true, 'retained-max'),
    [35],
  );
  assert.deepEqual(
    groups.map((group) => group.replaySeconds),
    [[10], [5]],
  );
});

test('run 42310641606 retains 49 complete children and all eleven unfinished reservations', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42310641606.json', import.meta.url),
      'utf8',
    ),
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 49);
  assert.equal(receipt.interruptedGroups.length, 2);
  assert.equal(receipt.unstartedGroups.length, 9);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups])
    assert.equal(receipt.completedSeconds[label], undefined);
  const replay = ledger.replayRuns.findIndex((run) => run.runId === receipt.runId);
  assert.ok(replay >= 0, 'retain the original complete-child replay');
  assert.deepEqual(ledger.replayRuns[replay].completedSeconds, receipt.completedSeconds);
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay);
  assert.ok(
    Math.max(...finishes) <= 2300,
    `complete observations plus unchanged unfinished reservations retain setup headroom: ${finishes}`,
  );
});

test('replanning a changed roster does not retain its prior traversal order', () => {
  const groups = [50, 10, 50, 50, 10, 70, 30].map((weight, index) => ({
    label: `mutable-${index}`,
    projects: [`project-${index}`],
    files: [],
    weight,
  }));
  const before = assignCoverageShards(groups, 2, { typecheck: false });
  groups[0].weight = 500;
  const actual = assignCoverageShards(groups, 2, { typecheck: false });
  const fresh = assignCoverageShards(
    groups.map((group) => ({ ...group })),
    2,
    { typecheck: false },
  );
  assert.notDeepEqual(fresh, before, 'the changed cost must require a different plan');
  assert.deepEqual(actual, fresh, 'live input changes match a fresh planning invocation');
});

test('run 42262364048 rebalances completed work without inventing a bake sample', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42262364048.json', import.meta.url),
      'utf8',
    ),
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 52);
  const bake = '@forgeax/engine-modeling:packages/modeling/src/__tests__/bake-cage.unit.test.ts';
  assert.equal(receipt.completedSeconds[bake], undefined);
  assert.deepEqual(receipt.interruptedGroups, [bake]);
  assert.notEqual(ledger.latestRun, receipt.runId);
  const replay = ledger.replayRuns.findIndex((run) => run.runId === receipt.runId);
  assert.deepEqual(ledger.replayRuns[replay].completedSeconds, receipt.completedSeconds);
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay);
  assert.ok(
    Math.max(...finishes) <= 2300,
    `completed work and unfinished reservations retain setup headroom: ${finishes}`,
  );
  assert.equal(groups.find((group) => group.label === bake).reservationWeight, 200);
});

test('run 42351811353 keeps completed slow-run observations within existing setup headroom', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42351811353.json', import.meta.url),
      'utf8',
    ),
  );
  const groups = coverageGroups(allProjectNames(), 8);
  assert.equal(Object.keys(receipt.completedSeconds).length, 56);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 3);
  assert.deepEqual(
    [
      ...Object.keys(receipt.completedSeconds),
      ...receipt.interruptedGroups,
      ...receipt.unstartedGroups,
      ...coldOwnerLabels,
    ].sort(),
    groups.map((group) => group.label).sort(),
    'all sixty complete owners remain accounted for exactly once',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `retain the original setup headroom and unfinished-owner forecasts: ${finishes}`,
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'partial observations cannot replace the admitted cohort',
  );
  assert.deepEqual(
    ledger.replayRuns.find((run) => run.runId === receipt.runId)?.completedSeconds,
    receipt.completedSeconds,
  );
});

test('run 42367192490 keeps another completed slow Modeling wave within existing setup headroom', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-42367192490.json', import.meta.url),
      'utf8',
    ),
  );
  const groups = coverageGroups(allProjectNames(), 8);
  assert.equal(Object.keys(receipt.completedSeconds).length, 56);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 3);
  assert.deepEqual(
    [
      ...Object.keys(receipt.completedSeconds),
      ...receipt.interruptedGroups,
      ...receipt.unstartedGroups,
      ...coldOwnerLabels,
    ].sort(),
    groups.map((group) => group.label).sort(),
    'all sixty complete owners remain accounted for exactly once',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `retain the original setup headroom and unfinished-owner forecasts: ${finishes}`,
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'partial observations cannot replace the admitted cohort',
  );
  assert.deepEqual(
    ledger.replayRuns.find((run) => run.runId === receipt.runId)?.completedSeconds,
    receipt.completedSeconds,
  );
});
