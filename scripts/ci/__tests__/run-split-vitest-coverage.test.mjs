import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
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
    3,
    'both native Renderer files and the Vite process owner remain isolated',
  );
  assert.equal(active.size, 0);
});

test('cold compiler file sets keep one owner and drain all neighboring work', async () => {
  const groups = coverageGroups(
    [
      '@forgeax/engine-devkit',
      '@forgeax/engine-vite-plugin-shader',
      '@forgeax/engine-pack',
      '@forgeax/engine-render',
      'unit',
    ],
    8,
  );
  for (const file of [
    'packages/pack/src/__tests__/material-surface-publication.unit.test.ts',
    'packages/vite-plugin-shader/src/__tests__/vite-plugin-shader.unit.test.ts',
    'packages/vite-plugin-shader/src/__tests__/public-surface.unit.test.ts',
    'packages/devkit/src/__tests__/live-dev-process.integration.test.ts',
    'packages/render/src/__tests__/raytracing/diffuse-gi.unit.test.ts',
    'packages/render/src/__tests__/raytracing/gi-view.unit.test.ts',
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
  assert.equal(exclusiveRuns, 6);
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
  const devkitFiles = [...nativeFiles, liveProcessFile];
  const groups = coverageGroups(['@forgeax/engine-scene', '@forgeax/engine-devkit'], 8);
  assert.deepEqual(
    groups.map(({ projects, files, excludes, gpuLease }) => ({
      projects,
      files,
      excludes,
      gpuLease,
    })),
    [
      { projects: ['@forgeax/engine-scene'], files: [], excludes: devkitFiles, gpuLease: false },
      { projects: ['@forgeax/engine-devkit'], files: [], excludes: devkitFiles, gpuLease: false },
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
  for (const file of nativeFiles) assert.ok(ordinaryArgs.includes(`--exclude=${file}`));
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
        .every((group) => group.excludes.includes(file)),
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
  assert.equal(scanRuns, 1);
});

test('cold Standard raster and ray compilation has one exclusive instrumented owner', () => {
  const file =
    'packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts';
  const groups = coverageGroups(
    ['@forgeax/engine-shader-compiler', '@forgeax/engine-naga', 'unit'],
    8,
  );
  const owners = groups.filter((group) => group.files.includes(file));
  assert.equal(owners.length, 1);
  assert.ok(isExclusiveCoverageGroup(owners[0]));
  assert.deepEqual(owners[0].projects, ['@forgeax/engine-shader-compiler']);
  assert.ok(
    groups.filter((group) => group !== owners[0]).every((group) => group.excludes.includes(file)),
  );
});
