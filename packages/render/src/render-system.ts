import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle, RenderPipelineAsset } from '@forgeax/engine-types';
import { AssetError, numMipLevels } from '@forgeax/engine-types';
import {
  type DirectionalShadowInspectionSource,
  directionalShadowProfileFromQuality,
  projectDirectionalShadowInspectionSource,
} from './assembly/directional-shadow-inspection';
import { createFeatureSceneInputs } from './assembly/feature-scene-inputs';
import {
  drainFramePreparation,
  type FeatureFrameRequest,
  type FramePreparation,
  type FrameRecording,
  prepareFrameSubmission,
  profileFrameRecording,
  recordPreparationBarrier,
} from './assembly/frame-recording';
import { createGpuDrivenOwner } from './assembly/gpu-driven-owner';
import { createPostProcessParamsOwner } from './assembly/post-process-params';
import { standardBloomAdmitted } from './bloom-admission';
import type { CapsuleShadowInspection } from './capsule-shadow/inspection';
import { projectCaptureScene } from './capture/scene-projection';
import { createCloudFeatureFrameContext, createCloudFeatureView } from './cloud/frame-context';
import { createClusterBinScratch } from './cluster-binner';
import { ProjectedDecalInvalidError } from './decals/component';
import type { DynamicGeometryRecordStageLane } from './dynamic-geometry';
import { EnvironmentLifecycle } from './environment/lifecycle';
import { releaseAtmosphere } from './environment/storage';
import {
  type ObservationUnavailableError,
  TransmissionCapabilityMissingError,
} from './errors/render';
import { renderMaterialContext } from './extract/material-context';
import { projectDepthOfFieldInspection } from './features/depth-of-field/depth-of-field-inspection';
import type { PendingRenderFeatureErrorReport } from './features/error-reporting';
import { reportPendingRenderFeatureErrors } from './features/error-reporting';
import type { RenderFeaturePreparedGraphicsResolverInput } from './features/host';
import {
  createMotionBlurFeature,
  type MotionBlurFeatureInput,
} from './features/motion-blur/motion-blur-feature';
import { MotionBlurValidationError } from './features/motion-blur/motion-blur-params';
import {
  planMotionBlurFrame,
  projectMotionBlurInspection,
} from './features/motion-blur/motion-blur-runtime';
import { createFeatureNoiseResolver } from './features/noise-texture';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuWorkOwner,
} from './features/prepared-gpu-work';
import { renderFeatureViewIdentity } from './features/view';
import {
  buildFullscreenPostProcessPass,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from './fullscreen-post-process-pass';
import type { GeometryObservation } from './geometry-observation';
import type {
  BarrelDistortionInspection,
  BloomInspection,
  DepthOfFieldInspection,
  DirectionalShadowInspection,
  GpuDrivenProductionInspection,
  LodOcclusionInspection,
  MaterialTextureSourceInspection,
  MotionBlurInspection,
  ReflectionProbeInspection,
  RenderSceneInspection,
  ShadowRasterInspection,
  SsrDependenciesInspection,
  SsrSpatialInspection,
  TemporalTargetInspection,
  TransmissionInspection,
} from './inspection-types';
import { emptyBloomInspection } from './inspection-types';
import { AUTO_EXPOSURE_HISTOGRAM_BYTES } from './pipeline/standard-output/auto-exposure/gpu';
import {
  type AutoExposureInspection,
  createAutoExposureInspection,
} from './pipeline/standard-output/auto-exposure/inspection';
import {
  createStandardLutState,
  inspectStandardLutState,
  type StandardLutState,
} from './pipeline/standard-output/lut-state';
import {
  discardStandardOutputStates,
  disposeStandardOutput,
  prepareStandardOutputResources,
  resetStandardOutputForDeviceLoss,
  stageStandardOutputStates,
} from './pipeline/standard-output/resources';
import type { PointsLinesRetainedSnapshot } from './points-lines/snapshot';
import { StandardPointsLinesOwner } from './points-lines/standard-owner';
import type { RenderPublicationIdentity } from './publication/contract';
import { preparePublicationGeometry } from './publication/prepare-geometry';
import type { PreparedRenderPublication } from './publication/receiver';
import {
  type RenderResourceScope,
  renderTime,
  worldRenderResources,
} from './publication/resource-scope';
import { createDynamicGeometryFrameBindings } from './record/dynamic-geometry-consumption';
import { MaterialBgAssemblyCache } from './record/material-bg-assembly-cache';
import { RecordingSkinTasks } from './record/recording-skin-tasks';
import {
  disposeTargetCaptureLighting,
  disposeTargetCaptures,
} from './record/target-capture-lighting';
import { createRenderSystemRecovery } from './recovery/render-system-candidate';
import type {
  RecoveryGraphCandidate,
  RecoveryGraphCandidatePreparation,
  RecoveryGraphCandidateRuntime,
  RecoveryGraphSetupSubmission,
  RecoveryPostProcessResources,
  RecoveryRootBundle,
  RecoveryRootRuntime,
} from './recovery/types';
import { cameraForView, projectAuxiliaryCamerasForView } from './render-system-extract';
import { type FrameList, FrameProjection } from './scene/frame-list';
import type { RenderSceneBounds } from './scene/render-scene-types';
import { TerrainLayers } from './terrain/layers';
import { captureSubmittedTerrain, type SubmittedTerrainSection } from './terrain/submitted.js';

export type {
  RecoveryGraphCandidate,
  RecoveryGraphCandidatePreparation,
  RecoveryGraphCandidateRuntime,
  RecoveryGraphSetupSubmission,
  RecoveryPointsLinesCandidate,
  RecoveryPostProcessResources,
  RecoveryRootBundle,
  RecoveryRootRuntime,
} from './recovery/types';

import { prepareRenderSystemRecoveryRoots } from './recovery/render-system-roots';
import { ReflectionProbeRecordOwner } from './reflection/record-owner';
import { inspectVolumetricFog } from './volume/inspection';

export type { RenderSceneInspection } from './inspection-types';

import type { BarrelDistortionMapping } from './barrel-distortion';
import type { EnvironmentInspection } from './environment/inspection';
import { selectGpuLodLane } from './gpu-driven/view-gpu';
import { resetHdrpBuffers } from './hdrp-buffers';
import type { SkylightBindGroupResources } from './ibl/skylight-bind-group';
import {
  disposeInstanceBufferChunks,
  disposeInstanceBuffers,
  disposeTransientInstanceBuffers,
} from './instance-buffer-cache';
import type { InstanceCollectionInspection } from './instances';
import { InstanceProjectionStore } from './instances';
import {
  type MeshMaterialBindingObservation,
  projectMeshMaterialBindingObservation,
} from './mesh-material-bindings';
import { deriveCameraStandardConfiguration } from './pipeline/camera-standard-profile';
import type { StandardLightingInspection } from './pipeline/standard-lighting/inspection';
import { validateClusterGrid } from './pipeline/standard-pipeline';
import { DEFAULT_CLUSTER_GRID } from './pipeline/standard-profile';
import type { PointShadowInspection } from './point-shadow-inspection';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolver,
} from './prepare/prepared-graphics-resolver';
import { inspectBarrelDistortionState } from './record/barrel-distortion-frame';
import {
  type CandidatePipelineInput,
  CandidatePipelinePreparationOwner,
  type PreparedCandidatePipelines,
} from './record/candidate-pipeline-preparation';
import { cpuLodLevel, lodLevelHistogram } from './record/cpu-lod';
import { createDrawObservation, unavailableDrawObservation } from './record/draw-observation';
import {
  type CubeCaptureFrameInput,
  type FrameObservation,
  type FrameObservationOptions,
  observeCurrentFrame,
  prepareFrameRecording,
  type RecordProfileRunner,
} from './record/frame';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import type {
  CurrentGraphTarget,
  GraphTargetCaptureRequest,
  RenderFrameState,
} from './record/frame-snapshot';
import {
  emptyFrameRecordingOutputs,
  getTextureIdentity,
  resetFrameRecordingOutputs,
  worldEntityKey,
} from './record/frame-snapshot';
import type { RenderableDrawReceipt } from './record/gpu-draw-receipts';
import type { GpuPassTimingError } from './record/gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './record/gpu-pass-timing/session';
import type { GpuTimingCapture } from './record/gpu-timing';
import { resolveMaterialSkylight } from './record/main-pass-material';
import {
  createPreparedResolverCaches,
  type PreparedMaterialBindingsScope,
  type PreparedResolverCaches,
  preparedMaterialBindings,
} from './record/prepared-material-bindings';
import type { PipelineState, RenderSystemInternals } from './record/render-context';
import { ShadowRasterLedger } from './record/shadow-raster-ledger';
import type { CubeCaptureGraphState } from './record/typed-frame-graph';
import {
  discardCompiledFrameGraphs,
  getRenderFeatureGraphInspection,
  inspectRenderGraphGenerationAllocation,
  type RenderFeatureGraphCandidate,
  recordRenderFeatureCandidate,
  resetRenderFeatureGraphState,
} from './record/typed-frame-graph';
import { emptyVolumetricFogParams } from './record/volume-params';
import {
  type CameraSnapshot,
  type DrawOwnerOptions,
  type FramePresentation,
  type FramePresentationPendingReason,
  RENDER_PHASE_CATALOG,
  type RenderPhase,
  type RenderPhaseSkipReason,
  type RenderRecordPhase,
} from './render-contract';
import type {
  DispatchList,
  ExtractedFrame,
  ExtractedLights,
  RenderableSnapshot,
} from './render-system-extract';
import { extractFrames } from './render-system-extract-tail';
import {
  createPresentationDraws,
  initialFramePresentation,
  markFramePending,
  markPipelinePreparationPending,
  missingDrawEvidence,
  projectDisplayRenderables,
  projectFramePresentation,
  skyCubemapPending,
  verifySubmittedShadows,
} from './render-system-presentation';
import {
  createRendererProducerRootMatrix,
  type RendererProducerRoot,
} from './render-system-producer-roots';
import {
  canonicalizeWorldComposition,
  captureOnlyCameras,
  createLodWorldInspections,
  featureCameraSelection,
  lodWorldAttachments,
} from './render-system-projections';
import {
  acceptSubmittedDepthOfField,
  assertPublishedFeaturesImplemented,
  commitSubmittedBloom,
  directionalShadowCandidateError,
  directionalShadowSubmitted,
  discardUnsubmittedFrame,
  featurePreparationPendingReason,
  fitDirectionalCsm,
  hasCaptureWork,
  hasLiveStandardOutputState,
  isPassProfilePhase,
  type RecordAttempt,
  type RecordDraws,
  type RecordFeatures,
  recordFailureError,
  recordRetirementError,
  releasePreparedResourceBatches,
  resolveFeatureTargets,
} from './render-system-record-attempt';
import { createMaterialResidencyObserver } from './render-system-residency';
import { PersistentRenderScene } from './scene/render-scene';
import { inspectLodOcclusion } from './scene/visibility/inspection';
import { resetSsaoResources } from './ssao-buffers';
import { resolveSsaoParameters } from './ssao-config';
import {
  projectSsrDependencies,
  resolveSsrAdmissionGeneration,
  type SsrSpatialAdmission,
  zeroSsrAdmissionWork,
} from './ssr/admission';
import { projectSsrSpatialInspection } from './ssr/inspection';
import type { SurfaceDynamicInputFrame } from './surface/dynamic-input';
import { SurfaceSubmissionObservationOwner } from './surface/submission-observation';
import { TransparentSortCache } from './systems/transparent-dispatch';
import type { RenderTarget } from './targets/contracts';
import {
  createTemporalFrameTransaction,
  resetTemporalHistory,
  type TemporalFrame,
} from './temporal/frame';
import { releaseTemporalGpuStates } from './temporal/gpu';
import { inspectTemporal, type TemporalInspection } from './temporal/inspection';
import {
  evaluateTransmissionCapability,
  probeTransmissionCapability,
  resolveTransmissionBackdropTopology,
  TransmissionCandidateAdmission,
} from './transmission/backdrop';
import {
  estimateTransmissionBackdropBytes,
  inspectTransmission,
  inspectTransmissionFromAdmission,
} from './transmission/inspection';

type TimingSessionHost = RenderSystemInternals & {
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
};

/** Attach the Render-owned timing session without widening the public renderer surface. */
export function attachGpuPassTimingSession(
  internals: object,
  session: GpuPassTimingSession | undefined,
): void {
  (internals as TimingSessionHost).gpuPassTimingSession = session;
}

export type {
  _InternalRenderPipelineContext,
  _StandardForwardSceneView,
  PerPassResources,
  PipelineState,
  RenderSystemInternals,
  RenderSystemRuntime,
  SurfaceCapabilityFacts,
  SurfaceProfile,
  SwapChainFormatPair,
} from './record/render-context';
export {
  configureSurface,
  MATERIAL_PER_ENTITY_STRIDE,
  resolveSurfaceProfile,
  STANDARD_PBR_UBO_SIZE,
  selectSwapChainFormat,
} from './record/render-context';

export type {
  RendererProducerRoot,
  RendererProducerRootKind,
} from './render-system-producer-roots';
export { createRendererProducerRootMatrix } from './render-system-producer-roots';

/**
 * Production-owned recovery facts. These values are projections of the live
 * RenderSystem owners; they are not a test ledger or a second graph model.
 */
interface RecoveryProductionEvidence {
  readonly producerRoots: readonly RendererProducerRoot[];
  readonly graph: {
    readonly ready: boolean;
    readonly generation: number;
    readonly passCount: number;
    readonly resourceCount: number;
  };
  readonly residency: { readonly meshResidencyEpoch: number };
  readonly submissions: {
    readonly count: number;
    readonly lastGeneration: number | undefined;
  };
}

/**
 * Engine-internal Extract / Prepare / Record driver; constructed by createRenderer.
 *
 * w15 M5 dual-pipeline dispatch: `pipelineDispatchCounts` surfaces per-frame
 * counters of how many entities were routed to each pipeline (plan-strategy
 * D-P4 / requirements AC-07). The counts roll over monotonically — test
 * callers read them after `draw([world], { cameraOwner: 0, resourceOwner: 0 })` to assert each tag saw >= 1 draw.
 * Reset is intentional on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry so per-frame assertions
 * stay local (charter proposition 4 explicit failure: test code sees exact
 * per-draw counts, not stale cross-frame totals).
 *
 * bug-20260519: BUILTIN cube migrated to 12F so the legacy `unlitBuiltin`
 * counter is gone; the surface collapses to `unlit` (every entity whose
 * shader identity is `forgeax::default-unlit`) + `standard` (every entity
 * whose shader identity is `forgeax::default-standard-pbr`).
 */
