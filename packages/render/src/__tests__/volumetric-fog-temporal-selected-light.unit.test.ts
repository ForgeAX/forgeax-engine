import { describe, expect, it } from 'vitest';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';

const base: VolumeTemporalSignature = {
  cameraRevision: 1,
  fogRevision: 2,
  lightRevision: 3,
  densityGeneration: 4,
  width: 64,
  height: 64,
  lightKind: 'directional',
  lightEntity: 7,
  lightShadowRevision: 5,
};

describe('volumetric fog selected-light temporal identity', () => {
  it('resets for selected identity, kind, and shadow matrix revisions', () => {
    for (const change of [
      { lightEntity: 8 },
      { lightKind: 'spot' as const },
      { lightShadowRevision: 6 },
    ]) {
      expect(resolveVolumeTemporalReset(base, { ...base, ...change })).toEqual({
        reset: true,
        reason: 'light-revision',
      });
    }
  });

  it('does not reset when unrelated light revisions are unchanged', () => {
    expect(resolveVolumeTemporalReset(base, { ...base })).toEqual({ reset: false });
  });
});
