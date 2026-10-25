import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
import { BaseSequencer, createVitest } from 'vitest/node';
import { DawnSequencer, planDawnShards } from '../../../config/vitest-dawn-sequencer.ts';
import { DAWN_COMPACT_TEST_FILES } from '../dawn-compact-roster.mjs';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../dawn-gate-roster.mjs';
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
const configuredPartitions = [];
try {
  nativeSpecifications = await nativeVitest.globTestSpecifications();
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

function listDawnFiles(extraEnv = {}) {
  const env = { ...process.env };
  for (const key of selectors) delete env[key];
  const output = execFileSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--project=dawn', '--filesOnly', '--json'],
    { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(output)
    .map(({ file }) => relative(root, file).replaceAll('\\', '/'))
    .sort();
}

test('actual Vitest discovery conserves every Dawn file across execution groups', () => {
  const owners = validateDawnGateRoster();
  const ordinary = listDawnFiles();
  assert.ok(ordinary.length > 0, 'the ordinary gate must execute tests');
  const all = listDawnFiles({
    FORGEAX_DAWN_ISOLATED: '1',
    FORGEAX_DAWN_COMPACT: '1',
    FORGEAX_DAWN_PARTITION: 'roster-audit',
  });
  for (const file of ordinary) assert.ok(!owners.has(file), `duplicate ordinary owner: ${file}`);
  const planned = [...ordinary, ...owners.keys()].sort();
  assert.deepEqual(planned, all, 'every discovered file must execute exactly once');
});

test('each group keeps its admission and native lifetime boundary', () => {
  const ids = DAWN_GATE_GROUPS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of DAWN_GATE_GROUPS) {
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
    assert.deepEqual(
      selectDawnShard(`${index + 1}/${DAWN_GATE_SHARDS.length}`).map((group) => group.id),
      DAWN_GATE_GROUPS.filter((group) => lane.includes(group.id)).map((group) => group.id),
    );
    assert.equal(lane.filter((id) => id.startsWith('ordinary-')).length, 1);
  }
  assert.equal(
    DAWN_GATE_SHARDS.findIndex((lane) => lane.includes('gi-5')),
    1,
    'the measured GI reservation belongs on the former overrun lane',
  );
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
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/nightly.yml']) {
    const workflow = readFileSync(file, 'utf8');
    const start = workflow.indexOf('      - name: Vitest dawn project');
    assert.ok(start >= 0);
    const remaining = workflow.slice(start);
    const nextStep = remaining.indexOf('\n      - name:', 1);
    const step = remaining.slice(0, nextStep === -1 ? undefined : nextStep);
    assert.match(step, /node scripts\/ci\/run-dawn-gate\.mjs(?: --shard [^\n]+)?/);
    assert.match(step, /NODE_OPTIONS: --max-old-space-size=4096/);
    assert.equal(step.includes("FORGEAX_DAWN_LIGHTWEIGHT: '1'"), file.endsWith('/ci.yml'));
  }
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
