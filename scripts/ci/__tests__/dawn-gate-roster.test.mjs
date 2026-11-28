import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { BaseSequencer, createVitest } from 'vitest/node';
import { parse } from 'yaml';
import {
  dawnFileOwnerCosts,
  dawnPlanningFileCosts,
  dawnPlanningOwnerCosts,
  readDawnTimings,
} from '../../../config/dawn-timings.ts';
import { DawnSequencer, planDawnShards } from '../../../config/vitest-dawn-sequencer.ts';
import { dawnOrdinaryWorkers, runnerResources } from '../../lib/runner-resources.mjs';
import { DAWN_COMPACT_TEST_FILES } from '../dawn-compact-roster.mjs';
import {
  DAWN_GATE_GROUPS,
  DAWN_GATE_SHARDS,
  DAWN_ORDINARY_FILE_FAMILIES,
  DAWN_VITEST_CONFIG,
} from '../dawn-gate-roster.mjs';
import { nativeValidationLanes } from '../native-validation-scope.mjs';
import {
  dawnGroupEnvironment,
  dawnVitestArgs,
  selectDawnGroups,
  selectDawnShard,
  validateDawnGateRoster,
} from '../run-dawn-gate.mjs';

const root = resolve('.');
const selectors = [
  'FORGEAX_DAWN_ISOLATED',
  'FORGEAX_DAWN_COMPACT',
  'FORGEAX_DAWN_PARTITION',
  'FORGEAX_DAWN_SERIAL_ORDINARY',
];
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

// Replay the explicitly admitted Linux CI executor; local discovery remains serial.
const shippingPartitions = planDawnShards(nativeSpecifications, root, 2);
const familyChildren = new Set(DAWN_ORDINARY_FILE_FAMILIES.flatMap(({ children }) => children));
const isLogicalOwner = ({ moduleId }) =>
  !familyChildren.has(relative(root, moduleId).replaceAll('\\', '/'));

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

test('Dawn sharding follows the resolved project pool when root CLI workers differ', async () => {
  const specifications = nativeSpecifications.map(({ moduleId, project }) => ({
    moduleId,
    project: { name: project.name, config: { maxWorkers: 2 } },
  }));
  const selected = await new DawnSequencer({
    config: {
      root,
      maxWorkers: 1,
      shard: { index: 1, count: 4 },
    },
  }).shard(specifications);
  assert.deepEqual(
    selected.map(({ moduleId }) => moduleId),
    shippingPartitions[0].map(({ moduleId }) => moduleId),
  );
  await assert.rejects(
    new DawnSequencer({ config: { root, shard: { index: 1, count: 4 } } }).shard([
      {
        moduleId: specifications[0].moduleId,
        project: { name: 'dawn', config: { maxWorkers: 96 } },
      },
    ]),
    /exactly one or two/,
  );
});

test('the opt-in ordinary pool is bounded and retains separate native forks', () => {
  const admitted = { cpus: 8, memoryBytes: 16_000_000_000 };
  assert.equal(dawnOrdinaryWorkers({}, admitted), 1);
  assert.equal(dawnOrdinaryWorkers({ FORGEAX_DAWN_ORDINARY_WORKERS: '2' }, admitted), 2);
  for (const requested of ['', '0', '3', '96', '2junk']) {
    assert.throws(
      () => dawnOrdinaryWorkers({ FORGEAX_DAWN_ORDINARY_WORKERS: requested }, admitted),
      /exactly 1 or 2/,
    );
  }
  for (const resources of [
    { cpus: 7, memoryBytes: admitted.memoryBytes },
    { cpus: 8, memoryBytes: admitted.memoryBytes - 1 },
  ]) {
    assert.throws(
      () => dawnOrdinaryWorkers({ FORGEAX_DAWN_ORDINARY_WORKERS: '2' }, resources),
      /at least eight CPUs and 16 GB/,
    );
  }
  for (const group of DAWN_GATE_GROUPS) {
    const args = dawnVitestArgs(group, { ordinaryWorkers: 2 });
    const ordinary = group.vitestShard !== undefined;
    const env = dawnGroupEnvironment(group, { LP_NUM_THREADS: '8' }, 2);
    const bounded = ordinary || group.limitSoftwareGpuWorkers;
    const rasterThreads = group.softwareGpuHeapRasterThreads ?? (bounded ? 4 : 8);
    assert.equal(env.LP_NUM_THREADS, String(rasterThreads));
    assert.equal(
      env.MALLOC_ARENA_MAX,
      group.softwareGpuHeapRasterThreads !== undefined ? '2' : undefined,
    );
    assert.equal(
      env.MALLOC_TRIM_THRESHOLD_,
      group.softwareGpuHeapRasterThreads !== undefined ? '131072' : undefined,
    );
    assert.equal(env.FORGEAX_SHADER_COMPILE_WORKERS, bounded ? '1' : undefined);
    assert.equal(
      env.GALLIVM_PERF,
      ['default-gbuffer-gi', 'screen-probe-support', 'world-card-bounds'].includes(group.id)
        ? 'nopt'
        : undefined,
    );
    const parallel = ordinary && !group.serialOrdinary;
    assert.ok(args.includes(`--maxWorkers=${parallel ? 2 : 1}`));
    assert.equal(args.includes('--pool=forks'), parallel);
    assert.equal(args.includes('--fileParallelism=true'), parallel);
    assert.equal(env.FORGEAX_DAWN_SERIAL_ORDINARY, group.serialOrdinary ? '2' : undefined);
    assert.equal(args.includes('--reporter=default'), ordinary);
    assert.equal(
      args.some((arg) => arg.replaceAll('\\', '/').endsWith('/modeling-file-phase-reporter.mjs')),
      ordinary,
    );
    assert.equal(args.includes('--no-file-parallelism'), !parallel);
    assert.equal(args.includes('--no-isolate'), group.id.startsWith('heavy-'));
  }
});

