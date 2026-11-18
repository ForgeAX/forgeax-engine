import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('software callback cadence does not provision a second browser or claim Engine FPS', () => {
  const manifest = JSON.parse(readFileSync('apps/hello/triangle/package.json', 'utf8'));
  assert.equal(manifest.forgeax.metrics.fps.enabled, false);
  assert.match(manifest.forgeax.metrics.fps.reason, /completed Engine frames/);
  assert.equal(manifest.forgeax.metrics.gate.enabled, true);
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  for (const name of ['metrics-validate-browser', 'metrics-validate-runtime']) {
    const steps = workflow.jobs[name].steps;
    assert.ok(
      !steps.some((step) => /playwright install chromium|metrics:run-fps/.test(step.run ?? '')),
    );
  }
  assert.ok(
    workflow.jobs['metrics-validate-browser'].steps.some(
      (step) => step.uses === './.github/actions/install-playwright-chrome-beta',
    ),
  );
  assert.ok(
    workflow.jobs['metrics-validate-runtime'].steps.some(
      (step) => step.name === 'Run hello-lod-occlusion GPU frame samples producer',
    ),
  );
});
