import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { DawnSequencer } from '../../../config/vitest-dawn-sequencer.ts';
import { runGroups } from '../../lib/run-bounded-groups.mjs';
import { coreDeferredCoverageFiles, localModelingShowcases } from '../core-validation.mjs';

const coldCoverageFiles = [
  'packages/app/__tests__/builtin-systems.test.ts',
  'packages/codec/scripts/__tests__/fetch-basis.test.mjs',
  'packages/three/src/__tests__/api-audit.test.ts',
];
const coldOwnerLabels = [
  `${coldCoverageFiles.map((file) => `@forgeax/engine-${file.split('/')[1]}`).join(',')}:${coldCoverageFiles.join(',')}`,
];

const historicalCoverageReceipt = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-completed-41828488495.json', import.meta.url)),
);
// Replay the original input roster. Newly registered projects still execute in
// today's runner, but cannot rewrite a completed child's identity or cost.
const historicalCoverageProjects = [
  ...new Set(
    [
      ...Object.keys(historicalCoverageReceipt.completedSeconds),
      historicalCoverageReceipt.interruptedGroup,
    ].flatMap((label) => label.split(':')[0].split(',')),
  ),
].sort();

const standardTransmissionFiles = ['dry-rgba32', 'dry-rgba16', 'waves-rgba32', 'waves-rgba16'].map(
  (mode) => `packages/shader/src/__tests__/standard-transmission-${mode}.unit.test.ts`,
);
const standardAliasFile =
  'packages/shader-compiler/src/__tests__/material-standard-alias.unit.test.ts';
const materialCompilerSplitFile =
  'packages/shader-compiler/src/material/__tests__/ray-surface-derivatives.integration.test.ts';
const meshIoFormatFile = 'packages/mesh-io/src/__tests__/formats.integration.test.ts';
const devkitBootstrapCommandsFile = 'packages/devkit/src/__tests__/bootstrap-commands.test.ts';
const previouslySharedFiles = new Set([meshIoFormatFile, devkitBootstrapCommandsFile]);

function restoreHistoricalSharedCoverage(groups) {
  // Historical coverage receipts include these suites in their shared children.
  return groups
    .filter((group) => !group.files.some((file) => previouslySharedFiles.has(file)))
    .map((group) => ({
      ...group,
      excludes: group.excludes.filter((file) => !previouslySharedFiles.has(file)),
    }));
}

function coverageGroupsForHistoricalReceipts(projects, size, options) {
  const groups = restoreHistoricalSharedCoverage(
    coverageGroups(projects, size, {
      ...options,
      includeLocalShowcases: true,
      historicalModeling: true,
    }),
  );
  const split = groups.find((group) => group.files.includes(materialCompilerSplitFile));
  const ledger =
    options?.completed ??
    JSON.parse(
      readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
    );
  return groups
    .filter(
      (group) =>
        group !== split &&
        !group.files.some(
          (file) => file === standardAliasFile || standardTransmissionFiles.includes(file),
        ),
    )
    .map((group) => {
      if (split === undefined || split.splitFromReceipt !== group.label) return group;
      // Older observations charged both batches to a single serial owner.
      const reserved = ledger.groups[group.label]?.reservedSeconds ?? 0;
      return {
        ...group,
        files: [...group.files, ...split.files],
        weight: Math.max(40, Math.ceil(reserved / 5) * 5),
        reservationWeight: Math.max(
          975,
          ...ledger.replayRuns.map(
            (run) => Math.ceil((run.completedSeconds[group.label] ?? 0) / 5) * 5,
          ),
        ),
      };
    });
}

function historicalCoverageGroups(options) {
  return coverageGroupsForHistoricalReceipts(historicalCoverageProjects, 8, options);
}

function waterCoverageGroupsThrough(runId) {
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const receipt = JSON.parse(
    readFileSync(new URL(`./fixtures/coverage-completed-${runId}.json`, import.meta.url), 'utf8'),
  );
  const admittedProjects = new Set(
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)].flatMap(
      (label) => label.split(':')[0].split(','),
    ),
  );
  // New Node apps execute today; a completed cohort keeps only its own roster.
  return coverageGroupsForHistoricalReceipts(
    allProjectNames().filter((name) => admittedProjects.has(name)),
    8,
    {
      completed: {
        ...ledger,
        replayRuns: ledger.replayRuns.filter(
          (run) => run.runId === undefined || run.runId <= runId,
        ),
      },
    },
  );
}

test('historical coverage replay preserves its roster while current CI includes new projects', () => {
  const currentProjects = allProjectNames();
  const current = coverageGroups(currentProjects, 8);
  const historical = historicalCoverageGroups();
  assert.deepEqual(
    [...new Set(current.flatMap((group) => group.projects))].sort(),
    currentProjects.toSorted(),
  );
  assert.deepEqual(
    [...new Set(historical.flatMap((group) => group.projects))].sort(),
    historicalCoverageProjects,
  );
  assert.ok(current.some((group) => group.projects.includes('@forgeax/engine-water')));
  assert.equal(historicalCoverageProjects.includes('@forgeax/engine-water'), false);
  assert.equal(historical.length, 61);
  assert.equal(new Set(current.map((group) => group.label)).size, current.length);
});

// Preserve the admitted cohort's launch order while substituting each receipt's
// complete costs and explicit reservations. Clearing observations also changes
// coverageGroupOrder and replays an execution order the producer never uses.
test('nightly 42778322662 retains complete children and every unfinished forecast', (t) => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/coverage-completed-42778322662.json', import.meta.url)),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 54);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 7);
  const groups = historicalCoverageGroups();
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

test('run 43668054135 cold-source forecast retains its original provenance and window', (t) => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/coverage-completed-43668054135.json', import.meta.url)),
  );
  const groups = waterCoverageGroupsThrough(43668054135);
  assert.equal(groups.length, 64);
  assert.equal(Object.keys(receipt.completedSeconds).length, 61);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 3);
  const sources = groups.filter((group) => group.label in receipt.reservedSeconds);
  assert.equal(sources.length, 3);
  assert.equal(sources.flatMap((group) => group.files).length, 5);
  assert.equal(new Set(sources.flatMap((group) => group.files)).size, 5);
  for (const source of sources) {
    assert.equal(source.sourceCompilation, true);
    assert.equal(source.weight, receipt.reservedSeconds[source.label]);
    assert.equal(receipt.completedSeconds[source.label], undefined);
  }
  assert.equal(receipt.sourceForecast.directDfgCompleted, false);
  const ledger = JSON.parse(readFileSync('scripts/ci/coverage-completed-child-seconds.json'));
  const replay = ledger.replayRuns.findIndex((run) => run.runId === receipt.runId);
  assert.deepEqual(ledger.replayRuns[replay], receipt);
  const previous = groups.map((group) =>
    sources.includes(group)
      ? 3
      : receipt.originalJobs.find((job) => job.groups.includes(group.label)).shardIndex,
  );
  const oldFinishes = coverageAssignmentLaneFinishes(groups, previous, 4, false, true, replay);
  assert.ok(
    Math.max(...oldFinishes) > receipt.budgetSeconds,
    'old placement consumes setup headroom',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, replay);
  t.diagnostic(
    `current measured children plus unfinished forecast: ${finishes.map((s) => s.toFixed(2))}`,
  );
  assert.ok(Math.max(...finishes) <= receipt.budgetSeconds, `retain setup headroom: ${finishes}`);
  assert.ok(new Set(sources.map((group) => assignment[groups.indexOf(group)])).size >= 2);
  validateShardManifests(
    Array.from({ length: 4 }, (_, shardIndex) => ({
      shardIndex,
      shardCount: 4,
      expectedGroups: groups.map((group) => group.label),
      groups: groups
        .filter((_group, index) => assignment[index] === shardIndex)
        .map((group) => group.label),
    })),
    groups.map((group) => group.label),
  );
});

