import { describe, expect, it } from 'vitest';
import { inspectVolumetricFog } from '../volume/inspection';

const recovery = {
  guid: 'density-guid',
  generation: 4,
  deviceEpoch: 2,
  status: 'accepted' as const,
  lkgGeneration: 4,
};

describe('volumetric fog inspection', () => {
  it('distinguishes authored off from an accepted resource', () => {
    expect(inspectVolumetricFog({ authored: false, capability: 'available' })).toMatchObject({
      status: 'off',
      resourceStage: 'none',
      passCount: 0,
      sampleCount: 0,
      memoryBytes: 0,
    });
    expect(
      inspectVolumetricFog({
        authored: true,
        capability: 'available',
        recovery,
        acceptedDigest: 'digest-4',
        passCount: 4,
        sampleCount: 2,
        memoryBytes: 64,
      }),
    ).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      guid: 'density-guid',
      generation: 4,
      digest: 'digest-4',
      deviceEpoch: 2,
      passCount: 4,
      sampleCount: 2,
      memoryBytes: 64,
    });
  });

  it('exposes candidate and LKG identity after a failed candidate', () => {
    const result = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      recovery: {
        ...recovery,
        status: 'degraded',
        candidateGeneration: 5,
        candidateDigest: 'digest-5',
        candidateFailure: 'submit-failed',
      },
      acceptedDigest: 'digest-4',
    });
    expect(result).toMatchObject({
      status: 'degraded',
      resourceStage: 'lkg',
      generation: 4,
      digest: 'digest-4',
      candidateGeneration: 5,
      candidateDigest: 'digest-5',
      lkgGeneration: 4,
      candidateFailure: 'submit-failed',
    });
  });

  it('keeps capability unavailable distinct from degraded recovery', () => {
    expect(inspectVolumetricFog({ authored: true, capability: 'unavailable' }).status).toBe(
      'unavailable',
    );
    expect(
      inspectVolumetricFog({ authored: true, capability: 'available', degraded: true }).status,
    ).toBe('degraded');
  });
});
