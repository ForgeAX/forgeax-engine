// Display-frame temporal state: the sample clock, the TAA / Motion Blur
// temporal view with its reset reason, and the camera-owned post-process
// parameters projected from that view at record time.

import { mat4 } from '@forgeax/engine-math';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { BARREL_DISTORTION_POST_PROCESS_ID } from '../features/barrel-distortion';
import {
  DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS,
  DEPTH_OF_FIELD_POST_PROCESS_IDS,
} from '../features/depth-of-field/depth-of-field-feature';
import { packDepthOfFieldParams } from '../features/depth-of-field/depth-of-field-params';
import { LENS_EFFECTS_POST_PROCESS_ID, packLensEffectsParams } from '../features/lens-effects';
import { LENS_FLARE_PROGRAMS, packLensFlareParams } from '../features/lens-flare';
import {
  effectiveMotionBlurSampleCount,
  isMotionBlurIntervalValid,
  MOTION_BLUR_PARAMS_BYTE_SIZE,
  motionBlurExposureScale,
  motionBlurSampleDelta,
  motionBlurTemporalDemand,
} from '../features/motion-blur/motion-blur-params';
import { OUTPUT_GAMUT_CODE } from '../output-color-space';
import type { RenderExtent } from '../pipeline/render-extent';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderTime } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import type { TemporalCommitOutcome } from '../temporal/frame';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import { createTemporalView, resolveTemporalReset, type TemporalView } from '../temporal/view';
import {
  packBarrelDistortionParams,
  type resolveSubmittedBarrelMapping,
} from './barrel-distortion-frame';
import type { RenderFrameState } from './frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';
import type { RenderSystemInternals } from './render-context';

export interface FrameClockSample {
  readonly deltaSeconds: number;
  readonly elapsedSeconds: number | undefined;
  /** Explicit host/replay clock was present but invalid. */
  readonly invalidSampleTime: boolean;
}

/** Read the render sample clock from the camera's composition world once per frame. */
export function frameClockSample(
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  sampleTimeSeconds?: number,
): FrameClockSample {
  const owner = worlds[camera.worldId ?? 0] ?? world;
  const invalidSampleTime = sampleTimeSeconds !== undefined && !Number.isFinite(sampleTimeSeconds);
  try {
    const clock = renderTime(owner);
    return {
      deltaSeconds: Number.isFinite(clock.delta) ? Math.max(0, clock.delta) : 0,
      // Keep the raw host sample even when ECS accepted only a clamped
      // simulation delta. Temporal admission compares this value with the
      // last successfully submitted sample and therefore sees real hitches.
      elapsedSeconds:
        sampleTimeSeconds === undefined
          ? Number.isFinite(clock.elapsed)
            ? clock.elapsed
            : undefined
          : Number.isFinite(sampleTimeSeconds)
            ? sampleTimeSeconds
            : undefined,
      invalidSampleTime,
    };
  } catch {
    // Test and recovery callers may provide a minimal RenderResourceScope-shaped owner. An
    // absent clock is an invalid temporal pair and therefore safely resets.
    return {
      deltaSeconds: 0,
      elapsedSeconds: Number.isFinite(sampleTimeSeconds) ? sampleTimeSeconds : undefined,
      invalidSampleTime,
    };
  }
}

function motionBlurDemandFor(camera: CameraSnapshot): boolean {
  return camera.motionBlur === undefined
    ? false
    : motionBlurTemporalDemand({
        shutterAngle: camera.motionBlur.shutterAngle,
        maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
        sampleCount: camera.motionBlur.sampleCount,
        targetFps: camera.motionBlur.targetFps ?? 60,
      });
}

/**
 * An off MB-only frame still carries an unjittered temporal view so the
 * accepted sample clock remains observable. Its history flag is false,
 * however, and must form a new baseline when the effect is enabled again.
 * A reset frame already has an explicit reason and is the valid baseline for
 * the following pair, so it is deliberately excluded here.
 */
function motionBlurFirstFrame(
  camera: CameraSnapshot,
  motionBlurDemand: boolean,
  previous: TemporalView | undefined,
): boolean {
  return (
    motionBlurDemand &&
    camera.antialias !== 'taa' &&
    (previous === undefined ||
      (previous.mode === 'off' && !previous.historyValid && previous.resetReason === undefined))
  );
}

