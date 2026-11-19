import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { checkWorkflowText } from '../check-runner-pool-labels.mjs';
import { focusBuildArgs, focusPlan } from '../run-ci-focus.mjs';
import { selectDawnGroups } from '../run-dawn-gate.mjs';
import { packageOnlyNodeAppProjects } from '../run-split-vitest-coverage.mjs';

test('Water CPU projects retain their complete instrumented child with package preparation', () => {
  for (const project of packageOnlyNodeAppProjects) {
    const plan = focusPlan('unit', project);
    assert.equal(plan.packagesOnly, true);
    assert.ok(plan.args.includes(project));
  }
  const selector = packageOnlyNodeAppProjects.join(',');
  const plan = focusPlan('coverage', selector);
  assert.equal(plan.packagesOnly, true);
  assert.ok(plan.args.includes('--coverage'));
  for (const project of packageOnlyNodeAppProjects)
    assert.equal(plan.args[plan.args.indexOf(project) - 1], '--project');
  assert.ok(plan.args.includes('--maxWorkers=1'));
  assert.deepEqual(focusBuildArgs(plan), ['scripts/build.mjs', '--packages-only']);
  assert.notEqual(focusPlan('unit', '@forgeax/engine-runtime').packagesOnly, true);
});

test('CPU performance focus uses the same complete uninstrumented gates as CI', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  for (const [selector, project, name] of [
    ['ecs-ratios', 'ecs-perf', 'ECS performance ratio gates (uninstrumented)'],
    ['render-ratios', 'render-perf', 'Render performance ratio gates (uninstrumented)'],
  ]) {
    const plan = focusPlan('performance', selector);
    const step = workflow.jobs['coverage-perf'].steps.find((entry) => entry.name === name);
    assert.deepEqual(plan.args, [
      'scripts/ci/run-with-runner-cpu-affinity.mjs',
      '--',
      process.execPath,
      'scripts/ci/run-vitest-projects.mjs',
      'run',
      '--maxWorkers=1',
      `--project=${project}`,
      '--coverage.enabled=false',
      '--typecheck.enabled=false',
      '--passWithNoTests=false',
    ]);
    assert.equal(
      step.run.replace(/\s+/g, ' ').trim(),
      ['node', ...plan.args.map((arg) => (arg === process.execPath ? 'node' : arg))].join(' '),
    );
    assert.deepEqual(plan.env, step.env ?? {});
    assert.equal(plan.gpuLease, undefined);
    assert.equal(plan.apps, undefined);
  }
});

test('LOD performance focus retains the real producer and separates opt-in profiling', () => {
  const plan = focusPlan('performance', 'hello-lod-occlusion');
  assert.deepEqual(plan.apps, ['apps/hello/lod-occlusion']);
  assert.deepEqual(plan.args, [
    'scripts/ci/run-with-runner-cpu-affinity.mjs',
    '--',
    process.execPath,
    'scripts/ci/run-lod-performance-with-retry.mjs',
    '--',
    'pnpm',
    '--filter',
    '@forgeax/hello-lod-occlusion',
    'bench:json',
  ]);
  assert.equal(plan.gpuLease, true);
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.deepEqual(plan.env, {
    NODE_OPTIONS:
      process.env.NODE_OPTIONS ?? workflow.jobs['metrics-validate-runtime'].env.NODE_OPTIONS,
  });
  const profile = focusPlan('performance', 'hello-lod-occlusion-profile');
  assert.deepEqual(profile.args, plan.args);
  assert.deepEqual(profile.env, { ...plan.env, FORGEAX_LOD_PROFILE: '1' });
  assert.throws(() => focusPlan('performance', 'unknown'), /performance selector/);
});

test('cold source Focus uses owner-declared package preparation without cooking unused profiles', () => {
  for (const file of [
    'direct-dfg-manifest.integration.test.ts',
    'surface-manifest.integration.test.ts',
  ]) {
    const selector = `packages/vite-plugin-shader/src/__tests__/${file}`;
    const plan = focusPlan('coverage', selector);
    assert.equal(plan.packagesOnly, true);
    assert.ok(plan.args.includes(selector));
    assert.ok(plan.args.includes('--coverage'));
    assert.equal(
      plan.args.filter((arg) => arg.startsWith('--maxWorkers=')).join(),
      '--maxWorkers=1',
    );
    assert.ok(Number(plan.env.FORGEAX_SHADER_COMPILE_WORKERS) >= 1);
  }
  const consumer = focusPlan(
    'coverage',
    'packages/vite-plugin-shader/src/__tests__/public-surface.unit.test.ts',
  );
  assert.notEqual(consumer.packagesOnly, true);
});