test('the resolved project consumes the bounded pool policy instead of masking CLI workers', () => {
  const resources = runnerResources();
  const admitted = resources.cpus >= 8 && resources.memoryBytes >= 16_000_000_000;
  for (const selector of [null, ...selectors]) {
    const env = { ...process.env, FORGEAX_DAWN_ORDINARY_WORKERS: '2' };
    for (const name of selectors) delete env[name];
    if (selector) env[selector] = '1';
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createVitest } from 'vitest/node';
         let v;
         try {
           v = await createVitest('test', {
             config: 'config/vitest.dawn.config.ts', project: ['dawn'],
             maxWorkers: 2, fileParallelism: true, pool: 'forks', watch: false,
           });
           const c = v.projects.find(p => p.name === 'dawn').config;
           console.log(JSON.stringify({ workers: c.maxWorkers, pool: c.pool,
             isolate: c.isolate, testTimeout: c.testTimeout }));
         } catch (error) { console.log(JSON.stringify({ error: error.message })); }
         finally { await v?.close(); }`,
      ],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const policy = JSON.parse(output.trim());
    if (!selector && !admitted) {
      assert.match(policy.error, /at least eight CPUs and 16 GB/);
    } else {
      assert.deepEqual(policy, {
        workers: selector ? 1 : 2,
        pool: 'forks',
        isolate: true,
        testTimeout: 30000,
      });
    }
  }
});

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
  assert.match(
    parse(workflow).jobs['vitest-dawn'].strategy.matrix.shard,
    /core-build.outputs.dawn_shards/,
  );
  assert.deepEqual(
    nativeValidationLanes.dawn,
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
  assert.match(dawn.strategy.matrix.shard, /core-build.outputs.dawn_shards/);
  const step = dawn.steps.find((candidate) =>
    candidate.run?.includes('node scripts/ci/run-dawn-gate.mjs --shard'),
  );
  assert.ok(step, 'the reused CI must execute the authoritative Dawn gate');
  assert.match(step.run, /--shard "\$\{\{ matrix\.shard \}\}\/4"/);
  assert.equal(step.env.NODE_OPTIONS, '--max-old-space-size=4096');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const profile = "${{ inputs.nightly_full_profile && '0' || '1' }}";
  assert.equal(step.env.FORGEAX_DAWN_LIGHTWEIGHT, profile);
  assert.equal(step.env.FORGEAX_DAWN_ORDINARY_WORKERS, '2');
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

test('VFX depth reserves its complete native lifetime before ordinary backfill', () => {
  const group = DAWN_GATE_GROUPS.find(({ id }) => id === 'vfx-depth');
  assert.equal(group.placementReserveSeconds, 600);
  assert.ok(group.placementReserveSeconds >= readDawnTimings().owners['vfx-depth']);
});

test('unmeasured native files have deadline reserves without replacing observations', () => {
  const timings = readDawnTimings();
  const ordinary = new Set([
    ...nativeSpecifications.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')),
    ...DAWN_GATE_GROUPS.flatMap((group) => group.files),
  ]);
  for (const [file, seconds] of Object.entries(timings.fileReserves)) {
    assert.ok(ordinary.has(file), file);
    assert.ok(!Object.hasOwn(timings.files, file), `retire the provisional reserve for ${file}`);
    assert.ok(Number.isFinite(seconds) && seconds > 0, file);
    assert.equal(timings.planningFiles[file], seconds);
  }
});

test('completed ordinary children retain their expensive measured file shares', () => {
  const timings = readDawnTimings();
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
  const timings = readDawnTimings();
  const fallback = Math.max(...Object.values(timings.files));
  const fileCost = (file) =>
    familyChildren.has(file) ? 0 : (timings.planningFiles[file] ?? fallback);
  const nativeLoads = [];
  const loads = DAWN_GATE_SHARDS.map((ids, index) => {
    const reserved = ids
      .filter((id) => !id.startsWith('ordinary-'))
      .reduce((sum, id) => {
        const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
        const measured =
          timings.planningOwners[id] ?? group.files.reduce((n, file) => n + fileCost(file), 0);
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
  // Historical owners backfill around native reserves before new owners enter
  // the remaining capacity at their full conservative forecast.
  const measuredBackfill = configuredPartitions.map((partition) =>
    partition.reduce((sum, specification) => {
      const file = relative(root, specification.moduleId).replaceAll('\\', '/');
      return sum + (timings.planningFiles[file] === undefined ? 0 : fileCost(file));
    }, 0),
  );
  assert.ok(
    measuredBackfill[mostReserved] < measuredBackfill[leastReserved],
    `measured backfill must compensate for unequal native-owner reserves; native=${nativeLoads.join(', ')} backfill=${measuredBackfill.join(', ')}`,
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
  const timings = readDawnTimings();
  const ranked = nativeSpecifications.filter(isLogicalOwner).sort((left, right) => {
    const leftPath = relative(root, left.moduleId).replaceAll('\\', '/');
    const rightPath = relative(root, right.moduleId).replaceAll('\\', '/');
    const unmeasured = Math.max(...Object.values(timings.planningFiles));
    const leftSeconds = timings.planningFiles[leftPath] ?? unmeasured;
    const rightSeconds = timings.planningFiles[rightPath] ?? unmeasured;
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

test('later discoveries retain conservative capacity without entering old measured windows', () => {
  const timings = readDawnTimings();
  const fallback = Math.max(...Object.values(timings.planningFiles));
  const added = {
    moduleId: resolve(root, 'packages/render/src/__tests__/unmeasured-discovery.dawn.test.ts'),
    project: nativeSpecifications[0].project,
  };
  // Model one later discovery after a known planning cohort. The current worktree
  // may itself contain several new, equally conservative unmeasured owners.
  const known = nativeSpecifications.filter(
    (file) =>
      timings.planningFiles[relative(root, file.moduleId).replaceAll('\\', '/')] !== undefined,
  );
  assert.ok(known.length >= DAWN_GATE_SHARDS.length);
  const files = [...known, added];
  const qualified = planDawnShards(known, root, 2);
  const partitions = planDawnShards(files, root, 2);
  for (const [lane, owners] of qualified.entries())
    for (const owner of owners)
      assert.ok(
        partitions[lane].includes(owner),
        'new discovery must preserve qualified placement',
      );
  assert.equal(partitions.flat().length, files.length);
  assert.equal(new Set(partitions.flat().map((file) => file.moduleId)).size, files.length);
  const cost = (file) =>
    timings.planningFiles[relative(root, file.moduleId).replaceAll('\\', '/')] ?? fallback;
  const firstWave = files
    .filter(isLogicalOwner)
    .sort((left, right) => cost(right) - cost(left) || left.moduleId.localeCompare(right.moduleId))
    .slice(0, DAWN_GATE_SHARDS.length);
  assert.ok(firstWave.includes(added), 'an unmeasured file retains the largest capacity forecast');
  const lanes = firstWave.map((file) => partitions.findIndex((row) => row.includes(file)));
  assert.equal(new Set(lanes).size, DAWN_GATE_SHARDS.length);
});

test('partial run 42369476147 separates complete process costs from inherited forecasts', () => {
  const timings = readDawnTimings();
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
  const currentFiles = new Set([
    ...nativeSpecifications.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')),
    ...DAWN_GATE_GROUPS.flatMap((group) => group.files),
  ]);
  assert.equal(new Set(allFiles).size, 364);
  assert.ok(
    allFiles
      .filter((file) => existsSync(resolve(root, file)))
      .every((file) => currentFiles.has(file)),
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

test('historical missing-owner forecasts stay frozen when later measurements grow', () => {
  const timings = readDawnTimings();
  const rows = [timings.previousRun, ...timings.replayRuns];
  const inherited = rows.filter((row) => row.reservedOwners?.['direct-light'] === 219.011);
  assert.equal(inherited.length, 8);
  for (const row of inherited) {
    assert.equal(row.owners['direct-light'], undefined, 'a frozen forecast is not an observation');
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/dawn-completed-${row.runId}.json`, import.meta.url)),
    );
    assert.deepEqual(row.reservedOwners, fixture.reservedOwners);
  }
  const admitted = [...rows, timings.latestRun].find((row) => row.runId === 42778322662);
  assert.equal(admitted.owners['direct-light'], 350.217);
  assert.ok(timings.owners['direct-light'] >= 350.217, 'retain the larger current capacity cost');
});

