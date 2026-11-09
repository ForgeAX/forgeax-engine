import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
import { BaseSequencer, createVitest } from 'vitest/node';
import { parse } from 'yaml';
import { DawnSequencer, planDawnShards } from '../../../config/vitest-dawn-sequencer.ts';
import { DAWN_COMPACT_TEST_FILES } from '../dawn-compact-roster.mjs';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS, DAWN_VITEST_CONFIG } from '../dawn-gate-roster.mjs';
import {
  dawnVitestArgs,
  selectDawnGroups,
  selectDawnShard,
  validateDawnGateRoster,
} from '../run-dawn-gate.mjs';

const root = resolve('.');
const selectors = ['FORGEAX_DAWN_ISOLATED', 'FORGEAX_DAWN_COMPACT', 'FORGEAX_DAWN_PARTITION'];
const nativeVitest = await createVitest('test', { project: ['dawn'], watch: false });
let nativeSpecifications;
let configuredSequencer;
let rootDawnPolicy;
const configuredPartitions = [];
try {
  nativeSpecifications = await nativeVitest.globTestSpecifications();
  rootDawnPolicy = dawnPolicy(nativeVitest);
  configuredSequencer = nativeVitest.config.sequence.sequencer;
  for (let index = 1; index <= DAWN_GATE_SHARDS.length; index++) {
    const owner = DAWN_GATE_GROUPS.find(
      (group) => group.vitestShard === `${index}/${DAWN_GATE_SHARDS.length}`,
    );
    const physicalLane = DAWN_GATE_SHARDS.findIndex((lane) => lane.includes(owner.id));
    const context = {
      config: {
        ...nativeVitest.config,
        shard: { index, count: DAWN_GATE_SHARDS.length },
      },
    };
    configuredPartitions[physicalLane] = await new configuredSequencer(context).shard(
      nativeSpecifications,
    );
  }
} finally {
  await nativeVitest.close();
}

function dawnPolicy(vitest) {
  const project = vitest.projects.find((project) => project.name === 'dawn');
  assert.ok(project, 'missing Dawn project');
  const keys = [
    'root',
    'environment',
    'setupFiles',
    'include',
    'exclude',
    'pool',
    'isolate',
    'maxWorkers',
    'fileParallelism',
    'testTimeout',
    'hookTimeout',
    'teardownTimeout',
    'retry',
  ];
  return {
    execution: Object.fromEntries(keys.map((key) => [key, project.config[key]])),
    typecheck: {
      enabled: project.config.typecheck.enabled,
      include: project.config.typecheck.include,
    },
    sequencer: Function.prototype.toString.call(vitest.config.sequence.sequencer),
    aliases: project.vite.config.resolve.alias.map(({ find, replacement }) => ({
      find: String(find),
      replacement,
    })),
  };
}

test('the dedicated entry retains the root Dawn execution policy and source aliases', async () => {
  const vitest = await createVitest('test', {
    config: resolve(DAWN_VITEST_CONFIG),
    project: ['dawn'],
    watch: false,
  });
  try {
    assert.deepEqual(dawnPolicy(vitest), rootDawnPolicy);
    const dependencies = vitest.vite.config.configFileDependencies.map((path) =>
      relative(root, path).replaceAll('\\', '/'),
    );
    assert.ok(
      dependencies.includes('config/vitest-dawn-project.ts') &&
        dependencies.includes('config/vitest-shared.ts'),
      'configuration dependency evidence must include the actual shared policy modules',
    );
    assert.ok(
      !dependencies.some((path) =>
        /(?:vitest-browser-project|vitest-browser-provider|material-publication\.commands)\./.test(
          path,
        ),
      ),
      'native configuration must not initialize browser command owners',
    );
  } finally {
    await vitest.close();
  }
});

function listDawnFiles(extraEnv = {}, config = DAWN_VITEST_CONFIG) {
  const env = { ...process.env };
  for (const key of selectors) delete env[key];
  const output = execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'list',
      ...(config === null ? [] : ['--config', config]),
      '--project=dawn',
      '--filesOnly',
      '--json',
    ],
    { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(output)
    .map(({ file }) => relative(root, file).replaceAll('\\', '/'))
    .sort();
}

test('actual Vitest discovery conserves every Dawn file across execution groups', () => {
  const owners = validateDawnGateRoster();
  const ordinary = listDawnFiles();
  assert.deepEqual(ordinary, listDawnFiles({}, null), 'Dawn entry retains root ordinary discovery');
  assert.ok(ordinary.length > 0, 'the ordinary gate must execute tests');
  const all = listDawnFiles({
    FORGEAX_DAWN_ISOLATED: '1',
    FORGEAX_DAWN_COMPACT: '1',
    FORGEAX_DAWN_PARTITION: 'roster-audit',
  });
  assert.deepEqual(
    all,
    listDawnFiles(
      {
        FORGEAX_DAWN_ISOLATED: '1',
        FORGEAX_DAWN_COMPACT: '1',
        FORGEAX_DAWN_PARTITION: 'roster-audit',
      },
      null,
    ),
    'Dawn entry retains the complete root discovery',
  );
  for (const file of ordinary) assert.ok(!owners.has(file), `duplicate ordinary owner: ${file}`);
  const planned = [...ordinary, ...owners.keys()].sort();
  assert.deepEqual(planned, all, 'every discovered file must execute exactly once');
});

