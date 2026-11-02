import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { DawnSequencer } from '../../../config/vitest-dawn-sequencer.ts';
import { runGroups } from '../../lib/run-bounded-groups.mjs';

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
  assignCoverageShards,
  buildGroupArgs,
  buildTypecheckArgs,
  coverageGroupOrder,
  coverageGroups,
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
    6,
    'native, Vite build and live startup owners drain neighboring coverage work',
  );
  assert.equal(active.size, 0);
});

test('cold compiler file sets keep one owner and drain all neighboring work', async () => {
  const groups = coverageGroups(
    [
      '@forgeax/engine-devkit',
      '@forgeax/engine-vite-plugin-shader',
      '@forgeax/engine-vite-plugin-pack',
      '@forgeax/engine-pack',
      '@forgeax/engine-render',
      'unit',
    ],
    8,
  );
  for (const file of [
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
  assert.equal(exclusiveRuns, 14);
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
  const consume = workflow.jobs['coverage-pnpm'].steps.find((step) =>
    step.run?.includes('--artifact-pattern "coverage-shard-*"'),
  );
  assert.equal(Number(produce.run.match(/--shard-count=(\d+)/)?.[1]), shards.length);
  assert.equal(Number(consume.run.match(/--expected-count (\d+)/)?.[1]), shards.length);
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
  const gate = workflow.jobs['coverage-perf'].steps.find((step) => step.run?.includes(file));
  assert.ok(gate, 'the required performance job must run the complete tier-budget file');
  assert.ok(gate.run.includes('--project=@forgeax/engine-modeling'));
  assert.ok(gate.run.includes('--coverage.enabled=false'));
  assert.notEqual(gate['continue-on-error'], true);
  assert.ok(!/testTimeout|testNamePattern|--exclude/.test(gate.run));
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
    }).filter((argument) => argument.startsWith('--exclude='));
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
      ...native[0].excludes.map((file) => `--exclude=${path.resolve(file)}`),
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

test('modeling partitions retain the complete native shard roster and bounded workers', () => {
  const project = '@forgeax/engine-modeling';
  for (const isolateFiles of [true, false]) {
    const groups = coverageGroups(['@forgeax/engine-math', project], 4, { isolateFiles });
    const modeling = groups.filter((group) => group.projects.includes(project));
    assert.equal(modeling.length, isolateFiles ? 17 : 16);
    const native = modeling.filter((group) => group.shard);
    const isolated = modeling.filter((group) => group.files.length > 0);
    assert.equal(isolated.length, isolateFiles ? 1 : 0);
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
  const allFiles = [
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
  const { weight: _weight, ...owner } = owners[0];
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
