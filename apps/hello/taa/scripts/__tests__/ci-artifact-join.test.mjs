import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '../../../../..');
const schemaPath = resolve(root, 'apps/hello/taa/evidence/feature-evidence.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, unevaluated: true });
  ajv.addSchema(schema);
  return ajv.getSchema(`${schema.$id}#/$defs/ciArtifactJoin`);
}

test('exposes a separate strict CI join definition beside raw producer evidence', () => {
  const join = schema.$defs?.ciArtifactJoin;
  assert.ok(join);
  assert.deepEqual(join.required, ['schemaVersion', 'featureId', 'identity', 'gates', 'status']);
  assert.deepEqual(join.properties.schemaVersion, { const: 'forgeax-auto-exposure-ci-join/1' });
  assert.deepEqual(join.properties.status.enum, ['pass', 'blocked', 'failed']);
  assert.deepEqual(join.properties.gates.$ref, '#/$defs/ciArtifactJoinGates');
  assert.equal(Object.hasOwn(join.properties, 'default'), false);
});

test('the CI join schema has no pass-valued defaults and keeps every gate mandatory', () => {
  const join = schema.$defs.ciArtifactJoin;
  const gates = schema.$defs.ciArtifactJoinGates;
  assert.deepEqual(gates.required, [
    'browser',
    'dawn',
    'featureValidator',
    'qualifiedTiming',
    'threeAc27',
    'canonicalRoster',
    'sharedProbe',
  ]);
  const serialized = JSON.stringify(join);
  assert.equal(serialized.includes('"default"'), false);
  assert.equal(schema.properties.status.default, undefined);
});

test('an incomplete join is rejected by the schema instead of being inferred as pass', () => {
  const validate = schemaValidator();
  assert.equal(typeof validate, 'function');
  assert.equal(validate({ schemaVersion: 'forgeax-auto-exposure-ci-join/1', featureId: 'feat-20260827-auto-exposure-hdr-color-grading', status: 'pass' }), false);
  assert.ok(validate.errors?.some((error) => error.keyword === 'required'));
});
