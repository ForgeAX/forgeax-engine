import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { AttachmentReport } from '../types';
import { deriveAttachmentReportStatus } from '../../report/status';

const schemaPath = resolve(import.meta.dirname, '../../../schemas/case-report.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const attachment: AttachmentReport = {
  linearHdr: {
    kind: 'linearHdr',
    status: 'ready',
    bytes: new Uint8Array([1, 2]),
    format: 'rgba16float',
    size: { width: 1, height: 1 },
    rawHash: 'linear',
    frameId: 1,
    pipelineId: 'forgeax::standard',
    backendId: 'dawn',
  },
  finalDisplay: {
    kind: 'finalDisplay',
    status: 'ready',
    bytes: new Uint8Array([3, 4]),
    format: 'rgba8unorm',
    size: { width: 1, height: 1 },
    rawHash: 'display',
    frameId: 1,
    pipelineId: 'forgeax::standard',
    backendId: 'dawn',
  },
  attachmentReadbackStatus: 'complete',
  capabilityStatus: 'supported',
  executionStatus: 'complete',
  verdict: 'passed',
  missingPipelineIds: [],
};

describe('attachment report contract', () => {
  it('derives complete only from complete evidence and execution', () => {
    expect(deriveAttachmentReportStatus(attachment)).toBe('complete');
    expect(deriveAttachmentReportStatus({ ...attachment, missingPipelineIds: ['forgeax::standard'] })).toBe('failed');
  });

  it('requires attachment evidence fields in the report schema', () => {
    const producer = (pipelineId: 'forgeax::standard', runtimeId: 'browser' | 'dawn') => ({
      pipelineId,
      runtimeId,
      backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
      frameId: 1,
      copySrc: true,
      lifetime: 'active',
      provenance: {
        implementation: 'forgeax',
        version: 'workspace',
        renderer: runtimeId === 'browser' ? 'webgpu' : 'wgpu',
        adapterId: `${runtimeId}-standard`,
      },
      semantic: 'linear-hdr',
      source: 'live-producer',
      sourceHash: 'a'.repeat(64),
      semanticHash: 'b'.repeat(64),
      linearHdr: {
        kind: 'linearHdr',
        status: 'ready',
        bytes: [1, 2],
        format: 'rgba16float',
        size: { width: 1, height: 1 },
        rawHash: 'c'.repeat(64),
        frameId: 1,
        pipelineId: 'forgeax::standard' as const,
        backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
      },
      finalDisplay: {
        kind: 'finalDisplay',
        status: 'ready',
        bytes: [3, 4],
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
        rawHash: 'd'.repeat(64),
        frameId: 1,
        pipelineId: 'forgeax::standard' as const,
        backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
      },
    });
    const valid = {
      schemaVersion: 2,
      caseId: 'm4-report',
      required: true,
      invocationId: 'm4-invocation',
      sceneCaseIdentity: { sourceHash: 'a'.repeat(64), semanticHash: 'b'.repeat(64) },
      attachmentEvidence: {
        producers: [producer('forgeax::standard', 'browser'), producer('forgeax::standard', 'dawn')],
        attachmentReadbackStatus: 'complete',
        capabilityStatus: 'supported',
        executionStatus: 'complete',
        verdict: 'passed',
        capturedPipelineIds: ['standard'],
        missingPipelineIds: [],
      },
      verdict: 'passed',
      status: 'complete',
    };
    expect(validateSchema(valid)).toBe(true);
    expect(validateSchema({ ...valid, attachmentEvidence: undefined })).toBe(false);
  });
});
