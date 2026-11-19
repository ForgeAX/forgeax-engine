import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { coreValidationFiles } from '../core-validation.mjs';
import deferred from '../core-validation-deferred.json' with { type: 'json' };
import modelingTimings from '../modeling-coverage-file-seconds.json' with { type: 'json' };
import { dawnExecutionGroups, selectDawnGroups } from '../run-dawn-gate.mjs';
import { browserFileWeight, browserTestFiles } from '../run-split-vitest-browser.mjs';
import { coverageGroups } from '../run-split-vitest-coverage.mjs';

const core = { FORGEAX_CI_CORE_VALIDATION: '1' };

test('Dawn core execution omits empty groups and explicit diagnosis always runs the full owner', () => {
  const groups = dawnExecutionGroups(undefined, undefined, core);
  assert.ok(groups.every((group) => group.vitestShard !== undefined || group.files.length > 0));
  const files = groups.flatMap((group) => group.files);
  for (const { file } of deferred) assert.ok(!files.includes(file));
  assert.deepEqual(
    dawnExecutionGroups('shadow-quality', undefined, core),
    selectDawnGroups('shadow-quality'),
  );
  assert.deepEqual(dawnExecutionGroups(undefined, undefined, {}), selectDawnGroups());
});

test('core selection is explicit, preserves new owners and leaves full validation intact', () => {
  const files = [...deferred.map(({ file }) => file), 'new-owner.browser.test.ts'];
  assert.deepEqual(coreValidationFiles(files, {}), files);
  assert.deepEqual(coreValidationFiles(files, { FORGEAX_CI_CORE_VALIDATION: '0' }), files);
  assert.deepEqual(coreValidationFiles(files, core), ['new-owner.browser.test.ts']);
  assert.equal(new Set(deferred.map(({ file }) => file)).size, deferred.length);
  for (const row of deferred) {
    assert.ok(existsSync(row.file), row.file);
    assert.ok(row.reason.length > 30, row.file);
    assert.ok(!row.file.startsWith('packages/rhi-'), row.file);
    if (row.retained) {
      assert.ok(existsSync(row.retained), row.retained);
      assert.deepEqual(coreValidationFiles([row.retained], core), [row.retained]);
    }
  }
});

test('Browser retains approximately eighty percent of measured work', () => {
  const files = browserTestFiles();
  const selected = coreValidationFiles(files, core);
  const weight = (values) => values.reduce((sum, file) => sum + browserFileWeight(file), 0);
  const ratio = weight(selected) / weight(files);
  assert.ok(ratio >= 0.75 && ratio <= 0.85, String(ratio));
  for (const suffix of ['render', 'texture', 'shadow-directional']) {
    assert.ok(selected.includes(`packages/three/src/__tests__/${suffix}.browser.test.ts`));
  }
});

test('WaterMesh visibility stays in the core Browser GPU roster', () => {
  const file = 'packages/runtime/src/__tests__/water-mesh-visibility.browser.test.ts';
  assert.ok(coreValidationFiles(browserTestFiles(), core).includes(file));
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const evidence = workflow.jobs['vitest-browser-shard'].steps.find(
    (step) => step.name === 'Preserve render browser failure evidence',
  );
  assert.ok(evidence.with.path.includes('artifacts/water-mesh-visibility/'));
});

test('workflow selects full Nightly and core PR work without adding execution lanes', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(
    workflow.jobs['vitest-browser-shard'].env.FORGEAX_CI_CORE_VALIDATION,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression.
    "${{ inputs.nightly_full_profile && '0' || '1' }}",
  );
  for (const job of [
    'coverage-pnpm-shard',
    'coverage-pnpm',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
    'build-artifacts',
    'smoke-fleet',
  ])
    assert.equal(
      workflow.jobs[job].env.FORGEAX_CI_CORE_VALIDATION,
      workflow.jobs['vitest-browser-shard'].env.FORGEAX_CI_CORE_VALIDATION,
    );
  for (const job of Object.values(workflow.jobs)) {
    for (const values of Object.values(job.strategy?.matrix ?? {})) {
      if (Array.isArray(values)) assert.ok(values.length <= 4);
    }
  }
});

test('workflow shell and native descendants inherit a zero core limit', {
  skip: process.platform !== 'linux',
}, () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  for (const file of ['sdk-pr-preflight.yml', 'webgpu-compatibility.yml']) {
    const sibling = parse(readFileSync(`.github/workflows/${file}`, 'utf8'));
    assert.equal(sibling.defaults.run.shell, workflow.defaults.run.shell);
  }
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-core-limit-'));
  const script = join(dir, 'probe.sh');
  writeFileSync(script, 'ulimit -c; bash -c "ulimit -c"\n');
  const [command, ...args] = workflow.defaults.run.shell.split(' ');
  args[args.indexOf('{0}')] = script;
  const probe = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '0\n0');
});