test('each group keeps its admission and native lifetime boundary', () => {
  const ids = DAWN_GATE_GROUPS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of DAWN_GATE_GROUPS) {
    const args = dawnVitestArgs(group);
    assert.equal(args[args.indexOf('--config') + 1], DAWN_VITEST_CONFIG);
    const passWithNoTests = group.vitestShard === undefined ? 'false' : 'true';
    assert.ok(dawnVitestArgs(group).includes(`--passWithNoTests=${passWithNoTests}`));
    if (group.id.startsWith('compact-')) assert.equal(group.env.FORGEAX_DAWN_COMPACT, '1');
    else if (group.vitestShard === undefined && group.id !== 'direct-light') {
      assert.equal(group.env.FORGEAX_DAWN_ISOLATED, '1');
    }
    assert.equal(dawnVitestArgs(group).includes('--no-isolate'), group.id.startsWith('heavy-'));
    if (group.id.startsWith('heavy-')) {
      assert.equal(group.files.length, 1);
      assert.ok(dawnVitestArgs(group).includes('--retry=0'));
      assert.ok(dawnVitestArgs(group).includes('--bail=1'));
    }
  }
  assert.equal(ids.filter((id) => id === 'gpu-timing').length, 1);
});

test('compact files remain complete and unique across three existing native lanes', () => {
  const groups = DAWN_GATE_GROUPS.filter(({ id }) => id.startsWith('compact-'));
  assert.equal(groups.length, 3);
  const files = groups.flatMap(({ files }) => files);
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.toSorted(), [...DAWN_COMPACT_TEST_FILES].sort());
  const lanes = groups.map(({ id }) => DAWN_GATE_SHARDS.findIndex((lane) => lane.includes(id)));
  assert.equal(new Set(lanes).size, 3);
});

test('four Dawn jobs cover every complete native group exactly once', () => {
  const ids = DAWN_GATE_SHARDS.flat();
  assert.equal(DAWN_GATE_SHARDS.length, 4);
  assert.equal(ids.length, DAWN_GATE_GROUPS.length, 'each group must have exactly one lane');
  assert.equal(new Set(ids).size, DAWN_GATE_GROUPS.length);
  assert.deepEqual(new Set(ids), new Set(DAWN_GATE_GROUPS.map((group) => group.id)));
  for (const [index, lane] of DAWN_GATE_SHARDS.entries()) {
    const selected = selectDawnShard(`${index + 1}/${DAWN_GATE_SHARDS.length}`);
    assert.deepEqual(new Set(selected.map((group) => group.id)), new Set(lane));
    assert.deepEqual(
      selected.filter((group) => !group.placementReserveSeconds).map((group) => group.id),
      DAWN_GATE_GROUPS.filter(
        (group) => lane.includes(group.id) && !group.placementReserveSeconds,
      ).map((group) => group.id),
    );
    assert.equal(lane.filter((id) => id.startsWith('ordinary-')).length, 1);
  }
  const gi4Lane = DAWN_GATE_SHARDS.findIndex((lane) => lane.includes('gi-4'));
  const gi5Lane = DAWN_GATE_SHARDS.findIndex((lane) => lane.includes('gi-5'));
  assert.notEqual(gi4Lane, gi5Lane, 'the two growing GI tails must not share the overrun lane');
  assert.throws(() => selectDawnShard('0/4'), /outside/);
  assert.throws(() => selectDawnShard('1/3'), /outside/);
  assert.throws(() => selectDawnShard('1/8'), /outside/);
  assert.throws(() => selectDawnGroups('ordinary-1', '1/4'), /mutually exclusive/);
});

test('the CI matrix and Dawn gate command match the authoritative lane count', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf('  vitest-dawn:\n');
  const end = workflow.indexOf('\n  vitest-dawn-required:\n', start);
  assert.ok(start >= 0 && end > start, 'the CI Dawn matrix job must remain explicit');
  const job = workflow.slice(start, end);
  const laneCount = DAWN_GATE_SHARDS.length;
  assert.match(
    job,
    /\n {4}timeout-minutes: 50\n/,
    'setup and cleanup have an explicit bounded allowance',
  );
  const nativeStep = parse(workflow).jobs['vitest-dawn'].steps.find((step) =>
    step.name?.startsWith('Vitest dawn project'),
  );
  assert.equal(
    nativeStep?.['timeout-minutes'],
    40,
    'the complete native test step retains a forty-minute execution bound',
  );
  assert.ok(job.includes(`name: vitest-dawn-\${{ matrix.shard }}-of-${laneCount}`));
  assert.ok(job.includes(`--shard "\${{ matrix.shard }}/${laneCount}"`));
  const matrix = /\n\s+shard:\s*\[([^\]]+)\]/.exec(job);
  assert.ok(matrix, 'the CI job must declare its complete shard matrix');
  assert.deepEqual(
    JSON.parse(`[${matrix[1]}]`),
    Array.from({ length: laneCount }, (_, index) => index + 1),
  );
});

