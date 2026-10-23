// Display-frame submission: the optional parts of the pass context grouped by
// their owner, the submission hooks that fence/track/commit every prepared
// owner, capture-only submission, and the post-submission promotions.

import type { RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { FrameRecording } from '../assembly/frame-recording';
import type { RenderTargetLayerWrite } from '../assembly/render-target-host';
import type { PlanarCaptureState } from '../capture/planar-state';
import { settleAtmospherePublish } from '../environment/storage';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type { DynamicResolutionController } from '../pipeline/dynamic-resolution';
import { gpuPassFrameMilliseconds } from '../pipeline/dynamic-resolution';
import type { RenderExtent } from '../pipeline/render-extent';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedLights, ExtractedVolumetricFog } from '../render-system-extract';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { projectVolumeCompositeBounds } from '../volume/composite-scissor';
import type {
  currentDirectionalShadowPublication,
  prepareDirectionalCascadeCadence,
} from './directional-cascade-cadence';
import {
  type prepareDirectionalShadowCache,
  type ShadowMeshInput,
  shadowMeshInputCurrent,
} from './directional-shadow-cache';
import type { CubeCaptureFrameInput, FrameRecordingAttempt, GpuDrivenRecordInput } from './frame';
import {
  commitDiffuseGi,
  diffuseGiFencesCurrent,
  type FrameDiffuseGi,
  hasDiffuseGiWork,
  trackDiffuseGi,
} from './frame-diffuse-gi';
import type { RenderFrameState, ValidatedRenderable } from './frame-snapshot';
import type { GpuTimingCapture } from './gpu-timing';
import type {
  _InternalRenderPipelineContext,
  PointsLinesRecordOwner,
  RenderSystemInternals,
} from './render-context';
import { reportSsrHistoryFailure } from './ssr-history-frame';

type ShadowPublication = ReturnType<typeof currentDirectionalShadowPublication>;
type CascadeCadence = ReturnType<typeof prepareDirectionalCascadeCadence>;

/** Frame-owned inputs that the scene passes consume beside the shared roster. */
export function scenePassInputs(
  camera: CameraSnapshot,
  gpuDriven: GpuDrivenRecordInput | undefined,
  scenePassWork: _InternalRenderPipelineContext['scenePassWork'],
  visibleSurface: VisibleSurfaceProjection | undefined,
  probePlacement: FrameDiffuseGi['probePlacement'],
) {
  return {
    ...(camera.antialias === 'taa' || gpuDriven?.cameraVisible === undefined
      ? {}
      : { cameraVisible: gpuDriven.cameraVisible }),
    ...(scenePassWork === undefined ? {} : { scenePassWork }),
    ...(visibleSurface === undefined ? {} : { visibleSurface }),
    ...(probePlacement === undefined ? {} : { probePlacement }),
  };
}

export function shaderSourcePassContext(internals: RenderSystemInternals) {
  return {
    ...(internals.volumetricFogShaders === undefined
      ? {}
      : { volumetricFogShaders: internals.volumetricFogShaders }),
    ...(internals.ssrShaders === undefined ? {} : { ssrShaders: internals.ssrShaders }),
    ...(internals.depthPyramidShaders === undefined
      ? {}
      : { depthPyramidShaders: internals.depthPyramidShaders }),
    ...(internals.atmosphereShaders === undefined
      ? {}
      : { atmosphereShaders: internals.atmosphereShaders }),
  };
}

function rasterShadowPassResources(
  raster: PreparedGpuDrivenFrame | undefined,
  selection: GpuDrawSelection,
  shadowArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
) {
  if (raster === undefined) return {};
  return {
    gpuDrivenSelection: selection,
    ...(shadowArtifacts === undefined
      ? {}
      : { gpuDrivenShadowPreparationArtifacts: shadowArtifacts }),
    gpuDrivenShadowViews: raster.shadowViewPool,
    shadowDirectRequired: raster.shadowDirectRequired,
    gpuDrivenShadowBatchProjections: raster.shadowBatchProjections,
  };
}

