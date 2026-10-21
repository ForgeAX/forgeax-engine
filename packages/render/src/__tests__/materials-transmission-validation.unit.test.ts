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

  it('exposes structured finite, shape, and range failures', () => {
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
        thickness: -1,
      }),
    ).toThrow(MaterialTransmissionContractError);
  });

  it('preserves explicit transmission depth and blending while keeping the native default', () => {
    const blend = {
      color: {
        operation: 'add' as const,
        srcFactor: 'src-alpha' as const,
        dstFactor: 'one-minus-src-alpha' as const,
      },
      alpha: {
        operation: 'add' as const,
        srcFactor: 'one' as const,
        dstFactor: 'one-minus-src-alpha' as const,
      },
    };
    const authored = Materials.standard({
      baseColor: [1, 1, 1, 0.4],
      transmission: 1,
      renderState: { depthWriteEnabled: true, blend },
    });
    expect(authored.passes?.find((pass) => pass.name === 'forward')?.renderState).toMatchObject({
      depthWriteEnabled: true,
      blend,
    });
    expect(
      Materials.standard({ baseColor: [1, 1, 1, 1], transmission: 1 }).passes?.[0]?.renderState
        ?.depthWriteEnabled,
    ).toBe(false);
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
