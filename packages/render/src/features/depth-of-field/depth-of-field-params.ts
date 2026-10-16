import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type DepthOfFieldData,
  type DepthOfFieldQuality,
  DepthOfFieldQualityValue,
  type DepthOfFieldSide,
  DepthOfFieldSideValue,
  depthOfFieldQualityFromF32,
  depthOfFieldSideFromF32,
} from '../../components/depth-of-field';

export const DEPTH_OF_FIELD_PARAMS_BYTE_SIZE = 64;

// Camera component values cross the UBO boundary as f32. Keep bounds in that
// same representation so the authored decimal boundary 0.7 remains valid
// after quantization.
const MIN_F_STOP = Math.fround(0.7);
const MAX_F_STOP = Math.fround(32);

export interface DepthOfFieldParams {
  readonly focusDistance: number;
  readonly fStop: number;
  readonly sensorHeight: number;
  readonly maxRadiusPixels: number;
  readonly quality: DepthOfFieldQuality;
  readonly blurSide: DepthOfFieldSide;
  readonly focalLength: number;
}

export const DEFAULT_DEPTH_OF_FIELD_PARAMS: DepthOfFieldParams = Object.freeze({
  focusDistance: 8,
  fStop: 2.8,
  sensorHeight: 0.024,
  maxRadiusPixels: 16,
  quality: 'medium',
  blurSide: 'both',
  focalLength: 0,
});

function quantizeF32(value: number): number {
  return Math.fround(value);
}

export type DepthOfFieldErrorCode =
  | 'depth-of-field-invalid-params'
  | 'depth-of-field-orthographic-unsupported';

export interface DepthOfFieldInvalidParamsDetail {
  readonly field: string;
  readonly value: unknown;
  readonly expected: string;
  readonly bound?: readonly [number, number] | undefined;
}

export interface DepthOfFieldOrthographicDetail {
  readonly projection: 'orthographic';
}

export type DepthOfFieldErrorDetail =
  | DepthOfFieldInvalidParamsDetail
  | DepthOfFieldOrthographicDetail;

/** Detached validation facts carried from extract to renderer inspection. */
export interface DepthOfFieldRequestFailure {
  readonly code: DepthOfFieldErrorCode;
  readonly detail: DepthOfFieldErrorDetail;
  readonly expected: string;
  readonly hint: string;
}

export class DepthOfFieldValidationError extends Error {
  readonly code: DepthOfFieldErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DepthOfFieldErrorDetail;