test('run 43703295156 retains complete costs and a full direct-DFG case reservation', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-43703295156.json', import.meta.url),
      'utf8',
    ),
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    ledger.replayRuns.find((run) => run.runId === receipt.runId),
    receipt,
  );
  assert.notEqual(
    ledger.latestRun,
    receipt.runId,
    'a partial cohort cannot replace the complete seed',
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 49);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 15);
  assert.equal(receipt.failedGroups.length, 1);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 13);
  assert.equal(
    receipt.originalJobs.reduce((sum, job) => sum + job.groups.length, 0),
    49,
  );
  const groups = waterCoverageGroupsThrough(receipt.runId);
  assert.deepEqual(
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)].sort(),
    groups.map((group) => group.label).sort(),
  );
  for (const label of [
    ...receipt.failedGroups,
    ...receipt.interruptedGroups,
    ...receipt.unstartedGroups,
  ])
    assert.equal(
      receipt.completedSeconds[label],
      undefined,
      'incomplete work supplies no timing sample',
    );
  const file = 'packages/vite-plugin-shader/src/__tests__/direct-dfg-manifest.integration.test.ts';
  const dfg = groups.find((group) => group.files.includes(file));
  assert.equal(dfg.weight, 530, 'the original placement forecast remains intact');
  assert.equal(dfg.reservationWeight, 900, 'reserve the original complete case budget');
  assert.equal(dfg.observedSeconds, undefined);
  assert.deepEqual(dfg.replaySeconds, [900]);
  assert.deepEqual(dfg.replayReserved, [true]);
  const earlier = waterCoverageGroupsThrough(43668054135).find((group) =>
    group.files.includes(file),
  );
  assert.deepEqual(earlier.replaySeconds, [530], 'the earlier forecast remains frozen');
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, 0);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `complete costs and unfinished forecasts retain setup headroom: ${finishes}`,
  );
});

test('run 43744332755 retains complete children and every unfinished owner within the original window', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL('./fixtures/coverage-completed-43744332755.json', import.meta.url),
      'utf8',
    ),
  );
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    ledger.replayRuns.find((run) => run.runId === receipt.runId),
    receipt,
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 58);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 6);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 5);
  assert.equal(receipt.originalJobs.flatMap((job) => job.groups).length, 58);
  assert.equal(
    receipt.originalJobs.every(
      (job) => job.runId === receipt.runId && job.sourceHead === receipt.head && !job.inherited,
    ),
    true,
  );
  const groups = waterCoverageGroupsThrough(receipt.runId);
  assert.deepEqual(
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)].sort(),
    groups.map((group) => group.label).sort(),
  );
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups])
    assert.equal(receipt.completedSeconds[label], undefined);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const finishes = coverageAssignmentLaneFinishes(groups, assignment, 4, false, true, 0);
  assert.ok(Math.max(...finishes) <= 2300, `retain the original setup headroom: ${finishes}`);
});

test('GTAO publication admission shares the exclusive CPU contract batch exactly once', () => {
  const file = 'packages/runtime/src/__tests__/gtao-deferred-admission.integration.test.ts';
  const groups = coverageGroups(allProjectNames(), 8);
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.equal(owner.label, coldOwnerLabels[0], 'retain the original three-file timing identity');
  assert.ok(isExclusiveCoverageGroup(owner));
  assert.equal(owner.gpuLease, false, 'Null-RHI admission is CPU work');
  assert.equal(
    owner.sourceCompilation,
    false,
    'the complete published profile is loaded, not cooked',
  );
  assert.equal(owner.reservationWeight, 155, 'reserve all original case bounds and one startup');
  assert.deepEqual(
    owner.files.toSorted(),
    [
      ...coldCoverageFiles,
      file,
      'packages/vite-plugin-shader/src/__tests__/standard-material-cold-cook.unit.test.ts',
    ].toSorted(),
  );
  assert.ok(
    groups
      .filter((group) => group.files.length === 0)
      .every((group) => group.excludes.includes(file)),
  );
  const single = coverageGroups(['@forgeax/engine-runtime'], 8).find((group) =>
    group.files.includes(file),
  );
  assert.equal(single.label, `@forgeax/engine-runtime:${file}`);
  assert.equal(
    single.observedSeconds,
    undefined,
    'a partial selection cannot claim the old batch receipt',
  );
});