function preparedGpuDrivenPassResources(
  frameState: RenderFrameState,
  prepared: PreparedGpuDrivenFrame | undefined,
  raster: PreparedGpuDrivenFrame | undefined,
  selection: GpuDrawSelection,
  shadowArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
) {
  if (prepared === undefined) return {};
  const observation = frameState.surfaceSubmissionObservation;
  return {
    gpuDrivenStandardPbrFrameResources: {
      ...prepared.standardPbrFrameResources,
      ...(observation === undefined ? {} : { surfaceSubmissionObservation: observation }),
    },
    ...rasterShadowPassResources(raster, selection, shadowArtifacts),
  };
}

/** GPU-driven lane, prepared frame resources and retained scene tables. */
export function gpuDrivenPassContext(
  frameState: RenderFrameState,
  frameGpuDriven: GpuDrivenRecordInput | undefined,
  prepared: PreparedGpuDrivenFrame | undefined,
  raster: PreparedGpuDrivenFrame | undefined,
  selection: GpuDrawSelection,
  shadowArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
) {
  const scene = frameGpuDriven?.scene;
  return {
    ...(frameGpuDriven === undefined
      ? {}
      : { gpuDrivenGeometryLane: frameGpuDriven.geometryLane ?? 'automatic' }),
    ...preparedGpuDrivenPassResources(frameState, prepared, raster, selection, shadowArtifacts),
    ...(scene?.slotForEntity === undefined ? {} : { shadowSlotForEntity: scene.slotForEntity }),
    ...(scene === undefined ? {} : { gpuDrivenSceneMaterialBuffer: scene.scene.materialBuffer }),
  };
}

/** Display-only composite scissor over every available volume member. */
function compositeVolumeBounds(
  camera: CameraSnapshot,
  graphFog: ExtractedVolumetricFog | undefined,
  viewProjection: Float32Array,
) {
  if (
    camera.captureProjection !== undefined ||
    camera.target !== undefined ||
    camera.view !== undefined
  ) {
    return undefined;
  }
  if (graphFog?.status !== 'available' || graphFog.fog === undefined) return undefined;
  const additional = graphFog.additional ?? [];
  if (!additional.every((member) => member.status === 'available' && member.fog !== undefined))
    return undefined;
  return projectVolumeCompositeBounds(
    [
      graphFog.fog.bounds,
      ...additional.flatMap((member) => (member.fog === undefined ? [] : [member.fog.bounds])),
    ],
    viewProjection,
    camera.position,
  );
}

export function volumetricFogPassContext(
  camera: CameraSnapshot,
  active: VolumetricFogFrameContext | undefined,
  graphFog: ExtractedVolumetricFog | undefined,
  viewProjection: Float32Array,
) {
  if (active === undefined) return {};
  return {
    volumetricFog: {
      ...active,
      compositeProjectedBounds: compositeVolumeBounds(camera, graphFog, viewProjection),
    },
  };
}

export function capturePassContext(
  cubeCapture: CubeCaptureFrameInput | undefined,
  planarCapture: ReturnType<PlanarCaptureState['current']>,
) {
  return {
    ...(cubeCapture?.reflectionProbes === undefined
      ? {}
      : { reflectionProbes: cubeCapture.reflectionProbes }),
    ...(cubeCapture?.captureDispatch === undefined
      ? {}
      : { captureDispatch: cubeCapture.captureDispatch }),
    ...(planarCapture === undefined
      ? {}
      : { planarReflectionView: planarCapture.physical.resolveView }),
  };
}

/** Shadow caster rows, cadence and capsule inputs consumed by the shadow passes. */
export function shadowPassContext(
  projection: PersistentShadowCasterProjection | undefined,
  cascadeCadence: CascadeCadence | undefined,
  capsuleShadowLight: _InternalRenderPipelineContext['capsuleShadowLight'],
  publishShadowRows: boolean,
  shadowValidatedOrdered: readonly ValidatedRenderable[],
  shadowMaterialRowBase: number,
  shadowCasterWorldKeys: readonly number[] | undefined,
): Pick<
  Partial<_InternalRenderPipelineContext>,
  | 'shadowCasterBounds'
  | 'directionalShadowCascadeMiss'
  | 'capsuleShadowLight'
  | 'shadowValidatedOrdered'
  | 'shadowMaterialRowBase'
  | 'shadowDispatch'
  | 'shadowCasterWorldKeys'
