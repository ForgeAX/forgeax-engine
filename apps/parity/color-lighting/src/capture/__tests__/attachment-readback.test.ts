import { describe, expect, it } from 'vitest';
import {
  validateAttachmentEvidence,
  type ObservationCapture,
} from '../attachment-readback';

const linearHdr: ObservationCapture = {
  kind: 'linearHdr',
  status: 'ready',
  bytes: new Uint8Array([1, 2, 3, 4]),
  format: 'rgba16float',
  size: { width: 1, height: 1 },
  rawHash: 'linear-hash',
  frameId: 12,
  pipelineId: 'forgeax::standard',
  backendId: 'webgpu',
};

const finalDisplay: ObservationCapture = {
  kind: 'finalDisplay',
  status: 'ready',
  bytes: new Uint8Array([5, 6, 7, 8]),
  format: 'rgba8unorm',
  size: { width: 1, height: 1 },
  rawHash: 'display-hash',
  frameId: 12,
  pipelineId: 'forgeax::standard',
  backendId: 'webgpu',
};

describe('linear HDR attachment evidence', () => {
  it('accepts independent structured linear and final captures', () => {
    const result = validateAttachmentEvidence({ linearHdr, finalDisplay });
    expect(result.ok).toBe(true);
  });

  const invalidCases: Array<[string, ObservationCapture]> = [
    ['missing linear bytes', { ...linearHdr, status: 'failed' }],
    ['same canvas', { ...finalDisplay, kind: 'linearHdr' }],
    ['same raw hash', { ...finalDisplay, rawHash: 'linear-hash' }],
  ];

  it.each(invalidCases)('fails closed for %s', (_label, display) => {
    const result = validateAttachmentEvidence({ linearHdr, finalDisplay: display });
    expect(result.ok).toBe(false);
  });
});
