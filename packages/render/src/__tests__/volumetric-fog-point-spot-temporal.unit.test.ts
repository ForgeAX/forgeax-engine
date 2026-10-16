import { describe, expect, it } from 'vitest';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';

const projector = {
  guid: 'projector-guid',
  generation: 3,
  view: 'spot-view-7',
  sampler: 'linear-clamp',
  projection: 'spot-projection-7',
  revision: 11,
} as const;

const signature: VolumeTemporalSignature = {
  cameraRevision: 4,
  fogRevision: 2,
  lightRevision: 7,
  densityGeneration: 3,
  width: 1280,
  height: 720,
  lightKind: 'point',
  lightEntity: 19,
  pointLightEntity: 19,
  spotLightEntity: 23,
  projector,
};

describe('Point+Spot volumetric temporal identity', () => {
  it('keeps history for the same accepted pair and projector tuple', () => {
    expect(resolveVolumeTemporalReset(signature, signature)).toEqual({ reset: false });
  });

  it.each([
    ['projector GUID', { ...projector, guid: 'new-projector-guid' }],
    ['projector generation', { ...projector, generation: 4 }],
    ['projector view', { ...projector, view: 'spot-view-8' }],
    ['projector sampler', { ...projector, sampler: 'nearest-clamp' }],
    ['projector projection', { ...projector, projection: 'spot-projection-8' }],
    ['projector revision', { ...projector, revision: 12 }],
  ] as const)('resets history when %s changes', (_name, nextProjector) => {
    expect(
      resolveVolumeTemporalReset(signature, { ...signature, projector: nextProjector }),
    ).toEqual({ reset: true, reason: 'light-revision' });
  });

  it('resets history when either selected pair entity changes', () => {
    expect(resolveVolumeTemporalReset(signature, { ...signature, spotLightEntity: 24 })).toEqual({
      reset: true,
      reason: 'light-revision',
    });
    expect(resolveVolumeTemporalReset(signature, { ...signature, pointLightEntity: 20 })).toEqual({
      reset: true,
      reason: 'light-revision',
    });
  });
});
