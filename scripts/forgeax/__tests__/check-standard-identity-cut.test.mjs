import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSemanticHits } from '../check-standard-identity-cut.mjs';

test('semantic census ignores unrelated lighting and fallback vocabulary', () => {
  const hits = findSemanticHits(
    'scripts/example.mjs',
    "const fallback = 'network'; const lighting = 'ui';\n",
  );
  assert.deepEqual(hits, []);
});

test('semantic census reports legacy identity and Standard-bound fields', () => {
  const hits = findSemanticHits(
    'apps/example/main.ts',
    "const profile = { StandardProfile, lighting: 'direct' };\nconst id = 'forgeax::hdrp';\n",
  );
  assert.deepEqual(
    hits.map(({ line, token }) => [line, token]),
    [
      [1, 'lighting'],
      [2, 'forgeax::hdrp'],
    ],
  );
});

test('negative rejection assertions do not become migration hits', () => {
  const hits = findSemanticHits(
    'scripts/example.test.mjs',
    "assert.doesNotMatch(value, /forgeax::urp/);\nexpect(value).not.toContain('forgeax::hdrp');\n",
  );
  assert.deepEqual(hits, []);
});

test('census emits stable context and detects direct mode only with Standard context', () => {
  const hits = findSemanticHits(
    'apps/example/main.ts',
    "const StandardProfile = { renderPath: 'forward' };\nconst mode = 'direct';\n",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].token, 'direct');
  assert.equal(hits[0].context, "const mode = 'direct';");
});

test('semantic census reports retired Standard error tokens', () => {
  const hits = findSemanticHits(
    'packages/render/src/errors/render.ts',
    'throw new HdrpLightBudgetExceededError(3, 1);\nconst code = "hdrp-index-list-overflow";\n',
  );
  assert.deepEqual(
    hits.map(({ line, token }) => [line, token]),
    [
      [1, 'HdrpLightBudgetExceededError'],
      [2, 'hdrp-index-list-overflow'],
    ],
  );
});

test('negative assertions for retired error tokens remain migration-safe', () => {
  const hits = findSemanticHits(
    'packages/render/src/__tests__/errors.unit.test.ts',
    "expect(value).not.toContain('hdrp-light-budget-exceeded');\nassert.doesNotMatch(value, /HdrpIndexListOverflowError/);\n",
  );
  assert.deepEqual(hits, []);
});

test('semantic census reports the retired cluster owner flag and install error', () => {
  const hits = findSemanticHits(
    'packages/render/src/pipeline/standard-pipeline.ts',
    'const isHdrpActive = true;\nthrow new HdrpInstallError(1, 2, 3);\n',
  );
  assert.deepEqual(
    hits.map(({ line, token }) => [line, token]),
    [
      [1, 'isHdrpActive'],
      [2, 'HdrpInstallError'],
    ],
  );
});

test('standard identity cut exposes a stable report shape for baseline gates', () => {
  const hits = findSemanticHits('packages/types/src/index.ts', 'const value = 1;\n');
  assert.deepEqual(hits, []);
  assert.deepEqual(Object.keys({ schemaVersion: 2, status: 'pass', channels: [] }).sort(), [
    'channels',
    'schemaVersion',
    'status',
  ]);
});
