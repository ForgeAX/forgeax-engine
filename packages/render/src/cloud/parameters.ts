import { CLOUD_EXTINCTION_COEFFICIENT } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type CloudLayerData,
  type CloudQuality,
  CloudQualityValue,
  cloudQualityFromF32,
} from '../components/cloud-layer';
import { type CloudLayerError, CloudLayerInvalidParameterError } from '../errors/cloud';

export interface CloudLayerAuthoring {
  readonly seed?: number;
  readonly baseHeight?: number;
  readonly thickness?: number;
  readonly scale?: number;
  readonly coverage?: number;
  readonly density?: number;
  readonly wind?: ArrayLike<number>;
  readonly quality?: CloudQuality | number;
  readonly shadowRange?: number;
}

export interface ValidatedCloudLayer {
  readonly seed: number;
  readonly baseHeight: number;
  readonly thickness: number;
  readonly scale: number;
  readonly coverage: number;
  readonly density: number;
  readonly wind: readonly [number, number, number];
  readonly quality: CloudQuality;
  readonly shadowRange: number;
}

export interface CloudQualityProfile {
  readonly cacheResolution: number;
  readonly viewSteps: number;
  readonly shadowSteps: number;
  readonly historyWeight: number;
  /** Renderer-owned sky trace domain in world units; independent of Camera.far. */
  readonly viewDistance: number;
}

/**
 * Quality values are bounded in one place. The values are deliberately
 * renderer policy, while the component stores only the closed quality code.
 */
export const CLOUD_QUALITY_PROFILES: Readonly<Record<CloudQuality, CloudQualityProfile>> =
  Object.freeze({
    low: Object.freeze({
      // Preserve low-profile ray counts while keeping separate puffs from
      // collapsing into one bilinear cache smear.
      cacheResolution: 32,
      viewSteps: 40,
      shadowSteps: 12,
      historyWeight: 0.82,
      viewDistance: 1600,
    }),
    medium: Object.freeze({
      cacheResolution: 40,
      viewSteps: 64,
      shadowSteps: 20,
      historyWeight: 0.9,
      viewDistance: 2400,
    }),
    high: Object.freeze({
      cacheResolution: 64,
      viewSteps: 64,
      shadowSteps: 32,
      historyWeight: 0.94,
      viewDistance: 4000,
    }),
  });

/**
 * The spatial cloud-shadow map is intentionally derived from the same quality
 * profile everywhere: graph allocation, light-space projection and inspection
 * must agree on one texel grid.  Keep the multiplier here rather than letting
 * each owner invent a resolution.
 */
export function cloudShadowResolutionForQuality(qualityValue: CloudQuality): number {
  return CLOUD_QUALITY_PROFILES[qualityValue].cacheResolution * 4;
}

/**
 * Cloud visibility is a sky-domain concern. It must not inherit the opaque
 * geometry far plane or the finite receiver-shadow footprint: either value is
 * commonly much shorter than a ground-view cloud trace and would turn the
 * distant layer into a flat wall.
 */
export function cloudViewDistanceForQuality(qualityValue: CloudQuality): number {
  return CLOUD_QUALITY_PROFILES[qualityValue].viewDistance;
}

/**
 * Authored density is a normalized formation value. Convert it to a bounded
 * per-world-unit extinction coefficient only at integration time; otherwise a
 * long horizon step would become opaque after its first sample and expose
 * marching bands instead of a participating volume.
 */
export { CLOUD_EXTINCTION_COEFFICIENT };

export const DEFAULT_CLOUD_LAYER: ValidatedCloudLayer = Object.freeze({
  seed: 1337,
  baseHeight: 120,
  thickness: 80,
  scale: 0.004,
  coverage: 0.48,
  density: 1,
  wind: Object.freeze([8, 0, 2] as [number, number, number]),
  quality: 'medium',
  shadowRange: 512,
});

function invalid(field: string, value: unknown, expected: string): Result<never, CloudLayerError> {
  return err(new CloudLayerInvalidParameterError(field, value, expected));
}

function finiteRange(
  field: string,
  value: unknown,
  min: number,
  max = Number.POSITIVE_INFINITY,
): Result<number, CloudLayerError> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    const expected = Number.isFinite(max)
      ? `finite and in [${min}, ${max}]`
      : `finite and >= ${min}`;
    return invalid(field, value, expected);
  }
  return ok(value);
}

