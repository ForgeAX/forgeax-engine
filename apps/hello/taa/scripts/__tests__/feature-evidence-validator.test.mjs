import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateFeatureEvidence } from '../validate-feature-evidence.mjs';

const fixturePath = fileURLToPath(new URL('../__fixtures__/artifact-9833689985.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function expectBlocked(report, expectedCodes) {
  assert.notEqual(report.status, 'pass');
  assert.ok(Array.isArray(report.errors));
  for (const code of expectedCodes) assert.ok(report.errors.some((error) => error.code === code), `${code} missing`);
}

test('rejects the CI artifact 9833689985 producer-level falsifier', () => {
  const report = validateFeatureEvidence(fixture);
  expectBlocked(report, [
    'auto-workload-missing',
    'positive-lut-workload-missing',
    'domain-capture-not-distinct',
    'timing-source-invalid',
    'producer-pass-not-derived',
  ]);
});

test('missing auto workload, positive LUT, and provenance are fail-closed', () => {
  const report = validateFeatureEvidence({
    ...fixture,
    status: 'blocked',
    exposure: undefined,
    lut: undefined,
    source: undefined,
    build: undefined,
    frameIdentity: undefined,
    stages: undefined,
  });
  expectBlocked(report, ['auto-workload-missing', 'positive-lut-workload-missing', 'provenance-missing', 'domain-observation-missing']);
});

test('duplicate domain captures and TAA motion blur timing cannot become feature pass', () => {
  const duplicate = structuredClone(fixture);
  duplicate.exposure = { mode: 'auto', ev: { first: -1, last: 1, generation: 2 } };
  duplicate.lut = { generation: 4, strength: 1, sourceKey: 'lut://positive' };
  const report = validateFeatureEvidence(duplicate);
  expectBlocked(report, ['domain-capture-not-distinct', 'timing-source-invalid']);
});

test('schema has no pass-valued defaults for evidence gates', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../evidence/feature-evidence.schema.json', import.meta.url)), 'utf8'));
  assert.deepEqual(schema.properties.status.enum, ['observation', 'blocked', 'failed']);
  assert.equal(schema.properties.status.default, undefined);
  assert.equal(schema.properties.exposure.default, undefined);
  assert.equal(schema.properties.lut.default, undefined);
  assert.equal(schema.properties.visualEvidence.default, undefined);
  assert.equal(schema.properties.stages.default, undefined);
  assert.equal(schema.properties.source.default, undefined);
  assert.equal(schema.properties.build.default, undefined);
});