test('specular AA keeps a complete owner outside ordinary discovery', () => {
  const group = selectDawnGroups('specular-aa')[0];
  assert.deepEqual(group.files, ['packages/runtime/src/__tests__/specular-aa.dawn.test.ts']);
  assert.ok(DAWN_GATE_SHARDS.flat().includes(group.id));
  assert.ok(!listDawnFiles().includes(group.files[0]));
});

test('complete Modeling journeys have fresh native owners without test filters', () => {
  for (const [id, file] of [
    ['modeling-s6', 'packages/modeling/examples/mech-gt/__tests__/s6.case.dawn.test.ts'],
    ['modeling-show', 'apps/modeling-show/__tests__/show.dawn.test.ts'],
  ]) {
    const [group] = selectDawnGroups(id);
    assert.deepEqual(group.files, [file]);
    assert.ok(!listDawnFiles().includes(file));
    const args = dawnVitestArgs(group);
    assert.ok(args.includes('--isolate'));
    assert.ok(!args.some((arg) => /testNamePattern|testTimeout|hookTimeout|--shard/.test(arg)));
    assert.equal(DAWN_GATE_SHARDS.flat().filter((owner) => owner === group.id).length, 1);
  }
});

test('four ordinary partitions conserve actual Vitest discovery', async () => {
  const ordinaryPartitions = DAWN_GATE_GROUPS.filter((group) => group.vitestShard !== undefined);
  assert.deepEqual(
    ordinaryPartitions.map(({ id, vitestShard }) => [id, vitestShard]),
    [
      ['ordinary-1', '1/4'],
      ['ordinary-2', '2/4'],
      ['ordinary-3', '3/4'],
      ['ordinary-4', '4/4'],
    ],
  );
  for (const group of ordinaryPartitions) {
    assert.deepEqual(group.files, []);
    assert.equal(group.retryMode, 'vitest-dawn');
    assert.ok(dawnVitestArgs(group).includes('--passWithNoTests=true'));
    assert.ok(dawnVitestArgs(group).includes(`--shard=${group.vitestShard}`));
  }
  for (const group of DAWN_GATE_GROUPS.filter((candidate) => candidate.vitestShard === undefined)) {
    assert.ok(!dawnVitestArgs(group).some((arg) => arg.startsWith('--shard')));
  }
  const ordinary = listDawnFiles();
  assert.equal(
    configuredSequencer.name,
    'DawnSequencer',
    'the real root config must install Dawn balancing',
  );
  const specifications = nativeSpecifications;
  assert.ok(specifications.every((specification) => specification.project.name === 'dawn'));
  const partitions = [];
  for (const selected of configuredPartitions) {
    partitions.push(
      ...selected.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')),
    );
  }
  assert.deepEqual(configuredPartitions, planDawnShards(specifications, root));
  assert.equal(new Set(partitions).size, partitions.length, 'Vitest shards must not overlap');
  assert.ok(
    configuredPartitions.every((partition) => partition.length > 0),
    'all native lanes must retain ordinary Dawn files after reserving fixed owner work',
  );
  assert.deepEqual(
    [...partitions].sort(),
    ordinary,
    'Vitest shards must conserve ordinary discovery',
  );
});

