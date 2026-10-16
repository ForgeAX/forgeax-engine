import { mat4 } from '@forgeax/engine-math';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import {
  type FrameRecording,
  profileFrameRecording,
  submitFrameRecordings,
} from './assembly/frame-recording';
import type { CapsuleShadowInspection } from './capsule-shadow/inspection';
import { projectCaptureScene } from './capture/scene-projection';
import { releaseAtmosphere } from './environment/storage';
import { renderMaterialContext } from './extract/material-context';
import { RenderPublicationError, type RenderPublicationIdentity } from './publication/contract';
import { preparePublicationGeometry } from './publication/prepare-geometry';
import type { PreparedRenderPublication } from './publication/receiver';
import { type RenderResourceScope, renderTime } from './publication/resource-scope';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import { MaterialBgAssemblyCache } from './record/material-bg-assembly-cache';
import {
  disposeTargetCaptureLighting,
  disposeTargetCaptures,
} from './record/target-capture-lighting';
import {
  cameraForView,
  computeDirectionalCsm,
  projectAuxiliaryCamerasForView,
} from './render-system-extract';
import type { RenderSceneBounds } from './scene/render-scene-types';
import { captureSubmittedTerrain, type SubmittedTerrainSection } from './terrain/submitted.js';
// @forgeax/engine-math is referenced through render-system-record.ts which builds
// view/proj matrices and worldFromLocal via `mat4.compose / .multiply /
// .invert` (charter proposition 5: no math reinvention; render-system.test.ts
// asserts `/@forgeax\/engine-math/` shows up in render-system.ts source).

