import { describe, expect, it } from 'vitest';
import {
  recoverVolumetricFog,
  stageVolumetricFog,
  type VolumeRecoveryState,
} from '../volume/recovery';

const selected = { entity: 19, kind: 'spot' as const, revision: 8, shadowTile: 2 };
const state = {
  guid: 'density-guid',
  generation: 4,
  deviceEpoch: 2,
  status: 'accepted' as const,
  selectedLight: selected,
};

describe('selected volumetric light transaction', () => {
  it('keeps selected light LKG when candidate submit fails', () => {
    const staged = stageVolumetricFog(
      state as VolumeRecoveryState,
      {
        generation: 5,
        digest: 'candidate-digest',
        selectedLight: { ...selected, revision: 9 },
      } as never,
    );
    const failed = recoverVolumetricFog(staged, { kind: 'submit-failed' });
    expect(failed).toMatchObject({
      status: 'degraded',
      generation: 4,
      selectedLight: selected,
      candidateFailure: 'submit-failed',
    });
  });

  it('does not promote a candidate from a stale device generation', () => {
    const staged = stageVolumetricFog(
      state as VolumeRecoveryState,
      {
        generation: 5,
        digest: 'candidate-digest',
        selectedLight: selected,
      } as never,
    );
    const stale = recoverVolumetricFog(staged, { kind: 'accepted', generation: 4 });
    expect(stale).toMatchObject({
      status: 'degraded',
      generation: 4,
      selectedLight: selected,
      candidateFailure: 'stale-generation',
    });
  });
});
