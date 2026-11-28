import type { Antialias } from '../components/camera';
import { isTemporalAntialias } from '../components/camera';

type Jitter = readonly [number, number];

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

/** Subpixel offset of one temporal sample, `Halton(i + 1, 2|3) - 0.5` in input pixels. */
export function temporalJitterSample(sampleIndex: number): Jitter {
  const index = Math.trunc(sampleIndex) + 1;
  return Object.freeze([halton(index, 2) - 0.5, halton(index, 3) - 0.5]) as Jitter;
}

// UE 5.8.1 SceneVisibility.cpp:5276-5281.
const FIRST_PRIMES = Object.freeze([
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
  101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193,
  197, 199, 211, 223, 227, 229, 233, 239, 241, 251,
]);

/**
 * Temporal sequence length, following UE 5.8.1 SceneVisibility.cpp:5252-5296
 * with r.TemporalAASamples=8 and r.TemporalAAScaleSamples=1: scale by the
 * inverse squared resolution fraction so every output pixel keeps a constant
 * sample density, and for TSR round up to a prime to break coherence with
 * power-of-two frame-index sequences.
 */
export function temporalJitterSampleCount(mode: 'taa' | 'tsr', resolutionFraction: number): number {
  const count = Math.round(8 * Math.max(1, 1 / (resolutionFraction * resolutionFraction)));
  if (mode === 'taa') return count;
  for (let id = Math.max(4, Math.trunc((count - 1) / 5)); id < FIRST_PRIMES.length; id++) {
    const prime = FIRST_PRIMES[id] as number;
    if (prime >= count) return prime;
  }
  return count;
}

/**
 * Automatic view material texture mip bias, following UE 5.8.1
 * SceneVisibility.cpp:5336-5351 with r.ViewTextureMipBias.Offset=-0.3,
 * .Min=-2 and .Quantization=1024. Temporal accumulation integrates the
 * jittered samples, so surface textures are sampled sharper than the input
 * pixel footprint: -0.296875 at 100%, -1.296875 at 50%.
 */
export function temporalMaterialTextureMipBias(resolutionFraction: number): number {
  const bias = -Math.max(-Math.log2(resolutionFraction), 0) - 0.3;
  const clamped = Math.min(Math.max(Math.max(bias, -2), -4), 4);
  const step = 8 / 1024;
  return Math.ceil(clamped / step) * step;
}

function temporalJitter(
  mode: 'off' | 'taa' | 'tsr',
  frameIndex: number,
  resolutionFraction: number,
): Jitter | undefined {
  if (mode === 'off') return undefined;
  return temporalJitterSample(frameIndex % temporalJitterSampleCount(mode, resolutionFraction));
}

function viewMaterialTextureMipBias(
  mode: 'off' | 'taa' | 'tsr',
  resolutionFraction: number,
): number {
  return mode === 'off' ? 0 : temporalMaterialTextureMipBias(resolutionFraction);
}

export type TemporalResetReason =
  | 'first-frame'
  | 'resize'
  | 'camera-cut'
  | 'history-version'
  | 'view-switch'
  | 'environment-change'
  | 'fog-change'
  | 'time-discontinuity'
  | 'device-recover'
  | 'submit-failure';

export interface TemporalViewInput {
  readonly antialias: Antialias;
  readonly width: number;
  readonly height: number;
  /** Internal scene extent used to normalize TAA jitter for TAAU. */
  readonly internalWidth?: number;
  readonly internalHeight?: number;
  readonly frameIndex?: number;
  readonly historyVersion?: number;
  readonly viewIdentity?: string;
  readonly environmentSignature?: string;
  readonly fogSignature?: string;
  readonly deviceGeneration?: number;
  readonly cameraCut?: boolean;
  readonly historyValid?: boolean;
  readonly currentUnjitteredViewProjection?: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection?: ArrayLike<number> | undefined;
  readonly currentCameraPosition?: readonly [number, number, number] | undefined;
  readonly previousCameraPosition?: readonly [number, number, number] | undefined;
  /** Monotonic accepted sample time used to bridge failed render attempts. */
  readonly sampleTimeSeconds?: number | undefined;
  readonly resetReason?: TemporalResetReason | undefined;
}

interface TemporalViewSnapshot {
  readonly antialias: Antialias;
  readonly width: number;
  readonly height: number;
  /** Internal scene extent used for TAAU jitter normalization. */
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly frameIndex: number;
  readonly historyVersion: number;
  readonly viewIdentity: string;
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly deviceGeneration: number;
  readonly cameraCut: boolean;
  readonly historyValid: boolean;
  readonly currentUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly currentCameraPosition: readonly [number, number, number] | undefined;
  readonly previousCameraPosition: readonly [number, number, number] | undefined;
  readonly sampleTimeSeconds: number | undefined;
  readonly resetReason: TemporalResetReason | undefined;
}

