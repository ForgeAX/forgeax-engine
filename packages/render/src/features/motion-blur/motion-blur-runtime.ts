import type { MotionBlurExecutionReceipt, MotionBlurInspection } from '../../inspection-types';
import type { CameraSnapshot } from '../../render-contract';
import type { TemporalFrameTransactionInspection } from '../../temporal/frame';
import type { TemporalView } from '../../temporal/view';
import type { MotionBlurFeatureInput } from './motion-blur-feature';
import {
  DEFAULT_MOTION_BLUR_PARAMS,
  effectiveMotionBlurSampleCount,
  isMotionBlurIntervalValid,
  type MotionBlurValidationError,
  motionBlurSampleDelta,
  motionBlurTemporalDemand,
} from './motion-blur-params';

export interface MotionBlurRuntimeCapabilities {
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly storageTexture: boolean;
  readonly rgba16floatRenderable: boolean;
}

export interface MotionBlurFramePlan {
  readonly rawSampleDelta: number;
  readonly demanded: boolean;
  readonly featureInput: MotionBlurFeatureInput | undefined;
}

export interface MotionBlurDrawOptions {
  readonly sampleTimeSeconds?: number;
  readonly temporalReset?: true;
}

export function motionBlurDrawOptions(input: {
  readonly sampleTimeSeconds?: number;
  readonly temporalReset?: boolean;
}): MotionBlurDrawOptions {
  return {
    ...(input.sampleTimeSeconds === undefined
      ? {}
      : { sampleTimeSeconds: input.sampleTimeSeconds }),
    ...(input.temporalReset === true ? { temporalReset: true as const } : {}),
  };
}

/** Derive one motion-blur temporal plan before the record transaction starts. */
export function planMotionBlurFrame(input: {
  readonly params: CameraSnapshot['motionBlur'];
  readonly sampleTimeSeconds: number | undefined;
  readonly acceptedSampleTimeSeconds: number | undefined;
  readonly fallbackDeltaSeconds: number;
  readonly acceptedTemporal: TemporalView | undefined;
  readonly temporalReset: boolean;
  readonly width: number;
  readonly height: number;
  readonly cameraViewIdentity: string;
  readonly historyVersion: number;
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly deviceGeneration: number;
}): MotionBlurFramePlan {
  const rawSampleDelta = motionBlurSampleDelta(
    input.sampleTimeSeconds,
    input.acceptedSampleTimeSeconds,
    input.fallbackDeltaSeconds,
  );
  const accepted = input.acceptedTemporal;
  const reset =
    input.temporalReset ||
    accepted === undefined ||
    (accepted.historyValid === false && accepted.resetReason === undefined) ||
    !isMotionBlurIntervalValid(rawSampleDelta) ||
    accepted.input.width !== input.width ||
    accepted.input.height !== input.height ||
    accepted.input.viewIdentity !== input.cameraViewIdentity ||
    accepted.input.historyVersion !== input.historyVersion ||
    accepted.input.environmentSignature !== input.environmentSignature ||
    accepted.input.fogSignature !== input.fogSignature ||
    accepted.input.deviceGeneration !== input.deviceGeneration;
  const params =
    input.params === undefined
      ? undefined
      : { ...input.params, targetFps: input.params.targetFps ?? 60 };
  const demanded = motionBlurTemporalDemand(params);
  return {
    rawSampleDelta,
    demanded,
    featureInput:
      params === undefined
        ? undefined
        : {
            params,
            frameDeltaSeconds: rawSampleDelta,
            reset: demanded && reset,
          },
  };
}

/** Project the bounded inspection record without exposing renderer internals. */
export function projectMotionBlurInspection(input: {
  readonly camera: CameraSnapshot | undefined;
  readonly invalidParams: MotionBlurValidationError | undefined;
  readonly capabilities: MotionBlurRuntimeCapabilities;
  readonly acceptedTemporal: TemporalView | undefined;
  readonly transaction: TemporalFrameTransactionInspection;
  readonly execution: MotionBlurExecutionReceipt | undefined;
  readonly temporalFrameId: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}): MotionBlurInspection | undefined {
  if (input.camera?.motionBlur === undefined && input.invalidParams === undefined) {
    return undefined;
  }
  const motionBlur =
    input.camera?.motionBlur === undefined
      ? DEFAULT_MOTION_BLUR_PARAMS
      : { ...input.camera.motionBlur, targetFps: input.camera.motionBlur.targetFps ?? 60 };
  const demanded = motionBlurTemporalDemand(motionBlur);
  const unavailable = demanded && !input.capabilities.rgba16floatRenderable;
  const lane =
    input.capabilities.compute &&
    input.capabilities.storageBuffer &&
    input.capabilities.storageTexture &&
    input.capabilities.rgba16floatRenderable
      ? ('compute' as const)
      : ('raster-limited' as const);
  const accepted = input.acceptedTemporal;
  const submitFailure =
    input.transaction.lastFailure === 'queue-submit-failed' ||
    accepted?.resetReason === 'submit-failure';
  const execution = input.execution;
  const executionAccepted =
    execution !== undefined &&
    input.temporalFrameId === execution.frameId &&
    execution.deviceGeneration === input.deviceGeneration &&
    execution.graphGeneration === input.graphGeneration;
  const active =
    demanded &&
    !unavailable &&
    lane === 'compute' &&
    executionAccepted &&
    accepted?.historyValid === true &&
    accepted.resetReason === undefined;
  return {
    enabled: demanded,
    status:
      input.invalidParams !== undefined
        ? 'invalid'
        : !demanded
          ? 'off'
          : active
            ? 'active'
            : !unavailable && lane === 'raster-limited'
              ? 'limited'
              : 'reset',
    lane,
    shutterAngle: motionBlur.shutterAngle,
    maxRadiusPixels: motionBlur.maxRadiusPixels,
    sampleCount: motionBlur.sampleCount,
    targetFps: motionBlur.targetFps ?? 60,
    effectiveSampleCount: !demanded ? 0 : effectiveMotionBlurSampleCount(motionBlur.sampleCount),
    temporalDemand: demanded ? 'scene-data-temporal-v1' : 'none',
    passName: 'motion-blur',
    historyWrites: 0,
    passCount: !demanded ? 0 : executionAccepted ? 2 : lane === 'raster-limited' ? 1 : 0,
    tapBudget: !demanded ? 0 : effectiveMotionBlurSampleCount(motionBlur.sampleCount),
    ...(executionAccepted ? { execution } : {}),
    ...(accepted?.resetReason === undefined ? {} : { resetReason: accepted.resetReason }),
    ...(input.invalidParams !== undefined
      ? { lastFailure: 'invalid-params' as const }
      : unavailable
        ? { lastFailure: 'scene-data-unavailable' as const }
        : submitFailure
          ? { lastFailure: 'submit-failure' as const }
          : {}),
  };
}
