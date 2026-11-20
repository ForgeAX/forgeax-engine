// @forgeax/engine-render - SSAO parameter authority.

import {
  type CompactGBufferLayout,
  err,
  type MaterialGBufferLayout,
  ok,
  type RenderPipelineAsset,
  type Result,
} from '@forgeax/engine-types';
import { PostProcessError } from './post-process-errors';

export const SSAO_DEFAULT_RADIUS = 0.25;
export const SSAO_DEFAULT_BIAS = 0;
export const SSAO_DEFAULT_INTENSITY = 1.0;
export const DEFAULT_AMBIENT_OCCLUSION_METHOD = 'ssao';

export type DeferredAoNormalLayout = MaterialGBufferLayout | CompactGBufferLayout;

export type AmbientOcclusionSettings = NonNullable<
  NonNullable<RenderPipelineAsset['config']>['ambientOcclusion']
>;
export type SsaoParameterConfig = Omit<AmbientOcclusionSettings, 'enabled'>;

/** Stock Standard graphs upload direct AO strength as a frame value. */
export function ssaoStructuralIdentity<
  T extends { readonly directLightingStrength?: number | undefined },
>(
  config: T | undefined,
  stockStandard: boolean,
): T | Omit<T, 'directLightingStrength'> | undefined {
  if (!stockStandard || config === undefined) return config;
  const { directLightingStrength: _directLightingStrength, ...structure } = config;
  return structure;
}

export const GTAO_SAMPLE_COUNTS = { low: 4, medium: 10, high: 16 } as const;
export const SSAO_DEFAULT_THICKNESS = 1;
export const SSAO_DEFAULT_DISTANCE_EXPONENT = 1;
export const SSAO_DEFAULT_DISTANCE_FALL_OFF = 1;
export const SSAO_DEFAULT_RESOLUTION_SCALE = 1;

export const SPIRAL_SSAO_SAMPLE_COUNTS = { low: 8, medium: 12, high: 12 } as const;

export const SSAO_SAMPLE_COUNTS = { low: 16, medium: 32, high: 64 } as const;

interface ResolvedSsaoParameters {
  readonly method: NonNullable<AmbientOcclusionSettings['method']>;
  readonly application: 'lighting' | 'scene-color';
  readonly sceneColorStrength: number;
  readonly sampleCount: number;
  readonly directLightingStrength: number;
  readonly radius: number;
  readonly bias: number;
  readonly intensity: number;
  readonly thickness: number;
  readonly distanceExponent: number;
  readonly distanceFallOff: number;
  readonly resolutionScale: number;
  readonly quality: 'low' | 'medium' | 'high';
}

/**
 * Apply the public defaults without deciding whether the values are valid.
 * The record stage uses this only after the graph build has validated the
 * active Standard configuration, or for the disabled/default fallback payload.
 */
export function getSsaoParameters(config: SsaoParameterConfig | undefined): ResolvedSsaoParameters {
  const method = config?.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD;
  const quality = config?.quality ?? 'high';
  const counts =
    method === 'gtao'
      ? GTAO_SAMPLE_COUNTS
      : method === 'spiral-ssao'
        ? SPIRAL_SSAO_SAMPLE_COUNTS
        : SSAO_SAMPLE_COUNTS;
  return {
    method,
    application: config?.application ?? 'lighting',
    sceneColorStrength: config?.sceneColorStrength ?? 0.95,
    sampleCount: config?.sampleCount ?? counts[quality],
    directLightingStrength: config?.directLightingStrength ?? 0,
    radius: config?.radius ?? SSAO_DEFAULT_RADIUS,
    bias: config?.bias ?? SSAO_DEFAULT_BIAS,
    intensity: config?.intensity ?? SSAO_DEFAULT_INTENSITY,
    thickness: config?.thickness ?? SSAO_DEFAULT_THICKNESS,
    distanceExponent: config?.distanceExponent ?? SSAO_DEFAULT_DISTANCE_EXPONENT,
    distanceFallOff: config?.distanceFallOff ?? SSAO_DEFAULT_DISTANCE_FALL_OFF,
    resolutionScale: config?.resolutionScale ?? SSAO_DEFAULT_RESOLUTION_SCALE,
    quality,
  };
}