test('cold source and TypeScript files drain neighboring instrumented children', async () => {
  const groups = waterCoverageGroupsThrough(43668054135);
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
  assert.equal(results.length, groups.length);
  assert.equal(new Set(results).size, groups.length);
  for (const file of coldCoverageFiles) {
    const [owner] = owners.filter((group) => group.files.includes(file));
    assert.deepEqual(
      owner.files.toSorted(),
      [
        ...coldCoverageFiles,
        'packages/runtime/src/__tests__/gtao-deferred-admission.integration.test.ts',
        'packages/vite-plugin-shader/src/__tests__/standard-material-cold-cook.unit.test.ts',
      ].toSorted(),
    );
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
    assert.equal(owner.observedSeconds, 20.34, 'retain the qualified original completed child');
    assert.equal(owner.weight, 0, 'historical project receipts already contain this case work');
    assert.equal(
      owner.reservationWeight,
      155,
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
  const groups = waterCoverageGroupsThrough(43668054135);
  const files = [
    'packages/gltf/src/__tests__/diffuse-transmission-import.integration.test.ts',
    'packages/gltf/src/__tests__/physical-material-import.integration.test.ts',
    'packages/import/src/__tests__/browser-package-build.integration.test.ts',
    'packages/pack/src/__tests__/material-surface-publication.unit.test.ts',
    'packages/pack/src/__tests__/scriptable-pack-json.integration.test.ts',
    'packages/runtime/src/__tests__/custom-surface-publication.integration.test.ts',
    'packages/vite-plugin-pack/src/__tests__/authored-pack-serving.regression.test.ts',
  ];
  const receiptFile = 'packages/pack/src/__tests__/material-surface-publication.unit.test.ts';
  const owner = groups.find((group) => group.files.includes(receiptFile));
  assert.deepEqual(owner.files, files);
  assert.deepEqual(owner.projects, [
    '@forgeax/engine-gltf',
    '@forgeax/engine-import',
    '@forgeax/engine-pack',
    '@forgeax/engine-runtime',
    '@forgeax/engine-vite-plugin-pack',
  ]);
  assert.equal(
    owner.label,
    `@forgeax/engine-pack:${receiptFile}`,
    'the explicit historical receipt owns identity even when another project is visited first',
  );
  assert.equal(owner.reservationWeight, 220, 'reserve all cases and one cold startup');
  assert.equal(owner.sourceCompilation, true);
  assert.equal(owner.packagesOnly, true);
  assert.equal(
    owner.observedSeconds,
    31.5,
    'retain the qualified original complete child observation',
  );
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
  const groups = historicalCoverageGroups();
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
    const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const seed = ledger.placementSeeds.find((seed) => seed.typecheck === false);
  assert.equal(seed.kind, 'forecast-only', 'a placement forecast is not executed CI evidence');
  assert.ok(coveragePlacementSeed(groups, 4, false, seed));
  assert.ok(
    coveragePlacementSeed(coverageGroupsForHistoricalReceipts(allProjectNames(), 8), 4, false),
  );
  assert.equal(coveragePlacementSeed(coverageGroups(allProjectNames(), 8), 4, false), null);
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
  const groups = historicalCoverageGroups();
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

  const groups = historicalCoverageGroups();
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

  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  coverageGroupEnvironment,
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

test('complete Standard cold cooks share the existing exclusive source-contract child', () => {
  const file = 'packages/vite-plugin-shader/src/__tests__/standard-material-cold-cook.unit.test.ts';
  const groups = coverageGroups(allProjectNames(), 8);
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.ok(owner.files.includes('packages/app/__tests__/builtin-systems.test.ts'));
  assert.ok(
    owner.files.includes(
      'packages/runtime/src/__tests__/gtao-deferred-admission.integration.test.ts',
    ),
  );
  assert.equal(owner.reservationWeight, 155);
  assert.ok(isExclusiveCoverageGroup(owner));
  assert.equal(
    coverageGroupMaxWorkers(
      owner,
      { coverage: true, maxWorkers: 2 },
      { cpus: 8, memoryBytes: 16_000_000_000 },
      2,
    ),
    1,
  );
  assert.ok(
    groups
      .filter((group) => group.files.length === 0)
      .every((group) => group.excludes.includes(file)),
  );
});

test('cold mounted asset libraries share the existing exclusive DevKit publication owner', () => {
  const file = 'packages/devkit/src/__tests__/asset-libraries.integration.test.ts';
  const previous = 'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts';
  const groups = coverageGroups(allProjectNames(), 8);
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.deepEqual(owner.files, [
    previous,
    file,
    'packages/devkit/src/__tests__/host-authoring-publication.integration.test.ts',
  ]);
  assert.equal(owner.label, ['@forgeax/engine-devkit', previous].join(':'));
  assert.ok(isExclusiveCoverageGroup(owner));
  assert.equal(
    coverageGroupMaxWorkers(
      owner,
      { coverage: true, maxWorkers: 2 },
      { cpus: 8, memoryBytes: 16_000_000_000 },
      2,
    ),
    1,
  );
  assert.equal(owner.reservationWeight, 225);
  assert.ok(
    groups
      .filter((group) => group.files.length === 0)
      .every((group) => group.excludes.includes(file)),
  );
});

test('cold source coverage validates each owner heap and compiler budget', () => {
  const groups = coverageGroups(allProjectNames(), 8);
  const sources = groups.filter((group) => group.sourceCompilation);
  assert.equal(sources.length, 12 + standardTransmissionFiles.length);
  for (const file of [
    'packages/render/src/__tests__/direct-shadow-preparation.integration.test.ts',
    'packages/render/src/__tests__/direct-preparation.integration.test.ts',
    'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
  ]) {
    const owner = sources.find((group) => group.files.includes(file));
    assert.equal(owner?.packagesOnly, true, file);
  }
  const original = { NODE_OPTIONS: '--import=probe.mjs --max-old-space-size=4096', KEEP: 'yes' };
  for (const group of sources) {
    assert.ok(isExclusiveCoverageGroup(group));
    assert.equal(
      coverageGroupMaxWorkers(
        group,
        parseArgs(['--max-workers=2']),
        { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
        2,
      ),
      1,
    );
    const serialWorkerLimit = [
      ['packages/pack/src/__tests__/material-surface-publication.unit.test.ts', '7'],
      [
        'packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts',
        '7',
      ],
      [standardAliasFile, '7'],
      [materialCompilerSplitFile, '7'],
      [
        'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
        '6',
      ],
    ].find(([file]) => group.files.includes(file))?.[1];
    const budgets = serialWorkerLimit
      ? [
          [8, 4096, '2'],
          [16, 4096, serialWorkerLimit],
          [48, 4096, serialWorkerLimit],
        ]
      : [
          [8, 4096, '2'],
          [16, 8192, '4'],
          [48, 24576, '4'],
        ];
    for (const [capacityGiB, heapMiB, workers] of budgets) {
      const env = coverageGroupEnvironment(
        group,
        { cpus: 8, memoryBytes: capacityGiB * 1024 ** 3 },
        7,
        original,
      );
      assert.ok(env.NODE_OPTIONS.endsWith(`--max-old-space-size=${heapMiB}`));
      assert.ok(env.NODE_OPTIONS.startsWith('--import=probe.mjs'));
      assert.equal(env.FORGEAX_SHADER_COMPILE_WORKERS, workers);
      assert.equal(env.KEEP, 'yes');
    }
    const constrained = coverageGroupEnvironment(
      group,
      { cpus: 2, memoryBytes: 16 * 1024 ** 3 },
      7,
      original,
    );
    assert.equal(constrained.FORGEAX_SHADER_COMPILE_WORKERS, '1');
  }
  assert.deepEqual(
    coverageGroupEnvironment({ files: [] }, { cpus: 8, memoryBytes: 16 * 1024 ** 3 }, 3, original),
    { ...original, FORGEAX_SHADER_COMPILE_WORKERS: '3' },
  );
  assert.equal(original.NODE_OPTIONS, '--import=probe.mjs --max-old-space-size=4096');
  assert.throws(
    () =>
      coverageGroupEnvironment(
        { files: [], sourceCompilation: true },
        { memoryBytes: 16 * 1024 ** 3 },
        1,
      ),
    /exclusive/,
  );
});

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
    8,
    'native, Vite build, bootstrap and live startup owners drain neighboring coverage work',
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
    'packages/devkit/src/__tests__/asset-libraries.integration.test.ts',
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
  assert.equal(exclusiveRuns, 20);
});

test('asset-library catalogs share the complete exclusive bootstrap owner with their original deadline', () => {
  const file = 'packages/devkit/src/__tests__/asset-libraries.integration.test.ts';
  const bootstrap = 'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts';
  const groups = coverageGroups(['@forgeax/engine-devkit'], 8);
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.deepEqual(owner.files, [
    bootstrap,
    file,
    'packages/devkit/src/__tests__/host-authoring-publication.integration.test.ts',
  ]);
  assert.equal(owner.label, `@forgeax/engine-devkit:${bootstrap}`);
  assert.equal(isExclusiveCoverageGroup(owner), true);
  assert.equal(owner.gpuLease, false);
  assert.ok(owner.reservationWeight >= 195);
  assert.equal(
    coverageGroupMaxWorkers(
      owner,
      { coverage: true, maxWorkers: 2 },
      { cpus: 8, memoryBytes: 16e9 },
      2,
    ),
    1,
  );
  assert.ok(
    groups
      .filter((group) => group !== owner)
      .every((group) => group.files.length > 0 || group.excludes.includes(file)),
  );
  assert.match(readFileSync(file, 'utf8'), /}, 120_000\);/);
});

test('cold scene, format and bootstrap contracts execute once in exclusive coverage children', () => {
  const groups = coverageGroups(
    [
      '@forgeax/engine-scene',
      '@forgeax/engine-render',
      '@forgeax/engine-mesh-io',
      '@forgeax/engine-devkit',
    ],
    8,
  );
  for (const file of [
    meshIoFormatFile,
    devkitBootstrapCommandsFile,
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

test('ordinary coverage workers share bounded CPU and memory while source owners stay serial', () => {
  const options = parseArgs(['--max-workers=2', '--modeling-max-workers=2']);
  const resources = { cpus: 8, memoryBytes: 16_000_000_000 };
  const groups = coverageGroups(allProjectNames(), 8);
  const ordinary = groups.filter((group) => !isExclusiveCoverageGroup(group));
  const exclusive = groups.filter(isExclusiveCoverageGroup);
  assert.ok(ordinary.some((group) => group.projects.includes('@forgeax/engine-render')));
  assert.ok(exclusive.some((group) => group.files.length > 1));
  for (const group of ordinary) {
    assert.equal(coverageGroupMaxWorkers(group, options, resources, 2), 2, group.label);
    assert.equal(coverageGroupMaxWorkers(group, options, { ...resources, cpus: 7 }, 2), 1);
    assert.equal(
      coverageGroupMaxWorkers(group, options, { ...resources, memoryBytes: 12_000_000_000 }, 2),
      1,
    );
    assert.equal(coverageGroupMaxWorkers(group, options, resources, 3), 1);
  }
  for (const group of exclusive)
    assert.equal(coverageGroupMaxWorkers(group, options, resources, 2), 1, group.label);
});

test('complete Render coverage retains admitted workers and limited source headroom', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const producer = workflow.jobs['coverage-pnpm-shard'];
  const gate = producer.steps.find((step) => step.run?.includes('--shard-count='));
  assert.match(gate.run, /--max-workers=2/);
  assert.match(producer['timeout-minutes'], /^\$\{\{ matrix\.shard == 0 && 50 \|\| 45 \}\}$/);
  assert.deepEqual(producer.strategy.matrix.shard, [0, 1, 2, 3]);
  const groups = coverageGroups(allProjectNames(), 8);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const renderIndex = groups.findIndex(
    (group) => group.label === '@forgeax/engine-render:shard-2-of-2',
  );
  assert.notEqual(renderIndex, -1);
  const renderLanes = groups.flatMap((group, index) =>
    group.projects[0] === '@forgeax/engine-render' && group.shard ? [assignment[index]] : [],
  );
  assert.deepEqual(
    renderLanes.toSorted(),
    [0, 2],
    'both complete Render halves use the already admitted two-worker jobs',
  );
  const options = parseArgs(['--max-workers=2', '--modeling-max-workers=2']);
  const resources = { cpus: 8, memoryBytes: 16_000_000_000 };
  const render = groups[renderIndex];
  assert.equal(coverageGroupMaxWorkers(render, options, resources, 2), 2);
  assert.equal(coverageGroupMaxWorkers(render, options, { ...resources, cpus: 7 }, 2), 1);
  assert.equal(
    coverageGroupMaxWorkers(render, options, { ...resources, memoryBytes: 12_000_000_000 }, 2),
    1,
  );
  const source = groups.find((group) =>
    group.files.includes(
      'packages/vite-plugin-shader/src/__tests__/direct-dfg-manifest.integration.test.ts',
    ),
  );
  assert.ok(source);
  assert.ok(assignment[groups.indexOf(source)] >= 0);
  assert.equal(coverageGroupMaxWorkers(source, options, resources, 2), 1);
});

test('ordinary worker admission retains complete owners after cold-source rebalancing', () => {
  const groups = waterCoverageGroupsThrough(43744332755);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const options = parseArgs(['--max-workers=2', '--modeling-max-workers=2']);
  const resources = { cpus: 8, memoryBytes: 16_000_000_000 };
  for (const label of ['@forgeax/engine-devkit:shard-1-of-2', '@forgeax/engine-vite-plugin-pack']) {
    const index = groups.findIndex((group) => group.label === label);
    assert.ok(index >= 0);
    assert.ok(assignment[index] >= 0 && assignment[index] < 4, 'retain a complete assigned owner');
    assert.equal(coverageGroupMaxWorkers(groups[index], options, resources, 2), 2);
    assert.equal(coverageGroupMaxWorkers(groups[index], options, { ...resources, cpus: 7 }, 2), 1);
    assert.equal(
      coverageGroupMaxWorkers(
        groups[index],
        options,
        { ...resources, memoryBytes: 12_000_000_000 },
        2,
      ),
      1,
    );
  }
  const source = groups.find((group) =>
    group.files.includes(
      'packages/vite-plugin-shader/src/__tests__/production-resampling-vite.integration.test.ts',
    ),
  );
  assert.ok(source);
  assert.ok(assignment[groups.indexOf(source)] >= 0 && assignment[groups.indexOf(source)] < 4);
  assert.equal(coverageGroupMaxWorkers(source, options, resources, 2), 1);
  assert.ok(isExclusiveCoverageGroup(source));
  assert.deepEqual(
    assignCoverageShards(groups, 4, { typecheck: false }),
    assignment,
    'probing worker admission must not change the accepted complete-child placement',
  );
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
    'packages/render/src/__tests__/mesh-builder-stock-material-inputs.integration.test.ts',
    'packages/render/src/__tests__/skin-candidate-host.unit.test.ts',
    'packages/render/src/__tests__/standard-scene-data-runtime.integration.test.ts',
    'packages/render/src/__tests__/planar-receiver-routing.unit.test.ts',
    'packages/render/src/__tests__/raytracing/renderer-diffuse-retained.unit.test.ts',
    'packages/render/src/raytracing/__tests__/scene-field-projection.integration.test.ts',
  ];
  const groups = coverageGroups(['@forgeax/engine-render'], 8);
  const owner = groups.find((group) => group.files.includes(files[0]));
  assert.deepEqual(owner.files, files);
  assert.equal(owner.label, `@forgeax/engine-render:${files.slice(0, 2).join(',')}`);
  assert.equal(owner.weight, 110, 'retain the larger completed owner observation');
  assert.equal(owner.reservationWeight, 520, 'reserve new work without inventing a sample');
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

function discoverExplicitCoverageFiles(discovered, groups) {
  const filters = groups.flatMap(({ files }) => files);
  const observed = new Set(discovered);
  const selected = filters
    .map((file) => path.resolve(file).replaceAll('\\', '/'))
    .filter((file) => observed.has(file));
  assert.deepEqual(
    [...new Set(selected)].toSorted(),
    discovered.toSorted(),
    'the batched Vitest filter selects only the explicitly owned files',
  );
  return selected;
}

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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  completed.replayRuns = completed.replayRuns.filter((run) => !run.requiredProjects?.length);

  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
    const groups = historicalCoverageGroups();
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

test('actual Vitest discovery conserves native coverage and the central type-test owner', async () => {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const modeling = '@forgeax/engine-modeling';
  const render = '@forgeax/engine-render';
  const projects = [modeling, '@forgeax/engine-devkit', render];
  const groups = coverageGroups(projects, 8);
  const owners = projects.map((project) => ({
    project,
    native: groups.filter((group) => group.shard && group.projects.includes(project)),
    explicit: groups.filter((group) => group.files.length > 0 && group.projects.includes(project)),
  }));
  // One real root CLI discovery per mode. Project identities keep the three
  // inventories independent while avoiding repeated Vite config resolution.
  const discover = (args) => {
    const rows = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          'list',
          ...projects.map((project) => `--project=${project}`),
          ...args,
          '--filesOnly',
          '--json',
        ],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    return new Map(
      projects.map((project) => [
        project,
        rows
          .filter(({ projectName }) => projectName === project)
          .map(({ file }) => file.replaceAll('\\', '/')),
      ]),
    );
  };
  const typeTest = (file) => file.includes('.test-d.');
  const all = discover([]);
  const typeTests = all.get(render).filter(typeTest);
  assert.ok(typeTests.length > 0, 'exercise the real package type-test declaration');
  const preflight = discover(['--typecheck.only']);
  assert.deepEqual(preflight.get(render).filter(typeTest).toSorted(), typeTests.toSorted());
  const runtimeOnly = '--typecheck.enabled=false';
  const runtime = discover([runtimeOnly]);
  assert.deepEqual(
    runtime.get(render).toSorted(),
    all
      .get(render)
      .filter((file) => !typeTest(file))
      .toSorted(),
    'the runtime child keeps every ordinary file and excludes central type tests',
  );

  const exclusions = (group) =>
    buildGroupArgs({
      cliPath: cli,
      group,
      maxWorkers: 1,
      coverage: true,
      coverageDir: 'coverage',
      reportPath: 'report.json',
    }).filter((argument) => argument.startsWith('--exclude='));
  const commonExcludes = new Set([
    ...exclusions({ ...owners[0].native[0], excludes: [] }).map((arg) =>
      arg.slice('--exclude='.length),
    ),
    ...[...coreDeferredCoverageFiles(), ...localModelingShowcases].map((file) =>
      path.resolve(file).replaceAll('\\', '/'),
    ),
  ]);
  const covered = discover([
    runtimeOnly,
    ...new Set(owners.flatMap(({ native }) => exclusions(native[0]))),
  ]);
  const selected = discover([
    runtimeOnly,
    ...owners.flatMap(({ explicit }) => explicit.flatMap(({ files }) => files)),
  ]);
  const performanceFile = path
    .resolve('packages/modeling/src/__tests__/perf-tiers.unit.test.ts')
    .replaceAll('\\', '/');
  assert.ok(
    runtime.get(modeling).includes(performanceFile),
    'retain the complete performance file',
  );
  assert.ok(
    commonExcludes.has(performanceFile),
    'the Modeling preflight owns the performance file',
  );

  for (const { project, native, explicit } of owners) {
    // Files-only listing is unsharded. Exercise the real sequencer against
    // the ordinary inventory and the explicit child filters separately.
    const specifications = covered
      .get(project)
      .map((moduleId) => ({ moduleId, project: { name: project } }));
    const partition = (files) =>
      Promise.all(
        native.map((group) => {
          const [index, count] = group.shard.split('/').map(Number);
          return new DawnSequencer({
            config: { root: process.cwd(), coverage: { enabled: true }, shard: { index, count } },
          }).shard(files);
        }),
      );
    const partitions = await partition(specifications);
    assert.ok(partitions.every((files) => files.length > 0));
    if (project === modeling)
      assert.deepEqual(
        await partition(specifications.toReversed()),
        partitions,
        'placement is independent of discovery order',
      );
    assert.deepEqual(
      [
        ...partitions.flat().map(({ moduleId }) => moduleId),
        ...discoverExplicitCoverageFiles(selected.get(project), explicit),
      ].toSorted(),
      runtime
        .get(project)
        .filter((file) => !commonExcludes.has(file))
        .toSorted(),
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
      const firstParallel = order.find((index) => !isExclusiveCoverageGroup(children[index]));
      assert.ok(
        firstParallel !== undefined && children[firstParallel].shard?.endsWith('/2'),
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

test('the Primary live journey is excluded from V8 while Scene and local browser acceptance stay available', () => {
  const file = 'packages/devkit/src/__tests__/live-dev-look.e2e.test.ts';
  const sceneFile = 'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts';
  for (const isolateFiles of [false, true]) {
    const groups = coverageGroups(['@forgeax/engine-devkit'], 8, { isolateFiles });
    const owners = groups.filter((group) => group.files.includes(sceneFile));
    assert.equal(owners.length, 1);
    const owner = owners[0];
    assert.deepEqual(owner.files, isolateFiles ? [sceneFile] : [sceneFile, file]);
    assert.equal(owner.label, `@forgeax/engine-devkit:${sceneFile}`);
    assert.equal(owner.gpuLease, true);
    assert.ok(isExclusiveCoverageGroup(owner));
    assert.equal(
      coverageGroupMaxWorkers(
        owner,
        { coverage: true, maxWorkers: 2 },
        { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
        2,
      ),
      1,
    );
    for (const group of groups) {
      const args = buildGroupArgs({
        cliPath: 'vitest.mjs',
        group,
        maxWorkers: 1,
        coverage: isolateFiles,
        coverageDir: '.coverage',
        reportPath: 'result.json',
      });
      assert.equal(
        args.includes(`--exclude=${path.resolve(file).replaceAll('\\', '/')}`),
        isolateFiles || group.files.length === 0,
      );
    }
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

test('starts the cold Standard fixtures before the parallel coverage batch', () => {
  const groups = [
    { label: 'ordinary', files: [] },
    { label: 'large source compilation', files: ['large-source.test.ts'] },
    {
      label: 'cold Standard alias',
      files: ['packages/shader-compiler/src/__tests__/material-standard-alias.unit.test.ts'],
    },
    { label: 'other source compilation', files: ['other-source.test.ts'] },
    {
      label: 'cold Standard schema reuse',
      files: [
        'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
      ],
    },
  ];
  assert.deepEqual(
    scheduledGroupOrder(groups, {
      coverage: true,
      localGpuLease: false,
      coverageOrder: [1, 0, 3, 2, 4],
    }),
    [2, 4, 0, 1, 3],
  );
});

test('isolates a heavy test file into its own child and excludes it elsewhere', () => {
  const nativeFiles = [
    'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
    'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
    'packages/devkit/src/__tests__/live-dev-look.e2e.test.ts',
  ];
  const liveProcessFile = 'packages/devkit/src/__tests__/live-dev-process.integration.test.ts';
  const liveClientFile = 'packages/devkit/src/__tests__/live-dev-client.test.ts';
  const workerIdentityFile =
    'packages/devkit/src/__tests__/worker-module-identity.integration.test.ts';
  const playFile = 'packages/devkit/src/__tests__/project-play.e2e.test.ts';
  const sceneFile = 'packages/scene/src/__tests__/flat-propagation.contract.test.ts';
  const bootstrapFile =
    'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts';
  const libraryFile = 'packages/devkit/src/__tests__/asset-libraries.integration.test.ts';
  const publicationFile =
    'packages/devkit/src/__tests__/host-authoring-publication.integration.test.ts';
  const allFiles = [
    bootstrapFile,
    libraryFile,
    publicationFile,
    devkitBootstrapCommandsFile,
    sceneFile,
    ...nativeFiles.slice(0, 2),
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
        files: [bootstrapFile, libraryFile, publicationFile],
        excludes: [],
        gpuLease: false,
      },
      {
        projects: ['@forgeax/engine-devkit'],
        files: [devkitBootstrapCommandsFile],
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
      [[nativeFiles[1], nativeFiles[2]], [], true],
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
  for (const file of nativeFiles) {
    const owner = unit.find((group) => group.files.includes(file));
    const nativeArgs = buildGroupArgs({
      cliPath: '/workspace/scripts/run-vitest-projects.mjs',
      group: owner,
      maxWorkers: 1,
      coverage: false,
    });
    assert.ok(nativeArgs.includes(file));
    assert.equal(
      nativeFiles.filter((candidate) => nativeArgs.includes(candidate)).length,
      owner.files.length,
    );
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
    sourceCompilation: false,
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
      'packages/shader-compiler/src/__tests__/material-surface-import.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/__tests__/material-webgpu-build-profile.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/custom-surface-coverage.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/parameter-identifiers.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/ray-surface-derivatives.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/standard-static-shadow.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/surface-resources.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/weapon-spirit-material.integration.test.ts',
    ],
    [
      '@forgeax/engine-runtime',
      'packages/runtime/src/__tests__/custom-surface-publication.integration.test.ts',
    ],
    [
      '@forgeax/engine-gltf',
      'packages/gltf/src/__tests__/diffuse-transmission-import.integration.test.ts',
    ],
    [
      '@forgeax/engine-gltf',
      'packages/gltf/src/__tests__/physical-material-import.integration.test.ts',
    ],
    [
      '@forgeax/engine-vite-plugin-pack',
      'packages/vite-plugin-pack/src/__tests__/imported-material-publication.integration.test.ts',
    ],
    [
      '@forgeax/engine-vite-plugin-pack',
      'packages/vite-plugin-pack/src/__tests__/scriptable-standard-material.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/__tests__/material-cook.unit.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/gbuffer-publication.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/material-static-switches.integration.test.ts',
    ],
    [
      '@forgeax/engine-shader-compiler',
      'packages/shader-compiler/src/material/__tests__/node-material-pool.integration.test.ts',
    ],

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
      '@forgeax/engine-gltf',
      '@forgeax/engine-naga',
      '@forgeax/engine-runtime',
      'unit',
    ],
    8,
  );
  for (const [project, file] of cases) {
    const owners = groups.filter((group) => group.files.includes(file));
    assert.equal(owners.length, 1, file);
    assert.ok(isExclusiveCoverageGroup(owners[0]));
    assert.ok(owners[0].projects.includes(project));
    assert.ok(
      groups
        .filter((group) => group !== owners[0])
        .every((group) => group.files.length > 0 || group.excludes.includes(file)),
    );
  }
});

test('the completed split compiler cohort fits the daily Coverage replay target', () => {
  const ledger = JSON.parse(
    readFileSync('scripts/ci/coverage-completed-child-seconds.json', 'utf8'),
  );
  const receipt = ledger.replayRuns.find((run) => run.runId === 44949779826);
  const groups = restoreHistoricalSharedCoverage(
    coverageGroups(allProjectNames(), 8, {
      historicalModeling: true,
      environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
    }),
  );
  assert.equal(receipt.originalJobs.length, 4);
  assert.ok(receipt.originalJobs.every((job) => !job.inherited));
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    Object.keys(receipt.completedSeconds).sort(),
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(Math.max(...finishes) <= receipt.targetSeconds, String(finishes));
});

test('the timeout cohort moves complete Coverage work off the overrun lane', () => {
  const ledger = JSON.parse(
    readFileSync('scripts/ci/coverage-completed-child-seconds.json', 'utf8'),
  );
  const receipt = ledger.replayRuns.find(({ runId }) => runId === 44984141441);
  const groups = restoreHistoricalSharedCoverage(
    coverageGroups(allProjectNames(), 8, {
      historicalModeling: true,
      environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
    }),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 61);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 6);
  assert.ok(receipt.originalJobs.every((job) => !job.inherited && job.runId === receipt.runId));
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)].sort(),
  );
  const interrupted = groups.find((group) =>
    group.files.includes(
      'packages/render/src/__tests__/direct-shadow-preparation.integration.test.ts',
    ),
  );
  assert.equal(interrupted.observedSeconds, undefined);
  assert.equal(receipt.reservedSeconds[interrupted.label], 180);
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(Math.max(...finishes) <= receipt.targetSeconds, String(finishes));
});

test('current Coverage assigns each Standard output batch once across the four jobs', () => {
  const groups = coverageGroups(allProjectNames(), 8, {
    environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
  });
  const assignments = assignCoverageShards(groups, 4, { typecheck: false });
  const modelingByShard = [0, 0, 0, 0];
  for (const [index, group] of groups.entries()) {
    if (group.shard && group.projects[0] === '@forgeax/engine-modeling')
      modelingByShard[assignments[index]]++;
  }
  assert.deepEqual(modelingByShard, [3, 3, 3, 3]);
  const compilerSplitIndex = groups.findIndex((group) =>
    group.files.includes(materialCompilerSplitFile),
  );
  const compilerSplit = groups[compilerSplitIndex];
  const compilerIndex = groups.findIndex((group) => group.label === compilerSplit.splitFromReceipt);
  assert.ok(compilerIndex >= 0);
  assert.notEqual(assignments[compilerSplitIndex], assignments[compilerIndex]);
  assert.equal(compilerSplit.files.length + groups[compilerIndex].files.length, 17);
  for (const file of standardTransmissionFiles) {
    const indices = groups.flatMap((group, index) => (group.files.includes(file) ? [index] : []));
    assert.equal(indices.length, 1, file);
    const [index] = indices;
    const group = groups[index];
    assert.equal(group.sourceCompilation, true, file);
    assert.equal(group.packagesOnly, true, file);
    assert.ok(isExclusiveCoverageGroup(group), file);
    assert.ok(assignments[index] >= 0 && assignments[index] < 4, file);
    assert.ok(group.weight > 0, file);
    const prior = groups.find((candidate) => candidate.label === group.splitFromReceipt);
    const measuredReplay = prior?.replaySeconds.findIndex((seconds) => seconds > 0);
    assert.ok(measuredReplay >= 0, file);
    assert.equal(group.replaySeconds[measuredReplay], 0, file);
  }
  const finishes = coverageAssignmentLaneFinishes(groups, assignments, 4, false, true);
  assert.ok(
    Math.max(...finishes) <= 2300,
    `retain the current four-job execution budget: ${finishes}`,
  );
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
    ...standardTransmissionFiles.map((file) => [file, '@forgeax/engine-shader']),
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
  const groups = historicalCoverageGroups();
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
  const evenShare = Math.ceil(groups.length / counts.length);
  assert.ok(
    Math.max(...counts) <= Math.max(16, evenShare),
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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
  const groups = historicalCoverageGroups();
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

test('authoring publication retains its cold 15-second deadline without a competing coverage child', () => {
  const file = 'packages/devkit/src/__tests__/host-authoring-publication.integration.test.ts';
  const groups = coverageGroups(['@forgeax/engine-devkit'], 8, { isolateFiles: true });
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  assert.ok(isExclusiveCoverageGroup(owners[0]));
  assert.equal(
    coverageGroupMaxWorkers(
      owners[0],
      { coverage: true, maxWorkers: 2 },
      { cpus: 8, memoryBytes: 16e9 },
    ),
    1,
  );
  assert.ok(
    groups
      .filter((group) => group !== owners[0])
      .every((group) =>
        group.files.length > 0 ? !group.files.includes(file) : group.excludes.includes(file),
      ),
  );
});

test('latest Core replay leaves room for the exclusive Shader Compiler in four shards', () => {
  const ledger = JSON.parse(
    readFileSync(new URL('../coverage-completed-child-seconds.json', import.meta.url), 'utf8'),
  );
  const receipt = ledger.replayRuns.find(({ runId }) => runId === 44509748020);
  assert.equal(Object.keys(receipt.completedSeconds).length, 49);
  assert.equal(receipt.interruptedGroups.length, 1);
  const [interrupted] = receipt.interruptedGroups;
  assert.equal(receipt.completedSeconds[interrupted], undefined);
  assert.equal(receipt.reservedSeconds[interrupted], 1020);
  const groups = coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
    environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
  });
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  assert.equal(groups.length, 61);
  assert.equal(new Set(assignment).size, 4);
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  assert.ok(observed.every(({ replaySeconds: [seconds] }) => Number.isFinite(seconds)));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(Math.max(...finishes) < receipt.budgetSeconds, `latest replay lanes: ${finishes}`);
});

test('partial daily cohort retains its 2300-second placement window without importing core costs into full validation', () => {
  const receipt = JSON.parse(
    readFileSync('scripts/ci/__tests__/fixtures/coverage-completed-43847849110.json', 'utf8'),
  );
  const ledger = JSON.parse(
    readFileSync('scripts/ci/coverage-completed-child-seconds.json', 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 61);
  assert.equal(Object.keys(receipt.reservedSeconds).length, 3);
  assert.equal(receipt.originalJobs.flatMap((job) => job.groups).length, 61);
  for (const label of [...receipt.failedGroups, ...receipt.unstartedGroups])
    assert.equal(receipt.completedSeconds[label], undefined);
  const groups = coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
    environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
  });
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)]
      .filter(
        (label) =>
          ![
            '@forgeax/engine-devkit:packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
            '@forgeax/engine-devkit:packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
            '@forgeax/engine-devkit:packages/devkit/src/__tests__/project-play.e2e.test.ts',
          ].includes(label),
      )
      .sort(),
  );
  assert.equal(
    groups.length,
    61,
    'the original 64-child receipt retains three native owners now executed on prepared workers',
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `retain daily setup headroom: ${finishes}`,
  );
  const withoutDaily = {
    ...ledger,
    replayRuns: ledger.replayRuns.filter((run) => run.runId !== receipt.runId),
  };
  assert.deepEqual(
    coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
      completed: ledger,
      environment: {},
    }),
    coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
      completed: withoutDaily,
      environment: {},
    }),
    'a core-only observation must not become a full/Nightly cost sample',
  );
});

test('completed daily children rebalance the 45-minute timeout within the original four jobs', (t) => {
  const receipt = JSON.parse(
    readFileSync('scripts/ci/__tests__/fixtures/coverage-completed-44073088105.json', 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 58);
  assert.equal(receipt.interruptedGroups.length, 1);
  assert.equal(receipt.unstartedGroups.length, 3);
  for (const label of [...receipt.interruptedGroups, ...receipt.unstartedGroups])
    assert.equal(receipt.completedSeconds[label], undefined);
  const groups = coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
    environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
  });
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)]
      .filter(
        (label) =>
          label !== '@forgeax/engine-devkit:packages/devkit/src/__tests__/project-play.e2e.test.ts',
      )
      .sort(),
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  t.diagnostic(`complete-child replay seconds: ${finishes.map((value) => value.toFixed(2))}`);
  assert.ok(
    Math.max(...finishes) <= receipt.budgetSeconds,
    `preserve two-minute setup headroom under the thirty-minute target: ${finishes}`,
  );
});