function temporalCandidateFor(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  targetW: number,
  targetH: number,
  renderExtent: RenderExtent | undefined,
  clock: FrameClockSample,
  environmentSignature: string,
  fogSignature: string,
  currentUnjitteredViewProjection: Float32Array,
): TemporalView {
  return createTemporalView({
    antialias: camera.antialias,
    width: Math.max(1, targetW),
    height: Math.max(1, targetH),
    frameIndex: frameState.temporalView.frameIndex,
    viewIdentity: `camera:${camera.entityKey ?? 0}`,
    environmentSignature,
    fogSignature,
    deviceGeneration: internals.deviceScope?.generation ?? 0,
    ...(renderExtent === undefined
      ? {}
      : {
          internalWidth: renderExtent.internalWidth,
          internalHeight: renderExtent.internalHeight,
        }),
    ...(camera.historyVersion === undefined ? {} : { historyVersion: camera.historyVersion }),
    ...(clock.elapsedSeconds === undefined ? {} : { sampleTimeSeconds: clock.elapsedSeconds }),
    historyValid: false,
    currentUnjitteredViewProjection,
    currentCameraPosition: [
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
    ] as const,
  });
}

function clockResetReason(
  temporalReset: boolean,
  motionBlurDemand: boolean,
  intervalValid: boolean,
  firstFrame: boolean,
) {
  if (temporalReset || (motionBlurDemand && !intervalValid)) return 'time-discontinuity' as const;
  return firstFrame ? ('first-frame' as const) : undefined;
}

function reusedTemporalHistory(reusable: TemporalView | undefined) {
  return {
    ...(reusable?.currentUnjitteredViewProjection === undefined
      ? {}
      : { previousUnjitteredViewProjection: reusable.currentUnjitteredViewProjection }),
    ...(reusable?.currentCameraPosition === undefined
      ? {}
      : { previousCameraPosition: reusable.currentCameraPosition }),
  };
}

function pendingTemporalCommitFor(
  internals: RenderSystemInternals,
  cameraCount: number,
  environmentReady: boolean,
  view: TemporalView,
): TemporalCommitOutcome {
  if (cameraCount === 0 || !environmentReady || internals.deviceScope === undefined)
    return { kind: 'none' };
  return view.mode === 'taa' ? { kind: 'taa', view } : { kind: 'off', view };
}

/** Resolve this frame's temporal view and stage its pending commit. */
export function resolveFrameTemporal(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  cameraCount: number,
  targetW: number,
  targetH: number,
  renderExtent: RenderExtent | undefined,
  visibleSurfaceActive: boolean,
  clock: FrameClockSample,
  environmentSignature: string,
  fogSignature: string,
  environmentReady: boolean,
  temporalReset: boolean,
) {
  const previous = frameState.temporalView.accepted;
  const motionBlurDemand = motionBlurDemandFor(camera);
  const temporalDemand = standardSceneTemporalDemand(camera, visibleSurfaceActive);
  const deltaSeconds =
    temporalReset || clock.invalidSampleTime
      ? Number.NaN
      : motionBlurSampleDelta(
          clock.elapsedSeconds,
          previous?.sampleTimeSeconds,
          clock.deltaSeconds,
        );
  const intervalValid = isMotionBlurIntervalValid(deltaSeconds);
  const currentUnjitteredViewProjection = mat4.multiply(
    mat4.create(),
    computeProjectionMatrix(camera),
    computeViewMatrix(camera),
  );
  const candidate = temporalCandidateFor(
    internals,
    frameState,
    camera,
    targetW,
    targetH,
    renderExtent,
    clock,
    environmentSignature,
    fogSignature,
    currentUnjitteredViewProjection,
  );
  const resetReason =
    temporalDemand && environmentReady
      ? (resolveTemporalReset(previous, candidate) ??
        clockResetReason(
          temporalReset,
          motionBlurDemand,
          intervalValid,
          motionBlurFirstFrame(camera, motionBlurDemand, previous),
        ))
      : undefined;
  const reusable = resetReason === undefined ? previous : undefined;
  const view = createTemporalView({
    ...candidate.input,
    frameIndex: resetReason === undefined ? candidate.input.frameIndex : 0,
    // Motion Blur needs a finite positive pair before it can read the
    // baseline. TAA-only frames retain their existing temporal contract and
    // do not depend on the simulation clock being present in a test host.
    historyValid:
      temporalDemand &&
      environmentReady &&
      reusable !== undefined &&
      (!motionBlurDemand || intervalValid),
    resetReason,
    ...reusedTemporalHistory(reusable),
  });
  frameState.temporalView.stage(
    pendingTemporalCommitFor(internals, cameraCount, environmentReady, view),
  );
  return {
    view,
    previous,
    recordCamera: view.mode === 'taa' ? { ...camera, temporal: view } : camera,
    deltaSeconds,
    motionBlurDemand,
    continuousGeometry:
      reusable !== undefined ||
      resetReason === 'environment-change' ||
      resetReason === 'fog-change',
    currentUnjitteredViewProjection,
  };
}