test('historical missing-file forecasts stay frozen when later measurements grow', () => {
  const timings = readDawnTimings();
  const snapshots = [timings.previousRun, ...timings.replayRuns];
  for (const snapshot of snapshots.filter((row) => row.fileForecast)) {
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/dawn-completed-${snapshot.runId}.json`, import.meta.url)),
    );
    assert.deepEqual(snapshot.files, fixture.files);
    assert.deepEqual(snapshot.owners, fixture.owners);
    assert.deepEqual(snapshot.reservedFiles, fixture.reservedFiles);
    assert.deepEqual(snapshot.fileForecast, fixture.fileForecast);
    assert.equal(
      snapshot.fileForecast.sourceHead,
      snapshot.fileForecast.kind === 'partial-process-reserve'
        ? snapshot.head
        : '9d67578ad93a06b4883e20b6998485ac540a2a8f',
    );
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
  {
    runId: 43819262879,
    fileCount: 401,
    ownerCount: 23,
    missing: ['heavy-1', 'heavy-2', 'shadow-fields', 'gi-1'],
  },
  {
    runId: 43744332755,
    fileCount: 401,
    ownerCount: 25,
    missing: ['gi-3', 'screen-probe'],
  },
  {
    runId: 43718751716,
    fileCount: 390,
    ownerCount: 23,
    missing: ['transmission', 'gi-1', 'gi-2', 'gi-4'],
  },
  {
    runId: 43693841655,
    fileCount: 390,
    ownerCount: 26,
    missing: ['screen-probe'],
  },
  {
    runId: 43532825859,
    fileCount: 364,
    ownerCount: 24,
    missing: ['heavy-2', 'gi-6', 'shadow-fields'],
  },
  {
    runId: 43193477552,
    fileCount: 113,
    ownerCount: 7,
    missing: ['shadow-fields'],
  },
  {
    runId: 42929802533,
    fileCount: 364,
    ownerCount: 28,
    missing: ['shadow-fields'],
  },
  {
    runId: 42817415758,
    fileCount: 272,
    ownerCount: 26,
    missing: ['compact-2', 'gi-4', 'gi-1'],
  },
  {
    runId: 42835598738,
    fileCount: 364,
    ownerCount: 26,
    missing: ['heavy-4', 'specular-aa', 'gi-6'],
  },
  {
    runId: 42786967820,
    fileCount: 364,
    ownerCount: 21,
    missing: [
      'feature-depth',
      'gi-6',
      'heavy-3',
      'heavy-4',
      'specular-aa',
      'timing-lifecycle',
      'transmission',
      'vfx-depth',
    ],
  },
  {
    runId: 42778322662,
    fileCount: 364,
    ownerCount: 26,
    missing: ['compact-2', 'gi-1', 'gi-4'],
  },
  {
    runId: 42443025201,
    fileCount: 364,
    ownerCount: 24,
    missing: ['heavy-1', 'heavy-2', 'shadow-fields', 'gi-2', 'screen-probe'],
  },
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
  test(`run ${receipt.runId} retains immutable complete-source timing evidence`, (t) => {
    const timings = readDawnTimings();
    const snapshot = JSON.parse(
      readFileSync(
        new URL(`./fixtures/dawn-completed-${receipt.runId}.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.equal(snapshot.runId, receipt.runId);
    assert.equal(Object.keys(snapshot.files).length, receipt.fileCount ?? 354);
    assert.equal(Object.keys(snapshot.owners).length, receipt.ownerCount);
    if (snapshot.ordinaryReceipts) {
      const measuredFileWork = Object.values(snapshot.files).reduce(
        (sum, seconds) => sum + seconds,
        0,
      );
      const workerCount = snapshot.executionPolicy?.ordinaryWorkers ?? 1;
      const completeProcessWork =
        workerCount *
        snapshot.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
      assert.ok(
        Math.abs(measuredFileWork - completeProcessWork) < 0.001,
        'ordinary file receipts conserve complete work across each admitted worker',
      );
    }

    const currentFiles = new Set([
      ...nativeSpecifications.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')),
      ...DAWN_GATE_GROUPS.flatMap((group) => group.files),
    ]);
    for (const file of Object.keys(snapshot.files))
      if (existsSync(resolve(root, file))) assert.ok(currentFiles.has(file), file);

    assert.ok(
      [timings.latestRun, timings.previousRun, ...timings.replayRuns].some(
        (run) => run.runId === receipt.runId,
      ),
      'every retained regression scenario must participate in placement',
    );
    for (const id of receipt.missing) assert.ok(!Object.hasOwn(snapshot.owners, id));
    if (!receipt.missing.includes('shadow-fields'))
      assert.ok(Object.hasOwn(snapshot.owners, 'shadow-fields'));
    t.diagnostic(
      JSON.stringify({
        runId: receipt.runId,
        originalOrdinaryFiles: Object.keys(snapshot.files).length,
        evidence: 'historical-only',
      }),
    );
  });
}

for (const receipt of [
  { runId: 42817415758, fileCount: 272 },
  { runId: 42443025201, fileCount: 364 },
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
    const timings = readDawnTimings();
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
  const timings = readDawnTimings();
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

test('run 44023395616 retains complete core receipts and interrupted GI forecasts', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-44023395616.json', import.meta.url), 'utf8'),
  );
  const timings = readDawnTimings();
  assert.deepEqual(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      (row) => row.runId === receipt.runId,
    ),
    receipt,
  );
  assert.equal(receipt.head, 'f63f46041014cf4b00dcf5b206d823a77172b2ad');
  assert.equal(receipt.complete, false);
  assert.equal(receipt.executionPolicy.profile, 'pull-request-core-lightweight');
  assert.equal(Object.keys(receipt.files).length, 371);
  assert.equal(Object.keys(receipt.owners).length, 24);
  assert.deepEqual(
    receipt.ordinaryReceipts.map(({ fileCount }) => fileCount),
    [89, 91, 93, 98],
  );
  const work = Object.values(receipt.files).reduce((sum, seconds) => sum + seconds, 0);
  const wall = receipt.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(work - 2 * wall) < 0.001, 'retain both complete ordinary worker slots');
  for (const [owner, seconds] of Object.entries(receipt.owners)) {
    const processes = receipt.ownerReceipts[owner].processes;
    assert.ok(processes.every(({ status }) => status === 0));
    assert.ok(
      Math.abs(processes.reduce((sum, row) => sum + row.elapsedMs / 1000, 0) - seconds) < 0.001,
    );
    assert.ok(timings.owners[owner] >= seconds);
  }
  for (const [file, seconds] of Object.entries(receipt.files))
    assert.ok(timings.files[file] >= seconds, `retain the complete file cost: ${file}`);
  for (const owner of [...receipt.interruptedOwners, ...receipt.unstartedOwners]) {
    assert.ok(!Object.hasOwn(receipt.owners, owner));
    assert.ok(receipt.reservedOwners[owner] > 0);
    assert.ok(timings.owners[owner] >= receipt.reservedOwners[owner]);
  }
});

