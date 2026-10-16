import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '../../..');
const schema = JSON.parse(
  readFileSync(resolve(root, 'scripts/ci/evidence/vertex-color-gate-report.schema.json'), 'utf8'),
);
const candidateSourceSha = 'a'.repeat(40);
const gateIds = [
  'hello-learn-render',
  'browser',
  'dawn',
  'parity',
  'metrics',
  'asset-audit',
  'smoke-fleet-0',
  'smoke-fleet-1',
  'smoke-fleet-2',
  'smoke-fleet-3',
  'full-local-gate',
];

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'blocked',
    candidateSourceSha,
    gates: gateIds.map((id) => ({
      id,
      command: `literal ${id}`,
      exitStatus: 1,
      candidateSourceSha,
      status: 'failed',
      artifactRefs: [`report/${id}.json`],
      detail: 'The gate ran and reported a failure.',
    })),
    step7Handoff: {
      mainAncestry: 'pending',
      postMergeCi: 'pending',
      harnessPersistence: 'pending',
      worktreeCleanup: 'pending',
      ac14: 'blocked',
    },
    ...overrides,
  };
}

function validate(value) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const check = ajv.compile(schema);
  return { valid: check(value), errors: check.errors ?? [] };
}

test('accepts a complete candidate gate report with every required roster item', () => {
  assert.equal(validate(report()).valid, true);
});

test('rejects a gate without a literal command, exit status, source SHA, or artifact reference', () => {
  for (const field of ['command', 'exitStatus', 'candidateSourceSha', 'artifactRefs']) {
    const value = report();
    delete value.gates[0][field];
    assert.equal(validate(value).valid, false, `missing ${field} must fail`);
  }
});

test('rejects a green gate without a candidate SHA or with a non-zero exit status', () => {
  const noSha = report();
  noSha.gates[0].status = 'passed';
  noSha.gates[0].exitStatus = 0;
  delete noSha.gates[0].candidateSourceSha;
  assert.equal(validate(noSha).valid, false);

  const nonZero = report();
  nonZero.gates[0].status = 'passed';
  nonZero.gates[0].exitStatus = 1;
  assert.equal(validate(nonZero).valid, false);
});

test('rejects a report when any roster-derived gate is missing', () => {
  const value = report();
  value.gates = value.gates.filter((gate) => gate.id !== 'dawn');
  assert.equal(validate(value).valid, false);
});

test('allows blocked and pending diagnostics without pretending they are green', () => {
  const value = report();
  value.gates[0] = {
    id: 'hello-learn-render',
    command: 'literal hello-learn-render',
    exitStatus: null,
    candidateSourceSha,
    status: 'blocked',
    artifactRefs: ['report/hello-learn-render.blocked.json'],
    detail: 'Runner unavailable.',
  };
  value.status = 'blocked';
  assert.equal(validate(value).valid, true);
});