/**
 * The negotiated surface color space is renderer state, not camera state:
 * stamp the effective output gamut into this frame's Output Transform
 * parameters so a fallback to sRGB never encodes P3 values into an sRGB surface.
 */
function stampOutputGamut(
  internals: RenderSystemInternals,
  extracted: ReadonlyMap<string, Uint8Array>,
  params: Map<string, Uint8Array>,
): void {
  const outputGamut = OUTPUT_GAMUT_CODE[internals.outputColorSpace?.report.effective ?? 'srgb'];
  if (outputGamut === 0) return;
  const extractedTonemap = extracted.get(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
  const tonemap = new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize);
  if (extractedTonemap !== undefined) tonemap.set(extractedTonemap.subarray(0, tonemap.byteLength));
  new DataView(tonemap.buffer).setUint32(
    TONEMAP_PARAMS_LAYOUT.outputGamutOffset,
    outputGamut,
    true,
  );
  params.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, tonemap);
}

function packMotionBlurFrameParams(
  motionBlur: NonNullable<CameraSnapshot['motionBlur']>,
  deltaSeconds: number,
  historyValid: boolean,
): Uint8Array {
  const motionBlurParams = new Uint8Array(MOTION_BLUR_PARAMS_BYTE_SIZE);
  const motionBlurView = new DataView(motionBlurParams.buffer);
  const uniformDeltaSeconds = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  motionBlurView.setFloat32(0, motionBlur.shutterAngle, true);
  motionBlurView.setFloat32(4, motionBlur.maxRadiusPixels, true);
  motionBlurView.setUint32(8, effectiveMotionBlurSampleCount(motionBlur.sampleCount), true);
  motionBlurView.setUint32(12, historyValid ? 0 : 1, true);
  motionBlurView.setFloat32(16, motionBlur.targetFps ?? 60, true);
  motionBlurView.setFloat32(
    20,
    motionBlurExposureScale(uniformDeltaSeconds, motionBlur.targetFps ?? 60),
    true,
  );
  motionBlurView.setFloat32(24, uniformDeltaSeconds, true);
  return motionBlurParams;
}

function setDepthOfFieldParams(
  params: Map<string, Uint8Array>,
  camera: CameraSnapshot,
  depthOfField: NonNullable<CameraSnapshot['depthOfField']>,
  targetH: number,
): void {
  const dofParams = packDepthOfFieldParams(depthOfField, {
    outputHeight: targetH,
    near: camera.near,
    far: camera.far,
    useTemporalDepth: camera.antialias === 'taa',
  });
  for (const id of [...DEPTH_OF_FIELD_POST_PROCESS_IDS, ...DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS]) {
    params.set(id, dofParams);
  }
}

/**
 * Camera-owned temporal controls are projected into the per-frame
 * post-process parameter map at record time. The extracted ECS map only
 * carries explicit PostProcessParams components; without this bridge the
 * builtin motion-blur pass receives its all-zero registration default.
 */
export function buildFramePostProcessParams(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  postProcessParams: ReadonlyMap<string, Uint8Array>,
  motionBlurDemand: boolean,
  deltaSeconds: number,
  temporalView: TemporalView,
  targetH: number,
  barrelMapping: ReturnType<typeof resolveSubmittedBarrelMapping>,
): Map<string, Uint8Array> {
  const params = new Map(postProcessParams);
  stampOutputGamut(internals, postProcessParams, params);
  if (camera.motionBlur !== undefined && motionBlurDemand) {
    params.set(
      'forgeax.motion-blur',
      packMotionBlurFrameParams(camera.motionBlur, deltaSeconds, temporalView.historyValid),
    );
  }
  if (camera.depthOfField !== undefined)
    setDepthOfFieldParams(params, camera, camera.depthOfField, targetH);
  if (
    camera.lensEffects !== undefined ||
    internals.getPostProcessParamsBuffer?.(LENS_EFFECTS_POST_PROCESS_ID) !== undefined
  ) {
    params.set(
      LENS_EFFECTS_POST_PROCESS_ID,
      packLensEffectsParams(camera.lensEffects, frameState.frameNumber),
    );
  }
  if (camera.lensFlare !== undefined) {
    const lensFlareParams = packLensFlareParams(camera.lensFlare);
    for (const program of LENS_FLARE_PROGRAMS) params.set(program.name, lensFlareParams);
  }
  if (barrelMapping !== undefined && barrelMapping.strength > 0) {
    params.set(BARREL_DISTORTION_POST_PROCESS_ID, packBarrelDistortionParams(barrelMapping));
  }
  return params;
}
