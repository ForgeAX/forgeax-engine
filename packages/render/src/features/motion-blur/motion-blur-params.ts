import { err, ok, type Result } from '@forgeax/engine-types';

export interface MotionBlurParams {
  readonly shutterAngle: number;
  readonly maxRadiusPixels: number;
  readonly sampleCount: number;
  /** Target presentation rate used to convert frame displacement to exposure. 0 follows frame time. */
  readonly targetFps: number;
}

/** WGSL uniform size for the renderer-owned Motion Blur parameter block. */
export const MOTION_BLUR_PARAMS_BYTE_SIZE = 32;

/** The only quality tiers the shader is allowed to execute. */
export type MotionBlurSampleTier = 0 | 4 | 8 | 16;

export const DEFAULT_MOTION_BLUR_PARAMS: MotionBlurParams = Object.freeze({
  shutterAngle: 180,
  maxRadiusPixels: 32,
  sampleCount: 8,
  targetFps: 60,
});

export interface MotionBlurInvalidParamsDetail {
  readonly field: keyof MotionBlurParams;
  readonly value: unknown;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export class MotionBlurValidationError extends Error {
  readonly code = 'motion-blur-invalid-params' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MotionBlurInvalidParamsDetail;

  constructor(detail: MotionBlurInvalidParamsDetail) {
    const integer = detail.integer === true ? 'integer ' : '';
    const expected = `${detail.field} ${integer}in [${detail.min}, ${detail.max}]`;
    super(`motion-blur-invalid-params: ${expected}`);
    this.name = 'MotionBlurValidationError';
    this.expected = expected;
    this.hint = `set ${detail.field} to an ${integer}value in [${detail.min}, ${detail.max}]`;
    this.detail = detail;
  }
}

function validateField(
  field: keyof MotionBlurParams,
  value: number,
  min: number,
  max: number,
  integer = false,
): MotionBlurValidationError | undefined {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    return new MotionBlurValidationError({
      field,
      value,
      min,
      max,
      ...(integer ? { integer } : {}),
    });
  }
  return undefined;
}

export function validateMotionBlurParams(
  input: Partial<MotionBlurParams> | undefined,
): Result<MotionBlurParams, MotionBlurValidationError> {
  const value = input ?? {};
  const shutterAngle = value.shutterAngle ?? DEFAULT_MOTION_BLUR_PARAMS.shutterAngle;
  const maxRadiusPixels = value.maxRadiusPixels ?? DEFAULT_MOTION_BLUR_PARAMS.maxRadiusPixels;
  const sampleCount = value.sampleCount ?? DEFAULT_MOTION_BLUR_PARAMS.sampleCount;
  const targetFps = value.targetFps ?? DEFAULT_MOTION_BLUR_PARAMS.targetFps;
  const shutterError = validateField('shutterAngle', shutterAngle, 0, 360);
  if (shutterError !== undefined) return err(shutterError);
  const radiusError = validateField('maxRadiusPixels', maxRadiusPixels, 0, 64);
  if (radiusError !== undefined) return err(radiusError);
  const sampleError = validateField('sampleCount', sampleCount, 4, 16, true);
  if (sampleError !== undefined) return err(sampleError);
  const targetFpsError = validateField('targetFps', targetFps, 0, 240, true);
  if (targetFpsError !== undefined) return err(targetFpsError);
  return ok(Object.freeze({ shutterAngle, maxRadiusPixels, sampleCount, targetFps }));
}

export function motionBlurTemporalDemand(params: MotionBlurParams | undefined): boolean {
  return params !== undefined && params.shutterAngle > 0 && params.maxRadiusPixels > 0;
}

/** Round authored work down to the bounded shader tiers without changing exposure length. */
export function effectiveMotionBlurSampleCount(sampleCount: number): MotionBlurSampleTier {
  if (!Number.isFinite(sampleCount) || sampleCount < 4) return 0;
  if (sampleCount < 8) return 4;
  if (sampleCount < 16) return 8;
  return 16;
}

/** Reject a frame interval that cannot represent a stable temporal pair. */
export function isMotionBlurIntervalValid(frameDeltaSeconds: number): boolean {
  return Number.isFinite(frameDeltaSeconds) && frameDeltaSeconds > 0 && frameDeltaSeconds <= 0.1;
}

/**
 * Convert current-to-previous frame displacement into the authored target-rate exposure.
 * Invalid intervals return zero so callers can commit a fresh baseline without blurring it.
 */
export function motionBlurExposureScale(frameDeltaSeconds: number, targetFps: number): number {
  if (!isMotionBlurIntervalValid(frameDeltaSeconds)) return 0;
  if (
    !Number.isFinite(targetFps) ||
    targetFps < 0 ||
    targetFps > 240 ||
    !Number.isInteger(targetFps)
  ) {
    return 0;
  }
  if (targetFps === 0) return 1;
  return 1 / (targetFps * frameDeltaSeconds);
}

/**
 * Derive a render interval from the host sample clock before ECS time policy
 * clamps it. A finite raw pair is never clamped here, so a hitch remains
 * visible to temporal admission.
 */
export function motionBlurSampleDelta(
  sampleTimeSeconds: number | undefined,
  previousSampleTimeSeconds: number | undefined,
  fallbackDeltaSeconds: number,
): number {
  // An explicitly supplied non-finite sample is a temporal discontinuity. Do
  // not silently replace it with ECS delta: that would turn a corrupt host or
  // replay clock into an apparently valid blur interval.
  if (
    (sampleTimeSeconds !== undefined && !Number.isFinite(sampleTimeSeconds)) ||
    (previousSampleTimeSeconds !== undefined && !Number.isFinite(previousSampleTimeSeconds))
  ) {
    return Number.NaN;
  }
  if (Number.isFinite(sampleTimeSeconds) && Number.isFinite(previousSampleTimeSeconds)) {
    return (sampleTimeSeconds as number) - (previousSampleTimeSeconds as number);
  }
  return fallbackDeltaSeconds;
}

export function resolveMotionBlurParams(
  input: Partial<MotionBlurParams> | undefined,
): Result<MotionBlurParams | undefined, MotionBlurValidationError> {
  if (input === undefined) return ok(undefined);
  return validateMotionBlurParams(input);
}
