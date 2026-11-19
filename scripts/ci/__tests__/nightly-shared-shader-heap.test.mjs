import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('Linux nightly orchestration retains its cap and admits a runner-budgeted cold producer', () => {
  const nightly = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'));
  assert.equal(nightly.jobs['linux-ci'].uses, './.github/workflows/ci.yml');
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const profiles = ci.jobs['core-build'].steps.filter((step) =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell array expansion
    step.run?.includes('node scripts/build-shared-inputs.mjs "${SHADER_ARGS[@]}" --out'),
  );
  assert.equal(profiles.length, 2, 'Core owns both source-bound profile producers');
  for (const step of profiles) {
    assert.equal(step.env.NODE_OPTIONS, '--max-old-space-size=4096');
  }
  const producer = readFileSync('scripts/build-shared-inputs.mjs', 'utf8');
  const admission = producer.indexOf(
    'admitShaderSourceBudget({ workerBudget: shaderProducerCompileWorkers });',
  );
  assert.ok(admission > producer.indexOf('reusableSharedShader(root,'));
  assert.ok(admission < producer.indexOf("await import('vite')"));
});
