import { describe, expect, it } from 'vitest';
import {
  recoverVolumetricFog,
  stageVolumetricFog,
  type VolumeRecoveryState,
} from '../volume/recovery';

const state: VolumeRecoveryState = {
  guid: 'density-guid',
  generation: 4,
  deviceEpoch: 2,
  status: 'accepted',
};

describe('volumetric fog recovery transaction', () => {
  it('keeps accepted LKG when candidate upload or submit fails', () => {
    const staged = stageVolumetricFog(state, { generation: 5, digest: 'candidate-digest' });
    expect(staged).toMatchObject({ status: 'candidate', candidateGeneration: 5 });
    const failed = recoverVolumetricFog(staged, { kind: 'submit-failed' });
    expect(failed).toMatchObject({
      status: 'degraded',
      generation: 4,
      lkgGeneration: 4,
      candidateFailure: 'submit-failed',
    });
  });

  it('clears device-bound resources and rebuilds the same GUID after device loss', () => {
    const lost = recoverVolumetricFog(state, { kind: 'device-lost', deviceEpoch: 3 });
    expect(lost).toMatchObject({
      status: 'recovering',
      guid: 'density-guid',
      deviceEpoch: 3,
      generation: 4,
    });
    expect(lost).not.toHaveProperty('acceptedGeneration', 5);
  });

  it('rejects stale generations instead of silently publishing a new LKG', () => {
    const stale = recoverVolumetricFog(state, { kind: 'accepted', generation: 3 });
    expect(stale).toMatchObject({
      status: 'degraded',
      generation: 4,
      candidateFailure: 'stale-generation',
    });
  });
});
