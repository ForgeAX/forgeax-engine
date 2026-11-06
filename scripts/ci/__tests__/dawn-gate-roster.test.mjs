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
  assert.match(
    job,
    /- name: Vitest dawn project[^\n]*\n {8}timeout-minutes: 40\n/,
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

for (const receipt of [
  { runId: 41741792994, ownerCount: 27, missing: ['gi-1', 'gi-5'] },
  { runId: 41840653604, ownerCount: 28, missing: ['gi-5'] },
  { runId: 41891389810, ownerCount: 27, missing: ['gi-4', 'direct-light'] },
  { runId: 42076518011, ownerCount: 28, missing: ['direct-light'] },
  { runId: 42146194978, ownerCount: 28, missing: ['screen-probe'] },
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
    assert.equal(Object.keys(snapshot.files).length, 354);
    assert.equal(Object.keys(snapshot.owners).length, receipt.ownerCount);

    const ordinaryFiles = configuredPartitions.flatMap((partition) =>
      partition.map((specification) =>
        relative(root, specification.moduleId).replaceAll('\\', '/'),
      ),
    );
    assert.equal(new Set(ordinaryFiles).size, nativeSpecifications.length);
    assert.deepEqual([...ordinaryFiles].sort(), Object.keys(snapshot.files).sort());

    const fallback = Math.max(...Object.values(timings.files));
    const fileCost = (file) => snapshot.files[file] ?? timings.files[file] ?? fallback;
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
    for (const id of receipt.missing) assert.ok(!Object.hasOwn(snapshot.owners, id));
    assert.ok(Object.hasOwn(snapshot.owners, 'shadow-fields'));
    t.diagnostic(JSON.stringify({ runId: receipt.runId, laneSeconds }));
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
  assert.equal(timings.latestRun.runId, 42146194978);
  for (const [file, seconds] of Object.entries(previousLedger.files)) {
    assert.ok(timings.files[file] >= seconds, `historical file maximum decreased: ${file}`);
  }
  for (const [owner, seconds] of Object.entries(previousLedger.owners)) {
    assert.ok(timings.owners[owner] >= seconds, `historical owner maximum decreased: ${owner}`);
  }
});

test('long native capture journeys start before ordinary backfill', () => {
  for (const id of ['modeling-s6', 'modeling-show']) {
    const lane = DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(id));
    const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
    assert.ok(
      group.placementReserveSeconds >= 600,
      'retain measured capture headroom without changing the case deadline',
    );
    const selected = selectDawnShard(`${lane + 1}/4`);
    assert.ok(
      selected.findIndex((candidate) => candidate.id === id) <
        selected.findIndex((candidate) => candidate.id.startsWith('ordinary-')),
      'both complete capture journeys must start before ordinary backfill',
    );
  }
  assert.deepEqual(
    selectDawnShard('4/4')
      .slice(0, 2)
      .map(({ id }) => id),
    ['modeling-s6', 'modeling-show'],
  );
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
