import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shaderProducerCompileWorkers,
  shaderSourceCompileWorkers,
} from '../../lib/runner-resources.mjs';
import { focusPlan } from '../run-ci-focus.mjs';
import {
  allProjectNames,
  coverageGroupEnvironment,
  coverageGroupMaxWorkers,
  coverageGroups,
} from '../run-split-vitest-coverage.mjs';

const selector =
  'packages/vite-plugin-shader/src/__tests__/production-resampling-vite.integration.test.ts';
const resources = { cpus: 8, memoryBytes: 16_000_000_000 };

test('a dedicated manifest producer uses spare CPU within its separate heap and Worker budgets', () => {
  assert.equal(shaderProducerCompileWorkers(resources), 7);
  assert.equal(shaderProducerCompileWorkers(resources, '4'), 4);
  assert.equal(shaderProducerCompileWorkers(resources, '1'), 1);
  assert.equal(shaderProducerCompileWorkers({ ...resources, cpus: 4 }, '7'), 3);
  assert.equal(shaderProducerCompileWorkers({ ...resources, memoryBytes: 8 * 1024 ** 3 }), 2);
  assert.equal(shaderProducerCompileWorkers(resources, '7', 10 * 1024), 3);
  assert.equal(shaderProducerCompileWorkers({ cpus: 64, memoryBytes: 128 * 1024 ** 3 }, '64'), 7);
});

test('cold compiler capacity reserves its producer heap before admitting parallel workers', () => {
  assert.equal(shaderSourceCompileWorkers(resources), 4);
  assert.equal(shaderSourceCompileWorkers(resources, '7'), 4);
  assert.equal(shaderSourceCompileWorkers(resources, '1'), 1);
  assert.equal(shaderSourceCompileWorkers({ ...resources, cpus: 2 }, '7'), 1);
  assert.equal(shaderSourceCompileWorkers({ ...resources, memoryBytes: 8 * 1024 ** 3 }, '7'), 2);
  assert.equal(shaderSourceCompileWorkers({ ...resources, memoryBytes: 6 * 1024 ** 3 }, '7'), 1);
  assert.equal(shaderSourceCompileWorkers(resources, '7', 4096), 4);
  assert.equal(shaderSourceCompileWorkers({ ...resources, memoryBytes: 128 * 1024 ** 3 }, '99'), 4);
});

test('the original source coverage owner receives parallel compilation and one file worker', () => {
  const group = coverageGroups(allProjectNames(), 8).find((candidate) =>
    candidate.files.includes(selector),
  );
  assert.ok(group?.sourceCompilation);
  const original = { NODE_OPTIONS: '--import=probe.mjs --max-old-space-size=4096', KEEP: 'yes' };
  const env = coverageGroupEnvironment(group, resources, 7, original);
  assert.equal(env.FORGEAX_SHADER_COMPILE_WORKERS, '4');
  assert.equal(env.FORGEAX_SHADER_COMPILE_DIAGNOSTICS, '1');
  assert.equal(
    env.NODE_OPTIONS,
    '--import=probe.mjs --max-old-space-size=4096 --max-old-space-size=7168',
  );
  assert.equal(env.KEEP, 'yes');
  assert.equal(original.NODE_OPTIONS, '--import=probe.mjs --max-old-space-size=4096');
  assert.equal(coverageGroupMaxWorkers(group, { coverage: true, maxWorkers: 2 }, resources, 2), 1);
  assert.equal(
    coverageGroupEnvironment(group, { ...resources, memoryBytes: 6 * 1024 ** 3 }, 7, {})
      .FORGEAX_SHADER_COMPILE_WORKERS,
    '1',
  );
});