  constructor(
    code: DepthOfFieldErrorCode,
    detail: DepthOfFieldErrorDetail,
    expected: string,
    hint: string,
  ) {
    super(`${code}: ${expected}`);
    this.name = 'DepthOfFieldValidationError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export function depthOfFieldRequestFailure(
  error: DepthOfFieldValidationError,
): DepthOfFieldRequestFailure {
  return Object.freeze({
    code: error.code,
    detail: error.detail,
    expected: error.expected,
    hint: error.hint,
  });
}

/**
 * Resolve the params used by a frame when authoring validation failed.
 * Invalid/unsupported requests stay visible as errors, but an already
 * accepted DoF graph must keep receiving its last-known-good UBO until the
 * author submits a valid replacement or explicitly removes the component.
 */
export function resolveDepthOfFieldFrameParams(
  requested: DepthOfFieldParams | undefined,
  requestFailure: DepthOfFieldRequestFailure | undefined,
  accepted: DepthOfFieldParams | undefined,
): DepthOfFieldParams | undefined {
  if (requested !== undefined) return requested;
  if (
    requestFailure === undefined ||
    requestFailure.code === 'depth-of-field-orthographic-unsupported'
  ) {
    return undefined;
  }
  return accepted;
}

export interface DepthOfFieldCameraInput {
  readonly projection: 'perspective' | 'orthographic';
  readonly fov: number;
  readonly near: number;
  readonly far: number;
}

function invalid(
  field: string,
  value: unknown,
  expected: string,
  bound?: readonly [number, number],
): DepthOfFieldValidationError {
  return new DepthOfFieldValidationError(
    'depth-of-field-invalid-params',
    { field, value, expected, ...(bound === undefined ? {} : { bound }) },
    expected,
    `set ${field} to ${expected}`,
  );
}

function focalLength(sensorHeight: number, fov: number): number {
  return sensorHeight / (2 * Math.tan(fov / 2));
}

function opticalCocScale(
  params: Pick<DepthOfFieldParams, 'focalLength' | 'sensorHeight' | 'fStop' | 'focusDistance'>,
): number {
  // This is evaluated on the CPU once per frame. Keep the ratios separate so
  // the final f32 coefficient does not inherit an avoidable focalLength^2
  // overflow.
  return (
    (params.focalLength / params.sensorHeight / (2 * params.fStop)) *
    (params.focalLength / (params.focusDistance - params.focalLength))
  );
}

function frameCocCoefficient(
  params: Pick<DepthOfFieldParams, 'focalLength' | 'sensorHeight' | 'fStop' | 'focusDistance'>,
  outputHeight: number,
): number {
  return quantizeF32(quantizeF32(outputHeight) * opticalCocScale(params));
}

interface DepthOfFieldFrameValues {
  readonly focusDistance: number;
  readonly fStop: number;
  readonly sensorHeight: number;
  readonly focalLength: number;
  readonly maxRadiusPixels: number;
  readonly outputHeight: number;
  readonly near: number;
  readonly far: number;
  readonly cocCoefficient: number;
}

function resolveDepthOfFieldFrameValues(
  params: DepthOfFieldParams,
  input: {
    readonly outputHeight: number;
    readonly near: number;
    readonly far: number;
    readonly useTemporalDepth: boolean;
  },
): Result<DepthOfFieldFrameValues, DepthOfFieldValidationError> {
  const focusDistance = quantizeF32(params.focusDistance);
  const fStop = quantizeF32(params.fStop);
  const sensorHeight = quantizeF32(params.sensorHeight);
  const focal = quantizeF32(params.focalLength);
  const maxRadiusPixels = quantizeF32(params.maxRadiusPixels);
  const outputHeight = quantizeF32(input.outputHeight);
  const near = quantizeF32(input.near);
  const far = quantizeF32(input.far);
  const finitePositiveFields: readonly [string, number, number][] = [
    ['focusDistance', focusDistance, params.focusDistance],
    ['sensorHeight', sensorHeight, params.sensorHeight],
    ['focalLength', focal, params.focalLength],
    ['near', near, input.near],
    ['far', far, input.far],
  ];
  for (const [field, value, raw] of finitePositiveFields) {
    if (!Number.isFinite(value) || value <= 0) {
      return err(invalid(field, raw, 'a finite positive f32 value'));
    }
  }
  if (!Number.isFinite(fStop) || fStop < MIN_F_STOP || fStop > MAX_F_STOP) {
    return err(
      invalid('fStop', params.fStop, 'a finite f32 value in [0.7, 32]', [MIN_F_STOP, MAX_F_STOP]),
    );
  }
  if (!Number.isFinite(maxRadiusPixels) || maxRadiusPixels < 0 || maxRadiusPixels > 32) {
    return err(
      invalid('maxRadiusPixels', params.maxRadiusPixels, 'a finite f32 value in [0, 32]', [0, 32]),
    );
  }
  if (!Number.isFinite(outputHeight) || outputHeight <= 0) {
    return err(invalid('outputHeight', input.outputHeight, 'a finite positive f32 value'));
  }
  if (far <= near) {
    return err(invalid('near/far', [input.near, input.far], 'finite f32 near > 0 and far > near'));
  }
  if (focusDistance <= focal) {
    return err(invalid('focusDistance', params.focusDistance, 'greater than focalLength in f32'));
  }

  // linearDepth() uses this ratio and denominator order in both WGSL
  // variants. Reject a ratio that disappears at f32 precision, then check the
  // far, mid and near raw-depth samples for finite denominators and
  // reconstructed distances. The denominator is strictly positive for valid
  // raw depth, so no world-unit epsilon belongs in the shader.
  const depthRatio = quantizeF32(near / far);
  if (!Number.isFinite(depthRatio) || depthRatio <= 0) {
    return err(invalid('near/far ratio', depthRatio, 'a finite positive f32 value'));
  }
  for (const raw of [quantizeF32(2 ** -149), 0.5, 1]) {
    const oneMinusRaw = quantizeF32(1 - raw);
    const weightedRatio = quantizeF32(oneMinusRaw * depthRatio);
    const denominator = quantizeF32(raw + weightedRatio);
    const distance = quantizeF32(near / denominator);
    if (
      !Number.isFinite(oneMinusRaw) ||
      oneMinusRaw < 0 ||
      !Number.isFinite(weightedRatio) ||
      !Number.isFinite(denominator) ||
      denominator <= 0 ||
      !Number.isFinite(distance) ||
      distance <= 0
    ) {
      return err(invalid('linearDepth', distance, 'finite positive f32 reconstruction'));
    }
  }

  const cocCoefficient = frameCocCoefficient(
    {
      focusDistance,
      fStop,
      sensorHeight,
      focalLength: focal,
    },
    outputHeight,
  );
  if (!Number.isFinite(cocCoefficient) || cocCoefficient <= 0) {
    return err(
      invalid('cocCoefficient', cocCoefficient, 'a finite positive value representable as f32'),
    );
  }
  // The shader evaluates C * (1 - focus / depth). Check each f32 operation at
  // the projection endpoints before the UBO is written.
  for (const [field, depth] of [
    ['near', near],
    ['far', far],
  ] as const) {
    const focusOverDepth = quantizeF32(focusDistance / depth);
    const depthFactor = quantizeF32(1 - focusOverDepth);
    const radius = quantizeF32(cocCoefficient * depthFactor);
    if (
      !Number.isFinite(focusOverDepth) ||
      !Number.isFinite(depthFactor) ||
      !Number.isFinite(radius)
    ) {
      return err(invalid(`coc.${field}`, radius, 'a finite value representable as f32'));
    }
  }

  return ok({
    focusDistance,
    fStop,
    sensorHeight,
    focalLength: focal,
    maxRadiusPixels,
    outputHeight,
    near,
    far,
    cocCoefficient,
  });
}

/**
 * Validate the values that cross the f32 camera UBO boundary for one frame.
 * Camera and DoF schemas already use f32 columns, but direct callers and
 * synthetic frame tests can still supply wider JS numbers. Quantize first so
 * admission and the WGSL consumer make the same decision.
 */
export function validateDepthOfFieldFrameParams(
  params: DepthOfFieldParams,
  input: {
    readonly outputHeight: number;
    readonly near: number;
    readonly far: number;
    readonly useTemporalDepth: boolean;
  },
): Result<void, DepthOfFieldValidationError> {
  const resolved = resolveDepthOfFieldFrameValues(params, input);
  return resolved.ok ? ok(undefined) : resolved;
}

/**
 * Validate and derive one camera DoF declaration at the frame admission seam.
 * The returned focal length is a derived fact; callers never author it.
 */
export function validateDepthOfFieldParams(
  input: Partial<DepthOfFieldData> | undefined,
  camera?: DepthOfFieldCameraInput,
): Result<DepthOfFieldParams, DepthOfFieldValidationError> {
  if (camera?.projection === 'orthographic') {
    return err(
      new DepthOfFieldValidationError(
        'depth-of-field-orthographic-unsupported',
        { projection: 'orthographic' },
        'DepthOfField requires a perspective Camera',
        'use a perspective Camera or remove the DepthOfField component',
      ),
    );
  }
  const value = input ?? {};
  const focusDistance = quantizeF32(
    value.focusDistance ?? DEFAULT_DEPTH_OF_FIELD_PARAMS.focusDistance,
  );
  const fStop = quantizeF32(value.fStop ?? DEFAULT_DEPTH_OF_FIELD_PARAMS.fStop);
  const sensorHeight = quantizeF32(
    value.sensorHeight ?? DEFAULT_DEPTH_OF_FIELD_PARAMS.sensorHeight,
  );
  const maxRadiusPixels = quantizeF32(
    value.maxRadiusPixels ?? DEFAULT_DEPTH_OF_FIELD_PARAMS.maxRadiusPixels,
  );
  const qualityValue = quantizeF32(value.quality ?? DepthOfFieldQualityValue.medium);
  const blurSideValue = quantizeF32(value.blurSide ?? DepthOfFieldSideValue.both);
  const quality = depthOfFieldQualityFromF32(qualityValue);
  const blurSide = depthOfFieldSideFromF32(blurSideValue);
  if (!Number.isFinite(focusDistance) || focusDistance <= 0) {
    return err(
      invalid('focusDistance', value.focusDistance ?? focusDistance, 'a finite positive f32 value'),
    );
  }
  if (!Number.isFinite(fStop) || fStop < MIN_F_STOP || fStop > MAX_F_STOP) {
    return err(
      invalid('fStop', value.fStop ?? fStop, 'a finite f32 value in [0.7, 32]', [
        MIN_F_STOP,
        MAX_F_STOP,
      ]),
    );
  }
  if (!Number.isFinite(sensorHeight) || sensorHeight <= 0) {
    return err(
      invalid('sensorHeight', value.sensorHeight ?? sensorHeight, 'a finite positive f32 value'),
    );
  }
  if (!Number.isFinite(maxRadiusPixels) || maxRadiusPixels < 0 || maxRadiusPixels > 32) {
    return err(
      invalid(
        'maxRadiusPixels',
        value.maxRadiusPixels ?? maxRadiusPixels,
        'a finite f32 value in [0, 32]',
        [0, 32],
      ),
    );
  }
  if (quality === undefined) {
    return err(invalid('quality', qualityValue, 'DepthOfFieldQualityValue.low, medium, or high'));
  }
  if (blurSide === undefined) {
    return err(invalid('blurSide', blurSideValue, 'DepthOfFieldSideValue.both, near, or far'));
  }

  let focal = DEFAULT_DEPTH_OF_FIELD_PARAMS.focalLength;
  if (camera !== undefined) {
    const fov = quantizeF32(camera.fov);
    const near = quantizeF32(camera.near);
    const far = quantizeF32(camera.far);
    if (!Number.isFinite(fov) || fov <= 0 || fov >= Math.PI) {
      return err(invalid('fov', camera.fov, 'a finite f32 value in (0, PI)'));
    }
    if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
      return err(
        invalid('near/far', [camera.near, camera.far], 'finite f32 near > 0 and far > near'),
      );
    }
    focal = quantizeF32(focalLength(sensorHeight, fov));
    if (!Number.isFinite(focal) || focal <= 0) {
      return err(invalid('focalLength', focal, 'a finite positive f32 value'));
    }
    if (focusDistance < near || focusDistance > far) {
      return err(
        invalid('focusDistance', focusDistance, `a value in [${near}, ${far}]`, [near, far]),
      );
    }
    if (focusDistance <= focal) {
      return err(
        invalid('focusDistance', focusDistance, `greater than focalLength in f32 (${focal})`),
      );
    }
  }
  return ok(
    Object.freeze({
      focusDistance,
      fStop,
      sensorHeight,
      maxRadiusPixels,
      quality,
      blurSide,
      focalLength: focal,
    }),
  );
}