test('coverage core defers expanded Modeling examples while retaining core operators and thresholds', () => {
  const full = coverageGroups(['@forgeax/engine-modeling'], 8, { environment: {} });
  const selected = coverageGroups(['@forgeax/engine-modeling'], 8, { environment: core });
  const excluded = new Set(selected.flatMap((group) => group.excludes));
  const files = [
    'packages/modeling/examples/hood-linkage/__tests__/hood.unit.test.ts',
    'packages/modeling/examples/__tests__/scene-components.unit.test.ts',
    'packages/modeling/examples/mech-gt/__tests__/proportions.perturb.unit.test.ts',
    'packages/modeling/examples/mech-gt/__tests__/s6c-car-form.integration.test.ts',
    'packages/modeling/examples/mech-gt/__tests__/s6c-ranges.unit.test.ts',
    'packages/modeling/examples/mech-gt/__tests__/s7-motion.unit.test.ts',
  ];
  for (const file of files) {
    assert.ok(excluded.has(file), file);
    assert.ok(full.every((group) => !group.excludes.includes(file)));
  }
  assert.ok(!excluded.has('packages/modeling/src/__tests__/pin-joint.unit.test.ts'));
  assert.ok(
    selected.some((group) =>
      group.files.includes('packages/modeling/examples/mech-gt/__tests__/s6c.unit.test.ts'),
    ),
  );
  const seconds = Object.values(modelingTimings.files).reduce((sum, value) => sum + value, 0);
  const retained = 1 - files.reduce((sum, file) => sum + modelingTimings.files[file], 0) / seconds;
  assert.ok(retained >= 0.78 && retained <= 0.82, String(retained));
  assert.equal(selected.length, full.length);
});

test('daily native journeys stay complete and uninstrumented on the existing primary worker', () => {
  const files = [
    'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
    'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
    'packages/devkit/src/__tests__/live-dev-look.e2e.test.ts',
  ];
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs['primary-pnpm'].steps.find(
    (entry) => entry.name === 'DevKit native browser journeys (uninstrumented)',
  );
  assert.ok(step);
  for (const file of files) assert.ok(step.run.includes(file));
  assert.match(step.run, /--maxWorkers=1/);
  assert.match(step.run, /--coverage.enabled=false/);
  assert.match(step.run, /--passWithNoTests=false/);
  assert.equal(step.env.FORGEAX_CI_CORE_VALIDATION, '0');
  const full = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: {} });
  const daily = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: core });
  for (const file of files) {
    assert.equal(full.filter((group) => group.files.includes(file)).length, 1);
    assert.ok(daily.every((group) => !group.files.includes(file)));
    assert.ok(
      daily
        .filter((group) => group.files.length === 0)
        .every((group) => group.excludes.includes(file)),
    );
  }
  assert.equal(
    full.length - daily.length,
    3,
    'reuse prepared native workers instead of three daily coverage children',
  );
});

test('Project Play retains all native acceptance on View one and full-profile V8 coverage', () => {
  const file = 'packages/devkit/src/__tests__/project-play.e2e.test.ts';
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const owners = Object.entries(workflow.jobs).filter(([_id, job]) =>
    job.steps?.some((step) => step.run?.includes(file)),
  );
  assert.deepEqual(
    owners.map(([id]) => id),
    ['view-integration-shards'],
  );
  const view = owners[0][1];
  const play = view.steps.find((step) => step.run?.includes(file));
  assert.equal(play.if, "steps.ci-repair.outputs.reused != 'true' && (matrix.shard == '1')");
  assert.equal(play.env.FORGEAX_CI_CORE_VALIDATION, '0');
  assert.equal(play.env.FORGEAX_CHROME_CHANNEL, 'chrome-beta');
  assert.match(play.run, /--maxWorkers=1/);
  assert.match(play.run, /--coverage.enabled=false/);
  assert.match(play.run, /--passWithNoTests=false/);
  const point = view.steps.findIndex(
    (step) => step.name === 'Prepare matching DevKit browser shader profile',
  );
  assert.ok(point >= 0 && point < view.steps.indexOf(play));
  assert.match(view.steps[point].if, /matrix.shard == '1'/);
  const full = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: {} });
  const daily = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: core });
  assert.equal(full.filter((group) => group.files.includes(file)).length, 1);
  assert.ok(daily.every((group) => !group.files.includes(file)));
  assert.ok(
    daily
      .filter((group) => group.files.length === 0)
      .every((group) => group.excludes.includes(file)),
  );
  assert.equal(view['timeout-minutes'], 30);
});