test('later native measurements preserve older uncompleted-owner reservations', () => {
  const timings = readDawnTimings();
  for (const snapshot of [timings.latestRun, timings.previousRun, ...timings.replayRuns]) {
    if (snapshot.reservedOwners === undefined) continue;
    const fixture = JSON.parse(
      readFileSync(
        new URL(`./fixtures/dawn-completed-${snapshot.runId}.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.deepEqual(snapshot.reservedOwners, fixture.reservedOwners);
    if (snapshot.ownerForecastSourceHead !== undefined) {
      assert.equal(snapshot.ownerForecastSourceHead, '3d396763e7ee1102f329ba686138371a7ca04167');
      assert.equal(snapshot.ownerForecastSourceHead, fixture.ownerForecastSourceHead);
    } else {
      assert.equal(snapshot.forecastSourceRunId, fixture.forecastSourceRunId);
      assert.ok(timings.runs.includes(snapshot.forecastSourceRunId));
      assert.ok(snapshot.forecastSourceRunId < snapshot.runId);
    }
    for (const [owner, seconds] of Object.entries(snapshot.reservedOwners)) {
      assert.ok(!Object.hasOwn(snapshot.owners, owner));
      assert.ok(seconds > 0 && seconds <= timings.owners[owner]);
    }
  }
});

test('run 44136739089 freezes complete children and excludes interrupted VFX partitions', () => {
  const bytes = readFileSync(new URL('../dawn-timing-snapshots/44136739089.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'a9231578ec85e13978fd7041521ea30e6cbcb347e83bd885321a0c5afb4e5675',
  );
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.head, '705b99991c12a90481d073c5a36bb3ca9ba364d0');
  assert.equal(receipt.complete, false);
  assert.equal(receipt.ordinaryReceipts.length, 4);
  assert.equal(Object.keys(receipt.files).length, 371);
  assert.equal(Object.keys(receipt.owners).length, 22);
  assert.equal(receipt.owners['vfx-depth'], undefined);
  assert.deepEqual(receipt.interruptedOwners, ['vfx-depth']);
  const wall = receipt.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  const work = Object.values(receipt.files).reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(Math.abs(work - 2 * wall) < 0.001);
  assert.ok(receipt.incompleteOwnerForecasts['vfx-depth'].seconds > 500);
});

test('core forecasts derive only from complete children in the matching execution profile', () => {
  const timings = readDawnTimings();
  const expected = { files: {}, owners: {} };
  for (const run of timings.coreProfile.sourceRuns) {
    const snapshot = JSON.parse(
      readFileSync(new URL(`../dawn-timing-snapshots/${run}.json`, import.meta.url), 'utf8'),
    );
    assert.deepEqual(snapshot.executionPolicy, timings.coreProfile.executionPolicy);
    for (const key of ['files', 'owners']) {
      for (const [name, seconds] of Object.entries(snapshot[key])) {
        expected[key][name] = Math.max(expected[key][name] ?? 0, seconds);
        assert.ok(timings[key][name] >= seconds, `retain the historical maximum: ${name}`);
      }
    }
  }
  assert.equal(timings.coreProfile.executionPolicy.profile, 'pull-request-core-lightweight');
  assert.deepEqual(timings.coreProfile.files, expected.files);
  assert.deepEqual(timings.coreProfile.owners, expected.owners);
  const core = { FORGEAX_CI_CORE_VALIDATION: '1', FORGEAX_DAWN_LIGHTWEIGHT: '1' };
  const full = { FORGEAX_CI_CORE_VALIDATION: '0' };
  const coreOwners = dawnPlanningOwnerCosts(core);
  const fullOwners = dawnPlanningOwnerCosts(full);
  assert.equal(coreOwners.get('vfx-depth'), expected.owners['vfx-depth']);
  assert.equal(fullOwners.get('vfx-depth'), timings.owners['vfx-depth']);
  assert.equal(
    dawnPlanningOwnerCosts({ FORGEAX_CI_CORE_VALIDATION: '1' }).get('vfx-depth'),
    fullOwners.get('vfx-depth'),
    'a core roster alone cannot admit lightweight measurements',
  );
  assert.equal(
    coreOwners.get('gi-3'),
    expected.owners['gi-3'],
    'a later complete child supplies core timing',
  );
  assert.ok(coreOwners.get('vfx-depth') < fullOwners.get('vfx-depth'));
  const familyMembers = new Set(
    DAWN_ORDINARY_FILE_FAMILIES.flatMap(({ anchor, children }) => [anchor, ...children]),
  );
  const coreFiles = dawnPlanningFileCosts(core);
  const fullFiles = dawnPlanningFileCosts(full);
  for (const [file, seconds] of Object.entries(expected.files)) {
    if (familyMembers.has(file)) continue;
    assert.equal(coreFiles.get(file), seconds);
    assert.ok(fullFiles.get(file) >= seconds);
  }
});

test('run 44039100905 retains failed lanes without admitting interrupted owners', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-44039100905.json', import.meta.url), 'utf8'),
  );
  const timings = readDawnTimings();
  assert.deepEqual(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      ({ runId }) => runId === receipt.runId,
    ),
    receipt,
  );
  assert.equal(receipt.head, '1a3f77b6d685325cd30e33f1fd83b08075849595');
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.interruptedOwners, ['gi-3', 'compact-3']);
  assert.equal(Object.keys(receipt.files).length, 371);
  assert.equal(Object.keys(receipt.owners).length, 20);
  assert.deepEqual(
    receipt.ordinaryReceipts.map(({ fileCount }) => fileCount),
    [85, 94, 93, 99],
  );
  const work = Object.values(receipt.files).reduce((sum, seconds) => sum + seconds, 0);
  const wall = receipt.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(work - 2 * wall) < 0.001);
  for (const owner of [...receipt.interruptedOwners, ...receipt.unstartedOwners]) {
    assert.ok(!Object.hasOwn(receipt.owners, owner));
    assert.ok(receipt.reservedOwners[owner] > 0);
  }
  for (const [owner, seconds] of Object.entries(receipt.owners)) {
    const processes = receipt.ownerReceipts[owner].processes;
    assert.ok(processes.every(({ status }) => status === 0));
    assert.ok(
      Math.abs(processes.reduce((sum, row) => sum + row.elapsedMs / 1000, 0) - seconds) < 0.001,
    );
  }
});

test('run 44113035424 conserves complete workers and excludes interrupted VFX timing', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-44113035424.json', import.meta.url), 'utf8'),
  );
  const timings = readDawnTimings();
  assert.deepEqual(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      ({ runId }) => runId === receipt.runId,
    ),
    receipt,
  );
  assert.equal(receipt.head, '52b5bcf1e35be1c248b6e2146170bdee1863746c');
  assert.equal(receipt.complete, false);
  assert.equal(Object.keys(receipt.files).length, 372);
  assert.equal(Object.keys(receipt.owners).length, 22);
  assert.deepEqual(receipt.interruptedOwners, ['vfx-depth']);
  assert.deepEqual(receipt.unstartedOwners, []);
  assert.ok(!Object.hasOwn(receipt.owners, 'vfx-depth'));
  assert.equal(receipt.reservedOwners['vfx-depth'], 187.419);
  assert.deepEqual(
    receipt.ordinaryReceipts.map(({ fileCount }) => fileCount),
    [87, 94, 96, 95],
  );
  const work = Object.values(receipt.files).reduce((sum, seconds) => sum + seconds, 0);
  const wall = receipt.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(work - 2 * wall) < 0.001);
  const filter = 'packages/render/src/__tests__/ssr-current-filter.dawn.test.ts';
  assert.equal(receipt.files[filter], 6.097842105263161);
  assert.ok(!Object.hasOwn(timings.fileReserves, filter));
  for (const [owner, seconds] of Object.entries(receipt.owners)) {
    const processes = receipt.ownerReceipts[owner].processes;
    assert.ok(processes.every(({ status }) => status === 0));
    assert.ok(
      Math.abs(processes.reduce((sum, row) => sum + row.elapsedMs / 1000, 0) - seconds) < 0.001,
    );
  }
});

test('actual core discovery uses matching costs and conserves every ordinary file', () => {
  // Provisional file forecasts include startup allowance.
  const unmeasured = [
    'packages/render/src/__tests__/raytracing/world-bounds-index.dawn.test.ts',
    'packages/render/src/__tests__/raytracing/world-card-bounds.dawn.test.ts',
    'packages/render/src/__tests__/target-environment.dawn.test.ts',
    'packages/render/src/__tests__/target-subresources.dawn.test.ts',
    'packages/runtime/src/__tests__/default-gbuffer-gi.dawn.test.ts',
    'packages/three/src/__tests__/procedural-addons-render.dawn.test.ts',
    'packages/three/src/__tests__/surface-expression.dawn.test.ts',
    'packages/three/src/__tests__/target-surface.dawn.test.ts',
  ];
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { relative } from 'node:path';
      import { readFileSync } from 'node:fs';
      import { createVitest } from 'vitest/node';
      import ledger from './scripts/ci/dawn-file-seconds.json' with { type: 'json' };
      import { DawnSequencer, planDawnShards } from './config/vitest-dawn-sequencer.ts';
      import { DAWN_GATE_SHARDS, DAWN_GATE_GROUPS, DAWN_ORDINARY_EXCLUSIVE_FILES, dawnNativeLaneReserve } from './scripts/ci/dawn-gate-roster.mjs';
      import { coreValidationFiles } from './scripts/ci/core-validation.mjs';
      import { dawnFileOwnerCosts, dawnPlanningFileCosts, dawnPlanningOwnerCosts } from './config/dawn-timings.ts';
      const v = await createVitest('test', { project: ['dawn'], watch: false });
      try {
        const files = await v.globTestSpecifications();
        const paths = files.map(({ moduleId }) => relative(process.cwd(), moduleId).replaceAll('\\\\', '/'));
        const unmeasured = ${JSON.stringify(unmeasured)};
        assert.ok(unmeasured.every((path) => !Object.hasOwn(ledger.coreProfile.files, path)));
        assert.deepEqual(Object.keys(ledger.fileReserves).sort(), unmeasured);
        // Historical receipts retain their original population. Current discovery
        // also admits new files, charged at the sequencer's conservative fallback.
        const measured = Object.keys(ledger.coreProfile.files);
        const native = new Set(DAWN_GATE_GROUPS.flatMap(({ files }) => files));
        const retired = new Set([
          'packages/render/src/__tests__/ssr-hit-color.dawn.test.ts',
          'packages/render/src/__tests__/ssr-texel-crossing.dawn.test.ts',
          'packages/render/src/__tests__/ssr-trace-pyramid-rescue.dawn.test.ts',
          'packages/shader/src/__tests__/ssao-cluster-pack.dawn.test.ts',
        ]);
        for (const file of retired) {
          assert.ok(measured.includes(file));
          assert.ok(!paths.includes(file));
        }
        const declared = coreValidationFiles([...measured, ...Object.keys(ledger.fileReserves)])
          .filter((path) => !retired.has(path))
          .filter((path) => !native.has(path));
        assert.deepEqual(declared.filter((path) => !paths.includes(path)), []);
        for (const file of [
          'packages/render/src/__tests__/depth-pyramid-odd-reduction.dawn.test.ts',
          'packages/render/src/__tests__/ssr-roughness-mip.dawn.test.ts',
          'packages/shader/src/__tests__/ssr-ray.dawn.test.ts',
        ]) {
          assert.ok(paths.includes(file), file);
        }
        const added = paths.filter((path) => !declared.includes(path));
        const quick = files.find(({ moduleId }) => moduleId.endsWith('/integer-readback.dawn.test.ts'));
        const lighting = files.find(({ moduleId }) => moduleId.endsWith('/lighting-channels.dawn.test.ts'));
        assert.ok(quick && lighting);
        const context = { config: { ...v.config, shard: { index: 2, count: 4 } }, cache: v.cache };
        assert.deepEqual(await new DawnSequencer(context).sort([quick, lighting]), [lighting, quick]);
        const lanes = planDawnShards(files, process.cwd(), 2);
        assert.equal(lanes.length, 4);
        const serialFiles = files.map(({ moduleId, project }) => ({
          moduleId,
          project: { name: project.name, config: { maxWorkers: 1 } },
        }));
        process.env.FORGEAX_DAWN_SERIAL_ORDINARY = '2';
        const gbuffer = 'packages/runtime/src/__tests__/default-gbuffer-gi.dawn.test.ts';
        assert.ok(native.has(gbuffer));
        assert.ok(!paths.includes(gbuffer));
        try {
          const serialContext = { ...context, config: { ...context.config, shard: { index: 4, count: 4 } } };
          const serialLane = await new DawnSequencer(serialContext).shard(serialFiles);
          assert.deepEqual(serialLane.map(({ moduleId }) => moduleId), lanes[3].map(({ moduleId }) => moduleId));
          process.env.FORGEAX_DAWN_ORDINARY_MEMORY_PHASE = 'exclusive';
          const exclusive = await new DawnSequencer(serialContext).shard(serialFiles);
          delete process.env.FORGEAX_DAWN_SERIAL_ORDINARY;
          process.env.FORGEAX_DAWN_ORDINARY_MEMORY_PHASE = 'bounded';
          const bounded = await new DawnSequencer(serialContext).shard(files);
          const pathOf = ({ moduleId }) => relative(process.cwd(), moduleId).replaceAll('\\\\', '/');
          const selected = serialLane.map(pathOf);
          assert.deepEqual(exclusive.map(pathOf), selected.filter(path => DAWN_ORDINARY_EXCLUSIVE_FILES.has(path)));
          assert.deepEqual(bounded.map(pathOf), selected.filter(path => !DAWN_ORDINARY_EXCLUSIVE_FILES.has(path)));
          assert.ok(exclusive.length > 0 && bounded.length > exclusive.length);
        } finally {
          delete process.env.FORGEAX_DAWN_SERIAL_ORDINARY;
          delete process.env.FORGEAX_DAWN_ORDINARY_MEMORY_PHASE;
        }
        assert.equal(new Set(lanes.flat().map(({ moduleId }) => moduleId)).size, files.length);
        assert.deepEqual(lanes.flat().map(({ moduleId }) =>
          relative(process.cwd(), moduleId).replaceAll('\\\\', '/')).sort(), paths.sort());
        const costs = dawnPlanningFileCosts();
        const fallback = Math.max(...costs.values());
        const owners = dawnPlanningOwnerCosts();
        assert.equal(owners.get('vfx-depth'), ledger.coreProfile.owners['vfx-depth']);
        const children = new Set([
          'packages/three/src/__tests__/node-optical-inputs.dawn.test.ts',
          'packages/three/src/__tests__/node-primitive-inputs.dawn.test.ts',
        ]);
        const nativeReserves = new Map(DAWN_GATE_GROUPS.filter(({ files }) => files.length > 0)
          .map(group => {
            const selected = coreValidationFiles(group.files);
            const history = owners.get(group.id) ??
              selected.reduce((seconds, path) => seconds + (costs.get(path) ?? fallback), 0);
            return [group.id, selected.length === 0 ? 0 :
              Math.max(history, group.placementReserveSeconds ?? 0)];
          }));
        const loads = lanes.map((lane, index) =>
          lane.reduce((sum, { moduleId }) => {
            const path = relative(process.cwd(), moduleId).replaceAll('\\\\', '/');
            return sum + (children.has(path) ? 0 : (costs.get(path) ?? fallback) / 2);
          }, 0) + dawnNativeLaneReserve(DAWN_GATE_GROUPS.filter(group => DAWN_GATE_SHARDS[index].includes(group.id)),
            nativeReserves, 2));
        assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...costs.values()) / 2 + 1e-6, 'complete core loads: ' + loads + ', allowed spread: ' + (Math.max(...costs.values()) / 2));
        // Replay the retained measured population; new files still use forecasts.
        const historical = files.filter(({ moduleId }) =>
          Object.hasOwn(ledger.coreProfile.files, relative(process.cwd(), moduleId).replaceAll('\\\\', '/')));
        const historicalLanes = planDawnShards(historical, process.cwd(), 2);
        assert.equal(historical.length, files.length - paths.filter((path) => !measured.includes(path)).length);
        const replays = [];
        for (const run of ledger.coreProfile.sourceRuns) {
          const receipt = JSON.parse(readFileSync('scripts/ci/dawn-timing-snapshots/' + run + '.json', 'utf8'));
          const fileCosts = dawnFileOwnerCosts(receipt.files);
          const tails = { ...receipt.owners, ...receipt.reservedOwners };
          for (const [owner, forecast] of Object.entries(receipt.incompleteOwnerForecasts ?? {}))
            tails[owner] = forecast.seconds;
          const observed = historicalLanes.map((lane, index) =>
            lane.reduce((sum, { moduleId }) => {
              const path = relative(process.cwd(), moduleId).replaceAll('\\\\', '/');
              return sum + (children.has(path) ? 0 : (fileCosts.get(path) ?? 0) / 2);
            }, 0) + DAWN_GATE_SHARDS[index].reduce((sum, id) => {
            const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
            // Archived owner timings remain immutable. Charge a partial owner
            // its whole historical tail, and drop owners absent from current core.
            const selected = coreValidationFiles(group.files);
            if (group.files.length > 0 && selected.length === 0) return sum;
            // Count retained files that moved out of ordinary discovery exactly once.
            return sum + (tails[id] ?? 0) + selected.reduce(
              (seconds, path) => seconds + (fileCosts.get(path) ?? 0), 0);
          }, 0));
          // Two minutes of the 30-minute target remain for preparation. Older
          // infeasible targets retain the original 40-minute execution bound.
          const bound = observed.reduce((sum, seconds) => sum + seconds, 0) / 4 <= 1680 ? 1680 : 2400;
          assert.ok(Math.max(...observed) <= bound, 'complete cohort ' + run + ' exceeds ' + bound + ': ' + observed);
          replays.push({ run, bound, loads: observed });
        }
        console.log(JSON.stringify({ files: files.length, measuredFiles: measured.length, declaredFiles: declared.length, unmeasured, added, loads, replays }));
      } finally { await v.close(); }
    `,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_CI_CORE_VALIDATION: '1', FORGEAX_DAWN_LIGHTWEIGHT: '1' },
    },
  );
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(result.unmeasured, unmeasured);
  assert.equal(result.measuredFiles, 372);
  assert.equal(result.files, result.declaredFiles + result.added.length);
});

test('planar capture and low-limit transmission share serial Surface admission', () => {
  const owner = DAWN_GATE_GROUPS.find((group) => group.id === 'surface-pipelines');
  for (const file of [
    'packages/runtime/src/__tests__/planar-reflection.dawn.test.ts',
    'packages/runtime/src/__tests__/standard-planar-reflection.dawn.test.ts',
    'packages/runtime/src/__tests__/cooked-transmission-low-limit.dawn.test.ts',
    'packages/render/src/__tests__/standard-lean-inputs.dawn.test.ts',
  ]) {
    assert.ok(owner.files.includes(file), file);
    assert.equal(DAWN_GATE_GROUPS.filter((group) => group.files.includes(file)).length, 1);
    assert.ok(!nativeSpecifications.some((specification) => specification.moduleId.endsWith(file)));
  }
  const args = dawnVitestArgs(owner, { ordinaryWorkers: 2 });
  assert.ok(args.includes('--maxWorkers=1'));
  assert.ok(args.includes('--no-file-parallelism'));
  assert.equal(DAWN_GATE_SHARDS.length, 4);
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const evidence = workflow.jobs['vitest-dawn'].steps.find((step) =>
    step.with?.name?.startsWith('lighting-channels-dawn-'),
  );
  assert.ok(evidence.with.path.includes('artifacts/planar-reflection/dawn/'));
  assert.ok(evidence.if.includes('artifacts/planar-reflection/dawn/**'));
});

test('long native capture journeys start before ordinary backfill', () => {
  const minimumReserveSeconds = new Map([
    ['direct-light', 219.011],
    ['gi-2', 534.117],
    ['path-tracer', 355.022],
    ['transmission', 294.878],
  ]);
  for (const id of [
    'modeling-s6',
    'modeling-show',
    'gi-5',
    'gi-2',
    'surface-pipelines',
    'direct-light',
    'path-tracer',
    'transmission',
  ]) {
    const lane = DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id));
    const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
    assert.ok(
      group.placementReserveSeconds >= (minimumReserveSeconds.get(id) ?? 600),
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
  const coldLanes = ['surface-pipelines', 'three-surface-expression', 'gi-4'].map((id) =>
    DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id)),
  );
  assert.equal(new Set(coldLanes).size, coldLanes.length);
});

