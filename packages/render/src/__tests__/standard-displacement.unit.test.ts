import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';
import { buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';

describe('Standard vertex displacement', () => {
  it('keeps height sampling vertex-only within the portable sampler budget', () => {
    const entries = buildPbrMaterialUserRegionEntries(
      [{ name: 'displacementTexture', type: 'texture2d' }],
      [],
      ['displacementTexture'],
    );
    expect(entries.filter((e) => e.texture || e.sampler).map((e) => e.visibility)).toEqual([1, 1]);
  });
  it('preserves both stages for a custom shader with the same texture name', () => {
    const entries = buildPbrMaterialUserRegionEntries([
      { name: 'displacementTexture', type: 'texture2d' },
    ]);
    expect(entries.filter((e) => e.texture || e.sampler).map((e) => e.visibility)).toEqual([3, 3]);
  });
  it('publishes the height texture and signed scale/bias through the material contract', () => {
    const texture = {
      texture: 19,
      coordinates: { set: 1 as const, transform: { scale: [2, 3] as const } },
    };
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      displacementTexture: texture,
      displacementScale: -2,
      displacementBias: 0.5,
    });
    expect(material.values).toMatchObject({
      displacementTexture: texture,
      displacementScale: -2,
      displacementBias: 0.5,
    });
    expect(material.parameters?.map((p) => p.name)).toContain('displacementTexture');
    expect(material.passes?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['forward', 'deferred', 'shadow-caster']),
    );
  });
  it.each(['displacementScale', 'displacementBias'])('rejects non-finite %s', (parameter) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], [parameter]: value })).toThrow(
        expect.objectContaining({
          code: 'material-authoring-contract-invalid',
          detail: expect.objectContaining({ parameter, reason: 'non-finite' }),
        }),
      );
    }
  });
});