> {
  return {
    ...(projection === undefined ? {} : { shadowCasterBounds: projection.worldBoundsOf }),
    ...(cascadeCadence?.cascadeMiss === undefined
      ? {}
      : { directionalShadowCascadeMiss: cascadeCadence.cascadeMiss }),
    ...(capsuleShadowLight === undefined ? {} : { capsuleShadowLight }),
    ...(publishShadowRows ? { shadowValidatedOrdered, shadowMaterialRowBase } : {}),
    ...(projection?.dispatch === undefined ? {} : { shadowDispatch: projection.dispatch }),
    ...(shadowCasterWorldKeys === undefined ? {} : { shadowCasterWorldKeys }),
  };
}

function submissionInputsCurrent(
  frameState: RenderFrameState,
  gi: FrameDiffuseGi,
  shadowPublication: ShadowPublication,
  nativeScene: PersistentGpuDrivenState | undefined,
  shadowMeshInput: ShadowMeshInput | undefined,
  shadowLodToken: object | undefined,
): boolean {
  return (
    diffuseGiFencesCurrent(gi) &&
    (shadowPublication === undefined || shadowPublication.isCurrent()) &&
    (nativeScene?.retained === undefined || nativeScene.retained.isSourceCurrent()) &&
    (shadowMeshInput === undefined ||
      (shadowMeshInputCurrent(shadowMeshInput) &&
        frameState.directionalShadowLod?.token === shadowLodToken))
  );
}

function commitSsrHistory(
  internals: RenderSystemInternals,
  owner: RenderFrameState['ssrHistoryOwner'],
  candidate: NonNullable<RenderFrameState['ssrHistoryOwner']>['candidate'],
): void {
  if (owner === undefined || candidate === undefined) return;
  const committed = owner.commitFrame(candidate);
  if (!committed.ok) {
    owner.abortFrame(candidate, 'submit');
    reportSsrHistoryFailure(internals, 'submit', committed.error);
  }
}

/**
 * Skin history/task buffers track accepted submissions independently of other
 * owners. Frames without any submission-sensitive owner submit without hooks.
 */
export function frameSubmissionHooks(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  gpuDriven: GpuDrivenRecordInput | undefined,
  gi: FrameDiffuseGi,
  shadowPublication: ShadowPublication,
  pointsLinesOwner: PointsLinesRecordOwner | undefined,
  nativeScene: PersistentGpuDrivenState | undefined,
  shadowMeshInput: ShadowMeshInput | undefined,
  shadowLodToken: object | undefined,
  submittedShadowGraphGeneration: number | undefined,
) {
  const ssrOwner = frameState.ssrHistoryOwner;
  const ssrCandidate = ssrOwner?.candidate;
  if (
    gpuDriven?.onSubmittedWork === undefined &&
    attempt.preparedGpuDriven === undefined &&
    ssrCandidate === undefined &&
    !hasDiffuseGiWork(gi) &&
    shadowPublication === undefined &&
    pointsLinesOwner === undefined &&
    nativeScene?.retained === undefined &&
    shadowMeshInput === undefined
  ) {
    return undefined;
  }
  return {
    generationFence: {
      capturedGeneration: 0,
      currentGeneration: () =>
        submissionInputsCurrent(
          frameState,
          gi,
          shadowPublication,
          nativeScene,
          shadowMeshInput,
          shadowLodToken,
        )
          ? 0
          : -1,
    },
    onSubmittedWork: (done: Promise<void>) => {
      gpuDriven?.onSubmittedWork?.(done);
      attempt.preparedGpuDriven?._trackSubmittedWork(done);
      pointsLinesOwner?.track(done);
      trackDiffuseGi(gi, done);
    },
    onSubmitted: () => {
      commitDiffuseGi(gi);
      commitSsrHistory(internals, ssrOwner, ssrCandidate);
      attempt.preparedGpuDriven?._commitResourceReplacement(submittedShadowGraphGeneration);
      const consumed = attempt.preparedGpuDriven?._consumeSurfaceDynamicInput?.(
        frameState.frameNumber,
      );
      if (consumed !== undefined && !consumed.ok) {
        internals.errorRegistry.fire(consumed.error);
      }
    },
    onAborted: () => {
      gi.probePlacement?.abort();
      if (ssrOwner !== undefined && ssrCandidate !== undefined) {
        ssrOwner.abortFrame(ssrCandidate, 'submit');
      }
      attempt.preparedGpuDriven?._abortResourceReplacement?.();
    },
  };
}