test('focused and full Smoke routes carry 300 through all four shards', () => {
  assert.equal(focusPlan('smoke', 'hello-cinder-fall/smoke', { frames: 300 }).frames, 300);
  const plans = [0, 1, 2, 3].map((shardIndex) =>
    focusPlan('smoke', 'all', { frames: 300, shardIndex, shardCount: 4 }),
  );
  const entries = plans.flatMap((plan) => plan.entries);
  assert.deepEqual(
    entries.map((entry) => entry.gateId).sort(),
    focusPlan('smoke', 'all', { frames: 300 })
      .entries.map((entry) => entry.gateId)
      .sort(),
  );
  assert.equal(new Set(entries.map((entry) => entry.gateId)).size, entries.length);
  assert.deepEqual(
    entries
      .filter((entry) => entry.package === '@forgeax/hello-boss-lightning')
      .map((entry) => [entry.gateId, entry.commandId])
      .sort(),
    [
      ['hello-boss-lightning/sdf', 'smoke:sdf'],
      ['hello-boss-lightning/smoke', 'smoke'],
    ],
  );
  assert.deepEqual(
    entries
      .filter((entry) => entry.package === '@forgeax/hello-terrain')
      .map((entry) => [entry.gateId, entry.commandId]),
    [['hello-terrain/smoke', 'smoke']],
  );
  assert.deepEqual(
    entries
      .filter((entry) => entry.package === '@forgeax/hello-transform-gizmo')
      .map((entry) => entry.gateId)
      .sort(),
    ['hello-transform-gizmo/browser', 'hello-transform-gizmo/smoke'],
  );
  assert.deepEqual(
    entries
      .filter(
        (entry) => entry.package === '@forgeax/app-learn-render-6-pbr-4-transmission-refraction',
      )
      .map((entry) => [entry.gateId, entry.commandId])
      .sort(),
    [
      ['app-learn-render-6-pbr-4-transmission-refraction/features-a', 'smoke:features-a'],
      ['app-learn-render-6-pbr-4-transmission-refraction/features-b', 'smoke:features-b'],
      ['app-learn-render-6-pbr-4-transmission-refraction/frames', 'smoke:frames'],
    ],
  );
  assert.ok(plans.every((plan) => plan.frames === 300 && plan.scope === 'full'));
  assert.throws(() => focusPlan('smoke', 'all', { frames: 59 }), /frame|budget/);
  assert.throws(() => focusPlan('smoke', 'all', { shardIndex: 4, shardCount: 4 }), /shard/);
  const workflow = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  assert.match(workflow, /default: '60'/);
  assert.match(workflow, /\[0,1,2,3\]/);
  assert.match(workflow, /--frames "\$SMOKE_MIN_FRAMES"/);
  assert.match(
    workflow,
    /--aggregate --scope full[\s\S]*--expected-product-sha "\$EXPECTED_PRODUCT_SHA"/,
  );
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, /--allow-blocked/);
});

test('Boss Lightning full Smoke executes every native owner exactly once', () => {
  const manifest = JSON.parse(readFileSync('apps/hello/boss-lightning/package.json', 'utf8'));
  const entries = focusPlan('smoke', 'all').entries.filter(
    (entry) => entry.package === manifest.name,
  );
  const commands = entries.flatMap((entry) => manifest.scripts[entry.commandId].split(' && '));
  assert.deepEqual(commands.sort(), [
    'node scripts/smoke-dawn.mjs',
    'node scripts/smoke-fields-dawn.mjs',
    'node scripts/smoke-sdf-dawn.mjs',
  ]);
});