export interface RenderSystem {
  prepareCandidatePipelines(
    input: CandidatePipelineInput,
    signal?: AbortSignal,
  ): Promise<
    import('@forgeax/engine-types').Result<
      PreparedCandidatePipelines,
      import('./dynamic-geometry').DynamicGeometryError
    >
  >;
  observeGeometry(receipt: {
    frameId: number;
    deviceGeneration: number;
  }): Promise<GeometryObservation>;
  readonly featureGpuWork: RenderFeatureGpuWorkOwner;
  readonly submittedTerrain: readonly SubmittedTerrainSection[];
  bounds(world: World | RenderPublicationIdentity, entity: number): RenderSceneBounds | undefined;
  /** Publish one renderer-owned read-only Surface dynamic page for the next frame. */
  setSurfaceDynamicInput(frame: SurfaceDynamicInputFrame | undefined): void;
  /** Complete explicit SSR capability preparation before drawing a device generation. */
  initializeSsr(device?: RhiDevice): Promise<void>;
  /** Returns true only when this invocation reached queue submission. */
  draw(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    renderReadLeases?: readonly RenderReadLease[],
    timingCapture?: GpuTimingCapture,
    publication?: PreparedRenderPublication,
  ): boolean;
  prepareSubmission(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    renderReadLeases?: readonly RenderReadLease[],
    timingCapture?: GpuTimingCapture,
    publication?: PreparedRenderPublication,
    isCurrent?: () => boolean,
  ): FramePreparation;
  /** Current source needs cold admission after initialization or owner retirement. */
  publicationBaselineRequired(input: PreparedRenderPublication): boolean;
  record(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    renderReadLeases?: readonly RenderReadLease[],
    timingCapture?: GpuTimingCapture,
    publication?: PreparedRenderPublication,
    encoder?: RhiCommandEncoder,
    render?: boolean | 'capture',
  ): FrameRecording;
  copyBuiltinPostProcessesTo(target: RenderSystem): void;
  /** Seed a view RenderSystem from the active Standard and device capability facts. */
  copyConfigurationTo(target: RenderSystem): void;
  /** Internal device-fact transfer used by Renderer-owned camera views. */
  adoptSsrFormatReceipt(
    device: RhiDevice,
    receipt: import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt,
  ): void;
  /**
   * Return the asset binding consumed by the last successful record pass.
   * Dynamic geometry uses this renderer-owned frame fact as its publication
   * barrier; ECS component presence alone is not a draw receipt.
   */
  isDynamicGeometryConsumed(
    world: RenderResourceScope,
    entity: number,
    meshHandle: number | undefined,
  ): boolean;
  dynamicGeometryRecordStageLane(
    world: RenderResourceScope,
    entity: number,
    meshHandle: number | undefined,
  ): DynamicGeometryRecordStageLane | undefined;
  /** Prepare a detached graph candidate without entering the frame record path. */
  prepareRecoveryTextureData(runtime: RecoveryGraphCandidateRuntime): Promise<void>;
  prepareRecoveryGraphCandidate(
    runtime: RecoveryGraphCandidateRuntime,
  ): RecoveryGraphCandidatePreparation;
  /** Finish and submit detached candidate setup, never a frame receipt. */
  submitCandidateSetup(
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError>;
  /** Publish a detached graph candidate at the generation publication boundary. */
  publishRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  /** Discard a detached graph candidate that did not reach publication. */
  discardRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  /** Release renderer-owned persistent state for one detached World. */
  detachScene(world: World): void;
  /** Release the profiler catalog contribution owned by this RenderSystem. */
  releaseProfilerCatalog(): void;
  observeCurrentFrame(
    options: FrameObservationOptions,
  ): Promise<Result<FrameObservation, ObservationUnavailableError>>;
  /** Resolve the renderer-owned GPU LOD counters for the last accepted submit. */
  observeLodOcclusion(receipt?: {
    readonly frameId: number;
    readonly deviceGeneration: number;
  }): Promise<LodOcclusionInspection | undefined>;
  /** Internal same-frame graph target access for backend diagnostics. */
  getCurrentGraphTarget(name: string): CurrentGraphTarget | undefined;
  /** Internal test capture copied into the draw's command submission. */
  requestGraphTargetCapture(request: GraphTargetCaptureRequest): void;
  readonly pipelineDispatchCounts: {
    readonly unlit: number;
  };
  /** Detached residency and upload facts for explicit instance collections. */
  readonly instanceCollectionsInspection: readonly InstanceCollectionInspection[];
  /**
   * feat-20260528-frustum-culling M5 / w14: per-frame frustum-culling counters.
   * Updated by `draw([world], { cameraOwner: 0, resourceOwner: 0 })` on every call from the Extract stage.
   */
  readonly frustumStats: { culled: number; total: number };
  /** Per-frame candidate entities rejected by author visibility. */
  readonly visibilityStats: { explicitlyHidden: number };
  /** Persistent scene maintenance evidence from the ordinary single-World path. */
  readonly renderScene: RenderSceneInspection;
  readonly reflectionProbes: ReflectionProbeInspection;
  /** Live producer/RHI/temporal receipts projected through SSR admission. */
  readonly ssrDependencies: SsrDependenciesInspection;
  /** Live SSR spatial admission and bounded graph/history projection. */
  readonly ssr: SsrSpatialInspection;
  /** Producer completion fence included in the public FrameReceipt. */
  readonly reflectionFallbackCompletion: Promise<void> | undefined;
  /** Presentation readiness derived from the producer facts used by draw(). */
  readonly presentation: FramePresentation;
  readonly presentationPendingReason: FramePresentationPendingReason | undefined;
  /** True while a progressive CubeCamera candidate still owns unfinished faces. */
  isCubeCapturePending(target: RenderTarget): boolean;
  readonly environment: EnvironmentInspection;
  /** Detached auto-exposure state published after a successful frame submit. */
  readonly autoExposure: AutoExposureInspection | undefined;
  /** Detached Standard LUT state published after a successful frame submit. */
  readonly standardLut: StandardLutState;
  readonly temporal: TemporalInspection;
  readonly dynamicResolution:
    | import('./pipeline/dynamic-resolution').DynamicResolutionInspection
    | undefined;
  readonly diffuseGi:
    | import('./raytracing/renderer-diffuse').RayDiffuseInspection
    | import('./raytracing/renderer-irradiance-field').IrradianceFieldInspection
    | import('./raytracing/renderer-screen-probe').ScreenProbeInspection
    | import('./raytracing/renderer-baked-field').BakedFieldInspection
    | undefined;
  readonly probePlacement:
    | import('./raytracing/renderer-probe-placement').ProbePlacementInspection
    | undefined;
  readonly bloom: BloomInspection;
  readonly motionBlurInspection: MotionBlurInspection | undefined;
  /** The last extraction validation failure, preserved for public draw(). */
  readonly motionBlurInvalidParams: MotionBlurValidationError | undefined;
  readonly depthOfFieldInspection: DepthOfFieldInspection | undefined;
  readonly temporalTargetInspection: TemporalTargetInspection | undefined;
  readonly materialDraws: import('./render-contract').DrawObservation;
  readonly lodOcclusionInspection: LodOcclusionInspection | undefined;
  /** Bounded GPU-driven counters without materializing the persistent scene table. */
  readonly gpuDrivenInspection: GpuDrivenProductionInspection;
  /** Last completed transmission candidate facts, detached from GPU handles. */
  readonly transmission: TransmissionInspection | undefined;
  /** Single production projection of Directional author/extract/record facts. */
  readonly directionalShadow: DirectionalShadowInspection;
  /** Per-view shadow cache decisions and raster work of the last submitted frame. */
  readonly shadowRaster: ShadowRasterInspection;
  captureShadowWorkload(
    frameId: number,
  ): readonly import('./inspection-types').ShadowWorkloadPass[] | undefined;
  /** Last prepared Standard transport facts, detached from GPU handles. */
  readonly standardLightingInspection: StandardLightingInspection | undefined;
  /** Last submitted point-shadow atlas budget facts, detached from GPU handles. */
  readonly pointShadowInspection: PointShadowInspection | undefined;
  /** Last submitted capsule-shadow admission facts. */
  readonly capsuleShadowInspection: CapsuleShadowInspection | undefined;
  /** Last submitted display-view transparency resolution and draw eligibility. */
  readonly transparencyInspection: import('./oit/view').TransparencyInspection | undefined;
  /** Retained Points/Lines authoring facts from the single scene projection. */
  readonly pointsLinesSnapshots: readonly PointsLinesRetainedSnapshot[];
  /** Current mesh-slot provenance and active diagnostics from the last frame. */
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  /** Final-submit IBL binding-chain receipt for the last diagnostic frame. */
  readonly iblBinding: import('./mesh-material-bindings').IblBindingInspection | undefined;
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass M4 fix-up w19:
   * per-frame render-graph pass names in declaration order. Empty array
   * before the first `draw([world], { cameraOwner: 0, resourceOwner: 0 })` call; populated after the per-frame
   * graph is built (lazily on first draw). Read-only introspection surface
   * so smoke tests can assert the declarative pass chain is wired without
   * reaching into engine internals.
   */
  readonly perFramePassNames: readonly string[];
  /** Camera antialias mode for the last successfully submitted frame. */
  readonly lastSuccessfulCameraAntialias: CameraSnapshot['antialias'] | undefined;
  /** Effective output mapping for the last successfully submitted camera. */
  readonly lastSuccessfulBarrelDistortion: BarrelDistortionMapping | undefined;
  /** Detached accepted/LKG projection for Renderer.inspect(). */
  readonly barrelDistortionInspection: BarrelDistortionInspection;
  /** Detached compiled-graph facts used by the renderer inspection owner. */
  readonly perFrameGraphInfo: CompiledRenderGraphInfo | undefined;
  /** Internal graph object identity used to fence receipt-bound async observations. */
  readonly perFrameGraphIncarnation: object | undefined;
  /** Detached allocation facts across active, candidate, and retiring graphs. */
  readonly renderGraphGenerationAllocation: import('@forgeax/engine-render-graph').RenderGraphGenerationAllocationInspection;
  /** Detached feature signature/compile/lifetime counters. */
  readonly featureGraphInspection: import('./inspection-types').RenderFeatureGraphInspection;
  /** Detached material texture-source probe counters from the last extract. */
  readonly materialTextureSources: MaterialTextureSourceInspection;
  /** Production-owner recovery facts used by Renderer.inspect(). */
  readonly recoveryEvidence: RecoveryProductionEvidence;
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
   * createBindGroup counter. Reset to 0 on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry,
   * bumped on each cache-miss createBindGroup call in the record stage.
   * Aligns with pipelineDispatchCounts precedent: closure-mutable object
   * + draw-entry reset + readonly getter. Stable-frame AC-03 asserts
   * createBindGroup == 0 when all bind groups are cache-resident.
   *
   * M5 / w19 type-safe finalization: the return type is purposely the
   * narrowest inline object literal `{ readonly createBindGroup: number }`
   * rather than a wider Record/alias — this ensures TS language service
   * hover shows the exact field name + type, and AC-09 consumption sites
   * infer `number` without `as` casts (plan-strategy D-7 + sec.8
   * discoverability).
   */
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
  /** Latest accepted-submit temporal POD; absent until the first accepted frame. */
  readonly temporalFrame: TemporalFrame | undefined;
  /** Current renderer-owned volumetric fog inspection snapshot. */
  readonly volumetricFog: import('./volume/inspection').VolumetricFogInspection;
  /** Configure the sole Standard graph owner before the first frame. */
  configureStandard(config: RenderPipelineAsset['config']): void;
  /** Register one engine-owned post-process shader used by the Standard lane. */
  registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void;
  /** Resolve one active built-in post-process declaration for a detached candidate. */
  readonly lookupPostProcess: (id: string) => PostProcessShaderEntry | undefined;
  /**
   * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21:
   * release the per-RenderSystem frame-state GPU bookkeeping during
   * `Renderer.dispose()`. Retires the compiled graph and clears the instance-buffer cache.
   *
   * Idempotent (architecture-principles §6): a second call after both
   * structures are cleared is a no-op. Per-step failures inside drain /
   * disposeInstanceBuffers fall through silently -- the Renderer.dispose
   * cascade owns the try/catch + errorRegistry.fire fan-out (D-3).
   */
  disposeFrameState(): void;

  /**
   * feat-20260622-s5 M3 / B-2 / w18: drop the device-bound state the recover()
   * rebuild must shed before re-running the pipeline build against a fresh
   * device. Two effects, both keyed to the lost device:
   *   1. the per-frame render-graph's pendingDestroy queue (PooledTextures
   *      minted by the lost device — clearPendingDestroy skips destroyTexture);
   *   2. post-process declarations + their eager param UBOs. Declarations are
   *      CPU-owned author intent and survive; UBOs are stale lost-device
   *      handles and are rebuilt after the replacement device is live.
   * Idempotent and graph-optional (no-op when nothing has compiled yet).
   */
  resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void;
  /** Build post-process parameter buffers without mutating the active bundle. */
  prepareRecoveryPostProcessResources(
    device: RhiDevice,
  ): Result<RecoveryPostProcessResources, RhiError>;
  /** Publish a previously prepared post-process bundle at the recovery boundary. */
  publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Release a candidate bundle that was never published. */
  discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Recreate post-process GPU parameter resources after a device rebuild. */
  restorePostProcessResources(): void;
  /** Build candidate roots from explicit candidate-owned device state. */
  prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle;
}

function makePreparedPipelinePendingError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'prepared pipeline shader module warm-up to finish asynchronously',
    hint: 'retry the prepared graphics pass on the next frame',
  });
}