import { numMipLevels, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RenderPipeline,
  RhiDevice,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { ShaderError } from '@forgeax/engine-shader';
import { type RenderPipelineAsset, toShared } from '@forgeax/engine-types';
import {
  type DirectionalShadowInspectionSource,
  directionalShadowProfileFromQuality,
  projectDirectionalShadowInspectionSource,
} from './assembly/directional-shadow-inspection';
import { createFeatureSceneInputs } from './assembly/feature-scene-inputs';
import { createGpuDrivenOwner } from './assembly/gpu-driven-owner';
import { createPostProcessParamsOwner } from './assembly/post-process-params';
import { standardBloomAdmitted } from './bloom-admission';
import { createCloudFeatureFrameContext, createCloudFeatureView } from './cloud/frame-context';
import { createClusterBinScratch } from './cluster-binner';
import { ProjectedDecalInvalidError } from './decals/component';
import type { DynamicGeometryRecordStageLane } from './dynamic-geometry';
import { EnvironmentLifecycle } from './environment/lifecycle';
import {
  type ObservationUnavailableError,
  TransmissionCapabilityMissingError,
} from './errors/render';
import { projectDepthOfFieldInspection } from './features/depth-of-field/depth-of-field-inspection';
import { resolveDepthOfFieldFrameParams } from './features/depth-of-field/depth-of-field-params';
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
import { resolveStandardRenderFeatureTargets } from './features/targets';
import { renderFeatureViewIdentity } from './features/view';
import {
  buildFullscreenPostProcessPass,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from './fullscreen-post-process-pass';
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
import { createRenderSystemRecovery } from './recovery/render-system-candidate';

export { materialTextureHandlesForResidency } from './recovery/render-system-candidate';

import { createDynamicGeometryFrameBindings } from './record/dynamic-geometry-consumption';
import type {
  RecoveryGraphCandidate,
  RecoveryGraphCandidatePreparation,
  RecoveryGraphCandidateRuntime,
  RecoveryGraphSetupSubmission,
  RecoveryPostProcessResources,
  RecoveryRootBundle,
  RecoveryRootRuntime,
} from './recovery/types';

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
import { ShadowCasterOwnershipRebase } from './gpu-driven/shadow-ownership';
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
import { PipelineSpecError } from './pipeline-spec';
import type { PointShadowInspection } from './point-shadow-inspection';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolver,
} from './prepare/prepared-graphics-resolver';
import { inspectBarrelDistortionState } from './record/barrel-distortion-frame';
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
import type { GpuPassTimingReason } from './record/gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './record/gpu-pass-timing/session';
import type { GpuTimingCapture } from './record/gpu-timing';
import { resolveMaterialSkylight } from './record/main-pass-material';
import {
  createPreparedResolverCaches,
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
  RENDER_PHASE_CATALOG,
  type RenderPhase,
  type RenderPhaseSkipReason,
  type RenderRecordPhase,
} from './render-contract';
import type { ExtractedLights, RenderableSnapshot } from './render-system-extract';
import { extractFrames } from './render-system-extract-tail';
import {
  createPresentationDraws,
  projectDisplayRenderables,
  projectFramePresentation,
} from './render-system-presentation';
import {
  createRendererProducerRootMatrix,
  type RendererProducerRoot,
} from './render-system-producer-roots';
import {
  canonicalizeWorldComposition,
  createLodWorldInspections,
} from './render-system-projections';
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
  gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
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
  SurfaceBackendKind,
  SurfaceCapabilityFacts,
  SurfaceProfile,
  SwapChainFormatPair,
} from './record/render-context';
export {
  configureSurface,
  MATERIAL_PER_ENTITY_STRIDE,
  resolveSurfaceFormatPair,
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
export interface RecoveryProductionEvidence {
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
  const cubeCaptureState: CubeCaptureGraphState = { work: [] };
  const shadowOwnershipRebase = new ShadowCasterOwnershipRebase();
  const persistentRenderScene = new PersistentRenderScene({
    shaderRegistry: internals.assets.shaderRegistry,
    getTemporalConsumerDemand: () => internals.standardProfile?.visibleSurface === true,
    getDevice: () => internals.device,
    onGpuError: (error) => internals.errorRegistry.fire(error),
    onRuntimeAssetChange: (worldId, handle) => {
      internals.gpuStore.invalidateMesh(handle, preparedWorlds[worldId] ?? worldId);
    },
    instanceCollections,
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
    | { readonly renderables: readonly RenderableSnapshot[]; readonly count: number }
    | undefined;
  let lodInspectionRenderablesCache:
    | {
        readonly submissionRenderables: readonly RenderableSnapshot[];
        readonly lodCandidateCount: number;
        readonly values: readonly RenderableSnapshot[];
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
  const lastFrustumStats: { culled: number; total: number } = { culled: 0, total: 0 };
  const lastVisibilityStats: { explicitlyHidden: number } = { explicitlyHidden: 0 };
  let lastMaterialTextureSources: MaterialTextureSourceInspection = {
    sourceFieldsVisited: 0,
    numericSharedRefProbes: 0,
    sourceCacheHits: 0,
    sourceCacheMisses: 0,
    producerRoutes: Object.freeze({}),
  };
  let lastMeshMaterialBindings: readonly MeshMaterialBindingObservation[] = [];
  let lastMeshMaterialBindingRenderables: readonly RenderableSnapshot[] | undefined;
  let lastPresentation: FramePresentation = 'pending';
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
          const preparedPipelineEntry = runtime.getMaterialShaderPipelineEntry?.(
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
              ? (runtime.getMaterialShaderPipeline?.(
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
            'guid' in material &&
            typeof material.world === 'number' &&
            typeof material.guid === 'string'
          ) {
            return preparedMaterialBindings(
              runtime,
              worlds,
              materialShaderId,
              material.world,
              material.guid,
              layout,
              preparedFeatureSkylightResources,
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
        gpuDriven: gpuDrivenProduction.inspect(),
        frameCaches: {
          materialUniforms: {
            ...(frameState.materialUboCounters ?? {
              packHits: 0,
              packMisses: 0,
              comparedSlots: 0,
              unchangedSlots: 0,
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
      return gpuDrivenProduction.inspect();
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
        ? (graph?.resources.find((resource) => resource.label === 'directional-shadow-depth')
            ?.byteSize ?? 0)
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
      const worldId = preparedWorlds.indexOf(world);
      const allocator = internals.getPipelineState()?.skinPaletteAllocator;
      if (allocator !== undefined && allocator !== null) {
        for (const slot of persistentRenderScene.compositionSlots()) {
          if (slot.worldId === worldId && slot.snapshot.skin !== undefined)
            allocator.releasePersistentSlice(slot.snapshot.skin.identity);
        }
      }
      persistentRenderScene.detach(world);
      internals.featureSceneInputs?.detach(world);
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
      return submitFrameRecordings([this.record(...args)], undefined, internals);
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
      const render = mode === true;
      const captureOnly = mode === 'capture';
      const composition = canonicalizeWorldComposition(worlds, opts, renderReadLeases);
      const sourceWorlds = composition.worlds;
      const compositionWorlds: readonly RenderResourceScope[] =
        publication === undefined ? sourceWorlds : [publication.resources];
      const compositionLeases = composition.leases;
      preparedWorlds = compositionWorlds;
      const profileSession = internals.profiler?.activeSession();
      let ownsProfileFrame = false;
      let submitted = false;
      // A failed draw cannot publish a startup completion fact. Reset the
      // projection before extraction so a later receipt never reuses an old
      // scene's readiness.
      if (render) lastPresentation = 'pending';
      // A prior failed record/submit may have staged a temporal capture. A
      // capture belongs only to the draw call that created it; discard it
      // before this call can prepare or commit a new candidate.
      persistentRenderScene.discardTemporalFrame();
      // A failed draw must never leave a previous frame eligible to publish a
      // newly accepted dynamic-geometry candidate.
      dynamicGeometryFrames.begin();
      if (profileSession !== undefined && opts.profileFrame === undefined) {
        try {
          ownsProfileFrame = profileSession.beginFrame(++directFrameId).ok;
        } catch {
          ownsProfileFrame = false;
        }
      }
      try {
        pointsLinesOwner.beginFrame();
        // cameraOwner drives the surfaced cameras + frustum
        // cull; resourceOwner drives skylight/skybox/postProcess + per-world
        // record config.
        const { cameraOwner, resourceOwner, cameraEntityKey } = composition.owners;
        // Keep the compiled graph as last-known-good until the candidate topology
        // compiles. The failed candidate frame does not execute it; successful
        // replacement retires it atomically in ensureCompiledFrameGraph.
        if (frameState.installedPipelineHandle !== lastBuiltPipelineHandle) {
          // Feature contributions describe the active pipeline graph. Drop the
          // old graph before the next frame re-runs feature contribution
          // so a hot-swap cannot reuse passes compiled for the retired pipeline.
          resetRenderFeatureGraphState(internals);
          lastBuiltPipelineHandle = frameState.installedPipelineHandle;
          if (publication === undefined) persistentRenderScene.invalidate();
        }
        dispatchCounts.unlit = 0;

        const resourceWorld = compositionWorlds[resourceOwner] as RenderResourceScope;
        let frame: ReturnType<PersistentRenderScene['extractComposition']>;
        try {
          frame = runProfiledRenderPhase(profileSession, 'extract', () => {
            if (publication !== undefined) {
              const viewCamera =
                internals.viewOutput === undefined
                  ? undefined
                  : cameraForView(publication.frame.cameras, cameraEntityKey, internals.viewOutput);
              return persistentRenderScene.consumePublication(
                preparePublicationGeometry(
                  internals.viewOutput === undefined
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
                  persistentRenderScene,
                  internals.getPipelineState()?.skinPaletteAllocator,
                  internals.assets,
                  instanceCollections,
                  internals.device.caps.storageBuffer
                    ? internals.getMaterialShaderArtifact
                    : undefined,
                ),
              );
            }
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
              internals.assets.catalogEpoch,
              (renderables) =>
                extractFrames(
                  sourceWorlds,
                  {
                    cameraOwner,
                    resourceOwner,
                    ...(cameraEntityKey === undefined ? {} : { cameraEntityKey }),
                  },
                  internals.assets,
                  internals.getPipelineState(),
                  materialCaches,
                  {
                    ...materialContext,
                    cull: 'none',
                    ...(internals.viewOutput === undefined
                      ? {}
                      : { viewExtent: internals.viewOutput }),
                    retainHidden: true,
                    renderables,
                    instanceCollections,
                    ...(!internals.device.caps.storageBuffer ||
                    internals.getMaterialShaderArtifact === undefined
                      ? {}
                      : { getMaterialShaderArtifact: internals.getMaterialShaderArtifact }),
                  },
                ),
              compositionLeases,
            );
          });
        } catch (cause) {
          if (cause instanceof MotionBlurValidationError) {
            lastMotionBlurInvalidParams = cause;
            latestCamera = undefined;
            internals.errorRegistry.fire(cause);
            return false;
          }
          throw cause;
        }
        lastMotionBlurInvalidParams = undefined;
        const {
          cameras: extractedCameras,
          auxiliaryCameras: extractedAuxiliaryCameras,
          cubeCameras: extractedCubeCameras,
          lights: extractedLights,
          environment,
          environmentReady,
          volumetricFog,
          cloudLayer,
          renderables,
          dispatch,
          shadowCasterEntityKeys: extractedShadowCasterEntityKeys,
          shadowCasterDrawKeys: extractedShadowCasterDrawKeys,
          shadowCasterMembership: extractedShadowCasterMembership,
          skylight,
          skylightCount,
          skybox,
          skyboxCount,
          fogFailure,
          frustumStats,
          visibilityStats,
          postProcessParams,
        } = frame;
        const cameras: CameraSnapshot[] = captureOnly
          ? extractedCameras
              .filter((camera, index) =>
                opts.cameraEntityKey === undefined
                  ? index === 0
                  : camera.entityKey === opts.cameraEntityKey,
              )
              .map((camera) => ({
                position: camera.position,
                world: camera.world,
                fov: camera.fov,
                aspect: camera.aspect,
                near: camera.near,
                far: camera.far,
                projection: camera.projection,
                orthoLeft: camera.orthoLeft,
                orthoRight: camera.orthoRight,
                orthoBottom: camera.orthoBottom,
                orthoTop: camera.orthoTop,
                tonemap: 'none' as const,
                exposure: 1,
                whitePoint: 1,
                antialias: 'none' as const,
                bloom: 'off' as const,
                bloomThreshold: 1,
                bloomIntensity: 0,
                bloomSoftKnee: 0,
                bloomScatter: 0,
                clearColor: camera.clearColor,
                ...(camera.entityKey === undefined ? {} : { entityKey: camera.entityKey }),
                ...(camera.worldId === undefined ? {} : { worldId: camera.worldId }),
              }))
          : extractedCameras;
        const csm =
          captureOnly ||
          extractedLights.directionalCsmConfig === undefined ||
          extractedLights.directionalCsmDirection === undefined
            ? null
            : computeDirectionalCsm(
                extractedLights.directionalCsmDirection,
                extractedLights.directionalCsmConfig,
                cameras[0],
                frameState.directionalShadowProjection,
                extractedLights.normalBias ?? 0.05,
              );
        const lights = csm === null ? extractedLights : { ...extractedLights, ...csm };
        // Derive after this view selects its camera. Capture-only snapshots omit
        // display companions and therefore restore the author configuration.
        const lane = {
          storageBuffer: internals.device.caps.storageBuffer,
          maxColorAttachments: internals.device.limits.maxColorAttachments,
        };
        let cameraConfiguration = deriveCameraStandardConfiguration(
          internals.standardProfile,
          configuredPipelineConfig,
          cameras[0],
          lane,
        );
        if (!cameraConfiguration.ok) {
          const failureKey = JSON.stringify([
            cameraConfiguration.error.code,
            cameraConfiguration.error.detail,
          ]);
          if (failureKey !== lastCameraAoFailure) {
            internals.errorRegistry.fire(cameraConfiguration.error);
            lastCameraAoFailure = failureKey;
          }
          // Invalid AO cannot prevent an independently authored SSR request.
          cameraConfiguration = deriveCameraStandardConfiguration(
            internals.standardProfile,
            configuredPipelineConfig,
            { screenSpaceReflection: cameras[0]?.screenSpaceReflection },
            lane,
          );
        } else {
          lastCameraAoFailure = '';
        }
        if (!cameraConfiguration.ok) return false;
        const signature = JSON.stringify([
          cameraConfiguration.value.profile?.renderPath,
          cameraConfiguration.value.config?.ssao,
        ]);
        frameState.cameraStandardProfile = cameraConfiguration.value.profile;
        frameState.installedPipelineConfig = cameraConfiguration.value.config;
        if (signature !== cameraStandardSignature) {
          cameraStandardSignature = signature;
          installEpoch += 1;
          frameState.installedPipelineHandle = installEpoch;
          // Re-contribute before compiling the current selected view. The
          // prior compiled graph remains last-known-good until compilation.
          resetRenderFeatureGraphState(internals);
          lastBuiltPipelineHandle = installEpoch;
        }
        internals.gpuPassTimingViewId = cameras[0]?.entityKey;
        // Publication carries planar authoring facts from the source realm.
        // Re-project them against this RenderSystem's selected display camera.
        let auxiliaryCameras = projectAuxiliaryCamerasForView(
          cameras[0],
          extractedAuxiliaryCameras,
        );
        let scheduledCaptureWork: readonly import('./capture/scheduler').CubeCaptureWork[] = [];
        const preparedOutput = prepareStandardOutputResources(
          frameState,
          internals,
          cameras[0],
          compositionWorlds[cameraOwner] as RenderResourceScope,
        );
        if (!preparedOutput.ok) {
          internals.errorRegistry.fire(preparedOutput.error);
          return false;
        }
        const stableShadowOwnership = shadowOwnershipRebase.rebase(
          compositionWorlds,
          persistentRenderScene.visibilityWorldKeysFor(compositionWorlds),
          extractedShadowCasterEntityKeys,
          extractedShadowCasterDrawKeys,
          extractedShadowCasterMembership,
        );
        const shadowCasterEntityKeys = stableShadowOwnership.entityKeys;
        const shadowCasterDrawKeys = stableShadowOwnership.drawKeys;
        const shadowCasterMembership = stableShadowOwnership.membership;
        const shadowCasterProjection = persistentRenderScene.shadowCasterProjection();
        lastDirectionalShadowLights = lights;
        lastDirectionalShadowCandidate = 'failed';
        lastDirectionalShadowError = lights.directionalShadowError;
        const reflectionProbeRecord = reflectionProbeOwner.prepare(
          frame.reflectionProbes ?? [],
          persistentRenderScene.reflectionProbeProjection().selected,
          cameras[0],
          frameState.frameNumber,
          skylight,
          frame.reflectionProbes?.some((probe) => probe.updateIntent === 'on-change')
            ? JSON.stringify([
                persistentRenderScene.reflectionCaptureRevision(),
                lights.directional,
                lights.point,
                lights.spot,
                lights.rect,
                skylight,
                frame.skybox,
                environment?.environmentSignature,
              ])
            : '',
          frame.skybox,
          environment as import('./environment/frame').SelectedEnvironmentFrame | undefined,
        );
        latestCamera = cameras[0];
        frameState.ssrRequested = latestCamera?.screenSpaceReflection !== undefined;
        // Resolve before a committed fallback change resets accumulation.
        // Fresh spatial SSR does not require a previous temporal submission.
        // Inspection uses the read-only projection above and never resets state.
        const ssrDependencies = resolveSsrDependencies(frameState.ssrRequested);
        const reset = resolveSsrAdmissionGeneration(
          ssrFallbackGeneration,
          ssrDependencies.reflectionFallback?.projectionGeneration,
        );
        if (reset.changed) {
          resetTemporalHistory(frameState, 'signature-change');
          frameState.ssrHistoryOwner?.reset('reflection-generation');
        }
        ssrFallbackGeneration = reset.generation;
        const worldKeys = persistentRenderScene.visibilityWorldKeysFor(compositionWorlds);
        const slotByEntity = persistentRenderScene.compositionSlotByStableEntity();
        const visibilityProjection = persistentRenderScene.projectVisibility(
          compositionWorlds,
          renderables,
          dispatch,
        );
        const submissionRenderables = visibilityProjection.renderables;
        const submissionDispatch = visibilityProjection.dispatch;
        const presentationRenderables =
          cameras.length === 0
            ? []
            : projectDisplayRenderables(submissionRenderables, submissionDispatch);
        const terrainCandidate = captureSubmittedTerrain(
          presentationRenderables,
          compositionWorlds,
        );
        let framePresentation: FramePresentation =
          cameras.length > 0 && (!environmentReady || environment === undefined)
            ? 'pending'
            : 'ready';
        const inspectionCamera = latestCamera;
        // The public frame receipt is allocated by WebGPURenderer immediately
        // before this draw (`observationFrameId`). RenderSystem's private
        // frameNumber is an internal generation and also advances on failed
        // record attempts, so it cannot be used as receipt identity. Keep the
        // internal generation for recovery/visibility state, but bind the LOD
        // inspection to the frame id that the caller will receive.
        const lodSubmitFrameId =
          (internals as RenderSystemInternals & { readonly observationFrameId?: number })
            .observationFrameId ?? frameState.frameNumber;
        let lodCandidateCountForFrame = 0;
        if (inspectionCamera !== undefined) {
          const firstRenderable = renderables[0];
          const lodCandidateCount =
            lodCandidateCountCache?.renderables === renderables
              ? lodCandidateCountCache.count
              : (() => {
                  const count = renderables.reduce(
                    (total, renderable) => total + ((renderable.lods?.length ?? 0) > 0 ? 1 : 0),
                    0,
                  );
                  lodCandidateCountCache = { renderables, count };
                  return count;
                })();
          lodCandidateCountForFrame = lodCandidateCount;
          const inspectionRenderables =
            lodInspectionRenderablesCache?.submissionRenderables === submissionRenderables &&
            lodInspectionRenderablesCache.lodCandidateCount === lodCandidateCount
              ? lodInspectionRenderablesCache.values
              : (() => {
                  const values =
                    lodCandidateCount > 0
                      ? submissionRenderables.filter(
                          (renderable) => (renderable.lods?.length ?? 0) > 0,
                        )
                      : submissionRenderables;
                  lodInspectionRenderablesCache = {
                    submissionRenderables,
                    lodCandidateCount,
                    values,
                  };
                  return values;
                })();
          const candidateCount =
            lodCandidateCount > 0 ? lodCandidateCount : renderables.length + frustumStats.culled;
          // The GPU lane replaces this projection with its selector counters;
          // the CPU lane reports the same hard selection its classic draws use.
          const cpuLodLane = selectGpuLodLane(internals.device.caps) === 'cpu';
          const levelOf = (renderable: RenderableSnapshot): number =>
            cpuLodLane
              ? cpuLodLevel(
                  renderable,
                  internals.gpuStore.getMeshGpuHandles(
                    toShared<'MeshAsset'>(renderable.assetHandle),
                    compositionWorlds[renderable.worldId] ?? renderable.worldId,
                  ),
                  inspectionCamera,
                )
              : 0;
          const inspectionWorlds = createLodWorldInspections(
            compositionWorlds,
            renderables,
            submissionRenderables,
            inspectionCamera,
            lodSubmitFrameId,
            worldKeys,
            slotByEntity,
            levelOf,
          );
          const inspectionLevels = inspectionRenderables.map(levelOf);
          const attachmentByWorldKey = new Map<number, string>();
          for (let worldId = 0; worldId < compositionWorlds.length; worldId += 1) {
            const world = compositionWorlds[worldId];
            if (world === undefined) continue;
            const worldKey = worldKeys[worldId] ?? worldId;
            if (attachmentByWorldKey.has(worldKey)) {
              attachmentByWorldKey.clear();
              break;
            }
            attachmentByWorldKey.set(worldKey, world.identity);
          }
          lastLodWorldAttachments = attachmentByWorldKey;
          lastLodOcclusionInspection = inspectLodOcclusion({
            root: {
              guid:
                firstRenderable === undefined
                  ? 'none'
                  : `asset-handle:${firstRenderable.assetHandle}`,
              sourceKey: `render-frame:${lodSubmitFrameId}`,
            },
            view: {
              attachmentId:
                compositionWorlds[inspectionCamera.worldId ?? cameraOwner]?.identity ?? 'none',
              cameraEntity: inspectionCamera.entityKey ?? 0,
              viewRole: 'main',
              viewGeneration: inspectionCamera.historyVersion ?? 0,
            },
            slot: {
              primitiveSlot: 0,
              slotGeneration: persistentRenderScene.inspect().topology.revision,
            },
            generation: lodSubmitFrameId,
            count: {
              candidates: candidateCount,
              visible: inspectionRenderables.length,
              occluded: 0,
            },
            lodHistogram: lodLevelHistogram(inspectionLevels),
            samples: inspectionRenderables.slice(0, 64).map((_, index) => ({
              primitiveSlot: index,
              level: inspectionLevels[index] ?? 0,
              visible: true,
            })),
            submit: {
              frameId: lodSubmitFrameId,
              build: resolveInspectionBuild(internals),
              deviceGeneration: internals.deviceScope.generation,
            },
            worlds: inspectionWorlds,
          });
        } else {
          lastLodOcclusionInspection = undefined;
          lastLodWorldAttachments = new Map();
        }
        persistentRenderScene.prepareTemporalFrame(submissionRenderables);
        frameState.environmentFrame = environment as
          | import('./environment/frame').SelectedEnvironmentFrame
          | undefined;
        if (environment?.source.kind !== 'atmosphere') releaseAtmosphere(internals);
        environmentLifecycle.bindScope(internals.deviceScope);
        if (fogFailure !== undefined) {
          environmentLifecycle.recordSelectionFailure(fogFailure);
        }
        if (!environmentReady || environment === undefined) {
          frameState.pendingTemporalCommit = { kind: 'none' };
          // A world with no camera still has a valid clear-only render path.
          // It has no environment candidate and therefore must not publish an
          // off/taa temporal state; camera-bearing rejected extraction remains
          // an atomic render failure.
          if (cameras.length > 0) return false;
        } else {
          const environmentCandidate = environmentLifecycle.ensure(environment);
          if (!environmentCandidate.ok) {
            environmentLifecycle.recordCandidateFailure(environmentCandidate.error);
            internals.errorRegistry.fire(environmentCandidate.error);
            return false;
          }
          if (!environmentLifecycle.isActive(environmentCandidate.value)) {
            frameState.environmentGeneration = environmentCandidate.value;
          }
        }
        const transmissionAntialias = frame.cameras[0]?.antialias ?? 'none';
        if (!prepareTransmissionCandidate(transmissionAntialias)) {
          // The candidate gate runs before bind-group preparation, graph
          // construction, and record/submit. A missing capability therefore
          // cannot publish or execute a transmission graph.
          updateTransmissionInspection(transmissionAntialias, false);
          return false;
        }
        if (lastMeshMaterialBindingRenderables !== renderables) {
          const observeResidency = createMaterialResidencyObserver(internals);
          lastMeshMaterialBindingRenderables = renderables;
          lastMeshMaterialBindings = renderables.map((renderable) => {
            const materialWorld = preparedWorlds[renderable.worldId];
            return projectMeshMaterialBindingObservation({
              worldId: renderable.worldId,
              ...(materialWorld === undefined ? {} : { worldIdentity: materialWorld.identity }),
              entityKey: renderable.entityKey,
              bindings: renderable.materials.map((material, slotIndex) => ({
                handle: material.materialHandle ?? 0,
                source: renderable.materialBindingSources[slotIndex] ?? 'engine-default',
              })),
              diagnostics: renderable.materialBindingDiagnostics ?? [],
              residency: renderable.materials.map((material) =>
                observeResidency(materialWorld, material),
              ),
            });
          });
        }

        bindGroupCounts.createBindGroup = 0;
        bindGroupCounts.keys = [];
        const preparedPipelineState = internals.getPipelineState();
        const featureView = createCloudFeatureView(
          cameras[0],
          compositionWorlds,
          cameraOwner,
          internals.canvas.width,
          internals.canvas.height,
          internals.deviceScope.generation,
          frameState.lastSuccessfulTemporalView === undefined,
          lastSubmittedGeneration !== undefined &&
            lastSubmittedGeneration !== internals.deviceScope.generation,
        );
        const bindGroupSkipReason: RenderPhaseSkipReason | undefined =
          internals.featureHost === undefined
            ? 'feature-host-unavailable'
            : internals.featureHost.size === 0
              ? 'feature-host-empty'
              : preparedPipelineState === null
                ? 'pipeline-state-unavailable'
                : frame.cameras.length === 0
                  ? 'camera-unavailable'
                  : undefined;
        if (bindGroupSkipReason !== undefined || preparedPipelineState === null) {
          recordProfileSkip(
            profileSession,
            'bind-groups',
            bindGroupSkipReason ?? 'pipeline-state-unavailable',
          );
        } else {
          runProfiledRenderPhase(profileSession, 'bind-groups', () =>
            buildPerFrameBindGroups(
              internals,
              frameState,
              preparedPipelineState,
              true,
              bindGroupCounts,
              undefined,
              false,
            ),
          );
        }
        lastFrustumStats.culled = frustumStats.culled;
        lastFrustumStats.total = frustumStats.total;
        lastVisibilityStats.explicitlyHidden = visibilityStats.explicitlyHidden;
        if (frame.materialTextureSources !== undefined) {
          lastMaterialTextureSources = Object.freeze({
            sourceFieldsVisited: frame.materialTextureSources.sourceFieldsVisited,
            numericSharedRefProbes: frame.materialTextureSources.numericSharedRefProbes,
            sourceCacheHits: frame.materialTextureSources.sourceCacheHits,
            sourceCacheMisses: frame.materialTextureSources.sourceCacheMisses,
            producerRoutes: Object.freeze({ ...frame.materialTextureSources.producerRoutes }),
          });
        }
        const featureTargets =
          preparedPipelineState === null || cameras[0] === undefined
            ? []
            : resolveStandardRenderFeatureTargets({
                tonemap: cameras[0].tonemap,
                antialias: cameras[0].antialias,
                colorAttachmentFormat: preparedPipelineState.colorAttachmentFormat,
                storageBuffer: internals.device.caps.storageBuffer,
                multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
                cloudHistory: cloudLayer !== undefined,
              });
        const motionBlurParams = cameras[0]?.motionBlur;
        let motionBlurDelta = 0;
        try {
          const delta = renderTime(compositionWorlds[cameraOwner] as RenderResourceScope).delta;
          motionBlurDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
        } catch {
          motionBlurDelta = 0;
        }
        const acceptedSampleTime = frameState.lastSuccessfulTemporalView?.sampleTimeSeconds;
        const cameraViewIdentity = captureOnly
          ? 'renderer:capture'
          : renderFeatureViewIdentity(cameras[0]);
        const canvasWidth = Math.max(1, internals.canvas.width);
        const canvasHeight = Math.max(1, internals.canvas.height);
        const motionBlurPlan = planMotionBlurFrame({
          params: motionBlurParams,
          sampleTimeSeconds: opts.sampleTimeSeconds,
          acceptedSampleTimeSeconds: acceptedSampleTime,
          fallbackDeltaSeconds: motionBlurDelta,
          acceptedTemporal: frameState.lastSuccessfulTemporalView,
          temporalReset: opts.temporalReset === true,
          width: canvasWidth,
          height: canvasHeight,
          cameraViewIdentity,
          historyVersion: cameras[0]?.historyVersion ?? 0,
          environmentSignature: environment?.environmentSignature ?? '',
          fogSignature: environment?.fogSignature ?? '',
          deviceGeneration: internals.deviceScope?.generation ?? 0,
        });
        const demandedMotionBlur = motionBlurPlan.demanded;
        motionBlurFeatureInput = motionBlurPlan.featureInput;
        if (
          demandedMotionBlur &&
          internals.device.caps.compute === true &&
          internals.device.caps.storageBuffer === true &&
          internals.device.caps.storageTexture === true &&
          internals.device.caps.rgba16floatRenderable === true
        ) {
          ensureMotionBlurFeature();
        }
        preparedFeatureSkylightResources =
          preparedPipelineState === null
            ? undefined
            : resolveMaterialSkylight(internals, preparedPipelineState, skylight, skylightCount)
                .skylightResources;
        let featureGraphCandidate: RenderFeatureGraphCandidate | undefined;
        let featureGraphAccepted = false;
        const selectedCamera = cameras[0];
        const selectedView =
          selectedCamera === undefined
            ? undefined
            : {
                position: new Float32Array(selectedCamera.position),
                right: new Float32Array([
                  selectedCamera.world[0] ?? 1,
                  selectedCamera.world[1] ?? 0,
                  selectedCamera.world[2] ?? 0,
                ]),
                up: new Float32Array([
                  selectedCamera.world[4] ?? 0,
                  selectedCamera.world[5] ?? 1,
                  selectedCamera.world[6] ?? 0,
                ]),
                viewProjection: mat4.multiply(
                  mat4.create(),
                  computeProjectionMatrix(selectedCamera),
                  computeViewMatrix(selectedCamera),
                ),
              };
        let preparedFeatureFrame: import('./features/host').RenderFeatureFrameResult | undefined;
        const sceneInputs = internals.featureSceneInputs;
        let featureSceneInputWork: readonly import('./record/target-capture-graph').CubeCaptureGraphWork[] =
          [];
        if (internals.featureHost !== undefined) {
          if (encoder === undefined) {
            const createdEncoder = internals.device.createCommandEncoder();
            if (!createdEncoder.ok) throw createdEncoder.error;
            encoder = createdEncoder.value;
          }
          const featureSignal = yield {
            kind: 'features' as const,
            host: internals.featureHost,
            internals,
            encoder,
            captures: {
              snapshots: extractedCubeCameras,
              auxiliary: extractedAuxiliaryCameras,
              exclusive: captureOnly,
              accept: (
                work: readonly import('./capture/scheduler').CubeCaptureWork[],
                sharedAuxiliary: readonly CameraSnapshot[],
                sceneInputs: readonly import('./record/target-capture-graph').CubeCaptureGraphWork[],
              ) => {
                scheduledCaptureWork = work;
                featureSceneInputWork = sceneInputs;
                auxiliaryCameras = [
                  ...(render
                    ? auxiliaryCameras.filter((camera) => camera.planarReflection !== undefined)
                    : []),
                  ...sharedAuxiliary,
                ];
              },
            },
            input: {
              identity: cameraViewIdentity,
              render,
              ...(motionBlurFeatureInput === undefined
                ? {}
                : { motionBlur: motionBlurFeatureInput }),
              worlds: sourceWorlds,
              resolveAsset: (index, handle) => {
                const source = compositionWorlds[index];
                return source === undefined
                  ? err(new Error(`Missing feature asset source ${index}`))
                  : resolveAssetHandle(source, handle);
              },
              ...(publication === undefined
                ? {}
                : {
                    publishedFeatures: publication.packet.features,
                    ...(publication.onFeatureSourceSubmitted === undefined
                      ? {}
                      : { onFeatureSourceSubmitted: publication.onFeatureSourceSubmitted }),
                  }),
              owner: resourceOwner,
              frameNumber: internals.rendererFrameNumber ?? frameState.frameNumber,
              ...(selectedCamera === undefined ? {} : { selectedCamera, selectedView }),
              frameSize: { width: internals.canvas.width, height: internals.canvas.height },
              visibilitySnapshots: frame.featureVisibilitySnapshots,
              hiddenEntityReports: frame.hiddenEntityReports,
              targets: featureTargets,
              generation: internals.featureHost?.preparedGeneration ?? 0,
              getFeatureShaderSource: internals.getFeatureShaderSource,
              caps: internals.device.caps,
              limits: internals.device.limits,
              frame: createCloudFeatureFrameContext(cloudLayer, featureView),
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
                          scopes: compositionWorlds,
                        }),
                      abortFeature: (identity) => sceneInputs.abortFeature(identity),
                    },
            },
            accept: (result: import('./features/host').RenderFeatureFrameResult) => {
              preparedFeatureFrame = result;
            },
          };
          if (!featureSignal.ok) return false;
        }
        runProfiledRenderPhase(profileSession, 'features', () => {
          if (
            publication?.packet.features.some(
              (row) =>
                !internals.featureHost?.features.some(
                  (feature) => feature.identity === row.identity,
                ),
            )
          )
            throw new RenderPublicationError({
              reason: 'shape',
              subject: 'published feature has no receiver implementation',
            });
          if (internals.featureHost === undefined) return [];
          const featureFrame = preparedFeatureFrame;
          if (featureFrame === undefined) return [];

          lastVisibilityStats.explicitlyHidden = featureFrame.hiddenEntityReports.length;
          reportPendingRenderFeatureErrors(
            featureFrame.errors,
            frameState.frameNumber,
            pendingFeatureErrorLastReportedFrame,
            internals.errorRegistry,
          );
          const postProcessParamsCandidate = postProcessOwner.prepare(
            featureFrame.fullscreenEffects,
          );
          if (!postProcessParamsCandidate.ok) {
            internals.errorRegistry.fire(postProcessParamsCandidate.error);
            for (const batch of featureFrame.preparedResourceBatches) {
              const released = batch.release();
              if (!released.ok) internals.errorRegistry.fire(released.error);
            }
            return [];
          }
          featureGraphCandidate = {
            plans: featureFrame.plans,
            fullscreenEffects: featureFrame.fullscreenEffects,
            postProcessIdentities: featureFrame.postProcessIdentities,
            ...(featureFrame.requiresPreparedResourceKey
              ? { preparedResourceKey: `frame-${frameState.frameNumber}` }
              : {}),
            onRejected: () => {
              featureFrame.onAborted();
              for (const batch of featureFrame.preparedResourceBatches) {
                const released = batch.release();
                if (!released.ok) {
                  internals.errorRegistry.fire(released.error);
                }
              }
              postProcessOwner.discard(postProcessParamsCandidate.value);
            },
            onAbandoned: () => {
              featureFrame.onAborted();
              postProcessOwner.discard(postProcessParamsCandidate.value);
            },
            onSubmitted: () => {
              featureFrame.onSubmitted();
            },
            onAborted: () => {
              featureFrame.onAborted();
            },
            onAccepted: () => {
              featureGraphAccepted = true;
              for (const [id, previous] of postProcessOwner.featureEntries) {
                const next = featureFrame.fullscreenEffects.get(id);
                if (next === undefined) {
                  clearPostProcessPipelineCache(id);
                  invalidatePostProcessModule(id);
                } else if (
                  postProcessShaderEntrySignature(previous) !==
                  postProcessShaderEntrySignature(next)
                ) {
                  clearPostProcessPipelineEntry(id, previous);
                  if (previous.source !== next.source) {
                    invalidatePostProcessModule(id);
                  }
                }
              }
              postProcessOwner.accept(postProcessParamsCandidate.value);
              postProcessOwner.featureEntries = featureFrame.fullscreenEffects;
            },
          };
          recordRenderFeatureCandidate(internals, featureGraphCandidate);
          return featureFrame.preparedResourceBatches;
        });

        if (
          !render &&
          scheduledCaptureWork.length === 0 &&
          auxiliaryCameras.length === 0 &&
          featureSceneInputWork.length === 0
        ) {
          if (captureOnly) disposeTargetCaptureLighting(cubeCaptureState);
          return true;
        }

        // Unified transparent-sort: (layer ASC, sortValue ASC) for modes 0/1/2;
        // distance back-to-front for mode=3. The transparent-sort config is a
        // per-world resource; it is read from the resource-owner world (the
        // world that owns skylight / skybox / singleton render state, w5 / D-3).
        // Only the Transparent segment is reordered; queue ordering between
        // segments (sortDispatchByQueue, stable) is preserved.
        const orderedDispatch = runProfiledRenderPhase(profileSession, 'sort', () =>
          transparentSort.sort(submissionDispatch, resourceWorld, cameras, submissionRenderables),
        );

        // M3 / w26: single dispatch list replaces old three-bucket model.
        // Pass dispatch to recordFrame — the record stage iterates dispatch
        // entries in queue order per plan-strategy D-3.
        //
        // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2):
        // the record stage must resolve each renderable's mesh + material
        // textures against the world it was EXTRACTED from — never the single
        // resourceWorld. The extract stage already resolves per-world
        // (extractFrames loops worlds[] and stamps RenderableSnapshot.worldId);
        // the record stage regressed to resolving everything against
        // resourceWorld, so a user-tier mesh living in the cameraOwner world
        // (e.g. an editor gizmo handle) resolves against resourceWorld's
        // sharedRefs — either a miss (asset-not-registered) or, when that slot
        // is occupied by an unrelated user-tier payload (equirect), a
        // wrong-kind resolve that throws in ensureResident. `worlds` is threaded
        // so the record stage can index worlds[renderable.worldId]. `resourceWorld`
        // stays the singleton-resource owner (skybox equirect / transparent-sort
        // config / video provider) — those ARE resource-owner reads.
        const recordProfilePhase: RecordProfileRunner | undefined =
          profileSession === undefined || profileSession.detail === 'owner'
            ? undefined
            : function recordProfilePhase<T>(phase: RenderRecordPhase, action: () => T): T {
                // `passes` deliberately keeps only the graph-pass boundary
                // plus once-per-record owners (GPU-driven prepare).
                // The same runner is also called by geometry/material helpers;
                // invoking those wrappers would turn a pass probe into the
                // high-overhead per-draw `nested` probe.
                if (profileSession.detail === 'passes') {
                  const isRecordOwner =
                    phase.startsWith('record/gpu-driven-prepare') && !phase.endsWith('/groups/key');
                  const isGraphOwner =
                    phase === 'record/graph-execute' ||
                    (phase.startsWith('record/graph-execute/') &&
                      (!phase.slice('record/graph-execute/'.length).includes('/') ||
                        phase.endsWith('/geometry-loop')));
                  if (!isRecordOwner && !isGraphOwner) return action();
                }
                return runProfiledRenderPhase(profileSession, phase, action);
              };
        const bloomAdmitted = standardBloomAdmitted(cameras[0]);
        if (bloomAdmitted) {
          internals.getPipelineState()?.perPassResources.ensureBloomResources?.();
        }
        const liveOutput = cameras[0]?.output;
        const hasLiveFeatureState =
          liveOutput !== undefined ||
          frameState.autoExposureGpuResources !== undefined ||
          frameState.pendingAutoExposureGpuResources !== undefined ||
          frameState.autoExposureState !== undefined ||
          frameState.pendingAutoExposureState !== undefined ||
          frameState.standardLutGpuResources !== undefined ||
          frameState.pendingStandardLutGpuResources !== undefined ||
          frameState.standardLutState.resident !== null ||
          frameState.pendingStandardLutState !== undefined;
        if (hasLiveFeatureState) {
          const cameraWorld = compositionWorlds[cameraOwner] as RenderResourceScope;
          const deltaTime = renderTime(cameraWorld).delta;
          stageStandardOutputStates(
            frameState,
            internals,
            cameras[0],
            Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0,
          );
        }
        const surfaceSubmissionCandidate = surfaceSubmissionObservation.begin({
          frameId:
            (internals as RenderSystemInternals & { readonly observationFrameId?: number })
              .observationFrameId ?? frameState.frameNumber,
          requestedLane: opts.geometryLane === 'direct' ? 'direct' : 'gpu-driven',
          deviceGeneration: internals.deviceScope.generation,
          resourceGeneration: gpuDrivenProduction.resourceGeneration,
        });
        frameState.surfaceSubmissionObservation = surfaceSubmissionCandidate;
        const probeCaptureScene =
          shadowCasterProjection !== undefined &&
          (auxiliaryCameras.length > 0 ||
            featureSceneInputWork.length > 0 ||
            scheduledCaptureWork.length > 0 ||
            reflectionProbeRecord.graph.work.some((work) => work.rawCaptureFace !== undefined))
            ? projectCaptureScene(shadowCasterProjection, submissionRenderables, orderedDispatch)
            : undefined;
        // Track actual draws so a clear/submit cannot claim visible geometry was presented.
        const presentedDraws = createPresentationDraws();
        const drawObservation = createDrawObservation(internals);
        const consumeDynamicGeometry = dynamicGeometryFrames.onRenderableDraw(compositionWorlds);
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
        submitted = yield* profileFrameRecording(
          prepareFrameRecording(
            internals,
            resourceWorld,
            cameras,
            lights,
            probeCaptureScene?.renderables ?? submissionRenderables,
            probeCaptureScene?.displayDispatch ?? orderedDispatch,
            frameState,
            dispatchCounts,
            bindGroupCounts,
            skylight,
            skylightCount,
            skybox,
            skyboxCount,
            postProcessParams,
            compositionWorlds,
            recordProfilePhase,
            {
              owner: gpuDrivenProduction,
              scene: persistentRenderScene.compositionGpuDrivenState(),
              onRasterLane: (owned) => {
                persistentRenderScene.setGpuDrivenRasterLane(owned);
              },
              activeEntityKeys: visibilityProjection.activeEntityKeys,
              activeEntityRevision: visibilityProjection.activeEntityRevision,
              visibleRasterRows: Math.max(0, frustumStats.total - frustumStats.culled),
              ...(captureOnly || frame.gpuRasterCulledEntityKeys === undefined
                ? {}
                : { rasterCulledEntityKeys: frame.gpuRasterCulledEntityKeys }),
              telemetryCandidateCount: lodCandidateCountForFrame,
              telemetrySubmit: {
                frameId: lodSubmitFrameId,
                deviceGeneration: internals.deviceScope.generation,
              },
              frameTime: (() => {
                const elapsed = renderTime(
                  compositionWorlds[cameraOwner] as RenderResourceScope,
                ).elapsed;
                return Number.isFinite(elapsed) ? elapsed : 0;
              })(),
              deviceGeneration: internals.deviceScope.generation,
              ...(surfaceDynamicInputFrame === undefined
                ? {}
                : { surfaceDynamicInput: surfaceDynamicInputFrame }),
              ...(opts.geometryLane === undefined ? {} : { geometryLane: opts.geometryLane }),
            },
            compositionLeases,
            featureGraphCandidate,
            pointsLinesOwner,
            {
              scheduledWork: scheduledCaptureWork,
              captureOnly: captureOnly || !render,
              sceneInputs: featureSceneInputWork,
              auxiliaryCameras,
              state: cubeCaptureState,
              reflectionProbes: reflectionProbeRecord,
              ...(probeCaptureScene === undefined
                ? {}
                : { captureDispatch: probeCaptureScene.captureDispatch }),
            } satisfies CubeCaptureFrameInput,
            environment?.environmentSignature ?? '',
            environment?.fogSignature ?? '',
            environmentReady && environment !== undefined,
            persistentRenderScene.transmissionTopologyDemand(),
            shadowCasterEntityKeys,
            shadowCasterDrawKeys,
            captureOnly ? undefined : volumetricFog,
            timingCapture,
            shadowCasterMembership,
            shadowCasterProjection,
            worldKeys,
            undefined,
            ssrDependencies,
            markPresentedRenderable,
            environment?.fog,
            opts.sampleTimeSeconds,
            opts.temporalReset === true,
            captureOnly ? undefined : frame.cloudLayer,
            encoder,
            // extractFrames owns this fresh plain light record; features
            // receive view/cloud projections, never this mutable container.
            lights.cascadeCount,
            true,
          ),
          (action) => runProfiledRenderPhase(profileSession, 'record', action),
        );
        const sceneSubmitted = submitted && frameState.frameOutputs.sceneSubmitted;
        dynamicGeometryFrames.commit(submitted);
        if (!submitted) surfaceSubmissionCandidate.abort();
        frameState.surfaceSubmissionObservation = undefined;
        if (!sceneSubmitted) discardStandardOutputStates(frameState);
        const directionalQuality = lights.directionalShadowQuality;
        const directionalShadowReady =
          directionalQuality === undefined ||
          (frameState.frameOutputs.directionalShadowView !== null &&
            (lights.lightViewProj?.length ?? 0) > 0 &&
            (internals.getPipelineState()?.perPassResources.shadowMapSize ?? 0) > 0);

        // A successful queue submit is necessary but not sufficient for the
        // startup presentation fact. Reuse the same visible snapshots and
        // producer-owned GPU stores consumed by record so missing geometry,
        // material bindings, dynamic video frames, or requested shadow work
        // cannot dismiss the loading screen behind a clear/fallback pass.
        if (submitted && framePresentation === 'ready' && cameras.length > 0) {
          // Recording starts lazy image projection. Only its resident cube/IBL
          // publication can qualify the picture, not the extracted descriptor.
          if (
            [skylight?.equirectHandle, skybox?.equirectHandle].some(
              (handle) =>
                handle !== undefined &&
                handle !== 0 &&
                (internals.gpuStore.getCubemapStatus(toShared<'EquirectAsset'>(handle)) !==
                  'ready' ||
                  internals.gpuStore.getCubemapGpuView(toShared<'EquirectAsset'>(handle)) ===
                    undefined),
            )
          ) {
            framePresentation = 'pending';
          }
          const pipelineState = internals.getPipelineState();
          if (pipelineState === null || frameState.compiledFrameGraph === null) {
            framePresentation = 'pending';
          }
          for (const renderable of presentationRenderables) {
            if (framePresentation === 'pending') break;
            const entityKey = worldEntityKey(
              worldKeys[renderable.worldId] ?? renderable.worldId,
              renderable.entityKey,
            );
            if (!presentedDraws.hasEntity(entityKey)) {
              framePresentation = 'pending';
              break;
            }
            const renderableWorld = preparedWorlds[renderable.worldId];
            const meshHandles =
              renderableWorld === undefined
                ? undefined
                : (internals.gpuStore.getMeshGpuHandles(
                    toShared<'MeshAsset'>(renderable.assetHandle),
                    renderableWorld,
                  ) ?? pipelineState?.meshes.get(renderable.assetHandle));
            if (meshHandles === undefined) {
              framePresentation = 'pending';
              break;
            }
            if (
              renderable.terrainSection !== undefined &&
              !presentedDraws.hasTerrain(entityKey, renderable.terrainSection.index)
            ) {
              framePresentation = 'pending';
              break;
            }
            if (renderable.pointsLines === undefined) {
              for (const [submeshIndex] of meshHandles.submeshes.entries()) {
                if (!presentedDraws.hasSubmesh(entityKey, submeshIndex)) {
                  framePresentation = 'pending';
                  break;
                }
              }
            }
            if (framePresentation === 'pending') break;
          }
          if (framePresentation === 'ready') {
            framePresentation = projectFramePresentation({
              renderables: presentationRenderables,
              preparedWorlds,
              internals,
            });
          }
          // The receiver-bound view proves fresh or retained GPU shadow depth.
          // The legacy CPU cache is not the GPU shadow view pool's authority.
          if (framePresentation === 'ready' && !directionalShadowReady) {
            framePresentation = 'pending';
          }
          if (
            framePresentation === 'ready' &&
            lights.pointShadow.some(
              (shadow) =>
                shadow.shadowAtlasLayer >= 0 &&
                (shadow.shadowMatrices.length < 96 ||
                  [...shadow.shadowMatrices].some((value) => !Number.isFinite(value))),
            )
          ) {
            framePresentation = 'pending';
          }
          if (
            framePresentation === 'ready' &&
            lights.spot.some(
              (spot) =>
                spot.castShadow && (spot.lightViewProj === undefined || spot.shadowAtlasTile < 0),
            )
          ) {
            framePresentation = 'pending';
          }
        }
        if (sceneSubmitted && directionalShadowReady) {
          lastDirectionalShadowCandidate = 'accepted';
        } else if (directionalQuality !== undefined && (!submitted || sceneSubmitted)) {
          lastDirectionalShadowError = {
            code: 'directional-shadow-candidate-failed',
            expected:
              'the extracted Directional CSM candidate has a valid graph target and fitted matrices',
            hint: 'inspect the retained LKG and retry after the graph or resource owner recovers',
            detail: {
              submitted,
              hasShadowView: frameState.frameOutputs.directionalShadowView !== null,
              matrixCount: lights.lightViewProj?.length ?? 0,
              shadowMapSize: internals.getPipelineState()?.perPassResources.shadowMapSize ?? 0,
            },
          };
        }
        if (submitted) {
          if (framePresentation === 'ready')
            submittedTerrain = terrainCandidate.filter((section) =>
              presentedDraws.hasTerrain(
                worldEntityKey(worldKeys[section.worldId] ?? section.worldId, section.entity),
                section.section,
              ),
            );
          if (featureGraphAccepted) featureGraphCandidate?.onSubmitted?.();
          lastPresentation = framePresentation;
          materialDraws = drawObservation.commit(framePresentation === 'ready');
          if (sceneSubmitted) {
            recoveryOwner.setLastSuccessfulFrameSeed({
              frame,
              worlds: compositionWorlds,
              ...(publication === undefined
                ? {}
                : { publishedFeatures: publication.packet.features }),
              cameraOwner: composition.owners.cameraOwner,
              resourceOwner: composition.owners.resourceOwner,
              width: Math.max(1, internals.canvas.width),
              height: Math.max(1, internals.canvas.height),
              frameTime: (() => {
                const elapsed = renderTime(
                  compositionWorlds[cameraOwner] as RenderResourceScope,
                ).elapsed;
                return Number.isFinite(elapsed) ? elapsed : 0;
              })(),
              ...(surfaceDynamicInputFrame === undefined
                ? {}
                : { surfaceDynamicInput: surfaceDynamicInputFrame }),
              ...(frameState.recoveryMaterialArtifacts === undefined
                ? {}
                : { materialArtifacts: frameState.recoveryMaterialArtifacts }),
              ...(frameState.recoveryShadowMaterialArtifacts === undefined
                ? {}
                : { shadowMaterialArtifacts: frameState.recoveryShadowMaterialArtifacts }),
            });
          }
          submittedFrameCount += 1;
          lastSubmittedGeneration = internals.deviceScope?.generation;
          if (!sceneSubmitted) persistentRenderScene.discardTemporalFrame();
          if (sceneSubmitted) {
            const temporalCommit = persistentRenderScene.commitTemporalFrame(
              framePresentation === 'ready',
            );
            if (!temporalCommit.ok) internals.errorRegistry.fire(temporalCommit.error);
            frameState.lastSuccessfulCameraAntialias = cameras[0]?.antialias;
            const submittedDepthOfField =
              cameras[0] === undefined
                ? undefined
                : resolveDepthOfFieldFrameParams(
                    cameras[0].depthOfField,
                    cameras[0].depthOfFieldError,
                    frameState.depthOfFieldAccepted?.params,
                  );
            const submittedDepthOfFieldGraph = frameState.compiledFrameGraph?.graph.inspect();
            if (submittedDepthOfField !== undefined && submittedDepthOfFieldGraph !== undefined) {
              frameState.depthOfFieldAccepted = {
                params: submittedDepthOfField,
                graph: submittedDepthOfFieldGraph,
                deviceGeneration: internals.deviceScope.generation,
              };
              frameState.depthOfFieldLastSubmitFailed = false;
            } else if (submittedDepthOfField === undefined) {
              frameState.depthOfFieldAccepted = undefined;
              frameState.depthOfFieldLastSubmitFailed = false;
            } else {
              frameState.depthOfFieldLastSubmitFailed = true;
            }
            internals.getPipelineState()?.perPassResources.commitBloomResources?.();
            const nextBloom = bloomAdmitted ? 'on' : 'off';
            if (frameState.lastSuccessfulBloom === 'on' && nextBloom !== 'on') {
              internals
                .getPipelineState()
                ?.perPassResources.retireBloomResources?.(
                  internals.device.queue.onSubmittedWorkDone(),
                );
            }
            frameState.lastSuccessfulBloom = nextBloom;
          } else {
            internals.getPipelineState()?.perPassResources.discardBloomResources?.();
          }
        } else {
          if (cameras[0]?.depthOfField !== undefined) {
            frameState.depthOfFieldLastSubmitFailed = true;
          }
          internals.getPipelineState()?.perPassResources.discardBloomResources?.();
        }
        if (!submitted && frameState.environmentGeneration !== undefined) {
          environmentLifecycle.discard(frameState.environmentGeneration);
          frameState.environmentGeneration = undefined;
        }
        updateTransmissionInspection(transmissionAntialias, sceneSubmitted);
        persistentRenderScene.setPointsLinesInspections(pointsLinesOwner.inspections());
      } catch (err) {
        discardStandardOutputStates(frameState);
        if (!submitted) {
          internals.getPipelineState()?.perPassResources.discardBloomResources?.();
        }
        if (err instanceof ProjectedDecalInvalidError) throw err;
        const innerError =
          err instanceof PipelineSpecError || err instanceof ShaderError
            ? {
                name: err.name,
                code: err.code,
                message: err.message,
                ...(err.detail === undefined ? {} : { detail: err.detail }),
              }
            : err instanceof RhiError
              ? err
              : {
                  code: 'unknown' as const,
                  message: String(err),
                  name: (err as Error)?.name,
                };
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'RenderSystem to record one frame without an internal exception',
            hint: 'inspect detail.error for the underlying cause; next frame will retry',
            detail: { error: innerError },
          }),
        );
      } finally {
        if (!submitted) persistentRenderScene.discardTemporalFrame();
        if (ownsProfileFrame) {
          try {
            profileSession?.endFrame();
          } catch {
            // Profiler failures never alter rendering.
          }
        }
      }
      return submitted;
    },
    get submittedTerrain() {
      return submittedTerrain;
    },
    isDynamicGeometryConsumed: (world, entity, meshHandle) =>
      dynamicGeometryFrames.isConsumed(world, entity, meshHandle),
    dynamicGeometryRecordStageLane: (world, entity, meshHandle) =>
      dynamicGeometryFrames.recordStageLane(world, entity, meshHandle),
    pipelineDispatchCounts: dispatchCounts,
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
      return lastMeshMaterialBindings;
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
    prepareRecoveryGraphCandidate: recoveryOwner.prepareRecoveryGraphCandidate,
    submitCandidateSetup: recoveryOwner.submitCandidateSetup,
    publishRecoveryGraphCandidate: recoveryOwner.publishRecoveryGraphCandidate,
    discardRecoveryGraphCandidate: recoveryOwner.discardRecoveryGraphCandidate,
    disposeFrameState(): void {
      if (ownsSceneInputs) internals.featureSceneInputs?.dispose();
      disposeTargetCaptures(cubeCaptureState);
      frameState.dynamicResolution?.reset();
      internals.getPipelineState()?.skinPaletteAllocator?.dispose();
      pointsLinesOwner.dispose();
      persistentRenderScene.dispose();
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
      frameState.directionalShadowCache = null;
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
      disposeTransientInstanceBuffers(frameState.transientInstanceBuffers, internals.errorRegistry);
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
      if (frameState.pointShadowAtlas !== null) {
        frameState.pointShadowAtlas.dispose();
        frameState.pointShadowAtlas = null;
      }
    },
    resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {
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
      frameState.directionalShadowCache = null;
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
