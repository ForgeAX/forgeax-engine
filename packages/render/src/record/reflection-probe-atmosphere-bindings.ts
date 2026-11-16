import type { TextureView } from '@forgeax/engine-rhi';
import type { AtmosphereViews } from '../environment/bindings';

export interface ReflectionProbeAtmosphereBindingState {
  readonly atmosphereAvailable: boolean;
  readonly atmosphereFallbackView: TextureView | undefined;
}

export type ReflectionProbeAtmosphereTableViews = Pick<
  AtmosphereViews,
  'distantSkyLight' | 'transmittance' | 'multipleScattering'
>;

export function resolveReflectionProbeAtmosphereBindings(
  state: ReflectionProbeAtmosphereBindingState,
  readTables: () => ReflectionProbeAtmosphereTableViews,
): AtmosphereViews | undefined {
  if (!state.atmosphereAvailable) return undefined;
  const volume = state.atmosphereFallbackView;
  if (volume === undefined)
    throw new Error('Admitted Atmosphere bindings require a neutral volume');
  return {
    ...readTables(),
    aerialPerspective: volume,
    aerialTransmittance: volume,
  };
}