export function createRenderSystem(internals: RenderSystemInternals): RenderSystem {
  const phaseCatalogRegistration = internals.profiler?.registerPhaseCatalog(
    'render',
    RENDER_PHASE_CATALOG,
  );
  let releaseProfilerCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  let preparedWorlds: readonly RenderResourceScope[] = [];
  let submittedTerrain: readonly SubmittedTerrainSection[] = [];
  const resolveFeatureNoise = createFeatureNoiseResolver({
    scope: internals.deviceScope,
    getDevice: () => internals.device,
    onError: (error) => internals.errorRegistry.fire(error),
  });
  const ownsSceneInputs = internals.featureSceneInputs === undefined;
  internals.featureSceneInputs ??= createFeatureSceneInputs(internals, resolveFeatureNoise);
  let preparedFeatureSkylightResources: SkylightBindGroupResources | undefined;
  const dynamicGeometryFrames = createDynamicGeometryFrameBindings();
  let surfaceDynamicInputFrame: SurfaceDynamicInputFrame | undefined;
  let latestCamera: CameraSnapshot | undefined;
  // Keep install-time configuration separate from the private selected-view override.
  let configuredPipelineConfig: RenderPipelineAsset['config'];
  let cameraStandardSignature = '';
  let lastCameraAoFailure = '';
  // Last public parameter failure; cleared only after a valid extraction.
  let lastMotionBlurInvalidParams: MotionBlurValidationError | undefined;
  // Lazily install the compute lane when a capable frame demands it.
  let motionBlurFeatureInput: MotionBlurFeatureInput | undefined;
  const motionBlurFeature = createMotionBlurFeature();
  const ensureMotionBlurFeature = (): void => {
    const host = internals.featureHost;
    if (
      host === undefined ||
      host.features.some((feature) => feature.identity === 'forgeax.motion-blur')
    ) {
      return;
    }
    const installed = host.install(
      motionBlurFeature as import('./features/types').RenderFeature<unknown>,
    );
    if (!installed.ok) internals.errorRegistry.fire(installed.error);
  };
  const pointsLinesOwner = new StandardPointsLinesOwner(internals);
  const instanceCollections = new InstanceProjectionStore();
  const reflectionProbeOwner = new ReflectionProbeRecordOwner(internals);
  const ssrFormatReceipts = new WeakMap<
    RhiDevice,
    import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt
  >();
  let ssrFallbackGeneration: number | undefined;
  const ensureSsrFormatProbe = async (device = internals.device): Promise<void> => {
    if (
      internals.ssrIdentity === undefined ||
      typeof device.probeTextureFormatCapability !== 'function'
    )
      return;
    // RHI memoizes the probe per physical device. Retain the detached candidate
    // receipt without publishing it: inspection selects only the active device.
    // A failed/late recovery therefore cannot overwrite the active generation.
    try {
      const result = await device.probeTextureFormatCapability();
      if (result.ok) ssrFormatReceipts.set(device, result.value);
    } catch {
      // Missing capability remains an explicit fallback-only admission.
    }
  };
  // GPU-driven production uses the validated adapter for normal frames. The
  // assembly-supplied closure resolves its device-bound adapter at call time,
  // so recovery candidate preparation still follows candidateShaderState
  // rather than retaining a lost-generation module.
  const gpuDrivenShaderFactory =
    internals.shaderModuleFactory ??
    internals.immediateShaderModuleFactory ??
    ({
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'the renderer backend exposes shader module creation',
            hint: 'construct the renderer through the backend pack before activating GPU-driven rendering',
          }),
        ),
    } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory);
  const cubeCaptureState: CubeCaptureGraphState = { work: [] };
  const terrainLayers = new TerrainLayers(
    () => internals.gpuStore,
    () => internals.device,
    internals.immediateShaderModuleFactory ?? gpuDrivenShaderFactory,
  );
  Object.assign(internals, { preparedMaterialTexture: terrainLayers.texture.bind(terrainLayers) });
  const persistentRenderScene = new PersistentRenderScene({
    terrainLayers,
    assets: internals.assets,
    shaderRegistry: internals.assets.shaderRegistry,
    getTemporalConsumerDemand: () => internals.standardProfile?.visibleSurface === true,
    getDevice: () => internals.device,
    onGpuError: (error) => internals.errorRegistry.fire(error),
    onAssetChange: (scope, change) => {
      frameState.irradianceField?.adoptAsset(scope, change);
      frameState.firedEquirectProjectionFailedHandles.delete(change.handle);
      // Published GPU residency is adopted once by the outer view assembly.
      // Each retained view still adopts its own GI dependencies, even when held.
      if (scope.world === undefined) return;
      const content = change.removed
        ? undefined
        : scope.resolveAsset<import('@forgeax/engine-types').Asset>(change.handle);
      const mesh = content?.ok && content.value.kind === 'mesh' ? content.value : undefined;
      const adopted = internals.gpuStore.adoptMeshChange(change, mesh, scope);
      if (!adopted.ok) internals.errorRegistry.fire(adopted.error);
      const texture = content?.ok && content.value.kind === 'texture' ? content.value : undefined;
      const adoptedTexture = internals.gpuStore.adoptTextureChange(change, texture, scope);
      if (!adoptedTexture.ok) internals.errorRegistry.fire(adoptedTexture.error);
      internals.gpuStore.invalidateSampler(change.handle, scope);
      internals.gpuStore.adoptCubemapChange(change, scope);
    },
    instanceCollections,
  });
  const skinTasks = new RecordingSkinTasks({
    device: () => internals.device,
    roots: persistentRenderScene,
    reportError: (error) => internals.errorRegistry.fire(error),
  });
  Object.assign(internals, {
    demandSkinTask: (source: Parameters<RecordingSkinTasks['demand']>[0]) =>
      skinTasks.demand(source),
    demandCapsuleShadow: (source: Parameters<RecordingSkinTasks['capsules']>[0]) =>
      skinTasks.capsules(source),
  });
  let environmentLifecycle = new EnvironmentLifecycle(internals.deviceScope);
  const transmissionAdmission = new TransmissionCandidateAdmission();
  let lastTransmissionInspection: TransmissionInspection | undefined;
  let lastTransmissionKey = '';
  let lastTransmissionAntialias: CameraSnapshot['antialias'] = 'none';
  const transmissionCapabilities = new WeakMap<
    RhiDevice,
    Map<TextureFormat, import('./transmission/backdrop').TransmissionCapabilityFacts>
  >();
  const transmissionCapability = (format: TextureFormat = 'rgba16float') => {
    const device = internals.device;
    let formats = transmissionCapabilities.get(device);
    if (formats === undefined) {
      formats = new Map();
      transmissionCapabilities.set(device, formats);
    }
    let facts = formats.get(format);
    if (facts === undefined) {
      facts = probeTransmissionCapability(device, format);
      formats.set(format, facts);
    }
    return facts;
  };
  const prepareTransmissionCandidate = (antialias: CameraSnapshot['antialias']): boolean => {
    const demand = persistentRenderScene.transmissionTopologyDemand();
    if (demand.activeCount === 0) return true;
    const topology = resolveTransmissionBackdropTopology({
      demand,
      sourceSampleCount: antialias === 'msaa' ? 4 : 1,
    });
    const capability = {
      ...transmissionCapability(),
      msaaResolve: antialias === 'msaa' || topology.sourceSampleCount === 1,
    } as const;
    const verdict = evaluateTransmissionCapability(capability);
    if (verdict.ok) return true;

    const extent = {
      width: Math.max(1, internals.canvas.width),
      height: Math.max(1, internals.canvas.height),
    };
    const resource = {
      extent,
      format: capability.format,
      mipCount: topology.mipCount === 0 ? 1 : numMipLevels(extent),
      bytes: estimateTransmissionBackdropBytes(
        extent,
        topology.mipCount === 0 ? 1 : numMipLevels(extent),
        capability.format,
      ),
      deviceGeneration: internals.deviceScope.generation,
    } as const;
    transmissionAdmission.admit(demand, capability, resource);
    internals.errorRegistry.fire(
      new TransmissionCapabilityMissingError('standard transmission', 'prepare', {
        lane: 'standard-forward',
        format: capability.format,
        missing: verdict.missing,
      }),
    );
    return false;
  };
  const updateTransmissionInspection = (
    antialias: CameraSnapshot['antialias'],
    submitted: boolean,
  ): void => {
    lastTransmissionAntialias = antialias;
    const demand = persistentRenderScene.transmissionTopologyDemand();
    if (demand.activeCount === 0) {
      lastTransmissionInspection = undefined;
      lastTransmissionKey = '';
      return;
    }
    const physical = submitted
      ? frameState.compiledFrameGraph?.graph
          .inspect()
          .resources.find(
            (resource) => resource.kind === 'texture' && resource.label === 'transmission-backdrop',
          )
      : undefined;
    const descriptor = physical?.descriptor.kind === 'texture' ? physical.descriptor : undefined;
    const extent = {
      width: descriptor?.width ?? Math.max(1, internals.canvas.width),
      height: descriptor?.height ?? Math.max(1, internals.canvas.height),
    };
    const topology = resolveTransmissionBackdropTopology({
      demand,
      sourceSampleCount: antialias === 'msaa' ? 4 : 1,
    });
    const format = descriptor?.format ?? 'rgba16float';
    const mipCount =
      descriptor?.mipLevelCount ?? (topology.mipCount === 0 ? 1 : numMipLevels(extent));
    const resource =
      descriptor === undefined
        ? undefined
        : ({
            extent,
            format,
            mipCount,
            bytes:
              physical?.byteSize ?? estimateTransmissionBackdropBytes(extent, mipCount, format),
            deviceGeneration: internals.deviceScope.generation,
          } as const);
    const key = `${demand.activeCount}:${demand.needsRoughMips}:${extent.width}:${extent.height}:${internals.deviceScope.generation}:${format}:${mipCount}:${resource?.bytes ?? 0}:${antialias}:${submitted}`;
    if (key === lastTransmissionKey && lastTransmissionInspection !== undefined) return;
    if (submitted) {
      transmissionAdmission.admit(
        demand,
        {
          ...transmissionCapability(format),
          msaaResolve: antialias === 'msaa' || topology.sourceSampleCount === 1,
        },
        resource,
      );
    }
    const admission = transmissionAdmission.inspectLifecycle();
    lastTransmissionInspection = submitted
      ? inspectTransmissionFromAdmission({
          admission,
          topology,
          extent,
          transmissionDrawCount: resource === undefined ? 0 : demand.activeCount,
        })
      : inspectTransmission({
          demand,
          topology,
          extent,
          generation: admission.generation,
          lastKnownGood: admission.lastKnownGood,
          lifecycle: admission.lifecycle,
          recovery: admission.recovery,
          capability: admission.capability,
          resourcePresent: admission.resource !== undefined,
          ...(admission.resource === undefined
            ? {}
            : {
                extent: admission.resource.extent,
                format: admission.resource.format,
                mipCount: admission.resource.mipCount,
                bytes: admission.resource.bytes,
              }),
          transmissionDrawCount: demand.activeCount,
        });
    lastTransmissionKey = key;
  };
  let gpuDrivenRecoveryCount = 0;
  const surfaceSubmissionObservation = new SurfaceSubmissionObservationOwner(
    () => internals.deviceScope.generation,
  );
  let gpuDrivenProduction = createGpuDrivenOwner(
    internals.device,
    gpuDrivenShaderFactory,
    gpuDrivenRecoveryCount,
  );
  const createFeatureGpuWorkOwner = (runtime: RenderSystemInternals): RenderFeatureGpuWorkOwner =>
    createRenderFeatureGpuWorkOwner({
      getDevice: () => runtime.device,
      getShaderModuleFactory: () =>
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
      getImmediateShaderModuleFactory: () =>
        runtime.immediateShaderModuleFactory ??
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
    });
  let featureGpuWork = internals.sharedFeatureGpuWork ?? createFeatureGpuWorkOwner(internals);
  const disposeFeatureGpuWork = (): void => {
    if (internals.sharedFeatureGpuWork !== undefined) return;
    const disposed = featureGpuWork.dispose();
    if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
  };
  // Per-RenderSystem frame state: closure-internal frameNumber + the
  // per-entity instance GPU buffer cache (feat-20260514 M3 / w15: the
  // record stage owns GPU storage buffer allocation for Instances entities;
  // the `instanceBuffers` map is keyed by the packed Entity u32 surfaced
  // through `InstancesSnapshot.cacheKey` and rebuilds buffers on archetype
  // version bump or byte-length change). The legacy
  // `lastFiredLimitExceededFrame` engine-side dedup field was removed in
  // feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3); the active
  // `'limit-exceeded'` emit point is now the record stage upload path.
  //
  // feat-20260708 M1 / D-1a #1: positive-half keys are worldEntityKey(worldId,
  // cacheKey) composites. Negative-half fold-bucket keys (sprite fold) stay
  // raw (material-handle-based, cross-world collision semantically correct).
  const frameState: RenderFrameState = {
    frameNumber: 0,
    renderBundleCounters: { hits: 0, misses: 0 },
    surfaceSubmissionObservation: undefined,
    reflectionFallbackDemand: false,
    ssrRequested: false,
    ssrSpatialAdmission: undefined,
    ssrHistoryOwner: undefined,
    ssrTemporalParamsPayload: new Uint8Array(32),
    ssrLastCameraEntity: undefined,
    ssrLastHistoryVersion: undefined,
    graphGeneration: 0,
    successfulTemporalFrameIndex: 0,
    lastSuccessfulBloom: 'off',
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    reflectionFallbackReadback: undefined,
    directionalShadowCache: null,
    directionalShadowCacheRecorded: false,
    shadowRaster: new ShadowRasterLedger(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    depthOfFieldAccepted: undefined,
    depthOfFieldLastSubmitFailed: false,
    volumetricFogParams: emptyVolumetricFogParams(),
    volumetricFogInspection: inspectVolumetricFog({ authored: false, capability: 'available' }),
    volumetricFogAccepted: undefined,
    volumetricFogAcceptedContext: undefined,
    volumetricFogHistoryGraph: null,
    volumetricFogHistorySlot: null,
    volumetricFogHistorySignature: null,
    retiredCompiledFrameGraphs: new Set(),
    frameOutputs: emptyFrameRecordingOutputs(),
    reflectionFallbackObservationSource: undefined,
    lastSuccessfulCameraAntialias: undefined,
    lastSuccessfulBarrelDistortion: undefined,
    barrelDistortionGraphResolution: 'accepted',
    temporalGpuState: undefined,
    autoExposureGpuResources: undefined,
    pendingAutoExposureGpuResources: undefined,
    autoExposureState: undefined,
    pendingAutoExposureState: undefined,
    standardLutGpuResources: undefined,
    pendingStandardLutGpuResources: undefined,
    standardLutState: createStandardLutState({ deviceEpoch: internals.deviceScope.generation }),
    pendingStandardLutState: undefined,
    activeTemporalGpuState: undefined,
    retiringTemporalGpuStates: new Set(),
    lastSuccessfulTemporalView: undefined,
    pendingTemporalCommit: { kind: 'none' },
    environmentGeneration: undefined,
    environmentLifecycle,
    instanceBuffers: new Map(),
    instanceCollections,
    instanceBufferChunks: new Map(),
    probeBlendBuffers: new Map(),
    probeBlendRecordBufferCapacity: 0,
    morphBuffers: new Map(),
    hdrpClusterBinScratch: createClusterBinScratch(),
    hdrpClusterGridScratch: null,
    hdrpLightIndexListScratch: null,
    hdrpClusterMembership: null,
    standardLightingGraphSignature: '',
    submittedInspection: undefined,
    transientInstanceBuffers: [],
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
    // once-warn latches for >1 Skylight / >1 SkyboxBackground (names winner).
    warnedMultiSkylight: false,
    warnedMultiSkybox: false,
    warnedSkyboxTonemapNone: false,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (AC-18 path 4): per-
    // handle warn-once anchor for the sprite-bucket missing-texture
    // fallback. Set<number> keyed by raw Handle<TextureAsset>; never
    // cleared (charter F1 minimal surface — the per-RenderSystem lifetime
    // is the natural upper bound).
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    // feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
    // renderable guard for the runtime `nineslice.scale-too-small` metric
    // counter (`runtime.metrics.increment(...)` in render-system-record.ts).
    warnedNineSliceScaleEntities: new Set<number>(),
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
    // per-handle fire-once anchor for the lazy equirect projection failure
    // (EquirectProjectionFailedError). Set<number> keyed by raw
    // Handle<EquirectAsset>; never cleared (per-RenderSystem lifetime upper bound).
    firedEquirectProjectionFailedHandles: new Set<number>(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
    // bind group caches as nested WeakMap chain roots. viewBindGroupCache
    // covers main and shadow variants; meshBindGroupCache keys on inner
    // buffer handles (D-3). Roots are stable between device recoveries.
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
    // material and instances caches (outer Map<entityKey, WeakMap>).
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    instancesBgShared: new WeakMap(),
    // cross-entity shared material cache (outer Map<shaderId, WeakMap>).
    materialBgShared: new Map(),
    // cross-frame material assembly cache; entries are only retained when all
    // explicit texture/sampler handles resolved to resident GPU resources.
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    // singleton material cache (flat Map<variant, BindGroup>; D-6).
    shadowMaterialBindGroups: new WeakMap(),
    // post-process bind group cache (bloom / fxaa / ssao): identity-keyed
    // WeakMap chain so resize-retired transient targets rebuild automatically.
    postProcessBgCache: new WeakMap(),
    // feat-20260601-customizable-render-pipeline-seam M1 / w7: installed-pipeline state.
    // 0 = nothing installed yet (createRenderer dogfood installs the default before a
    // draw). activePipeline defaults to the built-in forward pipeline.
    installedPipelineHandle: 0,
    activePipeline: internals.standardPipeline,
    // feat-20260601 verify round 2: the standard forward pipeline installs with no config
    // (its topology is frame-invariant). Standard configuration overwrites this with the
    // resolved asset config on every swap so the active graph reads its current config.
    installedPipelineConfig: undefined,
    standardOncePerFrameFired: new Set(),
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // cube_array shadow atlas + per-frame snapshot list. Atlas is null until the
    // first frame whose extracted lights.pointShadow is non-empty (zero-shadow
    // scenes never allocate; AC-09); the snapshot list defaults to an empty
    // tuple so the typed point-shadow graph sees zero shadow lights as the
    // initial steady state.
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
    // initial fold-bucket count is 0; recordFrame writes the per-frame
    // value from foldDispatchBuckets(...) before dispatch.
    lastFoldBucketCount: 0,
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): empty initial spot
    // shadow snapshot list so the spotShadowDepth caster pass renders zero
    // tiles until the first frame with a castShadow spot (AC-03).
    spotShadowSnapshots: [],
  };
  // A feature that is explicitly recoverable on the next frame must not
  // publish the same transient failure on every render tick. Keep one
  // renderer-owned cooldown per structured feature failure while retaining
  // the original error for the first and periodic reports.
  const pendingFeatureErrorLastReportedFrame = new Map<string, PendingRenderFeatureErrorReport>();
  const resolveSsrDependencies = (requested: boolean): SsrDependenciesInspection => {
    // Explicit SSR capability preparation belongs to initialization. Inspection
    // only projects receipts and never starts work or creates image history.
    const owner = reflectionProbeOwner.inspect();
    const temporal =
      frameState.lastSuccessfulTemporalView === undefined
        ? undefined
        : ({
            successfulSubmit: true,
            generation: frameState.lastSuccessfulTemporalView.input.deviceGeneration,
          } as const);
    return projectSsrDependencies({
      requested,
      identity: internals.ssrIdentity,
      reflectionFallback: owner.reflectionFallback,
      format: ssrFormatReceipts.get(internals.device),
      temporal,
    });
  };
  let directFrameId = 0;
  let submittedFrameCount = 0;
  let lastSubmittedGeneration: number | undefined;
  let lastDirectionalShadowLights: ExtractedLights | undefined;
  let lastDirectionalShadowCandidate: 'accepted' | 'failed' = 'failed';
  let lastDirectionalShadowError: DirectionalShadowInspectionSource['error'];

  function beginProfilePhase(session: RecorderSession | undefined, phase: RenderPhase): boolean {
    if (session === undefined) return false;
    try {
      return session.beginPhase('render', phase).ok;
    } catch {
      return false;
    }
  }

  function endProfilePhase(session: RecorderSession | undefined): void {
    if (session === undefined) return;
    try {
      session.endPhase();
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function recordProfileSkip(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    reason: RenderPhaseSkipReason,
  ): void {
    if (session === undefined) return;
    try {
      session.recordSkip({ source: 'render', phase, reason });
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function runProfiledRenderPhase<T>(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    action: () => T,
  ): T {
    const opened = beginProfilePhase(session, phase);
    try {
      return action();
    } finally {
      if (opened) endProfilePhase(session);
    }
  }
  let lastBuiltPipelineHandle = 0;
  // Monotonic configuration epoch: bumped on every Standard configuration change to brand the
  // installed pipeline so `draw` can detect a swap and rebuild the per-frame
  // graph. Replaces the prior raw-handle brand (D-19: the pipeline configuration takes a
  // POD, no handle).
  let installEpoch = 0;
  const postProcessOwner = createPostProcessParamsOwner(internals, (id, moduleLabel) => {
    clearPostProcessPipelineCache(id);
    internals.invalidateShaderModule?.(moduleLabel);
  });
  const lookupPostProcess = postProcessOwner.lookup;
  const invalidatePostProcessModule = (id: string): void => {
    const entry = lookupPostProcess(id);
    if (entry !== undefined) {
      internals.invalidateShaderModule?.(postProcessShaderModuleLabel(entry.source));
    }
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline cache (declaration|colorFormat -> RhiRenderPipeline).
  // Solves CONCERN-1: dispatcher previously passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await async
  // shader compile. The cache here delegates the actual build to
  // `internals.buildPostProcessPipeline` (sync wrapper over the shared shader
  // adapter; 1-frame warmup), then memoizes by declaration identity + format.
  const postProcessPipelineCache = new Map<string, RenderPipeline>();
  const getPostProcessPipeline = (
    id: string,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    entryOverride?: PostProcessShaderEntry,
  ): RenderPipeline | null => {
    const entry = entryOverride ?? lookupPostProcess(id);
    if (entry === undefined) return null;
    const signature = postProcessShaderEntrySignature(entry);
    const key = `${id}|${colorFormats.join(',')}|${signature}`;
    const cached = postProcessPipelineCache.get(key);
    if (cached !== undefined) return cached;
    const factory = internals.buildPostProcessPipeline;
    if (factory === undefined) return null;
    const built = factory(
      entry,
      bgl,
      colorFormats,
      postProcessShaderPipelineLabel(id, entry.source),
    );
    if (built === null) return null;
    postProcessPipelineCache.set(key, built);
    return built;
  };
  const clearPostProcessPipelineCache = (id: string): void => {
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`)) postProcessPipelineCache.delete(key);
    }
  };
  const clearPostProcessPipelineEntry = (id: string, entry: PostProcessShaderEntry): void => {
    const suffix = `|${postProcessShaderEntrySignature(entry)}`;
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`) && key.endsWith(suffix)) {
        postProcessPipelineCache.delete(key);
      }
    }
  };
  Object.assign(internals, {
    lookupPostProcess,
    getPostProcessParamsBuffer: postProcessOwner.getBuffer,
    getPostProcessPipeline,
    clearPostProcessPipelineCache,
  });
  // w15 M5 (plan-strategy D-P4 / AC-07): per-frame dispatch counters. Reset
  // on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry; bumped once per actual `pass.setPipeline`
  // dispatch in render-system-record.ts. Two-way split mirrors the two
  // render pipelines on PipelineState (bug-20260519: BUILTIN cube migrated
  // to 12F so `unlitBuiltin` retired): `unlit` covers every
  // unlit material, `standard` covers every PBR material.
  const dispatchCounts: { unlit: number } = {
    unlit: 0,
  };
  let lastLodOcclusionInspection: LodOcclusionInspection | undefined;
  // The GPU selector returns stable numeric World keys with its same-submit
  // counters. Keep the attachment join from that submit, rather than using
  // the current worlds[] position when the asynchronous readback completes.
  let lastLodWorldAttachments: ReadonlyMap<number, string> = new Map();
  let lodCandidateCountCache:
    | { readonly renderables: FrameList<RenderableSnapshot>; readonly count: number }
    | undefined;
  let lodInspectionRenderablesCache:
    | {
        readonly submissionRenderables: FrameList<RenderableSnapshot>;
        readonly lodCandidateCount: number;
        readonly values: FrameList<RenderableSnapshot>;
      }
    | undefined;
  const transparentSort = new TransparentSortCache();
  const applyLodSelectionTelemetry = (
    selection:
      | {
          readonly candidateCount: number;
          readonly visible: number;
          readonly occluded: number;
          readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
          readonly submit?: { readonly frameId: number; readonly deviceGeneration: number };
          readonly worldSelections?: readonly {
            readonly worldKey: number;
            readonly primitiveSlot: number;
            readonly slotGeneration: number;
            readonly candidateCount: number;
            readonly visible: number;
            readonly occluded: number;
            readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
          }[];
        }
      | undefined,
    targetInspection: LodOcclusionInspection | undefined = lastLodOcclusionInspection,
    targetWorldAttachments: ReadonlyMap<number, string> = lastLodWorldAttachments,
  ): LodOcclusionInspection | undefined => {
    if (selection === undefined || targetInspection === undefined) return undefined;
    const inspection = targetInspection;
    // The GPU readback histogram is the selector fact, while final submitted
    // counts are owned by the persistent visibility projection. Keeping the
    // projection count here excludes ordinary non-LOD geometry (for example a
    // benchmark occluder) from the LOD workload without inventing a second
    // visibility owner or mixing CPU/GPU admission decisions.
    let worlds = inspection.worlds;
    const worldSelections = selection.worldSelections;
    if (worldSelections !== undefined && worldSelections.length > 0) {
      if (worldSelections.some((selected) => !targetWorldAttachments.has(selected.worldKey)))
        return undefined;
      const selectionsByAttachment = new Map<string, (typeof worldSelections)[number][]>();
      for (const selected of worldSelections) {
        const attachmentId = targetWorldAttachments.get(selected.worldKey);
        if (attachmentId === undefined) return undefined;
        const rows = selectionsByAttachment.get(attachmentId);
        if (rows === undefined) selectionsByAttachment.set(attachmentId, [selected]);
        else rows.push(selected);
      }
      const nextWorlds = worlds.map((world) => {
        const selected = selectionsByAttachment.get(world.attachmentId);
        const baseRow = world.rows[0];
        // A World with only plain meshes has no LOD selection row. Keep its
        // projection-only receipt and allow Worlds with valid LOD rows to
        // retain same-submit attribution. Unknown selected world keys still
        // fail closed above.
        if (selected === undefined || baseRow === undefined) return world;
        // The projection row is intentionally CPU-scoped and may omit
        // selector-only candidates that remain in the full GPU plan. The
        // same-submit GPU row owns the denominator; comparing it to the
        // projection count would reject a valid receipt (for example 11 GPU
        // candidates versus 10 CPU-admitted renderables).
        return Object.freeze({
          ...world,
          attribution: Object.freeze({
            status: 'same-submit' as const,
            submit: inspection.submit,
          }),
          rows: Object.freeze(
            selected.map((row) => ({
              ...baseRow,
              slot: {
                primitiveSlot: row.primitiveSlot,
                slotGeneration: row.slotGeneration,
              },
              count: {
                candidates: row.candidateCount,
                visible: row.visible,
                occluded: row.occluded,
              },
              lodHistogram: row.lodHistogram,
            })),
          ),
        });
      });
      worlds = Object.freeze(nextWorlds);
    }
    lastLodOcclusionInspection = inspectLodOcclusion({
      ...inspection,
      count: {
        ...inspection.count,
        candidates: selection.candidateCount,
        visible: selection.visible,
        occluded: selection.occluded,
      },
      lodHistogram: selection.lodHistogram,
      // Per-primitive samples are intentionally omitted until the GPU readback
      // carries stable primitive identities; the histogram is the authoritative
      // producer fact and is copied from the same GPU cull counters.
      samples: [],
      worlds,
    });
    return lastLodOcclusionInspection;
  };
  // feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
  // createBindGroup counter scaffolding. Reset on every draw([world], { cameraOwner: 0, resourceOwner: 0 }) entry,
  // bumped on cache-miss in render-system-record.ts (M2-M4 bump points).
  // Aligns with dispatchCounts precedent: closure-mutable object.
  const bindGroupCounts: { createBindGroup: number; keys: string[] } = {
    createBindGroup: 0,
    keys: [],
  };
  const activePreparedResolverCaches = createPreparedResolverCaches();
  // Frustum statistics are lazy inspection facts of the last accepted frame.
  let lastFrustumSource: { readonly culled: number; readonly total: number } = {
    culled: 0,
    total: 0,
  };
  const lastFrustumStats = {
    get culled() {
      return lastFrustumSource.culled;
    },
    get total() {
      return lastFrustumSource.total;
    },
  };
  const lastVisibilityStats: { explicitlyHidden: number } = { explicitlyHidden: 0 };
  let lastMaterialTextureSources: MaterialTextureSourceInspection = {
    sourceFieldsVisited: 0,
    producerRoutes: Object.freeze({}),
  };
  let lastMeshMaterialBindingRenderables: FrameList<RenderableSnapshot> | undefined;
  let lastMeshMaterialBindingWorlds: readonly RenderResourceScope[] = [];
  let lastMeshMaterialBindingMaterials:
    | import('./scene/material-dispatch').MaterialFrame
    | undefined;
  let lastPresentation: FramePresentation = 'pending';
  let lastPresentationPendingReason: FramePresentationPendingReason | undefined;
  let materialDraws: import('./render-contract').DrawObservation =
    unavailableDrawObservation('not-captured');
  const createPreparedResolverFactory =
    (
      runtime: RenderSystemInternals,
      gpuWork: RenderFeatureGpuWorkOwner,
      worlds: readonly RenderResourceScope[],
      caches: PreparedResolverCaches,
    ) =>
    (input: RenderFeaturePreparedGraphicsResolverInput): PreparedGraphicsResolver => {
      const materialBindings: PreparedMaterialBindingsScope = [];
      const {
        preparedPipelineIds,
        preparedMaterialPipelineShaders,
        preparedGroup0Pipelines,
        preparedViewOnlyPipelines,
        preparedRenderMaterialPipelines,
      } = caches;
      return createPreparedGraphicsResolver({
        device: runtime.device,
        featureIdentity: input.featureIdentity,
        generation: input.generation,
        capabilityAvailable: true,
        featureOrder: input.order,
        lookup: input.lookup,
        resolveGpuBuffer: (reference) => gpuWork.resolveBuffer(input.featureIdentity, reference),
        resolvePipeline: (descriptor) => {
          const postProcessEntry =
            input.fullscreenEffects.get(descriptor.shader) ??
            postProcessOwner.builtinEntries.get(descriptor.shader);
          if (postProcessEntry !== undefined) {
            const fullscreen = buildFullscreenPostProcessPass(
              { device: runtime.device, errorRegistry: runtime.errorRegistry },
              postProcessEntry,
            );
            if (fullscreen === null) return err(new Error('prepared post-process layout failed'));
            const pipeline = runtime.getPostProcessPipeline?.(
              descriptor.shader,
              fullscreen.bindGroupLayout,
              descriptor.colorFormats as readonly GPUTextureFormat[],
              postProcessEntry,
            );
            if (pipeline !== null && pipeline !== undefined) {
              preparedPipelineIds.set(pipeline as object, descriptor.shader);
              if (
                runtime.getMaterialShaderBindingContract?.(descriptor.shader).bindings === 'group-0'
              ) {
                preparedGroup0Pipelines.add(pipeline as object);
              }
            }
            return pipeline === null || pipeline === undefined
              ? err(makePreparedPipelinePendingError())
              : ok(pipeline);
          }
          const clusteredParticleMesh =
            runtime.device.caps.storageBuffer &&
            (descriptor.shader === 'forgeax::vfx-render.particles.mesh' ||
              descriptor.shader === 'forgeax::vfx-render.particles.mesh-inputs');
          const requestedVariantSet = clusteredParticleMesh
            ? 'CLUSTER_FORWARD_AVAILABLE=true'
            : undefined;
          // A colorless prepared program is a depth-only pass. Vertex-only
          // shadow programs must use the depth policy; resolving them as
          // forward asks Dawn for a non-existent `fs_main` entry point.
          const preparedPassKind =
            descriptor.colorFormats.length === 0 ? 'shadow-caster' : 'forward';
          const preparedPipelineEntry = (
            descriptor.preparePipelines
              ? (runtime.prepareMaterialShaderPipelineEntry ??
                  runtime.getMaterialShaderPipelineEntry)
              : runtime.getMaterialShaderPipelineEntry
          )?.(
            descriptor.shader,
            descriptor.colorFormats[0] === 'rgba16float',
            descriptor.renderState,
            descriptor.topology,
            descriptor.indexFormat,
            requestedVariantSet,
            preparedPassKind,
            undefined,
            descriptor.sampleCount ?? 1,
            // Prepared graphics own their declared attachment format. Passing
            // it through keeps the PSO compatible with feature-target views
            // (the ordinary material path intentionally defaults to the
            // swap-chain view format).
            descriptor.colorFormats[0] as GPUTextureFormat,
            undefined,
            descriptor.depthFormat === undefined
              ? null
              : (descriptor.depthFormat as GPUTextureFormat),
            descriptor.vertexLayout,
            undefined,
            input.shaderModuleMode,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            descriptor.particleInputLanes,
          );
          const preparedPipeline =
            preparedPipelineEntry === undefined
              ? ((descriptor.preparePipelines
                  ? (runtime.prepareMaterialShaderPipeline ?? runtime.getMaterialShaderPipeline)
                  : runtime.getMaterialShaderPipeline)?.(
                  descriptor.shader,
                  descriptor.colorFormats[0] === 'rgba16float',
                  descriptor.renderState,
                  descriptor.topology,
                  descriptor.indexFormat,
                  requestedVariantSet,
                  preparedPassKind,
                  undefined,
                  descriptor.sampleCount ?? 1,
                  descriptor.colorFormats[0] as GPUTextureFormat,
                  undefined,
                  descriptor.depthFormat === undefined
                    ? null
                    : (descriptor.depthFormat as GPUTextureFormat),
                  descriptor.vertexLayout,
                  undefined,
                  input.shaderModuleMode,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  descriptor.particleInputLanes,
                ) ?? null)
              : (preparedPipelineEntry?.pipeline ?? null);
          // A requested material shader is an exact pipeline contract. During
          // async shader warmup, substituting the generic unlit pipeline can
          // mismatch vertex layouts and HDR attachment formats, turning a
          // retryable next-frame prepare into an invalid GPU command buffer.
          const pipeline = preparedPipeline ?? null;
          if (pipeline !== null) {
            preparedMaterialPipelineShaders.set(pipeline as object, descriptor.shader);
            const bindingContract = runtime.getMaterialShaderBindingContract?.(
              descriptor.shader,
            ).bindings;
            if (bindingContract === 'group-0') {
              preparedGroup0Pipelines.add(pipeline as object);
            } else if (bindingContract === 'view-only') {
              preparedViewOnlyPipelines.add(pipeline as object);
            } else {
              preparedRenderMaterialPipelines.add(pipeline as object);
            }
          }
          return pipeline === null
            ? err(makePreparedPipelinePendingError())
            : ok({
                handle: pipeline,
                standardLighting: preparedPipelineEntry?.group2Contract === 'cluster',
              });
        },
        resolveBindings: (descriptor, pipeline) => {
          const materialShaderId = preparedMaterialPipelineShaders.get(pipeline as object);
          const bindingContract =
            materialShaderId === undefined
              ? undefined
              : runtime.getMaterialShaderBindingContract?.(materialShaderId).bindings;
          if (bindingContract === 'group-0-resource') {
            return descriptor.values.sceneDepth === undefined
              ? err(new Error('prepared group-0 resource pipeline requires a scene target'))
              : ok(undefined);
          }
          if (bindingContract === 'view-and-scene-depth') {
            return ok(undefined);
          }
          if (
            preparedRenderMaterialPipelines.has(pipeline as object) &&
            descriptor.values.group === 0 &&
            descriptor.values.sceneDepth === undefined &&
            descriptor.values.sceneDepthBinding !== undefined
          ) {
            return err(new Error('prepared scene-depth pipeline requires a scene target'));
          }
          // The typed graph composes fullscreen feature bindings from its
          // current graph views and post-process parameter snapshot at encode
          // time. Do not manufacture a fallback bind group here: during
          // registration/recovery its params buffer can still be absent, and
          // a two-entry fallback cannot satisfy a params-aware layout.
          if (
            preparedPipelineIds.has(pipeline as object) &&
            (descriptor.values.fullscreen === true || descriptor.values.view === true)
          ) {
            return ok(undefined);
          }
          if (preparedGroup0Pipelines.has(pipeline as object)) {
            const layout =
              (materialShaderId === undefined
                ? undefined
                : runtime.getMaterialBindGroupLayout?.(materialShaderId)) ??
              (
                pipeline as RenderPipeline & {
                  getBindGroupLayout?: (index: number) => BindGroupLayout;
                }
              ).getBindGroupLayout?.(0);
            return layout === undefined
              ? err(new Error('prepared group-0 pipeline bind group layout is unavailable'))
              : runtime.device.createBindGroup({ layout, entries: [] });
          }
          if (
            preparedViewOnlyPipelines.has(pipeline as object) ||
            (preparedRenderMaterialPipelines.has(pipeline as object) &&
              descriptor.values.group === 0) ||
            pipeline === runtime.getPipelineState()?.unlitPipeline
          ) {
            return ok(undefined);
          }
          const group = descriptor.values.group;
          const layout =
            (materialShaderId !== undefined
              ? (runtime.getMaterialBindGroupLayout?.(materialShaderId) ??
                (group === 0 ? runtime.getPipelineState()?.materialBindGroupLayout : undefined))
              : undefined) ??
            (
              pipeline as RenderPipeline & {
                getBindGroupLayout?: (index: number) => BindGroupLayout;
              }
            ).getBindGroupLayout?.(group === 1 ? 1 : 0);
          const material = descriptor.values.material;
          if (
            group === 1 &&
            layout !== undefined &&
            materialShaderId !== undefined &&
            typeof material === 'object' &&
            material !== null &&
            'world' in material &&
            'handle' in material &&
            typeof material.world === 'number' &&
            typeof material.handle === 'number'
          ) {
            return preparedMaterialBindings(
              runtime,
              worlds,
              materialShaderId,
              material.world,
              material.handle,
              layout,
              preparedFeatureSkylightResources,
              materialBindings,
            );
          }
          return layout === undefined
            ? err(new Error('prepared pipeline bind group layout is unavailable'))
            : runtime.device.createBindGroup({
                layout,
                entries:
                  group === 1 && preparedPipelineIds.has(pipeline as object)
                    ? [
                        {
                          binding: 0,
                          resource: {
                            kind: 'textureView',
                            value: runtime.getPipelineState()?.fallbackTextureView as never,
                          },
                        },
                        {
                          binding: 1,
                          resource: {
                            kind: 'sampler',
                            value: runtime.getPipelineState()?.defaultSampler as never,
                          },
                        },
                        ...(runtime.getPostProcessParamsBuffer?.(
                          preparedPipelineIds.get(pipeline as object) ?? '',
                        ) === undefined
                          ? []
                          : [
                              {
                                binding: 2,
                                resource: {
                                  kind: 'buffer' as const,
                                  value: {
                                    buffer: runtime.getPostProcessParamsBuffer?.(
                                      preparedPipelineIds.get(pipeline as object) ?? '',
                                    ) as never,
                                  },
                                },
                              },
                            ]),
                      ]
                    : [],
              });
        },
      });
    };
  const preparedResolverFactory = (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ): PreparedGraphicsResolver =>
    createPreparedResolverFactory(
      internals,
      featureGpuWork,
      preparedWorlds,
      activePreparedResolverCaches,
    )(input);
  const recoveryOwner = createRenderSystemRecovery({
    frameState,
    internals,
    getEnvironmentLifecycle: () => environmentLifecycle,
    getGpuDrivenProduction: () => gpuDrivenProduction,
    setGpuDrivenProduction: (production) => {
      gpuDrivenProduction = production;
    },
    disposeFeatureGpuWork,
    setFeatureGpuWork: (owner) => {
      featureGpuWork = owner;
    },
    getActiveFeaturePostProcessEntries: () => postProcessOwner.featureEntries,
    setActiveFeaturePostProcessEntries: (entries) => {
      postProcessOwner.featureEntries = entries;
    },
    postProcessPipelineCache,
    clearPostProcessPipelineCache,
    clearPostProcessPipelineEntry,
    invalidatePostProcessModule,
    persistentRenderScene,
    gpuDrivenShaderFactory,
    createFeatureGpuWorkOwner,
    pointsLinesOwner,
    createPreparedResolverFactory,
    createPreparedResolverCaches,
  });
  /**
   * Geometry observation identifies each draw's source World, revision and
   * mesh asset; a publication reports its source-realm World identity.
   */
  function beginGeometryObservation(attempt: RecordAttempt): void {
    const { composition, scopes, opts, publication } = attempt;
    gpuDrivenProduction.beginGeometryObservation(
      opts.geometryObservation === true && attempt.mode === true
        ? (slot) => {
            const scope = scopes[slot.snapshot.worldId];
            const worldIdentity =
              publication === undefined
                ? (composition.leases?.[slot.snapshot.worldId]?.worldIdentity ??
                  composition.worlds[slot.snapshot.worldId]?.identity)
                : opts.geometryObservationSourceWorldIdentity;
            if (!worldIdentity || scope === undefined) throw Error('geometry-source-unavailable');
            const handle = slot.snapshot.assetHandle as AssetHandle<'mesh'>;
            const source = 'sourceForAsset' in scope ? scope.sourceForAsset(handle) : undefined;
            return {
              worldIdentity,
              sourceRevision: publication?.packet.revision ?? slot.generation,
              ...(source === undefined
                ? {}
                : {
                    meshGuid: source.guid,
                    ...(source.sourceKey === undefined ? {} : { sourceKey: source.sourceKey }),
                  }),
            };
          }
        : undefined,
    );
  }

  /** Reset per-attempt publication facts; returns whether this call owns the profiler frame. */
  function beginRecordAttempt(attempt: RecordAttempt): boolean {
    // A failed draw cannot publish a startup completion fact. Reset the
    // projection before extraction so a later receipt never reuses an old
    // scene's readiness.
    if (attempt.mode === true) {
      lastPresentation = 'pending';
      lastPresentationPendingReason = undefined;
    }
    // A prior failed record/submit may have staged a temporal capture. A
    // capture belongs only to the draw call that created it; discard it
    // before this call can prepare or commit a new candidate.
    persistentRenderScene.discardTemporalFrame();
    // A failed draw must never leave a previous frame eligible to publish a
    // newly accepted dynamic-geometry candidate.
    dynamicGeometryFrames.begin();
    const profileSession = attempt.profileSession;
    if (profileSession === undefined || attempt.opts.profileFrame !== undefined) return false;
    try {
      return profileSession.beginFrame(++directFrameId).ok;
    } catch {
      return false;
    }
  }

  /**
   * Extraction, view selection, scene/feature preparation, submission and
   * publication of one record attempt. A rejected phase returns false and
   * leaves the last accepted frame published.
   */
  function* recordAttemptFrame(attempt: RecordAttempt): FrameRecording {
    pointsLinesOwner.beginFrame();
    retireSwappedPipelineGraph(attempt.publication);
    dispatchCounts.unlit = 0;
    let frame: ExtractedFrame;
    try {
      frame = runProfiledRenderPhase(attempt.profileSession, 'extract', () =>
        extractRecordFrame(attempt),
      );
    } catch (cause) {
      attempt.submitted = yield* recoverExtractionFailure(cause, attempt.encoder);
      return attempt.submitted;
    }
    lastMotionBlurInvalidParams = undefined;
    const view = selectRecordView(attempt, frame);
    if (view === undefined) return false;
    const scene = prepareRecordScene(attempt, frame, view);
    if (scene === undefined) return false;
    const features = yield* prepareRecordFeatures(attempt, frame, view);
    if (features === undefined) return false;
    if (attempt.mode !== true && !hasCaptureWork(features)) {
      if (attempt.mode === 'capture') disposeTargetCaptureLighting(cubeCaptureState);
      return true;
    }
    const draws = yield* submitRecordedFrame(attempt, frame, view, scene, features);
    publishRecordOutcome(attempt, frame, view, scene, features, draws);
    return attempt.submitted;
  }

  /**
   * Keep the compiled graph as last-known-good until the candidate topology
   * compiles. The failed candidate frame does not execute it; successful
   * replacement retires it atomically in ensureCompiledFrameGraph. Feature
   * contributions describe the active pipeline graph, so a hot-swap drops the
   * old graph before the next frame re-runs feature contribution.
   */
  function retireSwappedPipelineGraph(publication: PreparedRenderPublication | undefined): void {
    if (frameState.installedPipelineHandle === lastBuiltPipelineHandle) return;
    resetRenderFeatureGraphState(internals);
    lastBuiltPipelineHandle = frameState.installedPipelineHandle;
    if (publication === undefined) persistentRenderScene.invalidate();
  }

  /** cameraOwner drives surfaced cameras and frustum cull; resourceOwner drives singleton resources. */
  function extractRecordFrame(attempt: RecordAttempt): ExtractedFrame {
    if (attempt.publication !== undefined)
      return consumeRecordPublication(
        attempt.publication,
        attempt.composition.owners.cameraEntityKey,
      );
    const { worlds: sourceWorlds, owners, leases } = attempt.composition;
    const { cameraOwner, resourceOwner, cameraEntityKey } = owners;
    const materialContext = renderMaterialContext(
      internals.device.caps,
      internals.device.limits,
      internals.standardProfile?.visibleSurface === true,
    );
    const materialCaches = persistentRenderScene.materialSnapshotCacheStore(
      materialContext.materialContext,
    );
    return persistentRenderScene.extractComposition(
      sourceWorlds,
      { cameraOwner, resourceOwner },
      internals.assets,
      (renderables) =>
        extractFrames(
          sourceWorlds,
          {
            cameraOwner,
            resourceOwner,
            ...(cameraEntityKey === undefined ? {} : { cameraEntityKey }),
          },
          internals.assets,
          materialCaches,
          {
            ...materialContext,
            cull: 'none',
            ...(internals.viewOutput === undefined ? {} : { viewExtent: internals.viewOutput }),
            retainHidden: true,
            renderables,
            instanceCollections,
            ...(!internals.device.caps.storageBuffer ||
            internals.getMaterialShaderArtifact === undefined
              ? {}
              : { getMaterialShaderArtifact: internals.getMaterialShaderArtifact }),
          },
        ),
      leases,
    );
  }

  /** A view-output receiver keeps only the published camera it presents. */
  function consumeRecordPublication(
    publication: PreparedRenderPublication,
    cameraEntityKey: number | undefined,
  ): ExtractedFrame {
    const viewOutput = internals.viewOutput;
    const viewCamera =
      viewOutput === undefined
        ? undefined
        : cameraForView(publication.frame.cameras, cameraEntityKey, viewOutput);
    return persistentRenderScene.consumePublication(
      preparePublicationGeometry(
        viewOutput === undefined
          ? publication
          : {
              ...publication,
              frame: {
                ...publication.frame,
                cameras: viewCamera === undefined ? [] : [viewCamera],
                auxiliaryCameras: publication.frame.auxiliaryCameras,
                cubeCameras: publication.frame.cubeCameras,
              },
            },
        internals.assets,
        instanceCollections,
        internals.device.caps.storageBuffer ? internals.getMaterialShaderArtifact : undefined,
      ),
    );
  }

  /** Pending assets submit the preparation barrier; invalid motion blur rejects the frame. */
  function* recoverExtractionFailure(
    cause: unknown,
    encoder: RhiCommandEncoder | undefined,
  ): FrameRecording {
    if (cause instanceof AssetError && cause.code === 'asset-not-ready') {
      const submitted = yield* recordPreparationBarrier(internals, encoder);
      if (submitted) {
        submittedFrameCount++;
        lastSubmittedGeneration = internals.deviceScope.generation;
      }
      return submitted;
    }
    if (cause instanceof MotionBlurValidationError) {
      lastMotionBlurInvalidParams = cause;
      latestCamera = undefined;
      internals.errorRegistry.fire(cause);
      return false;
    }
    throw cause;
  }

  function cameraScope(attempt: RecordAttempt): RenderResourceScope {
    return attempt.scopes[attempt.composition.owners.cameraOwner] as RenderResourceScope;
  }

  function resourceScope(attempt: RecordAttempt): RenderResourceScope {
    return attempt.scopes[attempt.composition.owners.resourceOwner] as RenderResourceScope;
  }

  /** The selected display camera, its fitted lights and the Standard configuration it implies. */
  function selectRecordView(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
  ): { readonly cameras: CameraSnapshot[]; readonly lights: ExtractedLights } | undefined {
    const captureOnly = attempt.mode === 'capture';
    const cameras = captureOnly
      ? captureOnlyCameras(frame.cameras, attempt.opts.cameraEntityKey)
      : frame.cameras;
    const lights = fitDirectionalCsm(
      frame.lights,
      cameras[0],
      captureOnly,
      frameState.directionalShadowProjection,
    );
    if (!admitCameraConfiguration(cameras[0])) return undefined;
    internals.gpuPassTimingViewId = cameras[0]?.entityKey;
    const preparedOutput = prepareStandardOutputResources(
      frameState,
      internals,
      cameras[0],
      cameraScope(attempt),
    );
    if (!preparedOutput.ok) {
      internals.errorRegistry.fire(preparedOutput.error);
      return undefined;
    }
    return { cameras, lights };
  }

  type RecordView = NonNullable<ReturnType<typeof selectRecordView>>;

  /**
   * Derive after this view selects its camera. Capture-only snapshots omit
   * display companions and therefore restore the author configuration.
   */
  function admitCameraConfiguration(camera: CameraSnapshot | undefined): boolean {
    const lane = {
      storageBuffer: internals.device.caps.storageBuffer,
      maxColorAttachments: internals.device.limits.maxColorAttachments,
    };
    let configuration = deriveCameraStandardConfiguration(
      internals.standardProfile,
      configuredPipelineConfig,
      camera,
      lane,
    );
    if (!configuration.ok) {
      const failureKey = JSON.stringify([configuration.error.code, configuration.error.detail]);
      if (failureKey !== lastCameraAoFailure) {
        internals.errorRegistry.fire(configuration.error);
        lastCameraAoFailure = failureKey;
      }
      // Invalid AO cannot prevent an independently authored SSR request.
      configuration = deriveCameraStandardConfiguration(
        internals.standardProfile,
        configuredPipelineConfig,
        { screenSpaceReflection: camera?.screenSpaceReflection },
        lane,
      );
    } else {
      lastCameraAoFailure = '';
    }
    if (!configuration.ok) return false;
    const signature = JSON.stringify([
      configuration.value.profile?.renderPath,
      configuration.value.config?.ssao,
    ]);
    frameState.cameraStandardProfile = configuration.value.profile;
    frameState.installedPipelineConfig = configuration.value.config;
    if (signature !== cameraStandardSignature) {
      cameraStandardSignature = signature;
      installEpoch += 1;
      frameState.installedPipelineHandle = installEpoch;
      // Re-contribute before compiling the current selected view. The
      // prior compiled graph remains last-known-good until compilation.
      resetRenderFeatureGraphState(internals);
      lastBuiltPipelineHandle = installEpoch;
    }
    return true;
  }

  /**
   * Scene-side preparation for the selected view: shadow/probe/SSR state,
   * visibility projection, presentation candidate, LOD inspection and the
   * environment and transmission admission gates.
   */
  function prepareRecordScene(attempt: RecordAttempt, frame: ExtractedFrame, view: RecordView) {
    const { cameras, lights } = view;
    const shadowCasterProjection = persistentRenderScene.shadowCasterProjection();
    lastDirectionalShadowLights = lights;
    lastDirectionalShadowCandidate = 'failed';
    lastDirectionalShadowError = lights.directionalShadowError;
    const reflectionProbes = prepareReflectionProbes(
      frame,
      lights,
      cameras[0],
      resourceScope(attempt),
    );
    latestCamera = cameras[0];
    const ssrDependencies = resolveFrameSsrDependencies();
    const visibility = projectRecordVisibility(attempt.scopes, frame, cameras.length);
    const terrainCandidate = captureSubmittedTerrain(
      visibility.presentationRenderables,
      attempt.scopes,
    );
    frameState.pipelinePreparationPending = false;
    delete frameState.pipelinePreparationPendingReason;
    const presentation = initialFramePresentation(
      cameras.length,
      frame.environmentReady && frame.environment !== undefined,
    );
    const lodFrameId = observationFrameId();
    const lodCandidateCount = inspectFrameLod(latestCamera, frame, visibility, attempt, lodFrameId);
    persistentRenderScene.prepareTemporalFrame(visibility.projection.renderables);
    if (!admitFrameEnvironment(frame, cameras.length)) return undefined;
    const transmissionAntialias = frame.cameras[0]?.antialias ?? 'none';
    if (!prepareTransmissionCandidate(transmissionAntialias)) {
      // The candidate gate runs before bind-group preparation, graph
      // construction, and record/submit. A missing capability therefore
      // cannot publish or execute a transmission graph.
      updateTransmissionInspection(transmissionAntialias, false);
      return undefined;
    }
    // Retain accepted roots only. Full diagnostic rows belong to explicit inspection.
    lastMeshMaterialBindingRenderables = frame.renderables;
    lastMeshMaterialBindingWorlds = preparedWorlds;
    lastMeshMaterialBindingMaterials = shadowCasterProjection?.content.materials;
    return {
      shadowCasterProjection,
      reflectionProbes,
      ssrDependencies,
      visibility,
      terrainCandidate,
      presentation,
      lodFrameId,
      lodCandidateCount,
      transmissionAntialias,
    };
  }

  type RecordScene = NonNullable<ReturnType<typeof prepareRecordScene>>;

  function prepareReflectionProbes(
    frame: ExtractedFrame,
    lights: ExtractedLights,
    camera: CameraSnapshot | undefined,
    resourceWorld: RenderResourceScope,
  ) {
    const probes = frame.reflectionProbes ?? [];
    return reflectionProbeOwner.prepare(
      probes,
      persistentRenderScene.reflectionProbeProjection().selected,
      camera,
      frameState.frameNumber,
      frame.skylight,
      probes.some((probe) => probe.updateIntent === 'on-change')
        ? JSON.stringify([
            persistentRenderScene.reflectionCaptureRevision(),
            lights.directional,
            lights.point,
            lights.spot,
            lights.rect,
            frame.skylight,
            frame.skybox,
            frame.environment?.environmentSignature,
          ])
        : '',
      frame.skybox,
      frame.environment as import('./environment/frame').SelectedEnvironmentFrame | undefined,
      resourceWorld,
    );
  }

  /**
   * Resolve before a committed fallback change resets accumulation. Fresh
   * spatial SSR does not require a previous temporal submission. Inspection
   * uses the read-only projection and never resets state.
   */
  function resolveFrameSsrDependencies(): SsrDependenciesInspection {
    frameState.ssrRequested = latestCamera?.screenSpaceReflection !== undefined;
    const dependencies = resolveSsrDependencies(frameState.ssrRequested);
    const reset = resolveSsrAdmissionGeneration(
      ssrFallbackGeneration,
      dependencies.reflectionFallback?.projectionGeneration,
    );
    if (reset.changed) {
      resetTemporalHistory(frameState, 'signature-change');
      frameState.ssrHistoryOwner?.reset('reflection-generation');
    }
    ssrFallbackGeneration = reset.generation;
    return dependencies;
  }

  function projectRecordVisibility(
    scopes: readonly RenderResourceScope[],
    frame: ExtractedFrame,
    cameraCount: number,
  ) {
    const worldKeys = persistentRenderScene.visibilityWorldKeysFor(scopes);
    const slotByEntity = persistentRenderScene.compositionSlotByStableEntity();
    const projection = persistentRenderScene.projectVisibility(
      scopes,
      frame.renderables,
      frame.dispatch,
    );
    const presentationRenderables =
      cameraCount === 0
        ? []
        : projectDisplayRenderables(projection.renderables, projection.dispatch);
    return { worldKeys, slotByEntity, projection, presentationRenderables };
  }

  type RecordVisibility = ReturnType<typeof projectRecordVisibility>;

  /**
   * The public frame receipt is allocated by WebGPURenderer immediately
   * before this draw (`observationFrameId`). RenderSystem's private
   * frameNumber is an internal generation that also advances on failed record
   * attempts, so it is only the fallback identity.
   */
  function observationFrameId(): number {
    return (
      (internals as RenderSystemInternals & { readonly observationFrameId?: number })
        .observationFrameId ?? frameState.frameNumber
    );
  }

  function lodCandidateCountOf(renderables: FrameList<RenderableSnapshot>): number {
    if (lodCandidateCountCache?.renderables === renderables) return lodCandidateCountCache.count;
    const count = renderables.reduce(
      (total, renderable) => total + ((renderable.lods?.length ?? 0) > 0 ? 1 : 0),
      0,
    );
    lodCandidateCountCache = { renderables, count };
    return count;
  }

  function lodInspectionRenderablesOf(
    submissionRenderables: FrameList<RenderableSnapshot>,
    lodCandidateCount: number,
  ): FrameList<RenderableSnapshot> {
    const cached = lodInspectionRenderablesCache;
    if (
      cached?.submissionRenderables === submissionRenderables &&
      cached.lodCandidateCount === lodCandidateCount
    )
      return cached.values;
    const values =
      lodCandidateCount > 0
        ? submissionRenderables.filter((renderable) => (renderable.lods?.length ?? 0) > 0)
        : submissionRenderables;
    lodInspectionRenderablesCache = { submissionRenderables, lodCandidateCount, values };
    return values;
  }

  /**
   * Publish the CPU-side LOD/occlusion inspection bound to the caller's frame
   * receipt id; returns the frame's LOD candidate count. The GPU lane replaces
   * this projection with its selector counters; the CPU lane reports the same
   * hard selection its classic draws use.
   */
  function inspectFrameLod(
    camera: CameraSnapshot | undefined,
    frame: ExtractedFrame,
    visibility: RecordVisibility,
    attempt: RecordAttempt,
    frameId: number,
  ): number {
    if (camera === undefined) {
      lastLodOcclusionInspection = undefined;
      lastLodWorldAttachments = new Map();
      return 0;
    }
    const scopes = attempt.scopes;
    const renderables = frame.renderables;
    const submissionRenderables = visibility.projection.renderables;
    const lodCandidateCount = lodCandidateCountOf(renderables);
    const inspectionRenderables = lodInspectionRenderablesOf(
      submissionRenderables,
      lodCandidateCount,
    );
    const cpuLodLane = selectGpuLodLane(internals.device.caps) === 'cpu';
    const levelOf = (renderable: RenderableSnapshot): number =>
      cpuLodLane
        ? cpuLodLevel(
            renderable,
            internals.gpuStore.getMeshGpuHandles(
              renderable.assetHandle as AssetHandle<'mesh'>,
              scopes[renderable.worldId] ?? renderable.worldId,
            ),
            camera,
          )
        : 0;
    const inspectionWorlds = createLodWorldInspections(
      scopes,
      renderables,
      submissionRenderables,
      camera,
      frameId,
      visibility.worldKeys,
      visibility.slotByEntity,
      levelOf,
    );
    const inspectionLevels = inspectionRenderables.map(levelOf);
    lastLodWorldAttachments = lodWorldAttachments(scopes, visibility.worldKeys);
    const firstRenderable = renderables.at(0);
    const candidates =
      lodCandidateCount > 0 ? lodCandidateCount : renderables.length + frame.frustumStats.culled;
    lastLodOcclusionInspection = inspectLodOcclusion({
      root: {
        guid:
          firstRenderable === undefined ? 'none' : `asset-handle:${firstRenderable.assetHandle}`,
        sourceKey: `render-frame:${frameId}`,
      },
      view: {
        attachmentId:
          scopes[camera.worldId ?? attempt.composition.owners.cameraOwner]?.identity ?? 'none',
        cameraEntity: camera.entityKey ?? 0,
        viewRole: 'main',
        viewGeneration: camera.historyVersion ?? 0,
      },
      slot: { primitiveSlot: 0, slotGeneration: persistentRenderScene.topologyRevision() },
      generation: frameId,
      count: { candidates, visible: inspectionRenderables.length, occluded: 0 },
      lodHistogram: lodLevelHistogram(inspectionLevels),
      samples: inspectionRenderables.slice(0, 64).map((_, index) => ({
        primitiveSlot: index,
        level: inspectionLevels[index] ?? 0,
        visible: true,
      })),
      submit: {
        frameId,
        build: resolveInspectionBuild(internals),
        deviceGeneration: internals.deviceScope.generation,
      },
      worlds: inspectionWorlds,
    });
    return lodCandidateCount;
  }

  /** Bind the selected environment candidate; false rejects a camera-bearing frame atomically. */
  function admitFrameEnvironment(frame: ExtractedFrame, cameraCount: number): boolean {
    const environment = frame.environment;
    frameState.environmentFrame = environment as
      | import('./environment/frame').SelectedEnvironmentFrame
      | undefined;
    if (environment?.source.kind !== 'atmosphere') releaseAtmosphere(internals);
    environmentLifecycle.bindScope(internals.deviceScope);
    if (frame.fogFailure !== undefined) {
      environmentLifecycle.recordSelectionFailure(frame.fogFailure);
    }
    if (!frame.environmentReady || environment === undefined) {
      frameState.pendingTemporalCommit = { kind: 'none' };
      // A world with no camera still has a valid clear-only render path.
      // It has no environment candidate and therefore must not publish an
      // off/taa temporal state; camera-bearing rejected extraction remains
      // an atomic render failure.
      return cameraCount === 0;
    }
    const environmentCandidate = environmentLifecycle.ensure(environment);
    if (!environmentCandidate.ok) {
      environmentLifecycle.recordCandidateFailure(environmentCandidate.error);
      internals.errorRegistry.fire(environmentCandidate.error);
      return false;
    }
    if (!environmentLifecycle.isActive(environmentCandidate.value)) {
      frameState.environmentGeneration = environmentCandidate.value;
    }
    return true;
  }

  /**
   * Bind groups, motion blur and skylight feature resources, then the feature
   * host frame and its graph candidate. `undefined` rejects the frame.
   */
  function* prepareRecordFeatures(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
  ): FrameRecording<RecordFeatures | undefined> {
    bindGroupCounts.createBindGroup = 0;
    bindGroupCounts.keys = [];
    const pipelineState = internals.getPipelineState();
    const camera = view.cameras[0];
    const generation = internals.deviceScope.generation;
    const featureView = createCloudFeatureView(
      camera,
      attempt.scopes,
      attempt.composition.owners.cameraOwner,
      internals.canvas.width,
      internals.canvas.height,
      generation,
      frameState.lastSuccessfulTemporalView === undefined,
      lastSubmittedGeneration !== undefined && lastSubmittedGeneration !== generation,
    );
    buildFrameBindGroups(attempt.profileSession, pipelineState, frame.cameras.length);
    retainFrameInspection(frame);
    const targets = resolveFeatureTargets(internals, pipelineState, camera, frame.cloudLayer);
    const identity =
      attempt.mode === 'capture' ? 'renderer:capture' : renderFeatureViewIdentity(camera);
    planFrameMotionBlur(attempt, camera, frame.environment, identity);
    preparedFeatureSkylightResources = resolveFeatureSkylight(
      pipelineState,
      frame,
      resourceScope(attempt),
    );
    const host = yield* prepareFeatureHostFrame(
      attempt,
      frame,
      view,
      internals.featureHost === undefined
        ? undefined
        : featureFrameInput(attempt, frame, camera, targets, featureView, identity),
    );
    if (host === undefined) return undefined;
    const candidate = runProfiledRenderPhase(attempt.profileSession, 'features', () =>
      prepareFeatureGraphCandidate(attempt, host.featureFrame),
    );
    return { ...host, candidate };
  }

  function buildFrameBindGroups(
    profileSession: RecorderSession | undefined,
    pipelineState: PipelineState | null,
    cameraCount: number,
  ): void {
    const skipReason: RenderPhaseSkipReason | undefined =
      internals.featureHost === undefined
        ? 'feature-host-unavailable'
        : internals.featureHost.size === 0
          ? 'feature-host-empty'
          : pipelineState === null
            ? 'pipeline-state-unavailable'
            : cameraCount === 0
              ? 'camera-unavailable'
              : undefined;
    if (skipReason !== undefined || pipelineState === null) {
      recordProfileSkip(profileSession, 'bind-groups', skipReason ?? 'pipeline-state-unavailable');
      return;
    }
    runProfiledRenderPhase(profileSession, 'bind-groups', () =>
      buildPerFrameBindGroups(
        internals,
        frameState,
        pipelineState,
        true,
        bindGroupCounts,
        undefined,
        false,
      ),
    );
  }

  function retainFrameInspection(frame: ExtractedFrame): void {
    lastFrustumSource = frame.frustumStats;
    lastVisibilityStats.explicitlyHidden = frame.visibilityStats.explicitlyHidden;
    if (frame.materialTextureSources === undefined) return;
    lastMaterialTextureSources = Object.freeze({
      sourceFieldsVisited: frame.materialTextureSources.sourceFieldsVisited,
      producerRoutes: Object.freeze({ ...frame.materialTextureSources.producerRoutes }),
    });
  }

  function planFrameMotionBlur(
    attempt: RecordAttempt,
    camera: CameraSnapshot | undefined,
    environment: ExtractedFrame['environment'],
    cameraViewIdentity: string,
  ): void {
    let fallbackDelta = 0;
    try {
      const delta = renderTime(cameraScope(attempt)).delta;
      fallbackDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    } catch {
      fallbackDelta = 0;
    }
    const plan = planMotionBlurFrame({
      params: camera?.motionBlur,
      sampleTimeSeconds: attempt.opts.sampleTimeSeconds,
      acceptedSampleTimeSeconds: frameState.lastSuccessfulTemporalView?.sampleTimeSeconds,
      fallbackDeltaSeconds: fallbackDelta,
      acceptedTemporal: frameState.lastSuccessfulTemporalView,
      temporalReset: attempt.opts.temporalReset === true,
      width: Math.max(1, internals.canvas.width),
      height: Math.max(1, internals.canvas.height),
      cameraViewIdentity,
      historyVersion: camera?.historyVersion ?? 0,
      environmentSignature: environment?.environmentSignature ?? '',
      fogSignature: environment?.fogSignature ?? '',
      deviceGeneration: internals.deviceScope?.generation ?? 0,
    });
    motionBlurFeatureInput = plan.featureInput;
    const caps = internals.device.caps;
    if (
      plan.demanded &&
      caps.compute === true &&
      caps.storageBuffer === true &&
      caps.storageTexture === true &&
      caps.rgba16floatRenderable === true
    ) {
      ensureMotionBlurFeature();
    }
  }

  function resolveFeatureSkylight(
    pipelineState: PipelineState | null,
    frame: ExtractedFrame,
    resourceWorld: RenderResourceScope,
  ): SkylightBindGroupResources | undefined {
    if (pipelineState === null) return undefined;
    const skylight = frame.skylight;
    return resolveMaterialSkylight(
      internals,
      pipelineState,
      skylight,
      frame.skylightCount,
      skylight === undefined
        ? undefined
        : internals.gpuStore.getCubemapIbl(skylight.equirectHandle, resourceWorld),
    ).skylightResources;
  }

  function featureFrameInput(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    camera: CameraSnapshot | undefined,
    targets: ReturnType<typeof resolveFeatureTargets>,
    featureView: ReturnType<typeof createCloudFeatureView>,
    identity: string,
  ): FeatureFrameRequest['input'] {
    const { publication, scopes } = attempt;
    const sceneInputs = internals.featureSceneInputs;
    return {
      identity,
      render: attempt.mode === true,
      ...(motionBlurFeatureInput === undefined ? {} : { motionBlur: motionBlurFeatureInput }),
      worlds: attempt.composition.worlds,
      resolveAsset: (index, handle, revision) => {
        const source = scopes[index];
        return source === undefined
          ? err(new Error(`Missing feature asset source ${index}`))
          : source.resolveAsset(handle, revision);
      },
      ...(publication === undefined
        ? {}
        : {
            publishedFeatures: publication.packet.features,
            ...(publication.onFeatureSourceSubmitted === undefined
              ? {}
              : { onFeatureSourceSubmitted: publication.onFeatureSourceSubmitted }),
          }),
      owner: attempt.composition.owners.resourceOwner,
      frameNumber: internals.rendererFrameNumber ?? frameState.frameNumber,
      ...featureCameraSelection(camera),
      frameSize: { width: internals.canvas.width, height: internals.canvas.height },
      visibilitySnapshots: frame.featureVisibilitySnapshots,
      hiddenEntityReports: frame.hiddenEntityReports,
      targets,
      generation: internals.featureHost?.preparedGeneration ?? 0,
      getFeatureShaderSource: internals.getFeatureShaderSource,
      caps: internals.device.caps,
      featureReadOnlyDepthBatchDiagnostic:
        (internals.standardProfile?.featureReadOnlyDepthBatchDiagnostic ??
          internals.standardProfile?.featureReadOnlyDepthBatching) === true,
      limits: internals.device.limits,
      frame: createCloudFeatureFrameContext(frame.cloudLayer, featureView),
      ...(internals.getMaterialShaderBindingContract === undefined
        ? {}
        : { materialShaderBindingContract: internals.getMaterialShaderBindingContract }),
      createPreparedGraphicsResolver: preparedResolverFactory,
      gpuWork: featureGpuWork,
      sceneResources:
        sceneInputs === undefined
          ? undefined
          : {
              prepare: (identity, resource) =>
                sceneInputs.prepare(identity, resource, {
                  retained: persistentRenderScene.compositionRetainedScene(),
                  scopes,
                }),
              abortFeature: (identity) => sceneInputs.abortFeature(identity),
            },
    };
  }

  /**
   * Run the feature host for this frame. Capture scheduling may replace the
   * auxiliary camera list and add scene-input work. `undefined` means the
   * host rejected the frame.
   */
  function* prepareFeatureHostFrame(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
    input: FeatureFrameRequest['input'] | undefined,
  ): FrameRecording<Omit<RecordFeatures, 'candidate'> | undefined> {
    // Publication carries planar authoring facts from the source realm.
    // Re-project them against this RenderSystem's selected display camera.
    let auxiliaryCameras = projectAuxiliaryCamerasForView(view.cameras[0], frame.auxiliaryCameras);
    let scheduledCaptureWork: readonly import('./capture/scheduler').CubeCaptureWork[] = [];
    let sceneInputWork: readonly import('./record/target-capture-graph').CubeCaptureGraphWork[] =
      [];
    let featureFrame: import('./features/host').RenderFeatureFrameResult | undefined;
    const host = internals.featureHost;
    if (host !== undefined && input !== undefined) {
      if (attempt.encoder === undefined) {
        const createdEncoder = internals.device.createCommandEncoder();
        if (!createdEncoder.ok) throw createdEncoder.error;
        attempt.encoder = createdEncoder.value;
      }
      const render = attempt.mode === true;
      const featureSignal = yield {
        kind: 'features' as const,
        host,
        internals,
        encoder: attempt.encoder,
        captures: {
          snapshots: frame.cubeCameras,
          auxiliary: frame.auxiliaryCameras,
          exclusive: attempt.mode === 'capture',
          accept: (
            work: readonly import('./capture/scheduler').CubeCaptureWork[],
            sharedAuxiliary: readonly CameraSnapshot[],
            sceneInputs: readonly import('./record/target-capture-graph').CubeCaptureGraphWork[],
          ) => {
            scheduledCaptureWork = work;
            sceneInputWork = sceneInputs;
            auxiliaryCameras = [
              ...(render
                ? auxiliaryCameras.filter((camera) => camera.planarReflection !== undefined)
                : []),
              ...sharedAuxiliary,
            ];
          },
        },
        input,
        accept: (result: import('./features/host').RenderFeatureFrameResult) => {
          featureFrame = result;
        },
      };
      if (!featureSignal.ok) return undefined;
    }
    return { scheduledCaptureWork, sceneInputWork, auxiliaryCameras, featureFrame };
  }

  function prepareFeatureGraphCandidate(
    attempt: RecordAttempt,
    featureFrame: import('./features/host').RenderFeatureFrameResult | undefined,
  ): RenderFeatureGraphCandidate | undefined {
    assertPublishedFeaturesImplemented(attempt.publication, internals.featureHost);
    if (internals.featureHost === undefined || featureFrame === undefined) return undefined;
    if (featureFrame.preparationPending)
      markPipelinePreparationPending(frameState, featurePreparationPendingReason(featureFrame));
    lastVisibilityStats.explicitlyHidden = featureFrame.hiddenEntityReports.length;
    reportPendingRenderFeatureErrors(
      featureFrame.errors,
      frameState.frameNumber,
      pendingFeatureErrorLastReportedFrame,
      internals.errorRegistry,
    );
    const postProcessParams = postProcessOwner.prepare(featureFrame.fullscreenEffects);
    if (!postProcessParams.ok) {
      internals.errorRegistry.fire(postProcessParams.error);
      releasePreparedResourceBatches(featureFrame, internals.errorRegistry);
      return undefined;
    }
    const candidate = createFeatureGraphCandidate(attempt, featureFrame, postProcessParams.value);
    recordRenderFeatureCandidate(internals, candidate);
    return candidate;
  }

  type PostProcessParamsCandidate = Extract<
    ReturnType<typeof postProcessOwner.prepare>,
    { readonly ok: true }
  >['value'];

  function createFeatureGraphCandidate(
    attempt: RecordAttempt,
    featureFrame: import('./features/host').RenderFeatureFrameResult,
    postProcessParams: PostProcessParamsCandidate,
  ): RenderFeatureGraphCandidate {
    return {
      plans: featureFrame.plans,
      fullscreenEffects: featureFrame.fullscreenEffects,
      postProcessIdentities: featureFrame.postProcessIdentities,
      ...(featureFrame.requiresPreparedResourceKey
        ? { preparedResourceKey: `frame-${frameState.frameNumber}` }
        : {}),
      onRejected: () => {
        featureFrame.onAborted();
        releasePreparedResourceBatches(featureFrame, internals.errorRegistry);
        postProcessOwner.discard(postProcessParams);
      },
      onAbandoned: () => {
        featureFrame.onAborted();
        postProcessOwner.discard(postProcessParams);
      },
      onSubmitted: () => {
        featureFrame.onSubmitted();
      },
      onAborted: () => {
        featureFrame.onAborted();
      },
      onAccepted: () => {
        attempt.featureGraphAccepted = true;
        acceptFeaturePostProcess(featureFrame, postProcessParams);
      },
    };
  }

  /** Retire pipelines and modules of post-process entries the accepted frame replaced. */
  function acceptFeaturePostProcess(
    featureFrame: import('./features/host').RenderFeatureFrameResult,
    postProcessParams: PostProcessParamsCandidate,
  ): void {
    for (const [id, previous] of postProcessOwner.featureEntries) {
      const next = featureFrame.fullscreenEffects.get(id);
      if (next === undefined) {
        clearPostProcessPipelineCache(id);
        invalidatePostProcessModule(id);
      } else if (
        postProcessShaderEntrySignature(previous) !== postProcessShaderEntrySignature(next)
      ) {
        clearPostProcessPipelineEntry(id, previous);
        if (previous.source !== next.source) {
          invalidatePostProcessModule(id);
        }
      }
    }
    postProcessOwner.accept(postProcessParams);
    postProcessOwner.featureEntries = featureFrame.fullscreenEffects;
  }

  /**
   * Unified transparent-sort: (layer ASC, sortValue ASC) for modes 0/1/2;
   * distance back-to-front for mode=3. The config is a resource-owner world
   * resource. Native Scene Passes own their actual ordering; CPU-only and
   * manual recording sort queue-selected/blended work without touching
   * opaque slots.
   */
  function sortTransparentDispatch(
    attempt: RecordAttempt,
    cameras: readonly CameraSnapshot[],
    scene: RecordScene,
  ): DispatchList {
    const { projection } = scene.visibility;
    return transparentSort.sort(
      projection.dispatch,
      resourceScope(attempt),
      cameras,
      new FrameProjection(projection.renderables, (source) => ({
        transform: source.transform,
        material: source.material.snapshot,
      })),
    );
  }

  /**
   * `passes` deliberately keeps only the graph-pass boundary plus
   * once-per-record owners (GPU-driven prepare). The same runner is also
   * called by geometry/material helpers; invoking those wrappers would turn a
   * pass probe into the high-overhead per-draw `nested` probe.
   */
  function recordProfileRunner(
    profileSession: RecorderSession | undefined,
  ): RecordProfileRunner | undefined {
    if (profileSession === undefined || profileSession.detail === 'owner') return undefined;
    return function recordProfilePhase<T>(phase: RenderRecordPhase, action: () => T): T {
      if (profileSession.detail === 'passes' && !isPassProfilePhase(phase)) return action();
      return runProfiledRenderPhase(profileSession, phase, action);
    };
  }

  function stageLiveStandardOutputStates(
    attempt: RecordAttempt,
    camera: CameraSnapshot | undefined,
  ): void {
    if (!hasLiveStandardOutputState(frameState, camera?.output)) return;
    const deltaTime = renderTime(cameraScope(attempt)).delta;
    stageStandardOutputStates(
      frameState,
      internals,
      camera,
      Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0,
    );
  }

  function cameraFrameTime(attempt: RecordAttempt): number {
    const elapsed = renderTime(cameraScope(attempt)).elapsed;
    return Number.isFinite(elapsed) ? elapsed : 0;
  }

  /** Track actual draws so a clear/submit cannot claim visible geometry was presented. */
  function presentedRenderableRecorder(attempt: RecordAttempt, worldKeys: readonly number[]) {
    const presentedDraws = createPresentationDraws();
    const drawObservation = createDrawObservation(internals);
    const consumeDynamicGeometry = dynamicGeometryFrames.onRenderableDraw(attempt.scopes);
    const sourceWorlds = attempt.composition.worlds;
    const markPresentedRenderable = (
      entry: Parameters<typeof drawObservation.record>[0],
      submeshIndex?: number,
      receipt?: RenderableDrawReceipt,
    ): void => {
      const entityKey = worldEntityKey(
        worldKeys[entry.source.worldId] ?? entry.source.worldId,
        entry.source.entityKey,
      );
      if (receipt?.ready !== false) {
        presentedDraws.record(
          entityKey,
          submeshIndex,
          submeshIndex === undefined ? undefined : entry.source.terrainSection?.index,
        );
      }
      drawObservation.record(entry, submeshIndex, receipt, sourceWorlds[entry.source.worldId]);
      consumeDynamicGeometry(entry, receipt?.lane ?? 'cpu');
    };
    return { presentedDraws, drawObservation, markPresentedRenderable };
  }

  /**
   * Record and submit the frame. The record stage resolves each renderable's
   * mesh and material textures against the World it was extracted from
   * (`worlds[renderable.worldId]`); `resourceWorld` stays the singleton
   * resource owner (skybox equirect, transparent-sort config, video provider).
   */
  function* submitRecordedFrame(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
    scene: RecordScene,
    features: RecordFeatures,
  ): FrameRecording<RecordDraws> {
    const { cameras, lights } = view;
    const captureOnly = attempt.mode === 'capture';
    const { projection } = scene.visibility;
    const environment = frame.environment;
    const frustumStats = frame.frustumStats;
    const gpuDrivenScene = persistentRenderScene.compositionGpuDrivenState();
    const orderedDispatch = runProfiledRenderPhase(attempt.profileSession, 'sort', () =>
      scene.shadowCasterProjection === undefined || gpuDrivenScene === undefined
        ? sortTransparentDispatch(attempt, cameras, scene)
        : projection.dispatch,
    );
    const bloomAdmitted = standardBloomAdmitted(cameras[0]);
    if (bloomAdmitted) internals.getPipelineState()?.perPassResources.ensureBloomResources?.();
    stageLiveStandardOutputStates(attempt, cameras[0]);
    const surfaceSubmissionCandidate = surfaceSubmissionObservation.begin({
      frameId: observationFrameId(),
      requestedLane: attempt.opts.geometryLane === 'direct' ? 'direct' : 'gpu-driven',
      deviceGeneration: internals.deviceScope.generation,
      resourceGeneration: gpuDrivenProduction.resourceGeneration,
    });
    frameState.surfaceSubmissionObservation = surfaceSubmissionCandidate;
    const probeCaptureScene = projectProbeCaptureScene(scene, features, orderedDispatch);
    const draws = presentedRenderableRecorder(attempt, scene.visibility.worldKeys);
    attempt.submitted = yield* profileFrameRecording(
      prepareFrameRecording(
        internals,
        resourceScope(attempt),
        cameras,
        lights,
        probeCaptureScene?.renderables ?? projection.renderables,
        probeCaptureScene?.displayDispatch ?? orderedDispatch,
        frameState,
        dispatchCounts,
        bindGroupCounts,
        frame.skylight,
        frame.skylightCount,
        frame.skybox,
        frame.skyboxCount,
        frame.postProcessParams,
        attempt.scopes,
        recordProfileRunner(attempt.profileSession),
        {
          owner: gpuDrivenProduction,
          onSubmittedWork: (completed) => skinTasks.trackSubmittedWork(completed),
          scene: gpuDrivenScene,
          onRasterLane: (owned) => {
            persistentRenderScene.setGpuDrivenRasterLane(owned);
          },
          activeEntityKeys: projection.activeEntityKeys,
          activeEntityRevision: projection.activeEntityRevision,
          visibleRasterRows: () => Math.max(0, frustumStats.total - frustumStats.culled),
          ...(captureOnly || frame.cameraVisible === undefined
            ? {}
            : { cameraVisible: frame.cameraVisible }),
          telemetryCandidateCount: scene.lodCandidateCount,
          telemetrySubmit: {
            frameId: scene.lodFrameId,
            deviceGeneration: internals.deviceScope.generation,
          },
          frameTime: cameraFrameTime(attempt),
          deviceGeneration: internals.deviceScope.generation,
          ...(surfaceDynamicInputFrame === undefined
            ? {}
            : { surfaceDynamicInput: surfaceDynamicInputFrame }),
          ...(attempt.opts.geometryLane === undefined
            ? {}
            : { geometryLane: attempt.opts.geometryLane }),
        },
        attempt.composition.leases,
        features.candidate,
        pointsLinesOwner,
        cubeCaptureFrameInput(attempt, scene, features, probeCaptureScene),
        environment?.environmentSignature ?? '',
        environment?.fogSignature ?? '',
        frame.environmentReady && environment !== undefined,
        persistentRenderScene.transmissionTopologyDemand(),
        captureOnly ? undefined : frame.volumetricFog,
        attempt.timingCapture,
        scene.shadowCasterProjection,
        scene.visibility.worldKeys,
        undefined,
        scene.ssrDependencies,
        draws.markPresentedRenderable,
        environment?.fog,
        attempt.opts.sampleTimeSeconds,
        attempt.opts.temporalReset === true,
        captureOnly ? undefined : frame.cloudLayer,
        attempt.encoder,
        // extractFrames owns this fresh plain light record; features
        // receive view/cloud projections, never this mutable container.
        lights.cascadeCount,
        true,
      ),
      (action) => runProfiledRenderPhase(attempt.profileSession, 'record', action),
    );
    attempt.sceneSubmitted = attempt.submitted && frameState.frameOutputs.sceneSubmitted;
    dynamicGeometryFrames.commit(attempt.submitted);
    if (!attempt.submitted) surfaceSubmissionCandidate.abort();
    frameState.surfaceSubmissionObservation = undefined;
    if (!attempt.sceneSubmitted) discardStandardOutputStates(frameState);
    return {
      presentedDraws: draws.presentedDraws,
      drawObservation: draws.drawObservation,
      bloomAdmitted,
    };
  }

  /** Capture views share the display projection when any capture consumer exists. */
  function projectProbeCaptureScene(
    scene: RecordScene,
    features: RecordFeatures,
    orderedDispatch: DispatchList,
  ) {
    const projection = scene.shadowCasterProjection;
    if (
      projection === undefined ||
      (features.auxiliaryCameras.length === 0 &&
        features.sceneInputWork.length === 0 &&
        features.scheduledCaptureWork.length === 0 &&
        !scene.reflectionProbes.graph.work.some((work) => work.rawCaptureFace !== undefined))
    )
      return undefined;
    return projectCaptureScene(
      projection,
      scene.visibility.projection.renderables,
      orderedDispatch,
    );
  }

  function cubeCaptureFrameInput(
    attempt: RecordAttempt,
    scene: RecordScene,
    features: RecordFeatures,
    probeCaptureScene: ReturnType<typeof projectProbeCaptureScene>,
  ): CubeCaptureFrameInput {
    const shadowCasterProjection = scene.shadowCasterProjection;
    return {
      scheduledWork: features.scheduledCaptureWork,
      captureOnly: attempt.mode !== true,
      sceneInputs: features.sceneInputWork,
      auxiliaryCameras: features.auxiliaryCameras,
      state: cubeCaptureState,
      reflectionProbes: scene.reflectionProbes,
      ...(probeCaptureScene === undefined
        ? {}
        : {
            captureDispatch: probeCaptureScene.captureDispatch,
            ...(shadowCasterProjection === undefined
              ? {}
              : { subsurfaceDemand: shadowCasterProjection.content.subsurface.authorVisible }),
          }),
    };
  }

  function publishRecordOutcome(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
    scene: RecordScene,
    features: RecordFeatures,
    draws: RecordDraws,
  ): void {
    const presentation = scene.presentation;
    if (frameState.pipelinePreparationPending) {
      markFramePending(
        presentation,
        frameState.pipelinePreparationPendingReason ?? { code: 'pipeline-preparation' },
      );
    }
    const directionalShadowReady = directionalShadowSubmitted(frameState, internals, view.lights);
    // A successful queue submit is necessary but not sufficient for the
    // startup presentation fact. Reuse the same visible snapshots and
    // producer-owned GPU stores consumed by record so missing geometry,
    // material bindings, dynamic video frames, or requested shadow work
    // cannot dismiss the loading screen behind a clear/fallback pass.
    if (attempt.submitted && presentation.presentation === 'ready' && view.cameras.length > 0)
      verifySubmittedPresentation(attempt, frame, view, scene, draws, directionalShadowReady);
    recordDirectionalShadowOutcome(attempt, view.lights, directionalShadowReady);
    if (attempt.submitted) commitSubmittedFrame(attempt, frame, view, scene, features, draws);
    else discardUnsubmittedFrame(frameState, internals, view.cameras[0]);
    if (!attempt.submitted && frameState.environmentGeneration !== undefined) {
      environmentLifecycle.discard(frameState.environmentGeneration);
      frameState.environmentGeneration = undefined;
    }
    updateTransmissionInspection(scene.transmissionAntialias, attempt.sceneSubmitted);
    persistentRenderScene.setPointsLinesInspections(pointsLinesOwner.inspections());
  }

  function verifySubmittedPresentation(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
    scene: RecordScene,
    draws: RecordDraws,
    directionalShadowReady: boolean,
  ): void {
    const presentation = scene.presentation;
    const handles = [frame.skylight?.equirectHandle, frame.skybox?.equirectHandle];
    if (skyCubemapPending(handles, internals, resourceScope(attempt)))
      markFramePending(presentation, { code: 'sky-cubemap' });
    if (internals.getPipelineState() === null || frameState.compiledFrameGraph === null)
      markFramePending(presentation, { code: 'compiled-graph-unavailable' });
    const renderables = scene.visibility.presentationRenderables;
    const missing =
      presentation.presentation === 'pending'
        ? undefined
        : missingDrawEvidence(
            renderables,
            scene.visibility.worldKeys,
            draws.presentedDraws,
            preparedWorlds,
            internals,
          );
    if (missing !== undefined) markFramePending(presentation, missing);
    if (presentation.presentation === 'ready') {
      presentation.presentation = projectFramePresentation({
        renderables,
        preparedWorlds,
        internals,
        onPending: (reason) => {
          presentation.reason ??= reason;
        },
      });
    }
    verifySubmittedShadows(presentation, view.lights, directionalShadowReady);
  }

  function recordDirectionalShadowOutcome(
    attempt: RecordAttempt,
    lights: ExtractedLights,
    directionalShadowReady: boolean,
  ): void {
    if (attempt.sceneSubmitted && directionalShadowReady) {
      lastDirectionalShadowCandidate = 'accepted';
      return;
    }
    if (
      lights.directionalShadowQuality === undefined ||
      (attempt.submitted && !attempt.sceneSubmitted)
    )
      return;
    lastDirectionalShadowError = directionalShadowCandidateError(
      frameState,
      internals,
      lights,
      attempt.submitted,
    );
  }

  function commitSubmittedFrame(
    attempt: RecordAttempt,
    frame: ExtractedFrame,
    view: RecordView,
    scene: RecordScene,
    features: RecordFeatures,
    draws: RecordDraws,
  ): void {
    const { presentation, reason } = scene.presentation;
    const worldKeys = scene.visibility.worldKeys;
    if (presentation === 'ready')
      submittedTerrain = scene.terrainCandidate.filter((section) =>
        draws.presentedDraws.hasTerrain(
          worldEntityKey(worldKeys[section.worldId] ?? section.worldId, section.entity),
          section.section,
        ),
      );
    if (attempt.featureGraphAccepted) features.candidate?.onSubmitted?.();
    lastPresentation = presentation;
    lastPresentationPendingReason =
      presentation === 'pending' && reason !== undefined ? Object.freeze(reason) : undefined;
    materialDraws = draws.drawObservation.commit(presentation === 'ready');
    if (attempt.sceneSubmitted)
      recoveryOwner.setLastSuccessfulFrameSeed(recoveryFrameSeed(attempt, frame));
    submittedFrameCount += 1;
    lastSubmittedGeneration = internals.deviceScope?.generation;
    if (!attempt.sceneSubmitted) {
      persistentRenderScene.discardTemporalFrame();
      internals.getPipelineState()?.perPassResources.discardBloomResources?.();
      return;
    }
    const temporalCommit = persistentRenderScene.commitTemporalFrame(presentation === 'ready');
    if (!temporalCommit.ok) internals.errorRegistry.fire(temporalCommit.error);
    frameState.lastSuccessfulCameraAntialias = view.cameras[0]?.antialias;
    acceptSubmittedDepthOfField(frameState, internals, view.cameras[0]);
    commitSubmittedBloom(frameState, internals, draws.bloomAdmitted);
  }

  function recoveryFrameSeed(attempt: RecordAttempt, frame: ExtractedFrame) {
    const publication = attempt.publication;
    return {
      frame,
      worlds: attempt.scopes,
      ...(publication === undefined ? {} : { publishedFeatures: publication.packet.features }),
      cameraOwner: attempt.composition.owners.cameraOwner,
      resourceOwner: attempt.composition.owners.resourceOwner,
      width: Math.max(1, internals.canvas.width),
      height: Math.max(1, internals.canvas.height),
      frameTime: cameraFrameTime(attempt),
      ...(surfaceDynamicInputFrame === undefined
        ? {}
        : { surfaceDynamicInput: surfaceDynamicInputFrame }),
      ...(frameState.recoveryMaterialArtifacts === undefined
        ? {}
        : { materialArtifacts: frameState.recoveryMaterialArtifacts }),
      ...(frameState.recoveryShadowMaterialArtifacts === undefined
        ? {}
        : { shadowMaterialArtifacts: frameState.recoveryShadowMaterialArtifacts }),
    };
  }

  function reportRecordFailure(cause: unknown, submitted: boolean): void {
    discardStandardOutputStates(frameState);
    if (!submitted) {
      internals.getPipelineState()?.perPassResources.discardBloomResources?.();
    }
    if (cause instanceof ProjectedDecalInvalidError) throw cause;
    internals.errorRegistry.fire(recordFailureError(cause));
  }

  /** Task, temporal and Skin roots retire independently; every cause is reported together. */
  function retireRecordAttempt(
    attempt: RecordAttempt,
    recordFailure: unknown,
    ownsProfileFrame: boolean,
  ): void {
    const failures = skinTasks.complete(attempt.sceneSubmitted);
    try {
      if (!attempt.submitted) persistentRenderScene.discardTemporalFrame();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      if (recordFailure !== undefined) failures.unshift(recordFailure);
      internals.errorRegistry.fire(recordRetirementError(failures));
    }
    if (!ownsProfileFrame) return;
    try {
      attempt.profileSession?.endFrame();
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  return {
    get featureGpuWork() {
      return featureGpuWork;
    },
    setSurfaceDynamicInput(frame: SurfaceDynamicInputFrame | undefined): void {
      surfaceDynamicInputFrame = frame;
    },
    initializeSsr: ensureSsrFormatProbe,
    get instanceCollectionsInspection(): readonly InstanceCollectionInspection[] {
      return instanceCollections._inspections(frameState.frameNumber - 1);
    },
    releaseProfilerCatalog(): void {
      releaseProfilerCatalog?.();
      releaseProfilerCatalog = undefined;
    },
    bounds(world, entity) {
      return persistentRenderScene.bounds(world, entity);
    },
    get renderScene(): RenderSceneInspection {
      const submission = surfaceSubmissionObservation.inspect();
      return {
        ...persistentRenderScene.inspect(),
        gpuDriven: gpuDrivenProduction.inspect(skinTasks.paletteUploadBytes),
        frameCaches: {
          materialUniforms: {
            ...(frameState.materialUboCounters ?? {
              packHits: 0,
              packMisses: 0,
              uploadRanges: 0,
              uploadedLogicalBytes: 0,
              skippedUploads: 0,
            }),
          },
          ...(internals.getMaterialPipelineRequestInspection === undefined
            ? {}
            : { materialPipelineRequests: internals.getMaterialPipelineRequestInspection() }),
          visibilityProjection: persistentRenderScene.visibilityProjectionCacheInspection(),
          temporalSnapshots: persistentRenderScene.temporalSnapshotCacheInspection(),
          transparentSort: transparentSort.inspect(),
          renderBundles: { ...(frameState.renderBundleCounters ?? { hits: 0, misses: 0 }) },
        },
        ...(submission === undefined ? {} : { submission }),
      };
    },
    get gpuDrivenInspection(): GpuDrivenProductionInspection {
      return gpuDrivenProduction.inspect(skinTasks.paletteUploadBytes);
    },
    get reflectionProbes(): ReflectionProbeInspection {
      return reflectionProbeOwner.inspect();
    },
    get ssrDependencies(): SsrDependenciesInspection {
      return resolveSsrDependencies(frameState.ssrRequested === true);
    },
    get ssr(): SsrSpatialInspection {
      const camera = latestCamera;
      const lane =
        (frameState.cameraStandardProfile ?? internals.standardProfile)?.renderPath === 'deferred'
          ? 'deferred'
          : 'forward';
      const admission: SsrSpatialAdmission =
        frameState.ssrSpatialAdmission ??
        Object.freeze({
          status: camera?.screenSpaceReflection === undefined ? 'not-requested' : 'requested',
          lane,
          config: camera?.screenSpaceReflection,
          viewRange: camera === undefined ? 0 : camera.far - camera.near,
          work: zeroSsrAdmissionWork(),
        });
      const admitted = admission.status === 'admitted';
      const status =
        admitted &&
        (internals.ssrShaders === undefined || internals.depthPyramidShaders === undefined)
          ? ('structural-only' as const)
          : admission.status;
      const graph = frameState.compiledFrameGraph?.graph.inspect();
      const passRoster =
        admitted && graph !== undefined
          ? graph.passes
              .filter(
                (pass) => pass.name.startsWith('ssr-') || pass.name.startsWith('depth-pyramid-'),
              )
              .map((pass) => pass.name)
          : [];
      const history = frameState.ssrHistoryOwner?.inspect();
      const dependencies = resolveSsrDependencies(frameState.ssrRequested === true);
      const fallbackSource = dependencies.reflectionFallback?.source;
      return projectSsrSpatialInspection(admission, {
        status,
        ...(history === undefined
          ? {}
          : {
              history: {
                state: history.state,
                bytes: history.activeBytes + history.candidateBytes + history.retiringBytes,
                resetCount: history.resetCount,
              },
            }),
        passRoster,
        ...(fallbackSource === undefined ? {} : { fallbackSource }),
      });
    },
    get reflectionFallbackCompletion(): Promise<void> | undefined {
      return frameState.reflectionFallbackCompletion;
    },
    get presentation(): FramePresentation {
      return lastPresentation;
    },
    get presentationPendingReason() {
      return lastPresentationPendingReason;
    },
    isCubeCapturePending(target: RenderTarget): boolean {
      return internals.rendererCaptureOwner?.isPending(target) ?? false;
    },
    get environment(): EnvironmentInspection {
      return environmentLifecycle.inspect();
    },
    get autoExposure(): AutoExposureInspection | undefined {
      const camera = latestCamera;
      const state = frameState.autoExposureState;
      if (camera?.output?.exposure.kind !== 'auto' || state === undefined) return undefined;
      const actual = state.acceptedEv > 0 ? state.acceptedEv : null;
      return createAutoExposureInspection({
        requested: camera.output.exposure,
        actual,
        actualState:
          actual === null ? (state.receipt.committed ? 'gpu-resident' : 'fallback') : 'accepted',
        fallback: state.fallback,
        lastKnownGood: state.lastKnownGood,
        targetGeneration: state.targetGeneration,
        reset: state.reset,
        cost: { histogramBytes: AUTO_EXPOSURE_HISTOGRAM_BYTES, passCount: 3, physicalPassCount: 1 },
        receipt: state.receipt,
      });
    },
    get standardLut(): StandardLutState {
      return inspectStandardLutState(frameState.standardLutState);
    },
    get probePlacement() {
      return internals.standardProfile?.probePlacement === undefined
        ? undefined
        : frameState.probePlacement?.inspect();
    },
    get diffuseGi() {
      const gather = internals.standardProfile?.diffuseGi?.gather;
      if (gather === 'exact') return frameState.rayDiffuse?.inspect();
      if (gather === 'irradiance-field') return frameState.irradianceField?.inspect();
      if (gather === 'screen-probe')
        return frameState.screenProbe?.inspect(frameState.irradianceField?.inspect());
      if (gather === 'baked') return frameState.bakedField?.inspect();
      return undefined;
    },
    get dynamicResolution() {
      return frameState.dynamicResolution?.inspect();
    },
    get temporal(): TemporalInspection {
      return inspectTemporal(frameState.lastSuccessfulTemporalView, undefined, {
        ...(frameState.activeTemporalGpuState === undefined
          ? {}
          : { active: frameState.activeTemporalGpuState }),
        ...(frameState.temporalGpuState === undefined
          ? {}
          : { candidate: frameState.temporalGpuState }),
        retiring: [...frameState.retiringTemporalGpuStates],
        deviceGeneration: internals.deviceScope.generation,
      });
    },
    get motionBlurInspection(): MotionBlurInspection | undefined {
      return projectMotionBlurInspection({
        camera: latestCamera,
        invalidParams: lastMotionBlurInvalidParams,
        capabilities: internals.device.caps,
        acceptedTemporal: frameState.lastSuccessfulTemporalView,
        transaction: frameState.temporalFrameTransaction.inspect(),
        execution: frameState.motionBlurExecution,
        temporalFrameId: frameState.temporalFrame?.frameId,
        deviceGeneration: internals.deviceScope.generation,
        graphGeneration: frameState.graphGeneration,
      });
    },
    get motionBlurInvalidParams(): MotionBlurValidationError | undefined {
      return lastMotionBlurInvalidParams;
    },
    get depthOfFieldInspection(): DepthOfFieldInspection | undefined {
      const camera = latestCamera;
      if (camera === undefined) return undefined;
      const graph = frameState.compiledFrameGraph?.graph.inspect();
      return projectDepthOfFieldInspection({
        ...(camera.depthOfField === undefined ? {} : { params: camera.depthOfField }),
        ...(camera.depthOfFieldError === undefined ? {} : { error: camera.depthOfFieldError }),
        ...(graph === undefined ? {} : { graph }),
        // The explicit property keeps the inspector on the submit-bound
        // transaction path even before the first accepted frame. A missing
        // property remains supported for direct structural callers/tests.
        accepted: frameState.depthOfFieldAccepted,
        ...(frameState.depthOfFieldLastSubmitFailed === true ? { lastSubmitFailed: true } : {}),
        // Inspection can be queried while the renderer is being assembled,
        // before a device scope has been published. Keep that observation
        // bounded instead of turning a not-yet-ready renderer into a getter
        // exception.
        deviceGeneration: internals.deviceScope?.generation ?? 0,
      });
    },
    get temporalTargetInspection(): TemporalTargetInspection | undefined {
      const graph = frameState.compiledFrameGraph?.graph.inspect();
      if (graph === undefined) return undefined;
      const producer = graph.passes.find((pass) => pass.name === 'standard-scene-data');
      // The producer's semantic target is the graph-owned
      // `standard-scene-temporal` resource. Resolve it from the compiled
      // resource table rather than the pass access projection: a backend may
      // retain a view alias in the access list while the resource owner still
      // carries the canonical semantic label.
      const target = graph.resources.find(
        (resource) => resource.kind === 'texture' && resource.label === 'standard-scene-temporal',
      );
      if (producer === undefined || target === undefined) {
        return undefined;
      }
      const descriptor = target.descriptor.kind === 'texture' ? target.descriptor : undefined;
      const width = descriptor?.width ?? Math.max(1, internals.canvas.width);
      const height = descriptor?.height ?? Math.max(1, internals.canvas.height);
      return Object.freeze({
        identity: 'standard-scene-temporal',
        producerId: 'forgeax::standard::scene-data',
        schema: 'forgeax::scene-data::temporal-v1',
        targetCount: 1,
        descriptor: Object.freeze({
          format: 'rgba16float',
          width,
          height,
          sampleCount: 1,
          bytes: width * height * 8,
        }),
      });
    },
    get materialDraws() {
      return materialDraws;
    },
    get lodOcclusionInspection(): LodOcclusionInspection | undefined {
      return lastLodOcclusionInspection;
    },
    get bloom(): BloomInspection {
      const pipelineState = internals.getPipelineState();
      const resources = pipelineState?.perPassResources;
      const lifecycle = resources?.inspectBloomResources?.(
        frameState.compiledFrameGraph?.graph.inspect(),
      );
      return Object.freeze(lifecycle ?? emptyBloomInspection());
    },
    get transmission(): TransmissionInspection | undefined {
      return lastTransmissionInspection;
    },
    captureShadowWorkload: (frameId) =>
      frameState.shadowRaster.captureWorkload(
        frameId,
        gpuDrivenProduction.inspect(skinTasks.paletteUploadBytes).shadowViews,
      ),
    get shadowRaster(): ShadowRasterInspection {
      return frameState.shadowRaster.inspect();
    },
    get directionalShadow(): DirectionalShadowInspection {
      const lights = lastDirectionalShadowLights;
      const pipelineState = internals.getPipelineState();
      const graph = frameState.compiledFrameGraph?.graph.inspect();
      const requested = directionalShadowProfileFromQuality(lights?.directionalShadowQuality);
      const mapSize = pipelineState?.perPassResources.shadowMapSize ?? 0;
      const cascadeCount = lights?.cascadeCount ?? 0;
      const shadowReady = frameState.frameOutputs.directionalShadowView !== null;
      const shadowMapBytes = shadowReady
        ? (frameState.shadowDepthLayers?.byteSize('directional-shadow-depth') ?? 0)
        : 0;
      return projectDirectionalShadowInspectionSource({
        requested,
        candidate: lastDirectionalShadowCandidate,
        ...(frameState.directionalShadowCache === null
          ? {}
          : {
              lastKnownGood: directionalShadowProfileFromQuality(
                frameState.directionalShadowCache.directionalShadowQuality,
              ),
            }),
        cascadeCount,
        mapSize,
        shadowMapBytes,
        writerPasses:
          graph?.passes.filter((pass) => pass.name.startsWith('shadowCascade')).length ?? 0,
        shadowAngularRadius: lights?.directionalCsmConfig?.shadowAngularRadius,
        maxPenumbraTexels: lights?.directionalCsmConfig?.maxPenumbraTexels,
        deviceGeneration: internals.deviceScope.generation,
        graphGeneration:
          frameState.compiledFrameGraph?.targets.graphGeneration ?? frameState.graphGeneration,
        shadowReady,
        ...(lastDirectionalShadowError === undefined ? {} : { error: lastDirectionalShadowError }),
      });
    },
    get standardLightingInspection(): StandardLightingInspection | undefined {
      const inspection = frameState.submittedInspection?.standardLighting;
      return inspection === undefined ? undefined : Object.freeze({ ...inspection });
    },
    get capsuleShadowInspection(): CapsuleShadowInspection | undefined {
      return frameState.submittedInspection?.capsuleShadow;
    },
    get transparencyInspection() {
      return frameState.submittedInspection?.transparency;
    },
    get pointShadowInspection(): PointShadowInspection | undefined {
      const inspection = frameState.submittedInspection?.pointShadow;
      return inspection === undefined ? undefined : Object.freeze({ ...inspection });
    },
    get pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
      return persistentRenderScene.pointsLinesSnapshots();
    },
    detachScene(world: World): void {
      frameState.dynamicResolution?.reset();
      persistentRenderScene.detach(world);
      internals.featureSceneInputs?.detach(worldRenderResources(world));
    },
    copyBuiltinPostProcessesTo(target) {
      for (const [id, entry] of postProcessOwner.builtinEntries)
        target.registerBuiltinPostProcess(id, entry);
    },
    copyConfigurationTo(target) {
      this.copyBuiltinPostProcessesTo(target);
      target.configureStandard(configuredPipelineConfig);
      const receipt = ssrFormatReceipts.get(internals.device);
      if (receipt !== undefined) target.adoptSsrFormatReceipt(internals.device, receipt);
    },
    adoptSsrFormatReceipt(device, receipt) {
      ssrFormatReceipts.set(device, receipt);
    },
    draw(...args) {
      return drainFramePreparation(this.prepareSubmission(...args));
    },
    publicationBaselineRequired(input) {
      return persistentRenderScene.publicationBaselineRequired(input.resources);
    },
    *prepareSubmission(worlds, opts, leases, timing, publication, isCurrent) {
      return yield* prepareFrameSubmission(
        [this.record(worlds, opts, leases, timing, publication)],
        undefined,
        internals,
        isCurrent,
      );
    },
    *record(
      worlds: readonly World[],
      opts: DrawOwnerOptions,
      renderReadLeases?: readonly RenderReadLease[],
      timingCapture?: GpuTimingCapture,
      publication?: PreparedRenderPublication,
      encoder?: RhiCommandEncoder,
      mode: boolean | 'capture' = true,
    ): FrameRecording {
      skinTasks.beginRecording();
      const composition = canonicalizeWorldComposition(worlds, opts, renderReadLeases);
      const scopes: readonly RenderResourceScope[] =
        publication === undefined
          ? composition.worlds.map(worldRenderResources)
          : [publication.resources];
      preparedWorlds = scopes;
      const attempt: RecordAttempt = {
        composition,
        scopes,
        opts,
        publication,
        timingCapture,
        mode,
        profileSession: internals.profiler?.activeSession(),
        encoder,
        submitted: false,
        sceneSubmitted: false,
        featureGraphAccepted: false,
      };
      beginGeometryObservation(attempt);
      const ownsProfileFrame = beginRecordAttempt(attempt);
      let recordFailure: unknown;
      let result = false;
      try {
        result = yield* recordAttemptFrame(attempt);
      } catch (cause) {
        recordFailure = cause;
        reportRecordFailure(cause, attempt.submitted);
        result = attempt.submitted;
      } finally {
        retireRecordAttempt(attempt, recordFailure, ownsProfileFrame);
      }
      return result;
    },
    prepareCandidatePipelines(input, signal) {
      frameState.candidatePipelinePreparations ??= new CandidatePipelinePreparationOwner(
        () => frameState.compiledFrameGraph,
      );
      return frameState.candidatePipelinePreparations.prepare(input, signal);
    },
    get submittedTerrain() {
      return submittedTerrain;
    },
    isDynamicGeometryConsumed: (world, entity, meshHandle) =>
      dynamicGeometryFrames.isConsumed(world, entity, meshHandle),
    dynamicGeometryRecordStageLane: (world, entity, meshHandle) =>
      dynamicGeometryFrames.recordStageLane(world, entity, meshHandle),
    pipelineDispatchCounts: dispatchCounts,
    observeGeometry(receipt: { frameId: number; deviceGeneration: number }) {
      return gpuDrivenProduction.observeGeometry(receipt);
    },
    observeCurrentFrame(options: FrameObservationOptions) {
      const currentFrameId = frameState.frameNumber - 1;
      return observeCurrentFrame(
        options,
        frameState.frameOutputs.observationSource,
        currentFrameId,
      );
    },
    async observeLodOcclusion(receipt?: {
      readonly frameId: number;
      readonly deviceGeneration: number;
    }): Promise<LodOcclusionInspection | undefined> {
      const capturedInspection = lastLodOcclusionInspection;
      const capturedWorldAttachments = lastLodWorldAttachments;
      if (capturedInspection === undefined) return undefined;
      if (
        receipt !== undefined &&
        (capturedInspection.submit.frameId !== receipt.frameId ||
          capturedInspection.submit.deviceGeneration !== receipt.deviceGeneration)
      )
        return undefined;
      const selection = await gpuDrivenProduction.readLodSelection();
      if (
        lastLodOcclusionInspection !== capturedInspection ||
        lastLodWorldAttachments !== capturedWorldAttachments ||
        selection === undefined
      )
        return undefined;
      if (
        selection.submit !== undefined &&
        (selection.submit.frameId !== capturedInspection.submit.frameId ||
          selection.submit.deviceGeneration !== capturedInspection.submit.deviceGeneration)
      )
        return undefined;
      if (
        receipt !== undefined &&
        (selection.submit === undefined ||
          selection.submit.frameId !== receipt.frameId ||
          selection.submit.deviceGeneration !== receipt.deviceGeneration)
      )
        return undefined;
      const inspection = applyLodSelectionTelemetry(
        selection,
        capturedInspection,
        capturedWorldAttachments,
      );
      if (
        inspection === undefined ||
        lastLodOcclusionInspection !== inspection ||
        inspection.submit.frameId !== capturedInspection.submit.frameId ||
        inspection.submit.deviceGeneration !== capturedInspection.submit.deviceGeneration ||
        inspection.view.cameraEntity !== capturedInspection.view.cameraEntity ||
        inspection.view.viewGeneration !== capturedInspection.view.viewGeneration ||
        inspection.view.attachmentId !== capturedInspection.view.attachmentId
      )
        return undefined;
      if (
        selection.surfaceReadback !== undefined &&
        selection.surfaceActualMemberIds !== undefined &&
        selection.surfaceIndirectParameters !== undefined
      ) {
        surfaceSubmissionObservation.publishGpuMembers(
          {
            recording: selection.surfaceReadback,
            memberIds: selection.surfaceActualMemberIds,
            indirectParameters: selection.surfaceIndirectParameters,
          },
          receipt ?? capturedInspection.submit,
        );
      }
      return inspection;
    },
    getCurrentGraphTarget(name: string) {
      const graph = frameState.compiledFrameGraph?.targets;
      if (graph === undefined) return undefined;
      const descriptor = graph.getColorTargetDescriptor(name);
      const texture = graph.getColorTargetTexture(name);
      if (descriptor === undefined || texture === undefined) return undefined;
      return {
        name,
        texture,
        textureIdentity: getTextureIdentity(texture),
        descriptor,
        frameId: frameState.frameNumber - 1,
        graphGeneration: graph.graphGeneration,
      };
    },
    requestGraphTargetCapture(request: GraphTargetCaptureRequest) {
      frameState.graphTargetCapture = request;
    },
    bindGroupCounts: bindGroupCounts,
    get temporalFrame(): TemporalFrame | undefined {
      const accepted = frameState.temporalFrame;
      if (accepted === undefined) return undefined;
      return {
        ...accepted,
        currentViewProjection: new Float32Array(accepted.currentViewProjection),
        previousViewProjection:
          accepted.previousViewProjection === undefined
            ? undefined
            : new Float32Array(accepted.previousViewProjection),
        jitter: [accepted.jitter[0], accepted.jitter[1]],
        viewport: { ...accepted.viewport },
      };
    },
    frustumStats: lastFrustumStats,
    visibilityStats: lastVisibilityStats,
    get meshMaterialBindings(): readonly MeshMaterialBindingObservation[] {
      const observeResidency = createMaterialResidencyObserver(internals);
      return (lastMeshMaterialBindingRenderables ?? []).map((renderable) => {
        const materialWorld = lastMeshMaterialBindingWorlds[renderable.worldId];
        const snapshotOf = (material: import('./material-resource').MaterialResource) => {
          const snapshot = lastMeshMaterialBindingMaterials?.get(material)?.snapshot;
          if (snapshot === undefined)
            throw new Error('Inspected draw has no accepted material version');
          return snapshot;
        };
        return projectMeshMaterialBindingObservation({
          worldId: renderable.worldId,
          ...(materialWorld === undefined ? {} : { worldIdentity: materialWorld.identity }),
          entityKey: renderable.entityKey,
          bindings: renderable.materials.map((material, slotIndex) => ({
            handle: snapshotOf(material).materialHandle ?? 0,
            source: renderable.materialBindingSources[slotIndex] ?? 'engine-default',
          })),
          diagnostics: renderable.materialBindingDiagnostics ?? [],
          residency: renderable.materials.map((material) =>
            observeResidency(materialWorld, snapshotOf(material)),
          ),
        });
      });
    },
    get iblBinding(): import('./mesh-material-bindings').IblBindingInspection | undefined {
      return frameState.iblBindingInspection;
    },
    get perFramePassNames(): readonly string[] {
      return frameState.compiledFrameGraph?.graph.inspect().passes.map((pass) => pass.name) ?? [];
    },
    get lastSuccessfulCameraAntialias(): CameraSnapshot['antialias'] | undefined {
      return frameState.lastSuccessfulCameraAntialias;
    },
    get lastSuccessfulBarrelDistortion(): BarrelDistortionMapping | undefined {
      return frameState.lastSuccessfulBarrelDistortion;
    },
    get barrelDistortionInspection(): BarrelDistortionInspection {
      return inspectBarrelDistortionState(frameState, internals.deviceScope?.generation ?? 0);
    },
    get perFrameGraphInfo(): CompiledRenderGraphInfo | undefined {
      return frameState.compiledFrameGraph?.graph.inspect();
    },
    get perFrameGraphIncarnation(): object | undefined {
      return frameState.compiledFrameGraph?.graph;
    },
    get renderGraphGenerationAllocation() {
      return inspectRenderGraphGenerationAllocation(frameState);
    },
    get featureGraphInspection(): import('./inspection-types').RenderFeatureGraphInspection {
      return getRenderFeatureGraphInspection(internals);
    },
    get materialTextureSources(): MaterialTextureSourceInspection {
      return lastMaterialTextureSources;
    },
    get recoveryEvidence(): RecoveryProductionEvidence {
      const graph = frameState.compiledFrameGraph?.graph.inspect();
      return Object.freeze({
        producerRoots: createRendererProducerRootMatrix(),
        graph: Object.freeze({
          ready: graph !== undefined,
          generation: frameState.graphGeneration,
          passCount: graph?.passes.length ?? 0,
          resourceCount: graph?.resources.length ?? 0,
        }),
        residency: Object.freeze({
          meshResidencyEpoch: internals.gpuStore.meshResidencyEpoch,
        }),
        submissions: Object.freeze({
          count: submittedFrameCount,
          lastGeneration: lastSubmittedGeneration,
        }),
      });
    },
    get volumetricFog(): import('./volume/inspection').VolumetricFogInspection {
      const accepted = frameState.volumetricFogAccepted;
      return {
        ...frameState.volumetricFogInspection,
        ownerCount: accepted === undefined ? 0 : 1 + (accepted.additional?.length ?? 0),
      };
    },
    configureStandard(config: RenderPipelineAsset['config']): void {
      const profileConfig = internals.standardProfile;
      if (profileConfig?.probePlacement === undefined) frameState.probePlacement?.disable();
      const resolvedConfig =
        profileConfig === undefined
          ? config
          : {
              clusterGrid: DEFAULT_CLUSTER_GRID,
              ssao: {
                enabled: profileConfig.ssao !== false,
                ...(typeof profileConfig.ssao === 'object' ? profileConfig.ssao : {}),
              },
              ...(profileConfig.gpuOcclusion === undefined
                ? {}
                : { gpuOcclusion: profileConfig.gpuOcclusion }),
              ...config,
            };
      if (resolvedConfig?.clusterGrid !== undefined) {
        const grid = resolvedConfig.clusterGrid;
        const gridResult = validateClusterGrid(grid);
        if (!gridResult.ok) {
          throw gridResult.error;
        }
      }
      if (resolvedConfig?.ssao?.enabled === true) {
        const ssaoResult = resolveSsaoParameters(resolvedConfig.ssao);
        if (!ssaoResult.ok) {
          throw ssaoResult.error;
        }
      }
      // Standard configuration no longer carries a handle (D-19: RenderPipelineAsset is
      // supplied as a POD at boot/swap time before a World exists). The
      // brand-number that `draw` compares to force a per-frame graph rebuild is
      // now a monotonic epoch bumped on every install -- distinct configs (and
      // even identical re-installs) trigger the rebuild, which is correct: install
      // is a rare boot/swap event, never a per-frame cost.
      installEpoch += 1;
      frameState.installedPipelineHandle = installEpoch;
      configuredPipelineConfig = resolvedConfig;
      frameState.installedPipelineConfig = resolvedConfig;
      frameState.cameraStandardProfile = undefined;
      cameraStandardSignature = JSON.stringify([profileConfig?.renderPath, resolvedConfig?.ssao]);
    },
    registerBuiltinPostProcess: postProcessOwner.registerBuiltinPostProcess,
    lookupPostProcess,
    prepareRecoveryTextureData: recoveryOwner.prepareRecoveryTextureData,
    prepareRecoveryGraphCandidate: recoveryOwner.prepareRecoveryGraphCandidate,
    submitCandidateSetup: recoveryOwner.submitCandidateSetup,
    publishRecoveryGraphCandidate: recoveryOwner.publishRecoveryGraphCandidate,
    discardRecoveryGraphCandidate: recoveryOwner.discardRecoveryGraphCandidate,
    disposeFrameState(): void {
      let failure: unknown;
      try {
        lastMeshMaterialBindingRenderables = undefined;
        lastMeshMaterialBindingWorlds = [];
        lastMeshMaterialBindingMaterials = undefined;
        frameState.candidatePipelinePreparations?.dispose();
        if (ownsSceneInputs) internals.featureSceneInputs?.dispose();
        disposeTargetCaptures(cubeCaptureState);
        frameState.dynamicResolution?.reset();
        pointsLinesOwner.dispose();
        persistentRenderScene.dispose();
        terrainLayers.dispose();
        instanceCollections.dispose();
        gpuDrivenProduction.dispose();
        disposeFeatureGpuWork();
        reflectionProbeOwner.dispose();
        frameState.ssrHistoryOwner?.dispose();
        frameState.probePlacement?.dispose();
        frameState.probePlacement = undefined;
        frameState.probePlacementFrame = undefined;
        frameState.rayDiffuse?.dispose();
        frameState.rayDiffuse = undefined;
        frameState.irradianceField?.dispose();
        frameState.irradianceField = undefined;
        frameState.screenProbe?.dispose();
        frameState.screenProbe = undefined;
        frameState.bakedField?.dispose();
        frameState.bakedField = undefined;
        frameState.ssrHistoryOwner = undefined;
        frameState.ssrSpatialAdmission = undefined;
        // Bloom generations are renderer-owned rather than graph-owned. Drain
        // candidate, active, and fence-retiring bundles before the rest of the
        // frame state is torn down; the owner callback is idempotent so the
        // outer Renderer.dispose cascade can safely call this once only.
        internals.getPipelineState()?.perPassResources.drainBloomResources?.();
        internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
        invalidatePostProcessModule('forgeax.taa-resolve');
        // Post-process parameter UBOs are renderer-owned persistent resources,
        // rather than graph-owned transient state. Clear the active table before
        // the feature host is retired so the renderer remains the sole owner.
        postProcessOwner.dispose();
        resetSsaoResources(internals);
        resetHdrpBuffers(internals);
        // Retire graph-owned resources and dispose instance-buffer caches.
        frameState.renderBundleCaches?.passes.clear();
        // Both calls are idempotent + tolerate per-handle errors silently;
        // the Renderer.dispose() cascade owns the surrounding try/catch
        // (D-3 method A: void signature, sub-errors fan out via
        // errorRegistry.fire at the cascade layer, dispose still walks all
        // 6 steps).
        frameState.directionalShadowCache?.meshReads.release();
        frameState.directionalShadowCache = null;
        frameState.directionalShadowLod = undefined;
        frameState.directionalShadowCacheRecorded = false;
        resetFrameRecordingOutputs(frameState.frameOutputs);
        frameState.lastSuccessfulCameraAntialias = undefined;
        frameState.lastSuccessfulBarrelDistortion = undefined;
        frameState.cloudHistoryActive = false;
        delete frameState.pendingCloudHistoryActive;
        disposeStandardOutput(frameState);
        releaseTemporalGpuStates(frameState);
        for (const buffer of frameState.volumetricFogParams.buffers) {
          if (buffer === null) continue;
          const destroyed = internals.device.destroyBuffer(buffer);
          if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
        }
        frameState.volumetricFogParams = emptyVolumetricFogParams();
        frameState.volumetricFogAccepted = undefined;
        frameState.volumetricFogAcceptedContext = undefined;
        frameState.volumetricFogHistoryGraph = null;
        frameState.volumetricFogHistorySlot = null;
        frameState.volumetricFogHistorySignature = null;
        frameState.hdrpClusterMembership = null;
        discardCompiledFrameGraphs(frameState);
        frameState.standardLightingGraphSignature = '';
        frameState.submittedInspection = undefined;
        submittedTerrain = [];
        frameState.depthOfFieldAccepted = undefined;
        frameState.depthOfFieldLastSubmitFailed = false;
        // feat-20260619 M4 (D-6): pass errorRegistry to disposeInstanceBuffers
        // so destroy failures fire structured errors (unified per-frame +
        // dispose error strategy).
        disposeInstanceBuffers(frameState.instanceBuffers, internals.errorRegistry);
        if (frameState.instanceBufferChunks !== undefined) {
          disposeInstanceBufferChunks(frameState.instanceBufferChunks, internals.errorRegistry);
        }
        disposeTransientInstanceBuffers(
          frameState.transientInstanceBuffers,
          internals.errorRegistry,
        );
        if (frameState.probeBlendRecordBuffer !== undefined) {
          if (!frameState.probeBlendRecordBuffer.isDestroyed) {
            const result = frameState.probeBlendRecordBuffer.destroy();
            if (!result.ok) internals.errorRegistry.fire(result.error);
          }
          delete frameState.probeBlendRecordBuffer;
        }
        frameState.probeBlendRecordBufferCapacity = 0;
        frameState.probeBlendBuffers.clear();
        delete frameState.probeBlendRecordProjection;
        if (frameState.morphBuffers !== undefined) {
          for (const entry of frameState.morphBuffers.values()) {
            if (!entry.buffer.isDestroyed) {
              const result = entry.buffer.destroy();
              if (!result.ok) internals.errorRegistry.fire(result.error);
            }
          }
          frameState.morphBuffers.clear();
        }
        // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-2: dispose the
        // cube_array shadow atlas owned by the RenderSystem closure. The atlas
        // is per-RenderSystem (= per Renderer) and is shared transparently
        // between URP and HDRP pipelines.
        // Idempotent: dispose() on a null / already-disposed atlas is a no-op.
        frameState.shadowDepthLayers?.dispose();
        frameState.shadowDepthLayers = undefined;
        if (frameState.pointShadowAtlas !== null) {
          frameState.pointShadowAtlas.dispose();
          frameState.pointShadowAtlas = null;
        }
      } catch (cause) {
        failure = cause;
      }
      try {
        skinTasks.dispose();
      } catch (cause) {
        if (failure === undefined) failure = cause;
        else
          failure = new AggregateError(
            [failure, cause],
            'Render state and Skin task disposal failed',
            { cause: failure },
          );
      }
      if (failure !== undefined) throw failure;
    },
    resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {
      frameState.shadowDepthLayers?.dispose();
      frameState.shadowDepthLayers = undefined;
      disposeTargetCaptures(cubeCaptureState);
      frameState.dynamicResolution?.reset();
      // The active expansion buffers belong to the lost generation. Abandon
      // their handles without invoking destroy on a device that can no longer
      // service cleanup; the staged candidate owns the replacement buffers.
      pointsLinesOwner.abandonForDeviceLoss();
      resetStandardOutputForDeviceLoss(frameState, internals.deviceScope.generation);
      ssrFormatReceipts.delete(internals.device);
      ssrFallbackGeneration = undefined;
      transmissionAdmission.markDeviceLost();
      lastTransmissionKey = '';
      transmissionCapabilities.delete(internals.device);
      // The replacement device cannot consume buffers minted by the lost
      // device.  Drop the shared Standard Cluster bundle before the next
      // frame asks for a new generation; resetHdrpBuffers fences the bundle
      // using its own device/queue instead of the replacement runtime device.
      resetSsaoResources(internals);
      resetHdrpBuffers(internals);
      // Keep the persistent material demand observable across device loss.
      // The physical resource has already been fenced by markDeviceLost(); the
      // detached inspection now exposes the rebuild-required lifecycle until a
      // completed frame admits the replacement resource.
      updateTransmissionInspection(lastTransmissionAntialias, false);
      persistentRenderScene.resetGpuForRecover();
      gpuDrivenProduction.dispose();
      gpuDrivenRecoveryCount += 1;
      gpuDrivenProduction = createGpuDrivenOwner(
        replacementDevice ?? internals.device,
        gpuDrivenShaderFactory,
        gpuDrivenRecoveryCount,
      );
      disposeFeatureGpuWork();
      featureGpuWork = createFeatureGpuWorkOwner(internals);
      reflectionProbeOwner.dispose();
      frameState.ssrHistoryOwner?.dispose();
      frameState.probePlacement?.dispose();
      frameState.probePlacement = undefined;
      frameState.probePlacementFrame = undefined;
      frameState.rayDiffuse?.dispose();
      frameState.rayDiffuse = undefined;
      frameState.irradianceField?.dispose();
      frameState.irradianceField = undefined;
      frameState.screenProbe?.dispose();
      frameState.screenProbe = undefined;
      frameState.bakedField?.dispose();
      frameState.bakedField = undefined;
      frameState.ssrHistoryOwner = undefined;
      frameState.ssrSpatialAdmission = undefined;
      frameState.ssrRequested = false;
      frameState.ssrLastCameraEntity = undefined;
      frameState.ssrLastHistoryVersion = undefined;
      // A recovered device cannot retain handles from the lost device. The
      // Bloom owner abandons candidates and retires every committed generation
      // before the new PipelineState is rebuilt.
      (
        retiringPipelineState ?? internals.getPipelineState()
      )?.perPassResources.drainBloomResources?.();
      // feat-20260622-s5 M3 / B-2 / w18: recover() rebuild drops device-bound
      // state minted by the lost device. The active graph and per-entity caches
      // must be discarded, not merely marked for destruction: their opaque
      // handles cannot be used on the fresh device and the next draw must
      // lazily build a new graph from the preserved ECS / asset POD caches.
      // Inspection and capture stay detached from graph-owned texture and
      // descriptor accessors until the replacement graph is accepted.
      discardCompiledFrameGraphs(frameState);
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      frameState.volumetricFogHistoryGraph = null;
      frameState.volumetricFogHistorySlot = null;
      frameState.volumetricFogHistorySignature = null;
      // The old device owns these transient params buffers. Discard their
      // handles without calling destroy() on the lost device; the next frame
      // must allocate fresh buffers on the replacement device.
      frameState.volumetricFogParams = emptyVolumetricFogParams();
      frameState.standardLightingGraphSignature = '';
      frameState.submittedInspection = undefined;
      submittedTerrain = [];
      frameState.depthOfFieldAccepted = undefined;
      frameState.depthOfFieldLastSubmitFailed = false;
      frameState.directionalShadowCache?.meshReads.release();
      frameState.directionalShadowCache = null;
      frameState.directionalShadowLod = undefined;
      frameState.directionalShadowCacheRecorded = false;
      resetFrameRecordingOutputs(frameState.frameOutputs);
      frameState.lastSuccessfulCameraAntialias = undefined;
      frameState.lastSuccessfulBarrelDistortion = undefined;
      frameState.cloudHistoryActive = false;
      delete frameState.pendingCloudHistoryActive;
      resetTemporalHistory(frameState, 'device-recovery');
      releaseTemporalGpuStates(frameState);
      frameState.hdrpClusterMembership = null;
      frameState.instanceBuffers.clear();
      frameState.instanceBufferChunks?.clear();
      instanceCollections._resetResidency();
      delete frameState.probeBlendRecordBuffer;
      frameState.probeBlendRecordBufferCapacity = 0;
      frameState.probeBlendBuffers.clear();
      delete frameState.probeBlendRecordProjection;
      frameState.morphBuffers?.clear();
      frameState.transientInstanceBuffers = [];
      frameState.pointShadowAtlas = null;
      // Bind groups retain opaque handles from the lost device. WeakMap roots
      // cannot be cleared, so replace them; the Map-backed caches can be
      // emptied in place. The next frame recreates every binding from the
      // rebuilt PipelineState and fresh residency handles.
      frameState.viewBindGroupCache = new WeakMap();
      frameState.meshBindGroupCache = new WeakMap();
      frameState.materialBgPerEntity.clear();
      frameState.instancesBgPerEntity.clear();
      frameState.materialBgShared.clear();
      frameState.materialBgAssemblyCache.clear();
      frameState.renderBundleCaches?.passes.clear();
      frameState.shadowMaterialBindGroups = new WeakMap();
      frameState.postProcessBgCache = new WeakMap();
      // Fullscreen PSOs are cached outside frameState because the normal
      // path reuses them across frames. They still carry opaque handles from
      // the lost device, so recovery must invalidate this cache alongside the
      // feature-host declarations and UBOs below.
      postProcessPipelineCache.clear();
      // Logical declarations and the active params bundle stay live until the
      // candidate post-process bundle crosses the publication boundary.
      resetRenderFeatureGraphState(internals);
    },
    prepareRecoveryPostProcessResources(device: RhiDevice) {
      return postProcessOwner.prepareRecovery(device);
    },
    publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      postProcessOwner.publishRecovery(candidate);
    },
    discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      postProcessOwner.discardRecovery(candidate);
    },
    restorePostProcessResources(): void {
      const prepared = postProcessOwner.prepareRecovery(internals.device);
      if (!prepared.ok) throw prepared.error;
      postProcessOwner.publishRecovery(prepared.value);
    },
    prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle {
      return prepareRenderSystemRecoveryRoots(runtime, environmentLifecycle, frameState, (next) => {
        environmentLifecycle = next;
      });
    },
  };
}

/** Resolve the build identity used by every inspection submit. */
export function resolveInspectionBuild(internals: Pick<RenderSystemInternals, 'build'>): string {
  return internals.build ?? 'render-system';
}
