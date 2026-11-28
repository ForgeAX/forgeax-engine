import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import modelingDeferred from '../core-coverage-modeling-deferred.json' with { type: 'json' };
import { coreValidationFiles } from '../core-validation.mjs';
import deferred from '../core-validation-deferred.json' with { type: 'json' };
import { dawnAuthoringCapturesOutsideCi } from '../dawn-gate-roster.mjs';
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

test('Engine Dawn keeps full example captures out of both automated profiles', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const hosted = {
    FORGEAX_DAWN_OMIT_AUTHORING_CAPTURES:
      workflow.jobs['vitest-dawn'].env.FORGEAX_DAWN_OMIT_AUTHORING_CAPTURES,
  };
  assert.deepEqual(dawnAuthoringCapturesOutsideCi({ GITHUB_ACTIONS: 'true' }), []);
  const authoring = dawnAuthoringCapturesOutsideCi(hosted);
  assert.equal(authoring.length, 2);
  for (const env of [hosted, { ...hosted, ...core }]) {
    const groups = dawnExecutionGroups(undefined, undefined, env);
    for (const path of authoring) assert.ok(!groups.some(({ files }) => files.includes(path)));
    assert.ok(groups.some(({ id }) => id === 'modeling-show'));
  }
  assert.ok(dawnExecutionGroups('modeling-s6', undefined, hosted)[0].files.includes(authoring[0]));
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

test('core GI reuses complete Renderer journeys in the Native Ray Query matrix', () => {
  const workflow = parse(readFileSync('.github/workflows/native-ray-query.yml', 'utf8'));
  const owners = workflow.jobs['native-node-gi'].strategy.matrix.include;
  const dawnCore = dawnExecutionGroups(undefined, undefined, core).flatMap(({ files }) => files);
  const dawnFull = dawnExecutionGroups(undefined, undefined, {}).flatMap(({ files }) => files);
  for (const [group, name] of [
    ['foundation', 'irradiance-field'],
    ['foundation', 'irradiance-field-edit'],
    ['foundation', 'radiance-cache'],
    ['mutation', 'irradiance-field-add'],
    ['mutation', 'irradiance-field-clipmap'],
    ['mutation', 'irradiance-field-residency'],
    ['mutation', 'gi-coverage'],
    ['mutation', 'irradiance-field-multiview'],
    ['gather', 'screen-probe'],
  ]) {
    const file = `packages/runtime/src/__tests__/renderer-${name}.dawn.test.ts`;
    const selected = owners.filter(({ tests }) => tests.split(/\s+/).includes(file));
    assert.deepEqual(
      selected.map((owner) => owner.group),
      [group],
    );
    assert.ok(dawnFull.includes(file));
    assert.ok(!dawnCore.includes(file));
  }
  assert.ok(
    dawnCore.includes('packages/render/src/__tests__/raytracing/screen-probe-history.dawn.test.ts'),
  );
  assert.ok(dawnCore.includes('packages/runtime/src/__tests__/renderer-reflections.dawn.test.ts'));
  assert.ok(
    dawnCore.includes(
      'packages/render/src/__tests__/raytracing/irradiance-field-visibility.dawn.test.ts',
    ),
  );
});
test('Dawn core keeps both software trace and Card lookup with a bounded scene', () => {
  const group = dawnExecutionGroups(undefined, undefined, core).find(({ id }) => id === 'gi-3');
  assert.deepEqual(group.files, [
    'packages/render/src/__tests__/raytracing/global-sdf-gpu-rays.dawn.test.ts',
    'packages/render/src/__tests__/raytracing/global-card-lookup.dawn.test.ts',
  ]);
  assert.ok(
    dawnExecutionGroups('gi-3', undefined, core)[0].files.includes(
      'packages/runtime/src/__tests__/renderer-gi-coverage.dawn.test.ts',
    ),
  );
});

test('core Dawn runs the reflection filter while full and Focus retain the live denoise journey', () => {
  const filter =
    'packages/render/src/__tests__/raytracing/irradiance-field-reflection-filter.dawn.test.ts';
  const journey = 'packages/runtime/src/__tests__/renderer-reflection-denoise.dawn.test.ts';
  const groups = dawnExecutionGroups(undefined, undefined, core);
  assert.deepEqual(groups.find(({ id }) => id === 'gi-4').files, [filter]);
  const full = dawnExecutionGroups(undefined, undefined, {});
  assert.ok(full.find(({ id }) => id === 'gi-4').files.includes(journey));
  assert.ok(dawnExecutionGroups('gi-4', undefined, core)[0].files.includes(journey));
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

test('coverage core compacts only reviewed Modeling showcases and uses fresh partition identities', () => {
  const projects = ['@forgeax/engine-modeling'];
  const full = coverageGroups(projects, 8, { environment: {} });
  const coreGroups = coverageGroups(projects, 8, { environment: core });
  const previous = coverageGroups(projects, 8, { environment: core, historicalModeling: true });
  const partitionExcludes = (groups) =>
    new Set(groups.filter((g) => g.shard).flatMap((g) => g.excludes));
  const selected = partitionExcludes(coreGroups);
  const previousExcluded = partitionExcludes(previous);
  const fullExcluded = partitionExcludes(full);
  const files = modelingDeferred.map(({ file }) => file);
  assert.equal(new Set(files).size, files.length);
  for (const { file, retained, reason } of modelingDeferred) {
    assert.ok(file.startsWith('packages/modeling/examples/'), file);
    assert.ok(existsSync(file) && existsSync(retained), file);
    assert.ok(reason.length > 30 && modelingTimings.files[file] > 0, file);
    assert.ok(!selected.has(retained), retained);
    assert.ok(
      !previousExcluded.has(file) || previous.some((group) => group.files.includes(file)),
      file,
    );
    assert.ok(selected.has(file), file);
    assert.ok(
      coreGroups.every((group) => !group.files.includes(file)),
      file,
    );
    assert.ok(full.some((group) => group.files.includes(file)) || !fullExcluded.has(file), file);
  }
  assert.deepEqual(
    [...selected].filter((file) => file.startsWith('packages/modeling/src/')).sort(),
    [...previousExcluded].filter((file) => file.startsWith('packages/modeling/src/')).sort(),
  );
  const oldLabels = new Set(previous.map((group) => group.label));
  const partitions = coreGroups.filter((group) => group.shard);
  assert.equal(full.filter((group) => group.shard).length, 16);
  assert.equal(partitions.length, 12);
  assert.ok(partitions.every((group) => !oldLabels.has(group.label)));
});

test('authored Modeling showcases stay outside daily and expanded instrumented rosters', () => {
  const files = [
    'packages/modeling/examples/maid-whale/__tests__/g7-charts.integration.test.ts',
    'packages/modeling/examples/limb-choreography/__tests__/choreo.unit.test.ts',
  ];
  for (const environment of [{}, core]) {
    const groups = coverageGroups(['@forgeax/engine-modeling'], 8, { environment });
    for (const file of files) {
      assert.ok(!groups.some((group) => group.files.includes(file)));
      assert.ok(
        groups.filter((group) => group.shard).every((group) => group.excludes.includes(file)),
      );
    }
  }
});

test('daily native journeys stay complete and uninstrumented on the existing primary worker', () => {
  const liveJourney = 'packages/devkit/src/__tests__/live-dev-look.e2e.test.ts';
  const files = [
    'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
    'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
    liveJourney,
  ];
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs['primary-pnpm'].steps.find(
    (entry) => entry.name === 'DevKit native browser journeys (uninstrumented)',
  );
  assert.ok(step);
  assert.ok(step.run.includes(files[0]));
  assert.ok(!step.run.includes(files[1]), 'the worker and live edit journeys own native startup');
  assert.ok(step.run.includes(liveJourney));
  assert.match(step.run, /--maxWorkers=1/);
  assert.match(step.run, /--coverage.enabled=false/);
  assert.match(step.run, /--passWithNoTests=false/);
  assert.equal(step.env.FORGEAX_CI_CORE_VALIDATION, '0');
  const full = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: {} });
  const daily = coverageGroups(['@forgeax/engine-devkit'], 8, { environment: core });
  for (const file of files) {
    assert.equal(
      full.filter((group) => group.files.includes(file)).length,
      file === liveJourney ? 0 : 1,
    );
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
  assert.equal(play.env.FORGEAX_CHROME_CHANNEL, 'chrome');
  assert.match(play.run, /--maxWorkers=1/);
  assert.match(play.run, /--coverage.enabled=false/);
  assert.match(play.run, /--passWithNoTests=false/);
  const preparation = view.steps.findIndex(
    (step) => step.name === 'Prepare verified paired consumer inputs',
  );
  assert.ok(preparation >= 0 && preparation < view.steps.indexOf(play));
  assert.equal(view.steps[preparation].if, "steps.ci-repair.outputs.reused != 'true'");
  assert.equal(view.steps[preparation].with.consumer, 'view-integration-shards');
  assert.match(play.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST, /shared-app-inputs\/manifest.json/);
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

test('Core provenance records the shared template producer facts once', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs['core-build'].steps.find(({ id }) => id === 'write-shared-provenance');
  assert.ok(step);
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-shared-provenance-'));
  try {
    const inputs = join(fixture, 'shared-app-inputs');
    mkdirSync(inputs);
    const output = join(fixture, 'out');
    const facts = { engineCompileCount: 0, buildDurationSeconds: 2.75 };
    const fingerprints = { 'shared-asset-pack': 'assets', 'shared-engine-shaders': 'shaders' };
    writeFileSync(join(inputs, 'manifest.json'), JSON.stringify({ inputFingerprint: 'test' }));
    writeFileSync(join(inputs, 'production-facts.json'), JSON.stringify(facts));
    writeFileSync(join(fixture, 'shared-input-fingerprints.json'), JSON.stringify(fingerprints));
    const run = spawnSync(process.execPath, ['-e', step.run], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...step.env,
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_RUN_ID: '123',
        GITHUB_OUTPUT: output,
        SHARED_ARTIFACT_ID: '45',
        UPLOAD_ELAPSED_SECONDS: '1.5',
        UPLOAD_TRANSFER_ATTEMPT: '1',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(readFileSync(join(fixture, 'provenance-shared-app-inputs-a2.json')));
    assert.deepEqual(record.sharedProduction, facts);
    assert.deepEqual(
      record.artifacts.map(({ class: family, artifactId, inputFingerprint }) => [
        family,
        artifactId,
        inputFingerprint,
      ]),
      Object.entries(fingerprints).map(([family, fingerprint]) => [family, '45', fingerprint]),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Core releases consumer declarations while a required existing owner checks the full graph', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const core = workflow.jobs['core-build'].steps;
  const checks = workflow.jobs['primary-pnpm'].steps;
  assert.equal(workflow.jobs['smoke-fleet'].needs.includes('primary-pnpm'), false);
  for (const owner of ['app-shard-0', 'app-shard-1', 'app-shard-2'])
    assert.ok(
      !workflow.jobs[owner].steps.some(({ name }) => name === 'Package declaration typecheck'),
    );
  assert.match(
    core.find(({ name }) => name === 'Emit package declarations for prepared inputs').run,
    /tsc -b --noCheck/,
  );
  assert.equal(
    core.some(({ name }) => name === 'Package declaration typecheck'),
    false,
  );
  assert.match(
    checks.find(({ name }) => name === 'Package declaration typecheck').run,
    /tsc -b --force/,
  );
  assert.equal(checks.filter(({ name }) => name?.startsWith('Reproduce clean')).length, 2);
  assert.ok(workflow.jobs['build-artifacts'].needs.includes('app-shard-2'));
  assert.match(
    workflow.jobs['build-artifacts'].steps.map(({ run }) => run).join('\n'),
    /needs.app-shard-2.result/,
  );
});
