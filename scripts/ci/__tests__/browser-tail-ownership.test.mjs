import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('the existing fallback worker shares its server with complete Mesh and FXAA tails', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const job = workflow.jobs['webkit-fallback'];
  const names = [
    'Mesh interchange Catalog and RHI replay browser gate',
    'Preserve mesh interchange evidence',
    'Hello FXAA dark-gradient Browser WebGPU smoke (direct)',
    'Hello FXAA dark-gradient Browser WebGPU smoke (clustered)',
  ];
  for (const name of names) {
    const owners = Object.entries(workflow.jobs).filter(([_id, candidate]) =>
      candidate.steps?.some((step) => step.name === name),
    );
    assert.deepEqual(
      owners.map(([id]) => id),
      ['webkit-fallback'],
      name,
    );
    assert.doesNotMatch(job.steps.find((step) => step.name === name).if, /matrix/);
  }
  assert.equal(
    job.steps.find((step) => step.name === 'Stop dev server').if,
    "steps.ci-repair.outputs.reused != 'true' && (always())",
  );
  const aggregate = workflow.jobs['vitest-browser'];
  assert.ok(aggregate.needs.includes('shared-inputs-browser'));
  assert.match(aggregate.steps[0].run, /needs.shared-inputs-browser.result/);
  assert.match(
    workflow.jobs['vitest-browser-shard'].strategy.matrix.shard,
    /core-build.outputs.browser_shards/,
  );
  assert.ok(aggregate.needs.includes('webkit-fallback'));
  assert.match(aggregate.steps[0].run, /needs.webkit-fallback.result/);
  assert.equal(
    job.steps.filter((step) => step.name === 'Start hello-fxaa dev server (owned background)')
      .length,
    1,
  );
  assert.match(job.steps.find((step) => step.name === 'Stop dev server').run, /hello-fxaa.json/);
  assert.equal(job.strategy, undefined);
});

test('the required fallback worker runs both WebGPU tails after its servers stop', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const fallback = workflow.jobs['webkit-fallback'];
  const discovery = fallback.steps.findIndex((step) => step.name === 'Stop dev server');
  const tails = [
    ['MSAA paired P2 proof (real OFF/ON captures)', /smoke:browser:pair/],
    ['Multiplayer snake browser E2E (M16 reconnect/resync)', /multiplayer-snake e2e:browser/],
  ];
  assert.ok(discovery >= 0);
  for (const [name, command] of tails) {
    assert.deepEqual(
      Object.keys(workflow.jobs).filter((key) =>
        workflow.jobs[key].steps?.some((step) => step.name === name),
      ),
      ['webkit-fallback'],
    );
    const step = fallback.steps.find((entry) => entry.name === name);
    assert.ok(fallback.steps.indexOf(step) > discovery);
    assert.equal(step.if, "steps.ci-repair.outputs.reused != 'true'");
    assert.equal(step.env.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.match(step.run, command);
  }
  assert.equal(fallback['timeout-minutes'], 30);
});

test('the existing View workers own the Runtime Pack and workspace tails and Browser observes it', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const view = workflow.jobs['view-integration-shards'];
  const name = 'Runtime Pack Worker dev/build JS/TS browser gate';
  const owners = Object.entries(workflow.jobs).filter(([_id, job]) =>
    job.steps?.some((step) => step.name === name),
  );
  assert.deepEqual(
    owners.map(([id]) => id),
    ['view-integration-shards'],
  );
  const runtime = view.steps.find((step) => step.name === name);
  assert.equal(
    runtime.if,
    "steps.ci-repair.outputs.reused != 'true' && needs.post-merge-gate.outputs.skip_view != 'true' && (matrix.shard != '1')",
  );
  assert.match(
    runtime.env.FORGEAX_DEVKIT_RUNTIME_BROWSER_PARTITION,
    /'workspace' \|\| matrix.shard == '3' && 'vase' \|\| 'runtime'/,
  );
  assert.equal(runtime.env.FORGEAX_BROWSER_FIXED_SMOKE, '1');
  assert.equal(runtime.env.FORGEAX_BROWSER_CI_VIEWPORT_WIDTH, '320');
  assert.equal(runtime.env.FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT, '180');
  assert.equal(runtime.env.FORGEAX_BROWSER_CI_SETTLE_FRAMES, '2');
  assert.equal(runtime.env.FORGEAX_DEV_PACK_READINESS, 'on-demand');
  assert.equal(runtime.env.NODE_OPTIONS, '--max-old-space-size=4096');
  const preparation = view.steps.findIndex(
    (step) => step.name === 'Prepare verified paired consumer inputs',
  );
  const paired = view.steps.findIndex((step) => step.id === 'paired_view');
  assert.ok(preparation >= 0 && preparation < paired && paired < view.steps.indexOf(runtime));
  assert.equal(view.steps[preparation].with.consumer, 'view-integration-shards');
  assert.match(runtime.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST, /shared-app-inputs\/manifest.json/);
  const aggregate = workflow.jobs['vitest-browser'];
  assert.ok(aggregate.needs.includes('view-integration'));
  assert.match(aggregate.steps[0].run, /needs.view-integration.result/);
  assert.equal(view['timeout-minutes'], 30);
});

test('the same-tree View startup builds the pinned command bundle before launching the browser', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const { steps } = workflow.jobs['view-integration-shards'];
  const preparation = steps.findIndex(
    (step) => step.name === 'Prepare verified paired consumer inputs',
  );
  const build = steps.findIndex(
    (step) => step.name === 'Build the pinned View for the startup check',
  );
  const startup = steps.findIndex(
    (step) => step.name === 'Replay the View startup boundary on main',
  );
  assert.ok(preparation >= 0 && preparation < build && build < startup);
  assert.equal(steps[build].if, steps[startup].if);
  assert.match(steps[build].if, /needs\.post-merge-gate\.outputs\.skip_view == 'true'/);
  assert.equal(steps[build].run, 'pnpm --filter @forgeax/view build');
  assert.equal(steps[startup]['working-directory'], 'tools/view');
  assert.match(steps[startup].run, /xvfb-run .*verify-startup-boundaries\.mjs/);
});
