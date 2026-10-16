import { describe, expect, it } from 'vitest';
import { Materials, MaterialTransmissionContractError } from '../materials';

describe('Materials.standard transmission validation', () => {
  it('requires IOR to be a finite dielectric ratio >= 1', () => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], ior: 0.99 })).toThrow(
      MaterialTransmissionContractError,
    );
    try {
      Materials.standard({ baseColor: [1, 1, 1, 1], ior: 0.99 });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-transmission-contract-invalid',
        detail: { material: 'Standard', parameter: 'ior', reason: 'range', actual: 0.99 },
      });
    }
  });

  it('exposes structured finite, shape, and pass-state failures', () => {
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: NaN,
      }),
    ).toThrow(MaterialTransmissionContractError);
    try {
      Materials.standard({ baseColor: [1, 1, 1, 1], attenuationColor: [1, 2] as never });
    } catch (error) {
      expect(error).toMatchObject({ detail: { reason: 'shape' } });
    }
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 1,
        renderState: { blend: { color: {}, alpha: {} } as never },
      }),
    ).toThrow(MaterialTransmissionContractError);
  });

  it('preserves the typed physical contract error for incomplete custom layers', () => {
    const options = {
      surfaceModule: 'game_3d::custom_surface',
      staticSwitches: { clearcoat: true },
      parameters: [{ name: 'clearcoat', type: 'f32' as const }],
      values: { clearcoat: 0.5 },
    };

    expect(() => Materials.standard(options as never)).toThrow(Error);
    try {
      Materials.standard(options as never);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-physical-contract-invalid',
        detail: {
          code: 'material-physical-contract-invalid',
          material: 'Standard',
          layer: 'clearcoat',
          missing: ['clearcoatRoughness'],
          reason: 'incomplete-layer',
        },
      });
    }
  });
});