export function resolveDepthOfFieldParams(
  input: Partial<DepthOfFieldData> | undefined,
  camera?: DepthOfFieldCameraInput,
): Result<DepthOfFieldParams | undefined, DepthOfFieldValidationError> {
  if (input === undefined) return ok(undefined);
  return validateDepthOfFieldParams(input, camera);
}

export function depthOfFieldTapCount(quality: DepthOfFieldQuality): 16 | 32 | 64 {
  switch (quality) {
    case 'low':
      return 16;
    case 'medium':
      return 32;
    case 'high':
      return 64;
  }
}

export function depthOfFieldSideCode(side: DepthOfFieldSide): 0 | 1 | 2 {
  switch (side) {
    case 'both':
      return DepthOfFieldSideValue.both;
    case 'near':
      return DepthOfFieldSideValue.near;
    case 'far':
      return DepthOfFieldSideValue.far;
  }
}

export function depthOfFieldQualityCode(quality: DepthOfFieldQuality): 0 | 1 | 2 {
  switch (quality) {
    case 'low':
      return DepthOfFieldQualityValue.low;
    case 'medium':
      return DepthOfFieldQualityValue.medium;
    case 'high':
      return DepthOfFieldQualityValue.high;
  }
}

/** Signed thin-lens circle-of-confusion radius in final output pixels. */
export function signedDepthOfFieldCoC(
  params: Pick<DepthOfFieldParams, 'focalLength' | 'sensorHeight' | 'fStop' | 'focusDistance'> &
    Partial<Pick<DepthOfFieldParams, 'maxRadiusPixels'>>,
  viewDepth: number,
  outputHeight: number,
): number {
  if (
    !Number.isFinite(viewDepth) ||
    viewDepth <= 0 ||
    !Number.isFinite(outputHeight) ||
    outputHeight <= 0 ||
    !Number.isFinite(params.focalLength) ||
    params.focalLength <= 0 ||
    !Number.isFinite(params.sensorHeight) ||
    params.sensorHeight <= 0 ||
    !Number.isFinite(params.fStop) ||
    params.fStop <= 0 ||
    !Number.isFinite(params.focusDistance) ||
    params.focusDistance <= params.focalLength
  ) {
    return 0;
  }
  const focusDistance = quantizeF32(params.focusDistance);
  const depth = quantizeF32(viewDepth);
  const focalLength = quantizeF32(params.focalLength);
  const sensorHeight = quantizeF32(params.sensorHeight);
  const fStop = quantizeF32(params.fStop);
  const coefficient = frameCocCoefficient(
    { focusDistance, focalLength, sensorHeight, fStop },
    outputHeight,
  );
  const depthFactor = quantizeF32(1 - quantizeF32(focusDistance / depth));
  const radius = quantizeF32(coefficient * depthFactor);
  const limit = Number.isFinite(params.maxRadiusPixels)
    ? quantizeF32(params.maxRadiusPixels as number)
    : Number.POSITIVE_INFINITY;
  return Math.max(-limit, Math.min(limit, Number.isFinite(radius) ? radius : 0));
}

