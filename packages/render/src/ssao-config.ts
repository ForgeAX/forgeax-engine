// @forgeax/engine-render - SSAO parameter authority.

import { err, ok, type RenderPipelineAsset, type Result } from '@forgeax/engine-types';
import { PostProcessError } from './post-process-errors';

export const SSAO_DEFAULT_RADIUS = 0.25;
export const SSAO_DEFAULT_BIAS = 0;
export const SSAO_DEFAULT_INTENSITY = 1.0;

export type SsaoParameterConfig = Omit<
  NonNullable<NonNullable<RenderPipelineAsset['config']>['ssao']>,
  'enabled'
>;

export const GTAO_SAMPLE_COUNTS = { low: 4, medium: 10, high: 16 } as const;
export const SSAO_DEFAULT_THICKNESS = 1;
export const SSAO_DEFAULT_DISTANCE_EXPONENT = 1;
export const SSAO_DEFAULT_DISTANCE_FALL_OFF = 1;
export const SSAO_DEFAULT_RESOLUTION_SCALE = 1;

export const SSAO_SAMPLE_COUNTS = { low: 16, medium: 32, high: 64 } as const;

interface ResolvedSsaoParameters {
  readonly algorithm: 'ssao' | 'gtao';
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
 * active HDRP configuration, or for the disabled/default fallback payload.
 */
export function getSsaoParameters(config: SsaoParameterConfig | undefined): ResolvedSsaoParameters {
  return {
    algorithm: config?.algorithm ?? 'gtao',
    directLightingStrength: config?.directLightingStrength ?? 0,
    radius: config?.radius ?? SSAO_DEFAULT_RADIUS,
    bias: config?.bias ?? SSAO_DEFAULT_BIAS,
    intensity: config?.intensity ?? SSAO_DEFAULT_INTENSITY,
    thickness: config?.thickness ?? SSAO_DEFAULT_THICKNESS,
    distanceExponent: config?.distanceExponent ?? SSAO_DEFAULT_DISTANCE_EXPONENT,
    distanceFallOff: config?.distanceFallOff ?? SSAO_DEFAULT_DISTANCE_FALL_OFF,
    resolutionScale: config?.resolutionScale ?? SSAO_DEFAULT_RESOLUTION_SCALE,
    quality: config?.quality ?? 'high',
  };
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
  if (resolved.algorithm !== 'ssao' && resolved.algorithm !== 'gtao') {
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: 'algorithm', value: resolved.algorithm },
      }),
    );
  }
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
  if (
    !Number.isFinite(resolved.directLightingStrength) ||
    resolved.directLightingStrength < 0 ||
    resolved.directLightingStrength > 1
  ) {
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: 'directLightingStrength', value: resolved.directLightingStrength },
      }),
    );
  }
  for (const [paramName, min, max] of [
    ['thickness', 0, Number.POSITIVE_INFINITY],
    ['distanceExponent', 0, Number.POSITIVE_INFINITY],
    ['distanceFallOff', 0, 1],
    ['resolutionScale', 0.25, 1],
  ] as const) {
    const value = resolved[paramName];
    if (!Number.isFinite(value) || value < min || value > max) {
      return err(
        new PostProcessError({
          code: 'ssao-parameter-invalid',
          detail: { paramName, value },
        }),
      );
    }
  }
  return ok(resolved);
}
