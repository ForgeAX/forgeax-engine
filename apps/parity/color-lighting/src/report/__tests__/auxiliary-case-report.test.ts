import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  createAuxiliaryCaptureCaseReport,
  createIblCaseReport,
  type IblAuxiliaryProducer,
} from '../auxiliary-case-report';

const schema = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../schemas/case-report.schema.json'),
  'utf8',
)) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const provenance = {
  implementation: 'forgeax',
  version: 'workspace',
  renderer: 'webgpu',
  adapterId: 'forgeax-webgpu',
};
const threeProvenance = {
  implementation: 'three',
  version: 'r184',
  renderer: 'webgpu',
  adapterId: 'three-r184-webgpu',
};
const captures = { linear: [], final: [0, 1, 2, 255], hash: 'a'.repeat(64) };

function iblProducer(): IblAuxiliaryProducer {
  return {
    capability: {
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      rgba16floatRenderable: true,
      outputFormat: 'rgba16float',
      fallbackArtifact: null,
      expectedImpact: 'HDR IBL producer is available',
      hint: 'retain the raw evidence',
      lastKnownGood: 'ibl-constant-environment@rgba16float',
    },
    evidence: {
      status: 'ready',
      attachmentName: 'ibl.constant-environment',
      layer: 0,
      bytes: [1, 2, 3, 4],
      format: 'rgba16float',
      size: { width: 1, height: 1 },
      rawHash: 'b'.repeat(8),
      frameId: 0,
      lifetime: { frameId: 0, state: 'active' },
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl-constant-environment@rgba16float',
    },
    finalDisplay: { status: 'ready', bytes: [1, 2, 3, 4], format: 'rgba8unorm', rawHash: 'c'.repeat(8) },
    analytic: { environment: 0.72, payload: 0.72 * Math.PI, reconstructed: 0.72, maxError: 0 },
  };
}

describe('auxiliary CaseReport authority', () => {
  it('persists a schema-valid transparent browser/Dawn report', () => {
    const report = createAuxiliaryCaptureCaseReport({
      caseId: 'transparent-ldr-urp',
      required: true,
      invocationId: 'test-invocation',
      sourceHash: 'd'.repeat(64),
      semanticHash: 'e'.repeat(64),
      forgeax: { provenance, captures },
      three: { provenance: threeProvenance, captures },
      metrics: { analyticMax: 0, roiMax: 0, differingBytes: 0 },
      primaryStatus: 'pass',
      dawn: {
        status: 'pass',
        observations: [{
          caseId: 'transparent-ldr-urp',
          pipelineId: 'forgeax::standard',
          backendId: 'dawn',
          frameId: 0,
          bytes: [1, 2, 3, 4],
          rawHash: 'f'.repeat(8),
        }],
      },
    });
    expect(report.status).toBe('complete');
    expect(validate(report)).toBe(true);
  });

  it('persists both IBL producer capabilities without synthetic pass', () => {
    const report = createIblCaseReport({
      caseId: 'ibl-constant-environment',
      required: true,
      invocationId: 'test-invocation',
      browser: iblProducer(),
      dawn: iblProducer(),
    });
    expect(report.status).toBe('complete');
    expect(validate(report)).toBe(true);
    expect(createIblCaseReport({
      caseId: 'ibl-constant-environment',
      required: true,
      invocationId: 'test-invocation',
      browser: iblProducer(),
      dawn: { ...iblProducer(), capability: { ...iblProducer().capability, verdict: 'failed' } },
    }).status).toBe('failed');
  });
});