/** Pack the one renderer-owned per-frame DoF UBO (4 x vec4, 64 bytes). */
export function packDepthOfFieldParams(
  params: DepthOfFieldParams,
  input: {
    readonly outputHeight: number;
    readonly near: number;
    readonly far: number;
    readonly useTemporalDepth: boolean;
  },
): Uint8Array {
  const frameValues = resolveDepthOfFieldFrameValues(params, input);
  if (!frameValues.ok) throw frameValues.error;
  const {
    focusDistance,
    fStop,
    sensorHeight,
    focalLength: focal,
    outputHeight,
    maxRadiusPixels,
    near,
    far,
    cocCoefficient,
  } = frameValues.value;
  const payload = new Float32Array(DEPTH_OF_FIELD_PARAMS_BYTE_SIZE / 4);
  // row3.x is the frame CoC coefficient; the remaining reserved lanes stay
  // zero so the existing 64-byte binding contract remains unchanged.
  payload.set([
    focusDistance,
    fStop,
    sensorHeight,
    focal,
    outputHeight,
    maxRadiusPixels,
    depthOfFieldSideCode(params.blurSide),
    depthOfFieldQualityCode(params.quality),
    near,
    far,
    input.useTemporalDepth ? 1 : 0,
    0, // row2.w reserved
    cocCoefficient, // row3.x / WGSL reserved.x
    0,
    0,
    0,
  ]);
  return new Uint8Array(payload.buffer);
}
