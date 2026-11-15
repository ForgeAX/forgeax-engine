import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('Linux nightly orchestration retains its cap and admits a runner-budgeted cold producer', () => {
  const nightly = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'));
  assert.equal(nightly.jobs['linux-ci'].uses, './.github/workflows/ci.yml');
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  for (const owner of ['core-build', 'shared-app-inputs']) {
    const step = ci.jobs[owner].steps.find((candidate) =>
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell array expansion
      candidate.run?.includes('node scripts/build-shared-inputs.mjs "${SHADER_ARGS[@]}" --out'),
    );
    assert.ok(step, `${owner} must retain the source-bound shader producer`);
    assert.equal(step.env.NODE_OPTIONS, '--max-old-space-size=4096');
  }
  const producer = readFileSync('scripts/build-shared-inputs.mjs', 'utf8');
  assert.ok(
    producer.indexOf('admitShaderSourceBudget();') > producer.indexOf('reusableSharedShader(root,'),
  );
  assert.ok(
    producer.indexOf('admitShaderSourceBudget();') < producer.indexOf("await import('vite')"),
  );
});