/** Capture-only frames submit their capture graphs and readbacks, never a display picture. */
export function* submitCaptureOnlyFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  encoder: RhiCommandEncoder,
  readbackLayers: readonly RenderTargetLayerWrite[],
  nativeScene: PersistentGpuDrivenState | undefined,
  gpuDriven: GpuDrivenRecordInput | undefined,
): FrameRecording {
  internals.encodeRenderTargetReadbacks?.(encoder, readbackLayers);
  const result = yield {
    encoder,
    device: internals.device,
    beforeSubmit: internals.beforeSubmit,
    ...(nativeScene?.retained === undefined
      ? {}
      : {
          isCurrent: () => nativeScene.retained?.isSourceCurrent() === true,
        }),
    onSubmittedWork: (done: Promise<void>) => {
      gpuDriven?.onSubmittedWork?.(done);
      attempt.preparedGpuDriven?._trackSubmittedWork(done);
    },
    reportError: (error: RhiError) => internals.errorRegistry.fire(error),
  };
  attempt.submitted = result.ok;
  const captured = attempt.captureFrames.length > 0 || attempt.probeCaptureFrames.length > 0;
  frameState.frameOutputs.sceneSubmitted = attempt.submitted && captured;
  settleAtmospherePublish(frameState, attempt.submitted);
  if (!attempt.submitted) return false;
  for (const capture of attempt.captureFrames)
    internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
  if (captured)
    attempt.captureCompletion =
      internals.gpuPassTimingSubmittedWork ?? internals.device.queue.onSubmittedWorkDone();
  return true;
}

function resolutionObservation(
  internals: RenderSystemInternals,
  timing: GpuTimingCapture | undefined,
): Promise<number | undefined> {
  const passCapture = internals.gpuPassTimingCapture;
  const observation =
    passCapture !== undefined
      ? passCapture
          .observe()
          .then((result) =>
            result.ok
              ? gpuPassFrameMilliseconds(result.value, internals.gpuPassTimingViewId)
              : undefined,
          )
      : timing
          ?.observation()
          .then((result) => (result.status === 'ready' ? result.frameMs : undefined));
  return observation ?? Promise.resolve(undefined);
}

/** The submitted display frame accepts its capture targets and resolution sample. */
export function commitSubmittedDisplay(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  resolution: DynamicResolutionController,
  renderExtent: RenderExtent | undefined,
  rasterRows: GpuDrivenRecordInput['visibleRasterRows'] | undefined,
  renderableCount: number,
  sampleResolution: boolean,
  timing: GpuTimingCapture | undefined,
): void {
  frameState.frameOutputs.sceneSubmitted = true;
  for (const capture of attempt.captureFrames)
    internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
  attempt.captureCompletion = attempt.completion;
  resolution.commit(renderExtent, () =>
    typeof rasterRows === 'function' ? rasterRows() : (rasterRows ?? renderableCount),
  );
  if (sampleResolution) resolution.observe(resolutionObservation(internals, timing));
}

export function commitSubmittedShadows(
  frameState: RenderFrameState,
  lights: ExtractedLights,
  cascadeCadence: CascadeCadence | undefined,
): void {
  frameState.shadowRaster.commit();
  frameState.shadowDepthLayers?._commit();
  frameState.directionalShadowProjection = lights.lightViewProj;
  frameState.directionalCascadeCadence = cascadeCadence?.next ?? undefined;
}

/**
 * Transfer this candidate's mesh lease only to accepted depth; hits with the
 * same header merely release their temporary borrower when the attempt settles.
 */
export function promoteDirectionalShadowCache(
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  cache: ReturnType<typeof prepareDirectionalShadowCache>,
): void {
  const previous = frameState.directionalShadowCache;
  const next =
    cache.miss !== undefined
      ? frameState.directionalShadowCacheRecorded
        ? cache.next
        : null
      : (cache.next ?? previous);
  if (next === previous) return;
  frameState.directionalShadowCache = next;
  if (next !== null) attempt.shadowMeshLease = undefined;
  previous?.meshReads.release();
}