for (const [file, workerLimit] of [
  ['packages/pack/src/__tests__/material-surface-publication.unit.test.ts', '7'],
  ['packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts', '7'],
  ['packages/shader-compiler/src/__tests__/material-standard-alias.unit.test.ts', '7'],
  [
    'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
    '5',
  ],
])
  test(`serial material coverage uses the ordinary heap and spare program capacity for ${file}`, () => {
    const group = coverageGroups(allProjectNames(), 8).find(({ files }) => files.includes(file));
    assert.ok(group?.sourceCompilation);
    assert.equal(
      coverageGroupMaxWorkers(group, { coverage: true, maxWorkers: 2 }, resources, 2),
      1,
    );
    const native = coverageGroupEnvironment(group, resources, undefined, {});
    assert.equal(native.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(native.FORGEAX_SHADER_COMPILE_WORKERS, workerLimit);
    assert.equal(
      coverageGroupEnvironment(group, resources, 4, {}).FORGEAX_SHADER_COMPILE_WORKERS,
      '4',
    );
    const constrained = { cpus: 8, memoryBytes: 8 * 1024 ** 3 };
    assert.equal(
      coverageGroupEnvironment(group, constrained, 7, {}).FORGEAX_SHADER_COMPILE_WORKERS,
      '2',
    );
    const focus = focusPlan('coverage', file, { resources });
    assert.equal(focus.env.NODE_OPTIONS?.split(' ').at(-1), native.NODE_OPTIONS);
    assert.equal(
      focus.env.FORGEAX_SHADER_COMPILE_WORKERS,
      coverageGroupEnvironment(group, resources, process.env.FORGEAX_SHADER_COMPILE_WORKERS, {})
        .FORGEAX_SHADER_COMPILE_WORKERS,
    );
  });

test('the cold Standard source alias has its own coverage process', () => {
  const file = 'packages/shader-compiler/src/__tests__/material-standard-alias.unit.test.ts';
  const owners = coverageGroups(allProjectNames(), 8).filter(({ files }) => files.includes(file));
  assert.equal(owners.length, 1);
  assert.deepEqual(owners[0].files, [file]);
  assert.equal(owners[0].packagesOnly, true);
});

test('source coverage focus matches the exclusive compiler and heap admission', () => {
  const prior = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  const priorNodeOptions = process.env.NODE_OPTIONS;
  try {
    delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
    delete process.env.NODE_OPTIONS;
    const defaultPlan = focusPlan('coverage', selector, { resources });
    assert.equal(defaultPlan.env.FORGEAX_SHADER_COMPILE_WORKERS, '4');
    assert.equal(defaultPlan.env.NODE_OPTIONS, '--max-old-space-size=7168');
    assert.ok(defaultPlan.args.includes('--maxWorkers=1'));
    assert.ok(defaultPlan.args.includes('--typecheck.enabled=false'));
    process.env.FORGEAX_SHADER_COMPILE_WORKERS = '7';
    const requestedPlan = focusPlan('coverage', selector, { resources });
    assert.equal(requestedPlan.env.FORGEAX_SHADER_COMPILE_WORKERS, '4');
    const constrained = focusPlan('coverage', selector, { resources: { ...resources, cpus: 2 } });
    assert.equal(constrained.env.FORGEAX_SHADER_COMPILE_WORKERS, '1');
    process.env.NODE_OPTIONS = '--trace-warnings --max-old-space-size=4096';
    assert.equal(
      focusPlan('coverage', selector, { resources }).env.NODE_OPTIONS,
      '--trace-warnings --max-old-space-size=4096 --max-old-space-size=7168',
    );
  } finally {
    if (prior === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
    else process.env.FORGEAX_SHADER_COMPILE_WORKERS = prior;
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorNodeOptions;
  }
});

test('compile progress is scoped to exclusive source children without mutating the parent', () => {
  const parent = { FORGEAX_SHADER_COMPILE_DIAGNOSTICS: '1', KEEP: 'original' };
  const ordinary = coverageGroupEnvironment({ sourceCompilation: false }, resources, 2, parent);
  assert.equal(ordinary.FORGEAX_SHADER_COMPILE_DIAGNOSTICS, undefined);
  assert.equal(ordinary.KEEP, 'original');
  assert.equal(parent.FORGEAX_SHADER_COMPILE_DIAGNOSTICS, '1');
  assert.throws(
    () => coverageGroupEnvironment({ sourceCompilation: true, files: [] }, resources, 2, parent),
    /exclusive coverage owner/,
  );
});
