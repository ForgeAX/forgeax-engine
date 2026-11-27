import type {
  GraphAccess,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  Buffer,
  Result,
  RhiDevice,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialDynamicInputLayout } from '@forgeax/engine-types';
import { isStripTopology } from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  GEOMETRY_OBSERVATION_MAX_COMMANDS,
  type GeometryObservation,
} from '../geometry-observation';
import type { GpuScene, GpuSceneResourceFrame, GpuSceneTableBindingTarget } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import type {
  GpuDrivenLaneReason,
  GpuDrivenLaneSummary,
  GpuDrivenPreparationFailureInspection,
  GpuDrivenProductionInspection,
  GpuDrivenStructureMetrics,
} from '../inspection-types';
import { clippingCapRenderState } from '../material-render-state';
import { standardSurfaceDiscardMask } from '../material-stage-constants';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  materialLayoutIndexFromKey,
  materialSlotFromLayoutKey,
  standardPipelineMaterialLayoutIndex,
} from '../pbr-pipeline';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { PREDEPTH_FRAGMENT_ENTRY, predepthCoversMaterial } from '../predepth-coverage';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { GpuDrawSummary } from '../record/gpu-draw-receipts';
import type { MaterialTableBindingPreparation } from '../record/material-bg-assembly-cache';
import {
  type PipelineState,
  type RecordProfileRunner,
  runRecordProfilePhase,
} from '../record/render-context';
import { primitiveForPipeline } from '../reflection/primitive-bindings';
import type { CameraSnapshot } from '../render-contract';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineGpuDrivenTarget,
} from '../render-pipeline';
import type { FrameSet } from '../scene/frame-set';
import type { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  admitSingleLayerMediumSubmission,
  type SurfaceGpuSubmissionAdmission,
} from '../surface/gpu-driven';
import type { SurfaceSubmissionCandidate } from '../surface/submission-observation';
import {
  batchLevelStride,
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
} from './batch-layout';
import {
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
  inspectResourceClassSplits,
  type SubmissionPlan,
} from './batch-topology';
import { mainLayerSuppression } from './camera-layer-suppression';
import { EMPTY_GPU_DRAW_SELECTION } from './draw-selection';
import { FilteredPlanContributionOwner } from './filtered-plan-contributions';
import { hasCapturedTaskMembership, isIssuedExecution } from './fixed-task-plan';
import {
  type GBufferOrderDiagnosticConfig,
  type GBufferOrderEncodeEvidence,
  gbufferDiagnosticView,
  isGBufferOrderDiagnosticEncode,
  orderGBufferDiagnostic,
} from './gbuffer-order-diagnostic';
import { type LiveRasterBatch, type LiveRasterCache, projectLiveRaster } from './live-raster';
import type { BatchExecutions } from './material-artifacts';
import {
  type PreparedRasterCounters,
  type PreparedRasterPass,
  PreparedRasterPassCache,
} from './prepared-raster-bundle';
import { InitialViewPreparationOwner } from './production-initial-view';
import {
  bindSceneTables,
  prepareProductionInputBindings,
  prepareProductionStorageInputs,
  readSourceResources,
  sameInputViews,
} from './production-input-bindings';
import { registerRasterPipelinePreparation } from './production-pipeline-preparation';
import { activeFrustum, occlusionCamera, shadowViewClipping } from './production-raster-camera';
import {
  createRasterPipelines,
  type ImportedMeshBuffers,
  importMeshBuffers,
  importSurfaceBuffers,
  isSingleLayerMediumArtifact,
  type ProjectedRasterClass,
  type ProjectedRasterPipelines,
  type RasterPipelineShape,
  rasterClassFor,
  rasterClassProjectionKey,
  rasterPipelineShapeKey,
  selectRasterPipeline,
} from './production-raster-classes';
import type {
  CurrentCameraRaster,
  FilteredFrame,
  GpuDrivenGraphProjection,
  GpuDrivenPrepareInput,
  PreparedGpuDrivenFrame,
  ShadowViewRequest,
} from './production-raster-contract';
import {
  bindMaterialSlot,
  captureFixedRasterInputs,
  IndirectPassBindings,
  observeSurfaceDraw,
  observesSurfaceDraws,
  type RasterEncodeCall,
  type RetainedEncode,
  recordRetainedMaterialPipelineBinding,
  requireLateRegion,
  retainedRasterIdentities,
  retainedRunEnd,
  selectedMaterialSlot,
  visibleWindowsFor,
} from './production-raster-encode';
import type {
  PipelinePreparationJob,
  PreparedRasterFrame,
  ProjectedRasterGraph,
  RasterGraphTarget,
  RasterProjectionFrame,
} from './production-raster-frame';
import {
  type GBufferOrderEvidence,
  type GBufferOrderSources,
  gbufferOrderBatchDepth,
} from './production-raster-gbuffer-order';
import {
  captureGeometrySources,
  type GpuGeometryCapture,
  gbufferGeometryProgram,
  observeProductionGeometry,
} from './production-raster-geometry-capture';
import type { ProductionRasterInputs } from './production-raster-inputs';
import {
  admittedRasterBatchCount,
  lodCoverageMayFade,
  lodViewCameraFromMatrix,
} from './production-raster-lod';
import {
  MaterialAbiRasterAdapter,
  SurfaceFrameProjectionOwner,
  surfaceVisibleRows,
} from './production-raster-material';
import {
  assemblePreparedPlan,
  BatchPreparation,
  type FilteredProductionPlan,
  type PreparedBatch,
  type PreparedProductionPlan,
} from './production-raster-prepare';
import {
  admitDirectResources,
  BatchRowAssembly,
  type HeldResidentBatchRows,
  type ProvisionalBatchContribution,
  type ResidentBatchPreparationInput,
  type ResidentBatchSetInput,
} from './production-raster-rows';
import {
  captureShadowBatchFacts,
  createShadowBatchProjection,
  type GpuDrivenShadowBatchProjection,
  preparedShadowRows,
  publishedShadowProjections,
  restrictShadowCasterChannels,
  retainedShadowOwners,
  retainedShadowProjection,
  type ShadowBatchProjections,
  ShadowChannelSlots,
  type ShadowProjectionPass,
  type ShadowProjectionSource,
  type ShadowViewBindings,
  type ShadowViewCacheRequest,
  sameConsumedArtifact,
  sameShadowBatchProjection,
  sameShadowBindings,
  sameShadowExecution,
  shadowArtifactsChanged,
  shadowLayerRequests,
  shadowMaterialsChanged,
  shadowMeshesChanged,
} from './production-raster-shadow';
import {
  isSkinPreparedBatch,
  mainPlanPhase,
  observeShadowArtifacts,
  preparationFailureInspection,
  rasterSampleCount,
  rebindRaster,
  requiresGpuSurfacePreparation,
  runPipelinePreparations,
  type ShadowArtifactObservations,
  shadowDirectRequired,
  shadowPlanPhase,
  shadowViewPass,
  surfaceArtifactInspection,
} from './production-raster-support';
import { RasterGraphIdentity } from './raster-graph-identity';
import {
  createResidentRowPreparation,
  type ResidentRowPreparation,
  type ResidentRowPreparationInput,
} from './resident-row-preparation';
import { combineGpuResourceAllocationInspections } from './resource-allocation';
import { preparedAssemblyInputs, samePreparedAssemblyInputs } from './retained-batch-inputs';
import {
  classOwner,
  materialOwner,
  type RetainedRasterBlock,
  RetainedRasterEncodes,
  runFacts,
} from './retained-raster-encode';
import { ShadowCasterClassifier } from './shadow-caster-classes';
import { ShadowProjectionDiffs } from './shadow-projection-diffs';
import { publishReadonlyMap, sameShadowProjectionLayout } from './shadow-projection-publication';
import { staticShadowViewIdentity } from './shadow-view-identity';
import {
  type ShadowCameraCullDilation,
  type ShadowViewIdentity,
  ShadowViewStatePool,
  type ShadowViewUpdate,
  type ShadowViewUpdateInput,
  shadowViewIdentityKey,
} from './shadow-views';
import { rasterPassKey } from './source-raster-bundles';
import {
  type NativeMainGraphPreparation,
  prepareNativeMainGraph,
  prospectiveMainRaster,
  SourceRasterPreparations,
} from './source-raster-preparation';
import { type SubmissionAdmission, submissionAdmission } from './submission-admission';
import {
  type GpuDrivenLodSelectionInspection,
  type GpuDrivenShadowCameraCull,
  GpuDrivenView,
  type GpuDrivenViewGraphResources,
  selectGpuLodLane,
} from './view-gpu';
import type { GpuViewInputPreparation } from './view-input-bindings';

export type { GpuDrivenShadowBatchProjection } from './production-raster-shadow';

type ShadowViewUpdateStorage = {
  -readonly [Key in keyof ShadowViewUpdateInput]: ShadowViewUpdateInput[Key];
};

const NO_CAMERA_BATCHES: readonly LiveRasterBatch[] = Object.freeze([]);
const DIRECT_TOPOLOGY_SIGNATURE = () => 'direct';

/**
 * Candidate order is the same address carried in rigid visibleItems.z. The
 * shared GPU Scene owns transforms; this projection carries identity only.
 */
const EMPTY_MATERIAL_BINDING_SLOTS: GpuDrivenStandardPbrFrameResources['materialSlotIndicesByBinding'] =
  new Map();

export class GpuDrivenProduction {
  private inputBindingPreparation: GpuViewInputPreparation | undefined;
  private readonly resourceFrames = new Set<GpuSceneResourceFrame>();
  private readonly residentRowHolds = new Set<HeldResidentBatchRows>();
  private readonly residentRowTasks = new Set<ResidentRowPreparation>();
  private disposed = false;
  private residentPreparing = false;
  private disposalFailure: AggregateError | undefined;
  private readonly rasterPasses = new PreparedRasterPassCache();
  private readonly retainedEncodes = new RetainedRasterEncodes();
  private gbufferOrderMaterials: import('../scene/material-dispatch').MaterialFrame | undefined;
  private gbufferOrderMode: GBufferOrderDiagnosticConfig | undefined;
  private gbufferOrderView: Float32Array | undefined;
  private gbufferOrderSlotAt: PersistentGpuDrivenState['slotAt'] | undefined;
  private gbufferOrderInspection: GpuDrivenProductionInspection['gbufferBatchOrderDiagnostic'];
  private gbufferOrderEncodes: GBufferOrderEncodeEvidence[] | undefined;