test('new slow coverage children retain preceding windows and all failed-owner forecasts', (t) => {
  const receipt = JSON.parse(
    readFileSync('scripts/ci/__tests__/fixtures/coverage-completed-44098269686.json', 'utf8'),
  );
  assert.equal(Object.keys(receipt.completedSeconds).length, 53);
  assert.equal(receipt.failedGroups.length, 2);
  assert.equal(receipt.unstartedGroups.length, 7);
  assert.equal(receipt.targetSeconds, 1680, 'retain the independent execution target');
  for (const label of [...receipt.failedGroups, ...receipt.unstartedGroups]) {
    assert.equal(receipt.completedSeconds[label], undefined);
    assert.ok(receipt.reservedSeconds[label] > 0);
  }
  const groups = coverageGroupsForHistoricalReceipts(receipt.projects, 8, {
    environment: { FORGEAX_CI_CORE_VALIDATION: '1' },
  });
  assert.equal(groups.length, 61);
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    [...Object.keys(receipt.completedSeconds), ...Object.keys(receipt.reservedSeconds)]
      .filter(
        (label) =>
          label !== '@forgeax/engine-devkit:packages/devkit/src/__tests__/project-play.e2e.test.ts',
      )
      .sort(),
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label] ?? receipt.reservedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  t.diagnostic(`pre-repair cohort replay seconds: ${finishes.map((value) => value.toFixed(2))}`);
  assert.ok(Math.max(...finishes) <= receipt.budgetSeconds);
});

