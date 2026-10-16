import { describe, expect, it } from 'vitest';
import {
  recoverVolumetricFog,
  stageVolumetricFog,
  type VolumeRecoveryState,
} from '../volume/recovery';

const selectedLight = {
  entity: 19,
  kind: 'point' as const,
  revision: 8,
  shadowTile: 2,
  projector: {
    guid: 'projector-guid',
    generation: 3,
    view: 'spot-view-7',
    sampler: 'linear-clamp',
    projection: 'spot-projection-7',
    revision: 11,
  },
};

const state: VolumeRecoveryState = {
  guid: 'density-guid',
  generation: 4,
  deviceEpoch: 2,
  status: 'accepted',
  selectedLight,
};

describe('Point+Spot volumetric LKG transaction', () => {
  it('keeps the accepted pair and projector tuple after submit failure', () => {
    const staged = stageVolumetricFog(state, {
      generation: 5,
      digest: 'candidate-digest',
      selectedLight: {
        ...selectedLight,
        revision: 9,
        projector: { ...selectedLight.projector, revision: 12 },
      },
    });
    const failed = recoverVolumetricFog(staged, { kind: 'submit-failed' });
    expect(failed).toMatchObject({
      status: 'degraded',
      generation: 4,
      selectedLight,
      candidateFailure: 'submit-failed',
    });
  });

  it('does not promote a projector candidate from a stale generation', () => {
    const staged = stageVolumetricFog(state, {
      generation: 5,
      digest: 'candidate-digest',
      selectedLight,
    });
    const stale = recoverVolumetricFog(staged, { kind: 'accepted', generation: 4 });
    expect(stale).toMatchObject({
      status: 'degraded',
      generation: 4,
      selectedLight,
      candidateFailure: 'stale-generation',
    });
  });
});