  private readonly preparedBundleCounters: PreparedRasterCounters = {
    hits: 0,
    builds: 0,
    commands: 0,
    evictions: 0,
  };
  private preparedBundleFixedHits = 0;
  private geometryCapture: GpuGeometryCapture | undefined;
  beginGeometryObservation(source: GpuGeometryCapture['source'] | undefined): void {
    this.geometryCapture = source === undefined ? undefined : { commands: [], members: 0, source };
  }
  observeGeometry(receipt: {
    frameId: number;
    deviceGeneration: number;
  }): Promise<GeometryObservation> {
    const capture = this.geometryCapture,
      view = this.view;
    return observeProductionGeometry(
      capture,
      view,
      receipt,
      () => capture === this.geometryCapture && view === this.view,
    );
  }
  private view: GpuDrivenView | undefined;
  private readonly initialViews: InitialViewPreparationOwner;
  private readonly sourceRasters: SourceRasterPreparations;
  private materialRaster: MaterialAbiRasterAdapter | undefined;
  private skinRaster: MaterialAbiRasterAdapter | undefined;
  /** The frame whose live batches are current; stock graphs project new classes from it. */
  private currentRasterFrame: PreparedRasterFrame | undefined;
  /** Stock raster classes projected after their graph compiled. */
  readonly lateRasterClasses = { projected: 0, failed: 0, retired: 0 };
  private readonly preparations = {
    forward: new BatchPreparation(),
    shadow: new BatchPreparation(),
  };
  private readonly mainFilterContributions = new FilteredPlanContributionOwner();
  private readonly shadowFilterContributions = new FilteredPlanContributionOwner();
  private filteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly bindings: ReadonlyMap<string, string> | undefined;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  /** Live draw facts of the latest prepared frame, read by compiled raster encoders. */
  private liveRasterBatches: readonly LiveRasterBatch[] = [];
  private liveRasterCache: LiveRasterCache | undefined;
  /** Per-frame admission facts; recomputed only when the active entity set changes. */
  private admissionCache: SubmissionAdmission | undefined;
  private readonly surfaceFrames = new SurfaceFrameProjectionOwner();
  private shadowFilteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private gpuOwnedSnapshotsMaterialized = 0;
  private filteredPlanBuilds = 0;
  private preparedBatchBuilds = 0;
  private filteredBatchBuilds = 0;
  private planRebuildBatches = 0;
  private preparedAssemblyHits = 0;
  private planRebuildCandidates = 0;
  private pendingDrawSummary: (() => GpuDrawSummary) | undefined;
  private gpuOwnedEntityCount = 0;
  private batchBindGroupCreates = 0;
  private validatedGpuOwnedRows = 0;
  private cpuFallbackDrawItems = 0;
  private cpuSemanticFallbackDrawItems = 0;
  private cpuDeformationFallbackDrawItems = 0;
  private readonly cpuDeformationReasons = new Map<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >();
  private blockedDrawItems = 0;
  private preparationFailure: GpuDrivenPreparationFailureInspection | undefined;
  private encodedIndirectDraws = 0;
  private telemetryPrepared = false;
  private telemetryCandidateCount = 0;
  private telemetryGeometryWork = 0;
  private telemetryRootGeometryWork = 0;
  private telemetryOverflow = false;
  private indirectDrawCount = 0;
  private gpuOwnedDrawItems = 0;
  private mainTotalDrawItems = 0;
  private lane: 'gpu' | 'cpu-semantic' | 'cpu-deformation' | 'blocked' = 'cpu-semantic';
  private laneReason: GpuDrivenLaneReason = 'capability';
  private submissionState: 'idle' | 'pending' | 'submitted' | 'aborted' = 'idle';
  private retryCount = 0;
  private lastKnownGoodGeneration: number | undefined;
  private overflowRecoveryRequired = false;
  private shadowViews: ShadowViewStatePool | undefined;
  private shadowSource: FilteredProductionPlan | undefined;
  private shadowScene: PersistentGpuDrivenState['scene'] | undefined;
  private shadowBatchProjections = publishReadonlyMap(
    new Map<string, ReadonlyMap<number, GpuDrivenShadowBatchProjection>>(),
  );
  /** Final views last projected without a static layer; a mode change invalidates both layers. */
  private readonly shadowSingleLayerViews = new Set<string>();
  /** Per-view inputs of the last projection; identical inputs skip whole-plan change scans. */
  private readonly shadowUnchangedInputs = new Map<
    string,
    {
      readonly projections: object;
      readonly filtered: object;
      readonly executions: object;
      readonly artifacts: object;
    }
  >();
  private readonly shadowProjectionSources = new WeakMap<
    ShadowBatchProjections,
    ShadowProjectionSource
  >();
  private readonly shadowCasterClasses = new ShadowCasterClassifier();
  private readonly shadowChannelSlots = new ShadowChannelSlots();
  private surfaceSubmission: SurfaceGpuSubmissionAdmission | undefined;
  private surfaceArtifactInspection: GpuDrivenProductionInspection['surfaceArtifact'];
  private committedViewClipping = '';
  /** Observed publication fields; raw artifact wrappers and receipts may mutate in place. */
  private observedShadowArtifacts: ShadowArtifactObservations = new Map();
  private cpuValidationCacheHits = 0;
  private cpuValidationScans = 0;
  private structureMetrics: GpuDrivenStructureMetrics = {
    worldEntitiesScanned: 0,
    sceneTableUploadBytes: 0,
  };
  private readonly rasterGraphIdentity = new RasterGraphIdentity();

  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly recoveryCount = 0,
  ) {
    const production = this;
    this.sourceRasters = new SourceRasterPreparations(device, this.rasterPasses);
    this.initialViews = new InitialViewPreparationOwner(device, shaderModuleFactory, {
      get alive() {
        return !production.disposed;
      },
      get idle() {
        return (
          !production.disposed &&
          !production.residentPreparing &&
          production.resourceFrames.size === 0
        );
      },
      get view() {
        return production.view;
      },
      adopt: (view) => {
        production.view = view;
      },
      discard: (view) => {
        if (production.view === view) production.view = undefined;
      },
      prepareConsumers: (scene, storage) =>
        prepareProductionStorageInputs(
          scene,
          storage,
          this.inputBindingViews(scene),
          () => this.rasterInputState(),
          (main, shadows) => this.acceptRasterInputs(main, shadows),
        ),
    });
  }

  static forDevice(
    device: RhiDevice,
    shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ): GpuDrivenProduction {
    return new GpuDrivenProduction(device, shaderModuleFactory);
  }

  /** Actual material/geometry projection for prospective demand, without a View update or draw. */
  prepareInitialPlan(
    input: GpuDrivenPrepareInput,
    current: () => boolean,
  ): Result<
    { readonly main: SubmissionPlan; readonly shadow?: SubmissionPlan },
    RhiError | GpuDrivenPreparationError
  > {
    const invalid = () =>
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one idle original Production and current prospective input',
          hint: 'retry the original Source demand outside recording',
        }),
      );
    const scene = input.scene;
    if (
      this.disposed ||
      this.residentPreparing ||
      this.resourceFrames.size !== 0 ||
      scene === undefined
    )
      return invalid();
    this.residentPreparing = true;
    try {
      if (!current() || this.disposed || this.resourceFrames.size !== 0) return invalid();
      const result = readSourceResources(this.resourceFrames, scene.scene, (resources) =>
        this.projectInitialPlan(input, scene, resources, current),
      );
      if (result === undefined || !current() || this.disposed || this.resourceFrames.size !== 0)
        return invalid();
      return result;
    } finally {
      this.residentPreparing = false;
    }
  }

  private projectInitialPlan(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    resources: GpuSceneResourceFrame,
    current: () => boolean,
  ): Result<
    { readonly main: SubmissionPlan; readonly shadow?: SubmissionPlan },
    RhiError | GpuDrivenPreparationError
  > {
    const prepared = this.assemblePrepared(
      scene,
      resources,
      'forward',
      input.batchExecutions,
      input.meshByBinding,
    );
    if (!prepared.ok) return prepared;
    const filtered = this.filterFrame(input, scene, resources, prepared.value);
    if (filtered === undefined || !current() || this.disposed)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'current nonempty prospective material execution',
          hint: 'prepare the actual target consumers before accepting',
        }),
      );
    const sealed = resources.seal();
    if (!sealed.ok) return sealed;
    return ok({
      main: prospectiveMainRaster(input, filtered.filtered).plan,
      ...(filtered.shadowFiltered === undefined ? {} : { shadow: filtered.shadowFiltered.plan }),
    });
  }

  /** Native main graph construction only; no View update, target draw or frame read survives. */
  prepareMainGraphProjection(
    input: GpuDrivenPrepareInput,
    view: GpuDrivenView,
    current: () => boolean,
  ): Result<NativeMainGraphPreparation, RhiError | GpuDrivenPreparationError> {
    return prepareNativeMainGraph(this.sourceRasters, input, view, current, {
      owns: (candidate) =>
        !this.disposed && (this.view === candidate || this.initialViews.view === candidate),
      available: () => !this.residentPreparing && this.resourceFrames.size === 0,
      raster: () => this.materialRaster,
      shadows: () => this.shadowBatchProjections,
      prepare: (scene, pipeline, visible, live) => {
        this.residentPreparing = true;
        try {
          return readSourceResources(this.resourceFrames, scene.scene, (resources) =>
            this.prepareMainGraphFrame(input, scene, resources, pipeline, view, visible, live),
          );
        } finally {
          this.residentPreparing = false;
        }
      },
      signatures: (frame) => this.graphProjectionSignatures(frame, true),
      projectCamera: (frame, target) => this.projectCameraRaster(target, () => frame, true),
      project: (frame, args) => {
        const [graph, format, samples, surface, additional, late, recording] = args;
        return this.projectGraph(
          frame,
          graph,
          format,
          samples,
          surface,
          additional,
          late ?? false,
          recording ?? false,
        );
      },
    });
  }

  private prepareMainGraphFrame(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    resources: GpuSceneResourceFrame,
    pipeline: PipelineState,
    view: GpuDrivenView,
    visible: Buffer,
    current: () => boolean,
  ): Result<RasterProjectionFrame, RhiError | GpuDrivenPreparationError> {
    const prepared = this.assemblePrepared(
      scene,
      resources,
      'forward',
      input.batchExecutions,
      input.meshByBinding,
    );
    if (!prepared.ok) return prepared;
    const filtered = this.filterFrame(input, scene, resources, prepared.value);
    if (filtered === undefined || !current())
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'current prospective main batches',
          hint: 'reprepare the current Source',
        }),
      );
    const main = prospectiveMainRaster(input, filtered.filtered);
    const raster = this.ensureMaterialRaster(
      input,
      pipeline,
      main,
      filtered.shadowFiltered,
      visible,
    );
    if (!raster.ok) return raster;
    const skinRaster = this.ensureSkinRaster(
      input,
      pipeline,
      main,
      filtered.shadowFiltered,
      visible,
      raster.value,
    );
    if (!skinRaster.ok) return skinRaster;
    bindSceneTables(raster.value, scene, view);
    if (skinRaster.value !== undefined) bindSceneTables(skinRaster.value, scene, view);
    const pool = this.sourceShadowPool();
    resources.seal().unwrap();
    return ok({
      input,
      scene,
      materialPipelineState: pipeline,
      filtered: main,
      shadowFiltered: filtered.shadowFiltered,
      liveRasterBatches: projectLiveRaster(
        undefined,
        main,
        visible,
        raster.value.visibleBindingIdentity,
        skinRaster.value?.visibleBindingIdentity,
      ).value,
      view,
      shadowViewPool: pool,
      materialRaster: raster.value,
      skinRaster: skinRaster.value,
      viewClipping: shadowViewClipping(input.camera),
      viewClippingLive: (input.camera.clipping?.planes.length ?? 0) > 0,
    });
  }

  /** First native View only. This prepares storage, not complete Pass or Level readiness. */
  prepareInitialViewStorage(...args: Parameters<InitialViewPreparationOwner['prepare']>) {
    return this.initialViews.prepare(...args);
  }

  sourceShadowPool(): ShadowViewStatePool {
    this.shadowViews ??= ShadowViewStatePool.create({
      device: this.device,
      shaderModuleFactory: this.shaderModuleFactory,
    }).unwrap();
    return this.shadowViews;
  }

  prepareSourceShadowStorage(
    identity: ShadowViewIdentity,
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
  ) {
    const pool = this.sourceShadowPool();
    return pool.prepareSourceView(identity, plan, scene, current, (storage) =>
      prepareProductionStorageInputs(
        scene,
        storage,
        this.inputBindingViews(scene),
        () => this.rasterInputState(),
        (main, shadows) => this.acceptRasterInputs(main, shadows),
      ),
    );
  }

  /** Prospective class/layer data only; no target View update or execution clock change. */
  prepareSourceShadowLayers(input: GpuDrivenPrepareInput, requests: readonly ShadowViewRequest[]) {
    const scene = input.scene;
    if (scene === undefined) throw new Error('Source shadow layers require their original Scene');
    let classes: ReturnType<ShadowCasterClassifier['preview']> | undefined;
    const layers: ShadowViewRequest[] = [];
    const channelRoots = new Map<number, FrameSet>();
    for (const request of requests) {
      const captured = { ...request };
      const mask = captured.casterChannels ?? 0xffffffff;
      const single = captured.staticLayer === false;
      if (!single) classes ??= this.shadowCasterClasses.preview(scene, scene.scene);
      if ((single || mask !== 0xffffffff) && !channelRoots.has(mask))
        channelRoots.set(mask, this.shadowChannelSlots.select(mask, scene, scene.scene));
      const selected = shadowLayerRequests(
        restrictShadowCasterChannels(captured, this.shadowChannelSlots, {
          scene,
          shadowScene: scene.scene,
        }),
        single ? undefined : classes,
      );
      if (selected.static !== undefined) layers.push(selected.static);
      layers.push(selected.final);
    }
    const layoutCurrent =
      classes === undefined ? undefined : this.shadowCasterClasses.preparationCurrent(classes);
    const current = () => {
      if (layoutCurrent?.() === false) return false;
      for (const [mask, slots] of channelRoots)
        if (this.shadowChannelSlots.select(mask, scene, scene.scene) !== slots) return false;
      return true;
    };
    return { layers, current };
  }

  prepareSourceShadowTopology(...args: Parameters<ShadowViewStatePool['prepareSourceLayer']>) {
    if (this.shadowViews === undefined)
      throw new Error('Prepare the original shadow storage first');
    return this.shadowViews.prepareSourceLayer(...args);
  }

  settleInitialViewRetirement(): Promise<Result<void, RhiError>> {
    return this.initialViews.settleInitialViewRetirement();
  }

  /** Existing owned View/raster demand only; other Productions remain separate. */
  prepareInputBindings(
    scene: GpuScene,
    input: GpuSceneInputPreparation,
    current?: () => boolean,
    tables?: GpuSceneTableBindingTarget,
    materialTables?: MaterialTableBindingPreparation,
  ): Result<GpuViewInputPreparation, RhiError> {
    if (
      this.disposed ||
      this.residentPreparing ||
      this.resourceFrames.size !== 0 ||
      this.inputBindingPreparation !== undefined
    )
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one idle Production View input preparation',
          hint: 'finish recording or release its previous preparation',
        }),
      );
    const views = this.inputBindingViews(scene);
    let building = true;
    this.residentPreparing = true;
    try {
      const created = prepareProductionInputBindings(
        scene,
        input,
        views,
        () =>
          (current === undefined || current()) &&
          !this.disposed &&
          this.resourceFrames.size === 0 &&
          (building || !this.residentPreparing) &&
          sameInputViews(views, this.inputBindingViews(scene)),
        (task) => {
          if (this.inputBindingPreparation === task) this.inputBindingPreparation = undefined;
        },
        () => this.rasterInputState(),
        (main, shadows) => this.acceptRasterInputs(main, shadows),
        tables,
        materialTables,
      );
      if (created.ok) this.inputBindingPreparation = created.value;
      return created;
    } finally {
      building = false;
      this.residentPreparing = false;
    }
  }

  private rasterInputState(): ProductionRasterInputs {
    return {
      rigid: this.materialRaster,
      skin: this.skinRaster,
      main: this.liveRasterCache,
      shadows: this.shadowBatchProjections,
      shadowSources: this.shadowProjectionSources,
      unchanged: this.shadowUnchangedInputs,
      retained: this.retainedEncodes,
    };
  }
  private acceptRasterInputs(
    main: ProductionRasterInputs['main'],
    shadows: ProductionRasterInputs['shadows'],
  ): void {
    this.liveRasterCache = main;
    this.shadowBatchProjections = shadows;
  }

  inputBindingViews(scene: GpuScene): readonly GpuDrivenView[] {
    return [
      ...new Set([
        ...(this.view?.ownsInputScene(scene) === true ? [this.view] : []),
        ...(this.initialViews.view?.ownsInputScene(scene) === true ? [this.initialViews.view] : []),
        ...(this.shadowViews?.inputBindingViews(scene) ?? []),
      ]),
    ];
  }

  currentInputBindings(scene: GpuScene, input: Buffer): boolean {
    const views = this.inputBindingViews(scene);
    return (
      !this.disposed &&
      views.length > 0 &&
      views.every((view) => view.currentInputBindings(scene, input)) &&
      [this.materialRaster, this.skinRaster].every(
        (raster) =>
          raster === undefined ||
          ['unused', 'current'].includes(raster.inputBindingState(scene.inputs)),
      )
    );
  }

  /** Group-scoped work units; App still owns outer-frame admission and complete Render readiness. */
  createResidentPreparation(
    input: ResidentRowPreparationInput,
  ): Result<ResidentRowPreparation, RhiError | GpuDrivenPreparationError> {
    if (this.disposed || this.residentPreparing || this.resourceFrames.size !== 0)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a live idle owner for resident task creation',
          hint: 'finish ordinary recording before creating resident work',
        }),
      );
    this.residentPreparing = true;
    try {
      const created = createResidentRowPreparation(
        {
          alive: () => !this.disposed,
          available: () =>
            !this.disposed && !this.residentPreparing && this.resourceFrames.size === 0,
          prepare: (contribution) => this.prepareResidentBatch(contribution),
          accept: (set) => this.acceptResidentBatches(set),
          finished: (task) => this.residentRowTasks.delete(task),
        },
        input,
      );
      if (!created.ok) return created;
      if (this.disposed) {
        created.value.release();
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'a live owner after resident task creation',
            hint: 'discard terminated work',
          }),
        );
      }
      this.residentRowTasks.add(created.value);
      return created;
    } finally {
      this.residentPreparing = false;
    }
  }

  /** One off-frame contribution. Successful facts remain provisional, not Ready. */
  prepareResidentBatch(
    input: ResidentBatchPreparationInput,
  ): Result<ProvisionalBatchContribution, RhiError | GpuDrivenPreparationError> {
    if (this.disposed || this.residentPreparing || this.resourceFrames.size !== 0)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a live idle GPU preparation owner at an exclusive maintenance boundary',
          hint: 'finish the ordinary recording before advancing a resident contribution',
        }),
      );
    this.residentPreparing = true;
    try {
      const observed = { ...input };
      const scope = {
        ...observed,
        isCurrent: () => {
          if (this.disposed) return false;
          const current = observed.isCurrent.call(input) === true;
          return current && !this.disposed;
        },
      };
      const preparation = this.preparations[observed.pass];
      const result = BatchRowAssembly.prepareContribution(preparation, scope);
      if (!result.ok) return result;
      const filtered =
        observed.pass === 'forward' ? this.mainFilterContributions : this.shadowFilterContributions;
      const staged = filtered.prepareContribution({
        taskContext: { scene: observed.scene.scene, device: this.device },
        plan: observed.plan,
        index: observed.index,
        row: result.value.kind === 'provisional' ? result.value.row : undefined,
        isCurrent: () => BatchRowAssembly.isCurrentContribution(preparation, scope, result.value),
      });
      if (!staged.ok) return staged;
      if (observed.pass === 'forward') this.filteredCache = undefined;
      else this.shadowFilteredCache = undefined;
      return result;
    } finally {
      this.residentPreparing = false;
    }
  }

  /** Accept exact issued contributions in one read domain and retain its Scene versions. */
  acceptResidentBatches(
    input: ResidentBatchSetInput,
  ): Result<HeldResidentBatchRows, RhiError | GpuDrivenPreparationError> {
    if (this.disposed || this.residentPreparing || this.resourceFrames.size !== 0)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a live idle GPU preparation owner for resident row acceptance',
          hint: 'finish the ordinary recording before accepting resident rows',
        }),
      );
    this.residentPreparing = true;
    try {
      const observed = { ...input };
      const accepted = BatchRowAssembly.acceptContributions(this.preparations, {
        ...observed,
        isCurrent: () => {
          if (this.disposed) return false;
          const current = observed.isCurrent.call(input) === true;
          return current && !this.disposed;
        },
      });
      if (!accepted.ok) return accepted;
      const raw = accepted.value;
      const held: HeldResidentBatchRows = Object.freeze({
        forward: raw.forward,
        shadow: raw.shadow,
        isCurrent: () => !this.disposed && raw.isCurrent() && !this.disposed,
        release: () => {
          raw.release();
          this.residentRowHolds.delete(held);
        },
      });
      this.residentRowHolds.add(held);
      if (this.disposed) {
        held.release();
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'a live owner after resident row acceptance',
            hint: 'discard this terminated preparation owner',
          }),
        );
      }
      return ok(held);
    } finally {
      this.residentPreparing = false;
    }
  }

  prepare(
    input: GpuDrivenPrepareInput,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    if (this.disposed || this.residentPreparing || this.resourceFrames.size !== 0)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'finish the unsubmitted GPU preparation before preparing another frame',
          hint: 'submit or abort the existing recording; game asset edits remain independent',
        }),
      );
    const sources = input.scene?.residentExecution?.sourceGroups ?? input.scene?.plan.sourceGroups;
    try {
      if (sources !== undefined) input.scene?.scene.inputs.adoptSources(sources);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
    const captured = input.scene?.scene.captureResources();
    if (captured !== undefined && !captured.ok) return captured;
    const materials = captured?.value;
    if (materials !== undefined) this.resourceFrames.add(materials);
    let retained = false;
    try {
      const result = this.prepareFrame(input, materials);
      if (result.ok && result.value !== undefined) {
        retained = true;
      }
      return result;
    } catch (cause) {
      if (cause instanceof GpuDrivenPreparationError) return err(cause);
      throw cause;
    } finally {
      if (!retained && materials !== undefined) {
        this.shadowViews?._closeInputReads();
        this.resourceFrames.delete(materials);
        materials.release();
      }
    }
  }

  private prepareFrame(
    input: GpuDrivenPrepareInput,
    materials: GpuSceneResourceFrame | undefined,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    this.resetFrameObservation(input);
    if (
      input.scene === undefined ||
      (input.hdrp === true && input.clustered !== true) ||
      selectGpuLodLane(this.device.caps) === 'cpu'
    ) {
      this.gpuOwnedEntityCount = 0;
      this.releaseCameraRoster();
      return ok(undefined);
    }
    const recovered = this.recoverFromOverflow();
    if (!recovered.ok) return recovered;
    const scene = input.scene;
    if (materials === undefined)
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'the captured GPU Scene resource frame',
          hint: 'capture the Scene read domain before GPU preparation',
        }),
      );
    const materialPipelineState = input.materialPipelineState;
    if (materialPipelineState === undefined) return this.missingMaterialPipelineState(input);
    const direct = input.geometryLane === 'direct' && !requiresGpuSurfacePreparation(input);
    const resident = scene.residentExecution ?? scene.plan;
    if (direct && isIssuedExecution(scene.plan, resident)) {
      const preparation = this.preparations.forward;
      preparation.retireAbsent(resident);
      preparation.cached = undefined;
      const admission = runRecordProfilePhase(
        input.profilePhase,
        'record/gpu-driven-prepare/plan',
        () => admitDirectResources(scene, materials, input.batchExecutions, input.meshByBinding),
      );
      if (!admission.ok) {
        this.blockPlanAssembly(scene, admission.error);
        return admission;
      }
      return this.prepareDirectFrame(scene, materials, admission.value);
    }
    const rebuilt = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/plan',
      () =>
        this.assemblePrepared(
          scene,
          materials,
          'forward',
          input.batchExecutions,
          input.meshByBinding,
          input.profilePhase,
        ),
    );
    if (!rebuilt.ok) {
      this.blockPlanAssembly(scene, rebuilt.error);
      return rebuilt;
    }
    const preparedPlan = rebuilt.value;
    if (direct)
      return this.prepareDirectFrame(
        scene,
        materials,
        preparedPlan.batchRows.some((row) => row.fact !== undefined),
      );
    const filterStage = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter',
      () => this.filterFrame(input, scene, materials, preparedPlan),
    );
    if (filterStage === undefined) {
      this.releaseCameraRoster();
      this.laneReason = 'unsupported';
      return ok(undefined);
    }
    return this.prepareGpuFrame(input, scene, materials, materialPipelineState, filterStage);
  }

  private releaseCameraRoster(): void {
    this.liveRasterCache = undefined;
    this.liveRasterBatches = NO_CAMERA_BATCHES;
    this.currentRasterFrame = undefined;
  }

  /** Per-frame observation restarts before any lane decision. */
  private resetFrameObservation(input: GpuDrivenPrepareInput): void {
    this.pendingDrawSummary = undefined;
    this.surfaceArtifactInspection = undefined;
    this.retainedEncodes.beginFrame();
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.preparedBatchBuilds = 0;
    this.filteredBatchBuilds = 0;
    this.planRebuildBatches = 0;
    this.preparedAssemblyHits = 0;
    this.planRebuildCandidates = 0;
    this.batchBindGroupCreates = 0;
    this.validatedGpuOwnedRows = 0;
    this.cpuFallbackDrawItems = 0;
    this.cpuSemanticFallbackDrawItems = 0;
    this.cpuDeformationFallbackDrawItems = 0;
    this.cpuDeformationReasons.clear();
    this.blockedDrawItems = 0;
    this.preparationFailure = undefined;
    this.encodedIndirectDraws = 0;
    this.telemetryPrepared = false;
    this.telemetryCandidateCount = input.telemetryCandidateCount ?? 0;
    this.telemetryGeometryWork = 0;
    this.telemetryRootGeometryWork = 0;
    this.telemetryOverflow = false;
    this.indirectDrawCount = 0;
    this.gpuOwnedDrawItems = 0;
    this.mainTotalDrawItems = 0;
    this.structureMetrics = input.structureMetrics ?? {
      worldEntitiesScanned: 0,
      sceneTableUploadBytes: 0,
    };
    this.lane = 'cpu-semantic';
    this.laneReason = 'capability';
    this.submissionState = 'idle';
    this.surfaceSubmission = undefined;
  }

  private recoverFromOverflow(): Result<void, RhiError> {
    if (!this.overflowRecoveryRequired || this.view === undefined) return ok(undefined);
    const recovered = this.view._recoverFromOverflow();
    if (!recovered.ok) {
      this.gpuOwnedEntityCount = 0;
      this.lane = 'blocked';
      this.laneReason = 'capacity';
      return recovered;
    }
    this.overflowRecoveryRequired = false;
    return ok(undefined);
  }

  /** Without producer pipeline state, any GPU-routed execution blocks the frame. */
  private missingMaterialPipelineState(
    input: GpuDrivenPrepareInput,
  ): Result<undefined, GpuDrivenPreparationError> {
    let required = false;
    for (const execution of input.batchExecutions.values()) {
      if (execution.forward.route === 'gpu' || execution.shadow.route === 'gpu') {
        required = true;
        break;
      }
    }
    if (!required) return ok(undefined);
    this.lane = 'blocked';
    this.laneReason = 'resource-not-ready';
    const failure = new GpuDrivenPreparationError('resource-not-ready', {
      reason: 'material-resource-missing',
      owner: 'material',
      expected: 'producer-owned GPU-driven material pipeline state',
    });
    this.preparationFailure = preparationFailureInspection(failure);
    return err(failure);
  }

  private blockPlanAssembly(scene: PersistentGpuDrivenState, error: GpuDrivenPreparationError) {
    this.gpuOwnedEntityCount = 0;
    this.lane = 'blocked';
    this.laneReason = 'resource-not-ready';
    this.blockedDrawItems = scene.plan.batches.reduce(
      (total, batch) => total + batch.candidates.length,
      0,
    );
    this.preparationFailure = preparationFailureInspection(error);
  }

  private finishMaterials(materials: GpuSceneResourceFrame): boolean {
    if (!this.resourceFrames.delete(materials)) return false;
    materials.release();
    return true;
  }

  private sealResourceReads(materials: GpuSceneResourceFrame): Result<void, RhiError> {
    try {
      return materials.seal();
    } finally {
      this.shadowViews?._closeInputReads();
    }
  }

  /**
   * Direct commands consume the ordinary validated meshes and scene material
   * table. Receipt/mesh admission still ran, but none of the filtered
   * indirect plan, cull buffers or scene-index raster bindings is consumed.
   * Surface retains the complete shared page/frame/instance preparation.
   */
  private prepareDirectFrame(
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
    usesSceneTable: boolean,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError> {
    this.gpuOwnedEntityCount = 0;
    this.laneReason = 'unsupported';
    // Main grouping has no shadow claim filter: every admitted draw has
    // a candidate group. Preserve its empty/CPU-only resource fallback.
    this.releaseCameraRoster();
    if (!usesSceneTable) return ok(undefined);
    this.shadowSource = undefined;
    this.shadowScene = undefined;
    this.disableShadowViews();
    const view = this.view;
    const shadowViews = this.shadowViews;
    return ok({
      materialBindings: [],
      topologySignature: DIRECT_TOPOLOGY_SIGNATURE,
      selection: EMPTY_GPU_DRAW_SELECTION,
      shadowDirectRequired: true,
      standardPbrFrameResources: {
        prepareMaterialBinding: () => undefined,
        materialSlotIndicesByBinding: EMPTY_MATERIAL_BINDING_SLOTS,
        sceneMaterialBuffer: scene.scene.materialBuffer,
      },
      ...(shadowViews === undefined ? {} : { shadowViewPool: shadowViews }),
      _trackSubmittedWork: (completed) => materials.submit(completed, 'queue-order'),
      _sealResourceReads: () => this.sealResourceReads(materials),
      _commitResourceReplacement: () => {
        if (!this.finishMaterials(materials)) return;
        // A successful direct graph releases the superseded GPU graph's
        // imports and shadows. It does not submit a new GPU geometry generation.
        view?._commitResourceReplacement();
        shadowViews?._commitResourceReplacement();
      },
      _abortResourceReplacement: () => {
        if (!this.finishMaterials(materials)) return;
        shadowViews?._abortResourceReplacement();
      },
      project: () =>
        err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'an automatic geometry preparation before projecting indirect work',
            hint: 'record the selected direct frame through its ordinary CPU draw commands',
          }),
        ),
    });
  }

  private filterFrame(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
    preparedPlan: PreparedProductionPlan,
  ): FilteredFrame | undefined {
    const filtered = this.mainFilteredPlan(input, preparedPlan, scene);
    runRecordProfilePhase(input.profilePhase, 'record/gpu-driven-prepare/filter/counts', () => {
      this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
    });
    const shadowFiltered =
      input.shadowViews === true ? this.shadowFilteredPlan(input, scene, materials) : undefined;
    if (
      filtered.batches.length === 0 &&
      (shadowFiltered?.batches.length ?? 0) === 0 &&
      input.directSurface === undefined &&
      !this.sourceRasters.keepsEmptyView(this.view, this.materialRaster)
    )
      return undefined;
    const admission = this.submissionAdmission(input, scene);
    this.admissionCache = admission;
    return { preparedPlan, filtered, admission, shadowFiltered };
  }

  /**
   * Empty ordinary bindings cannot change a retained prepared plan. Nonempty
   * maps still check their admitted values; raw inputs retain their complete
   * observation fence and custom-get behavior.
   */
  private mainFilteredPlan(
    input: GpuDrivenPrepareInput,
    preparedPlan: PreparedProductionPlan,
    scene: PersistentGpuDrivenState,
  ): FilteredProductionPlan {
    const cached = this.filteredCache;
    if (cached?.prepared === preparedPlan && cached.bindings === input.materialBindingClasses)
      return cached.value;
    const profile = input.profilePhase;
    const filtered = runRecordProfilePhase(
      profile,
      'record/gpu-driven-prepare/filter/main-plan',
      () =>
        this.mainFilterContributions.update(
          preparedPlan,
          input.materialBindingClasses,
          profile === undefined
            ? undefined
            : (part, action) => runRecordProfilePhase(profile, mainPlanPhase(part), action),
          { scene: scene.scene, device: this.device },
        ).active,
    );
    this.filteredPlanBuilds = Number(filtered !== cached?.value);
    this.filteredCache = {
      prepared: preparedPlan,
      bindings: input.materialBindingClasses,
      value: filtered,
    };
    this.filteredBatchBuilds += this.mainFilterContributions.lastWork.projectedBatches;
    return filtered;
  }

  private shadowFilteredPlan(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
  ): FilteredProductionPlan {
    const profile = input.profilePhase;
    const shadowPrepared = this.assemblePrepared(
      scene,
      materials,
      'shadow',
      input.batchExecutions,
      input.meshByBinding,
      profile,
    ).unwrap();
    const cached = this.shadowFilteredCache;
    if (cached?.prepared === shadowPrepared) return cached.value;
    const shadowFiltered = runRecordProfilePhase(
      profile,
      'record/gpu-driven-prepare/filter/shadow-plan',
      () =>
        this.shadowFilterContributions.update(
          shadowPrepared,
          undefined,
          profile === undefined
            ? undefined
            : (part, action) => runRecordProfilePhase(profile, shadowPlanPhase(part), action),
          { scene: scene.scene, device: this.device },
        ).active,
    );
    this.filteredBatchBuilds += this.shadowFilterContributions.lastWork.projectedBatches;
    this.shadowFilteredCache = { prepared: shadowPrepared, value: shadowFiltered };
    return shadowFiltered;
  }

  /** Admission facts are recomputed only when the active entity set changes. */
  private submissionAdmission(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
  ): SubmissionAdmission {
    return runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter/admission',
      () => submissionAdmission(scene, input, this.admissionCache),
    );
  }

  private prepareGpuFrame(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
    materialPipelineState: PipelineState,
    { preparedPlan, filtered, admission, shadowFiltered }: FilteredFrame,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    const surfaceArtifact =
      filtered.materialBatches.find(({ artifact }) => isSingleLayerMediumArtifact(artifact))
        ?.artifact ?? input.directSurface?.artifact;
    this.surfaceArtifactInspection = surfaceArtifactInspection(surfaceArtifact);
    if (surfaceArtifact !== undefined) {
      const admitted = this.admitSurfaceSubmission(surfaceArtifact, input);
      if (!admitted.ok) return admitted;
    }
    this.lane = 'gpu';
    this.laneReason = 'none';
    this.submissionState = 'pending';
    this.shadowSource = shadowFiltered;
    this.shadowScene = scene.scene;
    const owners = this.ensureViewOwners();
    if (!owners.ok) return owners;
    const view = owners.value;
    const visibleBuffer = this.updateMainView(view, input, scene, materials, filtered, admission);
    if (!visibleBuffer.ok) return visibleBuffer;
    const materialRaster = this.ensureMaterialRaster(
      input,
      materialPipelineState,
      filtered,
      shadowFiltered,
      visibleBuffer.value,
    );
    if (!materialRaster.ok) return materialRaster;
    const skinRaster = this.ensureSkinRaster(
      input,
      materialPipelineState,
      filtered,
      shadowFiltered,
      visibleBuffer.value,
      materialRaster.value,
    );
    if (!skinRaster.ok) return skinRaster;
    // Visible windows bind the whole GPU Scene instance and primitive tables;
    // rebinding follows table growth, never per-frame row content.
    bindSceneTables(materialRaster.value, scene, view);
    if (skinRaster.value !== undefined) bindSceneTables(skinRaster.value, scene, view);
    if (this.surfaceSubmission !== undefined) {
      const surfaceInput = this.prepareSurfaceInput(
        input,
        scene,
        filtered,
        materialRaster.value,
        skinRaster.value,
        surfaceArtifact?.receipt?.surface?.dynamicInput?.layout,
      );
      if (!surfaceInput.ok) return surfaceInput;
    }
    const shadowViewPool = this.shadowViews;
    if (shadowViewPool === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'ShadowViewStatePool after GPU-driven preparation',
          hint: 'publish view-keyed shadow state with the prepared frame',
        }),
      );
    }
    // Shadow depth bakes the camera clipping casters opt into. A retained
    // layer, including one that survives a graph recompile, must not keep it.
    const viewClipping = shadowViewClipping(input.camera);
    if (viewClipping !== this.committedViewClipping) shadowViewPool.invalidateViewClipping();
    this.liveRasterCache = projectLiveRaster(
      this.liveRasterCache,
      filtered,
      visibleBuffer.value,
      materialRaster.value.visibleBindingIdentity,
      skinRaster.value?.visibleBindingIdentity,
      (prepared) =>
        this.sourceRasters.borrow(
          prepared,
          visibleBuffer.value,
          materialRaster.value.visibleBindingIdentity,
          skinRaster.value?.visibleBindingIdentity,
        ),
    );
    this.liveRasterBatches = this.liveRasterCache.value;
    this.beginGBufferOrderDiagnostic(input, scene);
    return ok(
      this.publishGpuFrame({
        input,
        scene,
        materials,
        materialPipelineState,
        preparedPlan,
        filtered,
        shadowFiltered,
        liveRasterBatches: this.liveRasterBatches,
        view,
        shadowViewPool,
        materialRaster: materialRaster.value,
        skinRaster: skinRaster.value,
        viewClipping,
        // Camera planes keep the Standard view clipping discard; a toggle recompiles.
        viewClippingLive: (input.camera.clipping?.planes.length ?? 0) > 0,
      }),
    );
  }

  /** A published Surface ABI admits the frame only when its device and inputs are ready. */
  private admitSurfaceSubmission(
    artifact: MaterialShaderArtifact,
    input: GpuDrivenPrepareInput,
  ): Result<void, GpuDrivenPreparationError> {
    const receipt = artifact.receipt;
    const surface = receipt?.surface;
    if (receipt === undefined || surface === undefined) return ok(undefined);
    const deviceGeneration = input.deviceGeneration ?? 1;
    const admitted = admitSingleLayerMediumSubmission({
      abi: receipt,
      caps: {
        compute: this.device.caps.compute,
        storageBuffer: this.device.caps.storageBuffer,
        indirectDrawing: this.device.caps.indirectDrawing,
      },
      sceneIndexReady: receipt.sceneIndexEntry !== undefined,
      resourcesReady: receipt.reflection.layoutIdentity === artifact.layoutIdentity,
      dynamicInputReady:
        surface.dynamicInput === undefined || input.surfaceDynamicInput !== undefined,
      deviceGeneration,
      preparedDeviceGeneration: deviceGeneration,
    });
    if (!admitted.ok) {
      this.lane = 'blocked';
      this.laneReason = 'resource-not-ready';
      const failure = new GpuDrivenPreparationError('resource-not-ready', {
        reason: 'material-resource-missing',
        owner: 'material',
        expected: admitted.error.expected,
        actual: JSON.stringify(admitted.error.actual),
      });
      this.preparationFailure = preparationFailureInspection(failure);
      return err(failure);
    }
    this.surfaceSubmission = admitted.value;
    return ok(undefined);
  }

  private ensureViewOwners(): Result<GpuDrivenView, RhiError> {
    if (this.shadowViews === undefined) {
      const created = ShadowViewStatePool.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.shadowViews = created.value;
    }
    if (this.view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.view = created.value;
    }
    this.initialViews.consume(this.view);
    return ok(this.view);
  }

  /** Upload the filtered plan to the main view and return its visible-index buffer. */
  private updateMainView(
    view: GpuDrivenView,
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
    filtered: FilteredProductionPlan,
    admission: SubmissionAdmission,
  ): Result<Buffer, RhiError> {
    const surfaceRows = surfaceVisibleRows(filtered.plan, scene, input.visibleSurface);
    // This bitmap belongs to this camera's main view only. Do not mutate the
    // scene admission or shadow-view bitmap: another camera still sees the row.
    const suppressed = mainLayerSuppression(scene, input.camera, admission.suppressed);
    const updated = view.update(
      filtered.plan,
      scene.scene,
      materials.inputReads(),
      activeFrustum(input.camera),
      input.camera,
      0,
      suppressed,
      undefined,
      occlusionCamera(input.camera),
      surfaceRows,
      undefined,
      scene.skin,
    );
    if (!updated.ok) return updated;
    view.setTelemetrySubmit(input.telemetrySubmit);
    this.telemetryPrepared = true;
    const visibleBuffer = view.visibleBuffer;
    if (visibleBuffer === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'GpuDrivenView visible buffer after update',
          hint: 'keep the visible-index binding request on the updated GPU scene view',
        }),
      );
    }
    return ok(visibleBuffer);
  }

  private ensureMaterialRaster(
    input: GpuDrivenPrepareInput,
    pipelineState: PipelineState,
    filtered: FilteredProductionPlan,
    shadowFiltered: FilteredProductionPlan | undefined,
    visibleBuffer: Buffer,
  ): Result<MaterialAbiRasterAdapter, RhiError | GpuDrivenPreparationError> {
    const representativeArtifact =
      filtered.materialBatches[0]?.artifact ??
      shadowFiltered?.materialBatches[0]?.artifact ??
      input.directSurface?.artifact;
    if (
      representativeArtifact === undefined &&
      this.materialRaster !== undefined &&
      this.sourceRasters.keepsEmptyView(this.view, this.materialRaster)
    )
      return rebindRaster(this.materialRaster, input, visibleBuffer);
    if (representativeArtifact === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'one selected MaterialProgramAbi artifact for GPU-driven batches',
          hint: 'keep receipt-backed draws blocked until Catalog/load publishes their artifact',
        }),
      );
    }
    const probeBlendRequested = filtered.materialBatches.some(({ artifact }) =>
      requiresProbeBlendRecord(artifact),
    );
    if (probeBlendRequested && input.probeBlendRecordBuffer === undefined) {
      return err(
        new GpuDrivenPreparationError('resource-not-ready', {
          reason: 'material-resource-missing',
          owner: 'material',
          expected: 'the retained ProbeBlend record page for every scene-index probe draw',
          actual: 'the prepared frame did not publish its ProbeBlend record page',
          recovery: 'retry-same-draw',
        }),
      );
    }
    if (this.materialRaster !== undefined)
      return rebindRaster(this.materialRaster, input, visibleBuffer);
    const created = MaterialAbiRasterAdapter.create({
      device: this.device,
      pipelineState,
      artifact: representativeArtifact,
      visibleBuffer,
      ...(input.materialPipelineFactory === undefined
        ? {}
        : { pipelineFactory: input.materialPipelineFactory }),
      ...(input.probeBlendRecordBuffer === undefined
        ? {}
        : { probeBlendRecordBuffer: input.probeBlendRecordBuffer }),
    });
    if (!created.ok) return created;
    this.materialRaster = created.value;
    return created;
  }

  /** A retained skin adapter stays bound even on frames without skinned batches. */
  private ensureSkinRaster(
    input: GpuDrivenPrepareInput,
    pipelineState: PipelineState,
    filtered: FilteredProductionPlan,
    shadowFiltered: FilteredProductionPlan | undefined,
    visibleBuffer: Buffer,
    materialRaster: MaterialAbiRasterAdapter,
  ): Result<MaterialAbiRasterAdapter | undefined, RhiError | GpuDrivenPreparationError> {
    const skinBatch =
      filtered.batches.find(isSkinPreparedBatch) ??
      shadowFiltered?.batches.find(isSkinPreparedBatch);
    if (skinBatch === undefined) return ok(this.skinRaster);
    if (this.skinRaster !== undefined) return rebindRaster(this.skinRaster, input, visibleBuffer);
    const created = MaterialAbiRasterAdapter.create({
      device: this.device,
      pipelineState,
      artifact: skinBatch.artifact,
      visibleBuffer,
      deformation: 'skin',
      sharedSurfaceFrame: materialRaster.surfaceDynamicSharedFrameState,
      ...(input.probeBlendRecordBuffer === undefined
        ? {}
        : { probeBlendRecordBuffer: input.probeBlendRecordBuffer }),
      ...(input.materialPipelineFactory === undefined
        ? {}
        : { pipelineFactory: input.materialPipelineFactory }),
    });
    if (!created.ok) return created;
    this.skinRaster = created.value;
    return created;
  }

  /** Frame rows use full filtered candidate indices and are bound whole by both adapters. */
  private prepareSurfaceInput(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    filtered: FilteredProductionPlan,
    materialRaster: MaterialAbiRasterAdapter,
    skinRaster: MaterialAbiRasterAdapter | undefined,
    layout: MaterialDynamicInputLayout | undefined,
  ): Result<void, RhiError> {
    const directRanges = input.directSurface?.ranges;
    const projection = this.surfaceFrames.resolve(
      filtered,
      input.surfaceDynamicInput,
      scene,
      directRanges,
    );
    if (!projection.ok) return projection;
    const capacity = projection.value.capacity;
    const frameTime = input.surfaceDynamicInput?.frameTime ?? input.frameTime ?? 0;
    const deviceGeneration = input.deviceGeneration ?? 1;
    const ranges = projection.value.ranges;
    const surfaceInput = materialRaster.ensureSurfaceDynamicInput(
      input.surfaceDynamicInput,
      capacity,
      frameTime,
      layout,
      deviceGeneration,
      ranges,
      projection.value.addresses,
    );
    if (!surfaceInput.ok) return surfaceInput;
    if (skinRaster !== undefined) {
      const skinSurfaceInput = skinRaster.ensureSurfaceDynamicInput(
        input.surfaceDynamicInput,
        capacity,
        frameTime,
        layout,
        deviceGeneration,
        ranges,
        projection.value.addresses,
      );
      if (!skinSurfaceInput.ok) return skinSurfaceInput;
    }
    const committed = materialRaster.commitSurfaceDynamicInput();
    if (!committed.ok) return committed;
    if (skinRaster !== undefined) {
      const skinCommitted = skinRaster.commitSurfaceDynamicInput();
      if (!skinCommitted.ok) return skinCommitted;
    }
    this.surfaceFrames.remember(
      filtered,
      input.surfaceDynamicInput,
      scene,
      projection.value,
      directRanges,
    );
    return ok(undefined);
  }

  private beginGBufferOrderDiagnostic(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
  ): void {
    const mode = input.gbufferBatchOrderDiagnostic;
    this.gbufferOrderMode = mode;
    this.gbufferOrderMaterials = input.materialFrame;
    if (mode === undefined) {
      this.gbufferOrderView = undefined;
      this.gbufferOrderSlotAt = undefined;
      this.gbufferOrderEncodes = undefined;
      this.gbufferOrderInspection = undefined;
      return;
    }
    this.gbufferOrderView = gbufferDiagnosticView(input.camera);
    this.gbufferOrderSlotAt = scene.slotAt;
    this.gbufferOrderEncodes = [];
    this.gbufferOrderInspection = {
      mode: mode.order,
      eligibleBatches: 0,
      movedBatches: 0,
      status: 'not-encoded',
      encodes: this.gbufferOrderEncodes,
      denominator: { live: this.liveRasterBatches.length, selected: null },
      ...(input.telemetrySubmit === undefined
        ? {}
        : {
            preparation: {
              frameId: input.telemetrySubmit.frameId,
              deviceGeneration: input.telemetrySubmit.deviceGeneration,
            },
          }),
    };
  }

  /**
   * Publish one GPU-lane frame. Visible items address GPU Scene instance rows
   * directly: the vertex stage reads current/previous transforms, temporal
   * flags and material rows from the scene tables, so no per-batch row
   * projection exists.
   */
  private graphProjectionSignatures(
    frame: RasterProjectionFrame,
    source = false,
  ): Pick<
    GpuDrivenGraphProjection,
    'topologySignature' | '_recordingTopologySignature' | 'cameraRasterIdentity'
  > {
    const { input, scene, filtered, view, materialRaster, skinRaster } = frame;
    // The graph imports scene and view buffers live, so neither a replaced
    // material table nor grown view storage is a graph dependency: key the
    // raster graph on the view's pass-list generation only.
    const graphIdentity = this.rasterGraphIdentity.update(
      filtered,
      this.rasterGraphIdentity.sceneIdentity(scene.scene),
      view.graphResourceGeneration,
      frame.liveRasterBatches,
      materialRaster.visibleBindingIdentity,
      skinRaster?.visibleBindingIdentity,
    );
    const discardSignature = frame.viewClippingLive
      ? `|view-clipping${frame.input.camera.clipping?.caps === true ? '-caps' : ''}`
      : '';
    // Both independent lighting facts are fixed into the projected pipelines.
    const variantSignature = `${discardSignature}${input.directionalShadowSimple === true ? '|simple' : ''}${input.leanLighting === true ? '|lean' : ''}${input.forwardInlineSsr ? '|inline-ssr' : ''}`;
    const signature = `gpu:${getOpaqueResourceIdentity(graphIdentity.raw)}${variantSignature}`;
    const recordingSignature = `gpu:${getOpaqueResourceIdentity(graphIdentity.recording)}${variantSignature}`;

    return {
      cameraRasterIdentity: recordingSignature,
      topologySignature: () => {
        const shadow = source
          ? frame.shadowViewPool.sourceTopologySignature(scene.scene)
          : this.shadowTopologySignature();
        return shadow.length === 0 ? signature : `${signature}|shadow=${shadow}`;
      },
      _recordingTopologySignature: () => {
        const shadow = source
          ? frame.shadowViewPool.sourceTopologySignature(scene.scene)
          : this.shadowTopologySignature();
        return shadow.length === 0 ? recordingSignature : `${recordingSignature}|shadow=${shadow}`;
      },
    };
  }

  private publishGpuFrame(frame: PreparedRasterFrame): PreparedGpuDrivenFrame {
    this.currentRasterFrame = frame;
    const { input, scene, materials, filtered, view, shadowViewPool, materialRaster, skinRaster } =
      frame;
    const surfaceSubmission = this.surfaceSubmission;
    const consumeSurfaceDynamicInput =
      surfaceSubmission === undefined
        ? undefined
        : this.surfaceFrames.consumer(input.surfaceDynamicInput);
    return {
      materialBindings: filtered.materialBindings,
      ...this.graphProjectionSignatures(frame),
      // Shadow-only geometry still has a live production frame. It needs no camera
      // selection, depth pyramid or camera telemetry allocation.
      ...(input.geometryLane !== 'direct' &&
      (this.indirectDrawCount > 0 ||
        filtered.plan.batches.some((batch) => (batch.lod?.coverages.length ?? 0) > 0))
        ? { cameraView: view }
        : {}),
      captureCameraMeshes: () => this.liveRasterCache?.meshBindings.capture(),
      projectCamera: (target) => this.projectCameraRaster(target, () => this.currentRasterFrame),
      selection: filtered.selection,
      shadowSelection: frame.shadowFiltered?.selection,
      shadowDirectRequired: shadowDirectRequired(scene, input.batchExecutions),
      ...(surfaceSubmission === undefined ? {} : { surfaceSubmission }),
      standardPbrFrameResources: {
        resourceGeneration: view.currentResourceGeneration,
        prepareMaterialBinding: () => undefined,
        materialSlotIndicesByBinding: EMPTY_MATERIAL_BINDING_SLOTS,
        sceneMaterialBuffer: scene.scene.materialBuffer,
        ...(surfaceSubmission === undefined ? {} : this.surfaceFrameResources(materialRaster)),
      },
      _commitGpuResourceReplacement: () => {
        view._commitResourceReplacement();
      },
      _trackSubmittedWork: (completed) => materials.submit(completed),
      _sealResourceReads: () => this.sealResourceReads(materials),
      _commitResourceReplacement: (submittedGraphGeneration) => {
        if (!this.finishMaterials(materials)) return;
        view._commitResourceReplacement();
        shadowViewPool._commitResourceReplacement(submittedGraphGeneration);
        this.committedViewClipping = frame.viewClipping;
        this.submissionState = 'submitted';
        this.lastKnownGoodGeneration = view.currentResourceGeneration;
      },
      _abortResourceReplacement: () => {
        if (!this.finishMaterials(materials)) return;
        materialRaster.abortSurfaceDynamicInput();
        skinRaster?.abortSurfaceDynamicInput();
        shadowViewPool._abortResourceReplacement();
        this.submissionState = 'aborted';
        this.retryCount += 1;
      },
      ...(consumeSurfaceDynamicInput === undefined
        ? {}
        : { _consumeSurfaceDynamicInput: consumeSurfaceDynamicInput }),
      projectShadow: (graph, identity, forceCompute = false, cameraPyramid) => {
        if (!shadowViewPool.isActive(identity) || shadowViewPool.submission(identity) === undefined)
          return ok(undefined);
        return shadowViewPool.project(graph, identity, forceCompute, cameraPyramid, true);
      },
      updateShadowViews: (views, ownedRequests) =>
        this.updateFrameShadowViews(frame, views, ownedRequests),
      shadowViewPool,
      shadowBatchProjections: () => this.shadowBatchProjections,
      project: (
        graph,
        format,
        sampleCount,
        surfaceSubmissionObservation,
        additionalColorFormats,
        lateOcclusion = false,
        rendererRecording = false,
      ) =>
        this.projectGraph(
          frame,
          graph,
          format,
          sampleCount,
          surfaceSubmissionObservation,
          additionalColorFormats,
          lateOcclusion,
          rendererRecording,
        ),
    };
  }

  /**
   * Cache decisions, logical update generations and source-plan revisions are
   * frame-local producer state. They must not feed the compiled graph key:
   * shadow encode reads the submitted plan and batch projections from the
   * frame, compute dispatch sizes follow the uploaded plan, and a recompile
   * allocates fresh shadow targets that miss every view. Only the view's
   * resource generation (buffer capacity replacement) is a graph dependency.
   */
  private shadowTopologySignature(): string {
    return this.shadowViews?.topologySignature() ?? '';
  }

  private surfaceFrameResources(
    materialRaster: MaterialAbiRasterAdapter,
  ): Pick<GpuDrivenStandardPbrFrameResources, 'surfaceDynamicInput' | 'surfaceDirectInstances'> {
    return {
      surfaceDynamicInput: {
        page: materialRaster.surfaceDynamicInputBuffer,
        frame: materialRaster.surfaceDynamicFrameBuffer,
        sharedFrame: materialRaster.surfaceDynamicSharedFrameBuffer,
        pageBytes: materialRaster.surfaceDynamicInputBufferSize,
        frameBytes: materialRaster.surfaceDynamicFrameBufferSize,
        sharedFrameBytes: materialRaster.surfaceDynamicSharedFrameBufferSize,
      },
      surfaceDirectInstances: (directInput) =>
        this.surfaceFrames.directInstances(materialRaster, directInput),
    };
  }

  private updateFrameShadowViews(
    frame: PreparedRasterFrame,
    views: readonly ShadowViewRequest[],
    ownedRequests = false,
  ): Result<void, RhiError> {
    const { shadowFiltered, input } = frame;
    if (shadowFiltered === undefined || views.length === 0) return this.disableShadowViews();
    return this.updateShadowViews(
      views,
      shadowFiltered,
      input.batchExecutions,
      frame.scene,
      frame.materials.inputReads(),
      input.camera,
      input.capsuleShadowDirectional === true,
      input.materialFrame,
      input.shadowMaterials,
      input.profilePhase,
      ownedRequests,
    );
  }

  /** Native camera passes share device-owned scene/indirect buffers with selection.
   * Only attachment formats and the material ABI are needed to declare their raster state. */
  private projectCameraRaster(
    target: RenderPipelineGpuDrivenTarget,
    readFrame: () => RasterProjectionFrame | undefined,
    prospective = false,
  ): Result<CurrentCameraRaster, RenderGraphError | RhiError> {
    const frame = readFrame();
    if (frame === undefined)
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'an active GPU camera frame',
          hint: 'stage the current view before its physical draw',
        }),
      );
    const formats = [target.format, ...(target.additionalColorFormats ?? [])];
    const view = frame.view;
    const projected: ProjectedRasterGraph = {
      get frame() {
        const live = readFrame();
        if (live === undefined || live.view !== view)
          throw new RhiError({
            code: 'internal-error',
            expected: 'the active camera GPU scene when encoding a raster projection',
            hint: 'stage the current view before its physical draw',
          });
        return live;
      },
      target: {
        format: target.format,
        sampleCount: target.sampleCount,
        rendererRecording: true,
        colorFormats: formats,
        colorFormatKey: formats.join(','),
      },
      indirect: undefined,
      rasterClasses: new Map(),
      lateRegion: target.lateOcclusion
        ? {
            get indirectByteOffset() {
              return view.cameraLateIndirectOffset;
            },
            get visibleBase() {
              return view.cameraLateVisibleBase;
            },
          }
        : undefined,
    };
    const classes = this.projectRasterClasses(projected, undefined, []);
    if (!classes.ok) return classes;
    const raster = this.rasterProjection(projected, [], {});
    if (prospective) return ok(raster);
    let roster = frame.liveRasterBatches;
    const inspection = this.lateRasterClasses;
    let visit = true;
    return ok({
      ...raster,
      stageCameraClasses() {
        const current = projected.frame.liveRasterBatches;
        if (current === roster) return;
        roster = current;
        const classes = projected.rasterClasses;
        let kept = 0;
        for (const row of current) {
          const cls = classes.get(row.recordingClassKey);
          if (cls !== undefined && cls.cameraVisit !== visit) {
            cls.cameraVisit = visit;
            kept++;
          }
        }
        if (kept < classes.size) {
          inspection.retired += classes.size - kept;
          classes.forEach((cls, key) => {
            if (cls.cameraVisit !== visit) classes.delete(key);
          });
        }
        visit = !visit;
      },
    });
  }

  /** Graph-time projection: import buffers, compile raster classes, expose encode. */
  private projectGraph(
    frame: RasterProjectionFrame,
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
    surfaceSubmissionObservation: (() => SurfaceSubmissionCandidate | undefined) | undefined,
    additionalColorFormats: readonly TextureFormat[] | undefined,
    lateOcclusion: boolean,
    rendererRecording: boolean,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError> {
    const colorFormats = [format, ...(additionalColorFormats ?? [])];
    const target: RasterGraphTarget = {
      format,
      sampleCount,
      rendererRecording,
      colorFormats,
      // Only stock recording owns its attachment formats for the projection.
      colorFormatKey: rendererRecording ? colorFormats.join(',') : undefined,
    };
    this.indirectDrawCount = admittedRasterBatchCount(frame.filtered.plan);
    const outputs = frame.view.addPasses(
      graph,
      'gpu-driven',
      true,
      surfaceSubmissionObservation,
      undefined,
      lateOcclusion,
      undefined,
      target.rendererRecording ? () => this.liveRasterCache?.meshBindings.capture() : undefined,
      rendererRecording ? 'combined' : 'separate',
    );
    if (!outputs.ok) return outputs;
    const accesses = this.rasterGraphAccesses(graph, outputs.value, frame.materialRaster);
    if (!accesses.ok) return accesses;
    const projected: ProjectedRasterGraph = {
      frame,
      target,
      indirect: outputs.value.indirect,
      rasterClasses: new Map(),
      lateRegion: undefined,
    };
    const classes = this.projectRasterClasses(projected, graph, accesses.value);
    if (!classes.ok) return classes;
    return ok(this.rasterProjection(projected, accesses.value, outputs.value));
  }

  /** Scene tables, visible rows, indirect args and any Surface page the encode reads. */
  private rasterGraphAccesses(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    outputs: GpuDrivenViewGraphResources,
    materialRaster: MaterialAbiRasterAdapter,
  ): Result<GraphAccess[], RenderGraphError> {
    const surface =
      this.surfaceSubmission === undefined
        ? undefined
        : importSurfaceBuffers(graph, materialRaster);
    if (surface !== undefined && !surface.ok) return surface;
    const accesses: GraphAccess[] = [
      { resource: outputs.primitive, usage: 'storage-read' },
      { resource: outputs.instance, usage: 'storage-read' },
      { resource: outputs.material, usage: 'storage-read' },
      { resource: outputs.visible, usage: 'storage-read' },
    ];
    if (outputs.visibleSurfaceRows !== undefined)
      accesses.push({ resource: outputs.visibleSurfaceRows, usage: 'storage-read' });
    accesses.push(
      { resource: outputs.transform, usage: 'storage-read' },
      { resource: outputs.indirect, usage: 'indirect-read' },
    );
    if (surface !== undefined) accesses.push(...surface.value);
    return ok(accesses);
  }

  /**
   * Compile one raster class per distinct class key. Raw projections retain
   * physical mesh identities and graph accesses; stock recording binds live
   * residency-owned meshes like direct draws.
   */
  private projectRasterClasses(
    projected: ProjectedRasterGraph,
    graph: RenderGraphBuilder<RenderPipelineFrame> | undefined,
    accesses: GraphAccess[],
  ): Result<void, RenderGraphError | RhiError> {
    const { frame, target, rasterClasses } = projected;
    const meshBuffers = target.rendererRecording
      ? undefined
      : new Map<MeshGpuHandles, ImportedMeshBuffers>();
    const pipelineShapes = new Map<string, ProjectedRasterPipelines>();
    let nextLiveIndex = 0;
    for (const prepared of frame.filtered.batches) {
      const liveIndex = nextLiveIndex++;
      const live = frame.liveRasterBatches[liveIndex];
      const classKey =
        live === undefined ? undefined : rasterClassProjectionKey(live, target.rendererRecording);
      if (classKey === undefined || rasterClasses.has(classKey)) continue;
      const projectedClass = this.projectRasterClass(
        projected,
        graph,
        accesses,
        meshBuffers,
        pipelineShapes,
        prepared,
      );
      if (!projectedClass.ok) return projectedClass;
      rasterClasses.set(classKey, projectedClass.value);
      if (!target.rendererRecording && live !== undefined && !rasterClasses.has(live.classKey))
        rasterClasses.set(live.classKey, projectedClass.value);
    }
    if (target.rendererRecording && graph !== undefined)
      this.rasterGraphIdentity.built(rasterClasses.keys());
    if (rasterClasses.size === 0 && frame.filtered.batches.length > 0) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'one material ABI raster class for the eligible batches',
          hint: 'repair the receipt-backed batch projection before encoding the frame',
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * The class a live batch draws with in this pass. A stock-recording graph
   * binds residency-owned mesh buffers outside the graph, so a class first
   * seen after compilation is projected from the current frame instead of
   * recompiling the graph. Raw graphs import mesh buffers and keep their
   * compiled class set.
   */
  private classFor(
    projected: ProjectedRasterGraph,
    live: LiveRasterBatch,
    filter?: RenderPipelineGpuDrivenFilter,
    fragmentEntryPoint?: string,
    coverageOnly = false,
  ): ProjectedRasterClass | undefined {
    if (
      projected.target.rendererRecording &&
      live.batch.visibleCapacity !== 0 &&
      !projected.rasterClasses.has(live.recordingClassKey) &&
      !this.projectLateRasterClass(projected, live)
    )
      return undefined;
    const selected = rasterClassFor(
      projected.rasterClasses,
      projected.target.rendererRecording,
      live,
      filter,
      fragmentEntryPoint,
      coverageOnly,
    );
    return fragmentEntryPoint === PREDEPTH_FRAGMENT_ENTRY && selected?.predepthCovered !== true
      ? undefined
      : selected;
  }

  private projectLateRasterClass(
    projected: ProjectedRasterGraph,
    live: LiveRasterBatch,
    frame: RasterProjectionFrame | undefined = this.currentRasterFrame,
  ): boolean {
    // Live rows carry their accepted preparation. Manually supplied rows still
    // resolve through their original matching frame index.
    const prepared =
      live.prepared ??
      (frame === undefined
        ? undefined
        : frame.filtered.batches[frame.liveRasterBatches.indexOf(live)]);
    if (frame === undefined || prepared === undefined) {
      this.lateRasterClasses.failed += 1;
      return false;
    }
    const made = this.projectRasterClass(
      { ...projected, frame },
      undefined,
      [],
      undefined,
      new Map(),
      prepared,
    );
    if (!made.ok) {
      this.lateRasterClasses.failed += 1;
      return false;
    }
    projected.rasterClasses.set(live.recordingClassKey, made.value);
    this.lateRasterClasses.projected += 1;
    return true;
  }

  private projectRasterClass(
    projected: ProjectedRasterGraph,
    graph: RenderGraphBuilder<RenderPipelineFrame> | undefined,
    accesses: GraphAccess[],
    meshBuffers: Map<MeshGpuHandles, ImportedMeshBuffers> | undefined,
    pipelineShapes: Map<string, ProjectedRasterPipelines>,
    prepared: PreparedBatch,
  ): Result<ProjectedRasterClass, RenderGraphError | RhiError> {
    const { frame, target } = projected;
    const deformation = prepared.batch.prepared?.identity.deformation ?? 'rigid';
    const raster = deformation === 'skin' ? frame.skinRaster : frame.materialRaster;
    if (raster === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `${deformation === 'skin' ? 'skinned ' : ''}published material ABI raster owner`,
          hint: 'publish the selected material artifact before entering the GPU lane',
        }),
      );
    }
    // Mesh rows are the shared GPU Scene transform table: visible.x names the
    // scene instance row and the vertex stage resolves the primitive root and
    // instance-local transforms itself.
    const meshBindGroup = raster.primitiveBindGroup(frame.view.skinTaskBinding());
    if (!meshBindGroup.ok) return meshBindGroup;
    let buffers = meshBuffers?.get(prepared.mesh);
    if (meshBuffers !== undefined && buffers === undefined && graph !== undefined) {
      const imported = importMeshBuffers(graph, prepared, accesses);
      if (!imported.ok) return imported;
      buffers = imported.value;
      meshBuffers.set(prepared.mesh, buffers);
    }
    const shape = this.rasterPipelineShape(projected, prepared, raster, deformation);
    const shapeKey = rasterPipelineShapeKey(shape);
    let pipelines = shapeKey === undefined ? undefined : pipelineShapes.get(shapeKey);
    if (pipelines === undefined) {
      pipelines = createRasterPipelines(shape);
      if (shapeKey !== undefined) pipelineShapes.set(shapeKey, pipelines);
    }
    // Admit the batch with the pipeline its ordinary forward encode binds, so
    // a frame that never needs fs_main does not compile it.
    if (!target.rendererRecording || frame.input.materialPipelinePreparationFactory === undefined) {
      const initialPipeline = pipelines.opaquePipelineFor(
        target.colorFormats,
        target.colorFormatKey,
      );
      if (!initialPipeline.ok) return initialPipeline;
    }
    const { artifact } = prepared;
    const rasterClass: ProjectedRasterClass = {
      predepthCovered: shape.predepthCovered,
      renderState: prepared.renderState,
      artifact,
      ...(target.rendererRecording ? {} : { mesh: prepared.mesh }),
      ...buffers,
      pipelines,
      meshBindGroup: meshBindGroup.value,
      raster,
      deformation,
      clustered:
        artifact.program.group2 === 'cluster' || artifact.program.group2 === 'skin-cluster',
    };
    return ok(rasterClass);
  }

  private rasterPipelineShape(
    projected: ProjectedRasterGraph,
    prepared: PreparedBatch,
    raster: MaterialAbiRasterAdapter,
    deformation: 'rigid' | 'skin',
  ): RasterPipelineShape {
    const { frame, target } = projected;
    const { artifact, batch, mesh } = prepared;
    const recording = target.rendererRecording;
    const pipelineState = frame.materialPipelineState;
    const discardMask = standardSurfaceDiscardMask(
      lodCoverageMayFade(batch),
      frame.viewClippingLive,
    );
    const proofArtifact =
      frame.input.materialArtifactResolver?.(artifact.material, {
        deformation,
        address: 'scene-index',
        ...(artifact.variantSet === undefined ? {} : { variantSet: artifact.variantSet }),
        surfaceDiscards: discardMask,
        vertexColorAvailable:
          artifact.receipt?.vertexInputs.some((input) => input.semantic === 'color') === true,
      }) ?? (discardMask === 0 ? artifact : undefined);
    return {
      predepthCovered: predepthCoversMaterial(proofArtifact, prepared.renderState),
      raster,
      prepared: recording ? undefined : prepared,
      artifact,
      deformation,
      format: target.format,
      sampleCount: target.sampleCount,
      rendererRecording: recording,
      shaderUvSetCount: isCanonicalStandardPbrMaterialShader(artifact.material)
        ? pipelineState.standardPbrShaderUvSetCount
        : (artifact.uvSetCount ?? pipelineState.standardPbrShaderUvSetCount),
      stripIndexFormat:
        batch.key.drawKind === 'indexed' && isStripTopology(batch.key.topology)
          ? mesh.indexFormat
          : undefined,
      // Class key splits LOD fade capability, the signature view clipping.
      standardSurfaceDiscards: standardSurfaceDiscardMask(
        lodCoverageMayFade(batch),
        frame.viewClippingLive,
      ),
      layoutProjection: recording ? mesh.layoutProjection : undefined,
      topology: recording ? batch.key.topology : undefined,
      renderState:
        deformation === 'skin' || !isStandardPbrMaterialShader(artifact.material)
          ? prepared.renderState
          : clippingCapRenderState(prepared.renderState, frame.input.camera.clipping),
      standardTextureMask: recording ? prepared.standardTextureMask : undefined,
      preparationFactory: frame.input.materialPipelinePreparationFactory,
      visibleSurface: frame.input.visibleSurface !== undefined,
      directionalShadowSimple: frame.input.directionalShadowSimple === true,
      leanLighting: frame.input.leanLighting === true,
      forwardInlineSsr: frame.input.forwardInlineSsr === true,
    };
  }

  /** The renderer-facing projection contract over one compiled raster class set. */
  private rasterProjection(
    projected: ProjectedRasterGraph,
    accesses: readonly GraphAccess[],
    outputs: Pick<GpuDrivenViewGraphResources, 'addLateOcclusion'>,
  ): RenderPipelineGpuDrivenProjection {
    const preparationFactory = projected.frame.input.materialPipelinePreparationFactory;
    const preparationJobs = new Map<string, PipelinePreparationJob>();
    return {
      accesses,
      prepareSource: (source, graphCurrent) =>
        this.sourceRasters.prepare(
          source,
          projected,
          preparationJobs,
          graphCurrent,
          (live, frame) => this.projectLateRasterClass(projected, live, frame),
        ),
      ...(projected.target.rendererRecording && preparationFactory !== undefined
        ? {
            registerPipelinePreparation: (
              formats,
              filter,
              fragmentEntryPoint,
              coverageOnly = false,
              sampleCount = projected.target.sampleCount,
              seededDepth = false,
              opaqueDepthPrimed = false,
            ) =>
              registerRasterPipelinePreparation(
                projected,
                preparationJobs,
                preparationFactory,
                {
                  formats,
                  filter,
                  fragmentEntryPoint,
                  coverageOnly,
                  sampleCount,
                  seededDepth,
                  opaqueDepthPrimed,
                },
                () => this.liveRasterBatches,
                (live) => this.classFor(projected, live, filter, fragmentEntryPoint, coverageOnly),
              ),
            preparePipelines: (entries = [], artifacts, onPending, materials) =>
              runPipelinePreparations(preparationJobs, entries, artifacts, onPending, materials),
          }
        : {}),
      hasWork: (filter, fragmentEntryPoint) =>
        this.liveRasterBatches.some(
          (live) => this.classFor(projected, live, filter, fragmentEntryPoint) !== undefined,
        ),
      ...(outputs.addLateOcclusion === undefined
        ? {}
        : {
            addLateOcclusion: (pyramid: GraphTextureView) => {
              const late = outputs.addLateOcclusion?.(pyramid);
              if (late === undefined || !late.ok) return late ?? ok([]);
              const region = late.value;
              projected.lateRegion = {
                get indirectByteOffset() {
                  return region.lateIndirectByteOffset;
                },
                get visibleBase() {
                  return region.lateVisibleBase;
                },
              };
              return ok(late.value.passNames);
            },
          }),
      encode: (
        viewBindGroup,
        pass,
        resources,
        frameResources,
        filter,
        fragmentEntryPoint,
        coverageOnly = false,
        phase = 'all',
        seededDepth = false,
        viewOffset = 0,
      ) =>
        this.encodeProjected(
          projected,
          viewBindGroup,
          pass,
          resources,
          frameResources,
          filter,
          fragmentEntryPoint,
          coverageOnly,
          phase,
          seededDepth,
          viewOffset,
        ),
    };
  }

  /**
   * Encode one graph pass's indirect draws. The shared Standard view BGL
   * carries two dynamic buffers: the frame view UBO and the per-frame
   * shadow/light table. GPU indirect draws use the same zero offsets as direct
   * draws; supplying only one offset makes Dawn reject the command buffer.
   */
  private encodeProjected(
    projected: ProjectedRasterGraph,
    viewBindGroup: BindGroup,
    pass: RhiRenderPassEncoder,
    resources: GraphResourceResolver,
    frameResources: GpuDrivenStandardPbrFrameResources,
    filter: RenderPipelineGpuDrivenFilter | undefined,
    fragmentEntryPoint: string | undefined,
    coverageOnly: boolean,
    phase: GpuDrivenDrawPhase,
    seededDepth: boolean,
    viewOffset: number,
  ): void {
    const { target } = projected;
    const region = phase === 'late' ? requireLateRegion(projected) : undefined;
    // Keep imperative per-draw Surface observation in its original recording
    // order; only closed pure draw lanes defer native execution.
    const descriptor =
      !target.rendererRecording || observesSurfaceDraws(frameResources, fragmentEntryPoint)
        ? undefined
        : frameResources.bundleDescriptor;
    const bundlePass =
      descriptor === undefined
        ? undefined
        : this.rasterPasses.prepare(
            rasterPassKey(
              filter,
              fragmentEntryPoint,
              coverageOnly,
              phase,
              seededDepth,
              viewOffset,
              frameResources.opaqueDepthPrimed === true,
            ),
            descriptor,
          );
    const bindings = new IndirectPassBindings(
      pass,
      viewBindGroup,
      descriptor,
      bundlePass,
      viewOffset,
    );
    if (!target.rendererRecording) bindings.bindInitialView();
    const colorFormats = frameResources.colorFormats ?? target.colorFormats;
    const sampleCount = rasterSampleCount(
      frameResources.sampleCount ??
        frameResources.bundleDescriptor?.sampleCount ??
        target.sampleCount,
    );
    const call: RasterEncodeCall = {
      resources,
      frameResources,
      filter,
      fragmentEntryPoint,
      coverageOnly,
      seededDepth,
      phase,
      colorFormats,
      sampleCount,
      // Stock recording owns the attachments for this encode. Raw callers
      // retain per-selected-batch format observations.
      formatKey: target.rendererRecording ? colorFormats.join(',') : undefined,
      regionOffset: region === undefined ? 0 : region.indirectByteOffset,
      visibleRegionBase: region === undefined ? 0 : region.visibleBase,
    };
    const ordered = this.orderGBufferEncode(projected, call);
    const lives = ordered ?? this.liveRasterBatches;
    const retained =
      ordered === undefined
        ? this.beginRetainedEncode(projected, call, bindings, viewBindGroup, bundlePass)
        : undefined;
    if (retained === undefined)
      for (const live of lives) this.encodeLiveBatch(projected, call, bindings, live);
    else this.encodeRetainedRuns(projected, call, bindings, lives, retained);
    bindings.finish();
    if (retained !== undefined)
      this.retainedEncodes.finish(
        retained.key,
        retained.identities,
        retained.runs,
        retained.lateClassesFailed === this.lateRasterClasses.failed ? retained.fixed : undefined,
      );
  }

  private rasterIndirect(projected: ProjectedRasterGraph, resources: GraphResourceResolver) {
    if (projected.indirect !== undefined) return resources.buffer(projected.indirect);
    const buffer = projected.frame.view.indirectBuffer;
    if (buffer === undefined)
      throw new RhiError({
        code: 'internal-error',
        expected: 'a current physical indirect buffer for camera raster work',
        hint: 'prepare the GPU view before recording its draw commands',
      });
    return ok(buffer);
  }

  /**
   * Bundled stock runs whose live owners, physical buffers and resolved
   * material, pipeline and mesh groups are unchanged replay their bundle.
   * Slot tables are rebuilt in place every frame; each run instead records
   * the slot and selection its batches resolved.
   */
  private beginRetainedEncode(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    viewBindGroup: BindGroup,
    bundlePass: PreparedRasterPass | undefined,
  ): RetainedEncode | undefined {
    const {
      frameResources,
      fragmentEntryPoint,
      coverageOnly,
      seededDepth,
      colorFormats,
      formatKey,
    } = call;
    if (
      !projected.target.rendererRecording ||
      bindings.direct ||
      bundlePass === undefined ||
      this.geometryCapture !== undefined
    )
      return undefined;
    const indirect = this.rasterIndirect(projected, call.resources);
    const slotsByBinding = frameResources.materialSlotIndicesByBinding;
    const identities = retainedRasterIdentities(
      projected,
      call,
      viewBindGroup,
      indirect.ok ? indirect.value : undefined,
    );
    const fixed = captureFixedRasterInputs(this.liveRasterCache, projected, call);
    const runs = this.retainedEncodes.begin(
      bundlePass,
      identities,
      (key, program, uniformRequired) =>
        materialOwner(
          frameResources.prepareMaterialBinding(
            materialSlotFromLayoutKey(key),
            materialLayoutIndexFromKey(key),
            program,
          ),
          program,
          uniformRequired,
        ),
      (cls) => {
        const batch = cls as ProjectedRasterClass;
        const pipelineFor = selectRasterPipeline(
          batch,
          fragmentEntryPoint,
          coverageOnly,
          seededDepth,
        );
        const pipeline = pipelineFor(
          colorFormats,
          formatKey,
          false,
          call.sampleCount,
          frameResources.opaqueDepthPrimed,
        );
        const mesh = this.meshGroupFor(projected, batch);
        return classOwner(pipeline, mesh);
      },
      fixed,
    );
    const facts = runFacts(
      (live) =>
        this.classFor(
          projected,
          live as LiveRasterBatch,
          call.filter,
          fragmentEntryPoint,
          coverageOnly,
        ) !== undefined,
      slotsByBinding,
      frameResources.selectedMaterialSlots,
    );
    return {
      key: bundlePass,
      identities,
      runs,
      facts,
      fixed,
      lateClassesFailed: this.lateRasterClasses.failed,
    };
  }

  /**
   * A run is the contiguous stable-ID block that one bundle covers. Retained
   * runs leave single candidates to the GPU cull, so replayed bundles stay
   * independent of this frame's camera classification.
   */
  private encodeRetainedRuns(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    lives: readonly LiveRasterBatch[],
    retained: RetainedEncode,
  ): void {
    let start = 0;
    while (start < lives.length) {
      const fixedLength = retained.runs.fixedRunLength(lives, start);
      const end = fixedLength === 0 ? retainedRunEnd(lives, start) : start + fixedLength;
      bindings.startRun();
      const reused = retained.runs.reuse(lives, start, end, retained.facts);
      if (reused !== undefined) {
        bindings.replayRun(reused, this.preparedBundleCounters);
        this.encodedIndirectDraws += reused.draws;
        if (fixedLength !== 0 && reused.bundle !== undefined) this.preparedBundleFixedHits++;
        if (reused.bundle !== undefined && reused.draws > 0)
          this.observeRetainedMaterialPipelineBindings(projected, call, reused, lives, start, end);
      } else {
        bindings.recordRun(retained.runs.record(lives, start, end, retained.facts));
        for (let index = start; index < end; index++)
          this.encodeLiveBatch(projected, call, bindings, lives[index] as LiveRasterBatch);
      }
      start = end;
    }
  }

  /** Record the encode and, for the stock early G-buffer only, its diagnostic order. */
  private orderGBufferEncode(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
  ): readonly LiveRasterBatch[] | undefined {
    const { filter, fragmentEntryPoint, coverageOnly, phase } = call;
    const rendererRecording = projected.target.rendererRecording;
    const admitted = isGBufferOrderDiagnosticEncode(
      rendererRecording,
      filter,
      fragmentEntryPoint,
      coverageOnly,
      phase,
      call.colorFormats.length,
    );
    if (this.gbufferOrderEncodes !== undefined)
      this.gbufferOrderEncodes.push({
        rendererRecording,
        filter,
        fragmentEntry: fragmentEntryPoint,
        coverageOnly,
        phase,
        colorTargetCount: call.colorFormats.length,
        admitted,
      });
    const mode = admitted ? this.gbufferOrderMode : undefined;
    if (mode === undefined) return undefined;
    const evidence: GBufferOrderEvidence = {
      classes: [],
      batches: [],
      rejections: {},
      indices: new Map(),
      selected: 0,
    };
    const sources: GBufferOrderSources = {
      view: this.gbufferOrderView,
      slotAt: this.gbufferOrderSlotAt,
      materials: this.gbufferOrderMaterials,
    };
    const { rasterClasses } = projected;
    const ordered = orderGBufferDiagnostic(this.liveRasterBatches, mode.order, (live) =>
      gbufferOrderBatchDepth(
        evidence,
        mode,
        sources,
        live,
        this.classFor(projected, live, filter, fragmentEntryPoint, coverageOnly),
        rasterClasses.get(rasterClassProjectionKey(live, rendererRecording)),
      ),
    );
    this.gbufferOrderInspection = {
      mode: mode.order,
      eligibleBatches: ordered.eligible,
      movedBatches: ordered.moved,
      status: 'evaluated',
      ...(this.gbufferOrderInspection?.preparation === undefined
        ? {}
        : { preparation: this.gbufferOrderInspection.preparation }),
      encodes: this.gbufferOrderEncodes ?? [],
      denominator: { live: this.liveRasterBatches.length, selected: evidence.selected },
      rejections: evidence.rejections,
      classes: evidence.classes,
      batches: evidence.batches,
    };
    return ordered.batches;
  }

  private encodeLiveBatch(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    live: LiveRasterBatch,
  ): void {
    const { frame, target } = projected;
    const { frameResources } = call;
    const batch = this.classFor(
      projected,
      live,
      call.filter,
      call.fragmentEntryPoint,
      call.coverageOnly,
    );
    if (batch === undefined) return;
    const globalMaterialSlot = selectedMaterialSlot(live, frameResources);
    if (globalMaterialSlot === undefined) return;
    const selectedPipeline = selectRasterPipeline(
      batch,
      call.fragmentEntryPoint,
      call.coverageOnly,
      call.seededDepth,
    )(call.colorFormats, call.formatKey, false, call.sampleCount, frameResources.opaqueDepthPrimed);
    if (!selectedPipeline.ok) throw selectedPipeline.error;
    bindings.bindPipeline(selectedPipeline.value, this.device);
    const material = bindMaterialSlot(
      bindings,
      batch,
      frameResources,
      globalMaterialSlot,
      standardPipelineMaterialLayoutIndex(selectedPipeline.value),
    );
    const mesh = this.meshGroupFor(projected, batch);
    const group2 = primitiveForPipeline(
      this.device,
      selectedPipeline.value,
      mesh,
      material.reflection,
    );
    bindings.observeRunClass(batch, selectedPipeline.value, mesh);
    bindings.bindMesh(group2, batch.deformation, frame.view);
    if (target.rendererRecording)
      bindings.bindRecordedGeometry(live.meshBinding, live.mesh.indexFormat);
    else {
      if (batch.mesh === undefined)
        throw new Error('A raw raster graph must import its compiled mesh');
      bindings.bindGraphGeometry(
        batch.vertex,
        batch.index,
        batch.mesh.indexFormat,
        call.resources,
        batch.mesh.vertexStreams,
      );
    }
    if (!bindings.hasIndirect) {
      const indirect = this.rasterIndirect(projected, call.resources);
      if (!indirect.ok) throw indirect.error;
      bindings.indirect = indirect.value;
    }
    const windows = visibleWindowsFor(live, batch, call, selectedPipeline.value);
    this.encodeLevels(projected, call, bindings, live, batch, windows);
    frameResources.recordMaterialPipelineBinding?.(
      globalMaterialSlot,
      selectedPipeline.value,
      material.group,
    );
    bindings.recordBundle(
      live,
      windows,
      call.regionOffset + live.batch.indirectOffset,
      frame.view,
      this.device,
      this.preparedBundleCounters,
    );
  }

  private observeRetainedMaterialPipelineBindings(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    reused: RetainedRasterBlock,
    lives: readonly LiveRasterBatch[],
    start: number,
    end: number,
  ): void {
    for (let index = start; index < end; index++) {
      const live = lives[index] as LiveRasterBatch;
      const batch = this.classFor(
        projected,
        live,
        call.filter,
        call.fragmentEntryPoint,
        call.coverageOnly,
      );
      const slot = selectedMaterialSlot(live, call.frameResources);
      if (batch === undefined || slot === undefined) continue;
      recordRetainedMaterialPipelineBinding(reused, batch, slot, call.frameResources);
    }
  }

  private meshGroupFor(projected: ProjectedRasterGraph, batch: ProjectedRasterClass): BindGroup {
    // A Skin task belongs to the selected View and may have changed since the
    // class was compiled. Rigid classes share their original Primitive.
    if (batch.deformation === 'rigid') return batch.meshBindGroup;
    const raster = projected.frame.skinRaster;
    if (raster === undefined) throw new Error('Missing scene-index Skin raster owner');
    return raster.primitiveBindGroup(projected.frame.view.skinTaskBinding()).unwrap();
  }

  /** One indirect command per LOD level slot; the GPU cull compacts members per level. */
  private encodeLevels(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    live: LiveRasterBatch,
    batch: ProjectedRasterClass,
    windows: readonly BindGroup[],
  ): void {
    const indirect = bindings.indirect;
    const indexed = live.batch.key.drawKind === 'indexed';
    const levelCount = batchLodLevelCount(live.batch);
    for (let level = 0; level < levelCount; level += 1) {
      const commandOffset =
        call.regionOffset + live.batch.indirectOffset + level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
      const visibleWindow = windows[level];
      if (visibleWindow === undefined) throw new Error('Missing prepared visible binding');
      bindings.drawIndirect(visibleWindow, indirect, commandOffset, indexed);
      this.captureGeometryCommand(projected, call, bindings, live, batch, level, commandOffset);
      observeSurfaceDraw(call, bindings, live, batch, commandOffset);
      this.encodedIndirectDraws += 1;
      bindings.countRunDraw();
    }
  }

  private captureGeometryCommand(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    live: LiveRasterBatch,
    batch: ProjectedRasterClass,
    level: number,
    commandOffset: number,
  ): void {
    const capture = this.geometryCapture;
    if (capture === undefined || capture.failure !== undefined) return;
    try {
      if (capture.commands.length >= GEOMETRY_OBSERVATION_MAX_COMMANDS) {
        capture.failure = 'command-budget';
        return;
      }
      const sources = captureGeometrySources(capture, this.preparations.forward.cached, live);
      const gbufferProgram =
        call.fragmentEntryPoint === 'fs_gbuffer'
          ? gbufferGeometryProgram(
              batch,
              projected.frame.input.visibleSurface !== undefined,
              bindings.pipeline,
            )
          : undefined;
      capture.commands.push({
        pass: `${call.filter ?? 'all'}:${call.fragmentEntryPoint ?? 'default'}`,
        phase: call.phase,
        level,
        batchId: live.batch.batchId,
        indirectOffset: commandOffset,
        visibleBase:
          call.visibleRegionBase + live.batch.visibleBase + level * batchLevelStride(live.batch),
        bufferIdentity: getOpaqueResourceIdentity(bindings.indirect as object),
        kind: live.batch.key.drawKind,
        topology: live.batch.key.topology,
        ...(gbufferProgram === undefined ? {} : { gbufferProgram }),
        sources,
      });
    } catch (error) {
      capture.failure = error instanceof Error ? error.message : 'source-capture-failed';
    }
  }

  private assemblePrepared(
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame | undefined,
    pass: 'forward' | 'shadow',
    batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
    meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
    profilePhase?: RecordProfileRunner,
  ): Result<PreparedProductionPlan, GpuDrivenPreparationError> {
    const preparation = this.preparations[pass];
    const complete = scene.residentExecution ?? scene.plan;
    const resident =
      hasCapturedTaskMembership(scene.plan) && hasCapturedTaskMembership(complete)
        ? complete
        : scene.plan;
    preparation.retireAbsent(complete);
    const previous = preparation.cached;
    const sameInputs = previous !== undefined && previous.scene === scene.scene;
    if (
      sameInputs &&
      previous.value.residentSource === resident &&
      previous.plan === scene.plan &&
      samePreparedAssemblyInputs(previous.inputs, batchExecutions, materials, [
        meshByBinding,
        scene.meshes,
      ])
    ) {
      if (previous.slotAt !== scene.slotAt)
        preparation.cached = { ...previous, slotAt: scene.slotAt };
      this.preparedAssemblyHits++;
      return ok(previous.value);
    }
    const assembly = new BatchRowAssembly(
      preparation,
      pass,
      scene,
      materials,
      batchExecutions,
      meshByBinding,
      sameInputs,
    );
    const batchRows =
      profilePhase === undefined
        ? assembly.assemble()
        : runRecordProfilePhase(profilePhase, 'record/gpu-driven-prepare/plan/rows', () =>
            assembly.assemble(),
          );
    this.preparedBatchBuilds += assembly.rebuiltBatches;
    this.planRebuildBatches += assembly.rebuiltBatches;
    this.planRebuildCandidates = 0;
    // A failed artifact publication cannot admit filtered or GPU work.
    if (assembly.missingArtifact !== undefined) return err(assembly.missingArtifact);
    const { sameRows, fixedMembership, serializedStates } = assembly;
    if (
      sameInputs &&
      previous.value.residentSource === resident &&
      previous.plan === scene.plan &&
      sameRows &&
      previous.batchRows.length === batchRows.length
    ) {
      // Pose-only snapshots replace their lookup without changing execution facts.
      if (previous.slotAt !== scene.slotAt)
        preparation.cached = { ...previous, slotAt: scene.slotAt };
      preparation.cached = {
        ...(preparation.cached ?? previous),
        inputs: preparedAssemblyInputs(
          batchExecutions,
          materials,
          [meshByBinding, scene.meshes],
          batchRows,
          serializedStates,
          fixedMembership,
        ),
      };
      return ok(previous.value);
    }
    this.gpuOwnedSnapshotsMaterialized = 0;
    const value =
      profilePhase === undefined
        ? assemblePreparedPlan(resident, batchRows, scene.plan)
        : runRecordProfilePhase(profilePhase, 'record/gpu-driven-prepare/plan/admission', () =>
            assemblePreparedPlan(resident, batchRows, scene.plan),
          );
    preparation.cached = {
      plan: scene.plan,
      slotAt: scene.slotAt,
      scene: scene.scene,
      batchRows,
      value,
      inputs: preparedAssemblyInputs(
        batchExecutions,
        materials,
        [meshByBinding, scene.meshes],
        batchRows,
        serializedStates,
        fixedMembership,
      ),
    };
    return ok(value);
  }

  updateShadowViews(
    views: readonly ShadowViewRequest[],
    filtered: FilteredProductionPlan,
    batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
    scene: PersistentGpuDrivenState,
    inputReads: import('../gpu-scene-inputs').GpuInputReadFrame,
    camera: CameraSnapshot,
    capsuleShadowDirectional: boolean,
    directMaterials: import('../scene/material-dispatch').MaterialFrame | undefined,
    shadowMaterials: ShadowMaterialContent | undefined,
    profilePhase?: RecordProfileRunner,
    ownedRequests = false,
  ): Result<void, RhiError> {
    if (views.length === 0) return this.disableShadowViews();
    this.observedShadowArtifacts = observeShadowArtifacts(
      this.observedShadowArtifacts,
      filtered.materialBatches,
    );
    const artifacts = this.observedShadowArtifacts;
    const shadowViews = this.shadowViews;
    const shadowSource = this.shadowSource;
    const shadowScene = this.shadowScene;
    if (shadowViews === undefined || shadowSource === undefined || shadowScene === undefined) {
      return ok(undefined);
    }
    const materialRaster = this.materialRaster;
    if (materialRaster === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'material ABI raster adapter for shadow projection',
          hint: 'prepare the selected-artifact raster owner before updating shadow views',
        }),
      );
    }
    const diffs = new ShadowProjectionDiffs(filtered, batchExecutions);
    const meshBinding = materialRaster.primitiveBindGroup();
    if (!meshBinding.ok) return meshBinding;
    const pass: ShadowProjectionPass = {
      filtered,
      ownedRequests,
      executions: batchExecutions,
      artifacts,
      diffs,
      scene,
      pool: shadowViews,
      sourcePlan: shadowSource.plan,
      projectionSource: shadowSource.projectionSource,
      shadowScene,
      inputReads,
      camera,
      capsuleShadowDirectional,
      directMaterials,
      shadowMaterials,
      profilePhase,
      materialRaster,
      meshBinding: meshBinding.value,
      visibleBindingIdentity: materialRaster.visibleBindingIdentity,
      skinVisibleBindingIdentity: this.skinRaster?.visibleBindingIdentity,
      cullCamera: undefined,
      preparedByBatch: undefined,
      next: new Map(),
    };
    let classes: ReturnType<ShadowCasterClassifier['update']> | undefined;
    const retained: ShadowViewIdentity[] = [];
    for (const requested of views) {
      const captured = ownedRequests ? requested : { ...requested };
      const single = captured.staticLayer === false;
      if (!single && classes === undefined) {
        classes =
          profilePhase === undefined
            ? this.shadowCasterClasses.update(scene, shadowScene)
            : runRecordProfilePhase(
                profilePhase,
                'record/gpu-driven-prepare/shadow-views/caster-classes',
                () => this.shadowCasterClasses.update(scene, shadowScene),
              );
      }
      const projected = this.projectRequestedShadowView(
        pass,
        captured,
        single ? undefined : classes,
        retained,
      );
      if (!projected.ok) return projected;
    }
    if (classes === undefined) this.shadowCasterClasses.release();
    this.shadowChannelSlots.retainRequested();
    shadowViews.retain(retained);
    this.shadowBatchProjections = publishReadonlyMap(pass.next);
    return ok(undefined);
  }

  /** One requested view projects as a single final layer or a static/final pair. */
  private projectRequestedShadowView(
    pass: ShadowProjectionPass,
    requested: ShadowViewRequest,
    classes: ReturnType<ShadowCasterClassifier['update']> | undefined,
    retained: ShadowViewIdentity[],
  ): Result<void, RhiError> {
    const input = restrictShadowCasterChannels(requested, this.shadowChannelSlots, pass);
    retained.push(input.identity);
    const layers = shadowLayerRequests(input, classes);
    const staticIdentity = staticShadowViewIdentity(input.identity);
    this.syncShadowLayerMode(
      pass.pool,
      input.identity,
      staticIdentity,
      input.staticLayer === false,
    );
    if (layers.static !== undefined) {
      retained.push(staticIdentity);
      const projected = this.projectShadowViewCache(pass, layers.static);
      if (!projected.ok) return projected;
      if (projected.value === 'invalidated')
        pass.pool.invalidate('static-layer-changed', input.identity);
    }
    return this.projectShadowView(pass, layers.final);
  }

  /**
   * A mode change swaps the final layer's caster set and its graph
   * composition. Neither layer's retained depth may survive it: a re-enabled
   * static layer kept its depth while it was not drawn.
   */
  private syncShadowLayerMode(
    pool: ShadowViewStatePool,
    identity: ShadowViewIdentity,
    staticIdentity: ShadowViewIdentity,
    singleLayer: boolean,
  ): void {
    const viewKey = shadowViewIdentityKey(identity);
    if (singleLayer === this.shadowSingleLayerViews.has(viewKey)) return;
    if (singleLayer) this.shadowSingleLayerViews.add(viewKey);
    else this.shadowSingleLayerViews.delete(viewKey);
    pool.invalidate('configuration-changed', identity);
    pool.invalidate('configuration-changed', staticIdentity);
  }

  private projectShadowView(
    pass: ShadowProjectionPass,
    request: ShadowViewRequest,
  ): Result<void, RhiError> {
    const projected = this.projectShadowViewCache(pass, request);
    return projected.ok ? ok(undefined) : projected;
  }

  private projectShadowViewCache(
    pass: ShadowProjectionPass,
    request: ShadowViewRequest,
  ): Result<ShadowViewUpdate['cache'], RhiError> {
    const cameraCull = request.cameraCull;
    return runRecordProfilePhase(
      pass.profilePhase,
      'record/gpu-driven-prepare/shadow-views/project-view',
      () => this.projectShadowViewBatches(pass, request, cameraCull),
    );
  }

  private projectShadowViewBatches(
    pass: ShadowProjectionPass,
    input: ShadowViewCacheRequest,
    cameraCull: ShadowCameraCullDilation | undefined,
  ): Result<ShadowViewUpdate['cache'], RhiError> {
    const identityKey = shadowViewIdentityKey(input.identity);
    const previousProjections = this.shadowBatchProjections.get(identityKey);
    const previousSource =
      previousProjections === undefined
        ? undefined
        : this.shadowProjectionSources.get(previousProjections);
    // Membership already invalidates depth through the source plan and bounds.
    // A publication edit can leave both unchanged: observe only receipts this
    // view consumed, before its depth-cache decision, including unsubmitted work.
    const physicalChanged =
      !this.sameShadowInputs(pass, identityKey, previousProjections) &&
      this.invalidateShadowViewEdits(pass, input.identity, previousProjections, previousSource);
    const updated = this.updateShadowViewCache(pass, input, cameraCull);
    if (!updated.ok) return updated;
    const submission = pass.pool.submission(input.identity);
    const visibleBuffer = submission?.view.visibleBuffer;
    if (submission === undefined || visibleBuffer === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'shadow view visible buffer after update',
          hint: 'publish the per-view visible window before recording indirect shadow draws',
        }),
      );
    }
    const skinMeshBinding = this.shadowSkinMeshBinding(submission.view);
    if (skinMeshBinding !== undefined && !skinMeshBinding.ok) return skinMeshBinding;
    const viewBindings: ShadowViewBindings = {
      visibleBuffer,
      meshBinding: pass.meshBinding,
      skinMeshBinding: skinMeshBinding?.value,
    };
    const sameBindings =
      previousSource !== undefined && sameShadowBindings(previousSource, pass, viewBindings);
    // Moving the camera or casters changes depth, not the binding contract.
    // Source edits outside this view do not replace its draw bindings.
    if (
      !physicalChanged &&
      previousProjections !== undefined &&
      previousSource !== undefined &&
      sameBindings &&
      this.shadowProjectionsRetained(pass, previousProjections, previousSource, submission.plan)
    ) {
      previousSource.filtered = pass.filtered;
      previousSource.executions = pass.executions;
      previousSource.artifacts = pass.artifacts;
      pass.next.set(identityKey, previousProjections);
      return ok(updated.value.cache);
    }
    const projections = this.projectShadowBatches(
      pass,
      submission.plan,
      previousProjections,
      sameBindings ? previousSource : undefined,
      previousSource?.artifacts,
      viewBindings,
    );
    if (!projections.ok) return projections;
    this.publishShadowProjections(
      pass,
      identityKey,
      publishedShadowProjections(projections.value, previousProjections),
      submission.plan,
      viewBindings,
    );
    return ok(updated.value.cache);
  }

  /**
   * A view whose projections, filtered rows, executions and receipts are the
   * same objects as its last unchanged check cannot observe a new edit.
   */
  private sameShadowInputs(
    pass: ShadowProjectionPass,
    identityKey: string,
    previousProjections: ReadonlyMap<number, GpuDrivenShadowBatchProjection> | undefined,
  ): boolean {
    const unchangedInputs = this.shadowUnchangedInputs.get(identityKey);
    return (
      previousProjections !== undefined &&
      unchangedInputs?.projections === previousProjections &&
      unchangedInputs.filtered === pass.filtered &&
      unchangedInputs.executions === pass.executions &&
      unchangedInputs.artifacts === pass.artifacts
    );
  }

  /** Invalidate the view's depth for consumed edits; `true` when draw inputs changed. */
  private invalidateShadowViewEdits(
    pass: ShadowProjectionPass,
    identity: ShadowViewIdentity,
    previousProjections: ReadonlyMap<number, GpuDrivenShadowBatchProjection> | undefined,
    previousSource: ShadowProjectionSource | undefined,
  ): boolean {
    if (previousSource === undefined) return false;
    const artifactsChanged = shadowArtifactsChanged(previousSource, pass.artifacts);
    // Projected rows matched previousSource.filtered; unchanged rows keep their mesh.
    const meshesChanged = shadowMeshesChanged(previousSource, pass, previousProjections);
    if (artifactsChanged) pass.pool.invalidate('artifact-changed', identity);
    else if (meshesChanged) pass.pool.invalidate('content-changed', identity);
    else if (shadowMaterialsChanged(previousSource, pass, previousProjections))
      pass.pool.invalidate('content-changed', identity);
    return artifactsChanged || meshesChanged;
  }

  private updateShadowViewCache(
    pass: ShadowProjectionPass,
    input: ShadowViewCacheRequest,
    cameraCull: ShadowCameraCullDilation | undefined,
  ): Result<ShadowViewUpdate, RhiError> {
    // The pool reads cameras only when compute consumes this frame's inputs.
    let lodCamera: ReturnType<typeof lodViewCameraFromMatrix> | undefined;
    let cull: Omit<GpuDrivenShadowCameraCull, 'lightViewProjection'> | undefined;
    const { directMaterials, shadowMaterials } = pass;
    return runRecordProfilePhase(
      pass.profilePhase,
      'record/gpu-driven-prepare/shadow-views/project-view/cache-update',
      () => {
        const readLodCamera = () => {
          lodCamera ??=
            input.matrix === undefined ? pass.camera : lodViewCameraFromMatrix(input.matrix);
          return lodCamera;
        };
        const readCameraCull = () => {
          if (cameraCull === undefined) return undefined;
          if (cull === undefined) {
            pass.cullCamera ??= occlusionCamera(pass.camera);
            cull = { ...cameraCull, camera: pass.cullCamera };
          }
          return cull;
        };
        const update = pass.ownedRequests
          ? this.consumeShadowViewRequest(pass, input, readLodCamera, readCameraCull)
          : {
              ...input,
              sourcePlan: pass.sourcePlan,
              scene: pass.shadowScene,
              inputReads: pass.inputReads,
              materialSource: pass.scene,
              skin: pass.scene.skin,
              capsuleDirectional:
                pass.capsuleShadowDirectional && input.identity.kind === 'directional',
              ...(directMaterials === undefined || input.identity.layer === 'static'
                ? {}
                : { directMaterials }),
              ...(shadowMaterials === undefined ? {} : { shadowMaterials }),
              lodCamera: readLodCamera,
              cameraCull: readCameraCull,
            };
        return pass.pool.update(update, pass.projectionSource);
      },
    );
  }

  /** Recorder-created requests transfer to this frame's pool read domain. */
  private consumeShadowViewRequest(
    pass: ShadowProjectionPass,
    input: ShadowViewCacheRequest,
    lodCamera: NonNullable<ShadowViewUpdateInput['lodCamera']>,
    cameraCull: NonNullable<ShadowViewUpdateInput['cameraCull']>,
  ): ShadowViewUpdateInput {
    const update = input as ShadowViewUpdateStorage;
    update.sourcePlan = pass.sourcePlan;
    update.scene = pass.shadowScene;
    update.inputReads = pass.inputReads;
    update.materialSource = pass.scene;
    update.skin = pass.scene.skin;
    update.capsuleDirectional =
      pass.capsuleShadowDirectional && input.identity.kind === 'directional';
    if (pass.directMaterials === undefined || input.identity.layer === 'static')
      delete update.directMaterials;
    else update.directMaterials = pass.directMaterials;
    if (pass.shadowMaterials === undefined) delete update.shadowMaterials;
    else update.shadowMaterials = pass.shadowMaterials;
    update.lodCamera = lodCamera;
    update.cameraCull = cameraCull;
    return update;
  }

  private shadowSkinMeshBinding(view: GpuDrivenView): Result<BindGroup, RhiError> | undefined {
    const skinTask = view.skinTaskBinding();
    if (skinTask === undefined) return undefined;
    return this.skinRaster?.primitiveBindGroup(skinTask);
  }

  /**
   * Changed plans and ownership compare each batch; physical changes rebuild.
   * Depth hits already validated drawn content; misses also check live
   * material values.
   */
  private shadowProjectionsRetained(
    pass: ShadowProjectionPass,
    previousProjections: ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    previousSource: ShadowProjectionSource,
    plan: SubmissionPlan,
  ): boolean {
    if (!sameShadowProjectionLayout(previousSource.plan, plan)) return false;
    if (!this.shadowRowsRetained(pass, previousProjections, previousSource, plan)) return false;
    // The same rows against the same execution table are each retained.
    if (previousSource.plan === plan && previousSource.executions === pass.executions) return true;
    return plan.batches.every((batch, index) =>
      sameShadowExecution(batch, index, previousSource, previousProjections, pass.executions),
    );
  }

  private shadowRowsRetained(
    pass: ShadowProjectionPass,
    previousProjections: ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    previousSource: ShadowProjectionSource,
    plan: SubmissionPlan,
  ): boolean {
    if (previousSource.filtered === pass.filtered) return true;
    const rows = pass.diffs.rowsChangedSince(previousSource.filtered);
    if (
      !rows.removed &&
      rows.changed.every(
        ({ batch, mesh }) =>
          !previousProjections.has(batch.batchId) ||
          previousProjections.get(batch.batchId)?.mesh === mesh,
      )
    )
      return true;
    return plan.batches.every(
      (batch) =>
        preparedShadowRows(pass).get(batch.batchId)?.mesh ===
        previousProjections.get(batch.batchId)?.mesh,
    );
  }

  /**
   * A topology/depth revision can leave every physical draw projection
   * unchanged; keep that publication without filling another complete map.
   * `undefined` means the previous projections are kept as they are.
   */
  private projectShadowBatches(
    pass: ShadowProjectionPass,
    plan: SubmissionPlan,
    previousProjections: ReadonlyMap<number, GpuDrivenShadowBatchProjection> | undefined,
    boundSource: ShadowProjectionSource | undefined,
    previousArtifacts: ShadowArtifactObservations | undefined,
    viewBindings: ShadowViewBindings,
  ): Result<Map<number, GpuDrivenShadowBatchProjection> | undefined, RhiError> {
    const previousBatches = boundSource?.plan.batches;
    let projections: Map<number, GpuDrivenShadowBatchProjection> | undefined =
      previousProjections?.size === plan.batches.length &&
      previousBatches?.every((batch, index) => batch.batchId === plan.batches.at(index)?.batchId)
        ? undefined
        : new Map();
    let previousById: ReadonlyMap<number, GpuDrivenBatch> | undefined;
    let batchIndex = 0;
    const retainedOwners = retainedShadowOwners(pass, boundSource);
    for (const batch of plan.batches) {
      if (batch.visibleCapacity === 0) {
        projections ??= new Map(previousProjections);
        projections.delete(batch.batchId);
        batchIndex++;
        continue;
      }
      const retainedProjection = retainedShadowProjection(
        retainedOwners,
        previousProjections,
        batch,
      );
      if (retainedProjection !== undefined) {
        projections?.set(batch.batchId, retainedProjection);
        batchIndex++;
        continue;
      }
      const facts = captureShadowBatchFacts(pass, batch, viewBindings, this.skinRaster);
      if (!facts.ok) return facts;
      // Stable command addresses need not follow source order after a
      // split/rejoin. Keep unchanged ordinals allocation-free; only a
      // reordered batch needs a transient linear-time lookup.
      let previousBatch = previousBatches?.at(batchIndex);
      batchIndex++;
      if (previousBatches !== undefined && previousBatch?.batchId !== batch.batchId) {
        previousById ??= new Map(previousBatches.map((entry) => [entry.batchId, entry]));
        previousBatch = previousById.get(batch.batchId);
      }
      const previousProjection = previousProjections?.get(batch.batchId);
      if (
        previousProjection !== undefined &&
        sameShadowBatchProjection(previousBatch, batch, previousProjection, facts.value) &&
        sameConsumedArtifact(batch, previousArtifacts, pass.artifacts)
      ) {
        projections?.set(batch.batchId, previousProjection);
        continue;
      }
      const borrowed = this.sourceRasters.borrowShadow(
        viewBindings.visibleBuffer,
        batch,
        facts.value,
      );
      const created =
        borrowed === undefined
          ? createShadowBatchProjection(
              batch,
              facts.value,
              viewBindings.visibleBuffer,
              previousProjection?.bundles,
            )
          : ok(borrowed);
      if (!created.ok) return created;
      projections ??= new Map(previousProjections);
      projections.set(batch.batchId, created.value);
    }
    return ok(projections);
  }

  private publishShadowProjections(
    pass: ShadowProjectionPass,
    identityKey: string,
    published: ShadowBatchProjections,
    plan: SubmissionPlan,
    viewBindings: ShadowViewBindings,
  ): void {
    pass.next.set(identityKey, published);
    this.shadowUnchangedInputs.set(identityKey, {
      projections: published,
      filtered: pass.filtered,
      executions: pass.executions,
      artifacts: pass.artifacts,
    });
    this.shadowProjectionSources.set(published, {
      plan,
      filtered: pass.filtered,
      executions: pass.executions,
      artifacts: pass.artifacts,
      ...viewBindings,
      visibleBindingIdentity: pass.visibleBindingIdentity,
      skinVisibleBindingIdentity: pass.skinVisibleBindingIdentity,
    });
  }

  private disableShadowViews(): Result<void, RhiError> {
    this.shadowCasterClasses.release();
    this.shadowViews?.retain([]);
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    return ok(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.sourceRasters.clear();
    const failures: unknown[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (cause) {
        failures.push(cause);
      }
    };
    attempt(() => this.initialViews.dispose());
    for (const task of this.residentRowTasks) attempt(() => task.release());
    attempt(() => this.inputBindingPreparation?.release());
    for (const hold of this.residentRowHolds) attempt(() => hold.release());
    for (const frame of this.resourceFrames)
      attempt(() => {
        frame.release();
        this.resourceFrames.delete(frame);
      });
    attempt(() => {
      this.view?.dispose();
      this.view = undefined;
    });
    attempt(() => {
      this.materialRaster?.dispose();
      this.materialRaster = undefined;
    });
    this.observedShadowArtifacts = new Map();
    attempt(() => {
      this.skinRaster?.dispose();
      this.skinRaster = undefined;
    });
    for (const preparation of Object.values(this.preparations)) preparation.clear();
    this.filteredCache = undefined;
    this.liveRasterCache = undefined;
    this.liveRasterBatches = [];
    this.currentRasterFrame = undefined;
    this.shadowFilteredCache = undefined;
    attempt(() => this.mainFilterContributions.clear());
    attempt(() => this.shadowFilterContributions.clear());
    this.surfaceFrames.clear();
    this.rasterGraphIdentity.clear();
    attempt(() => {
      this.shadowViews?.dispose();
      this.shadowViews = undefined;
    });
    this.shadowSource = undefined;
    this.shadowScene = undefined;
    this.shadowCasterClasses.release();
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    this.committedViewClipping = '';
    this.preparationFailure = undefined;
    this.surfaceArtifactInspection = undefined;
    this.overflowRecoveryRequired = false;
    if (failures.length > 0) {
      if (this.disposalFailure === undefined)
        this.disposalFailure = new AggregateError(failures, 'GPU production retirement failed');
      else this.disposalFailure.errors.push(...failures);
    }
    if (this.disposalFailure !== undefined) throw this.disposalFailure;
  }

  get resourceGeneration(): number | undefined {
    return this.view?.currentResourceGeneration;
  }

  /** Skin task upload bytes belong to the recording's CPU task owner. */
  inspect(paletteUploadBytes = 0): GpuDrivenProductionInspection {
    this.settleDrawSummary();
    const view = this.view?.inspect();
    const filtered = this.filteredCache?.value;
    const classification = this.shadowCasterClasses.inspect();
    const resourceAllocation = combineGpuResourceAllocationInspections([
      ...(view === undefined ? [] : [view.resourceAllocation]),
      ...(this.materialRaster === undefined ? [] : [this.materialRaster.resourceAllocation]),
      ...(this.skinRaster === undefined ? [] : [this.skinRaster.resourceAllocation]),
    ]);
    const resourceClasses =
      filtered === undefined
        ? undefined
        : inspectResourceClassSplits({ batches: filtered.batches.map(({ batch }) => batch) });
    const channels: GpuDrivenLaneSummary[] = [];
    this.mainLaneChannels(channels);
    this.shadowLaneChannels(channels);
    return {
      ...(this.surfaceArtifactInspection === undefined
        ? {}
        : { surfaceArtifact: this.surfaceArtifactInspection }),
      cpuValidationScans: this.cpuValidationScans,
      cpuValidationCacheHits: this.cpuValidationCacheHits,
      graphIdentityChanges: { ...this.rasterGraphIdentity.changes },
      ...this.structureMetrics,
      paletteUploadBytes,
      ...(this.gbufferOrderInspection === undefined
        ? {}
        : { gbufferBatchOrderDiagnostic: this.gbufferOrderInspection }),
      ...this.surfaceFrameInspection(),
      gpuOwnedSnapshotsMaterialized: this.gpuOwnedSnapshotsMaterialized,
      filteredPlanBuilds: this.filteredPlanBuilds,
      preparedBatchBuilds: this.preparedBatchBuilds,
      filteredBatchBuilds: this.filteredBatchBuilds,
      planRebuildBatches: this.planRebuildBatches,
      preparedAssemblyHits: this.preparedAssemblyHits,
      planRebuildCandidates: this.planRebuildCandidates,
      shadowCasterFlips: classification.flips,
      shadowCasterClassification: classification,
      shadowViews: this.shadowViews?.inspect() ?? [],
      shadowCasterPendingPromotions: classification.pendingPromotions,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      ...this.viewUploadInspection(view),
      batchBindGroupCreates: this.batchBindGroupCreates,
      submissionVisibleCapacity: view?.visibleCapacity ?? 0,
      submissionReservedVisibleEntries: this.liveRasterBatches.reduce(
        (sum, live) => sum + batchVisibleSpan(live.batch),
        0,
      ),
      visibleBufferCapacity: view?.visibleBufferCapacity ?? 0,
      ...this.filteredAssemblyInspection(),
      ...this.visibleWindowInspection(),
      viewBindGroupCreates: this.telemetryPrepared ? (view?.bindGroupCreates ?? 0) : 0,
      topologyRevision: view?.topologyRevision,
      validatedGpuOwnedRows: this.validatedGpuOwnedRows,
      cpuFallbackDrawItems: this.cpuFallbackDrawItems,
      geometryWork: this.telemetryGeometryWork,
      rootGeometryWork: this.telemetryRootGeometryWork,
      geometryWorkReduction:
        this.telemetryRootGeometryWork > 0
          ? 1 - this.telemetryGeometryWork / this.telemetryRootGeometryWork
          : 0,
      batchCount: view?.batchCount ?? 0,
      indirectDrawCount: this.indirectDrawCount,
      encodedIndirectDraws: this.encodedIndirectDraws,
      preparedBundleHits: this.preparedBundleCounters.hits,
      preparedBundleFixedHits: this.preparedBundleFixedHits,
      preparedBundleBuilds: this.preparedBundleCounters.builds,
      preparedBundleCommands: this.preparedBundleCounters.commands,
      preparedBundleEvictions: this.preparedBundleCounters.evictions,
      channels: Object.freeze(channels.map((channel) => Object.freeze(channel))),
      resourceGeneration: view?.resourceGeneration,
      candidateCapacity: view?.candidateCapacity ?? 0,
      batchCapacity: view?.batchCapacity ?? 0,
      indirectCapacity: view?.indirectCapacity ?? 0,
      overflow: this.telemetryOverflow,
      submitted: this.submissionState === 'submitted',
      recoveryCount: this.recoveryCount,
      retryCount: this.retryCount,
      lastKnownGoodGeneration: this.lastKnownGoodGeneration,
      ...(resourceAllocation === undefined ? {} : { resourceAllocation }),
      resourceAllocationOwners: this.resourceAllocationOwners(view),
      ...(resourceClasses === undefined
        ? {}
        : {
            resourceClassCount: resourceClasses.resourceClassCount,
            resourceClassSplits: resourceClasses.resourceClassSplits,
            resourceClassSplitReasons: resourceClasses.resourceClassSplitReasons,
          }),
    };
  }

  /** Main-view lanes: the claimed GPU lane plus each CPU and blocked residual. */
  private mainLaneChannels(channels: GpuDrivenLaneSummary[]): void {
    const totalDrawCount = this.mainTotalDrawItems;
    const claimedDrawCount = this.telemetryOverflow
      ? 0
      : Math.min(this.gpuOwnedDrawItems, totalDrawCount);
    const mainFacts = {
      totalDrawCount,
      claimedDrawCount,
      residualDrawCount: Math.max(0, totalDrawCount - claimedDrawCount),
    };
    const main: Pick<GpuDrivenLaneSummary, 'viewPass' | 'viewIndex'> = {
      viewPass: 'main',
      viewIndex: 0,
    };
    if (claimedDrawCount > 0 || (this.lane !== 'gpu' && this.lane !== 'blocked')) {
      channels.push({
        ...main,
        lane: this.lane,
        reason: this.laneReason,
        drawCount: claimedDrawCount,
        ...mainFacts,
      });
    }
    if (this.cpuSemanticFallbackDrawItems > 0) {
      channels.push({
        ...main,
        lane: 'cpu-semantic',
        reason: 'unsupported',
        drawCount: this.cpuSemanticFallbackDrawItems,
        ...mainFacts,
      });
    }
    if (this.cpuDeformationFallbackDrawItems > 0) {
      const reasons =
        this.cpuDeformationReasons.size === 0
          ? ([['resource-not-ready', this.cpuDeformationFallbackDrawItems]] as const)
          : this.cpuDeformationReasons.entries();
      for (const [reason, drawCount] of reasons) {
        channels.push({ ...main, lane: 'cpu-deformation', reason, drawCount, ...mainFacts });
      }
    }
    if (this.blockedDrawItems > 0) {
      channels.push({
        ...main,
        lane: 'blocked',
        reason: 'resource-not-ready',
        drawCount: this.blockedDrawItems,
        ...mainFacts,
        ...(this.preparationFailure === undefined ? {} : { failure: this.preparationFailure }),
      });
    }
  }

  /**
   * Retained view resources outlive admission. An idle frame has no current
   * GPU projection and must not publish last frame's channels.
   */
  private shadowLaneChannels(channels: GpuDrivenLaneSummary[]): void {
    for (const entry of this.shadowViews?.activeIdentities() ?? []) {
      if (this.submissionState === 'idle' || channels.length >= 32) break;
      if (entry.layer !== undefined) continue;
      let total = 0;
      let claimed = 0;
      for (const identity of [entry, staticShadowViewIdentity(entry)])
        for (const batch of this.shadowViews?.submission(identity)?.plan.batches ?? []) {
          total += batch.candidates.length;
          if (batch.visibleCapacity > 0) claimed += batch.candidates.length;
        }
      if (total === 0) continue;
      this.pushShadowLaneChannels(channels, entry, total, claimed);
    }
  }

  private pushShadowLaneChannels(
    channels: GpuDrivenLaneSummary[],
    identity: ShadowViewIdentity,
    total: number,
    claimed: number,
  ): void {
    const overflow = this.telemetryOverflow;
    const effectiveClaimed = overflow ? 0 : claimed;
    const residual = total - effectiveClaimed;
    const projected = this.shadowBatchProjections.has(shadowViewIdentityKey(identity));
    const view = {
      viewPass: shadowViewPass(identity.kind),
      viewIndex: identity.index,
      ...(identity.face === undefined ? {} : { face: identity.face }),
    };
    const counts = {
      totalDrawCount: total,
      claimedDrawCount: effectiveClaimed,
      residualDrawCount: residual,
    };
    if (projected && effectiveClaimed > 0) {
      channels.push({
        ...view,
        lane: overflow ? 'blocked' : 'gpu',
        reason: overflow ? 'overflow' : 'none',
        drawCount: effectiveClaimed,
        ...counts,
      });
    }
    if (residual > 0) {
      channels.push({
        ...view,
        lane: overflow ? 'blocked' : 'cpu-semantic',
        reason: overflow ? 'overflow' : 'unsupported',
        drawCount: residual,
        ...counts,
      });
    }
  }

  private surfaceFrameInspection() {
    const material = this.materialRaster;
    const skin = this.skinRaster;
    return {
      surfaceFrameRangeBuilds: this.surfaceFrames.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans:
        this.surfaceFrames.surfaceFrameRangeMemberScans +
        (material?.surfaceDynamicFrameMemberScans ?? 0) +
        (skin?.surfaceDynamicFrameMemberScans ?? 0),
      surfaceFrameRowAllocations:
        (material?.surfaceDynamicFrameRowAllocations ?? 0) +
        (skin?.surfaceDynamicFrameRowAllocations ?? 0),
      surfaceFrameTimeWrites: material?.surfaceDynamicFrameTimeWrites ?? 0,
    };
  }

  /** Upload counters describe only a frame whose GPU telemetry was prepared. */
  private viewUploadInspection(view: ReturnType<GpuDrivenView['inspect']> | undefined) {
    const uploads = this.telemetryPrepared ? view : undefined;
    return {
      sharedInputUploadBytes: uploads?.sharedInputUploadBytes ?? 0,
      suppressionUploadBytes: uploads?.suppressionUploadBytes ?? 0,
      batchUploadBytes: uploads?.batchUploadBytes ?? 0,
      viewConstantsUploadBytes: uploads?.viewConstantsUploadBytes ?? 0,
    };
  }

  private filteredAssemblyInspection() {
    const main = this.mainFilterContributions;
    const shadow = this.shadowFilterContributions;
    return {
      submissionWindowRelocations:
        main.windowCounters.relocations + shadow.windowCounters.relocations,
      submissionWindowCompactions:
        main.windowCounters.compactions + shadow.windowCounters.compactions,
      filteredAssemblyPublicationHits:
        main.assemblyCounters.publicationHits + shadow.assemblyCounters.publicationHits,
      filteredAssemblyHits: main.assemblyCounters.batchHits + shadow.assemblyCounters.batchHits,
      filteredAssemblyBuilds:
        main.assemblyCounters.batchBuilds + shadow.assemblyCounters.batchBuilds,
      filteredAssemblyChurnFallbacks:
        main.assemblyCounters.churnFallbacks + shadow.assemblyCounters.churnFallbacks,
    };
  }

  private visibleWindowInspection() {
    const material = this.materialRaster?.visibleWindowCounters;
    const skin = this.skinRaster?.visibleWindowCounters;
    return {
      visibleWindowCreates: (material?.creates ?? 0) + (skin?.creates ?? 0),
      visibleWindowHits: (material?.hits ?? 0) + (skin?.hits ?? 0),
      visibleWindowResets: (material?.resets ?? 0) + (skin?.resets ?? 0),
    };
  }

  private resourceAllocationOwners(view: ReturnType<GpuDrivenView['inspect']> | undefined) {
    return Object.freeze({
      ...(view === undefined ? {} : { gpuDrivenView: view.resourceAllocation }),
      ...(this.materialRaster === undefined
        ? {}
        : { materialRaster: this.materialRaster.resourceAllocation }),
      ...(this.skinRaster === undefined ? {} : { skinRaster: this.skinRaster.resourceAllocation }),
    });
  }

  /** Read renderer-owned LOD counters copied by the last GPU submission. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    if (!this.telemetryPrepared) return Promise.resolve(undefined);
    const view = this.view;
    const filtered = this.filteredCache?.value;
    const sourceFrame = this.preparations.forward.cached;
    const telemetryCandidateCount = this.telemetryCandidateCount;
    if (view === undefined) return Promise.resolve(undefined);
    const surfaceMemberId = this.surfaceFrames.capturedMemberId();
    return view.readLodSelection().then((selection) => {
      // The observer is asynchronous and prepare() may have published a new
      // filtered plan while mapAsync was pending. Do not attach old counters to
      // the new world/primitive cache; the next real copy will be observed on
      // its own generation.
      if (
        !this.telemetryPrepared ||
        this.view !== view ||
        this.filteredCache?.value !== filtered ||
        this.telemetryCandidateCount !== telemetryCandidateCount
      ) {
        return undefined;
      }
      if (selection !== undefined) {
        this.telemetryGeometryWork = selection.geometryWork;
        this.telemetryRootGeometryWork = selection.rootGeometryWork;
        this.telemetryOverflow = selection.overflow;
        if (selection.overflow) {
          if (!this.overflowRecoveryRequired) this.retryCount += 1;
          this.overflowRecoveryRequired = true;
          this.submissionState = 'aborted';
          this.lastKnownGoodGeneration = undefined;
          this.lane = 'blocked';
          this.laneReason = 'overflow';
        }
      }
      if (selection === undefined) return selection;
      if (filtered === undefined) return selection;
      type LodBatchAttribution = {
        readonly batch: GpuDrivenBatch;
        readonly primitiveSlot: number;
        readonly slotGeneration: number;
        readonly artifact?: MaterialShaderArtifact;
      };
      const preparedByBatchId = new Map<number, LodBatchAttribution>(
        filtered.batches.map((prepared) => [
          prepared.batch.batchId,
          {
            batch: prepared.batch,
            primitiveSlot: prepared.batch.members?.at(0)?.primitiveIndex ?? -1,
            slotGeneration: prepared.batch.members?.at(0)?.generation ?? -1,
            artifact: prepared.artifact,
          },
        ]),
      );
      const projectedCandidateCount =
        telemetryCandidateCount > 0 ? telemetryCandidateCount : selection.candidateCount;
      // Selector-only batches remain in filtered.plan so their GPU counters
      // can describe candidates suppressed from the raster admission lane.
      // They have no PreparedBatch entry because no draw is encoded, but they
      // still need the same World join for receipt attribution. Recover that
      // metadata from the stable primitive slot instead of dropping the whole
      // readback when the first such batch is encountered.
      const slotAt = sourceFrame?.slotAt;
      if (slotAt !== undefined) {
        for (const batch of filtered.plan.batches) {
          if (preparedByBatchId.has(batch.batchId)) continue;
          const candidate = batch.candidates.at(0);
          const slot = candidate === undefined ? undefined : slotAt(candidate.primitiveIndex);
          if (slot === undefined || slot.generation !== candidate?.generation) continue;
          preparedByBatchId.set(batch.batchId, {
            batch,
            primitiveSlot: slot.slot,
            slotGeneration: slot.generation,
          });
        }
      }
      const lodHistogram = new Map<number, number>();
      // The selector visits the full captured plan, including candidates that
      // the CPU visibility projection suppressed. Use that same plan for the
      // LOD denominator so World attribution cannot fail merely because the
      // two lanes have different frustum scopes.
      let lodCandidateCount = 0;
      let lodVisible = 0;
      for (const batchSelection of selection.batches) {
        const prepared = preparedByBatchId.get(batchSelection.batchId);
        // Selector-only or otherwise non-raster batches remain in the GPU
        // telemetry plan. They have no material producer row and therefore do
        // not invalidate readback evidence for the prepared Surface batches.
        if (prepared === undefined) continue;
        // The GPU selector also visits ordinary GPU-driven meshes so one
        // compact compute path can populate their indirect args. Those rows
        // are level-0 by construction, but they are not LOD candidates and
        // must not enter receipt-bound LOD attribution. Batch topology keeps
        // LOD coverage/ranges in the grouping key, so a batch is expected to
        // be homogeneous; fail closed if a producer violates that invariant
        // instead of guessing a split for aggregate counters.
        const lodCandidateRows =
          (prepared.batch.lod?.coverages.length ?? 0) > 1 ? prepared.batch.candidates : [];
        if (lodCandidateRows.length === 0) continue;
        if (lodCandidateRows.length !== batchSelection.candidateCount) return undefined;
        lodCandidateCount += batchSelection.candidateCount;
        lodVisible += batchSelection.visible;
        for (const row of batchSelection.lodHistogram) {
          lodHistogram.set(row.level, (lodHistogram.get(row.level) ?? 0) + row.count);
        }
      }
      const candidateCount = lodCandidateCount > 0 ? lodCandidateCount : projectedCandidateCount;
      const visible = lodCandidateCount > 0 ? lodVisible : selection.visible;
      return {
        ...selection,
        gpuSelection: Object.freeze({
          candidateCount: selection.candidateCount,
          visible: selection.visible,
          frustumCulled: selection.frustumCulled,
          texelCulled: selection.texelCulled,
          cameraCulled: selection.cameraCulled,
          overflow: selection.overflow,
          geometryWork: selection.geometryWork,
          rootGeometryWork: selection.rootGeometryWork,
          ...(selection.occlusion === undefined ? {} : { occlusion: selection.occlusion }),
        }),
        candidateCount,
        visible,
        occluded: Math.max(0, candidateCount - visible),
        lodHistogram: Object.freeze(
          [...lodHistogram.entries()]
            .sort(([left], [right]) => left - right)
            .map(([level, count]) => Object.freeze({ level, count })),
        ),
        surfaceActualMemberIds: Object.freeze(
          selection.actualMembers.flatMap((member) => {
            const prepared = preparedByBatchId.get(member.batchId);
            if (
              prepared === undefined ||
              prepared.artifact === undefined ||
              !isSingleLayerMediumArtifact(prepared.artifact)
            ) {
              return [];
            }
            const slot = sourceFrame?.slotAt(member.primitiveIndex);
            // A slot reused after the copy was encoded is another row.
            if (slot === undefined || slot.generation !== member.generation) return [];
            const memberId = surfaceMemberId(
              slot.entityKey,
              member.drawItemIndex,
              member.instanceOrdinal,
            );
            return memberId === undefined ? [] : [memberId];
          }),
        ),
      };
    });
  }

  /**
   * Bounded counters from a caller-requested submitted-draw observation. The
   * summary is settled only when inspected and dropped by the next frame.
   */
  recordDrawSummary(summary: () => GpuDrawSummary): void {
    this.pendingDrawSummary = summary;
  }

  private settleDrawSummary(): void {
    const settle = this.pendingDrawSummary;
    if (settle === undefined) return;
    this.pendingDrawSummary = undefined;
    const summary = settle();
    this.gpuOwnedDrawItems = summary.gpuDraws;
    this.gpuOwnedEntityCount = summary.gpuEntities;
    this.mainTotalDrawItems = summary.totalDraws;
    this.validatedGpuOwnedRows = summary.mixedEntities;
    this.cpuFallbackDrawItems = summary.cpuDraws;
    this.cpuSemanticFallbackDrawItems = summary.semanticDraws;
    this.cpuDeformationFallbackDrawItems = summary.deformationDraws;
    this.blockedDrawItems = summary.blockedDraws;
    this.cpuDeformationReasons.clear();
    for (const [reason, count] of summary.deformationReasons)
      this.cpuDeformationReasons.set(reason, count);
  }
}

export type {
  CurrentCameraRaster,
  GpuDrivenGraphProjection,
  GpuDrivenMaterialBinding,
  GpuDrivenPrepareInput,
  PreparedGpuDrivenFrame,
  ShadowViewRequest,
} from './production-raster-contract';
