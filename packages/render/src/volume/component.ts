import { defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  VolumeDensityShapeMismatchError,
  type VolumeError,
  VolumeInvalidBoundsError,
  VolumeInvalidParametersError,
} from '../errors/render';

// Portable WebGPU provides 16 sampled textures per stage. Integration also
// samples froxels, scene depth, a projector, cloud shadow, and atmosphere.
export const MAX_VOLUMETRIC_FOG_OWNERS = 16 - 5;
/**
 * `uniform` is a constant unit density inside `bounds`, scaled by `extinction`; it needs
 * no density texture. The other modes sample the bound 3D `density` TextureAsset.
 */
export const VolumetricFogSamplingValue = {
  noise: 0,
  density: 1,
  densityAlbedo: 2,
  uniform: 3,
} as const;

export type VolumetricFogSampling = 'noise' | 'density' | 'density-albedo' | 'uniform';

/** Shader lane value of a sampling mode (`VolumetricFogSamplingValue` in authoring order). */
export function volumetricFogSamplingLane(sampling: VolumetricFogSampling | undefined): number {
  switch (sampling) {
    case 'uniform':
      return VolumetricFogSamplingValue.uniform;
    case 'density-albedo':
      return VolumetricFogSamplingValue.densityAlbedo;
    case 'density':
      return VolumetricFogSamplingValue.density;
    default:
      return VolumetricFogSamplingValue.noise;
  }
}

export interface VolumeDensityBinding {
  readonly guid: string;
  readonly generation: number;
  readonly shape: {
    readonly viewDimension: '2d' | '2d-array' | '3d';
    readonly extent: {
      readonly width: number;
      readonly height: number;
      readonly depth?: number;
      readonly layers?: number;
    };
  };
  readonly format: string;
  readonly colorSpace?: 'linear' | 'srgb';
}

export interface VolumeBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface VolumetricFogAuthoring {
  /** Invalid authoring reports closed code, expected, hint, and detail fields. */
  /** The selected DirectionalLight or PointLight in this World. */
  readonly light: EntityHandle;
  /** The optional same-World SpotLight paired with a PointLight. */
  readonly spotLight?: EntityHandle;
  /** Required unless `sampling` is `uniform`, which ignores any bound texture. */
  readonly density?: VolumeDensityBinding;
  readonly bounds: VolumeBounds;
  readonly extinction: readonly [number, number, number];
  readonly albedo: readonly [number, number, number];
  readonly emission: readonly [number, number, number];
  readonly anisotropy: number;
  readonly maxDistance: number;
  /** Local density-albedo uses linear RGBA: RGB = density * albedo, A = density. */
  readonly sampling?: VolumetricFogSampling;
}

export type ValidatedVolumetricFog = VolumetricFogAuthoring;

export const VolumetricFog = defineComponent('VolumetricFog', {
  light: { type: 'entity' },
  spotLight: { type: 'entity' },
  density: { type: 'asset<texture>', simulationTransient: true },
  /** Runtime GPU-generated 3D density. Takes precedence over the byte source. */
  generatedDensity: { type: 'asset<gpu-texture>', simulationTransient: true },
  boundsMin: { type: 'array<f32, 3>' },
  boundsMax: { type: 'array<f32, 3>' },
  extinction: { type: 'array<f32, 3>' },
  albedo: { type: 'array<f32, 3>' },
  emission: { type: 'array<f32, 3>' },
  anisotropy: { type: 'f32', default: 0 },
  maxDistance: { type: 'f32', default: 100 },
  sampling: { type: 'enum', labels: VolumetricFogSamplingValue, default: 0 },
});

function finiteVector(value: readonly [number, number, number]): boolean {
  return value.every(Number.isFinite);
}

function validBounds(bounds: VolumeBounds): boolean {
  if (!finiteVector(bounds.min) || !finiteVector(bounds.max)) return false;
  return bounds.max.every((value, index) => value > (bounds.min[index] ?? value));
}

function validRange(
  value: readonly [number, number, number],
  min: number,
  max = Infinity,
): boolean {
  return value.every((entry) => Number.isFinite(entry) && entry >= min && entry <= max);
}

/** The texture a sampled mode reads: a linear 3D field, RGBA for density-albedo. */
function densityFailure(input: VolumetricFogAuthoring): VolumeError | undefined {
  if (input.sampling === 'uniform') return undefined;
  const density = input.density;
  if (density === undefined) return new VolumeDensityShapeMismatchError('', 'none');
  if (density.shape.viewDimension !== '3d' || density.colorSpace === 'srgb')
    return new VolumeDensityShapeMismatchError(density.guid, density.shape.viewDimension);
  if (
    input.sampling === 'density-albedo' &&
    density.format !== 'rgba8unorm' &&
    density.format !== 'rgba16float'
  )
    return new VolumeInvalidParametersError(input, {
      field: 'density.format',
      value: density.format,
    });
  return undefined;
}

export function validateVolumetricFog(
  input: VolumetricFogAuthoring,
): Result<ValidatedVolumetricFog, VolumeError> {
  const density = densityFailure(input);
  if (density instanceof VolumeDensityShapeMismatchError) return err(density);
  if (!validBounds(input.bounds)) return err(new VolumeInvalidBoundsError(input.bounds));
  if (density !== undefined) return err(density);
  if (
    !validRange(input.extinction, 0) ||
    !validRange(input.albedo, 0, 1) ||
    !validRange(input.emission, 0) ||
    !Number.isFinite(input.anisotropy) ||
    input.anisotropy <= -1 ||
    input.anisotropy >= 1 ||
    !Number.isFinite(input.maxDistance) ||
    input.maxDistance <= 0 ||
    (input.sampling !== undefined &&
      input.sampling !== 'noise' &&
      input.sampling !== 'density' &&
      input.sampling !== 'density-albedo' &&
      input.sampling !== 'uniform')
  ) {
    return err(new VolumeInvalidParametersError(input));
  }
  return ok(input);
}
