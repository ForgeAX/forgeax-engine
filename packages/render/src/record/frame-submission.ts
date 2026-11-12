import { recordContext } from '../world/view-record-context';
// Display-frame submission: the optional parts of the pass context grouped by
// their owner, the submission hooks that fence/track/commit every prepared
// owner, capture-only submission, and the post-submission promotions.

import type { RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { RenderTargetLayerWrite } from '../assembly/render-target-host';
import type { PlanarCaptureState } from '../capture/planar-state';
import type { RendererOperationCause } from '../errors/render';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { projectVolumeCompositeBounds } from '../volume/composite-scissor';
import { requireGiSubmissions } from '../world/gi-systems';
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
  diffuseGiFencesCurrent,
  type FrameDiffuseGi,
  hasDiffuseGiWork,
  trackDiffuseGi,
} from './frame-diffuse-gi';
import type { RenderFrameState, ValidatedRenderable } from './frame-snapshot';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';

type ShadowPublication = ReturnType<typeof currentDirectionalShadowPublication>;
type CascadeCadence = ReturnType<typeof prepareDirectionalCascadeCadence>;

/** Frame-owned inputs that the scene passes consume beside the shared roster. */
export function scenePassInputs(
  scenePassWork: _InternalRenderPipelineContext['scenePassWork'],
  visibleSurface: VisibleSurfaceProjection | undefined,
  probePlacement: FrameDiffuseGi['probePlacement'],
) {
  return {
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
    gpuDrivenShadowBatchProjections: raster.shadowBatchProjections?.(),
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

function submissionInputFailure(
  frameState: RenderFrameState,
  gi: FrameDiffuseGi,
  shadowPublication: ShadowPublication,
  nativeScene: PersistentGpuDrivenState | undefined,
  shadowMeshInput: ShadowMeshInput | undefined,
  shadowLodToken: object | undefined,
): RendererOperationCause | undefined {
  let code: string | undefined;
  if (!diffuseGiFencesCurrent(gi)) code = 'frame-gi-input-stale';
  else if (shadowPublication !== undefined && !shadowPublication.isCurrent())
    code = 'frame-shadow-publication-stale';
  else if (nativeScene?.retained !== undefined && !nativeScene.retained.isSourceCurrent())
    code = 'frame-scene-source-stale';
  else if (shadowMeshInput !== undefined && !shadowMeshInputCurrent(shadowMeshInput))
    code = 'frame-shadow-mesh-stale';
  else if (
    shadowMeshInput !== undefined &&
    frameState.directionalShadowLod?.token !== shadowLodToken
  )
    code = 'frame-shadow-lod-stale';
  return code === undefined
    ? undefined
    : {
        code,
        expected: 'the encoded scene inputs retain their accepted versions through submission',
        hint: 'inspect the named input owner and reprepare the rejected frame',
      };
}

/**
 * Stage what an accepted display submission commits for the prepared
 * GPU-driven frame. The Render World scene-row systems apply it in
 * RenderCommit; RenderCleanup aborts the frame otherwise.
 */
export function stageGpuDrivenCommit(
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  shadowGraphGeneration: number | undefined,
): void {
  if (attempt.preparedGpuDriven === undefined) return;
  frameState.gpuDrivenFrame = {
    prepared: attempt.preparedGpuDriven,
    commit: { shadowGraphGeneration, frameNumber: frameState.frameNumber },
  };
}

/**
 * Skin history/task buffers track accepted submissions independently of other
 * owners. Frames without any submission-sensitive owner submit without hooks.
 */
export function frameSubmissionHooks(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  gi: FrameDiffuseGi,
  shadowPublication: ShadowPublication,
  nativeScene: PersistentGpuDrivenState | undefined,
  shadowMeshInput: ShadowMeshInput | undefined,
  shadowLodToken: object | undefined,
) {
  if (
    attempt.preparedGpuDriven === undefined &&
    attempt.lightTextureResamples.length === 0 &&
    !hasDiffuseGiWork(gi) &&
    shadowPublication === undefined &&
    nativeScene?.retained === undefined &&
    shadowMeshInput === undefined
  ) {
    return undefined;
  }
  if (hasDiffuseGiWork(gi)) requireGiSubmissions(internals);
  let rejection: RendererOperationCause | undefined;
  return {
    generationFence: {
      capturedGeneration: 0,
      rejectionCause: () => rejection,
      currentGeneration: () => {
        rejection = submissionInputFailure(
          frameState,
          gi,
          shadowPublication,
          nativeScene,
          shadowMeshInput,
          shadowLodToken,
        );
        return rejection === undefined ? 0 : -1;
      },
    },
    onSubmittedWork: (done: Promise<void>) => {
      attempt.preparedGpuDriven?._trackSubmittedWork(done);
      trackDiffuseGi(gi, done);
      for (const pending of attempt.lightTextureResamples)
        pending.work.submitted(done, (error) => internals.errorRegistry.fire(error));
    },
    onSubmitted: () => {
      for (const pending of attempt.lightTextureResamples) pending.onSubmitted();
      attempt.lightTextureResamples.length = 0;
    },
    ...(hasDiffuseGiWork(gi) ? { gi } : {}),
  };
}

/** Capture-only frames submit their capture graphs and readbacks, never a display picture. */
export function encodeCaptureOnlyFrame(
  internals: RenderSystemInternals,
  _frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  encoder: RhiCommandEncoder,
  readbackLayers: readonly RenderTargetLayerWrite[],
  nativeScene: PersistentGpuDrivenState | undefined,
): import('../assembly/frame-recording').RecordedView {
  recordContext(internals).encodeRenderTargetReadbacks?.(encoder, readbackLayers);
  return {
    beforeSubmit: internals.beforeSubmit,
    ...(nativeScene?.retained === undefined
      ? {}
      : {
          isCurrent: () => nativeScene.retained?.isSourceCurrent() === true,
        }),
    onSubmittedWork: (done: Promise<void>) => {
      attempt.preparedGpuDriven?._trackSubmittedWork(done);
      for (const pending of attempt.lightTextureResamples)
        pending.work.submitted(done, (error) => internals.errorRegistry.fire(error));
    },
    reportError: (error: RhiError) => internals.errorRegistry.fire(error),
  };
}

export function settleCaptureOnlyFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  result: import('../assembly/renderer-frame-transaction').RendererFrameStageResult<void>,
): boolean {
  attempt.submitted = result.ok;
  const captured = attempt.captureFrames.length > 0 || attempt.probeCaptureFrames.length > 0;
  frameState.frameOutputs.sceneSubmitted = attempt.submitted && captured;
  if (!attempt.submitted) return false;
  for (const pending of attempt.lightTextureResamples) pending.onSubmitted();
  attempt.lightTextureResamples.length = 0;
  for (const capture of attempt.captureFrames)
    internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
  if (captured)
    attempt.captureCompletion =
      internals.gpuPassTimingSubmittedWork ?? internals.device.queue.onSubmittedWorkDone();
  return true;
}

/**
 * Stage the submitted shadow candidate. The Render World light systems promote
 * it in RenderCommit for an accepted scene submission, or release it in
 * RenderCleanup; recording never advances shadow history itself.
 */
export function stageSubmittedShadows(
  frameState: RenderFrameState,
  cascadeCadence: CascadeCadence | undefined,
  cache: ReturnType<typeof prepareDirectionalShadowCache>,
): void {
  frameState.shadowCandidate = {
    cadence: cascadeCadence?.next ?? undefined,
    cache,
    lease: frameState.shadowCandidate?.lease,
  };
}

/** Hand the attempt's mesh lease to the staged candidate; the light systems release or transfer it. */
export function stageShadowMeshLease(
  frameState: RenderFrameState,
  lease: ShadowMeshInput | undefined,
): void {
  if (lease === undefined) return;
  frameState.shadowCandidate = { ...frameState.shadowCandidate, lease };
}
