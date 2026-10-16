import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { collectMissingPipelineIds } from '../color-lighting-pipeline-coverage.mjs';

const root = join(import.meta.dirname, '../..', '..');
const schema = JSON.parse(
  await readFile(join(root, 'apps/parity/color-lighting/schemas/case-report.schema.json'), 'utf8'),
);
const validateReport = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const validReport = {
  schemaVersion: 2,
  status: 'complete',
  verdict: 'passed',
  attachmentEvidence: { capturedPipelineIds: ['standard'] },
};

test('uses the schema-valid cross-runtime report pipeline projection as the SSOT', () => {
  assert.deepEqual(
    collectMissingPipelineIds({
      reports: [validReport],
      requiredPipelineIds: ['standard'],
      validateReport: () => true,
    }),
    [],
  );
});

test('keeps missing coverage fail-closed for invalid or incomplete reports', () => {
  const invalid = { ...validReport, schemaVersion: 1 };
  const incomplete = { ...validReport, status: 'partial' };
  assert.deepEqual(
    collectMissingPipelineIds({
      reports: [invalid, incomplete],
      requiredPipelineIds: ['standard'],
      validateReport: () => true,
    }),
    ['standard'],
  );
});

test('rejects a report whose captured pipeline projection is not schema-valid', () => {
  const invalid = {
    ...validReport,
    attachmentEvidence: { capturedPipelineIds: ['urp'] },
  };
  assert.deepEqual(
    collectMissingPipelineIds({
      reports: [invalid],
      requiredPipelineIds: ['standard'],
      validateReport,
    }),
    ['standard'],
  );
});