function quality(value: unknown): Result<CloudQuality, CloudLayerError> {
  if (typeof value === 'string' && (value === 'low' || value === 'medium' || value === 'high')) {
    return ok(value);
  }
  if (typeof value === 'number') {
    const resolved = cloudQualityFromF32(value);
    if (resolved !== undefined) return ok(resolved);
  }
  return invalid(
    'quality',
    value,
    `one of low, medium, high (codes ${CloudQualityValue.low}, ${CloudQualityValue.medium}, ${CloudQualityValue.high})`,
  );
}

function wind(value: unknown): Result<readonly [number, number, number], CloudLayerError> {
  if (value === undefined || value === null || typeof value !== 'object') {
    return invalid('wind', value, 'three finite world-space components');
  }
  const source = value as ArrayLike<number>;
  if (source.length !== 3) return invalid('wind', value, 'three finite world-space components');
  const result: [number, number, number] = [
    source[0] ?? Number.NaN,
    source[1] ?? Number.NaN,
    source[2] ?? Number.NaN,
  ];
  if (result.some((entry) => !Number.isFinite(entry) || Math.abs(entry) > 1000)) {
    return invalid('wind', value, 'three finite components in [-1000, 1000]');
  }
  return ok(Object.freeze(result));
}

/** Validate one detached CloudLayer POD before deriving cache or graph state. */
export function validateCloudLayer(
  input: CloudLayerAuthoring | Partial<CloudLayerData> | undefined,
): Result<ValidatedCloudLayer, CloudLayerError> {
  const value = input ?? {};
  const seed = value.seed ?? DEFAULT_CLOUD_LAYER.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return invalid('seed', seed, 'an integer in [0, 4294967295]');
  }
  const baseHeight = finiteRange(
    'baseHeight',
    value.baseHeight ?? DEFAULT_CLOUD_LAYER.baseHeight,
    -100000,
    1000000,
  );
  if (!baseHeight.ok) return baseHeight;
  const thickness = finiteRange(
    'thickness',
    value.thickness ?? DEFAULT_CLOUD_LAYER.thickness,
    0.001,
    1000000,
  );
  if (!thickness.ok) return thickness;
  const scale = finiteRange('scale', value.scale ?? DEFAULT_CLOUD_LAYER.scale, 0.000001, 10);
  if (!scale.ok) return scale;
  const coverage = finiteRange('coverage', value.coverage ?? DEFAULT_CLOUD_LAYER.coverage, 0, 1);
  if (!coverage.ok) return coverage;
  const density = finiteRange('density', value.density ?? DEFAULT_CLOUD_LAYER.density, 0, 32);
  if (!density.ok) return density;
  const resolvedWind = wind(value.wind ?? DEFAULT_CLOUD_LAYER.wind);
  if (!resolvedWind.ok) return resolvedWind;
  const resolvedQuality = quality(value.quality ?? DEFAULT_CLOUD_LAYER.quality);
  if (!resolvedQuality.ok) return resolvedQuality;
  const shadowRange = finiteRange(
    'shadowRange',
    value.shadowRange ?? DEFAULT_CLOUD_LAYER.shadowRange,
    0.001,
    10000000,
  );
  if (!shadowRange.ok) return shadowRange;
  return ok(
    Object.freeze({
      seed,
      baseHeight: baseHeight.value,
      thickness: thickness.value,
      scale: scale.value,
      coverage: coverage.value,
      density: density.value,
      wind: resolvedWind.value,
      quality: resolvedQuality.value,
      shadowRange: shadowRange.value,
    }),
  );
}

/** Stable source identity used by cache, history and recovery receipts. */
export function cloudLayerSourceKey(params: ValidatedCloudLayer): string {
  return [
    'cloud-layer-v1',
    params.seed,
    params.baseHeight,
    params.thickness,
    params.scale,
    params.coverage,
    params.density,
    params.wind[0],
    params.wind[1],
    params.wind[2],
    params.quality,
    params.shadowRange,
  ].join(':');
}

/**
 * Stable identity for the reusable formation bases. Coverage, density and
 * wind are evaluation inputs and deliberately do not rebuild the weather,
 * body or erosion cache when they change continuously.
 */
export function cloudLayerFormationKey(params: ValidatedCloudLayer): string {
  return [
    'cloud-formation-v5',
    params.seed,
    params.baseHeight,
    params.thickness,
    params.scale,
    params.quality,
  ].join(':');
}