test('run 43718751716 preserves interrupted-owner forecasts', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-43718751716.json', import.meta.url), 'utf8'),
  );
  assert.equal(snapshot.owners.transmission, undefined, 'an interrupted owner is not measured');
  assert.equal(snapshot.reservedOwners.transmission, 294.878, 'retain its prior complete forecast');
});

test('native tails retain independent measured headroom across complete cohorts', () => {
  const laneOf = (id) => DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id));
  assert.equal(new Set(['modeling-s6', 'modeling-show', 'gi-5'].map(laneOf)).size, 3);
  assert.notEqual(laneOf('gi-4'), laneOf('gi-5'));
  assert.notEqual(laneOf('feature-depth'), laneOf('vfx-depth'));
  const depth = DAWN_GATE_GROUPS.find(({ id }) => id === 'vfx-depth');
  const timings = readDawnTimings();
  const forecast = [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
    ({ runId }) => runId === 44136739089,
  );
  const recordedReserve = forecast.incompleteOwnerForecasts['vfx-depth'].seconds;
  assert.equal(
    recordedReserve,
    500.73499999999996,
    'retain the original incomplete-owner forecast',
  );
  assert.ok(
    depth.placementReserveSeconds >= recordedReserve,
    'independent admission headroom must cover the recorded forecast',
  );
  const selected = selectDawnShard(`${laneOf('vfx-depth') + 1}/4`);
  assert.ok(
    selected.findIndex(({ id }) => id === 'vfx-depth') <
      selected.findIndex(({ id }) => id.startsWith('ordinary-')),
  );
});

