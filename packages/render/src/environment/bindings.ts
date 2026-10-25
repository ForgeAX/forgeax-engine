import type { BindGroupEntry, TextureView } from '@forgeax/engine-rhi';
import type { PipelineState } from '../record/render-context';
export interface AtmosphereViews {
  readonly distantSkyLight: TextureView;
  readonly transmittance: TextureView;
  readonly multipleScattering: TextureView;
  readonly aerialPerspective: TextureView;
  readonly aerialTransmittance: TextureView;
}
const ATMOSPHERE_BINDING_SLOTS = [18, 19, 20, 21, 23] as const;

/**
 * Push the atmosphere View resources in binding order (18, 19, 20, 21, 23).
 * Bind-group cache keys read this directly; `atmosphereBindings` derives its
 * entries from the same projection.
 */
export function pushAtmosphereBindingResources(
  out: TextureView[] | object[],
  state: PipelineState,
  views?: AtmosphereViews,
): void {
  if (state.atmosphereAvailable !== true) return;
  const volume = state.atmosphereFallbackView;
  if (volume === undefined) throw new Error('admitted atmosphere layout has no neutral volume');
  (out as object[]).push(
    views?.transmittance ?? state.defaultWhiteTextureView,
    views?.multipleScattering ?? state.defaultWhiteTextureView,
    views?.aerialPerspective ?? volume,
    views?.aerialTransmittance ?? volume,
    views?.distantSkyLight ?? state.defaultWhiteTextureView,
  );
}

/** The material View ABI and shadow layouts share these exact entries. */
export function atmosphereBindings(
  state: PipelineState,
  views?: AtmosphereViews,
): BindGroupEntry[] {
  const resources: TextureView[] = [];
  pushAtmosphereBindingResources(resources, state, views);
  return resources.map((value, index) => ({
    binding: ATMOSPHERE_BINDING_SLOTS[index] as number,
    resource: { kind: 'textureView', value },
  }));
}

export function atmosphereViewLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    ...(
      [
        [18, '2d'],
        [19, '2d'],
        [20, '3d'],
        [21, '3d'],
        [23, '2d'],
      ] as const
    ).map(([binding, viewDimension]) => ({
      binding,
      visibility: 2,
      texture: { sampleType: 'float' as const, viewDimension },
    })),
  ];
}

/** Depth-aware material programs also evaluate the shared single-scattering visibility. */
export function atmosphereMaterialVisibilityLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 3, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
    { binding: 4, visibility: 2, sampler: { type: 'comparison' } },
    { binding: 16, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 17, visibility: 2, sampler: { type: 'filtering' } },
  ];
}
export function atmosphereMaterialVisibilityBindings(
  state: PipelineState,
  directional?: TextureView,
  cloud?: TextureView,
): BindGroupEntry[] {
  if (state.atmosphereAvailable !== true) return [];
  const sampler = state.perPassResources.shadowSampler;
  if (sampler === null) throw new Error('admitted atmosphere requires the shadow sampler');
  return [
    {
      binding: 3,
      resource: { kind: 'textureView', value: directional ?? state.shadowArrayFallbackTextureView },
    },
    { binding: 4, resource: { kind: 'sampler', value: sampler } },
    {
      binding: 16,
      resource: { kind: 'textureView', value: cloud ?? state.defaultWhiteTextureView },
    },
    {
      binding: 17,
      resource: { kind: 'sampler', value: state.viewLinearSampler ?? state.defaultSampler },
    },
  ];
}