test('local, PR and Linux nightly execute the same complete gate', () => {
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:dawn'];
  assert.equal(command, 'node scripts/ci/run-test-suite.mjs dawn');
  const localEntry = readFileSync('scripts/ci/run-test-suite.mjs', 'utf8');
  assert.match(localEntry, /run\(\[\.\.\.node, 'scripts\/ci\/run-dawn-gate\.mjs'\]/);
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const nightly = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'));
  assert.equal(nightly.jobs['linux-ci'].uses, './.github/workflows/ci.yml');
  assert.equal(nightly.jobs['linux-ci'].with.nightly_full_profile, true);
  assert.ok(ci.on.workflow_call, 'Nightly must execute the same-commit CI workflow');
  assert.equal(ci.on.workflow_call.inputs.nightly_full_profile.default, false);
  const dawn = ci.jobs['vitest-dawn'];
  assert.deepEqual(dawn.strategy.matrix.shard, [1, 2, 3, 4]);
  const step = dawn.steps.find((candidate) =>
    candidate.run?.includes('node scripts/ci/run-dawn-gate.mjs --shard'),
  );
  assert.ok(step, 'the reused CI must execute the authoritative Dawn gate');
  assert.match(step.run, /--shard "\$\{\{ matrix\.shard \}\}\/4"/);
  assert.equal(step.env.NODE_OPTIONS, '--max-old-space-size=4096');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const profile = "${{ inputs.nightly_full_profile && '0' || '1' }}";
  assert.equal(step.env.FORGEAX_DAWN_LIGHTWEIGHT, profile);
});

test('Dawn discovery stays deterministic and admits new complete files without a copied roster', () => {
  const specifications = nativeSpecifications;
  const newFile = {
    moduleId: resolve(root, 'packages/new-owner/new.dawn.test.ts'),
    project: { name: 'dawn' },
  };
  const input = [...specifications, newFile];
  const planned = planDawnShards(input, root);
  assert.deepEqual(planDawnShards([...input].reverse(), root), planned);
  assert.equal(new Set(planned.flat()).size, input.length);
  assert.equal(planned.flat().filter((file) => file === newFile).length, 1);
  assert.deepEqual(new Set(planned.flat()), new Set(input));
});

test('only Dawn sharding changes; other projects retain native Vitest sequencing', async () => {
  const specs = Array.from({ length: 9 }, (_, index) => ({
    moduleId: resolve(root, `packages/other-owner/test-${index}.test.ts`),
    project: { name: 'unit' },
  }));
  const context = { config: { root, shard: { index: 2, count: 3 } } };
  assert.deepEqual(
    await new DawnSequencer(context).shard(specs),
    await new BaseSequencer(context).shard(specs),
  );
  const dawnSpecs = nativeSpecifications;
  assert.deepEqual(await new DawnSequencer({ config: { root } }).shard(dawnSpecs), dawnSpecs);
  await assert.rejects(new DawnSequencer(context).shard(dawnSpecs), /requires 4/);
});

test('completed ordinary children retain their expensive measured file shares', () => {
  const timings = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
  );
  // Run 41314021267: ordinary-2 completed successfully in 1463.899 seconds.
  // Include its process overhead across all 86 files, including seven skipped files.
  const observed = [
    // All four ordinary children completed before run 41741792994's parent deadline.
    ['packages/modeling/examples/mech-gt/__tests__/s6b-paint.case.dawn.test.ts', 321.266],
    ['packages/runtime/src/__tests__/standard-displacement.dawn.test.ts', 189.231],
    ['packages/devkit/src/tools/__tests__/model-views.dawn.test.ts', 111.087],
    ['packages/devkit/src/tools/__tests__/model-render.dawn.test.ts', 88.96],
    ['packages/modeling/examples/mech-gt/__tests__/s6c.case.dawn.test.ts', 282.232],
    // Run 41959265373 measured the new buffer compatibility file at 176 ms,
    // plus its equal share of the completed ordinary-2 process overhead.
    ['packages/rhi-webgpu/src/__tests__/buffer-compatibility.dawn.test.ts', 1.521],
    ['packages/three/src/__tests__/render.dawn.test.ts', 98.374],
    // All four ordinary children completed in 41541125949; cleanup remains
    // part of their file shares even though a later native owner was interrupted.
    ['packages/devkit/src/tools/__tests__/model-surface-views.dawn.test.ts', 114.911],
    // Run 41526304488: all four ordinary children completed, including skips.
    ['packages/modeling/examples/armor-bake/__tests__/armor.case.dawn.test.ts', 98.538],
    ['packages/modeling/examples/mech-gt/__tests__/s6a.case.dawn.test.ts', 67.859],
    ['packages/render/src/__tests__/portable-kernel-expansion.dawn.test.ts', 5.259],
    // Run 41539054992: completed ordinary work on the slower native lanes.
    ['packages/runtime/src/__tests__/standard-planar-reflection.dawn.test.ts', 115.956],
    ['packages/devkit/src/tools/__tests__/model-surface-views.dawn.test.ts', 72.02],
  ];
  for (const [file, seconds] of observed) {
    assert.ok(
      timings.files[file] >= seconds,
      `completed file must retain its wall-time share: ${file} (${timings.files[file]} < ${seconds})`,
    );
  }
  assert.ok(timings.owners['compact-3'] >= 144.151);
  assert.ok(timings.owners['direct-light'] >= 219.011);
  assert.ok(timings.owners['heavy-3'] >= 41.761);
});

