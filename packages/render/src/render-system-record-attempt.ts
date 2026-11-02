import type { RecorderSession } from '@forgeax/engine-profiler';
import { RhiError } from '@forgeax/engine-rhi';
import { ShaderError } from '@forgeax/engine-shader';
import { resolveDepthOfFieldFrameParams } from './features/depth-of-field/depth-of-field-params';
import type { RenderFeatureFrameResult } from './features/host';
import { resolveStandardRenderFeatureTargets } from './features/targets';
import type { GpuDrawSelection } from './gpu-driven/draw-selection';
import { PipelineSpecError } from './pipeline-spec';
import type { PreparedRenderPublication } from './publication/receiver';
import type { RenderResourceScope } from './publication/resource-scope';
import type { createDrawObservation } from './record/draw-observation';
import type { RenderFrameState } from './record/frame-snapshot';
import type { GpuTimingCapture } from './record/gpu-timing';
import type { PipelineState, RenderSystemInternals } from './record/render-context';
import type {
  CameraSnapshot,
  DrawOwnerOptions,
  FramePresentationPendingReason,
} from './render-contract';
import type { ExtractedFrame, RenderableSnapshot } from './render-system-extract';
import type {
  createPresentationDraws,
  FramePresentationCandidate,
} from './render-system-presentation';
import type { canonicalizeWorldComposition } from './render-system-projections';
import type { FrameList } from './scene/frame-list';
import type { ViewLights } from './world/render-lights';
import type { ViewFrameResult, ViewRecordMode } from './world/view-frame-systems';
import { recordContext } from './world/view-record-context';

/** One `record` call: its canonical inputs and the submission outcome it reports. */
export interface RecordAttempt {
  readonly composition: ReturnType<typeof canonicalizeWorldComposition>;
  /** Resource scopes aligned with `composition.worlds`, or the single publication scope. */
  readonly scopes: readonly RenderResourceScope[];
  readonly opts: DrawOwnerOptions;
  readonly publication: PreparedRenderPublication | undefined;
  /** The view's `render-view-frame` product this attempt records. */
  readonly frame: ViewFrameResult;
  readonly timingCapture: GpuTimingCapture | undefined;
  readonly mode: ViewRecordMode;
  readonly profileSession: RecorderSession | undefined;
  submitted: boolean;
  sceneSubmitted: boolean;
  /** Set once the attempt reached its queue submit; `render-record-commit` publishes it. */
  outcome: RecordOutcome | undefined;
}

/**
 * The facts a record attempt that reached its queue submit leaves for
 * `render-record-commit`: the frame, lights and visibility it recorded, its
 * presentation candidate and the draws it submitted.
 */
export interface RecordOutcome {
  readonly frame: ExtractedFrame;
  readonly lights: ViewLights;
  readonly cameraCount: number;
  readonly presentation: FramePresentationCandidate;
  readonly presentationRenderables: FrameList<RenderableSnapshot>;
  readonly worldKeys: readonly number[];
  readonly draws: RecordDraws;
}

/** Feature-host products of one record attempt. */
export interface RecordFeatures {
  readonly scheduledCaptureWork: readonly import('./capture/scheduler').CubeCaptureWork[];
  readonly sceneInputWork: readonly import('./record/target-capture-graph').CubeCaptureGraphWork[];
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  /** Every non-probe capture face `render-capture-schedule` built. */
  readonly faces: readonly import('./capture/faces').CaptureFace[];
  readonly featureFrame: RenderFeatureFrameResult | undefined;
  /** The view's composite/post plan `render-feature-plan` wrote in RenderQueue. */
  readonly plan: import('./world/feature-plan-systems').ViewFeaturePlan;
}

/** Submitted-draw evidence consumed by presentation readiness and observation commit. */
export interface RecordDraws {
  readonly presentedDraws: ReturnType<typeof createPresentationDraws>;
  readonly drawObservation: ReturnType<typeof createDrawObservation>;
  /** The selection that drew a GPU-owned frame's non-residual rows. */
  readonly gpuSelection: GpuDrawSelection;
}

export function featurePreparationPendingReason(
  featureFrame: RenderFeatureFrameResult,
): FramePresentationPendingReason {
  const identity = featureFrame.preparationPendingFeatureIdentity;
  return (
    featureFrame.preparationPendingReason ?? {
      code: 'feature-preparation',
      ...(identity === undefined ? {} : { featureIdentity: identity.slice(0, 256) }),
    }
  );
}

/** Live camera output or any staged/resident auto-exposure or LUT state needs restaging. */
export function hasLiveStandardOutputState(
  frameState: RenderFrameState,
  liveOutput: CameraSnapshot['output'],
): boolean {
  return (
    liveOutput !== undefined ||
    frameState.autoExposureGpuResources !== undefined ||
    frameState.pendingAutoExposureGpuResources !== undefined ||
    frameState.autoExposureState !== undefined ||
    frameState.pendingAutoExposureState !== undefined ||
    frameState.standardLutGpuResources !== undefined ||
    frameState.pendingStandardLutGpuResources !== undefined ||
    frameState.standardLutState.resident !== null ||
    frameState.pendingStandardLutState !== undefined
  );
}

function recordFailureDetail(cause: unknown) {
  if (cause instanceof PipelineSpecError || cause instanceof ShaderError)
    return {
      name: cause.name,
      code: cause.code,
      message: cause.message,
      ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    };
  if (cause instanceof RhiError) return cause;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  )
    return {
      code: cause.code,
      message: 'expected' in cause ? String(cause.expected) : cause.code,
      detail: cause,
    };
  return {
    code: 'unknown' as const,
    message: String(cause),
    name: (cause as Error)?.name,
  };
}

