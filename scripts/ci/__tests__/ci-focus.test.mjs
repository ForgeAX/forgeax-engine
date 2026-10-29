import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkWorkflowText } from '../check-runner-pool-labels.mjs';
import { focusPlan } from '../run-ci-focus.mjs';
import { selectDawnGroups } from '../run-dawn-gate.mjs';

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
