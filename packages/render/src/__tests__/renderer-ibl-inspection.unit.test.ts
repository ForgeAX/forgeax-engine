import { describe, expect, it } from 'vitest';
import { projectIblBindingInspection } from '../assembly/renderer-inspection';
import type { IblBindingInspection } from '../mesh-material-bindings';

function receipt(
  status: IblBindingInspection['status'],
  drawFrameId?: number,
): IblBindingInspection {
  return {
    status,
    frameId: 7,
    deviceGeneration: 2,
    active: 'fallback',
    cache: {
      identity: 11,
      generation: 2,
      prefilterMipCount: 1,
      prefilterViewMipCount: 1,
    },
    sampler: {
      expected: {
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      },
      identities: [12, 12, 12],
    },
    resources: {
      irradiance: { viewIdentity: 13, samplerIdentity: 12, deviceGeneration: 2 },
      prefilter: { viewIdentity: 14, samplerIdentity: 12, deviceGeneration: 2 },
      brdfLut: { viewIdentity: 15, samplerIdentity: 12, deviceGeneration: 2 },
      intensityBufferIdentity: 16,
    },
    ...(drawFrameId === undefined
      ? {}
      : {
          pipeline: {
            pipelineIdentity: 17,
            effectiveMaterialLayoutIdentity: undefined,
            materialBglIdentity: 18,
            bindGroupIdentity: 19,
            drawFrameId,
          },
        }),
    errors: status === 'binding-chain-mismatch' ? ['material-ibl-resource-identity-mismatch'] : [],
  };
}

describe('renderer IBL inspection projection', () => {
  it('keeps preparation-only baselines private', () => {
    expect(projectIblBindingInspection(receipt('binding-chain-consistent'))).toBeUndefined();
  });

  it('publishes recorded Standard draw receipts with matching frame proof', () => {
    const consistent = receipt('binding-chain-consistent', 7);
    const mismatch = receipt('binding-chain-mismatch', 7);

    expect(projectIblBindingInspection(consistent)).toBe(consistent);
    expect(projectIblBindingInspection(mismatch)).toBe(mismatch);
    expect(projectIblBindingInspection(mismatch)?.status).toBe('binding-chain-mismatch');
  });

  it('keeps a receipt private when its pipeline belongs to another frame', () => {
    expect(projectIblBindingInspection(receipt('binding-chain-consistent', 6))).toBeUndefined();
  });
});