test('completed cohorts distribute complete native tails before ordinary backfill', () => {
  assert.deepEqual(DAWN_GATE_SHARDS, [
    [
      'ordinary-1',
      'compact-1',
      'direct-light',
      'shadow-quality',
      'nested-discard',
      'heavy-3',
      'modeling-s6',
      'path-tracer',
      'surface-pipelines',
      'heavy-2',
      'screen-probe-support',
    ],
    [
      'ordinary-2',
      'compact-2',
      'gi-2',
      'alpha-hash',
      'feature-depth',
      'renderer',
      'rect-source',
      'three-surface-expression',
      'shadow-fields',
      'world-card-bounds',
      'gi-6',
    ],
    [
      'ordinary-3',
      'gi-3',
      'compact-3',
      'gi-4',
      'heavy-1',
      'modeling-show',
      's6c-capture',
      'screen-probe',
    ],
    [
      'ordinary-4',
      'gi-5',
      'heavy-4',
      'gi-1',
      'transmission',
      'vfx-depth',
      'default-gbuffer-gi',
      'specular-aa',
    ],
  ]);
});

test('Heavy standalone Dawn files each reserve a fresh serial fork', () => {
  for (const [id, file, forecast] of [
    ['s6c-capture', 'packages/modeling/examples/mech-gt/__tests__/s6c.case.dawn.test.ts', 930],
    ['alpha-hash', 'packages/runtime/src/__tests__/alpha-hash.dawn.test.ts', 186.15],
    ['default-gbuffer-gi', 'packages/runtime/src/__tests__/default-gbuffer-gi.dawn.test.ts', 750],
    [
      'screen-probe-support',
      'packages/render/src/__tests__/raytracing/screen-probe-support.dawn.test.ts',
      240,
    ],
    [
      'three-surface-expression',
      'packages/three/src/__tests__/surface-expression.dawn.test.ts',
      420,
    ],
  ]) {
    const owner = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
    assert.equal(owner.nativeProcessSlots, 2);
    assert.ok(owner.placementReserveSeconds >= forecast);
    assert.deepEqual(owner.files, [file]);
    assert.ok(!nativeSpecifications.some(({ moduleId }) => moduleId.endsWith(file)));
    assert.ok(dawnVitestArgs(owner, { ordinaryWorkers: 2 }).includes('--maxWorkers=1'));
  }
});

