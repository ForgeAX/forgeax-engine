import { halfFloat } from '@forgeax/engine-math';
import { textureReadbackLayout } from '@forgeax/engine-rhi';
import { capsuleConeHalfAngle } from '../capsule-shadow/frame';
import { inspectCapsuleShadow } from '../capsule-shadow/inspection';
import { targetCaptureWork } from '../capture/faces';
import { PlanarCaptureState } from '../capture/planar-state';
import { encodePlanarReflectionUniform } from '../capture/planar-uniform';
import { PlanarReflectionInvalidError } from '../components/planar-reflection';
import type { ProjectedDecalInvalidError } from '../decals/component';
import { directMorphGeometry } from '../device/morph-geometry';
import type { FogFrame } from '../extract/environment';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { EMPTY_MATERIAL_BINDINGS } from '../gpu-driven/material-bindings';
import type { TransparencyInspection } from '../oit/view';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import type { MaterialFrame } from '../scene/material-dispatch';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { GpuRasterOwnership } from '../scene/render-scene';
import type { SubsurfaceDemand } from '../subsurface/selection';
import {
  type DisplaySubmission,
  stageDisplaySubmission,
} from '../world/display-submission-systems';
import type { ViewLights } from '../world/render-lights';
import { viewTemporalStageOf } from '../world/temporal-systems';
import { recordContext } from '../world/view-record-context';
import { cpuLaneLodRows } from './cpu-lod';
import { ViewDrawPhases } from './direct-draw-phase';
import {
  currentDirectionalShadowPublication,
  prepareDirectionalCascadeCadence,
} from './directional-cascade-cadence';
import {
  prepareDirectionalShadowCache,
  type ShadowMeshInput,
  shadowMeshInputCurrent,
  shadowMeshReadsForQuery,
} from './directional-shadow-cache';
import {
  buildDispatchPlan,
  cleanPerFrameCaches,
  computeFoldBuckets,
  validateRenderables,
} from './fold-buckets';
import { retainedFoldInstanceKeys } from './fold-instance-buffer';
import { canRetainMaterialBindings } from './material-binding-index';
import { materialGeometry } from './material-geometry';
import { prepareScenePasses, scenePassRequests } from './scene-pass-work';
import { shadowViewPlanesByView } from './shadow-culling';
import { prepareShadowMaterialPipelines } from './shadow-pass';
import { createShadowUpdatePolicy } from './shadow-update-policy';
import { disposeTargetCaptureLighting } from './target-capture-lighting';
import { PLANAR_REFLECTION_UNIFORM_OFFSET } from './view-ubo';
// @forgeax/engine-runtime - RendererState record stage: frame.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4 } from '@forgeax/engine-math';
import {
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result, type TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { ExtractedCloudLayer } from '../cloud/extract';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  ObservationUnavailableError,
  type ObservationUnavailableReason,
  RendererOperationError,
} from '../errors/render';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { type GpuDrivenLodSubmitIdentity, selectGpuLodLane } from '../gpu-driven/view-gpu';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import { standardLightingTopologySignature } from '../pipeline/standard-lighting/topology';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { inspectPointShadow } from '../point-shadow-inspection';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../render-contract';
import type {
  DispatchList,
  ExtractedVolumetricFog,
  GpuOwnedFrame,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import type { VolumeTemporalSignature } from '../volume/temporal';
import {
  admitVolumeHistory,
  consumeViewHistoryAdmission,
  consumeViewSsrHistoryStage,
  type VolumeHistoryAdmission,
} from '../world/history-admission-systems';
import { consumeViewTopology } from '../world/view-topology-systems';
import {
  buildPerFrameBindGroups,
  prepareFrameLighting,
  resolveSkyboxActive,
  writeHdrpClusterAndSsaoBuffers,
  writeLightModifierTextures,
} from './frame-lighting';
import {
  type BindGroupCounts,
  type DispatchCounts,
  type FrameObservationSource,
  getTextureIdentity,
  type ReflectionFallbackReadbackRequest,
  type RenderFrameState,
  type ValidatedRenderable,
  validateGraphTargetCaptureReadback,
} from './frame-snapshot';
import {
  emitGpuDrivenDrawReceipts,
  type RenderableDrawReceipt,
  summarizeGpuDrivenDraws,
} from './gpu-draw-receipts';
import {
  type _InternalRenderPipelineContext,
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';
import { beginSsrHistoryFrame } from './ssr-history-frame';
import { type FrameVolumetricFog, planViewTopology } from './view-topology';

export {
  buildDispatchPlan,
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
  validateRenderables,
} from './fold-buckets';
export type { FrameObservationSource } from './frame-snapshot';

export type FrameObservationReadback = (
  lease: CurrentFrameObservationLease,
) => Promise<Result<Uint8Array, Error>>;

export interface FrameObservationOptions {
  readonly semantic: 'linear-hdr';
  readonly readback: FrameObservationReadback;
}

export interface FrameObservationMetadata {
  readonly format: TextureFormat;
  readonly size: { readonly width: number; readonly height: number };
  readonly usage: number;
  readonly sample: number;
  readonly frameId: number;
  readonly lifetime: { readonly frameId: number; readonly state: 'active' | 'retired' };
  readonly pipelineId: 'forgeax::standard';
  readonly backendId: string;
}

export interface FrameObservation {
  readonly bytes: Uint8Array;
  readonly metadata: FrameObservationMetadata;
}

function unavailable(
  reason: ObservationUnavailableReason,
  hint: string,
): Result<never, ObservationUnavailableError> {
  return err(new ObservationUnavailableError(reason, hint));
}

function mapLeaseFailure(code: string, hint: string): Result<never, ObservationUnavailableError> {
  let reason: ObservationUnavailableReason = 'resource';
  if (code === 'observation-stale') reason = 'stale';
  else if (code === 'observation-invalid-format') reason = 'format';
  else if (code === 'observation-missing-copy-src') reason = 'copy-src';
  return unavailable(reason, hint);
}

export async function observeCurrentFrame(
  options: FrameObservationOptions,
  source: FrameObservationSource | undefined,
  currentFrameId: number,
): Promise<Result<FrameObservation, ObservationUnavailableError>> {
  if (options.semantic !== 'linear-hdr') {
    return unavailable('identity', 'request the producer-owned linear-hdr semantic');
  }
  if (source === undefined) {
    return unavailable(
      'no-frame',
      'draw a frame through the Standard producer before requesting observation',
    );
  }
  if (source.pipelineId !== 'forgeax::standard' || source.backendId.length === 0) {
    return unavailable(
      'identity',
      'observe a producer with explicit pipeline and backend identity',
    );
  }

  const leaseResult = createCurrentFrameObservationLease(
    { ...source.descriptor, texture: source.texture, frameId: source.frameId },
    currentFrameId,
  );
  if (!leaseResult.ok) {
    return mapLeaseFailure(leaseResult.error.code, leaseResult.error.hint);
  }

  let bytesResult: Result<Uint8Array, Error>;
  try {
    bytesResult = await options.readback(leaseResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailable('readback-failed', `retry the current-frame readback after: ${message}`);
  }
  if (!bytesResult.ok) {
    return unavailable('readback-failed', bytesResult.error.message);
  }

  const activeResult = leaseResult.value.beginReadback();
  if (!activeResult.ok) {
    return mapLeaseFailure(activeResult.error.code, activeResult.error.hint);
  }

  return ok({
    bytes: bytesResult.value,
    metadata: {
      format: leaseResult.value.descriptor.format,
      size: leaseResult.value.descriptor.size,
      usage: leaseResult.value.descriptor.usage,
      sample: source.descriptor.sample,
      frameId: source.frameId,
      lifetime: leaseResult.value.lifetime,
      pipelineId: source.pipelineId,
      backendId: source.backendId,
    },
  });
}

import type { RenderExtent } from '../pipeline/render-extent';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import { markCaptureGraphsEncoded } from '../world/capture-graph-systems';
import {
  consumeViewFeaturePlan,
  type FeaturePlanMissing,
  type ViewFeaturePlan,
} from '../world/feature-plan-systems';
import { consumeViewGpuDrivenRaster } from '../world/gpu-driven-raster-systems';
import { consumeRecordingGpuDriven } from '../world/gpu-driven-systems';
import {
  consumeViewPassPlan,
  type PassPlanMissing,
  type ViewPassPlan,
} from '../world/pass-plan-systems';
import { frameEncoder } from '../world/record-systems';
import { renderSubmission, renderWorldFor } from '../world/render-world';
import {
  consumeViewSsrAdmission,
  reflectionFallbackDemandOf,
} from '../world/ssr-admission-systems';
import { consumeViewStandardLighting } from '../world/standard-lighting-systems';
import {
  consumeViewSubsurface,
  subsurfaceAdmissionInput,
} from '../world/subsurface-admission-systems';
import { consumeViewPointsLines } from '../world/view-points-lines';
import { resolveSubmittedBarrelMapping } from './barrel-distortion-frame';
import {
  admitFramePipeline,
  admitRecordScene,
  assertProbePlacementSingleView,
  hasCubeCaptureViews,
  isFixedShadowDomain,
  resetFrameAttemptOutputs,
  resolveFrameMaterials,
  shouldDeferImageDisplay,
} from './frame-admission';
import {
  type CaptureGraphOutcome,
  type CubeCaptureFrame,
  executeCaptureFrames,
  type ProbeCaptureFrame,
} from './frame-capture';
import { consumeViewDiffuseGi, reprojectDiffuseGiHistory } from './frame-diffuse-gi';
import {
  captureViewsCastShadows,
  collectDirectShadowMaterials,
  type DirectShadowInputs,
  gpuLaneDirectShadowRows,
  updateGpuDrivenShadowViews,
  validateDirectShadowRows,
} from './frame-gpu-driven';
import {
  capturePassContext,
  encodeCaptureOnlyFrame,
  frameSubmissionHooks,
  gpuDrivenPassContext,
  scenePassInputs,
  settleCaptureOnlyFrame,
  shaderSourcePassContext,
  shadowPassContext,
  stageGpuDrivenCommit,
  stageShadowMeshLease,
  stageSubmittedShadows,
  volumetricFogPassContext,
} from './frame-submission';
import {
  acquireSwapChainTarget,
  frameTargetExtent,
  graphExecutionPhase,
  hasShadowViewDemand,
  requireFrameTarget,
} from './frame-targets';
import {
  buildFramePostProcessParams,
  frameClockSample,
  resolveFrameTemporal,
} from './frame-temporal';
import { GpuTimingCapture } from './gpu-timing';
import { adoptViewGraph, type ViewGraphCompileOutcome } from './graph-adoption';
import { computeViewProjectionMatrix } from './helpers';
import { createMainPassMaterialSelectionOwner } from './main-pass';
import { computeSplitLdrSprite } from './main-pass-sprite-draws';
import { writeShadowCasterUniforms } from './shadow-caster-uniforms';
import {
  type CubeCaptureGraphState,
  compileViewGraph,
  ensureShadowDepthLayers,
  getRenderFeatureGraphState,
  recordCompiledFrameGraph,
  settleEncodedFrameGraph,
} from './typed-frame-graph';
import { writePointsLinesViewUbo, writeViewUbo } from './view-ubo';
import { updateVolumetricFogInspection } from './volumetric-fog-commit';

export type { RecordProfileRunner };

export interface CubeCaptureFrameInput {
  readonly sceneInputs?: readonly import('./target-capture-graph').CubeCaptureGraphWork[];
  readonly captureOnly?: boolean;
  readonly captureDispatch?: DispatchList;
  readonly subsurfaceDemand?: SubsurfaceDemand;
  readonly scheduledWork: readonly import('../capture/scheduler').CubeCaptureWork[];
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  /** Every non-probe face `render-capture-schedule` built, in capture order. */
  readonly faces: readonly import('../capture/faces').CaptureFace[];
  readonly state: CubeCaptureGraphState;
  readonly reflectionProbes?: import('./render-context').ReflectionProbeRecordState;
  /** Each face work's cascade-fitted lights, from `render-capture-fit` in RenderPrepare. */
  readonly fits: ReadonlyMap<object, ViewLights>;
}

/** A capture view's single target write, published to its capture graph's live state. */
function prepareCaptureView(
  internals: RenderSystemInternals,
  camera: CameraSnapshot,
): readonly import('./typed-frame-graph').CubeCaptureGraphWork[] | undefined {
  const capture = recordContext(internals).captureView;
  if (capture === undefined) return [];
  const work = targetCaptureWork(
    camera,
    camera.target === undefined ? undefined : internals.getRenderTargetPhysical?.(camera.target),
  );
  capture.state.work = work === undefined ? [] : [work];
  return work === undefined ? undefined : capture.state.work;
}

/**
 * Select this frame's planar mirror capture among `auxiliaryCameras`;
 * `render-capture-schedule` calls it in RenderPrepare. Throws
 * {@link PlanarReflectionInvalidError} for a target that cannot hold a mirror.
 */
export function preparePlanarCapture(
  internals: RenderSystemInternals,
  state: CubeCaptureGraphState,
  auxiliaryCameras: readonly CameraSnapshot[],
  frameNumber: number,
): import('../capture/planar-state').PlanarCapture | undefined {
  state.planar ??= new PlanarCaptureState();
  const planarCamera = auxiliaryCameras.find((camera) => camera.planarReflection !== undefined);
  const planarPhysical =
    planarCamera?.target === undefined
      ? undefined
      : internals.getRenderTargetPhysical?.(planarCamera.target);
  if (
    planarPhysical !== undefined &&
    (planarPhysical.descriptor.shape !== '2d' ||
      !planarPhysical.descriptor.sampled ||
      planarPhysical.descriptor.format.endsWith('-srgb'))
  )
    throw new PlanarReflectionInvalidError('target');
  return state.planar.prepare(planarCamera, planarPhysical, frameNumber);
}

function prepareCubeCapture(
  input: CubeCaptureFrameInput | undefined,
): readonly import('./typed-frame-graph').CubeCaptureGraphWork[] {
  if (input === undefined) return [];
  if (input.reflectionProbes === undefined) delete input.state.reflectionProbes;
  else input.state.reflectionProbes = input.reflectionProbes.graph;
  const physicalWork = input.faces.map((face) => face.work);
  input.state.work = physicalWork;
  if (physicalWork.length === 0) disposeTargetCaptureLighting(input.state);
  return physicalWork;
}

const EMPTY_ENTITY_KEYS: ReadonlySet<number> = new Set<number>();

/** Unknown graphs retain all four padded matrix slots, including recovery/LKG. */
export function directionalShadowPreparationLimit(
  cascadeCount: number | undefined,
  installed: RenderFrameState['compiledFrameGraph'],
  previous: RenderFrameState['compiledFrameGraph'] | undefined,
): number | undefined {
  if (
    !Number.isInteger(cascadeCount) ||
    cascadeCount === undefined ||
    cascadeCount < 1 ||
    cascadeCount > 4
  )
    return undefined;
  const count = installed?.directionalShadowViewCount;
  if (count === undefined || !Number.isInteger(count) || count < 1 || count > 4) return undefined;
  if (previous !== undefined) {
    const old = previous?.directionalShadowViewCount;
    if (old === undefined || !Number.isInteger(old) || old < 1 || old > 4) return undefined;
    return Math.max(cascadeCount, count, old);
  }
  return Math.max(cascadeCount, count);
}

function createReflectionFallbackReadbackRequest(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): ReflectionFallbackReadbackRequest | undefined {
  if (
    !reflectionFallbackDemandOf(internals) ||
    frameState.reflectionFallbackReadback !== undefined
  ) {
    return undefined;
  }
  const graph = frameState.compiledFrameGraph?.targets;
  if (graph === undefined) return undefined;
  const descriptor = graph.getColorTargetDescriptor('reflection-fallback-linear-hdr');
  const texture = graph.getColorTargetTexture('reflection-fallback-linear-hdr');
  if (
    descriptor === undefined ||
    texture === undefined ||
    descriptor.format !== 'rgba16float' ||
    descriptor.sample !== 1
  ) {
    return undefined;
  }
  const { bytesPerRow, byteLength } = textureReadbackLayout(
    descriptor.size.width,
    descriptor.size.height,
    { blockWidth: 1, blockHeight: 1, bytesPerBlock: 8 },
  );
  const created = internals.device.createBuffer({
    label: 'reflection-fallback-linear-hdr.readback',
    size: byteLength,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    internals.errorRegistry.fire(created.error);
    return undefined;
  }
  return {
    name: 'reflection-fallback-linear-hdr',
    buffer: created.value,
    bytesPerRow,
    width: descriptor.size.width,
    height: descriptor.size.height,
    expected: {
      format: descriptor.format,
      width: descriptor.size.width,
      height: descriptor.size.height,
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
      graphGeneration: graph.graphGeneration,
      frameId: frameState.frameNumber,
      textureIdentity: getTextureIdentity(texture),
    },
    encoded: false,
  };
}

async function mapReflectionFallbackReadback(
  internals: RenderSystemInternals,
  request: ReflectionFallbackReadbackRequest,
  allowZero: boolean,
): Promise<{
  readonly linearHdr: readonly [number, number, number, number];
  readonly hash: string;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
}> {
  try {
    if (!request.encoded) throw new Error('reflection fallback copy was not encoded');
    const mapped = await request.buffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
    if (!mapped.ok) throw mapped.error;
    const range = mapped.value.getMappedRange();
    if (!range.ok) throw range.error;
    const bytes = new Uint8Array(range.value.slice(0));
    mapped.value.unmap();
    const validation = validateGraphTargetCaptureReadback({
      bytes,
      expectedByteLength: request.bytesPerRow * request.height,
      allowZero,
    });
    if (!validation.ok) throw new Error(validation.code);
    let linearHdr: readonly [number, number, number, number] = [0, 0, 0, 0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let y = 0; y < request.height; y += 1) {
      for (let x = 0; x < request.width; x += 1) {
        const offset = y * request.bytesPerRow + x * 8;
        // Validation above already rejects non-finite half floats. Scan the
        // raw RGB magnitudes (both signed zero encodings are empty) without
        // allocating/decoding millions of background pixels each frame.
        const red = view.getUint16(offset, true);
        const green = view.getUint16(offset + 2, true);
        const blue = view.getUint16(offset + 4, true);
        if ((red & 0x7fff) !== 0 || (green & 0x7fff) !== 0 || (blue & 0x7fff) !== 0) {
          linearHdr = [
            halfFloat.f16ToF32(red),
            halfFloat.f16ToF32(green),
            halfFloat.f16ToF32(blue),
            halfFloat.f16ToF32(view.getUint16(offset + 6, true)),
          ];
          y = request.height;
          break;
        }
      }
    }
    // A cleared attachment has a non-zero alpha lane, so byte-level
    // validation alone can incorrectly admit an otherwise empty MRT.  When
    // the selected producer is non-neutral, require an actual finite RGB
    // sample before publishing a complete receipt; neutral rows explicitly
    // retain the zero quartet through allowZero=true.
    if (
      !allowZero &&
      !linearHdr.slice(0, 3).some((value) => Number.isFinite(value) && value !== 0)
    ) {
      throw new Error('capture-readback-empty');
    }
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error('Web Crypto SHA-256 is unavailable');
    const digest = await subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    return {
      linearHdr,
      hash: `sha256:${hash}`,
      graphGeneration: request.expected.graphGeneration,
      textureIdentity: request.expected.textureIdentity,
    };
  } finally {
    internals.device.destroyBuffer(request.buffer);
  }
}

/**
 * Resolve the history slot of an available volume from its admission and
 * write its adjacent UBO lanes: validity, scope time and elapsed time since
 * the accepted history. The slot is read only when this frame reuses the
 * accepted graph. A capture-only extent the admission did not sign is
 * admitted here through the same rule. False when the upload fails.
 */
function prepareVolumetricFogHistory(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  volume: FrameVolumetricFog,
  admission: VolumeHistoryAdmission | undefined,
  graph: import('@forgeax/engine-render-graph').CompiledRenderGraph<
    import('../render-pipeline').RenderPipelineFrame
  >,
  camera: CameraSnapshot,
  lights: ViewLights,
  width: number,
  height: number,
):
  | false
  | { readonly context: VolumetricFogFrameContext; readonly signature: VolumeTemporalSignature }
  | { readonly context: undefined; readonly signature: undefined } {
  if (volume.graphFog?.status !== 'available' || volume.baseContext === undefined)
    return { context: undefined, signature: undefined };
  const admitted =
    admission !== undefined &&
    admission.signature.width === width &&
    admission.signature.height === height
      ? admission
      : admitVolumeHistory(
          frameState,
          volume.graphFog,
          volume.baseContext,
          camera,
          lights,
          width,
          height,
        );
  const historyReadSlot = frameState.volumetricFogHistoryGraph === graph ? admitted.readSlot : null;
  const context: VolumetricFogFrameContext = {
    ...volume.baseContext,
    historyReadSlot,
    historyWriteSlot: historyReadSlot === 0 ? 1 : 0,
    historyValid: historyReadSlot !== null,
  };
  const historyParams = new Float32Array([
    context.historyValid ? 1 : 0,
    admitted.signature.worldTimeSeconds ?? 0,
    admitted.elapsedSeconds,
  ]);
  frameState.volumetricFogParams.pending?.params.set(historyParams, 31);
  const historyParamsWritten = internals.device.queue.writeBuffer(
    context.paramsBuffer,
    31 * Float32Array.BYTES_PER_ELEMENT,
    historyParams,
  );
  if (!historyParamsWritten.ok) {
    internals.errorRegistry.fire(historyParamsWritten.error);
    return false;
  }
  return { context, signature: admitted.signature };
}

/** The renderer-owned `gpuDriven` input of one display recording. */
export interface GpuDrivenRecordInput {
  readonly owner: GpuDrivenProduction;
  readonly scene: PersistentGpuDrivenState | undefined;
  /** Only direct recorders publish through this positional callback. View lanes are Queue-owned. */
  readonly onRasterLane?: (owned: GpuRasterOwnership | undefined) => void;
  readonly activeEntityKeys?: ReadonlySet<number>;
  readonly activeEntityRevision?: number;
  /** Extraction culling count; GPU-owned candidates can stay in residency rows. */
  /** Evaluated only by a dynamic-resolution owner; the count is lazy. */
  readonly visibleRasterRows: number | (() => number);
  readonly cameraVisible?: (source: RenderableSnapshot) => boolean;
  readonly cameraAdmission?: import('../render-system-extract').CameraAdmission;
  readonly telemetryCandidateCount?: number;
  readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
  readonly frameTime?: number;
  readonly deviceGeneration?: number;
  readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
  readonly geometryLane?: 'automatic' | 'direct';
  /** Uncompacted GPU-lane frame: receipts visit residual rows; `submitted` covers the rest. */
  readonly gpuOwned?: {
    readonly frame: GpuOwnedFrame;
    readonly submitted: (selection: GpuDrawSelection) => void;
  };
}

/**
 * Per-attempt state that the recording's `finally` settles on every exit
 * path (camera missing, pipeline pending, swap-chain unavailable, thrown
 * setup, capture-only or display submission).
 */
export interface FrameRecordingAttempt {
  /** Whether the shared frame encoder reached queue submission. */
  submitted: boolean;
  captureSettled: boolean;
  ownsCaptureGraphs: boolean;
  preparedGpuDriven: PreparedGpuDrivenFrame | undefined;
  shadowMeshLease: ShadowMeshInput | undefined;
  captureFrames: readonly CubeCaptureFrame[];
  probeCaptureFrames: readonly ProbeCaptureFrame[];
  completion: Promise<unknown> | undefined;
  fallbackReadback:
    | Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>
    | undefined;
  captureCompletion: Promise<unknown> | undefined;
  resolutionTiming: GpuTimingCapture | undefined;
  volumeInspectionReady: boolean;
  volumeSubmissionAttempted: boolean;
  preparedVolumetricFog: VolumetricFogFrameContext | undefined;
  volumeCapability: boolean;
  viewVolumetricFog: ExtractedVolumetricFog | undefined;
}

export function createFrameRecordingAttempt(
  volumetricFog: ExtractedVolumetricFog | undefined,
): FrameRecordingAttempt {
  return {
    submitted: false,
    captureSettled: false,
    ownsCaptureGraphs: false,
    preparedGpuDriven: undefined,
    shadowMeshLease: undefined,
    captureFrames: [],
    probeCaptureFrames: [],
    completion: undefined,
    fallbackReadback: undefined,
    captureCompletion: undefined,
    resolutionTiming: undefined,
    volumeInspectionReady: false,
    volumeSubmissionAttempted: false,
    preparedVolumetricFog: undefined,
    volumeCapability: false,
    viewVolumetricFog: volumetricFog,
  };
}

function stagedVolumeInspection(attempt: FrameRecordingAttempt, lights: ViewLights) {
  if (!attempt.volumeInspectionReady) return undefined;
  return {
    fog: attempt.viewVolumetricFog,
    lights,
    prepared: attempt.preparedVolumetricFog,
    capability: attempt.volumeCapability,
    attempted: attempt.volumeSubmissionAttempted,
  };
}

/** The prepared GPU-driven frame is settled by the Render World scene-row systems. */
function stageGpuDrivenFrame(frameState: RenderFrameState, attempt: FrameRecordingAttempt): void {
  const prepared = attempt.preparedGpuDriven;
  if (prepared === undefined || frameState.gpuDrivenFrame?.prepared === prepared) return;
  frameState.gpuDrivenFrame = { prepared };
}

/** Probe tickets belong to this recording attempt, including preparation barriers. */
function completeReflectionProbeSubmission(
  _internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  cubeCapture: CubeCaptureFrameInput | undefined,
  submission: { readonly accepted: boolean; readonly fallbackRequested: boolean },
): void {
  const fallbackSource = frameState.reflectionFallbackObservationSource;
  frameState.reflectionFallbackCompletion = cubeCapture?.reflectionProbes?.completeSubmission(
    submission.accepted,
    attempt.completion ?? attempt.captureCompletion,
    fallbackSource === undefined
      ? undefined
      : {
          format: fallbackSource.descriptor.format,
          size: fallbackSource.descriptor.size,
          frameId: fallbackSource.frameId,
          graphGeneration: frameState.graphGeneration,
          textureIdentity: getTextureIdentity(fallbackSource.texture),
          ...(attempt.fallbackReadback === undefined ? {} : { readback: attempt.fallbackReadback }),
        },
    submission.fallbackRequested,
  );
  frameState.reflectionFallbackObservationSource = undefined;
}

function retireCaptureGraphs(attempt: FrameRecordingAttempt): void {
  const completion = attempt.captureCompletion;
  for (const capture of [...attempt.captureFrames, ...attempt.probeCaptureFrames]) {
    if (completion === undefined) void capture.graph.retire();
    else
      void completion.then(
        () => capture.graph.retire(),
        () => capture.graph.retire(),
      );
  }
}

/** Transfer per-attempt leases to their Commit/Cleanup owners before any history settles. */
export function stageFrameRecordingResources(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
): void {
  stageShadowMeshLease(frameState, attempt.shadowMeshLease);
  attempt.shadowMeshLease = undefined;
  if (internals.viewEntity === undefined) stageGpuDrivenFrame(frameState, attempt);
}

/** Stage physical capture completion once; history acceptance remains the World's authority. */
export function stageFrameCaptureCompletion(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  cubeCapture: CubeCaptureFrameInput | undefined,
  graphEncoded: boolean,
): void {
  if (attempt.captureSettled) return;
  attempt.captureSettled = true;
  try {
    const physical = (attempt.completion ?? attempt.captureCompletion) !== undefined;
    completeReflectionProbeSubmission(internals, frameState, attempt, cubeCapture, {
      accepted:
        graphEncoded &&
        attempt.submitted &&
        physical &&
        renderSubmission(renderWorldFor(internals)).accepted,
      fallbackRequested: graphEncoded && reflectionFallbackDemandOf(internals),
    });
  } finally {
    cubeCapture?.state.planar?.stage(attempt.submitted, attempt.captureCompletion);
  }
}

/** Cleanup owns transient retirement, discarded timing and once-per-frame inspection state. */
export function releaseFrameRecordingAttempt(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  lights: ViewLights,
  cubeCapture: CubeCaptureFrameInput | undefined,
): void {
  const submitted = attempt.submitted;
  if (!attempt.captureSettled) {
    attempt.captureSettled = true;
    completeReflectionProbeSubmission(internals, frameState, attempt, cubeCapture, {
      accepted: false,
      fallbackRequested: false,
    });
  }
  attempt.shadowMeshLease?.reads.release();
  attempt.shadowMeshLease = undefined;
  frameState.probePlacementFrame = undefined;
  if (attempt.ownsCaptureGraphs) retireCaptureGraphs(attempt);
  if (!submitted) attempt.resolutionTiming?.discard();
  // `render-graph-settle` promotes or rolls back the adopted graph candidate.
  // A submitted attempt's inspection updates with its fog commit, after promotion.
  if (attempt.volumeInspectionReady && !submitted && attempt.volumeSubmissionAttempted) {
    updateVolumetricFogInspection(
      frameState,
      attempt.viewVolumetricFog,
      lights,
      attempt.preparedVolumetricFog,
      submitted,
      attempt.volumeCapability,
      attempt.volumeSubmissionAttempted,
    );
  }
  // feat-20260608-cluster-lighting M5 / w22: clear Standard once-per-frame fired
  // set so the next frame re-fires if the condition persists.
  frameState.standardOncePerFrameFired.clear();
}

type CompiledFrameGraph = import('@forgeax/engine-render-graph').CompiledRenderGraph<
  import('../render-pipeline').RenderPipelineFrame
>;

/** Direct recorders prepare in place; view recordings consume the Queue system's product. */
function prepareGpuDrivenRecordingShadows(
  internals: RenderSystemInternals,
  input: import('./frame-gpu-driven-input').FrameGpuDrivenInput,
  frame: GpuDrivenRecordInput,
  attempt: FrameRecordingAttempt,
  profile: RecordProfileRunner | undefined,
  lights: ViewLights,
  reads: ShadowMeshInput | undefined,
  planes: () => ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): boolean {
  if (hasShadowViewDemand(lights)) retainGpuShadowMeshReads(input, reads);
  const request = input.request;
  if (internals.viewEntity === undefined && request !== undefined) {
    const prepared = runRecordProfilePhase(profile, 'record/gpu-driven-prepare', () =>
      frame.owner.prepare(request),
    );
    if (!prepared.ok) {
      internals.errorRegistry.fire(prepared.error);
      return false;
    }
    attempt.preparedGpuDriven = prepared.value;
  }
  return updateGpuDrivenShadowViews(
    internals,
    attempt.preparedGpuDriven,
    profile,
    input.shadowViews,
    lights,
    planes,
    targetSize,
    graphGeneration,
    directionalLimit,
  );
}

/** Shadow leases retain exactly the resident bindings admitted during Queue. */
function retainGpuShadowMeshReads(
  input: import('./frame-gpu-driven-input').FrameGpuDrivenInput,
  reads: ShadowMeshInput | undefined,
): void {
  for (const [binding, execution] of input.artifacts?.batchExecutions ?? [])
    if (execution.shadow.route !== 'none') reads?.reads.add(input.meshes.get(binding)?.changeToken);
}

function observePreparedResourceGeneration(
  frameState: RenderFrameState,
  prepared: PreparedGpuDrivenFrame | undefined,
): void {
  if (prepared === undefined) return;
  frameState.surfaceSubmissionObservation?.setResourceGeneration(
    prepared.standardPbrFrameResources.resourceGeneration,
  );
}

function emitSubmittedDrawReceipts(
  renderables: FrameList<RenderableSnapshot>,
  selection: PreparedGpuDrivenFrame['selection'],
  onRenderableDraw: Parameters<typeof emitGpuDrivenDrawReceipts>[2] | undefined,
  frameGpuDriven: GpuDrivenRecordInput | undefined,
): void {
  if (onRenderableDraw === undefined || frameGpuDriven === undefined) return;
  const owned = frameGpuDriven.gpuOwned;
  emitGpuDrivenDrawReceipts(
    owned?.frame.residual(selection) ?? renderables,
    selection,
    onRenderableDraw,
  );
  owned?.submitted(selection);
  frameGpuDriven.owner.recordDrawSummary(() => summarizeGpuDrivenDraws(renderables, selection));
}

function fixedShadowMeshLease(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  worlds: readonly RenderResourceScope[],
  projection: PersistentShadowCasterProjection | undefined,
  fixedShadowDomain: boolean,
): ShadowMeshInput | undefined {
  if (!fixedShadowDomain || projection === undefined) return undefined;
  return shadowMeshReadsForQuery(
    frameState.directionalShadowCache,
    worlds,
    projection,
    internals.gpuStore.meshChanges,
  );
}

/** The lease still has to collect mesh reads unless the accepted cache already holds them. */
function collectsShadowMeshReads(
  frameState: RenderFrameState,
  lease: ShadowMeshInput | undefined,
): ShadowMeshInput | undefined {
  return lease !== undefined && lease.reads !== frameState.directionalShadowCache?.meshReads
    ? lease
    : undefined;
}

function selectDirectionalShadowLod(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  fixedShadowDomain: boolean,
): RenderFrameState['directionalShadowLod'] {
  if (fixedShadowDomain && selectGpuLodLane(internals.device.caps) === 'cpu') {
    frameState.directionalShadowLod ??= { values: [], token: {} };
  } else {
    frameState.directionalShadowLod = undefined;
  }
  return frameState.directionalShadowLod;
}

/** A retained barrel-distortion graph must still match the requested extent. */
function retainedGraphExtentMismatch(
  frameState: RenderFrameState,
  acceptedExtent: RenderExtent | undefined,
  renderExtent: RenderExtent | undefined,
): boolean {
  if (frameState.barrelDistortionGraphResolution !== 'retained') return false;
  if (renderExtent === undefined) return acceptedExtent !== undefined;
  return (
    acceptedExtent?.internalWidth !== renderExtent.internalWidth ||
    acceptedExtent?.internalHeight !== renderExtent.internalHeight ||
    acceptedExtent?.outputWidth !== renderExtent.outputWidth ||
    acceptedExtent?.outputHeight !== renderExtent.outputHeight
  );
}

/** Release the unpublished resources of a plan whose recording will not use its candidate. */
export function rejectFeaturePlan(plan: ViewFeaturePlan): void {
  plan.candidate?.onRejected?.();
}

/**
 * The Feature and pass plans RenderQueue wrote for this recording's view. A
 * plan RenderQueue did not write is fired and rejects the Feature candidate.
 */
function consumeViewPlans(
  internals: RenderSystemInternals,
): Result<
  { featurePlan: ViewFeaturePlan; passPlan: ViewPassPlan },
  RendererOperationError<'graph-build-failed'>
> {
  const feature = consumeViewFeaturePlan(internals);
  if (!feature.ok) {
    return err(planMissingError(feature.error));
  }
  const pass = consumeViewPassPlan(internals);
  if (!pass.ok) {
    rejectFeaturePlan(feature.value);
    return err(planMissingError(pass.error));
  }
  return ok({ featurePlan: feature.value, passPlan: pass.value });
}

/** A plan RenderQueue did not write fails this view's draw as data; the world stays healthy. */
export function planMissingError(
  missing: FeaturePlanMissing | PassPlanMissing,
): RendererOperationError<'graph-build-failed'> {
  return new RendererOperationError('graph-build-failed', {
    operation: 'draw',
    cause: {
      code: missing.code,
      expected: `${missing.system} plans the recorded view in RenderQueue`,
      hint: 'keep the RenderQueue plan systems registered',
      detail: { system: missing.system },
    },
  });
}

/**
 * The compiled graph is the acceptance boundary for the prepared Standard
 * lighting declaration. Upload the same declaration only after that graph is
 * current; a failed candidate therefore cannot leave an old graph consuming a
 * new buffer generation.
 */
function uploadAcceptedStandardLighting(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ViewLights,
  standard: StandardTopologyInputValue,
  profilePhase: RecordProfileRunner | undefined,
  projectorLightSlot: number | undefined,
  captureOnly: boolean,
): boolean {
  if (captureOnly) return true;
  if (frameState.standardLightingGraphSignature !== standardLightingTopologySignature(standard)) {
    internals.errorRegistry.fire(
      new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        cause: {
          code: 'standard-graph-generation-mismatch',
          expected: 'compiled graph and prepared Standard lighting share one topology signature',
          hint: 'retry the frame after the Standard graph candidate is accepted',
          detail: {
            expected: standardLightingTopologySignature(standard),
            actual: frameState.standardLightingGraphSignature,
          },
        },
      }),
    );
    return false;
  }
  if (standard.kind !== 'clustered') return true;
  // The clustered HDRP payload owns the direct-light slot upload, so it must
  // also drive the shared IES/light-texture resource upload from the
  // authoritative extracted-light corpus. The prepared local carrier can omit
  // the source payload on this path, leaving the shader bound to its white
  // Cookie fallback even though the authored handle is valid.
  writeLightModifierTextures(internals, pipelineState, lights);
  const clusterWrite = runRecordProfilePhase(profilePhase, 'record/scene-state/hdrp-cluster', () =>
    writeHdrpClusterAndSsaoBuffers(
      internals,
      frameState,
      camera,
      standard.prepared,
      standard.transport,
      profilePhase,
      pipelineState.hdrpClusterMembershipPipeline !== null,
      pipelineState.hdrpClusterMembershipBindGroupLayout,
      projectorLightSlot,
      pipelineState,
    ),
  );
  if (!clusterWrite.ok) {
    internals.errorRegistry.fire(clusterWrite.error);
    return false;
  }
  return true;
}

function cubeCaptureLayerWrites(
  cubeCaptureWork: readonly import('./typed-frame-graph').CubeCaptureGraphWork[],
) {
  return cubeCaptureWork.map((work) => ({ target: work.target, layer: work.layer }));
}

function captureSwapTarget(
  cubeCaptureWork: readonly import('./typed-frame-graph').CubeCaptureGraphWork[],
) {
  const capture = cubeCaptureWork[0];
  if (capture === undefined) return null;
  return {
    texture: capture.physical.texture,
    view: capture.physical.view,
    targetW: capture.physical.descriptor.width,
    targetH: capture.physical.descriptor.height,
  };
}

/**
 * Only the installed stock graph's capable Shadow lane can release its unused
 * legacy mesh slots. Every material row is kept: alpha/custom Shadow groups
 * still bind that table, and its getters/diagnostics remain observed.
 */
/** Facts unbatched validation reads beside rows and materials: residency and asset scopes. */
function directGeometryTokens(
  internals: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
): readonly unknown[] {
  return [
    recordContext(internals).deviceScope,
    internals.gpuStore.meshResidencyEpoch,
    ...worlds.flatMap((world) => [world, world.revision]),
  ];
}

function gpuOwnsShadowGeometryFor(
  rendererRecording: boolean,
  captureOnly: boolean,
  attempt: FrameRecordingAttempt,
  cubeCapture: CubeCaptureFrameInput | undefined,
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
  raster: PreparedGpuDrivenFrame | undefined,
): boolean {
  return (
    rendererRecording &&
    !captureOnly &&
    attempt.captureFrames.length === 0 &&
    attempt.probeCaptureFrames.length === 0 &&
    !hasCubeCaptureViews(cubeCapture) &&
    frameState.compiledFrameGraph?.graph === preflightGraph &&
    frameState.compiledFrameGraph.directionalShadowViewCount !== undefined &&
    raster?.shadowDirectRequired === false &&
    raster.shadowViewPool !== undefined
  );
}

/** Cleanup consumes rows only when a per-entity resource owner needs them. */
function* cacheRows(groups: readonly (readonly ValidatedRenderable[])[]) {
  for (const rows of groups) yield* rows;
}

function pipelinePreparationSources(
  nativeScene: PersistentGpuDrivenState | undefined,
  sourceRenderables: FrameList<RenderableSnapshot>,
): RenderableSnapshot[] {
  const sources: RenderableSnapshot[] = [];
  if (nativeScene === undefined) {
    for (const source of sourceRenderables)
      if (source.pipelinePreparation !== undefined) sources.push(source);
    return sources;
  }
  const slots = nativeScene.pipelinePreparationSlots;
  if (slots === undefined) return sources;
  const keys = FrameSet.isFixed(slots) ? slots.borrowKeys() : slots;
  for (const slot of keys) {
    const source = nativeScene.drawSnapshotAt?.(slot);
    if (source !== undefined) sources.push(source);
  }
  return sources;
}

function capsuleShadowLightFor(
  capsuleShadowDirectional: boolean,
  lights: ViewLights,
  renderables: FrameList<RenderableSnapshot>,
) {
  if (
    !capsuleShadowDirectional ||
    lights.directional === undefined ||
    lights.cascades?.directionalShadowQuality === undefined
  ) {
    return undefined;
  }
  return {
    direction: lights.directional.direction,
    coneHalfAngle: capsuleConeHalfAngle(lights.cascades?.directionalShadowQuality),
    renderables,
  };
}

/**
 * View / mesh uniform uploads are needed when geometry or a feature consumes
 * View, or when a skybox, gradient sky, atmosphere or volume reads the View UBO. The
 * clear-pass-only path skips the writeBuffer round-trips.
 */
function frameNeedsViewUploads(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  meshRows: boolean,
  raster: PreparedGpuDrivenFrame | undefined,
  materialSlotCount: number,
  skyboxActive: boolean,
  activeVolume: VolumetricFogFrameContext | undefined,
  preparedVolume: VolumetricFogFrameContext | undefined,
): boolean {
  return (
    meshRows ||
    (raster !== undefined && materialSlotCount > 0) ||
    getRenderFeatureGraphState(internals).plans.some(({ plan }) => plan.passes.length > 0) ||
    skyboxActive ||
    frameState.environmentFrame?.source.kind === 'atmosphere' ||
    activeVolume !== undefined ||
    preparedVolume !== undefined
  );
}

function sealPreparedResourceReads(
  internals: RenderSystemInternals,
  attempt: FrameRecordingAttempt,
): boolean {
  const sealedReads = attempt.preparedGpuDriven?._sealResourceReads();
  if (sealedReads === undefined || sealedReads.ok) return true;
  internals.errorRegistry.fire(sealedReads.error);
  return false;
}

function currentShadowMeshInput(
  shadowGeometryFixed: boolean,
  lease: ShadowMeshInput | undefined,
): ShadowMeshInput | undefined {
  return shadowGeometryFixed && lease !== undefined && shadowMeshInputCurrent(lease)
    ? lease
    : undefined;
}

/** Staggered cascades without a GPU shadow pool publish one cascade cadence. */
function prepareCascadeStagger(
  frameState: RenderFrameState,
  lights: ViewLights,
  worlds: readonly RenderResourceScope[],
  projection: PersistentShadowCasterProjection | undefined,
  raster: PreparedGpuDrivenFrame | undefined,
  cacheMiss: Parameters<typeof prepareDirectionalCascadeCadence>[2],
) {
  if (
    lights.directionalCsmConfig?.staggerCascades !== true ||
    raster?.shadowViewPool !== undefined
  ) {
    return { shadowPublication: undefined, cascadeCadence: undefined };
  }
  return {
    shadowPublication: currentDirectionalShadowPublication(
      worlds,
      projection,
      frameState.directionalShadowCache,
    ),
    cascadeCadence: prepareDirectionalCascadeCadence(
      lights,
      frameState.directionalShadowCache === null ? undefined : frameState.directionalCascadeCadence,
      cacheMiss,
    ),
  };
}

function writePlanarReflectionUniform(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
  planarCapture: ReturnType<PlanarCaptureState['current']>,
): void {
  const planarUniform = encodePlanarReflectionUniform(planarCapture?.camera);
  const planarUpload = internals.device.queue.writeBuffer(
    pipelineState.viewUniformBuffer,
    PLANAR_REFLECTION_UNIFORM_OFFSET,
    planarUniform,
  );
  if (!planarUpload.ok) throw planarUpload.error;
}

/** Prepare the compiled graph's scene and shadow pipelines; pending work defers the picture. */
function prepareFramePipelines(
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
  passCtx: _InternalRenderPipelineContext,
  hasShadowViews: boolean,
  rendererRecording: boolean,
  materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  materials: MaterialFrame,
): void {
  frameState.candidatePipelinePreparations?.process(passCtx, hasShadowViews);
  if (
    frameState.compiledFrameGraph?.graph === preflightGraph &&
    frameState.compiledFrameGraph.prepareGpuDrivenPipelines?.(
      passCtx.pipelinePreparationEntries,
      materialArtifacts,
      (reason) => {
        frameState.pipelinePreparationPendingReason ??= Object.freeze(reason);
      },
      materials,
    ) === false
  ) {
    markPipelinePreparationPending(frameState, { code: 'scene-pipeline-preparation' });
  }
  if (hasShadowViews)
    prepareShadowMaterialPipelines(
      passCtx,
      rendererRecording,
      frameState.compiledFrameGraph?.graph === preflightGraph
        ? frameState.compiledFrameGraph.requiresShadowPipelinePreparation
        : undefined,
    );
}

function stageReflectionFallbackReadback(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): ReflectionFallbackReadbackRequest | undefined {
  if (internals.captureReflectionFallbackReadback !== true) return undefined;
  const request = createReflectionFallbackReadbackRequest(internals, frameState);
  if (request !== undefined) frameState.reflectionFallbackReadback = request;
  return request;
}

/**
 * Preparation precedes graph compilation. Accept the submitted stock graph's
 * generation with its depth, rather than invalidating it again next frame.
 */
function submittedShadowGraphGenerationFor(
  rendererRecording: boolean,
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
): number | undefined {
  return rendererRecording &&
    frameState.activePipeline === standardPipeline &&
    frameState.compiledFrameGraph?.graph === preflightGraph
    ? frameState.graphGeneration
    : undefined;
}

/**
 * Reuse an existing timing owner. Otherwise allocate only for this ready
 * frame, with at most one DRS readback outstanding across view changes.
 */
function allocateResolutionTiming(
  internals: RenderSystemInternals,
  sampleResolution: boolean,
  timingCapture: GpuTimingCapture | undefined,
): GpuTimingCapture | undefined {
  if (
    !sampleResolution ||
    timingCapture !== undefined ||
    (internals.gpuPassTimingSession !== undefined &&
      internals.gpuPassTimingFrameIdentity !== undefined)
  ) {
    return undefined;
  }
  const created = GpuTimingCapture.create(internals.device);
  return created.ok ? created.value : undefined;
}

function beginShadowRasterTelemetry(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  raster: PreparedGpuDrivenFrame | undefined,
): void {
  if (internals.shadowWorkload === true && internals.observationFrameId !== undefined) {
    raster?.shadowViewPool?._setTelemetrySubmit({
      frameId: internals.observationFrameId,
      deviceGeneration: recordContext(internals).deviceScope.generation,
      graphGeneration: frameState.graphGeneration,
    });
  }
  frameState.shadowRaster.begin(internals.shadowWorkload === true, internals.observationFrameId);
}

function submittedFrameInspection(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  standard: StandardTopologyInputValue,
  lights: ViewLights,
  transparency: TransparencyInspection,
  renderables: FrameList<RenderableSnapshot>,
  materials: MaterialFrame,
  capsuleShadowDirectional: boolean,
): NonNullable<RenderFrameState['submittedInspection']> {
  return {
    standardLighting: inspectStandardLighting(standard),
    pointShadow: inspectPointShadow(lights.pointShadow, SHADOW_ATLAS_DEFAULT_LAYERS),
    transparency,
    capsuleShadow: inspectCapsuleShadow(
      renderables,
      materials,
      capsuleShadowDirectional,
      lights.cascades?.directionalShadowQuality !== undefined,
      frameState.capsuleShadowSubmission,
      internals.demandCapsuleShadow ?? (() => undefined),
    ),
  };
}

function discardReflectionFallbackReadback(
  internals: RenderSystemInternals,
  request: ReflectionFallbackReadbackRequest | undefined,
): void {
  if (request !== undefined) internals.device.destroyBuffer(request.buffer);
}

/** Publish the reflection-fallback readback once its submission completes. */
function observeReflectionFallbackReadback(
  internals: RenderSystemInternals,
  attempt: FrameRecordingAttempt,
  request: ReflectionFallbackReadbackRequest | undefined,
  cubeCapture: CubeCaptureFrameInput | undefined,
  done: Promise<unknown>,
): void {
  if (request === undefined) return;
  attempt.fallbackReadback = done.then(
    () =>
      mapReflectionFallbackReadback(
        internals,
        request,
        cubeCapture?.reflectionProbes?.fallbackHasNonNeutral !== true,
      ),
    (cause) => {
      internals.device.destroyBuffer(request.buffer);
      throw cause;
    },
  );
}

/** Direct harness: one submission whose RenderRecord opens the frame encoder. */

export interface FrameRecordingInput {
  readonly internals: RenderSystemInternals;
  readonly world: RenderResourceScope;
  readonly cameras: CameraSnapshot[];
  readonly lights: ViewLights;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly transparentDispatch: DispatchList;
  readonly frameState: RenderFrameState;
  readonly dispatchCounts: DispatchCounts;
  readonly bindGroupCounts: BindGroupCounts;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
  readonly worlds: readonly RenderResourceScope[] | undefined;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly gpuDriven: GpuDrivenRecordInput | undefined;
  readonly renderReadLeases: readonly RenderReadLease[] | undefined;
  readonly cubeCapture: CubeCaptureFrameInput | undefined;
  readonly environmentSignature: string | undefined;
  readonly fogSignature: string | undefined;
  readonly environmentReady: boolean | undefined;
  readonly volumetricFog: ExtractedVolumetricFog | undefined;
  readonly timingCapture: GpuTimingCapture | undefined;
  readonly shadowCasterProjection: PersistentShadowCasterProjection | undefined;
  readonly shadowCasterWorldKeys: readonly number[] | undefined;
  readonly onRenderableDraw:
    | ((
        entry: Pick<ValidatedRenderable, 'source'>,
        submeshIndex?: number,
        receipt?: RenderableDrawReceipt,
      ) => void)
    | undefined;
  readonly analyticFog: FogFrame | undefined;
  readonly sampleTimeSeconds: number | undefined;
  readonly temporalReset: boolean | undefined;
  readonly cloudLayer: ExtractedCloudLayer | undefined;
  readonly directionalShadowCascadeCount: number | undefined;
  readonly rendererRecording: boolean | undefined;
}

/** Prepare the immutable material read domain and its actual direct-geometry resolvers. */
function prepareFrameMaterialReads(input: {
  readonly internals: RenderSystemInternals;
  readonly world: RenderResourceScope;
  readonly worlds: readonly RenderResourceScope[];
  readonly pipelineState: PipelineState;
  readonly frameState: RenderFrameState;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly transparentDispatch: DispatchList;
  readonly nativeScene: PersistentGpuDrivenState | undefined;
  readonly shadowCasterProjection: PersistentShadowCasterProjection | undefined;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly camera: CameraSnapshot;
}) {
  const {
    internals,
    world,
    worlds,
    pipelineState,
    frameState,
    renderables,
    transparentDispatch,
    nativeScene,
    shadowCasterProjection,
    profilePhase,
    camera,
  } = input;
  const sourceRenderables = shadowCasterProjection?.renderables ?? renderables;
  const { materials: fixedMaterials, manualSubsurface } = resolveFrameMaterials(
    shadowCasterProjection,
    sourceRenderables,
  );
  const prepareSources = (sources: FrameList<RenderableSnapshot>, dispatch: DispatchList = []) =>
    runRecordProfilePhase(profilePhase, 'record/validation', () =>
      validateRenderables(
        internals,
        world,
        worlds,
        pipelineState,
        frameState,
        sources,
        dispatch,
        EMPTY_ENTITY_KEYS,
        undefined,
        profilePhase,
        undefined,
        fixedMaterials,
        shadowCasterProjection?.content.meshes,
      ),
    );
  const prepareGeometry = (
    mesh: MeshGpuHandles,
    material: MaterialSnapshot,
    source?: RenderableSnapshot,
  ) => {
    const effective = materialGeometry(mesh, material, () =>
      internals.gpuStore.ensureNineSliceGeometry().unwrap(),
    );
    // Direct draws of a shared morph batch deform each member's own stream.
    return source?.morph === undefined
      ? effective
      : directMorphGeometry(internals, worlds, source, effective);
  };
  const lodRows = cpuLaneLodRows(internals.device.caps, camera);
  // Only the manual recorder path lacks native source bindings. Here these
  // rows are actual Direct draw inputs, not a GPU-side validation mirror.
  const manualDraws =
    nativeScene === undefined ? lodRows(prepareSources(renderables, transparentDispatch)) : [];
  return {
    sourceRenderables,
    fixedMaterials,
    manualSubsurface,
    prepareSources,
    prepareGeometry,
    manualDraws,
  };
}

/** CPU preparation before graph compilation; its product lives on the recording view. */
export function prepareFrameGraphInputs(
  input: FrameRecordingInput,
  attempt: FrameRecordingAttempt,
) {
  let {
    internals,
    world,
    cameras,
    lights,
    renderables,
    transparentDispatch,
    frameState,
    dispatchCounts,
    bindGroupCounts,
    skylight,
    skylightCount,
    skybox,
    postProcessParams,
    worlds = [world],
    profilePhase,
    gpuDriven,
    renderReadLeases,
    cubeCapture,
    environmentSignature = '',
    fogSignature = '',
    environmentReady = true,
    volumetricFog,
    timingCapture,
    shadowCasterProjection,
    shadowCasterWorldKeys,
    onRenderableDraw,
    analyticFog,
    sampleTimeSeconds,
    temporalReset = false,
    cloudLayer,
    directionalShadowCascadeCount,
    rendererRecording = false,
  } = input;

  frameState.reflectionFallbackObservationSource = undefined;
  frameState.reflectionFallbackCompletion = undefined;
  // `render-graph-settle` advances `frameState.frameNumber` exactly once per
  // recorded attempt regardless of which early-return branch is taken. The
  // boolean result reports whether the shared frame encoder reached queue
  // submission; prepared graphics uses it to distinguish in-flight from
  // unsubmitted buffer leases.
  // No Camera is a valid scene state. The internal snapshot supplies only
  // stable clear/UI frame parameters; it never becomes an authored view.
  const admitted = admitRecordScene(input);
  renderables = admitted.renderables;
  transparentDispatch = admitted.transparentDispatch;
  gpuDriven = admitted.gpuDriven;
  const captureOnly = cubeCapture?.captureOnly === true;
  const { camera } = admitted;
  if (camera === undefined) return { kind: 'rejected' as const };
  assertProbePlacementSingleView(
    internals,
    frameState,
    camera,
    cameras.length,
    cubeCapture,
    captureOnly,
  );
  frameState.ssrRequested = camera.screenSpaceReflection !== undefined;
  const pipelineState = admitFramePipeline(internals, frameState);
  if (pipelineState === null) return { kind: 'rejected' as const };
  resetFrameAttemptOutputs(internals, frameState);

  const lightingPreparation = runRecordProfilePhase(profilePhase, 'record/scene-state', () => {
    const foldBuckets = runRecordProfilePhase(
      profilePhase,
      'record/scene-state/fold-buckets',
      () =>
        gpuDriven?.scene !== undefined && shadowCasterProjection !== undefined
          ? []
          : computeFoldBuckets(
              world,
              frameState,
              transparentDispatch,
              renderables.map((source) => ({
                transform: source.transform,
                material: source.material.snapshot,
              })),
            ),
    );

    // `render-standard-lighting` prepared the view's lighting in RenderPrepare.
    const lighting = consumeViewStandardLighting(internals, frameState, pipelineState, () =>
      prepareFrameLighting(internals, frameState, lights, camera, pipelineState),
    );
    if (!lighting.ok) return lighting;
    const { light, standard } = lighting.value;
    // RenderQueue planned this view's Feature composite/post candidate and pass families.
    const plans = consumeViewPlans(internals);
    if (!plans.ok) return plans;
    const { featurePlan, passPlan } = plans.value;

    return { ok: true as const, value: { foldBuckets, light, standard, featurePlan, passPlan } };
  });
  if (!lightingPreparation.ok) {
    internals.errorRegistry.fire(lightingPreparation.error);
    return { kind: 'rejected' as const };
  }
  const { foldBuckets, light, standard, featurePlan, passPlan } = lightingPreparation.value;
  const featureGraphCandidate = featurePlan.candidate;
  // Retain the picture and use the ordinary barrier while an authored image
  // prepares; no scene graph, history or draw receipt is promoted by it.
  if (
    shouldDeferImageDisplay(
      internals,
      world,
      frameState,
      camera,
      cameras.length,
      captureOnly,
      skylight,
      skybox,
      featureGraphCandidate,
      cubeCapture,
    )
  ) {
    return { kind: 'pending' as const, featurePlan };
  }

  // Deferred lighting is the only lane that shades capsule shadows, so only
  // there may admitted characters leave the directional cascades.
  const capsuleShadowDirectional = standard.prepared.renderPath === 'deferred';

  // 0 renderables is a legitimate scene: the frame falls through to encode
  // and submit a clear-pass-only render pass so the canvas is painted with
  // `clearColor`. Geometry submission is conditional on validated rows.

  // Per-spot perspective `lightViewProj` matrices fold into the View UBO
  // tail and are written with the per-frame view payload below.
  // `render-view-topology` planned this view's shadow size, terrain receivers,
  // cloud shadow, analytic fog and volumetric fog in RenderPrepare.
  const {
    directionalShadowMapSize: effectiveShadowMapSize,
    spotShadowMapSize: effectiveSpotShadowMapSize,
    shadowMapSize: graphShadowMapSize,
    terrainReceivers,
    cloudShadow: cloudShadowProjection,
    analyticFog: analyticFogActive,
    volume,
  } = consumeViewTopology(internals, () =>
    planViewTopology({
      internals,
      frameState,
      world,
      worlds,
      camera,
      lights,
      sourceRenderables: shadowCasterProjection?.renderables ?? renderables,
      volumetricFog,
      cloudLayer,
      analyticFog,
    }),
  );
  attempt.volumeInspectionReady = true;
  attempt.volumeCapability = volume.capability;
  attempt.viewVolumetricFog = volume.viewFog;
  attempt.preparedVolumetricFog = volume.prepared;
  const directionalPreparationLimit = directionalShadowPreparationLimit(
    directionalShadowCascadeCount,
    frameState.compiledFrameGraph,
    frameState.compiledFrameGraphCandidate?.previous.installed,
  );
  let frameShadowPlanes: ReadonlyMap<string, Float32Array> | undefined;
  const shadowPlanesByView = (): ReadonlyMap<string, Float32Array> => {
    frameShadowPlanes ??= shadowViewPlanesByView(lights.shadowViews, directionalPreparationLimit);
    return frameShadowPlanes;
  };
  const hasShadowViews = hasShadowViewDemand(lights);

  let acceptedMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  let acceptedShadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  let materialBindingClasses: ReadonlyMap<string, string> | undefined;
  let directShadowValidated: readonly ValidatedRenderable[] | undefined;
  const cubeCaptureWork = prepareCubeCapture(cubeCapture);
  const captureViewWork = prepareCaptureView(internals, camera);
  if (captureViewWork === undefined) return { kind: 'rejected' as const };
  // `render-ssr-admission` admitted this view's SSR in RenderQueue.
  const ssr = consumeViewSsrAdmission(internals, camera);
  // `render-history-admission` admitted this view's fog and SSR history in RenderQueue.
  const history = consumeViewHistoryAdmission(internals);
  // `render-gpu-driven-prepare` queried this view's GPU Scene and selected its lane in RenderQueue.
  const consumedGpuDriven = consumeRecordingGpuDriven(
    {
      internals,
      frameState,
      worlds,
      camera,
      lights,
      renderables,
      shadowCasterProjection,
      materialBindingClasses:
        cubeCapture?.reflectionProbes?.bindingClasses ?? EMPTY_MATERIAL_BINDINGS,
      profilePhase,
    },
    gpuDriven,
    standard,
    pipelineState,
  );
  if (consumedGpuDriven === undefined) return { kind: 'rejected' as const };
  gpuDriven = consumedGpuDriven.input;
  const frameGpuDriven = consumedGpuDriven.frame;
  const gpuInput = consumedGpuDriven.gpuInput;
  const gpuDrivenMeshes = gpuInput.meshes;
  attempt.preparedGpuDriven = consumedGpuDriven.prepared;
  const nativeScene = gpuDriven?.scene;
  const {
    sourceRenderables,
    fixedMaterials,
    manualSubsurface,
    prepareSources,
    prepareGeometry,
    manualDraws,
  } = prepareFrameMaterialReads({
    internals,
    world,
    worlds,
    pipelineState,
    frameState,
    renderables,
    transparentDispatch,
    nativeScene,
    shadowCasterProjection,
    profilePhase,
    camera,
  });
  const fixedShadowDomain = isFixedShadowDomain(
    rendererRecording,
    captureOnly,
    nativeScene,
    shadowCasterProjection,
    lights,
    effectiveShadowMapSize,
  );
  attempt.shadowMeshLease = fixedShadowMeshLease(
    internals,
    frameState,
    worlds,
    shadowCasterProjection,
    fixedShadowDomain,
  );
  const shadowMeshReads = collectsShadowMeshReads(frameState, attempt.shadowMeshLease);
  // CPU material-derived selection has no fixed source witness yet.
  let shadowGeometryFixed = fixedShadowDomain;
  const directGeometry = directGeometryTokens(internals, worlds);
  const shadowLodSelection = selectDirectionalShadowLod(internals, frameState, fixedShadowDomain);
  const shadowLodRows = cpuLaneLodRows(internals.device.caps, camera, shadowLodSelection);
  frameState.drawPhases ??= new ViewDrawPhases();
  const drawPhases = frameState.drawPhases;
  const directShadowInputs = (scene: PersistentGpuDrivenState): DirectShadowInputs => ({
    scene,
    phases: drawPhases,
    meshes: gpuDrivenMeshes,
    worlds,
    materials: fixedMaterials,
    prepareSources,
    viewDraws: shadowCasterProjection?.content.viewDraws,
    prepareGeometry,
    geometry: directGeometry,
    lodRows: shadowLodRows,
  });
  const gpuShadowMaterials = gpuInput.shadowMaterials;
  const directShadowMaterials = new ShadowMaterialContent();
  // `render-subsurface-admission` admitted this view's diffusion lane in RenderQueue.
  const subsurface = consumeViewSubsurface(internals, cubeCapture, captureOnly, () =>
    subsurfaceAdmissionInput(
      internals,
      frameState,
      camera,
      renderables.length,
      shadowCasterProjection,
      manualSubsurface,
      captureOnly,
    ),
  );
  if (!subsurface.ok) {
    internals.errorRegistry.fire(subsurface.error);
    return { kind: 'rejected' as const };
  }
  const ssrAdmission = ssr.admission;
  const { visibleSurface } = gpuInput;
  if (frameGpuDriven !== undefined) {
    const gpuShadowViews = gpuInput.shadowViews;
    const artifacts = gpuInput.artifacts;
    if (artifacts === undefined)
      throw new Error('GPU-driven preparation requires its material artifacts');
    materialBindingClasses = gpuInput.materialBindingClasses;
    acceptedMaterialArtifacts = artifacts.materialArtifacts;
    acceptedShadowMaterialArtifacts = artifacts.shadowMaterialArtifacts;
    if (
      !prepareGpuDrivenRecordingShadows(
        internals,
        gpuInput,
        frameGpuDriven,
        attempt,
        profilePhase,
        lights,
        shadowMeshReads,
        shadowPlanesByView,
        graphShadowMapSize,
        frameState.graphGeneration,
        directionalPreparationLimit,
      )
    )
      return { kind: 'rejected' as const };
    if (frameGpuDriven.scene !== undefined) {
      const shadows = gpuLaneDirectShadowRows(
        attempt.preparedGpuDriven,
        gpuShadowViews,
        artifacts.batchExecutions,
        cubeCaptureWork.length,
        cubeCapture,
        directShadowInputs(frameGpuDriven.scene),
      );
      if (shadows?.derived === true) shadowGeometryFixed = false;
      directShadowValidated = shadows?.rows;
    }
  }

  // Direct acceptance keeps main preparation/residency and Surface
  // page/frame/shared-time validation on the same submit hooks. Its CPU
  // shadows need no GPU shadow plan; the empty view list above retires any
  // prior GPU shadow state through the ordinary submission transaction.
  const { raster: rasterGpuDriven, selection: gpuSelection } = consumeViewGpuDrivenRaster(
    internals,
    gpuDriven,
    frameGpuDriven,
    attempt.preparedGpuDriven,
    captureViewsCastShadows(cubeCaptureWork.length, cubeCapture),
    shadowCasterProjection?.materialPrograms,
  );
  if (hasShadowViews && directShadowValidated === undefined) {
    if (nativeScene === undefined)
      directShadowValidated = shadowLodRows(
        prepareSources(sourceRenderables, shadowCasterProjection?.dispatch ?? transparentDispatch),
      );
    else {
      const shadows = validateDirectShadowRows(directShadowInputs(nativeScene));
      if (shadows.derived) shadowGeometryFixed = false;
      directShadowValidated = shadows.rows;
    }
  }
  collectDirectShadowMaterials(
    internals,
    worlds,
    directShadowValidated,
    fixedMaterials,
    directShadowMaterials,
    shadowMeshReads,
  );

  // Compile the single frame graph only after GPU preparation has projected
  // the current frame. This keeps the graph topology and its execution
  // closure on the same prepared GPU-owned draw set.
  // `view-diffuse-gi` prepared this view's resolution and GI in RenderPrepare.
  const { resolution, renderExtent, gi } = consumeViewDiffuseGi(
    internals,
    frameState,
    world,
    worlds,
    camera,
  );
  frameState.probePlacementFrame = gi.probePlacement;
  // `view-points-lines` prepared this view's Points/Lines rows in RenderPrepare.
  const pointsLines = consumeViewPointsLines(internals);

  return {
    kind: 'prepared' as const,
    internals,
    frameState,
    pipelineState,
    cubeCapture,
    cubeCaptureWork,
    graphShadowMapSize,
    terrainReceivers,
    profilePhase,
    captureOnly,
    attempt,
    camera,
    lights,
    rasterGpuDriven,
    featurePlan,
    cameras,
    passPlan,
    volume,
    standard,
    ssrAdmission,
    renderExtent,
    analyticFogActive,
    cloudShadowProjection,
    subsurface,
    rendererRecording,
    resolution,
    world,
    worlds,
    sampleTimeSeconds,
    visibleSurface,
    environmentSignature,
    fogSignature,
    environmentReady,
    temporalReset,
    gi,
    history,
    skybox,
    nativeScene,
    shadowCasterProjection,
    gpuSelection,
    gpuDrivenMeshes,
    prepareSources,
    prepareGeometry,
    gpuDriven,
    directGeometry,
    drawPhases,
    transparentDispatch,
    manualDraws,
    foldBuckets,
    directShadowValidated,
    materialBindingClasses,
    fixedMaterials,
    sourceRenderables,
    capsuleShadowDirectional,
    light,
    analyticFog,
    shadowGeometryFixed,
    shadowLodSelection,
    renderReadLeases,
    effectiveShadowMapSize,
    gpuShadowMaterials,
    directShadowMaterials,
    bindGroupCounts,
    postProcessParams,
    dispatchCounts,
    skylight,
    skylightCount,
    ssr,
    frameGpuDriven,
    acceptedShadowMaterialArtifacts,
    shadowPlanesByView,
    pointsLines,
    onRenderableDraw,
    effectiveSpotShadowMapSize,
    shadowCasterWorldKeys,
    hasShadowViews,
    acceptedMaterialArtifacts,
    featureGraphCandidate,
    captureViewWork,
    timingCapture,
    renderables,
    volumetricFog,
  };
}

export type PreparedFrameGraph = Extract<
  ReturnType<typeof prepareFrameGraphInputs>,
  { kind: 'prepared' }
>;

/** Stage this graph's temporal resources against its accepted history and fitted extent. */
/** Queue resolves temporal resources and writes their parameters before any encoder opens. */
export function resolveQueuedFrameTemporal(prepared: PreparedFrameGraph) {
  const {
    internals,
    frameState,
    world,
    worlds,
    camera,
    sampleTimeSeconds,
    cameras,
    renderExtent,
    visibleSurface,
    environmentSignature,
    fogSignature,
    environmentReady,
    temporalReset,
    gi,
    ssrAdmission,
  } = prepared;
  const { targetW, targetH } = frameTargetExtent(
    internals,
    prepared.captureOnly,
    prepared.cubeCaptureWork[0]?.physical.descriptor,
  );
  const staged = viewTemporalStageOf(renderWorldFor(internals), internals.viewEntity);
  const display = prepared.rendererRecording && !prepared.captureOnly && cameras.length > 0;
  if (display && staged?.kind !== 'staged') return { kind: 'rejected' as const };
  const currentViewProjection =
    display && staged?.kind === 'staged'
      ? staged.currentViewProjection
      : computeViewProjectionMatrix(camera, mat4.create());
  const clock = frameClockSample(world, worlds, camera, sampleTimeSeconds);
  const temporal = resolveFrameTemporal(
    internals,
    frameState,
    camera,
    cameras.length,
    targetW,
    targetH,
    renderExtent,
    visibleSurface !== undefined,
    clock,
    environmentSignature,
    fogSignature,
    environmentReady,
    temporalReset,
    currentViewProjection,
  );
  const temporalView = temporal.view;
  reprojectDiffuseGiHistory(
    gi,
    camera,
    temporalView,
    temporal.previous,
    temporal.continuousGeometry,
  );
  if (
    !beginSsrHistoryFrame(
      internals,
      frameState,
      ssrAdmission,
      consumeViewSsrHistoryStage(internals, ssrAdmission),
      temporalView,
    )
  ) {
    return { kind: 'rejected' as const };
  }
  return { kind: 'resolved' as const, clock, temporal, temporalView, targetW, targetH };
}
export type QueuedFrameTemporalOutcome =
  | ReturnType<typeof resolveQueuedFrameTemporal>
  | { readonly kind: 'failed'; readonly cause: unknown };
type ResolvedFrameTemporal = Extract<QueuedFrameTemporalOutcome, { kind: 'resolved' }>;

function sealFrameHistory(
  prepared: PreparedFrameGraph,
  preflightGraph: CompiledFrameGraph,
  queued: ResolvedFrameTemporal,
) {
  const { internals, frameState, volume, history, camera, lights } = prepared;
  const { clock, temporal, temporalView, targetW, targetH } = queued;
  const volumeHistory = prepareVolumetricFogHistory(
    internals,
    frameState,
    volume,
    history.fog,
    preflightGraph,
    camera,
    lights,
    targetW,
    targetH,
  );
  if (volumeHistory === false) {
    return { kind: 'rejected' as const };
  }
  const activeVolumetricFogContext = volumeHistory.context;

  return {
    kind: 'history' as const,
    clock,
    temporal,
    temporalView,
    volumeHistory,
    activeVolumetricFogContext,
  };
}

/** Seal selected graph resources, upload its view, resolve bindings and prepare native pipelines. */
export function sealFrameGraph(
  prepared: PreparedFrameGraph,
  preflightGraph: CompiledFrameGraph,
  queued: ResolvedFrameTemporal,
) {
  const {
    internals,
    frameState,
    pipelineState,
    camera,
    lights,
    standard,
    profilePhase,
    volume,
    captureOnly,
    world,
    worlds,
    renderExtent,
    visibleSurface,
    gi,
    skybox,
    rendererRecording,
    attempt,
    cubeCapture,
    rasterGpuDriven,
    nativeScene,
    shadowCasterProjection,
    gpuSelection,
    gpuDrivenMeshes,
    prepareSources,
    prepareGeometry,
    gpuDriven,
    directGeometry,
    drawPhases,
    transparentDispatch,
    manualDraws,
    foldBuckets,
    directShadowValidated,
    materialBindingClasses,
    fixedMaterials,
    sourceRenderables,
    capsuleShadowDirectional,
    light,
    cloudShadowProjection,
    analyticFog,
    shadowGeometryFixed,
    shadowLodSelection,
    renderReadLeases,
    effectiveShadowMapSize,
    gpuShadowMaterials,
    directShadowMaterials,
    bindGroupCounts,
    postProcessParams,
    dispatchCounts,
    skylight,
    skylightCount,
    ssr,
    frameGpuDriven,
    acceptedShadowMaterialArtifacts,
    shadowPlanesByView,
    pointsLines,
    onRenderableDraw,
    effectiveSpotShadowMapSize,
    shadowCasterWorldKeys,
    hasShadowViews,
    acceptedMaterialArtifacts,
  } = prepared;
  if (
    !uploadAcceptedStandardLighting(
      internals,
      frameState,
      pipelineState,
      camera,
      lights,
      standard,
      profilePhase,
      volume.spotLightProjector?.lightSlotIndex,
      captureOnly,
    )
  ) {
    return { kind: 'rejected' as const };
  }

  // Acquiring a canvas texture can replace its displayed picture even when
  // no raster work follows. Preparation needs only the target extent; keep
  // the surface untouched until the scene's native pipelines are ready.
  const target: { current: ReturnType<typeof acquireSwapChainTarget> | undefined } = {
    current: undefined,
  };
  const { targetW, targetH } = queued;
  const submittedBarrelMapping = captureOnly
    ? undefined
    : resolveSubmittedBarrelMapping(frameState, preflightGraph, camera, targetW, targetH);

  const sealedHistory = sealFrameHistory(prepared, preflightGraph, queued);
  if (sealedHistory.kind === 'rejected') return { kind: 'rejected' as const };
  const { clock, temporal, temporalView, volumeHistory, activeVolumetricFogContext } =
    sealedHistory;

  // The clear color is read from the active CameraSnapshot's single
  // `clearColor` field; the zero-camera fallback carries [0, 0, 0, 1]. A
  // GradientSky owns the background and clears transparent instead.
  const clear = camera.clearColor;

  // Tonemap + skybox-active resolution (skybox requires tonemap HDR target +
  // a resident cubemap view).
  const { tonemapActive, skyboxActive } = resolveSkyboxActive(
    internals,
    frameState,
    temporal.recordCamera,
    skybox,
    world,
  );

  // MSAA is a per-Camera switch derived from `camera.antialias`. When active
  // the geometry pass writes a count=4 multisample colour target and
  // resolves to a single-sample output with the `*Msaa` pipeline variants.
  const msaaActive =
    camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
  const geometryDepthKey: string | null = null;
  const gpuOwnsShadowGeometry = gpuOwnsShadowGeometryFor(
    rendererRecording,
    captureOnly,
    attempt,
    cubeCapture,
    frameState,
    preflightGraph,
    rasterGpuDriven,
  );

  const sceneWork =
    nativeScene === undefined || shadowCasterProjection === undefined
      ? undefined
      : prepareScenePasses(
          [
            preflightGraph,
            ...attempt.captureFrames.map(({ graph }) => graph),
            ...attempt.probeCaptureFrames.map(({ graph }) => graph),
          ].flatMap(scenePassRequests),
          {
            scene: nativeScene,
            retainMaterialBindings: canRetainMaterialBindings(materialBindingClasses),
            materials: shadowCasterProjection.content.materials,
            gpu: gpuSelection,
            meshes: gpuDrivenMeshes,
            worlds,
            prepareUnbatched: prepareSources,
            viewDraws: shadowCasterProjection.content.viewDraws ?? [],
            prepareGeometry,
            fold: (dispatch, sources) => computeFoldBuckets(world, frameState, dispatch, sources),
            lod: (rows, request) =>
              cpuLaneLodRows(internals.device.caps, request.camera?.() ?? camera)(rows),
            world,
            camera,
            cameraVisible: gpuDriven?.cameraVisible,
            cameraAdmission: gpuDriven?.cameraAdmission,
            geometry: directGeometry,
            phases: drawPhases,
          },
        );
  const sceneDispatch = sceneWork?.dispatch ?? transparentDispatch;

  // Dispatch-ordered render plan: reorder validated renderables to dispatch
  // order, run the mesh-SSBO capacity gate (graceful truncation), and build
  // the fold dispatch plan.
  const dispatchPlan = runRecordProfilePhase(profilePhase, 'record/dispatch-plan', () =>
    buildDispatchPlan(
      internals,
      sceneWork?.rows ?? manualDraws,
      sceneDispatch,
      sceneWork?.buckets ?? foldBuckets,
      directShadowValidated ?? [],
      materialBindingClasses,
      gpuOwnsShadowGeometry,
      { bindings: rasterGpuDriven?.materialBindings ?? [], worlds, frame: fixedMaterials },
      shadowCasterProjection?.meshDraws,
      // Scene-pass rows are this frame's fresh projections.
      sceneWork !== undefined,
      sceneWork === undefined
        ? undefined
        : {
            owner: drawPhases.materialBindings,
            renderables: sceneWork.rows,
            rows: sceneWork.materialRows,
          },
    ),
  );
  const validatedOrdered = dispatchPlan.validatedOrdered;
  const shadowValidatedOrdered = dispatchPlan.shadowValidatedOrdered;
  const scenePassWork = sceneWork?.finish(dispatchPlan);
  const pipelinePreparationEntries = prepareSources(
    pipelinePreparationSources(nativeScene, sourceRenderables),
  );
  cleanPerFrameCaches(
    internals,
    frameState,
    cacheRows([validatedOrdered, shadowValidatedOrdered, pipelinePreparationEntries]),
    undefined,
    retainedFoldInstanceKeys(dispatchPlan.foldDispatchPlan, validatedOrdered),
  );

  const capsuleShadowLight = capsuleShadowLightFor(
    capsuleShadowDirectional,
    lights,
    sourceRenderables,
  );
  frameState.capsuleShadowSubmission = undefined;
  const shadowMaterialRowBase = validatedOrdered.length;
  const materialSlotIndices = dispatchPlan.materialSlotIndices;
  const materialSlots = dispatchPlan.materialSlots;
  const materialSlotCount = dispatchPlan.materialSlotCount;

  // When the LDR path (tonemapActive=false) has transparent entities in the
  // validated draw list, the render is split into two serial passes sharing
  // one color attachment; see computeSplitLdrSprite for the format contract.
  const splitLdrSprite = computeSplitLdrSprite(validatedOrdered, tonemapActive, sceneDispatch);

  const meshRows = validatedOrdered.length + shadowValidatedOrdered.length > 0;
  if (
    frameNeedsViewUploads(
      internals,
      frameState,
      meshRows,
      rasterGpuDriven,
      materialSlotCount,
      skyboxActive,
      activeVolumetricFogContext,
      volume.prepared,
    )
  ) {
    runRecordProfilePhase(profilePhase, 'record/uploads', () => {
      // View UBO + CSM/spot-shadow matrix pack: assembled + uploaded in one
      // queue.writeBuffer round-trip. The stable projection is carried in
      // the View UBO; direct-sun shader consumers sample the renderer-owned
      // map at each receiver position.
      writeViewUbo(
        internals.device.queue,
        pipelineState.viewUniformBuffer,
        camera,
        light,
        lights,
        frameState.spotShadowSnapshots,
        temporalView,
        volume.spotLightProjector?.spotIndex,
        cloudShadowProjection,
        analyticFog,
        frameState.environmentFrame?.source.kind === 'atmosphere'
          ? frameState.environmentFrame.source.atmosphere
          : undefined,
        recordContext(internals).captureView !== undefined,
        clock.elapsedSeconds,
        { width: targetW, height: targetH },
      );
      if (pipelineState.pointsLinesViewBuffer !== undefined) {
        writePointsLinesViewUbo(
          internals.device.queue,
          pipelineState.pointsLinesViewBuffer,
          camera,
          targetW,
          targetH,
        );
      }
      writeShadowCasterUniforms(
        internals.device.queue,
        pipelineState.shadowCasterCascadeBuffer,
        lights,
      );
    });
  }

  if (!sealPreparedResourceReads(internals, attempt)) return { kind: 'rejected' as const };
  const shadowMeshInput = currentShadowMeshInput(shadowGeometryFixed, attempt.shadowMeshLease);
  const shadowLodToken = shadowLodSelection?.token;
  const directionalShadowCache = runRecordProfilePhase(
    profilePhase,
    'record/scene-state/directional-shadow-cache',
    () =>
      prepareDirectionalShadowCache(
        internals,
        frameState,
        worlds,
        renderReadLeases,
        lights,
        effectiveShadowMapSize,
        shadowMeshInput,
        shadowCasterProjection,
        [gpuShadowMaterials, directShadowMaterials],
        shadowLodToken,
      ),
  );
  frameState.directionalShadowCacheRecorded = false;
  const { shadowPublication, cascadeCadence } = prepareCascadeStagger(
    frameState,
    lights,
    worlds,
    shadowCasterProjection,
    rasterGpuDriven,
    directionalShadowCache.miss,
  );

  // RenderRecord opened the submission's one encoder before any view records.
  const encoder = frameEncoder(renderWorldFor(internals));

  // Per-frame bind group cache resolution (view / mesh / HDRP-cluster);
  // returns null groups on the clear-pass-only path.
  const { viewBindGroup, meshBindGroup, hdrpClusterBindGroup, hdrpClusterMembershipBindGroup } =
    runRecordProfilePhase(profilePhase, 'record/bind-groups', () =>
      buildPerFrameBindGroups(
        internals,
        frameState,
        pipelineState,
        meshRows || rasterGpuDriven !== undefined,
        bindGroupCounts,
        undefined,
        true,
        standard,
      ),
    );

  const planarCapture = cubeCapture?.state.planar?.current();
  writePlanarReflectionUniform(internals, pipelineState, planarCapture);

  // The compiled typed graph is the sole per-frame pass owner. Every pass
  // records into the shared encoder; the graph owns ordering and the
  // renderer finishes and submits exactly once after graph execution.
  const framePostProcessParams = buildFramePostProcessParams(
    internals,
    frameState,
    camera,
    postProcessParams,
    temporal.motionBlurDemand,
    temporal.deltaSeconds,
    temporalView,
    targetH,
    submittedBarrelMapping,
  );

  observePreparedResourceGeneration(frameState, attempt.preparedGpuDriven);
  const publishShadowRows =
    shadowValidatedOrdered.length > 0 ||
    gpuOwnsShadowGeometry ||
    directShadowValidated !== undefined;
  const shadowDispatch = shadowCasterProjection?.dispatch;
  const passCtx: _InternalRenderPipelineContext = {
    // A fixed first field avoids growing this frame's object storage.
    pipelinePreparationEntries,
    ...scenePassInputs(scenePassWork, visibleSurface, gi.probePlacement),
    mainPassMaterialSelection: createMainPassMaterialSelectionOwner({
      dispatch: sceneDispatch,
      validatedOrdered,
      materialSlotIndices,
      materialSlots,
      ...(publishShadowRows ? { shadowValidatedOrdered } : {}),
      ...(shadowDispatch === undefined ? {} : { shadowDispatch }),
    }),
    resourceScopes: worlds,
    assets: internals.assets,
    world,
    store: internals.gpuStore,
    pipelineState,
    bloomResources: pipelineState.perPassResources.getBloomResources?.() ?? null,
    runtime: internals,
    encoder,
    outputTarget: () => requireFrameTarget(target.current),
    clear,
    targetW,
    targetH,
    ...(renderExtent === undefined ? {} : { extent: renderExtent }),
    camera: temporal.recordCamera,
    tonemapActive,
    geometryDepthKey,
    validatedOrdered,
    viewBindGroup,
    meshBindGroup,
    frameState,
    dispatchCounts,
    bindGroupCounts,
    skylight,
    skylightCount,
    skyboxActive,
    skybox,
    splitLdrSprite,
    msaaActive,
    postProcessParams: framePostProcessParams,
    ...shaderSourcePassContext(internals),
    ...volumetricFogPassContext(
      camera,
      activeVolumetricFogContext,
      volume.graphFog,
      temporal.currentUnjitteredViewProjection,
    ),
    ...(volume.spotLightProjector === undefined
      ? {}
      : { spotLightProjector: volume.spotLightProjector }),
    dispatch: sceneDispatch,
    hdrpClusterBindGroup,
    hdrpClusterMembershipBindGroup,
    standardLighting: standard,
    reflectionFallbackDemand: ssr.reflectionFallbackDemand,
    foldDispatchPlan: dispatchPlan.foldDispatchPlan,
    materialSlotIndices,
    materialSlots,
    materialBindings: dispatchPlan.materialBindings,
    materialBindingSlots: dispatchPlan.materialBindingSlots,
    materialSlotCount,
    ...gpuDrivenPassContext(
      frameState,
      frameGpuDriven,
      attempt.preparedGpuDriven,
      rasterGpuDriven,
      gpuSelection,
      acceptedShadowMaterialArtifacts,
    ),
    shadowViewPlanesByView: shadowPlanesByView(),
    materialFrame: fixedMaterials,
    ...capturePassContext(cubeCapture, planarCapture),
    pointsLines,
    materialBgAssemblyCache: frameState.materialBgAssemblyCache,
    ...(onRenderableDraw === undefined ? {} : { onRenderableDraw }),
    shadowUpdatePolicy: createShadowUpdatePolicy(
      lights,
      worlds,
      effectiveShadowMapSize,
      effectiveSpotShadowMapSize,
      () => frameState.pointShadowAtlas?.getTexture() ?? undefined,
    ),
    directionalShadowCacheMiss: directionalShadowCache.miss,
    capsuleShadowDirectional,
    ...shadowPassContext(
      shadowCasterProjection,
      cascadeCadence,
      capsuleShadowLight,
      publishShadowRows,
      shadowValidatedOrdered,
      shadowMaterialRowBase,
      shadowCasterWorldKeys,
    ),
    ...(profilePhase !== undefined ? { profilePhase } : {}),
  };
  prepareFramePipelines(
    frameState,
    preflightGraph,
    passCtx,
    hasShadowViews,
    rendererRecording,
    acceptedMaterialArtifacts,
    fixedMaterials,
  );

  return {
    kind: 'sealed' as const,
    target,
    passCtx,
    clock,
    meshRows,
    encoder,
    activeVolumetricFogContext,
    shadowPublication,
    shadowMeshInput,
    shadowLodToken,
    submittedBarrelMapping,
    cascadeCadence,
    directionalShadowCache,
    volumeHistory,
  };
}

export type SealedFrameGraph = Extract<ReturnType<typeof sealFrameGraph>, { kind: 'sealed' }>;

/** Direct harness compile input; production graph compilation reads the existing view components. */
export function compileDirectPreparedGraph(prepared: PreparedFrameGraph): ViewGraphCompileOutcome {
  const {
    internals,
    frameState,
    pipelineState,
    camera,
    lights,
    graphShadowMapSize,
    rasterGpuDriven,
    featurePlan,
    fixedMaterials,
    cubeCapture,
    cameras,
    passPlan,
    volume,
    standard,
    ssrAdmission,
    renderExtent,
    analyticFogActive,
    cloudShadowProjection,
    terrainReceivers,
    subsurface,
    rendererRecording,
  } = prepared;
  return compileViewGraph({
    internals,
    frameState,
    pipelineState,
    camera,
    lights,
    surface: recordContext(internals).canvas,
    shadowMapSize: graphShadowMapSize,
    gpuDriven: rasterGpuDriven,
    featurePlan,
    cubeCaptureState: recordContext(internals).captureView?.state ?? cubeCapture?.state,
    clearOnly: cameras.length === 0,
    passPlan,
    unfoggedOpaque: fixedMaterials.hasUnfoggedOpaque,
    volumetricFog: volume.graphFog,
    volumeTopologyCandidate: volume.topologyCandidate,
    standardLighting: standard,
    ssr: ssrAdmission,
    renderExtent,
    analyticFog: analyticFogActive,
    cloudShadowResolution: cloudShadowProjection?.resolution,
    terrainReceivers,
    subsurface: subsurface.value,
    rendererRecording,
    shadowDepthLayers: ensureShadowDepthLayers(frameState, internals.device),
  });
}

export type ViewGraphSealOutcome =
  | {
      readonly kind: 'sealed';
      readonly graph: CompiledFrameGraph;
      readonly value: SealedFrameGraph;
    }
  | {
      readonly kind: 'rejected';
      readonly code:
        | 'capture-compile'
        | 'view-compile'
        | 'graph-unavailable'
        | 'extent-mismatch'
        | 'resource-seal';
    }
  | {
      readonly kind: 'failed';
      readonly error: RendererOperationError<'graph-build-failed'> | ProjectedDecalInvalidError;
    };

/** Consume compiler products, adopt the selected graph and seal its actual resource domain. */
export function sealCompiledViewGraph(
  prepared: PreparedFrameGraph,
  compiled: ViewGraphCompileOutcome | undefined,
  captures: CaptureGraphOutcome,
  temporal: QueuedFrameTemporalOutcome | undefined,
): ViewGraphSealOutcome {
  const { internals, frameState, attempt, captureOnly, profilePhase, resolution, renderExtent } =
    prepared;
  if (!captures.ok) {
    internals.errorRegistry.fire(captures.error);
    return { kind: 'rejected', code: 'capture-compile' };
  }
  attempt.captureFrames = captures.value.cube;
  attempt.probeCaptureFrames = captures.value.probes;
  if (!captureOnly && compiled === undefined) return { kind: 'rejected', code: 'view-compile' };
  const graph =
    compiled === undefined
      ? (attempt.captureFrames[0]?.graph ?? null)
      : runRecordProfilePhase(profilePhase, 'record/render-graph', () =>
          adoptViewGraph(internals, frameState, compiled),
        );
  if (graph === null) return { kind: 'rejected', code: 'graph-unavailable' };
  if (retainedGraphExtentMismatch(frameState, resolution.submittedExtent, renderExtent))
    return { kind: 'rejected', code: 'extent-mismatch' };
  if (temporal === undefined || temporal.kind === 'failed')
    return {
      kind: 'failed',
      error: new RendererOperationError('graph-build-failed', {
        operation: 'draw',
        cause: {
          code: 'temporal-resolve-unavailable',
          expected:
            'render-temporal-resolve produces the current view temporal resources in RenderQueue',
          hint: 'keep the temporal resolve system registered and retry after preparation',
          detail: temporal?.cause,
        },
      }),
    };
  if (temporal.kind === 'rejected') return { kind: 'rejected', code: 'resource-seal' };
  const sealed = sealFrameGraph(prepared, graph, temporal);
  return sealed.kind === 'rejected'
    ? { kind: 'rejected', code: 'resource-seal' }
    : { kind: 'sealed', graph, value: sealed };
}

export type FrameCaptureEncodeOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'rejected' };

export function encodePreparedFrameCaptures(
  prepared: PreparedFrameGraph,
  sealed: SealedFrameGraph,
): FrameCaptureEncodeOutcome {
  const {
    frameState,
    pipelineState,
    cubeCaptureWork,
    profilePhase,
    captureOnly,
    volume,
    cloudShadowProjection,
    light,
    bindGroupCounts,
    captureViewWork,
  } = prepared;
  const { target, passCtx, clock, meshRows } = sealed;

  const { internals, attempt } = prepared;
  if (frameState.pipelinePreparationPending) return { kind: 'pending' };
  target.current = runRecordProfilePhase(profilePhase, 'record/swapchain', () =>
    captureOnly || captureViewWork.length > 0
      ? captureSwapTarget(captureOnly ? cubeCaptureWork : captureViewWork)
      : acquireSwapChainTarget(internals, pipelineState),
  );
  if (target.current === null) {
    return { kind: 'rejected' };
  }
  markCaptureGraphsEncoded(internals);
  executeCaptureFrames(
    internals,
    frameState,
    passCtx,
    [...attempt.captureFrames, ...attempt.probeCaptureFrames],
    light,
    volume.spotLightProjector?.spotIndex,
    cloudShadowProjection,
    clock.elapsedSeconds,
    meshRows,
    bindGroupCounts,
  );

  return { kind: 'ready' };
}

export type PreparedViewEncoding =
  | { readonly kind: 'capture'; readonly work: import('../assembly/frame-recording').RecordedView }
  | {
      readonly kind: 'display';
      readonly encoded: import('./typed-frame-graph').EncodedFrameGraph;
      readonly fallbackReadbackRequest: ReflectionFallbackReadbackRequest | undefined;
      readonly sampleResolution: boolean;
      readonly frameTiming: GpuTimingCapture | undefined;
    };
export type ViewFrameEncodeOutcome =
  | { readonly kind: 'encoded'; readonly value: PreparedViewEncoding }
  | { readonly kind: 'pending' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** Encode the current sealed view graph; physical submission belongs to the frame. */
export function encodePreparedViewGraph(
  prepared: PreparedFrameGraph,
  seal: Extract<ViewGraphSealOutcome, { kind: 'sealed' }>,
): ViewFrameEncodeOutcome {
  const preflightGraph = seal.graph;
  const sealed = seal.value;
  const {
    frameState,
    cubeCapture,
    cubeCaptureWork,
    profilePhase,
    captureOnly,
    rasterGpuDriven,
    volume,
    rendererRecording,
    resolution,
    gi,
    nativeScene,
    timingCapture,
  } = prepared;
  const {
    passCtx,
    encoder,
    activeVolumetricFogContext,
    shadowPublication,
    shadowMeshInput,
    shadowLodToken,
  } = sealed;

  const { internals, attempt } = prepared;
  if (frameState.pipelinePreparationPending) return { kind: 'pending' };
  if (captureOnly)
    return {
      kind: 'encoded',
      value: {
        kind: 'capture',
        work: encodeCaptureOnlyFrame(
          internals,
          frameState,
          attempt,
          encoder,
          cubeCaptureLayerWrites(cubeCaptureWork),
          nativeScene,
        ),
      },
    };
  const fallbackReadbackRequest = stageReflectionFallbackReadback(internals, frameState);
  attempt.volumeSubmissionAttempted =
    volume.topologyCandidate || activeVolumetricFogContext !== undefined;
  stageGpuDrivenCommit(
    frameState,
    attempt,
    submittedShadowGraphGenerationFor(rendererRecording, frameState, preflightGraph),
  );
  const frameHooks = frameSubmissionHooks(
    internals,
    frameState,
    attempt,
    gi,
    shadowPublication,
    nativeScene,
    shadowMeshInput,
    shadowLodToken,
  );
  const sampleResolution = resolution.needsSample;
  attempt.resolutionTiming = allocateResolutionTiming(internals, sampleResolution, timingCapture);
  const frameTiming = timingCapture ?? attempt.resolutionTiming;
  beginShadowRasterTelemetry(internals, frameState, rasterGpuDriven);
  const encoded = runRecordProfilePhase(profilePhase, 'record/graph-execute', () =>
    recordCompiledFrameGraph(
      internals,
      frameState,
      passCtx,
      encoder,
      profilePhase === undefined
        ? undefined
        : (pass, encode) => profilePhase(graphExecutionPhase(pass.name), encode),
      frameHooks,
      cubeCaptureWork.length === 0 ? undefined : cubeCaptureLayerWrites(cubeCaptureWork),
      (done) => {
        attempt.completion = done;
        frameState.surfaceSubmissionObservation?.submit(done, frameState.graphGeneration);
        observeReflectionFallbackReadback(
          internals,
          attempt,
          fallbackReadbackRequest,
          cubeCapture,
          done,
        );
      },
      frameTiming,
    ),
  );
  if (encoded.kind === 'rejected') {
    discardReflectionFallbackReadback(internals, fallbackReadbackRequest);
    return { kind: 'rejected' };
  }

  return {
    kind: 'encoded',
    value: {
      kind: 'display',
      encoded: encoded.value,
      fallbackReadbackRequest,
      sampleResolution,
      frameTiming,
    },
  };
}

/** Stage only the products of work accepted by the one frame submission. */
export function settlePreparedViewGraph(
  prepared: PreparedFrameGraph,
  seal: Extract<ViewGraphSealOutcome, { kind: 'sealed' }>,
  encoding: PreparedViewEncoding,
  result: import('../assembly/renderer-frame-transaction').RendererFrameStageResult<void>,
): boolean {
  const { internals, attempt } = prepared;
  if (encoding.kind === 'capture')
    return settleCaptureOnlyFrame(internals, prepared.frameState, attempt, result);
  const { fallbackReadbackRequest, sampleResolution, frameTiming } = encoding;
  const preflightGraph = seal.graph;
  const sealed = seal.value;
  const {
    frameState,
    lights,
    passPlan,
    volume,
    standard,
    renderExtent,
    resolution,
    gpuSelection,
    gpuDriven,
    fixedMaterials,
    sourceRenderables,
    capsuleShadowDirectional,
    frameGpuDriven,
    onRenderableDraw,
    renderables,
    volumetricFog,
  } = prepared;
  const {
    activeVolumetricFogContext,
    submittedBarrelMapping,
    cascadeCadence,
    directionalShadowCache,
    volumeHistory,
  } = sealed;

  attempt.submitted = settleEncodedFrameGraph(encoding.encoded, result);
  if (!attempt.submitted) {
    discardReflectionFallbackReadback(internals, fallbackReadbackRequest);
    return false;
  }
  // Queue acceptance alone commits no history: a Feature scene input that was
  // not ready leaves the frame unaccepted (the RenderSubmission authority).
  // Queue submission is a fact; only RenderCommit promotes the display's history.
  const display: DisplaySubmission = {
    frame: renderSubmission(renderWorldFor(internals)).frame,
    attempt,
    resolution,
    extent: renderExtent,
    rasterRows: gpuDriven?.visibleRasterRows,
    renderableCount: renderables.length,
    sampleResolution,
    timing: frameTiming,
    barrelMapping: submittedBarrelMapping,
  };
  stageDisplaySubmission(internals, frameState, display);
  emitSubmittedDrawReceipts(renderables, gpuSelection, onRenderableDraw, frameGpuDriven);
  stageSubmittedShadows(frameState, cascadeCadence, directionalShadowCache);
  frameState.volumetricFogCandidate = {
    volumetricFog,
    volume,
    context: activeVolumetricFogContext,
    signature: volumeHistory.signature,
    graph: preflightGraph,
    inspection: stagedVolumeInspection(attempt, lights),
  };
  frameState.submittedInspection = submittedFrameInspection(
    internals,
    frameState,
    standard,
    lights,
    passPlan.transparent.inspection,
    sourceRenderables,
    fixedMaterials,
    capsuleShadowDirectional,
  );
  return true;
}
