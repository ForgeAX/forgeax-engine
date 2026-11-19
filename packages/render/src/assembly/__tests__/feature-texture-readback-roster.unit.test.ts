import { describe, expect, it } from 'vitest';
import { createRendererObservationCaptureOwner } from '../webgpu-renderer-observation-owner';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

describe('feature texture readback roster', () => {
  it('reserves and claims same-named outputs independently for two views', () => {
    const owner = createRendererObservationCaptureOwner(() => {}, 512).observationCaptureOwner;
    const declarations = ['camera:main', 'camera:reflection'].map((viewIdentity) => ({
      featureIdentity: 'water.feature',
      viewIdentity,
      name: 'water-grid',
      targetName: 'water-grid',
      format: 'rgba8unorm' as const,
      width: 1,
      height: 1,
      bytesPerRow: 256,
      byteLength: 256,
    }));

    expect(owner.preflightFeatureTextureReadbacks?.(4, declarations).ok).toBe(true);
    expect(owner.claimFeatureTextureReadback?.(4, requiredFixtureValue(declarations[0])).ok).toBe(
      true,
    );
    expect(owner.claimFeatureTextureReadback?.(4, requiredFixtureValue(declarations[1])).ok).toBe(
      true,
    );
    expect(owner.claimFeatureTextureReadback?.(4, requiredFixtureValue(declarations[0])).ok).toBe(
      false,
    );
  });
});