export function resolveFeatureTargets(
  internals: RenderSystemInternals,
  pipelineState: PipelineState | null,
  camera: CameraSnapshot | undefined,
  cloudLayer: ExtractedFrame['cloudLayer'],
) {
  if (pipelineState === null || camera === undefined) return [];
  return resolveStandardRenderFeatureTargets({
    tonemap: camera.tonemap,
    antialias: camera.antialias,
    colorAttachmentFormat: pipelineState.colorAttachmentFormat,
    storageBuffer: internals.device.caps.storageBuffer,
    multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
    cloudHistory: cloudLayer !== undefined,
  });
}

/** A submitted scene accepts the camera's depth-of-field params against its compiled graph. */
export function acceptSubmittedDepthOfField(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
): void {
  const submittedDepthOfField =
    camera === undefined
      ? undefined
      : resolveDepthOfFieldFrameParams(
          camera.depthOfField,
          camera.depthOfFieldError,
          frameState.depthOfFieldAccepted?.params,
        );
  const submittedDepthOfFieldGraph = frameState.compiledFrameGraph?.graph.inspect();
  if (submittedDepthOfField !== undefined && submittedDepthOfFieldGraph !== undefined) {
    frameState.depthOfFieldAccepted = {
      params: submittedDepthOfField,
      graph: submittedDepthOfFieldGraph,
      deviceGeneration: recordContext(internals).deviceScope.generation,
    };
    frameState.depthOfFieldLastSubmitFailed = false;
  } else if (submittedDepthOfField === undefined) {
    frameState.depthOfFieldAccepted = undefined;
    frameState.depthOfFieldLastSubmitFailed = false;
  } else {
    frameState.depthOfFieldLastSubmitFailed = true;
  }
}

/** Bloom resources commit with the scene; turning bloom off retires them after GPU completion. */
export function commitSubmittedBloom(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  bloomAdmitted: boolean,
): void {
  recordContext(internals).getPipelineState()?.perPassResources.commitBloomResources?.();
  const nextBloom = bloomAdmitted ? 'on' : 'off';
  if (frameState.lastSuccessfulBloom === 'on' && nextBloom !== 'on') {
    recordContext(internals)
      .getPipelineState()
      ?.perPassResources.retireBloomResources?.(internals.device.queue.onSubmittedWorkDone());
  }
  frameState.lastSuccessfulBloom = nextBloom;
}

export function discardUnsubmittedFrame(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
): void {
  if (camera?.depthOfField !== undefined) {
    frameState.depthOfFieldLastSubmitFailed = true;
  }
  recordContext(internals).getPipelineState()?.perPassResources.discardBloomResources?.();
}

export function recordFailureError(cause: unknown): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'RenderSystem to record one frame without an internal exception',
    hint: 'inspect detail.error for the underlying cause; next frame will retry',
    detail: { error: recordFailureDetail(cause) },
  });
}

/** Task, temporal and Skin roots retire independently; every cause is reported together. */
export function recordRetirementError(failures: readonly unknown[]): RhiError {
  return new RhiError({
    code: 'internal-error',
    expected: 'independent retirement of task, temporal and Skin roots',
    hint: 'inspect all retained recording and cleanup causes',
    detail: {
      error: {
        code: 'render-retirement-failed',
        message: 'Render recording retirement failed',
        detail: {
          error: new AggregateError(failures, 'Render recording retirement failed', {
            cause: failures[0],
          }),
        },
      },
    },
  });
}

/** The first published Feature row this receiver does not implement; undefined when all are. */
export function unimplementedPublishedFeature(
  publication: PreparedRenderPublication | undefined,
  featureHost: RenderSystemInternals['featureHost'],
): string | undefined {
  return publication?.packet.features.find(
    (row) => !featureHost?.features.some((feature) => feature.identity === row.identity),
  )?.identity;
}

/** The receiver-bound view proves fresh or retained GPU shadow depth. */
export function directionalShadowSubmitted(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  lights: ViewLights,
): boolean {
  return (
    lights.cascades?.directionalShadowQuality === undefined ||
    (frameState.frameOutputs.directionalShadowView !== null &&
      (lights.cascades?.lightViewProj?.length ?? 0) > 0 &&
      (recordContext(internals).getPipelineState()?.perPassResources.shadowMapSize ?? 0) > 0)
  );
}

export function directionalShadowCandidateError(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  lights: ViewLights,
  submitted: boolean,
) {
  return {
    code: 'directional-shadow-candidate-failed' as const,
    expected:
      'the extracted Directional CSM candidate has a valid graph target and fitted matrices',
    hint: 'inspect the retained LKG and retry after the graph or resource owner recovers',
    detail: {
      submitted,
      hasShadowView: frameState.frameOutputs.directionalShadowView !== null,
      matrixCount: lights.cascades?.lightViewProj?.length ?? 0,
      shadowMapSize:
        recordContext(internals).getPipelineState()?.perPassResources.shadowMapSize ?? 0,
    },
  };
}

export function releasePreparedResourceBatches(
  featureFrame: RenderFeatureFrameResult,
  errorRegistry: RenderSystemInternals['errorRegistry'],
): void {
  for (const batch of featureFrame.preparedResourceBatches) {
    const released = batch.release();
    if (!released.ok) errorRegistry.fire(released.error);
  }
}
