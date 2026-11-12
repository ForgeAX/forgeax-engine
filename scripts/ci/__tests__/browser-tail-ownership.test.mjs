import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('FXAA keeps its complete server and both pixel journeys off the full nightly shard-zero tail', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const job = Object.values(workflow.jobs).find((job) =>
    job.steps?.some(
      (step) => step.name === 'Hello FXAA dark-gradient Browser WebGPU smoke (direct)',
    ),
  );
  const names = [
    'Start hello-fxaa dev server (owned background)',
    'Hello FXAA dark-gradient Browser WebGPU smoke (direct)',
    'Hello FXAA dark-gradient Browser WebGPU smoke (clustered)',
    'Stop hello-fxaa dev server',
  ];
  for (const name of names) {
    const steps = job.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1);
    assert.match(steps[0].if, /matrix\.shard == 2/);
  }
  assert.equal(job.strategy.matrix.shard.length, 4);
});