test('ordinary backfill honors native-owner placement reserves without losing files', () => {
  const timings = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
  );
  const fallback = Math.max(...Object.values(timings.files));
  const fileCost = (file) => timings.files[file] ?? fallback;
  const nativeLoads = [];
  const loads = DAWN_GATE_SHARDS.map((ids, index) => {
    const reserved = ids
      .filter((id) => !id.startsWith('ordinary-'))
      .reduce((sum, id) => {
        const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
        const measured =
          timings.owners[id] ?? group.files.reduce((n, file) => n + fileCost(file), 0);
        const cost = Math.max(measured, group.placementReserveSeconds ?? 0);
        return sum + cost;
      }, 0);
    nativeLoads.push(reserved);
    return (
      reserved +
      configuredPartitions[index].reduce(
        (sum, specification) =>
          sum + fileCost(relative(root, specification.moduleId).replaceAll('\\', '/')),
        0,
      )
    );
  });
  const largest = Math.max(
    ...nativeSpecifications.map((specification) =>
      fileCost(relative(root, specification.moduleId).replaceAll('\\', '/')),
    ),
  );
  const mostReserved = nativeLoads.indexOf(Math.max(...nativeLoads));
  const leastReserved = nativeLoads.indexOf(Math.min(...nativeLoads));
  assert.ok(
    loads[mostReserved] - nativeLoads[mostReserved] <
      loads[leastReserved] - nativeLoads[leastReserved],
    'ordinary backfill must compensate for unequal complete native-owner reserves',
  );
  assert.ok(
    Math.max(...loads) - Math.min(...loads) <= largest + 1e-6,
    `native reserves must participate before ordinary backfill: ${loads.join(', ')}`,
  );
  assert.equal(
    new Set(configuredPartitions.flat().map((spec) => spec.moduleId)).size,
    nativeSpecifications.length,
  );
});

test('the largest ordinary files start on distinct native lanes before backfill', () => {
  const timings = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
  );
  const ranked = [...nativeSpecifications].sort((left, right) => {
    const leftPath = relative(root, left.moduleId).replaceAll('\\', '/');
    const rightPath = relative(root, right.moduleId).replaceAll('\\', '/');
    const leftSeconds = timings.files[leftPath];
    const rightSeconds = timings.files[rightPath];
    return rightSeconds - leftSeconds || leftPath.localeCompare(rightPath);
  });
  const firstWave = ranked.slice(0, DAWN_GATE_SHARDS.length);
  const lanes = firstWave.map((file) =>
    configuredPartitions.findIndex((partition) =>
      partition.some((candidate) => candidate.moduleId === file.moduleId),
    ),
  );
  assert.ok(lanes.every((lane) => lane >= 0));
  assert.equal(new Set(lanes).size, DAWN_GATE_SHARDS.length);
});

test('partial run 42369476147 separates complete process costs from inherited forecasts', () => {
  const timings = JSON.parse(readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json')));
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-42369476147.json', import.meta.url)),
  );
  assert.deepEqual(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      (row) => row.runId === snapshot.runId,
    ),
    snapshot,
  );
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.ordinaryProcesses, 3);
  assert.equal(Object.keys(snapshot.files).length, 268);
  assert.equal(Object.keys(snapshot.reservedFiles).length, 96);
  assert.deepEqual(snapshot.interruptedOrdinaryProcesses, ['ordinary-4']);
  assert.deepEqual(
    snapshot.ordinaryReceipts.map((row) => row.id),
    ['ordinary-1', 'ordinary-2', 'ordinary-3'],
  );
  const measured = Object.values(snapshot.files).reduce((sum, seconds) => sum + seconds, 0);
  const completed = snapshot.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(measured - completed) < 0.001);
  for (const row of snapshot.ordinaryReceipts) {
    assert.equal(row.result, 'passed');
    assert.equal(row.runId, snapshot.runId);
    assert.ok(
      Math.abs(
        row.reportedTestSeconds +
          row.fileCount * row.derivedOverheadSecondsPerFile -
          row.processWallSeconds,
      ) < 0.001,
    );
  }
  const allFiles = [...Object.keys(snapshot.files), ...Object.keys(snapshot.reservedFiles)];
  assert.equal(new Set(allFiles).size, nativeSpecifications.length);
  assert.deepEqual(
    allFiles.sort(),
    nativeSpecifications
      .map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/'))
      .sort(),
  );
  const [forecast] = snapshot.ordinaryForecasts;
  const source = JSON.parse(
    readFileSync(
      new URL(`./fixtures/dawn-completed-${forecast.sourceRunId}.json`, import.meta.url),
    ),
  );
  assert.equal(forecast.sourceRunId, 42325043736);
  assert.equal(forecast.sourceHead, '0586371c6463510adfc21fccd813689c31ca31e0');
  assert.equal(forecast.id, 'ordinary-4');
  assert.equal(forecast.fileCount, 96);
  assert.equal(
    forecast.reservedProcessSeconds,
    source.ordinaryProcesses.find((row) => row.id === forecast.sourceOrdinaryProcess)
      .processWallSeconds,
  );
  const reserved = Object.values(snapshot.reservedFiles).reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(Math.abs(reserved - forecast.reservedProcessSeconds) < 0.001);
  const basis = Object.keys(snapshot.reservedFiles).reduce(
    (sum, file) => sum + source.files[file],
    0,
  );
  for (const [file, seconds] of Object.entries(snapshot.reservedFiles)) {
    assert.ok(!Object.hasOwn(snapshot.files, file));
    assert.ok(Math.abs(seconds - (source.files[file] * reserved) / basis) < 0.000001);
  }
  for (const [file, seconds] of Object.entries(snapshot.files)) {
    assert.ok(timings.files[file] >= seconds);
  }
});

