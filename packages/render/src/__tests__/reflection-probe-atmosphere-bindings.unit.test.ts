import type { TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { resolveReflectionProbeAtmosphereBindings } from '../record/reflection-probe-atmosphere-bindings';

describe('ReflectionProbe atmosphere bindings', () => {
  it('does not require a material volume when reduced-capability atmosphere omits the View layout', () => {
    const readTables = vi.fn(() => ({
      distantSkyLight: {} as TextureView,
      transmittance: {} as TextureView,
      multipleScattering: {} as TextureView,
    }));

    expect(
      resolveReflectionProbeAtmosphereBindings(
        {
          atmosphereAvailable: false,
          atmosphereFallbackView: undefined,
        },
        readTables,
      ),
    ).toBeUndefined();
    expect(readTables).not.toHaveBeenCalled();
  });

  it('binds frozen sky tables with the neutral volume when the material layout is admitted', () => {
    const volume = {} as TextureView;
    const tables = {
      distantSkyLight: {} as TextureView,
      transmittance: {} as TextureView,
      multipleScattering: {} as TextureView,
    };

    expect(
      resolveReflectionProbeAtmosphereBindings(
        {
          atmosphereAvailable: true,
          atmosphereFallbackView: volume,
        },
        () => tables,
      ),
    ).toEqual({
      ...tables,
      aerialPerspective: volume,
      aerialTransmittance: volume,
    });
  });
});