function invalidSsaoMode(resolved: ResolvedSsaoParameters): PostProcessError | undefined {
  if (
    resolved.method !== 'ssao' &&
    resolved.method !== 'gtao' &&
    resolved.method !== 'spiral-ssao'
  ) {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'method', value: resolved.method },
    });
  }
  if (resolved.application !== 'lighting' && resolved.application !== 'scene-color') {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'application', value: resolved.application },
    });
  }
  if (
    !Number.isFinite(resolved.sceneColorStrength) ||
    resolved.sceneColorStrength < 0 ||
    resolved.sceneColorStrength > 1
  ) {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'sceneColorStrength', value: resolved.sceneColorStrength },
    });
  }
  return undefined;
}

function invalidSsaoSampling(resolved: ResolvedSsaoParameters): PostProcessError | undefined {
  if (
    !Number.isInteger(resolved.sampleCount) ||
    resolved.sampleCount < 1 ||
    resolved.sampleCount > 64
  ) {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'sampleCount', value: resolved.sampleCount },
    });
  }
  if (
    !Number.isFinite(resolved.directLightingStrength) ||
    resolved.directLightingStrength < 0 ||
    resolved.directLightingStrength > 1
  ) {
    return new PostProcessError({
      code: 'ssao-parameter-invalid',
      detail: { paramName: 'directLightingStrength', value: resolved.directLightingStrength },
    });
  }
  for (const [paramName, min, max] of [
    ['thickness', 0, Number.POSITIVE_INFINITY],
    ['distanceExponent', 0, Number.POSITIVE_INFINITY],
    ['distanceFallOff', 0, 1],
    ['resolutionScale', 0.25, 1],
  ] as const) {
    const value = resolved[paramName];
    if (!Number.isFinite(value) || value < min || value > max) {
      return new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName, value },
      });
    }
  }
  return undefined;
}

/**
 * Resolve and validate the SSAO configuration used by both graph routes.
 * Invalid values remain structured PostProcessErrors instead of becoming
 * NaNs or silently falling back to shader literals.
 */
export function resolveSsaoParameters(
  config: SsaoParameterConfig | undefined,
): Result<ResolvedSsaoParameters, PostProcessError> {
  const resolved = getSsaoParameters(config);
  const modeFailure = invalidSsaoMode(resolved);
  if (modeFailure !== undefined) return err(modeFailure);
  if (!Number.isFinite(resolved.radius) || resolved.radius <= 0) {
    return err(
      new PostProcessError({
        code: 'ssao-radius-non-positive',
        detail: { paramName: 'radius', value: resolved.radius },
      }),
    );
  }
  if (!Number.isFinite(resolved.bias) || resolved.bias < 0) {
    return err(
      new PostProcessError({
        code: 'ssao-bias-negative',
        detail: { paramName: 'bias', value: resolved.bias },
      }),
    );
  }
  if (
    !Number.isFinite(resolved.intensity) ||
    resolved.intensity < 0 ||
    !Object.hasOwn(SSAO_SAMPLE_COUNTS, resolved.quality)
  ) {
    const paramName =
      !Number.isFinite(resolved.intensity) || resolved.intensity < 0 ? 'intensity' : 'quality';
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName, value: resolved[paramName] },
      }),
    );
  }
  const samplingFailure = invalidSsaoSampling(resolved);
  if (samplingFailure !== undefined) return err(samplingFailure);
  return ok(resolved);
}

/** Scene-color AO must never darken lighting a second time. */
export function ssaoUsesLighting(
  config: NonNullable<RenderPipelineAsset['config']>['ambientOcclusion'],
): boolean {
  return config?.enabled === true && config.application !== 'scene-color';
}