test('historical missing-file forecasts stay frozen when later measurements grow', () => {
  const timings = JSON.parse(readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json')));
  const snapshots = [timings.previousRun, ...timings.replayRuns];
  for (const snapshot of snapshots.filter((row) => row.fileForecast)) {
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/dawn-completed-${snapshot.runId}.json`, import.meta.url)),
    );
    assert.deepEqual(snapshot.files, fixture.files);
    assert.deepEqual(snapshot.owners, fixture.owners);
    assert.deepEqual(snapshot.reservedFiles, fixture.reservedFiles);
    assert.deepEqual(snapshot.fileForecast, fixture.fileForecast);
    assert.equal(snapshot.fileForecast.sourceHead, '9d67578ad93a06b4883e20b6998485ac540a2a8f');
    assert.equal(Object.keys(snapshot.reservedFiles).length, snapshot.fileForecast.fileCount);
    for (const [file, seconds] of Object.entries(snapshot.reservedFiles)) {
      assert.ok(!Object.hasOwn(snapshot.files, file));
      assert.ok(seconds > 0 && seconds <= timings.files[file]);
    }
  }
  const frozen = snapshots.find((row) => row.runId === 42164226420).reservedFiles;
  assert.equal(
    frozen['packages/render/src/__tests__/tsr-feedback.dawn.test.ts'],
    3.826859999999999,
  );
  assert.equal(
    frozen['packages/runtime/src/__tests__/tsr-renderer.dawn.test.ts'],
    24.38884210526316,
  );
});

for (const receipt of [
  { runId: 42411246807, fileCount: 364, ownerCount: 28, missing: ['gi-3'] },
  {
    runId: 42394605381,
    fileCount: 364,
    ownerCount: 22,
    missing: ['gpu-timing', 'heavy-3', 'heavy-4', 'specular-aa', 'gi-1', 'gi-3', 'gi-6'],
  },
  { runId: 42388664877, fileCount: 364, ownerCount: 28, missing: ['direct-light'] },
  {
    runId: 42369476147,
    fileCount: 268,
    ownerCount: 26,
    missing: ['renderer', 'direct-light', 'gi-4'],
  },
  { runId: 42325043736, fileCount: 364, ownerCount: 28, missing: ['surface-pipelines'] },
  { runId: 42252922786, fileCount: 364, ownerCount: 29, missing: [] },
  { runId: 41856822044, ownerCount: 27, missing: ['gi-5', 'direct-light'] },
  { runId: 41741792994, ownerCount: 27, missing: ['gi-1', 'gi-5'] },
  { runId: 41840653604, ownerCount: 28, missing: ['gi-5'] },
  { runId: 41891389810, ownerCount: 27, missing: ['gi-4', 'direct-light'] },
  { runId: 42076518011, ownerCount: 28, missing: ['direct-light'] },
  { runId: 42146194978, ownerCount: 28, missing: ['screen-probe'] },
  {
    runId: 42164226420,
    fileCount: 359,
    ownerCount: 26,
    missing: ['gi-2', 'gi-5', 'direct-light'],
  },
  { runId: 42112381149, ownerCount: 27, missing: ['gi-1', 'gi-5'] },
  { runId: 42122803571, ownerCount: 28, missing: ['gi-5'] },
  { runId: 42130885413, ownerCount: 27, missing: ['shadow-fields', 'screen-probe'] },
  { runId: 42156059037, ownerCount: 27, missing: ['direct-light', 'gi-6'] },
  {
    runId: 42277039108,
    fileCount: 360,
    ownerCount: 22,
    missing: [
      'direct-light',
      'gi-3',
      'heavy-1',
      'heavy-2',
      'screen-probe',
      'shadow-fields',
      'transmission',
    ],
  },
]) {
  test(`run ${receipt.runId} retains three minutes of native-step headroom`, (t) => {
    const timings = JSON.parse(
      readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
    );
    const snapshot = JSON.parse(
      readFileSync(
        new URL(`./fixtures/dawn-completed-${receipt.runId}.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.equal(snapshot.runId, receipt.runId);
    assert.equal(Object.keys(snapshot.files).length, receipt.fileCount ?? 354);
    assert.equal(Object.keys(snapshot.owners).length, receipt.ownerCount);

    const ordinaryFiles = configuredPartitions.flatMap((partition) =>
      partition.map((specification) =>
        relative(root, specification.moduleId).replaceAll('\\', '/'),
      ),
    );
    assert.equal(new Set(ordinaryFiles).size, nativeSpecifications.length);
    // Historical receipts keep every original file. New complete owners enter
    // the same lane-cost calculation below with its conservative fallback.
    assert.deepEqual(
      ordinaryFiles.filter((file) => Object.hasOwn(snapshot.files, file)).sort(),
      Object.keys(snapshot.files).sort(),
    );

    const fallback = Math.max(...Object.values(timings.files));
    const fileCost = (file) =>
      snapshot.files[file] ?? snapshot.reservedFiles?.[file] ?? timings.files[file] ?? fallback;
    const laneSeconds = DAWN_GATE_SHARDS.map((owners, lane) => {
      const ordinarySeconds = configuredPartitions[lane].reduce(
        (sum, specification) =>
          sum + fileCost(relative(root, specification.moduleId).replaceAll('\\', '/')),
        0,
      );
      const ownerSeconds = owners
        .filter((id) => !id.startsWith('ordinary-'))
        .reduce((sum, id) => {
          const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
          const completed = snapshot.owners[id];
          const retained =
            timings.owners[id] ?? group.files.reduce((total, file) => total + fileCost(file), 0);
          return sum + (completed ?? Math.max(retained, group.placementReserveSeconds ?? 0));
        }, 0);
      // Retain five seconds for each run's complete shader-profile producer.
      return ordinarySeconds + ownerSeconds + 5;
    });

    assert.ok(
      Math.max(...laneSeconds) <= 2_200,
      `completed receipts should preserve three minutes below the unchanged 40-minute Dawn step; got ${laneSeconds.map((seconds) => seconds.toFixed(1)).join(', ')}s`,
    );
    assert.ok(
      [timings.latestRun, timings.previousRun, ...timings.replayRuns].some(
        (run) => run.runId === receipt.runId,
      ),
      'every retained regression scenario must participate in placement',
    );
    for (const id of receipt.missing) assert.ok(!Object.hasOwn(snapshot.owners, id));
    if (!receipt.missing.includes('shadow-fields'))
      assert.ok(Object.hasOwn(snapshot.owners, 'shadow-fields'));
    t.diagnostic(JSON.stringify({ runId: receipt.runId, laneSeconds }));
  });
}

for (const receipt of [
  { runId: 42411246807, fileCount: 364 },
  { runId: 42394605381, fileCount: 364 },
  { runId: 42388664877, fileCount: 364 },
  { runId: 42277039108, fileCount: 360 },
  { runId: 42325043736, fileCount: 364 },
]) {
  test(`run ${receipt.runId} retains complete ordinary overhead without interrupted samples`, () => {
    const snapshot = JSON.parse(
      readFileSync(
        new URL(`./fixtures/dawn-completed-${receipt.runId}.json`, import.meta.url),
        'utf8',
      ),
    );
    const timings = JSON.parse(
      readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
    );
    const retained = [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      (run) => run.runId === receipt.runId,
    );
    assert.ok(retained);
    assert.deepEqual(retained.files, snapshot.files);
    assert.deepEqual(retained.owners, snapshot.owners);
    const processSeconds = snapshot.ordinaryProcesses.reduce(
      (sum, row) => sum + row.elapsedSeconds,
      0,
    );
    const fileSeconds = Object.values(snapshot.files).reduce((sum, seconds) => sum + seconds, 0);
    assert.ok(Math.abs(processSeconds - fileSeconds) < 0.001);
    assert.equal(
      snapshot.ordinaryProcesses.reduce((sum, row) => sum + row.fileCount, 0),
      receipt.fileCount,
    );
    for (const owner of [...snapshot.interruptedOwners, ...snapshot.unstartedOwners]) {
      assert.ok(!Object.hasOwn(snapshot.owners, owner));
      assert.ok(timings.owners[owner] > 0);
    }
    for (const [file, seconds] of Object.entries(snapshot.files)) {
      assert.ok(timings.files[file] >= seconds);
    }
  });
}

test('latest Dawn timing ledger retains the preceding maximum measurements', () => {
  const timings = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
  );
  const previousLedger = JSON.parse(
    readFileSync(
      new URL('./fixtures/dawn-ledger-before-41998440989.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(timings.latestRun.runId, Math.max(...timings.runs));
  assert.ok(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].some(
      (run) => run.runId === 42076518011,
    ),
    'the preceding complete cohort remains in the retained planner',
  );
  for (const [file, seconds] of Object.entries(previousLedger.files)) {
    assert.ok(timings.files[file] >= seconds, `historical file maximum decreased: ${file}`);
  }
  for (const [owner, seconds] of Object.entries(previousLedger.owners)) {
    assert.ok(timings.owners[owner] >= seconds, `historical owner maximum decreased: ${owner}`);
  }
});

test('long native capture journeys start before ordinary backfill', () => {
  for (const id of ['modeling-s6', 'modeling-show', 'gi-5', 'surface-pipelines', 'direct-light']) {
    const lane = DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id));
    const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
    assert.ok(
      group.placementReserveSeconds >= (id === 'direct-light' ? 219.011 : 600),
      'retain measured capture headroom without changing the case deadline',
    );
    const selected = selectDawnShard(`${lane + 1}/4`);
    assert.ok(
      selected.findIndex((candidate) => candidate.id === id) <
        selected.findIndex((candidate) => candidate.id.startsWith('ordinary-')),
      'reserved complete capture journeys must start before ordinary backfill',
    );
  }
  for (const id of ['modeling-s6', 'modeling-show']) {
    const lane = DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id));
    assert.equal(selectDawnShard(`${lane + 1}/4`)[0].id, id);
  }
  const lanes = ['modeling-s6', 'modeling-show', 'gi-5'].map((id) =>
    DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id)),
  );
  assert.equal(
    new Set(lanes).size,
    lanes.length,
    'independent long capture journeys must not accumulate on one slow runner',
  );
});