test('registered Water Node apps share the existing bounded selector without rewriting old children', () => {
  const apps = [
    '@forgeax/water-r5-gpu-mesh-async-pontoons',
    '@forgeax/water-r8-entry-experiment',
    '@forgeax/water-mesh-demo',
    '@forgeax/water-r8-integration-acceptance',
  ];
  const projects = allProjectNames();
  const legacy = projects.filter((name) => !apps.includes(name));
  assert.deepEqual(projects.slice(0, -5), legacy.slice(0, -1));
  assert.equal(legacy.slice(0, -1).length, 80);
  assert.deepEqual(projects.slice(-5), [...apps, 'unit']);
  assert.equal(new Set(projects).size, projects.length);
  const current = coverageGroups(projects, 8);
  const preceding = coverageGroups(legacy, 8);
  const newChild = current.find((group) => apps.every((name) => group.projects.includes(name)));
  assert.ok(newChild);
  assert.ok(newChild.weight > 0, 'unmeasured work retains a positive forecast');
  assert.equal(newChild.observedSeconds, undefined, 'new apps have no completed observation');
  assert.equal(newChild.replaySeconds, undefined, 'old cohorts never observed the new child');
  for (const name of apps)
    assert.equal(current.filter((group) => group.projects.includes(name)).length, 1);
  for (const original of preceding.filter((group) => group.label !== 'unit'))
    assert.deepEqual(
      current.find((group) => group.label === original.label),
      original,
    );
  assert.equal(
    historicalCoverageGroups().some((group) => group.projects.some((name) => apps.includes(name))),
    false,
  );
});