test('full Smoke aggregation uses the standard self-hosted pool and rejects hosted placement', () => {
  const workflow = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  const checked = checkWorkflowText(workflow, 'ci-focus.yml');
  assert.deepEqual(checked.errors, []);
  const aggregate = checked.selectors.find((selector) => selector.job === 'smoke-aggregate');
  assert.equal(aggregate?.kind, 'self-hosted');
  assert.equal(aggregate.pool, 'standard');

  const hosted = workflow.replace(
    /(^ {2}smoke-aggregate:\n[\s\S]*?^ {4}runs-on: )[^\n]+/m,
    '$1ubuntu-latest',
  );
  assert.notEqual(hosted, workflow);
  assert.ok(
    checkWorkflowText(hosted, 'ci-focus.yml').errors.some((error) =>
      /job smoke-aggregate: GitHub-hosted Linux is disabled/.test(error),
    ),
  );
});

test('full Smoke reruns select one immutable artifact per shard before merging', () => {
  const workflow = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  const aggregate = workflow.slice(workflow.indexOf('  smoke-aggregate:'));
  assert.match(aggregate, /actions: read/);
  assert.match(aggregate, /FORGEAX_ARTIFACT_EXPECTED_SHA: \$\{\{ env\.EXPECTED_PRODUCT_SHA \}\}/);
  assert.match(aggregate, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(aggregate, /download-artifact-with-retry\.mjs/);
  assert.match(aggregate, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(aggregate, /--artifact-pattern "ci-focus-smoke-shard-\*"/);
  assert.match(aggregate, /--expected-count 4/);
  assert.match(aggregate, /--path artifacts\/ci-focus --merge-multiple/);
  assert.doesNotMatch(aggregate, /uses: actions\/download-artifact/);
});

test('selected Dawn group keeps the complete owning partition and rejects typos', () => {
  assert.deepEqual(
    selectDawnGroups('transmission').map((group) => group.id),
    ['transmission'],
  );
  assert.ok(selectDawnGroups().length > 1);
  assert.throws(() => selectDawnGroups('typo'), /unknown Dawn group/);
  assert.deepEqual(focusPlan('dawn', 'transmission').args, [
    'scripts/ci/run-dawn-gate.mjs',
    '--group',
    'transmission',
  ]);
});

test('unit focus preserves exact file filtering and rejects command injection or empty scopes', () => {
  const selected = 'packages/devkit/src/__tests__/host.test.ts';
  const args = focusPlan('unit', selected).args;
  assert.equal(args.at(-1), selected);
  assert.deepEqual(args.slice(2, 4), ['--project', '@forgeax/engine-devkit']);
  assert.ok(!args.includes('--project=@forgeax/*'));
  for (const selector of [
    '',
    '--passWithNoTests',
    '../../outside.test.ts',
    'missing.test.ts',
    '$(false)',
  ])
    assert.throws(() => focusPlan('unit', selector));
  assert.throws(() => focusPlan('unknown', selected));
});

test('a DevKit target lifetime unit gate consumes package outputs without compiling shaders', () => {
  const file = 'packages/devkit/src/tools/__tests__/model-render-target.unit.test.ts';
  const plan = focusPlan('unit', file);
  assert.deepEqual(focusBuildArgs(plan), ['scripts/build.mjs', '--packages-only']);
  assert.equal(plan.args.at(-1), file);
  assert.notEqual(focusPlan('unit', '@forgeax/engine-devkit').packagesOnly, true);
});

test('compiler unit bootstrap builds packages without precompiling the compiler product', () => {
  const owner = '@forgeax/engine-shader-compiler';
  const file =
    'packages/shader-compiler/src/material/__tests__/standard-material-cook.integration.test.ts';
  for (const [kind, selector] of [
    ['unit', owner],
    ['type', owner],
    ['unit', file],
  ]) {
    const plan = focusPlan(kind, selector);
    assert.equal(plan.packagesOnly, true);
    assert.deepEqual(focusBuildArgs(plan), ['scripts/build.mjs', '--packages-only']);
    assert.ok(plan.args.includes(owner));
    assert.ok(plan.args.includes('--passWithNoTests=false'));
  }
  assert.equal(focusPlan('unit', file).args.at(-1), file);
  for (const [kind, selector] of [
    ['unit', '@forgeax/engine-render'],
    ['view', 'modeling'],
    ['dawn', 'transmission'],
    ['compatibility', 'stable'],
  ]) {
    assert.notEqual(focusPlan(kind, selector).packagesOnly, true);
    assert.deepEqual(focusBuildArgs(focusPlan(kind, selector), '/tmp/pinned assets'), [
      'scripts/build.mjs',
      '--engine',
      '--assets-source-root',
      '/tmp/pinned assets',
    ]);
  }
});

test('fixture-only shader metadata Focus retains exact tests without a cold Engine profile', () => {
  for (const name of [
    'manifest-reflection-sharing',
    'manifest-publication',
    'shader-registry-publication-sharing',
    'shader-registry-transaction',
    'native-manifest',
    'shader-manifest-transmission',
  ]) {
    const file = `packages/shader/src/__tests__/${name}.unit.test.ts`;
    const plan = focusPlan('unit', file);
    assert.equal(plan.packagesOnly, true);
    assert.deepEqual(focusBuildArgs(plan), ['scripts/build.mjs', '--packages-only']);
    assert.equal(plan.args.at(-1), file);
    assert.ok(plan.args.includes('@forgeax/engine-shader'));
    assert.ok(plan.args.includes('--passWithNoTests=false'));
  }
  for (const selector of [
    '@forgeax/engine-shader',
    'packages/shader/src/__tests__/default-standard-pbr-transmission.unit.test.ts',
  ]) {
    assert.notEqual(focusPlan('unit', selector).packagesOnly, true);
    assert.deepEqual(focusBuildArgs(focusPlan('unit', selector)), [
      'scripts/build.mjs',
      '--engine',
    ]);
  }
});

test('CPU Node and Modeling focus retain package builds without a GPU product prerequisite', () => {
  const node = 'scripts/ci/__tests__/browser-test-discovery.test.mjs';
  const file = 'packages/modeling/src/__tests__/perf-tiers.unit.test.ts';
  for (const [kind, selector] of [
    ['node', node],
    ['unit', '@forgeax/engine-modeling'],
    ['type', '@forgeax/engine-modeling'],
    ['unit', file],
  ]) {
    const plan = focusPlan(kind, selector);
    assert.deepEqual(focusBuildArgs(plan), ['scripts/build.mjs', '--packages-only']);
  }
  assert.deepEqual(focusPlan('node', node).args, ['--test', node]);
  assert.equal(focusPlan('unit', file).args.at(-1), file);
});

test('compatibility focus retains the complete stable carrier instead of a different Browser profile', () => {
  assert.deepEqual(focusPlan('compatibility', 'stable'), {
    args: ['scripts/ci/run-webgpu-compatibility.mjs'],
    env: { FORGEAX_COMPAT_BROWSER: 'stable' },
  });
  for (const selector of ['latest', 'stable --skip', 'scene', 'webkit'])
    assert.throws(() => focusPlan('compatibility', selector), /unknown compatibility selector/);
});

test('browser focus conserves exact roster membership before launching Chrome', () => {
  const script = 'scripts/ci/run-split-vitest-browser.mjs';
  const file = 'apps/learn-render/2.lighting/1.colors/src/__tests__/onerror-gate.browser.test.ts';
  const output = execFileSync(process.execPath, [script, '--file', file, '--dry-run'], {
    encoding: 'utf8',
  });
  assert.match(output, /DIAGNOSTIC/);
  assert.equal(output.split('\n').filter((line) => line.startsWith('group-')).length, 1);
  assert.throws(() =>
    execFileSync(process.execPath, [script, '--file', 'missing.browser.test.ts', '--dry-run'], {
      stdio: 'pipe',
    }),
  );
});

test('View focus retains the complete named owner and rejects partial or invented selectors', () => {
  assert.deepEqual(focusPlan('view', 'game3d').args, [
    'scripts/ci/run-view-integration.mjs',
    '--candidate',
    '--group',
    'game3d',
  ]);
  assert.throws(() => focusPlan('view', 'game3d --skip'), /unknown View integration group/);
  assert.throws(() => focusPlan('view', 'typo'), /unknown View integration group/);
});

test('FXAA sampler contracts are selectable by the shared full-coverage and focused project roster', () => {
  const plan = focusPlan('unit', '@forgeax/hello-fxaa');
  assert.deepEqual(plan.args.slice(0, 4), [
    'scripts/ci/run-vitest-projects.mjs',
    'run',
    '--project',
    '@forgeax/hello-fxaa',
  ]);
  assert.ok(plan.args.includes('--passWithNoTests=false'));
});

test('allocation focus selects bounded Math/ECS owners and preserves raw evidence without a new job', () => {
  for (const selector of ['math', 'ecs', 'all'])
    assert.deepEqual(focusPlan('allocation', selector).args, [
      'scripts/ci/run-foundation-allocations.mjs',
      '--select',
      selector,
      '--output',
      'artifacts/ci-focus/foundation-allocation',
    ]);
  assert.throws(() => focusPlan('allocation', 'render'), /unknown foundation allocation selector/);
  assert.throws(
    () => focusPlan('allocation', 'math --skip'),
    /unknown foundation allocation selector/,
  );
  const workflow = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  assert.match(workflow, /view, allocation\]/);
  assert.match(workflow, /path: artifacts\/ci-focus\/foundation-allocation\//);
  assert.match(workflow, /inputs.kind != 'type' && inputs.kind != 'allocation'/);
});

test('Modeling coverage focus mirrors full-job worker and compiler admission', () => {
  const selector = '@forgeax/engine-modeling:shard-1-of-16';
  const resources = { cpus: 8, memoryBytes: 16_000_000_000 };
  const plan = focusPlan('coverage', selector, { resources });
  assert.ok(plan.args.includes('--maxWorkers=2'));
  assert.ok(plan.args.includes('--coverage'));
  assert.ok(plan.args.includes('--shard=1/16'));
  assert.equal(plan.env.FORGEAX_SHADER_COMPILE_WORKERS, '1');
  assert.equal(plan.env.NODE_DISABLE_COMPILE_CACHE, '1');
  const bounded = focusPlan('coverage', selector, { resources: { ...resources, cpus: 4 } });
  assert.ok(bounded.args.includes('--maxWorkers=1'));
});

test('the complete subdivision and sweep CPU oracle needs no Engine shader preparation', () => {
  const plan = focusPlan('coverage', 'packages/modeling/src/__tests__/subd-crease.unit.test.ts');
  assert.equal(plan.packagesOnly, true);
  assert.ok(plan.args.includes('--coverage'));
  assert.ok(plan.args.includes('packages/modeling/src/__tests__/subd-crease.unit.test.ts'));
  assert.ok(plan.args.includes('packages/modeling/src/__tests__/sweep.unit.test.ts'));
});

test('coverage focus retains the original complete instrumented bootstrap child', () => {
  const selector = 'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts';
  const plan = focusPlan('coverage', selector);
  assert.equal(plan.args[0], 'scripts/ci/run-vitest-projects.mjs');
  assert.equal(plan.gpuLease, false);
  assert.equal(
    focusPlan('coverage', 'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts').gpuLease,
    true,
  );
  assert.ok(plan.args.includes('--coverage'));
  assert.ok(plan.args.includes('--passWithNoTests=false'));
  assert.ok(plan.args.includes('--maxWorkers=1'));
  assert.ok(plan.args.includes('--typecheck.enabled=false'));
  assert.ok(plan.args.includes(selector));
  assert.equal(plan.args.filter((argument) => argument === selector).length, 1);
  assert.ok(plan.args.includes('--coverage.reporter=json'));
  assert.ok(plan.args.includes('--coverage.reportsDirectory=artifacts/ci-focus/coverage'));
  assert.ok(plan.args.includes('--project'));
  assert.ok(plan.args.includes('@forgeax/engine-devkit'));
  assert.throws(() => focusPlan('coverage', '../outside.test.ts'), /coverage/);
  assert.throws(() => focusPlan('coverage', 'unknown-coverage-child'), /coverage/);
  const workflow = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  assert.match(
    workflow,
    /options: \[unit, node, coverage, type, browser, compatibility, performance, dawn, smoke, view, allocation\]/,
  );
  assert.match(workflow, /inputs.kind == 'coverage'/);
});

test('Browser-only producer readiness cannot leak an empty policy into native Focus owners', () => {
  const workflow = parse(readFileSync('.github/workflows/ci-focus.yml', 'utf8'));
  const job = workflow.jobs.diagnostic;
  assert.ok(
    !Object.hasOwn(job.env, 'FORGEAX_DEV_PACK_READINESS'),
    'native publication must retain its normal default instead of an empty Browser policy',
  );
  const step = job.steps.find((candidate) => candidate.id === 'browser-readiness');
  assert.ok(step);
  assert.equal(step.if, "inputs.kind == 'browser' && inputs.browser_profile == 'ci'");
  assert.match(step.run, /echo "FORGEAX_DEV_PACK_READINESS=on-demand" >> "\$GITHUB_ENV"/);
});

test('Node focus executes the complete real Node test file without Vitest discovery', () => {
  const selector = 'scripts/ci/__tests__/rapier-release-payload.test.mjs';
  assert.deepEqual(focusPlan('node', selector), { args: ['--test', selector], packagesOnly: true });
  for (const invalid of [
    '../outside.test.mjs',
    '/tmp/other.test.mjs',
    'scripts/ci/__tests__/missing.test.mjs',
    'scripts/ci/__tests__/rapier-release-payload.test.mjs;echo',
  ])
    assert.throws(() => focusPlan('node', invalid), /Node test file/);
});

test('source-only CI planner Focus skips package preparation and keeps every assertion', () => {
  for (const owner of [
    'browser-work',
    'ci-focus',
    'core-validation',
    'download-artifact-with-retry',
    'prepare-ci-inputs',
    'run-split-vitest-browser',
    'view-diagnostic-workload',
  ]) {
    const selector = `scripts/ci/__tests__/${owner}.test.mjs`;
    const plan = focusPlan('node', selector);
    assert.deepEqual(plan.args, ['--test', selector]);
    assert.equal(focusBuildArgs(plan), undefined);
  }
  assert.deepEqual(
    focusBuildArgs(focusPlan('node', 'scripts/ci/__tests__/rapier-release-payload.test.mjs')),
    ['scripts/build.mjs', '--packages-only'],
  );
});

test('CPU-only Focus preparation validates package receipts without cooking unused Engine shaders', () => {
  const selector = 'scripts/ci/__tests__/build-app-shard.test.mjs';
  assert.equal(focusPlan('node', selector).packagesOnly, true);
  for (const selector of ['ecs-ratios', 'render-ratios'])
    assert.equal(focusPlan('performance', selector).packagesOnly, true);
  assert.notEqual(focusPlan('performance', 'hello-lod-occlusion').packagesOnly, true);
});

test('cold import, publication and Compiler repairs reuse exclusive instrumented package-only owners', () => {
  for (const selector of [
    'packages/gltf/src/__tests__/physical-material-import.integration.test.ts',
    'packages/vite-plugin-pack/src/__tests__/imported-material-publication.integration.test.ts',
    'packages/shader-compiler/src/material/__tests__/gbuffer-publication.integration.test.ts',
  ]) {
    const plan = focusPlan('coverage', selector);
    assert.equal(plan.packagesOnly, true);
    assert.ok(plan.args.includes(selector));
    assert.ok(plan.args.includes('--coverage'));
    assert.ok(plan.args.includes('--maxWorkers=1'));
    assert.equal(plan.env.FORGEAX_SHADER_COMPILE_DIAGNOSTICS, '1');
  }
});

test('pure CPU unit owners do not cook unused Engine profiles', () => {
  for (const selector of [
    '@forgeax/engine-content',
    'packages/content/src/__tests__/content.test.ts',
    '@forgeax/engine-naga',
    '@forgeax/engine-shader-compiler',
    'packages/naga/src/__tests__/compose-import-reachability.unit.test.ts',
    'packages/shader-compiler/src/__tests__/frozen.unit.test.ts',
  ]) {
    const plan = focusPlan('unit', selector);
    assert.equal(plan.packagesOnly, true);
    assert.ok(plan.args.includes(selector));
    assert.ok(plan.args.includes('--passWithNoTests=false'));
  }
  assert.notEqual(focusPlan('unit', '@forgeax/engine-runtime').packagesOnly, true);
});
