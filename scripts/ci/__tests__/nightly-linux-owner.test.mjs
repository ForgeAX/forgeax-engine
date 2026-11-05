import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const nightly = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'));
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));

test('Nightly runs the same-commit full Linux CI instead of serial unsharded coverage', () => {
  const owner = nightly.jobs['linux-ci'];
  assert.equal(owner?.uses, './.github/workflows/ci.yml');
  assert.deepEqual(owner.with, { nightly_full_profile: true });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  assert.deepEqual(owner.secrets, { GHA: '${{ secrets.GHA }}' });
  assert.deepEqual(owner.permissions, {
    actions: 'write',
    contents: 'write',
    'pull-requests': 'write',
  });
  assert.equal(ci.on.workflow_call.secrets.GHA.required, true);
  assert.equal(ci.on.workflow_call.inputs.comparison_base.default, '');
  assert.equal(ci.on.workflow_call.inputs.run_m4_live_evidence.default, false);
  assert.equal(ci.on.workflow_call.inputs.nightly_full_profile.default, false);
  assert.match(ci.jobs['post-merge-gate'].if, /github.event_name == 'push'/);
  assert.notEqual(nightly.concurrency.group, ci.concurrency.group);
  assert.deepEqual(ci.jobs['coverage-pnpm-shard'].strategy.matrix.shard, [0, 1, 2, 3]);
  assert.ok(ci.jobs['coverage-pnpm'].needs.includes('coverage-pnpm-shard'));
  assert.deepEqual(ci.jobs['vitest-dawn'].strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(ci.jobs['vitest-dawn'].strategy['max-parallel'], 4);
  for (const id of ['primary-pnpm', 'vitest-browser', 'smoke-fleet', 'portability-bun']) {
    assert.ok(ci.jobs[id], `Linux ${id} acceptance remains owned by CI`);
  }
});

test('Nightly retains full Dawn frames and browser-owned unit workloads', () => {
  const dawn = ci.jobs['vitest-dawn'].steps.find((step) =>
    step.run?.includes('node scripts/ci/run-dawn-gate.mjs --shard'),
  );
  const coverage = ci.jobs['coverage-pnpm-shard'].steps.find((step) =>
    step.run?.includes('node scripts/ci/run-split-vitest-coverage.mjs'),
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const profile = "${{ inputs.nightly_full_profile && '0' || '1' }}";
  assert.equal(dawn.env.FORGEAX_DAWN_LIGHTWEIGHT, profile);
  assert.equal(coverage.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT, profile);
});

test('Nightly retains both hosted native probes and the Metal boundary', () => {
  const hosted = nightly.jobs['smoke-browser-dawn'];
  assert.deepEqual(
    hosted.strategy.matrix.include.map((entry) => entry.name),
    ['macos-latest', 'windows-latest'],
  );
  assert.deepEqual(
    hosted.strategy.matrix.include.map((entry) => entry.timeout),
    [25, 90],
  );
  assert.ok(hosted.strategy['max-parallel'] <= 4);
  const probe = hosted.steps.find(
    (step) => step.name === 'Vitest Dawn platform probe (hosted macOS/Windows)',
  );
  assert.match(probe.run, /--passWithNoTests=false --no-file-parallelism --maxWorkers=1/);
  assert.equal((probe.run.match(/\.dawn\.test\.ts/g) ?? []).length, 4);
  assert.equal(nightly.jobs['native-ray-query-metal-build']['runs-on'], 'macos-15');
  assert.equal(nightly.jobs['native-ray-query-metal-build']['timeout-minutes'], 30);
});

test('Nightly issue closure requires Linux, both hosted probes and Metal to pass', () => {
  const success = nightly.jobs['notify-success'];
  assert.deepEqual(success.needs, [
    'linux-ci',
    'smoke-browser-dawn',
    'native-ray-query-metal-build',
  ]);
  for (const id of success.needs) {
    assert.ok(success.if.includes(`needs.${id}.result == 'success'`));
  }
  assert.match(success.if, /github.ref == 'refs\/heads\/main'/);
});

test('Nightly reports timeout cancellation as well as failure', () => {
  const failure = nightly.jobs['notify-failure'];
  assert.deepEqual(failure.needs, nightly.jobs['notify-success'].needs);
  assert.match(failure.if, /always\(\)/);
  assert.match(failure.if, /contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(failure.if, /contains\(needs\.\*\.result, 'cancelled'\)/);
});