export interface TemporalView {
  readonly input: Readonly<TemporalViewSnapshot>;
  readonly historyVersion: number;
  readonly mode: 'off' | 'taa' | 'tsr';
  readonly jitter: readonly [number, number] | undefined;
  readonly jitterCancellationUv: readonly [number, number] | undefined;
  readonly currentJitterUv: readonly [number, number] | undefined;
  /** Surface texture mip bias of the display view; zero without temporal AA. */
  readonly materialTextureMipBias: number;
  readonly historyValid: boolean;
  readonly temporalFrameIndex: number;
  /** Unjittered matrices are supplied by the renderer projection owner. */
  readonly currentUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection: ArrayLike<number> | undefined;
  /** Camera origins follow the same accepted-submit boundary as the matrices. */
  readonly currentCameraPosition: readonly [number, number, number] | undefined;
  readonly previousCameraPosition: readonly [number, number, number] | undefined;
  /** Monotonic accepted sample time used to bridge failed render attempts. */
  readonly sampleTimeSeconds: number | undefined;
  readonly currentProjection: 'jittered' | 'unjittered';
  readonly previousProjection: 'unjittered';
  readonly historyRequired: boolean;
  readonly resetReason: TemporalResetReason | undefined;
}

function validDimension(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

export function createTemporalView(input: TemporalViewInput): TemporalView {
  const width = validDimension(input.width, 'width');
  const height = validDimension(input.height, 'height');
  const internalWidth = validDimension(input.internalWidth ?? width, 'internalWidth');
  const internalHeight = validDimension(input.internalHeight ?? height, 'internalHeight');
  const historyVersion = input.historyVersion ?? 0;
  const frameIndex = input.frameIndex ?? 0;
  const deviceGeneration = input.deviceGeneration ?? 0;
  if (!Number.isSafeInteger(historyVersion) || historyVersion < 0) {
    throw new RangeError('historyVersion must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError('frameIndex must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0) {
    throw new RangeError('deviceGeneration must be a non-negative safe integer.');
  }
  const normalized: TemporalViewSnapshot = Object.freeze({
    ...input,
    width,
    height,
    internalWidth,
    internalHeight,
    frameIndex,
    historyVersion,
    viewIdentity: input.viewIdentity ?? 'camera:default',
    environmentSignature: input.environmentSignature ?? '',
    fogSignature: input.fogSignature ?? '',
    deviceGeneration,
    cameraCut: input.cameraCut ?? false,
    historyValid: input.historyValid ?? false,
    currentUnjitteredViewProjection: input.currentUnjitteredViewProjection,
    previousUnjitteredViewProjection: input.previousUnjitteredViewProjection,
    currentCameraPosition: input.currentCameraPosition,
    previousCameraPosition: input.previousCameraPosition,
    sampleTimeSeconds: input.sampleTimeSeconds,
    resetReason: input.resetReason,
  });
  const mode = isTemporalAntialias(input.antialias) ? input.antialias : 'off';
  const taa = mode !== 'off';
  // UE measures the fraction horizontally (ViewRect / SecondaryViewRectSize).
  const resolutionFraction = internalWidth / width;
  const jitter = temporalJitter(mode, frameIndex, resolutionFraction);
  const jitterUv: Jitter | undefined =
    jitter === undefined
      ? undefined
      : (Object.freeze([jitter[0] / internalWidth, jitter[1] / internalHeight]) as Jitter);
  return Object.freeze({
    input: normalized,
    historyVersion,
    mode,
    jitter,
    jitterCancellationUv: jitterUv,
    currentJitterUv: jitterUv,
    materialTextureMipBias: viewMaterialTextureMipBias(mode, resolutionFraction),
    historyValid: normalized.historyValid,
    temporalFrameIndex: frameIndex,
    currentUnjitteredViewProjection: input.currentUnjitteredViewProjection,
    previousUnjitteredViewProjection: input.previousUnjitteredViewProjection,
    currentCameraPosition: input.currentCameraPosition,
    previousCameraPosition: input.previousCameraPosition,
    sampleTimeSeconds: input.sampleTimeSeconds,
    currentProjection: taa ? 'jittered' : 'unjittered',
    previousProjection: 'unjittered',
    historyRequired: taa,
    resetReason: input.resetReason,
  });
}

/** Classify input changes before publishing the one finalized TemporalView. */
export function resolveTemporalReset(
  before: TemporalView['input'] | undefined,
  after: TemporalView['input'],
): TemporalResetReason | undefined {
  // Motion Blur uses the unjittered `off` temporal mode as well as TAA. Keep
  // the reset matrix shared so a camera switch, resize, or recovery cannot
  // leak a previous motion vector merely because antialiasing is disabled.
  if (before === undefined) return 'first-frame';
  if (isTemporalAntialias(after.antialias) && before.antialias !== after.antialias)
    return 'first-frame';
  if (before.width !== after.width || before.height !== after.height) return 'resize';
  if (after.cameraCut) return 'camera-cut';
  if (before.historyVersion !== after.historyVersion) return 'history-version';
  if (before.viewIdentity !== after.viewIdentity) return 'view-switch';
  if (before.deviceGeneration !== after.deviceGeneration) return 'device-recover';
  // Lighting-only reasons come last: reaching them proves the view geometry is
  // continuous, so geometry-keyed histories may keep reprojecting.
  if (before.environmentSignature !== after.environmentSignature) return 'environment-change';
  if (before.fogSignature !== after.fogSignature) return 'fog-change';
  return undefined;
}