test('measured heavy ordinary files spread across the existing lanes', (t) => {
  const currentPartitions = shippingPartitions;
  const locations = new Map(
    currentPartitions.flatMap((partition, lane) =>
      partition.map(({ moduleId }) => [relative(root, moduleId).replaceAll('\\', '/'), lane + 1]),
    ),
  );
  // The remaining heavy ordinary consumers retain separate capacity.
  const heavy = [
    'packages/modeling/examples/body-panels/__tests__/panels.case.dawn.test.ts',
    'packages/devkit/src/tools/__tests__/model-views.dawn.test.ts',
  ];
  for (const file of heavy) assert.ok(locations.has(file), file);
  assert.ok(new Set(heavy.map((file) => locations.get(file))).size >= 2);
  assert.equal(locations.size, currentPartitions.flat().length);
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

test('run 43851698763 retains complete work and exposes its infeasible forecast', (t) => {
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-43851698763.json', import.meta.url), 'utf8'),
  );
  const timings = readDawnTimings();
  assert.deepEqual(
    [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
      (row) => row.runId === snapshot.runId,
    ),
    snapshot,
  );
  assert.equal(snapshot.complete, false);
  assert.equal(Object.keys(snapshot.files).length, 403);
  assert.equal(Object.keys(snapshot.owners).length, 19);
  assert.equal(snapshot.executionPolicy.ordinaryWorkers, 2);
  assert.equal(snapshot.ordinaryReceipts.length, 4);
  const work = Object.values(snapshot.files).reduce((sum, seconds) => sum + seconds, 0);
  const elapsed = snapshot.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(work - 2 * elapsed) < 0.001, 'both complete worker slots remain charged');
  for (const id of [...snapshot.interruptedOwners, ...snapshot.unstartedOwners]) {
    assert.ok(!Object.hasOwn(snapshot.owners, id), `${id} did not complete`);
    assert.ok(snapshot.reservedOwners[id] > 0, `${id} retains its full forecast`);
  }
  for (const id of ['feature-depth', 'vfx-depth']) {
    assert.ok(!Object.hasOwn(snapshot.owners, id), `${id} ran only its PR subset`);
    assert.ok(snapshot.reservedOwners[id] > snapshot.partialOwnerReceipts[id].processWallSeconds);
  }
  const largest = Math.max(...Object.values(snapshot.files));
  const native = Object.values({ ...snapshot.reservedOwners, ...snapshot.owners }).reduce(
    (sum, seconds) => sum + seconds,
    0,
  );
  const total = work / 2 + 4 * (largest / 2 + 60) + native;
  assert.ok(
    total > 4 * 2194,
    'infeasible measured/reserved work must never be relabeled as fitting',
  );
  t.diagnostic(
    JSON.stringify({
      runId: snapshot.runId,
      qualification: 'historical-infeasible-forecast',
      total,
    }),
  );
});

test('run 43819262879 retains all completed work and positive unfinished-owner forecasts', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/dawn-completed-43819262879.json', import.meta.url), 'utf8'),
  );
  const timings = readDawnTimings();
  const retained = [timings.latestRun, timings.previousRun, ...timings.replayRuns].find(
    (row) => row.runId === snapshot.runId,
  );
  assert.ok(retained);
  assert.deepEqual(retained.files, snapshot.files);
  assert.deepEqual(retained.owners, snapshot.owners);
  assert.deepEqual(snapshot.interruptedOwners, ['heavy-1']);
  assert.deepEqual(snapshot.unstartedOwners, ['heavy-2', 'shadow-fields', 'gi-1']);
  assert.deepEqual(snapshot.reservedOwners, {
    'heavy-1': 77.11,
    'heavy-2': 52.202,
    'shadow-fields': 207.672,
    'gi-1': 241.472,
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.ordinaryReceipts.length, 4);
  assert.equal(
    snapshot.ordinaryReceipts.reduce((n, row) => n + row.fileCount, 0),
    401,
  );
  assert.equal(Object.keys(snapshot.owners).length, 23);
  for (const id of ['heavy-1', 'heavy-2', 'shadow-fields', 'gi-1']) {
    assert.equal(Object.hasOwn(snapshot.owners, id), false);
    assert.ok(snapshot.reservedOwners[id] > 0);
    assert.ok(snapshot.reservedOwners[id] <= timings.owners[id]);
  }
  assert.equal(snapshot.owners['direct-light'], (106221 + 179992 + 166090 + 98729) / 1000);
  assert.equal(snapshot.owners['surface-pipelines'], 421.326);
});

function nodeInputMatrix(node) {
  if (node === undefined) return null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
    return nodeInputMatrix(node.expression);
  if (ts.isIdentifier(node)) return node.text;
  assert.ok(ts.isArrayLiteralExpression(node));
  return node.elements.map((element) => {
    if (ts.isStringLiteral(element)) return element.text;
    assert.ok(
      element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword,
    );
    return element.kind === ts.SyntaxKind.TrueKeyword;
  });
}

