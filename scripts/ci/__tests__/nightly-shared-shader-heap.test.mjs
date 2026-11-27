import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('Linux nightly inherits one Core catalog producer and retains the legacy compiler budget', () => {
  const nightly = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'));
  assert.equal(nightly.jobs['linux-ci'].uses, './.github/workflows/ci.yml');
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const commands = ci.jobs['core-build'].steps.flatMap(({ run }) => (run ? [run] : []));
  const producers = commands.filter((command) =>
    command.includes('scripts/ci/build-shared-app-inputs.mjs'),
  );
  assert.equal(producers.length, 1);
  assert.match(producers[0], /--catalog-only/);
  assert.ok(commands.every((command) => !command.includes('scripts/build-shared-inputs.mjs')));
  const producer = readFileSync('scripts/build-shared-inputs.mjs', 'utf8');
  const admission = producer.indexOf(
    'admitShaderSourceBudget({ workerBudget: shaderProducerCompileWorkers });',
  );
  assert.ok(admission > producer.indexOf('reusableSharedShader(root,'));
  assert.ok(admission < producer.indexOf("await import('vite')"));
});