test('run 42147390301 tail owners stay off the formerly overloaded fourth lane', () => {
  const fourthLane = DAWN_GATE_SHARDS[3];
  for (const id of ['modeling-s6', 'screen-probe', 'transmission']) {
    assert.ok(!fourthLane.includes(id), `${id} must use capacity outside the measured slow lane`);
  }
});

test('run 42156059037 timeouts reserve the fourth lane before ordinary backfill', () => {
  const laneOf = (id) => DAWN_GATE_SHARDS.findIndex((lane) => lane.includes(id));
  assert.deepEqual(DAWN_GATE_SHARDS[3], ['ordinary-4', 'surface-pipelines', 'gi-5', 'gi-3']);
  for (const id of ['shadow-fields', 'heavy-1', 'heavy-2']) {
    assert.equal(laneOf(id), 0, `${id} moves to the measured lane-one headroom`);
  }
  for (const id of [
    'compact-1',
    'feature-depth',
    'timing-lifecycle',
    'gi-6',
    'vfx-depth',
    'nested-discard',
  ]) {
    assert.equal(laneOf(id), 1, `${id} moves to the measured lane-two headroom`);
  }
  assert.equal(laneOf('compact-3'), 0, 'run 42411246807 exchanges complete compact owners');
  for (const id of ['compact-2', 'direct-light', 'gi-4']) {
    assert.equal(laneOf(id), 2, `${id} stays with the reduced third-lane workload`);
  }
  assert.equal(laneOf('gi-5'), 3, 'GI-5 reserves ordinary-file headroom in lane four');
  assert.equal(
    laneOf('surface-pipelines'),
    3,
    'complete surface work replaces ordinary backfill after run 42247651279',
  );
});