test('all 62 completed 708d children retain source costs while daily Play moves to View', () => {
  const ledger = JSON.parse(
    readFileSync('scripts/ci/coverage-completed-child-seconds.json', 'utf8'),
  );
  const receipt = ledger.replayRuns.find((row) => row.runId === 44152394166);
  assert.equal(receipt.head, '708d4ff1c4515d5e0cc7af683759c477b2c62e40');
  assert.equal(Object.keys(receipt.completedSeconds).length, 62);
  assert.deepEqual(receipt.reservedSeconds, {});
  assert.equal(new Set(receipt.originalJobs.flatMap((job) => job.groups)).size, 62);
  assert.ok(receipt.originalJobs.every((job) => !job.inherited && job.runId === receipt.runId));
  const play = '@forgeax/engine-devkit:packages/devkit/src/__tests__/project-play.e2e.test.ts';
  assert.equal(receipt.completedSeconds[play], 736.26);
  const environment = { FORGEAX_CI_CORE_VALIDATION: '1' };
  const groups = coverageGroupsForHistoricalReceipts(receipt.projects, 8, { environment });
  assert.equal(groups.length, 61);
  assert.ok(groups.every((group) => group.label !== play));
  assert.deepEqual(
    groups.map((group) => group.label).sort(),
    Object.keys(receipt.completedSeconds)
      .filter((label) => label !== play)
      .sort(),
  );
  const assignment = assignCoverageShards(groups, 4, { typecheck: false });
  const observed = groups.map((group) => ({
    ...group,
    replaySeconds: [receipt.completedSeconds[group.label]],
  }));
  const finishes = coverageAssignmentLaneFinishes(observed, assignment, 4, false, true, 0);
  assert.ok(Math.max(...finishes) <= 1680, String(finishes));
});