// Preserve the case inputs and oracle delegation, independent of Renderer allocation.
function nodeInputContracts(file, core = false) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const profiles = new Map();
  for (const statement of source.statements.filter(ts.isVariableStatement)) {
    for (const declaration of statement.declarationList.declarations) {
      const choice = declaration.initializer;
      if (!choice || !ts.isConditionalExpression(choice)) continue;
      assert.equal(choice.condition.getText(source), 'core');
      profiles.set(
        declaration.name.getText(source),
        nodeInputMatrix(core ? choice.whenTrue : choice.whenFalse),
      );
    }
  }
  return source.statements.filter(ts.isExpressionStatement).map(({ expression: call }) => {
    assert.ok(ts.isCallExpression(call));
    const [title, options, callback] = call.arguments;
    assert.ok(ts.isStringLiteral(title));
    assert.ok(ts.isObjectLiteralExpression(options));
    assert.equal(options.properties.length, 1);
    const timeout = options.properties[0];
    assert.ok(ts.isPropertyAssignment(timeout));
    assert.equal(timeout.name.getText(source), 'timeout');
    assert.equal(timeout.initializer.getText(source), '120000');
    assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
    assert.equal(callback.body.statements.length, 2);
    const [creation, assertion] = callback.body.statements;
    assert.ok(ts.isVariableStatement(creation));
    assert.equal(creation.declarationList.declarations.length, 1);
    const renderer = creation.declarationList.declarations[0];
    assert.equal(renderer.name.getText(source), 'renderer');
    assert.ok(ts.isAwaitExpression(renderer.initializer));
    const factory = renderer.initializer.expression;
    assert.ok(ts.isCallExpression(factory));
    assert.equal(factory.arguments.length, 0);
    assert.ok(ts.isExpressionStatement(assertion) && ts.isAwaitExpression(assertion.expression));
    const verify = assertion.expression.expression;
    assert.ok(ts.isCallExpression(verify));
    const cleanup = verify.arguments.at(-1);
    assert.ok(ts.isArrowFunction(cleanup) && ts.isBlock(cleanup.body));
    assert.equal(cleanup.parameters.length, 0);
    assert.equal(cleanup.body.statements.length, 0);
    const each = ts.isCallExpression(call.expression) ? call.expression : undefined;
    assert.equal(
      each?.expression.getText(source) ?? call.expression.getText(source),
      each ? 'it.each' : 'it',
    );
    const matrix = nodeInputMatrix(each?.arguments[0]);
    return [
      profiles.get(matrix) ?? matrix,
      title.text,
      callback.parameters.map((parameter) => parameter.name.getText(source)),
      factory.expression.getText(source),
      verify.expression.getText(source),
      verify.arguments.slice(0, -1).map((argument) => argument.getText(source)),
    ];
  });
}

test('split node-input files retain the full and Core contracts and one measured physical owner', () => {
  const receipt = JSON.parse(
    readFileSync('scripts/ci/__tests__/fixtures/dawn-node-inputs-43823116760.json', 'utf8'),
  );
  const family = DAWN_ORDINARY_FILE_FAMILIES[0];
  assert.equal(family.anchor, receipt.uncompletedFile);
  const members = [family.anchor, ...family.children];
  assert.match(
    readFileSync(family.anchor, 'utf8'),
    /const core = process\.env\.FORGEAX_CI_CORE_VALIDATION === '1'/,
  );
  const contracts = members.flatMap((file) => nodeInputContracts(file));
  assert.deepEqual(contracts, [
    [
      ['uniform', 'vec4', 'texture'],
      'renders and replays live %s node inputs on Dawn',
      ['mode'],
      'preparedRenderer',
      'verifyNodeInputs',
      ['renderer', 'mode'],
    ],
    [
      null,
      'retains node input precedence through async override rendering on Dawn',
      [],
      'getRenderer',
      'verifyNodeOverride',
      ['renderer'],
    ],
    [
      'nodeInputPrimitives',
      'renders and replays %s node uniforms on Dawn',
      ['kind'],
      'getRenderer',
      'verifyNodeInputPrimitive',
      ['renderer', 'kind'],
    ],
    [
      [false, true],
      'renders and replays lit uniforms and loaded=%s scenes on Dawn',
      ['loaded'],
      'getRenderer',
      'verifyLitNodeInputs',
      ['renderer', 'loaded'],
    ],
    [
      'opticalModes',
      'renders and replays %s optical node uniforms on Dawn',
      ['mode'],
      'getRenderer',
      'verifyOpticalNodeInputs',
      ['renderer', 'mode'],
    ],
    [
      'primitiveInputModes',
      'renders and replays %s primitive node inputs on Dawn',
      ['mode'],
      'getRenderer',
      'verifyPrimitiveNodeInputs',
      ['renderer', 'mode'],
    ],
  ]);
  const coreContracts = members.flatMap((file) => nodeInputContracts(file, true));
  const coreMatrices = new Map([
    ['verifyNodeInputs', ['uniform', 'texture']],
    ['verifyNodeInputPrimitive', ['dashed', 'sprite']],
  ]);
  assert.deepEqual(
    coreContracts,
    contracts.map(([matrix, title, params, factory, verify, args]) => [
      coreMatrices.get(verify) ?? matrix,
      title,
      params,
      factory,
      verify,
      args,
    ]),
  );
  // The historical whole-body hashes remain untouched in their original receipt.
  // These unchanged helpers own all original frames, pixels and fresh-device replays.
  for (const [file, digest] of [
    ['node-inputs.fixture.ts', '66fddfee7a752255f1839f2226a12905c45d6a9f8cc8726fb9b98907019c62ae'],
    [
      'lit-node-inputs.fixture.ts',
      '1e29a0f94086f04f20d82285fab20d135fc8ba57d68562479001f8487f9284a0',
    ],
    [
      'optical-node-inputs.fixture.ts',
      'cec10a3dcce1459d157c04c6a40cfa24cfad7eaacc4f5a934fbf11f86e55a7ce',
    ],
    [
      'primitive-node-inputs.fixture.ts',
      'c98f9f54be10a40ee951a8526084de51c65b6f4045a11bd62325ce8f25485399',
    ],
  ]) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(`packages/three/src/__tests__/${file}`))
        .digest('hex'),
      digest,
    );
  }
  assert.equal(contracts.length, receipt.originalTestGroupSha256.length);
  assert.equal(
    receipt.originalTestsPerGroup.reduce((sum, count) => sum + count, 0),
    18,
  );
  const lanes = members.map((path) =>
    shippingPartitions.findIndex((lane) =>
      lane.some(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/') === path),
    ),
  );
  assert.ok(lanes.every((lane) => lane >= 0));
  assert.equal(new Set(lanes).size, 1);
  assert.equal(receipt.oomKillCounterAfter - receipt.oomKillCounterBefore, 1);
});

test('new split-file observations remain fully charged while old receipts retain their whole cost', () => {
  const { anchor, children } = DAWN_ORDINARY_FILE_FAMILIES[0];
  const old = { [anchor]: 334 };
  assert.equal(dawnFileOwnerCosts(old).get(anchor), 334);
  const current = { [anchor]: 200, [children[0]]: 100, [children[1]]: 80 };
  assert.deepEqual([...dawnFileOwnerCosts(current)], [[anchor, 380]]);
  assert.deepEqual(Object.values(current), [200, 100, 80]);
});

test('708d retains all completed Dawn children and forecasts unfinished full owners', () => {
  const bytes = readFileSync(new URL('../dawn-timing-snapshots/44152394166.json', import.meta.url));
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(JSON.parse(bytes)))
      .digest('hex'),
    '1908ebd441e32512bc591c1b7dbdb5ccfea06e9e4ea282ab81696d72c3751775',
  );
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.head, '708d4ff1c4515d5e0cc7af683759c477b2c62e40');
  assert.equal(receipt.ordinaryReceipts.length, 4);
  assert.equal(Object.keys(receipt.files).length, 371);
  assert.equal(Object.keys(receipt.owners).length, 24);
  assert.deepEqual(receipt.interruptedOwners, ['gi-1']);
  assert.deepEqual(receipt.unstartedOwners, ['screen-probe']);
  for (const owner of ['gi-1', 'screen-probe']) {
    assert.equal(receipt.owners[owner], undefined);
    assert.equal(
      receipt.reservedOwners[owner],
      DAWN_GATE_GROUPS.find((group) => group.id === owner).placementReserveSeconds,
    );
  }
  const work = Object.values(receipt.files).reduce((sum, seconds) => sum + seconds, 0);
  const wall = receipt.ordinaryReceipts.reduce((sum, row) => sum + row.processWallSeconds, 0);
  assert.ok(Math.abs(work - 2 * wall) < 0.001);
});