test('run 42277039108 spreads complete native forecasts across ordinary lanes', () => {
  const laneOf = (id) => DAWN_GATE_SHARDS.findIndex((lane) => lane.includes(id));
  assert.equal(laneOf('gi-2'), 0);
  assert.equal(laneOf('transmission'), 1);
  assert.equal(laneOf('gi-3'), 3);
  assert.equal(laneOf('gi-1'), 2);
  assert.equal(laneOf('modeling-s6'), 0);
  assert.equal(laneOf('gpu-timing'), 0);
  assert.equal(laneOf('gi-4'), 2);
  assert.notEqual(laneOf('gi-4'), laneOf('gi-5'));
});

test('run 42247651279 leaves ordinary-file headroom on the fourth lane', () => {
  const timings = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/dawn-file-seconds.json'), 'utf8'),
  );
  // Preserve this regression's original completed cohort when latestRun moves.
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-42164226420.json', import.meta.url), 'utf8'),
  );
  const seconds = configuredPartitions[3].reduce((sum, file) => {
    const path = relative(root, file.moduleId).replaceAll('\\', '/');
    return (
      sum +
      (snapshot.files[path] ?? timings.files[path] ?? Math.max(...Object.values(timings.files)))
    );
  }, 0);
  assert.ok(seconds <= 1550, `ordinary-4 must shed backfill after its timeout: ${seconds}s`);
});

test('measured heavy ordinary files spread without extra owners', (t) => {
  const locations = new Map(
    configuredPartitions.flatMap((partition, lane) =>
      partition.map(({ moduleId }) => [relative(root, moduleId).replaceAll('\\', '/'), lane + 1]),
    ),
  );
  // Whole-file swaps must spread the three heavy consumers that previously
  // accumulated in ordinary-2; destinations derive from measured capacity.
  const heavy = [
    'packages/modeling/examples/body-panels/__tests__/panels.case.dawn.test.ts',
    'packages/modeling/examples/mech-gt/__tests__/s6c.case.dawn.test.ts',
    'packages/devkit/src/tools/__tests__/model-views.dawn.test.ts',
  ];
  for (const file of heavy) assert.ok(locations.has(file), file);
  assert.ok(new Set(heavy.map((file) => locations.get(file))).size >= 2);
  assert.equal(locations.size, nativeSpecifications.length);
  assert.equal(DAWN_GATE_SHARDS.length, 4);
  assert.equal(DAWN_GATE_SHARDS.flat().length, DAWN_GATE_GROUPS.length);
  t.diagnostic(
    JSON.stringify({
      ordinaryFiles: nativeSpecifications.length,
      uniqueOrdinaryFiles: locations.size,
      nativeOwners: DAWN_GATE_GROUPS.length,
      uniqueNativeOwners: new Set(DAWN_GATE_SHARDS.flat()).size,
      heavyFiles: heavy.map((file) => [file, locations.get(file)]),
    }),
  );
});
