import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderBundle,
  RenderPipeline,
  Result,
  RhiDevice,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState, ResultOk } from '@forgeax/engine-types';
import { isStripTopology } from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  boundGeometryObservationMetadata,
  captureGeometrySource,
  GEOMETRY_OBSERVATION_MAX_COMMANDS,
  GEOMETRY_OBSERVATION_MAX_MEMBERS,
  type GeometryCommandCapture,
  type GeometryGBufferProgram,
  type GeometryObservation,
  type GeometrySourceIdentity,
  unavailableGeometry,
} from '../geometry-observation';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type {
  GpuDrivenLaneReason,
  GpuDrivenLaneSummary,
  GpuDrivenPreparationFailureInspection,
  GpuDrivenProductionInspection,
  GpuDrivenStructureMetrics,
} from '../inspection-types';
import { reflectedRenderState } from '../material-render-state';
import {
  isCanonicalStandardPbrMaterialShader,
  pbrSkinMeshDynamicOffsets,
  SKIN_UNCOVERED_GBUFFER_ENTRY,
} from '../pbr-pipeline';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { GpuDrawSummary } from '../record/gpu-draw-receipts';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { CameraSnapshot, FramePresentationPendingReason } from '../render-contract';
import type {
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import { type ShadowMaterialContent, sameShadowMaterial } from '../scene/material-shadow-content';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import {
  admitSingleLayerMediumSubmission,
  type SurfaceGpuSubmissionAdmission,
} from '../surface/gpu-driven';
import type { SurfaceSubmissionCandidate } from '../surface/submission-observation';
import { capturedGpuDrivenBatchKey } from './batch-key';
import {
  batchLevelStride,
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
} from './batch-layout';
import { MemberCandidates } from './batch-members';
import {
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
  inspectResourceClassSplits,
  type SubmissionPlan,
} from './batch-topology';
import { EMPTY_GPU_DRAW_SELECTION, type GpuDrawSelection } from './draw-selection';
import { FilteredPlanContributionOwner } from './filtered-plan-contributions';
import {
  type GBufferOrderDiagnosticConfig,
  type GBufferOrderDiagnosticInspection,
  type GBufferOrderEncodeEvidence,
  gbufferBatchDepth,
  gbufferDiagnosticView,
  gbufferOrderInterfaceEvidence,
  gbufferProgramDigest,
  isGBufferOrderDiagnosticEncode,
  orderGBufferDiagnostic,
} from './gbuffer-order-diagnostic';
import { type LiveRasterBatch, type LiveRasterCache, projectLiveRaster } from './live-raster';
import type { LodViewCamera } from './lod-projection.wgsl';
import { type BatchExecutions, prepareHiddenGpuDrivenPipelines } from './material-artifacts';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
  PreparedRasterPassCache,
  prepareRasterWindows,
} from './prepared-raster-bundle';
import { activeFrustum, occlusionCamera, shadowViewClipping } from './production-raster-camera';
import {
  admittedRasterBatchCount,
  type LodProjectionState,
  lodCoverageMayFade,
  lodProjectionState,
  lodSelectionChangeCount,
  lodViewCameraFromMatrix,
  shadowLodProjectionState,
} from './production-raster-lod';
import {
  MaterialAbiRasterAdapter,
  resolveGpuDrivenMeshGroup,
  SurfaceFrameProjectionOwner,
  standardSurfaceDiscardMask,
} from './production-raster-material';
import {
  assemblePreparedPlan,
  BatchPreparation,
  type FilteredProductionPlan,
  type PreparedBatchRows,
  type PreparedProductionPlan,
  prepareBatchRows,
  sameMaterialArtifact,
  samePreparedBatchLod,
  suppressedPrimitiveWords,
} from './production-raster-prepare';
import {
  observeShadowArtifacts,
  preparationFailureInspection,
  type ShadowArtifactObservations,
  sameEntityKeySet,
  shadowMaterialKey,
} from './production-raster-support';
import { RasterGraphIdentity } from './raster-graph-identity';
import { gpuRasterFilterMatches, gpuTemporalEligible } from './raster-selection';
import { combineGpuResourceAllocationInspections } from './resource-allocation';
import {
  batchExecutionKey,
  preparedAssemblyInputs,
  samePreparedAssemblyInputs,
} from './retained-batch-inputs';
import {
  classOwner,
  materialOwner,
  type RetainedRasterBlock,
  RetainedRasterEncodes,
  runFacts,
} from './retained-raster-encode';
import { restrictShadowCasterClasses, ShadowCasterClassifier } from './shadow-caster-classes';
import { filteredRows, ShadowProjectionDiffs } from './shadow-projection-diffs';
import { publishReadonlyMap, sameShadowProjectionLayout } from './shadow-projection-publication';
import {
  type ShadowCameraCullDilation,
  type ShadowViewIdentity,
  type ShadowViewProjection,
  ShadowViewStatePool,
  type ShadowViewUpdate,
  type ShadowViewUpdateInput,
  shadowViewHasStaticLayer,
  shadowViewIdentityKey,
} from './shadow-views';
import {
  type GpuDrivenLodSelectionInspection,
  type GpuDrivenLodSubmitIdentity,
  type GpuDrivenOcclusionCamera,
  GpuDrivenView,
  selectGpuLodLane,
} from './view-gpu';

function requireViewSkinTask(view: GpuDrivenView) {
  const task = view.skinTaskBinding();
  if (task === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'actual GPU view Skin task output',
      hint: 'prepare the fixed Skin frame before recording this selected view',
    });
  return task;
}

export interface GpuDrivenShadowBatchProjection {
  /** Batch-owned command closure; retained projection edits validate its physical inputs. */
  readonly bundles: PreparedRasterBundleCache;
  readonly mesh: MeshGpuHandles;
  readonly meshContentEpoch: number;
  readonly meshBindGroup: BindGroup;
  /** One visible-segment window per LOD level command, in level order. */
  readonly visibleBindGroups: readonly BindGroup[];
  readonly deformation: 'rigid' | 'skin';
  /** Actual producer-selected shadow-pass artifact for this batch. */
  readonly shadowArtifact: MaterialShaderArtifact;
  /** Pass entry points selected by the authored ShadowCaster dispatch. */
  readonly shadowVertexEntry?: string;
  readonly shadowFragmentEntry?: string;
  readonly shadowRenderState?: MaterialRenderState;
  /** Material snapshot used to assemble the receipt-owned alpha-mask BG. */
  readonly material: MaterialSnapshot;
  /** Accepted resource namespace. GPU execution has no entity-local video binding. */
  readonly worldId: number;
  /** Geometry-owned COLOR_0 fact shared by main and shadow ABI variants. */
  readonly vertexColorAvailable: boolean;
}

/**
 * A shadow view the frame asks for. Its camera cull names only the receiver
 * dilation; the main camera it tests against is the one the pyramid was built
 * from, attached here so the two cannot diverge.
 */
export type ShadowViewRequest = Omit<
  ShadowViewUpdateInput,
  'sourcePlan' | 'scene' | 'cameraCull' | 'inputReads' | 'skin' | 'capsuleDirectional'
> & {
  readonly cameraCull?: ShadowCameraCullDilation;
  /**
   * `false` projects a final view once with every caster and retains no
   * static layer for it. Absent keeps the cached static layer.
   */
  readonly staticLayer?: false;
};

function isSingleLayerMediumArtifact(artifact: MaterialShaderArtifact): boolean {
  return artifact.receipt?.surface?.model === 'single-layer-medium';
}

export interface GpuDrivenWorldLodSelectionInspection {
  readonly worldKey: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
  readonly candidateCount: number;
  readonly visible: number;
  readonly occluded: number;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
}

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

/** The GPU-driven bridge to the existing four-group Standard PBR pipeline. */

export interface GpuDrivenMaterialBinding {
  readonly material: import('../material-resource').MaterialResource;
  readonly worldId: number;
  readonly resourceClass: string;
}

export interface PreparedGpuDrivenFrame {
  /** Shared resource requirements from the accepted geometry/probe partitions. */
  readonly materialBindings: readonly GpuDrivenMaterialBinding[];
  readonly shadowDirectRequired: boolean;
  readonly topologySignature: string;
  /** @internal Private stock-recorder identity; borrowed graph projections keep topologySignature. */
  readonly _recordingTopologySignature?: string;
  /** Composition-local world indices mapped to the stable identities used by draw keys. */
  readonly worldKeys: readonly number[];
  /** Shared execution queried by each actual draw consumer. */
  readonly selection: GpuDrawSelection;
  readonly standardPbrFrameResources: GpuDrivenStandardPbrFrameResources;
  /** Published Surface admission and its pass lane decision. */
  readonly surfaceSubmission?: SurfaceGpuSubmissionAdmission;
  /** @internal Pins physical work independently of accepted frame publication. */
  readonly _trackSubmittedWork: (completed: Promise<void>) => void;
  /** @internal Close actual main/shadow demands before independent submission. */
  readonly _sealResourceReads: () => Result<void, RhiError>;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: (submittedGraphGeneration?: number) => void;
  /** @internal Retires superseded view buffers when graph compilation promotes them. */
  readonly _commitGpuResourceReplacement?: () => void;
  /** @internal Discards staged shadow cache publication after a failed frame. */
  readonly _abortResourceReplacement?: () => void;
  /** @internal Marks validated dynamic ranges consumed only after queue submit. */
  readonly _consumeSurfaceDynamicInput?: (frameNumber: number) => Result<void, RhiError>;
  /** `cameraPyramid` is the main camera's late HZB; eligible views cull against it. */
  readonly projectShadow?: (
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    identity: ShadowViewIdentity,
    forceCompute?: boolean,
    cameraPyramid?: GraphTextureView,
  ) => Result<ShadowViewProjection | undefined, RenderGraphError>;
  readonly updateShadowViews?: (views: readonly ShadowViewRequest[]) => Result<void, RhiError>;
  readonly shadowViewPool?: ShadowViewStatePool;
  readonly shadowBatchProjections?: ReadonlyMap<
    string,
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>
  >;
  project(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    additionalColorFormats?: readonly TextureFormat[],
    lateOcclusion?: boolean,
    /** @internal Only the private stock Renderer recording closure supplies this. */
    rendererRecording?: boolean,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError>;
}

type RasterPipelineFor = (
  formats: readonly TextureFormat[],
  formatKey?: string,
  preparation?: boolean,
) => Result<RenderPipeline, RhiError>;

export interface GpuDrivenPrepareInput {
  readonly materialArtifactResolver?: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly materialFrame?: import('../scene/material-dispatch').MaterialFrame;
  readonly shadowMaterials?: ShadowMaterialContent;
  readonly shadowViews?: boolean;
  readonly scene: PersistentGpuDrivenState | undefined;
  readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
  /** The already selected frame lane; Surface still shares its retained resource owner. */
  readonly geometryLane?: 'automatic' | 'direct';
  readonly gbufferBatchOrderDiagnostic?: GBufferOrderDiagnosticConfig | undefined;
  readonly visibleSurface?: import('../raytracing/visible-surface').VisibleSurfaceProjection;
  readonly camera: CameraSnapshot;
  /** Shared mesh residency, independent of the number of bound scene members. */
  readonly meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly viewBindGroupLayout: BindGroupLayout;
  /** Optional for legacy Standard callers; omitted means non-HDRP. */
  readonly hdrp?: boolean;
  /** Explicit Standard topology; cluster resources are bound by main-pass. */
  readonly clustered?: boolean;
  readonly materialBindingClasses?: ReadonlyMap<string, string>;
  /** Cooked producer artifact selected from the frame material catalog. */
  readonly materialArtifact?: MaterialShaderArtifact;
  /** Cooked producer artifact for the GPU skinning variant. */
  readonly materialSkinArtifact?: MaterialShaderArtifact;
  /** Per-draw producer artifacts keyed by prepared identity and receipt. */
  readonly materialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  /** Per-draw shadow-pass artifacts keyed by the same prepared identity. */
  readonly shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  /** Retained ProbeBlend record page; slot N is addressed at aligned lane N+1. */
  readonly probeBlendRecordBuffer?: Buffer;
  readonly materialPipelineState?: PipelineState;
  /** Existing renderer owner that builds the selected artifact PSO/BGL. */
  readonly materialPipelineFactory?: MaterialPipelineFactory;
  readonly materialPipelinePreparationFactory?: MaterialPipelineFactory;
  /** Capsule-ready casters leave the directional cascades (Deferred lane only). */
  readonly capsuleShadowDirectional?: boolean;
  /** Entity keys admitted by the persistent visibility facet for this view. */
  readonly activeEntityKeys?: ReadonlySet<number>;
  /** Collision-free renderer-owned revision for the active visibility set. */
  readonly activeEntityRevision?: number;
  /** Total extracted candidates, including facet-suppressed rows. */
  readonly telemetryCandidateCount?: number;
  /** Public receipt identity for the GPU telemetry copy encoded this frame. */
  readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
  /** Per-frame deltas from the existing RenderScene/GPU Scene/palette owners. */
  readonly structureMetrics?: GpuDrivenStructureMetrics;
  /** World/App frame-time snapshot consumed by authored Surface code. */
  readonly frameTime?: number;
  /** Current RHI device generation used for Surface admission. */
  readonly deviceGeneration?: number;
  /** Renderer-owned generic read-only Surface page and instance ranges. */
  readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
  /** Optional profiler seam for the `record/gpu-driven-prepare/*` phases. */
  readonly profilePhase?: RecordProfileRunner;
}

export class GpuDrivenProduction {
  private readonly resourceFrames = new Set<GpuSceneResourceFrame>();
  private disposed = false;
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
  private geometryCapture:
    | {
        commands: GeometryCommandCapture[];
        members: number;
        failure?: string;
        source: (
          slot: import('../scene/render-scene-types').RenderSceneSlot,
        ) => Pick<
          GeometrySourceIdentity,
          'worldIdentity' | 'meshGuid' | 'sourceKey' | 'sourceRevision'
        >;
      }
    | undefined;
  beginGeometryObservation(
    source: NonNullable<GpuDrivenProduction['geometryCapture']>['source'] | undefined,
  ): void {
    this.geometryCapture = source === undefined ? undefined : { commands: [], members: 0, source };
  }
  async observeGeometry(receipt: {
    frameId: number;
    deviceGeneration: number;
  }): Promise<GeometryObservation> {
    const capture = this.geometryCapture,
      view = this.view;
    if (capture === undefined || view === undefined)
      return unavailableGeometry('not-captured', receipt.frameId, receipt.deviceGeneration);
    try {
      if (capture.failure !== undefined) throw Error(capture.failure);
      const { commands, viewConstants } = await view.readGeometryCommands(
        capture.commands,
        receipt,
      );
      if (capture !== this.geometryCapture || view !== this.view) throw Error('superseded');
      const result: GeometryObservation = {
        scope: 'primary-display-view-gpu-commands',
        otherViews: 'unobserved',
        shadows: 'unobserved',
        cpuDraws: 'unobserved',
        featureDraws: 'unobserved',
        status: 'complete',
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        viewConstants,
        commands,
        commandCount: commands.length,
        indexOrVertexWork: commands.reduce((n, c) => n + c.indexOrVertexWork, 0),
      };
      return boundGeometryObservationMetadata(result);
    } catch (error) {
      return unavailableGeometry(
        error instanceof Error ? error.message : 'readback-failed',
        receipt.frameId,
        receipt.deviceGeneration,
      );
    }
  }
  private view: GpuDrivenView | undefined;
  private materialRaster: MaterialAbiRasterAdapter | undefined;
  private skinRaster: MaterialAbiRasterAdapter | undefined;
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
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
  private admissionCache:
    | {
        readonly source: SubmissionPlan;
        readonly sceneCapacity: number;
        readonly activeEntityRevision?: number;
        readonly activeEntityKeys?: ReadonlySet<number>;
        readonly suppressed?: Uint32Array;
      }
    | undefined;
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
  private lodSelectionChanges = 0;
  private lodSelectionBaseline:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly selections: readonly (readonly number[])[];
      }
    | undefined;
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
  /** Draw bindings follow physical resources and topology, independently of depth invalidation. */
  private readonly shadowProjectionSources = new WeakMap<
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    {
      readonly plan: SubmissionPlan;
      filtered: FilteredProductionPlan;
      /** Executions every projected material was validated against. */
      executions?: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
      artifacts: ShadowArtifactObservations;
      readonly visibleBuffer: Buffer;
      readonly meshBinding: BindGroup;
      readonly skinMeshBinding: BindGroup | undefined;
      readonly visibleBindingIdentity: object;
      readonly skinVisibleBindingIdentity: object | undefined;
    }
  >();
  private readonly shadowCasterClasses = new ShadowCasterClassifier();
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
  ) {}

  static forDevice(
    device: RhiDevice,
    shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ): GpuDrivenProduction {
    return new GpuDrivenProduction(device, shaderModuleFactory);
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'scene-table',
      create: () => {
        if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
        // Keep the actual detached production owner in the generation
        // aggregate. The recovery transaction, not a marker object, is the
        // owner that is published or discarded exactly once.
        return this;
      },
      cleanup: () => undefined,
    };
  }

  prepare(
    input: GpuDrivenPrepareInput,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    if (this.resourceFrames.size !== 0)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'finish the unsubmitted GPU preparation before preparing another frame',
          hint: 'submit or abort the existing recording; game asset edits remain independent',
        }),
      );
    const sources = input.scene?.plan.sourceGroups;
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
    const finishMaterials = (): boolean => {
      if (materials === undefined || !this.resourceFrames.delete(materials)) return false;
      materials.release();
      return true;
    };
    this.surfaceArtifactInspection = undefined;
    this.retainedEncodes.beginFrame();
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.preparedBatchBuilds = 0;
    this.filteredBatchBuilds = 0;
    this.planRebuildBatches = 0;
    this.preparedAssemblyHits = 0;
    this.planRebuildCandidates = 0;
    this.lodSelectionChanges = 0;
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
    if (
      input.scene === undefined ||
      (input.hdrp === true && input.clustered !== true) ||
      selectGpuLodLane(this.device.caps) === 'cpu'
    ) {
      this.gpuOwnedEntityCount = 0;
      return ok(undefined);
    }
    if (this.overflowRecoveryRequired && this.view !== undefined) {
      const recovered = this.view._recoverFromOverflow();
      if (!recovered.ok) {
        this.gpuOwnedEntityCount = 0;
        this.lane = 'blocked';
        this.laneReason = 'capacity';
        return recovered;
      }
      this.overflowRecoveryRequired = false;
    }
    const scene = input.scene;
    if (materials === undefined)
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'the captured GPU Scene resource frame',
          hint: 'capture the Scene read domain before GPU preparation',
        }),
      );
    const materialArtifact = input.materialArtifact;
    const skinArtifact = input.materialSkinArtifact;
    const materialPipelineState = input.materialPipelineState;
    if (materialPipelineState === undefined) {
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
      this.gpuOwnedEntityCount = 0;
      this.lane = 'blocked';
      this.laneReason = 'resource-not-ready';
      this.blockedDrawItems = scene.plan.batches.reduce(
        (total, batch) => total + batch.candidates.length,
        0,
      );
      this.preparationFailure = preparationFailureInspection(rebuilt.error);
      return rebuilt;
    }
    const preparedPlan = rebuilt.value;
    if (input.geometryLane === 'direct') {
      let hasSurface =
        materialArtifact?.receipt?.surface !== undefined ||
        skinArtifact?.receipt?.surface !== undefined;
      if (!hasSurface && input.materialArtifacts !== undefined) {
        for (const artifact of input.materialArtifacts.values()) {
          if (artifact.receipt?.surface !== undefined) {
            hasSurface = true;
            break;
          }
        }
      }
      if (!hasSurface) {
        // Direct commands consume the ordinary validated meshes and scene material
        // table. Receipt/mesh admission above still runs, but none of the filtered
        // indirect plan, cull buffers or scene-index raster bindings is consumed.
        // Surface retains the complete shared page/frame/instance preparation below.
        this.gpuOwnedEntityCount = 0;
        this.laneReason = 'unsupported';
        // Main grouping has no shadow claim filter: every admitted draw has
        // a candidate group. Preserve its empty/CPU-only resource fallback.
        if (!preparedPlan.batchRows.some((row) => row.fact !== undefined)) return ok(undefined);
        this.shadowSource = undefined;
        this.shadowScene = undefined;
        this.liveRasterBatches = [];
        this.disableShadowViews();
        const view = this.view;
        const shadowViews = this.shadowViews;
        return ok({
          materialBindings: [],
          topologySignature: 'direct',
          worldKeys: scene.worldKeys ?? [],
          selection: EMPTY_GPU_DRAW_SELECTION,
          shadowDirectRequired: true,
          standardPbrFrameResources: {
            prepareMaterialBinding: () => undefined,
            materialSlotIndicesByBinding: new Map(),
            sceneMaterialBuffer: scene.scene.materialBuffer,
          },
          ...(shadowViews === undefined ? {} : { shadowViewPool: shadowViews }),
          _trackSubmittedWork: (completed) => materials?.submit(completed),
          _sealResourceReads: () => {
            try {
              return materials?.seal() ?? ok(undefined);
            } finally {
              this.shadowViews?._closeInputReads();
            }
          },
          _commitResourceReplacement: () => {
            if (!finishMaterials()) return;
            // A successful direct graph releases the superseded GPU graph's
            // imports and shadows. It does not submit a new GPU geometry generation.
            view?._commitResourceReplacement();
            shadowViews?._commitResourceReplacement();
          },
          _abortResourceReplacement: () => {
            if (!finishMaterials()) return;
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
    }
    const filterStage = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter',
      () => {
        const lodProjection = lodProjectionState(
          preparedPlan,
          input.camera,
          scene.slotAt,
          input.profilePhase,
        );
        const lodBaseline = this.lodSelectionBaseline;
        this.lodSelectionChanges =
          lodBaseline?.prepared === preparedPlan
            ? lodSelectionChangeCount(
                lodBaseline.selections,
                lodProjection.selections,
                preparedPlan.lodPlan,
              )
            : 0;
        this.lodSelectionBaseline = {
          prepared: preparedPlan,
          selections: lodProjection.selections,
        };
        let filtered = this.filteredCache?.value;
        // Empty ordinary bindings cannot change a retained prepared plan.
        // Nonempty maps still check their admitted values; raw inputs retain
        // their complete observation fence and custom-get behavior.
        if (
          filtered === undefined ||
          this.filteredCache?.prepared !== preparedPlan ||
          this.filteredCache.bindings !== input.materialBindingClasses
        ) {
          filtered = runRecordProfilePhase(
            input.profilePhase,
            'record/gpu-driven-prepare/filter/main-plan',
            () =>
              this.mainFilterContributions.update(
                preparedPlan,
                input.materialBindingClasses,
                input.profilePhase === undefined
                  ? undefined
                  : (part, action) =>
                      runRecordProfilePhase(
                        input.profilePhase,
                        part === 'groups'
                          ? 'record/gpu-driven-prepare/filter/main-plan/groups'
                          : part === 'group-key'
                            ? 'record/gpu-driven-prepare/filter/main-plan/groups/key'
                            : 'record/gpu-driven-prepare/filter/main-plan/batches',
                        action,
                      ),
              ),
          );
          this.filteredPlanBuilds = Number(filtered !== this.filteredCache?.value);
          this.filteredCache = {
            prepared: preparedPlan,
            bindings: input.materialBindingClasses,
            value: filtered,
          };
          this.filteredBatchBuilds += this.mainFilterContributions.lastWork.projectedBatches;
        }
        runRecordProfilePhase(input.profilePhase, 'record/gpu-driven-prepare/filter/counts', () => {
          this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        });
        let shadowFiltered: FilteredProductionPlan | undefined;
        if (input.shadowViews === true) {
          const shadowPrepared = this.assemblePrepared(
            scene,
            materials,
            'shadow',
            input.batchExecutions,
            input.meshByBinding,
            input.profilePhase,
          ).unwrap();
          shadowFiltered = this.shadowFilteredCache?.value;
          if (
            shadowFiltered === undefined ||
            this.shadowFilteredCache?.prepared !== shadowPrepared
          ) {
            shadowFiltered = runRecordProfilePhase(
              input.profilePhase,
              'record/gpu-driven-prepare/filter/shadow-plan',
              () =>
                this.shadowFilterContributions.update(
                  shadowPrepared,
                  undefined,
                  input.profilePhase === undefined
                    ? undefined
                    : (part, action) =>
                        runRecordProfilePhase(
                          input.profilePhase,
                          part === 'groups'
                            ? 'record/gpu-driven-prepare/filter/shadow-plan/groups'
                            : part === 'group-key'
                              ? 'record/gpu-driven-prepare/filter/shadow-plan/groups/key'
                              : 'record/gpu-driven-prepare/filter/shadow-plan/batches',
                          action,
                        ),
                ),
            );
            this.filteredBatchBuilds += this.shadowFilterContributions.lastWork.projectedBatches;
            this.shadowFilteredCache = {
              prepared: shadowPrepared,
              value: shadowFiltered,
            };
          }
        }
        if (filtered.batches.length === 0 && (shadowFiltered?.batches.length ?? 0) === 0)
          return undefined;
        const sceneCapacity = scene.scene.rowCapacity;
        const cachedAdmission = this.admissionCache;
        const admissionMatches =
          cachedAdmission !== undefined &&
          cachedAdmission.source === scene.plan &&
          cachedAdmission.sceneCapacity === sceneCapacity &&
          (input.activeEntityRevision !== undefined &&
          cachedAdmission.activeEntityRevision !== undefined
            ? input.activeEntityRevision === cachedAdmission.activeEntityRevision
            : sameEntityKeySet(cachedAdmission.activeEntityKeys, input.activeEntityKeys));
        const admission = runRecordProfilePhase(
          input.profilePhase,
          'record/gpu-driven-prepare/filter/admission',
          () =>
            admissionMatches
              ? cachedAdmission
              : {
                  source: scene.plan,
                  sceneCapacity,
                  ...(input.activeEntityRevision === undefined
                    ? {}
                    : { activeEntityRevision: input.activeEntityRevision }),
                  ...(input.activeEntityKeys === undefined
                    ? {}
                    : { activeEntityKeys: input.activeEntityKeys }),
                  ...(input.activeEntityKeys === undefined
                    ? {}
                    : {
                        suppressed: suppressedPrimitiveWords(
                          scene.slots,
                          scene.worldKeys,
                          input.activeEntityKeys,
                          sceneCapacity,
                        ),
                      }),
                },
        );
        this.admissionCache = admission;
        return {
          lodProjection,
          filtered,
          admission,
          shadowFiltered,
        };
      },
    );
    if (filterStage === undefined) {
      this.laneReason = 'unsupported';
      return ok(undefined);
    }
    const { lodProjection, filtered, admission, shadowFiltered } = filterStage;
    const surfaceArtifact = filtered.materialBatches.find(
      ({ artifact }) => artifact.receipt?.surface?.model === 'single-layer-medium',
    )?.artifact;
    this.surfaceArtifactInspection =
      surfaceArtifact?.receipt === undefined ||
      surfaceArtifact.receipt.sceneIndexEntry === undefined
        ? undefined
        : Object.freeze({
            material: surfaceArtifact.material,
            specializationKey: surfaceArtifact.specializationKey,
            variantSet: surfaceArtifact.variantSet,
            layoutIdentity: surfaceArtifact.layoutIdentity,
            receiptIdentity: surfaceArtifact.receipt.receiptIdentity,
            receiptGeneration: surfaceArtifact.receipt.generation,
            directEntry: surfaceArtifact.receipt.directEntry,
            sceneIndexEntry: surfaceArtifact.receipt.sceneIndexEntry,
          });
    const surfaceDynamicInputLayout = surfaceArtifact?.receipt?.surface?.dynamicInput?.layout;
    if (surfaceArtifact?.receipt?.surface !== undefined) {
      const deviceGeneration = input.deviceGeneration ?? 1;
      const admitted = admitSingleLayerMediumSubmission({
        abi: surfaceArtifact.receipt,
        caps: {
          compute: this.device.caps.compute,
          storageBuffer: this.device.caps.storageBuffer,
          indirectDrawing: this.device.caps.indirectDrawing,
        },
        sceneIndexReady: surfaceArtifact.receipt.sceneIndexEntry !== undefined,
        resourcesReady:
          surfaceArtifact.receipt.reflection.layoutIdentity === surfaceArtifact.layoutIdentity,
        dynamicInputReady:
          surfaceArtifact.receipt.surface.dynamicInput === undefined ||
          input.surfaceDynamicInput !== undefined,
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
    }
    this.lane = 'gpu';
    this.laneReason = 'none';
    this.submissionState = 'pending';
    this.shadowSource = shadowFiltered;
    this.shadowScene = scene.scene;
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
    // Candidate order is the same address carried in rigid visibleItems.z.
    // The shared GPU Scene owns transforms; this projection carries identity only.
    const surfaceRows =
      input.visibleSurface === undefined
        ? undefined
        : new Uint32Array(filtered.plan.candidateCount);
    if (surfaceRows !== undefined) {
      let row = 0;
      for (const batch of filtered.plan.batches) {
        for (const candidate of batch.candidates) {
          const slot = scene.slotAt(candidate.primitiveIndex);
          const base = input.visibleSurface?.slotBases.get(candidate.primitiveIndex) ?? 0;
          const instanceCount = slot?.snapshot.instances?.instanceCount ?? 1;
          surfaceRows[row++] =
            base === 0
              ? 0
              : base +
                (batch.binding?.drawItemIndex ?? candidate.drawItemIndex) * instanceCount +
                candidate.instanceOrdinal;
        }
      }
    }
    const updated = this.view.update(
      filtered.plan,
      scene.scene,
      materials.inputReads(),
      activeFrustum(input.camera),
      input.camera,
      0,
      admission.suppressed,
      undefined,
      occlusionCamera(input.camera),
      surfaceRows,
      undefined,
      scene.skin,
    );
    if (!updated.ok) return updated;
    this.view.setTelemetrySubmit(input.telemetrySubmit);
    this.telemetryPrepared = true;
    const view = this.view;
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
    const representativeArtifact =
      filtered.materialBatches[0]?.artifact ?? shadowFiltered?.materialBatches[0]?.artifact;
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
    if (this.materialRaster === undefined) {
      const created = MaterialAbiRasterAdapter.create({
        device: this.device,
        pipelineState: materialPipelineState,
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
    } else {
      const probe = this.materialRaster.ensureProbeBlendRecordBuffer(input.probeBlendRecordBuffer);
      if (!probe.ok) return probe;
      const rebound = this.materialRaster.ensureVisibleBuffer(visibleBuffer);
      if (!rebound.ok) return rebound;
    }
    const materialRaster = this.materialRaster;
    if (materialRaster === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'material ABI raster adapter after prepared artifact admission',
          hint: 'keep the selected material artifact and PipelineState on one frame identity',
        }),
      );
    }
    const skinBatch =
      filtered.batches.find(({ batch }) => batch.prepared?.identity.deformation === 'skin') ??
      shadowFiltered?.batches.find(({ batch }) => batch.prepared?.identity.deformation === 'skin');
    if (skinBatch !== undefined) {
      const selectedSkinArtifact = skinBatch.artifact;
      if (this.skinRaster === undefined) {
        const created = MaterialAbiRasterAdapter.create({
          device: this.device,
          pipelineState: materialPipelineState,
          artifact: selectedSkinArtifact,
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
      } else {
        const probe = this.skinRaster.ensureProbeBlendRecordBuffer(input.probeBlendRecordBuffer);
        if (!probe.ok) return probe;
        const rebound = this.skinRaster.ensureVisibleBuffer(visibleBuffer);
        if (!rebound.ok) return rebound;
      }
    }
    const skinRaster = this.skinRaster;
    // Visible windows bind the whole GPU Scene instance and primitive tables;
    // rebinding follows table growth, never per-frame row content.
    const sceneRowCapacity = input.scene.scene.rowCapacity;
    for (const sceneRaster of [materialRaster, skinRaster]) {
      sceneRaster?.ensureSceneTables(
        input.scene.scene.instanceBuffer,
        sceneRowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
        input.scene.scene.primitiveBuffer,
        sceneRowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
        view.visibleSurfaceRowsBuffer,
      );
    }
    if (this.surfaceSubmission !== undefined) {
      const surfaceFrameRangesResult = this.surfaceFrames.resolve(
        filtered,
        input.surfaceDynamicInput,
        input.scene,
      );
      if (!surfaceFrameRangesResult.ok) return surfaceFrameRangesResult;
      const surfaceFrameProjection = surfaceFrameRangesResult.value;
      const surfaceFrameRanges = surfaceFrameProjection.ranges;
      // Frame rows are keyed by GPU Scene instance row and bound whole.
      const surfaceFrameCapacity = Math.max(
        input.scene.scene.rowCapacity,
        surfaceFrameProjection.capacity,
      );
      const surfaceInput = materialRaster.ensureSurfaceDynamicInput(
        input.surfaceDynamicInput,
        surfaceFrameCapacity,
        input.surfaceDynamicInput?.frameTime ?? input.frameTime ?? 0,
        surfaceDynamicInputLayout,
        input.deviceGeneration ?? 1,
        surfaceFrameRanges,
      );
      if (!surfaceInput.ok) return surfaceInput;
      if (skinRaster !== undefined) {
        const skinSurfaceInput = skinRaster.ensureSurfaceDynamicInput(
          input.surfaceDynamicInput,
          surfaceFrameCapacity,
          input.surfaceDynamicInput?.frameTime ?? input.frameTime ?? 0,
          surfaceDynamicInputLayout,
          input.deviceGeneration ?? 1,
          surfaceFrameRanges,
        );
        if (!skinSurfaceInput.ok) return skinSurfaceInput;
      }
      const committedSurfaceInput = materialRaster.commitSurfaceDynamicInput();
      if (!committedSurfaceInput.ok) return committedSurfaceInput;
      if (skinRaster !== undefined) {
        const committedSkinSurfaceInput = skinRaster.commitSurfaceDynamicInput();
        if (!committedSkinSurfaceInput.ok) return committedSkinSurfaceInput;
      }
      this.surfaceFrames.remember(
        filtered,
        input.surfaceDynamicInput,
        input.scene,
        surfaceFrameProjection,
      );
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
    // Camera planes keep the Standard view clipping discard; a toggle recompiles.
    const viewClippingLive = (input.camera.clipping?.planes.length ?? 0) > 0;
    // Visible items address GPU Scene instance rows directly: the vertex
    // stage reads current/previous transforms, temporal flags and material
    // rows from the scene tables, so no per-batch row projection exists.
    const sceneIdentity = this.sceneIdentity(scene.scene);
    const viewInspection = view.inspect();
    this.liveRasterCache = projectLiveRaster(
      this.liveRasterCache,
      filtered,
      visibleBuffer,
      materialRaster.visibleBindingIdentity,
      skinRaster?.visibleBindingIdentity,
    );
    const liveRasterBatches = this.liveRasterCache.value;
    this.liveRasterBatches = liveRasterBatches;
    this.gbufferOrderMode = input.gbufferBatchOrderDiagnostic;
    this.gbufferOrderMaterials = input.materialFrame;
    this.gbufferOrderView =
      input.gbufferBatchOrderDiagnostic === undefined
        ? undefined
        : gbufferDiagnosticView(input.camera);
    this.gbufferOrderSlotAt =
      input.gbufferBatchOrderDiagnostic === undefined ? undefined : scene.slotAt;
    this.gbufferOrderEncodes = input.gbufferBatchOrderDiagnostic === undefined ? undefined : [];
    this.gbufferOrderInspection =
      input.gbufferBatchOrderDiagnostic === undefined
        ? undefined
        : {
            mode: input.gbufferBatchOrderDiagnostic.order,
            eligibleBatches: 0,
            movedBatches: 0,
            status: 'not-encoded',
            encodes: this.gbufferOrderEncodes ?? [],
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

    // The graph imports the scene material table live, so a replaced
    // material table is not a graph dependency: key the raster graph on the
    // view's compute generation (its own buffer rebuilds) only.
    const graphIdentity = this.rasterGraphIdentity.update(
      filtered,
      sceneIdentity,
      { ...viewInspection, resourceGeneration: view.computeResourceGeneration },
      liveRasterBatches,
      materialRaster.visibleBindingIdentity,
      skinRaster?.visibleBindingIdentity,
    );
    const discardSignature = viewClippingLive ? '|view-clipping' : '';
    const signature = `gpu:${getOpaqueResourceIdentity(graphIdentity.raw)}${discardSignature}`;
    const recordingSignature = `gpu:${getOpaqueResourceIdentity(graphIdentity.recording)}${discardSignature}`;
    const shadowTopologySignature = () =>
      this.shadowViews
        ?.inspect()
        .map(
          (entry) =>
            // Cache decisions, logical update generations and source-plan
            // revisions are frame-local producer state. They must not feed
            // the compiled graph key: shadow encode reads the submitted plan
            // and batch projections from the frame, compute dispatch sizes
            // follow the uploaded plan, and a recompile allocates fresh
            // shadow targets that miss every view. Only the view's resource
            // generation (buffer capacity replacement) is a graph dependency.
            `${shadowViewIdentityKey(entry.identity)}:${entry.resourceGeneration}`,
        )
        .join('|') ?? '';
    const shadowDirectRequired =
      scene.completeGeometry !== true ||
      scene.plan.batches.some((batch) => {
        const execution =
          batch.binding === undefined
            ? undefined
            : input.batchExecutions.get(batch.binding)?.shadow;
        return execution === undefined || execution.route === 'direct';
      });
    const production = this;
    const consumeSurfaceDynamicInput =
      this.surfaceSubmission === undefined
        ? undefined
        : this.surfaceFrames.consumer(input.surfaceDynamicInput);
    return ok({
      materialBindings: filtered.batches.map(({ batch, materialBindingClass }) => {
        const binding = batch.binding;
        if (binding === undefined) throw new Error('Prepared batch has no shared material binding');
        return {
          material: binding.material,
          worldId: binding.worldId,
          resourceClass: materialBindingClass,
        };
      }),
      get topologySignature() {
        const shadow = shadowTopologySignature();
        return shadow.length === 0 ? signature : `${signature}|shadow=${shadow}`;
      },
      get _recordingTopologySignature() {
        const shadow = shadowTopologySignature();
        return shadow.length === 0 ? recordingSignature : `${recordingSignature}|shadow=${shadow}`;
      },
      worldKeys: scene.worldKeys ?? [],
      selection: filtered.selection,
      shadowDirectRequired,
      ...(this.surfaceSubmission === undefined
        ? {}
        : { surfaceSubmission: this.surfaceSubmission }),
      standardPbrFrameResources: {
        resourceGeneration: viewInspection.resourceGeneration,
        prepareMaterialBinding: () => undefined,
        materialSlotIndicesByBinding: new Map(),
        sceneMaterialBuffer: scene.scene.materialBuffer,
        ...(this.surfaceSubmission === undefined
          ? {}
          : {
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
            }),
      },
      _commitGpuResourceReplacement: () => {
        view._commitResourceReplacement();
      },
      _trackSubmittedWork: (completed) => materials?.submit(completed),
      _sealResourceReads: () => {
        try {
          return materials?.seal() ?? ok(undefined);
        } finally {
          this.shadowViews?._closeInputReads();
        }
      },
      _commitResourceReplacement: (submittedGraphGeneration) => {
        if (!finishMaterials()) return;
        view._commitResourceReplacement();
        shadowViewPool._commitResourceReplacement(submittedGraphGeneration);
        this.committedViewClipping = viewClipping;
        this.submissionState = 'submitted';
        this.lastKnownGoodGeneration = view.inspect().resourceGeneration;
      },
      _abortResourceReplacement: () => {
        if (!finishMaterials()) return;
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
        return shadowViewPool.project(graph, identity, forceCompute, cameraPyramid);
      },
      updateShadowViews: (views) =>
        shadowFiltered !== undefined && views.length > 0
          ? this.updateShadowViews(
              views,
              shadowFiltered,
              input.batchExecutions,
              scene,
              materials.inputReads(),
              lodProjection,
              preparedPlan,
              input.camera,
              input.capsuleShadowDirectional === true,
              input.materialFrame,
              input.shadowMaterials,
              input.profilePhase,
            )
          : this.disableShadowViews(),
      shadowViewPool,
      get shadowBatchProjections() {
        return production.shadowBatchProjections;
      },
      project: (
        graph,
        format,
        sampleCount,
        surfaceSubmissionObservation,
        additionalColorFormats,
        lateOcclusion = false,
        rendererRecording = false,
      ) => {
        this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        const outputs = view.addPasses(
          graph,
          'gpu-driven',
          true,
          surfaceSubmissionObservation,
          undefined,
          lateOcclusion,
          undefined,
          rendererRecording ? () => production.liveRasterCache?.meshBindings.capture() : undefined,
        );
        if (!outputs.ok) return outputs;
        let lateRegion:
          | { readonly indirectByteOffset: number; readonly visibleBase: number }
          | undefined;
        const addLateOcclusion =
          outputs.value.addLateOcclusion === undefined
            ? undefined
            : (pyramid: GraphTextureView) => {
                const late = outputs.value.addLateOcclusion?.(pyramid);
                if (late === undefined || !late.ok) return late ?? ok([]);
                lateRegion = {
                  indirectByteOffset: late.value.lateIndirectByteOffset,
                  visibleBase: late.value.lateVisibleBase,
                };
                return ok(late.value.passNames);
              };
        let surfacePage: GraphBuffer | undefined;
        let surfaceFrame: GraphBuffer | undefined;
        let surfaceSharedFrame: GraphBuffer | undefined;
        if (this.surfaceSubmission !== undefined) {
          const importedPage = graph.importBuffer(
            'gpu-driven.surface.dynamic-input',
            {
              size: materialRaster.surfaceDynamicInputBufferSize,
              usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
            },
            () => materialRaster.surfaceDynamicInputBuffer,
          );
          if (!importedPage.ok) return importedPage;
          const importedFrame = graph.importBuffer(
            'gpu-driven.surface.frame-input',
            {
              size: materialRaster.surfaceDynamicFrameBufferSize,
              usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
            },
            () => materialRaster.surfaceDynamicFrameBuffer,
          );
          if (!importedFrame.ok) return importedFrame;
          const importedSharedFrame = graph.importBuffer(
            'gpu-driven.surface.shared-frame-input',
            {
              size: materialRaster.surfaceDynamicSharedFrameBufferSize,
              usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            },
            () => materialRaster.surfaceDynamicSharedFrameBuffer,
          );
          if (!importedSharedFrame.ok) return importedSharedFrame;
          surfacePage = importedPage.value;
          surfaceFrame = importedFrame.value;
          surfaceSharedFrame = importedSharedFrame.value;
        }
        const sceneTransformBuffer = scene.scene.transformBuffer;
        const sceneTransformBytes = scene.scene.rowCapacity * GPU_SCENE_LAYOUTS.transform.stride;
        // Raster classes are the compiled graph's resource facts: pipelines,
        // mesh buffers and bind groups. Batch windows, indirect offsets and
        // representatives are live per-frame facts read at encode.
        type ProjectedRasterClass = {
          orderDiagnosticState: MaterialRenderState | undefined;
          diagnosticSourceDigest?: string;
          readonly artifact: MaterialShaderArtifact;
          readonly mesh: MeshGpuHandles;
          readonly vertex?: GraphBuffer;
          readonly index?: GraphBuffer;
          readonly meshBindGroup: BindGroup;
          readonly raster: MaterialAbiRasterAdapter;
          readonly deformation: 'rigid' | 'skin';
          readonly clustered: boolean;
          readonly pipelines: ProjectedRasterPipelines;
        };
        type ProjectedRasterPipelines = {
          readonly pipelineFor: RasterPipelineFor;
          readonly temporalPipelineFor: RasterPipelineFor;
          readonly coveragePipelineFor: RasterPipelineFor;
          readonly gbufferPipelineFor: RasterPipelineFor;
          /** Forward entry for the unfogged base View slot; equals `pipelineFor` for authored entries. */
          readonly opaquePipelineFor: RasterPipelineFor;
          readonly nearestPipelineFor?: RasterPipelineFor;
          readonly colorPipelineFor?: RasterPipelineFor;
        };
        const standardAccesses: GraphAccess[] = [
          { resource: outputs.value.primitive, usage: 'storage-read' },
          { resource: outputs.value.instance, usage: 'storage-read' },
          { resource: outputs.value.material, usage: 'storage-read' },
          { resource: outputs.value.visible, usage: 'storage-read' },
          ...(outputs.value.visibleSurfaceRows === undefined
            ? []
            : [
                {
                  resource: outputs.value.visibleSurfaceRows,
                  usage: 'storage-read' as const,
                },
              ]),
          { resource: outputs.value.transform, usage: 'storage-read' },
          { resource: outputs.value.indirect, usage: 'indirect-read' },
          ...(surfacePage === undefined
            ? []
            : [{ resource: surfacePage, usage: 'storage-read' as const }]),
          ...(surfaceFrame === undefined
            ? []
            : [{ resource: surfaceFrame, usage: 'storage-read' as const }]),
          ...(surfaceSharedFrame === undefined
            ? []
            : [{ resource: surfaceSharedFrame, usage: 'uniform-read' as const }]),
        ];
        const meshBuffers = rendererRecording
          ? undefined
          : new Map<
              MeshGpuHandles,
              { readonly vertex: GraphBuffer; readonly index?: GraphBuffer }
            >();
        // Raw projections retain late per-mesh resolvers; recording owns stable handles.
        const rasterClasses = new Map<string, ProjectedRasterClass>();
        const pipelineShapes = new Map<string, ProjectedRasterPipelines>();
        const initialFormats = rendererRecording
          ? [format, ...(additionalColorFormats ?? [])]
          : undefined;
        const initialFormatKey = initialFormats?.join(',');
        for (const [liveIndex, prepared] of filtered.batches.entries()) {
          const live = liveRasterBatches[liveIndex];
          const classKey = rendererRecording ? live?.recordingClassKey : live?.classKey;
          if (classKey === undefined || rasterClasses.has(classKey)) continue;
          const deformation = prepared.batch.prepared?.identity.deformation ?? 'rigid';
          const raster = deformation === 'skin' ? skinRaster : materialRaster;
          const artifact = prepared.artifact;
          if (raster === undefined) {
            return err(
              new RhiError({
                code: 'rhi-not-available',
                expected: `${deformation === 'skin' ? 'skinned ' : ''}published material ABI raster owner`,
                hint: 'publish the selected material artifact before entering the GPU lane',
              }),
            );
          }
          // Mesh rows are the shared GPU Scene transform table: visible.x
          // names the scene instance row and the vertex stage resolves the
          // primitive root and instance-local transforms itself.
          const meshBindGroup = raster.sceneMeshBindGroup(
            sceneTransformBuffer,
            sceneTransformBytes,
            view.skinTaskBinding(),
          );
          if (!meshBindGroup.ok) return meshBindGroup;
          let buffers = meshBuffers?.get(prepared.mesh);
          if (!rendererRecording && buffers === undefined) {
            let vertex: GraphBuffer | undefined;
            if (vertex === undefined) {
              const imported = graph.importBuffer(
                `gpu-driven.standard.${prepared.worldKey}.${prepared.batch.key.assetHandle}.vertex`,
                {
                  size: prepared.mesh.vboBytes,
                  usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
                },
                () => prepared.mesh.vertexBuffer.handle,
              );
              if (!imported.ok) return imported;
              vertex = imported.value;
              standardAccesses.push({ resource: vertex, usage: 'vertex-read' });
            }
            let index: GraphBuffer | undefined;
            if (prepared.mesh.indexBuffer !== null) {
              const indexBuffer = prepared.mesh.indexBuffer;
              if (index === undefined) {
                const imported = graph.importBuffer(
                  `gpu-driven.standard.${prepared.worldKey}.${prepared.batch.key.assetHandle}.index`,
                  {
                    size: prepared.mesh.iboBytes,
                    usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
                  },
                  () => indexBuffer.handle,
                );
                if (!imported.ok) return imported;
                index = imported.value;
                standardAccesses.push({ resource: index, usage: 'index-read' });
              }
            }
            buffers = { vertex, ...(index === undefined ? {} : { index }) };
            meshBuffers?.set(prepared.mesh, buffers);
          }
          const shaderUvSetCount = isCanonicalStandardPbrMaterialShader(artifact.material)
            ? materialPipelineState.standardPbrShaderUvSetCount
            : (artifact.uvSetCount ?? materialPipelineState.standardPbrShaderUvSetCount);
          const stripIndexFormat =
            prepared.batch.key.drawKind === 'indexed' &&
            isStripTopology(prepared.batch.key.topology)
              ? prepared.mesh.indexFormat
              : undefined;
          // Only the private stock recording closure owns immutable inputs.
          // Raw projections retain per-mesh lazy reads and retry boundaries.
          const layoutProjection = rendererRecording ? prepared.mesh.layoutProjection : undefined;
          const topology = rendererRecording ? prepared.batch.key.topology : undefined;
          const renderState = rendererRecording ? prepared.renderState : undefined;
          const standardTextureMask = rendererRecording ? prepared.standardTextureMask : undefined;
          // Class key splits LOD fade capability, the signature view clipping.
          const standardSurfaceDiscards = standardSurfaceDiscardMask(
            lodCoverageMayFade(prepared.batch),
            viewClippingLive,
          );
          // Raw projections retain physical mesh identities and graph accesses.
          // Stock recording binds live residency-owned meshes like direct draws.
          // Pipeline preparation depends only on immutable shader/layout facts;
          // Worlds, GUIDs and vertex/index allocations cannot split it.
          const pipelineShapeKey =
            layoutProjection === undefined
              ? undefined
              : JSON.stringify([
                  deformation,
                  layoutProjection.digest,
                  layoutProjection.arrayStride,
                  shaderUvSetCount,
                  topology,
                  stripIndexFormat ?? '',
                  renderState ?? null,
                  standardTextureMask ?? -1,
                  standardSurfaceDiscards,
                  artifact.material,
                  artifact.pass,
                  artifact.layoutIdentity,
                  artifact.receipt?.sceneIndexEntry ?? '',
                  artifact.vertexEntry ?? '',
                  artifact.fragmentEntry ?? '',
                  artifact.receipt?.receiptIdentity ?? '',
                  artifact.receipt?.generation ?? 0,
                  artifact.variantSet ?? '',
                  artifact.reflectionFallbackOutputAvailable === true,
                  isSingleLayerMediumArtifact(artifact),
                  materialArtifactProgramIdentity(artifact),
                ]);
          let pipelines =
            pipelineShapeKey === undefined ? undefined : pipelineShapes.get(pipelineShapeKey);
          if (pipelines === undefined) {
            // Artifact and render state are fixed by this graph projection.
            // Only attachment formats vary at encode; do not rebuild a key
            // from immutable program/receipt facts for every batch and frame.
            const pipelineForFragment = (
              fragmentEntry: string | undefined,
              coverageOnly = false,
              forwardColorPass = false,
            ): RasterPipelineFor => {
              let projectedPipelines: Map<string, ResultOk<RenderPipeline>> | undefined;
              let selectedArtifact: MaterialShaderArtifact | undefined;
              return (formats, formatKey, preparation = false) => {
                const key = formatKey ?? formats.join(',');
                const projected = projectedPipelines?.get(key);
                if (projected !== undefined)
                  return rendererRecording ? projected : ok(projected.value);
                // Unused G-buffer, temporal and coverage entries need no
                // artifact copy. Retain one immutable variant on first use;
                // failed pipeline admission still retries on the next call.
                selectedArtifact ??=
                  fragmentEntry === undefined
                    ? artifact
                    : {
                        ...artifact,
                        fragmentEntry,
                        ...(fragmentEntry === 'fs_temporal' ? { vertexEntry: 'vs_temporal' } : {}),
                        ...(coverageOnly
                          ? {
                              variantSet:
                                variantSetForCoveragePass(artifact.variantSet, true) ?? '',
                            }
                          : {}),
                      };
                const selected = raster.pipeline(
                  formats[0] ?? format,
                  sampleCount,
                  layoutProjection ?? prepared.mesh.layoutProjection,
                  // The producer receipt owns the selected shader's UV ABI.
                  shaderUvSetCount,
                  topology ?? prepared.batch.key.topology,
                  stripIndexFormat,
                  selectedArtifact.fragmentEntry === 'fs_temporal'
                    ? geometryRenderStateForPass(
                        rendererRecording ? renderState : prepared.renderState,
                        'temporal',
                        coverageOnly,
                      )
                    : rendererRecording
                      ? renderState
                      : prepared.renderState,
                  selectedArtifact,
                  formats.slice(1),
                  rendererRecording ? standardTextureMask : prepared.standardTextureMask,
                  forwardColorPass,
                  preparation ? input.materialPipelinePreparationFactory : undefined,
                  standardSurfaceDiscards,
                );
                if (selected.ok) {
                  projectedPipelines ??= new Map();
                  // Retain an owned result; an RHI result may observe value reads.
                  projectedPipelines.set(key, ok(selected.value));
                }
                return selected;
              };
            };
            const pipelineFor = pipelineForFragment(undefined, false, true);
            // Only the template forward entry has an fs_opaque twin; an
            // authored fragment entry keeps its own pipeline.
            const opaquePipelineFor =
              artifact.fragmentEntry === undefined || artifact.fragmentEntry === 'fs_main'
                ? pipelineForFragment(STANDARD_OPAQUE_FRAGMENT_ENTRY, false, true)
                : pipelineFor;
            const gbufferPipelineFor = pipelineForFragment(
              deformation === 'skin' && input.visibleSurface !== undefined
                ? SKIN_UNCOVERED_GBUFFER_ENTRY
                : 'fs_gbuffer',
            );
            const temporalPipelineFor = pipelineForFragment('fs_temporal');
            // Output-domain TAAU coverage reuses the culled/LOD-selected
            // indirect rows; only the binary variant and depth writes differ.
            const coveragePipelineFor = pipelineForFragment('fs_temporal', true);
            let nearestPipelineFor: RasterPipelineFor | undefined;
            let colorPipelineFor: RasterPipelineFor | undefined;
            if (isSingleLayerMediumArtifact(artifact)) {
              nearestPipelineFor = pipelineForFragment('fs_nearest_layer');
              colorPipelineFor = pipelineForFragment('fs_color');
            }
            pipelines = {
              pipelineFor,
              opaquePipelineFor,
              gbufferPipelineFor,
              temporalPipelineFor,
              coveragePipelineFor,
              ...(nearestPipelineFor === undefined ? {} : { nearestPipelineFor }),
              ...(colorPipelineFor === undefined ? {} : { colorPipelineFor }),
            };
            if (pipelineShapeKey !== undefined) pipelineShapes.set(pipelineShapeKey, pipelines);
          }
          // Admit the batch with the pipeline its ordinary forward encode
          // binds, so a frame that never needs fs_main does not compile it.
          if (!rendererRecording || input.materialPipelinePreparationFactory === undefined) {
            const initialPipeline = pipelines.opaquePipelineFor(
              initialFormats ?? [format, ...(additionalColorFormats ?? [])],
              initialFormatKey,
            );
            if (!initialPipeline.ok) return initialPipeline;
          }
          const projectedClass = {
            orderDiagnosticState: prepared.renderState,
            artifact,
            mesh: prepared.mesh,
            ...buffers,
            pipelines,
            meshBindGroup: meshBindGroup.value,
            raster,
            deformation,
            clustered:
              artifact.program.group2 === 'cluster' || artifact.program.group2 === 'skin-cluster',
          };
          rasterClasses.set(classKey, projectedClass);
        }
        if (rendererRecording) production.rasterGraphIdentity.built(rasterClasses.keys());
        if (rasterClasses.size === 0 && filtered.batches.length > 0) {
          return err(
            new RhiError({
              code: 'internal-error',
              expected: 'one material ABI raster class for the eligible batches',
              hint: 'repair the receipt-backed batch projection before encoding the frame',
            }),
          );
        }
        const rasterClassFor = (
          live: LiveRasterBatch,
          filter?: RenderPipelineGpuDrivenFilter,
          fragmentEntryPoint?: string,
        ): ProjectedRasterClass | undefined => {
          if (live.batch.visibleCapacity === 0) return undefined;
          const batch = rasterClasses.get(
            rendererRecording ? live.recordingClassKey : live.classKey,
          );
          if (batch === undefined) {
            throw new RhiError({
              code: 'internal-error',
              expected: `compiled raster class for live GPU batch ${live.batch.batchId}`,
              hint: 'derive the graph signature from the same raster class set as the live batches',
            });
          }
          if (
            fragmentEntryPoint === 'fs_temporal' &&
            !gpuTemporalEligible(
              batch.artifact.material,
              batch.deformation,
              live.batch.lod?.coverages.length ?? 0,
            )
          )
            return undefined;
          if (
            !gpuRasterFilterMatches(
              filter,
              live.batch.key.materialPass,
              isSingleLayerMediumArtifact(batch.artifact),
            )
          ) {
            return undefined;
          }
          return batch;
        };
        const preparationFactory = input.materialPipelinePreparationFactory;
        const preparationJobs = new Map<
          string,
          (
            entries: readonly ValidatedRenderable[],
            artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
            onPending?: (reason: FramePresentationPendingReason) => void,
            materials?: import('../scene/material-dispatch').MaterialFrame,
          ) => boolean
        >();
        const selectPipeline = (
          batch: ProjectedRasterClass,
          fragmentEntryPoint: string | undefined,
          coverageOnly: boolean,
        ) =>
          fragmentEntryPoint === 'fs_temporal'
            ? coverageOnly
              ? batch.pipelines.coveragePipelineFor
              : batch.pipelines.temporalPipelineFor
            : fragmentEntryPoint === 'fs_gbuffer'
              ? batch.pipelines.gbufferPipelineFor
              : fragmentEntryPoint === 'fs_nearest_layer'
                ? (batch.pipelines.nearestPipelineFor ?? batch.pipelines.pipelineFor)
                : fragmentEntryPoint === 'fs_color'
                  ? (batch.pipelines.colorPipelineFor ?? batch.pipelines.pipelineFor)
                  : fragmentEntryPoint === STANDARD_OPAQUE_FRAGMENT_ENTRY
                    ? batch.pipelines.opaquePipelineFor
                    : batch.pipelines.pipelineFor;
        return ok({
          accesses: standardAccesses,
          ...(rendererRecording && preparationFactory !== undefined
            ? {
                registerPipelinePreparation: (
                  formats,
                  filter,
                  fragmentEntryPoint,
                  coverageOnly = false,
                ) => {
                  const key = JSON.stringify([formats, filter, fragmentEntryPoint, coverageOnly]);
                  if (preparationJobs.has(key)) return;
                  const selected = new Map<RasterPipelineFor, string>();
                  for (const live of production.liveRasterBatches) {
                    const batch = rasterClassFor(live, filter, fragmentEntryPoint);
                    if (batch !== undefined)
                      selected.set(
                        selectPipeline(batch, fragmentEntryPoint, coverageOnly),
                        batch.artifact.material,
                      );
                  }
                  const ownedFormats = [...formats],
                    formatKey = ownedFormats.join(',');
                  preparationJobs.set(key, (entries, artifacts, onPending, materials) => {
                    let ready = true;
                    for (const pipelineFor of selected.keys())
                      if (!pipelineFor(ownedFormats, formatKey, true).ok) {
                        ready = false;
                        onPending?.({
                          code: 'scene-pipeline-preparation',
                          pass: (fragmentEntryPoint ?? filter ?? 'forward').slice(0, 256),
                          shader: (selected.get(pipelineFor) ?? '').slice(0, 256),
                        });
                      }
                    if (
                      !prepareHiddenGpuDrivenPipelines({
                        entries,
                        artifacts,
                        materials,
                        resolve: input.materialArtifactResolver,
                        factory: preparationFactory,
                        formats: ownedFormats,
                        sampleCount,
                        shaderUvSetCount: materialPipelineState.standardPbrShaderUvSetCount,
                        filter,
                        fragmentEntry: fragmentEntryPoint,
                        coverageOnly,
                        visibleSurface: input.visibleSurface !== undefined,
                        viewClipping: viewClippingLive,
                        ...(onPending === undefined ? {} : { onPending }),
                      })
                    )
                      ready = false;
                    return ready;
                  });
                },
                preparePipelines: (entries = [], artifacts, onPending, materials) => {
                  let ready = true;
                  for (const prepare of preparationJobs.values())
                    if (!prepare(entries, artifacts, onPending, materials)) ready = false;
                  return ready;
                },
              }
            : {}),
          hasWork: (filter, fragmentEntryPoint) =>
            production.liveRasterBatches.some(
              (live) => rasterClassFor(live, filter, fragmentEntryPoint) !== undefined,
            ),
          ...(addLateOcclusion === undefined ? {} : { addLateOcclusion }),
          encode: (
            viewBindGroup,
            pass,
            resources: GraphResourceResolver,
            frameResources: GpuDrivenStandardPbrFrameResources,
            filter,
            fragmentEntryPoint,
            coverageOnly = false,
            phase = 'all',
          ) => {
            let regionOffset = 0;
            let visibleRegionBase = 0;
            if (phase === 'late') {
              if (lateRegion === undefined) {
                throw new RhiError({
                  code: 'internal-error',
                  expected: 'addLateOcclusion(...) before a late-phase GPU-driven encode',
                  hint: 'add the late HZB cull between the early and late geometry passes',
                });
              }
              regionOffset = lateRegion.indirectByteOffset;
              visibleRegionBase = lateRegion.visibleBase;
            }
            // The shared Standard view BGL carries two dynamic buffers:
            // the frame view UBO and the per-frame shadow/light table. GPU
            // indirect draws use the same zero offsets as direct draws;
            // supplying only one offset makes Dawn reject the command
            // buffer before the indirect work can reach the rasterizer.
            // Keep imperative per-draw Surface observation in its original
            // recording order; only closed pure draw lanes defer native execution.
            const descriptor =
              !rendererRecording ||
              (frameResources.surfaceSubmissionObservation !== undefined &&
                (fragmentEntryPoint === 'fs_nearest_layer' || fragmentEntryPoint === 'fs_color'))
                ? undefined
                : frameResources.bundleDescriptor;
            const preparedBundles: RenderBundle[] = [];
            const bundleKey =
              descriptor === undefined
                ? undefined
                : production.rasterPasses.prepare(
                    `${filter ?? ''}/${fragmentEntryPoint ?? ''}/${coverageOnly ? 1 : 0}/${phase}`,
                    descriptor,
                  );
            let bundleOwner: LiveRasterBatch | undefined;
            let bundleBlock = -1;
            let preparedBindings: ReturnType<PreparedRasterBundleCache['begin']> | undefined;
            // Filled completely before each observation; only changed commands take a snapshot.
            const observedBindings = {} as {
              -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
            };
            let recordingRun: RetainedRasterBlock | undefined;
            const flushPrepared = () => {
              if (
                descriptor !== undefined &&
                bundleKey !== undefined &&
                bundleOwner !== undefined &&
                preparedBindings !== undefined
              ) {
                const finished = preparedBindings.finish();
                preparedBundles.push(finished);
                if (recordingRun !== undefined) recordingRun.bundle = finished;
              }
              preparedBindings = undefined;
              bundleOwner = undefined;
            };
            if (descriptor === undefined) pass.setBindGroup(0, viewBindGroup, [0, 0]);
            const colorFormats = frameResources.colorFormats ?? [
              format,
              ...(additionalColorFormats ?? []),
            ];
            // Stock recording owns the attachments for this encode. Raw callers
            // retain per-selected-batch format observations below.
            const formatKey = rendererRecording ? colorFormats.join(',') : undefined;
            const slotsByBinding = frameResources.materialSlotIndicesByBinding;
            let currentPipeline: RenderPipeline | undefined;
            let currentMaterial: BindGroup | undefined;
            let currentMaterialOffset = -1;
            let currentMesh: BindGroup | undefined;
            let rigidClusterGroup: BindGroup | undefined;
            let currentVisible: BindGroup | undefined;
            let currentDeformation: 'rigid' | 'skin' | undefined;
            let currentVertex: GraphBuffer | Buffer | undefined;
            let currentIndex: GraphBuffer | Buffer | undefined;
            let currentIndexFormat: MeshGpuHandles['indexFormat'] | undefined;
            let physicalVertex: Buffer | undefined;
            let physicalIndex: Buffer | undefined;
            let indirectBuffer: Buffer | undefined;
            const diagnosticAdmitted = isGBufferOrderDiagnosticEncode(
              rendererRecording,
              filter,
              fragmentEntryPoint,
              coverageOnly,
              phase,
              colorFormats.length,
            );
            if (production.gbufferOrderEncodes !== undefined)
              production.gbufferOrderEncodes.push({
                rendererRecording,
                filter,
                fragmentEntry: fragmentEntryPoint,
                coverageOnly,
                phase,
                colorTargetCount: colorFormats.length,
                admitted: diagnosticAdmitted,
              });
            const diagnosticMode = diagnosticAdmitted ? production.gbufferOrderMode : undefined;
            const evidence:
              | {
                  classes: NonNullable<GBufferOrderDiagnosticInspection['classes']>[number][];
                  batches: NonNullable<GBufferOrderDiagnosticInspection['batches']>[number][];
                  rejections: Record<string, number>;
                  indices: Map<ProjectedRasterClass, number>;
                  selected: number;
                }
              | undefined =
              diagnosticMode === undefined
                ? undefined
                : {
                    classes: [],
                    batches: [],
                    rejections: {},
                    indices: new Map(),
                    selected: 0,
                  };
            const ordered =
              diagnosticMode === undefined
                ? undefined
                : orderGBufferDiagnostic(
                    production.liveRasterBatches,
                    diagnosticMode.order,
                    (live) => {
                      if (evidence === undefined) return undefined;
                      const selected = rasterClassFor(live, filter, fragmentEntryPoint);
                      const batch =
                        selected ??
                        rasterClasses.get(
                          rendererRecording ? live.recordingClassKey : live.classKey,
                        );
                      const reasons: string[] = [];
                      if (selected === undefined) reasons.push('pass-filter');
                      else evidence.selected++;
                      let classIndex: number | undefined;
                      if (batch === undefined) reasons.push('missing-raster-class');
                      else {
                        batch.diagnosticSourceDigest ??= gbufferProgramDigest(
                          batch.artifact.program.source,
                        );
                        classIndex = evidence.indices.get(batch);
                        if (classIndex === undefined) {
                          const gate = gbufferOrderInterfaceEvidence(
                            batch.artifact,
                            batch.orderDiagnosticState,
                            batch.deformation,
                            batch.raster.diagnosticGBufferVertexEntry(batch.artifact),
                          );
                          classIndex = evidence.classes.length;
                          evidence.indices.set(batch, classIndex);
                          evidence.classes.push({
                            sourceDigest: batch.diagnosticSourceDigest,
                            material: batch.artifact.material,
                            specializationKey: batch.artifact.specializationKey,
                            facts: gate.facts,
                            checks: gate.checks,
                            rejections: gate.rejections.map((reason) => `interface/${reason}`),
                            auditedSource: diagnosticMode.programDigests.includes(
                              batch.diagnosticSourceDigest,
                            ),
                          });
                        }
                        const proof = evidence.classes[classIndex];
                        if (proof !== undefined) {
                          reasons.push(...proof.rejections);
                          if (!proof.auditedSource) reasons.push('program-digest');
                        }
                      }
                      let rejectedSource: Readonly<Record<string, unknown>> | undefined;
                      if (production.gbufferOrderView === undefined) reasons.push('camera-view');
                      if (production.gbufferOrderSlotAt === undefined)
                        reasons.push('source-slot-owner');
                      const depth =
                        production.gbufferOrderView === undefined ||
                        production.gbufferOrderSlotAt === undefined
                          ? undefined
                          : gbufferBatchDepth(
                              live.batch,
                              production.gbufferOrderSlotAt,
                              production.gbufferOrderView,
                              (reason, source) => {
                                reasons.push(`bounds/${reason}`);
                                rejectedSource = source;
                              },
                              live.batch.binding === undefined
                                ? undefined
                                : production.gbufferOrderMaterials?.get(live.batch.binding.material)
                                    ?.snapshot,
                            );
                      if (
                        depth === undefined &&
                        !reasons.some((reason) => reason.startsWith('bounds/')) &&
                        production.gbufferOrderView !== undefined &&
                        production.gbufferOrderSlotAt !== undefined
                      )
                        reasons.push('bounds/unavailable');
                      for (const reason of reasons)
                        evidence.rejections[reason] = (evidence.rejections[reason] ?? 0) + 1;
                      evidence.batches.push({
                        batchId: live.batch.batchId,
                        classIndex,
                        candidateCount: live.batch.candidates.length,
                        visibleCapacity: live.batch.visibleCapacity,
                        materialPass: live.batch.key.materialPass,
                        meshHandle: live.batch.key.assetHandle,
                        materialSlot: live.batch.key.materialSlot,
                        depth,
                        rejections: reasons,
                        ...(rejectedSource === undefined ? {} : { rejectedSource }),
                      });
                      return reasons.length === 0 ? depth : undefined;
                    },
                  );
            if (diagnosticMode !== undefined && ordered !== undefined && evidence !== undefined)
              production.gbufferOrderInspection = {
                mode: diagnosticMode.order,
                eligibleBatches: ordered.eligible,
                movedBatches: ordered.moved,
                status: 'evaluated',
                ...(production.gbufferOrderInspection?.preparation === undefined
                  ? {}
                  : {
                      preparation: production.gbufferOrderInspection.preparation,
                    }),
                encodes: production.gbufferOrderEncodes ?? [],
                denominator: {
                  live: production.liveRasterBatches.length,
                  selected: evidence.selected,
                },
                rejections: evidence.rejections,
                classes: evidence.classes,
                batches: evidence.batches,
              };
            const meshGroupFor = (batch: ProjectedRasterClass): BindGroup | undefined => {
              if (rendererRecording && batch.clustered && batch.deformation === 'rigid') {
                rigidClusterGroup ??= frameResources.clusterBindGroupForMesh?.(
                  sceneTransformBuffer,
                  sceneTransformBytes,
                );
                return rigidClusterGroup;
              }
              return resolveGpuDrivenMeshGroup({
                clustered: batch.clustered,
                deformation: batch.deformation,
                meshBindGroup: batch.meshBindGroup,
                sceneTransformBuffer,
                sceneTransformBytes,
                frameResources,
                skinTaskBinding: view.skinTaskBinding(),
              });
            };
            // Bundled stock runs whose live owners, physical buffers and resolved
            // material, pipeline and mesh groups are unchanged replay their bundle.
            const retainKey =
              rendererRecording &&
              descriptor !== undefined &&
              bundleKey !== undefined &&
              ordered === undefined &&
              production.geometryCapture === undefined &&
              frameResources.surfaceSubmissionObservation === undefined
                ? bundleKey
                : undefined;
            const retainedIndirect =
              retainKey === undefined ? undefined : resources.buffer(outputs.value.indirect);
            // Slot tables are rebuilt in place every frame; each run instead
            // records the slot and selection its batches resolved.
            const identities = [
              viewBindGroup,
              slotsByBinding.size === 0,
              retainedIndirect?.ok === true ? retainedIndirect.value : undefined,
              regionOffset,
              visibleRegionBase,
              formatKey,
              rasterClasses,
              sceneTransformBuffer,
              sceneTransformBytes,
            ];
            const retainedRuns =
              retainKey === undefined
                ? undefined
                : production.retainedEncodes.begin(
                    retainKey,
                    identities,
                    (slot) => materialOwner(frameResources.prepareMaterialBinding(slot)),
                    (cls) =>
                      classOwner(
                        selectPipeline(
                          cls as ProjectedRasterClass,
                          fragmentEntryPoint,
                          coverageOnly,
                        )(colorFormats, formatKey),
                        meshGroupFor(cls as ProjectedRasterClass),
                      ),
                  );
            const lives = ordered?.batches ?? production.liveRasterBatches;
            const liveFacts = runFacts(
              (live) =>
                rasterClassFor(live as LiveRasterBatch, filter, fragmentEntryPoint) !== undefined,
              slotsByBinding,
              frameResources.selectedMaterialSlots,
            );
            let runEnd = 0;
            for (let liveIndex = 0; liveIndex < lives.length; liveIndex++) {
              const live = lives[liveIndex] as LiveRasterBatch;
              if (retainedRuns !== undefined && liveIndex >= runEnd) {
                // A run is the contiguous stable-ID block that one bundle covers.
                const block = Math.floor(live.batch.batchId / 32);
                runEnd = liveIndex + 1;
                while (
                  runEnd < lives.length &&
                  Math.floor((lives[runEnd] as LiveRasterBatch).batch.batchId / 32) === block
                )
                  runEnd++;
                flushPrepared();
                bundleBlock = -1;
                recordingRun = undefined;
                const reused = retainedRuns.reuse(lives, liveIndex, runEnd, liveFacts);
                if (reused !== undefined) {
                  // A replayed run reuses its prepared bundle without rebuilding it.
                  if (reused.bundle !== undefined) {
                    preparedBundles.push(reused.bundle);
                    production.preparedBundleCounters.hits++;
                  }
                  this.encodedIndirectDraws += reused.draws;
                  liveIndex = runEnd - 1;
                  continue;
                }
                recordingRun = retainedRuns.record(lives, liveIndex, runEnd, liveFacts);
              }
              // One candidate is already classified by the Scene camera owner.
              // Larger batches stay GPU-culled without enumerating members here.
              // Retained runs leave single candidates to the GPU cull, so replayed
              // bundles stay independent of this frame's camera classification.
              if (
                retainedRuns === undefined &&
                live.batch.visibleCapacity === 1 &&
                frameResources.cameraVisible !== undefined
              ) {
                const member = live.batch.members?.at(0);
                const source =
                  member === undefined ? undefined : input.scene?.slotAt(member.primitiveIndex);
                if (
                  source !== undefined &&
                  source.generation === member?.generation &&
                  frameResources.cameraVisible(source.snapshot) === false
                )
                  continue;
              }
              const batch = rasterClassFor(live, filter, fragmentEntryPoint);
              if (batch === undefined) continue;
              const isMedium = isSingleLayerMediumArtifact(batch.artifact);
              const material = live.batch.binding?.material;
              const globalMaterialSlot =
                slotsByBinding.size === 0
                  ? live.batch.key.materialSlot
                  : material === undefined
                    ? undefined
                    : slotsByBinding.get(material)?.get(live.materialBindingClass);
              if (globalMaterialSlot === undefined) continue;
              if (
                frameResources.selectedMaterialSlots !== undefined &&
                !frameResources.selectedMaterialSlots.has(globalMaterialSlot)
              )
                continue;
              const pipelineFor = selectPipeline(batch, fragmentEntryPoint, coverageOnly);
              const selectedPipeline = pipelineFor(colorFormats, formatKey);
              if (!selectedPipeline.ok) throw selectedPipeline.error;
              if (currentPipeline !== selectedPipeline.value) {
                if (descriptor === undefined) pass.setPipeline(selectedPipeline.value);
                currentPipeline = selectedPipeline.value;
                // setPipeline preserves logical bindings. Their actual handles
                // and dynamic offsets below still select any required replacement.
              }
              const preparedMaterial = frameResources.prepareMaterialBinding(globalMaterialSlot);
              if (preparedMaterial === undefined) {
                throw new RhiError({
                  code: 'rhi-not-available',
                  expected: `material bind group for global slot ${globalMaterialSlot}`,
                  hint: 'keep GPU-driven material selection on the main-pass producer contract',
                });
              }
              // Scene-index templates read numeric values from GPU Scene. Their
              // retained uniform declaration only satisfies the shared layout;
              // a frame-local material slot must not invalidate those commands.
              // Full-custom programs that reference the uniform retain its offset.
              const materialOffset =
                batch.artifact.program.materialUniformRequired === false
                  ? 0
                  : preparedMaterial.byteOffset;
              const materialBindGroup = preparedMaterial.group;
              recordingRun?.materials.set(globalMaterialSlot, {
                group: materialBindGroup,
                offset: preparedMaterial.byteOffset,
              });
              if (
                currentMaterial !== materialBindGroup ||
                currentMaterialOffset !== materialOffset
              ) {
                if (descriptor === undefined)
                  pass.setBindGroup(1, materialBindGroup, [materialOffset]);
                currentMaterial = materialBindGroup;
                currentMaterialOffset = materialOffset;
              }
              // Every rigid cluster draw reads this projection's whole scene
              // table and this encode's lighting. Stock recording resolves on first use;
              // keep skin palettes and pipeline-transition rebinding separate.
              const group2 = meshGroupFor(batch);
              if (group2 === undefined) {
                throw new RhiError({
                  code: 'rhi-not-available',
                  expected: 'clustered Standard group(2) BindGroup for GPU-driven batch',
                  hint: 'publish the frame-owned cluster lighting resources before indirect encode',
                });
              }
              // Skin task offsets are per-frame facts; such encodes are never replayed.
              if (recordingRun !== undefined) {
                if (batch.deformation === 'skin') recordingRun.draws = Number.NaN;
                recordingRun.classes.set(batch, { pipeline: selectedPipeline.value, mesh: group2 });
              }
              if (currentMesh !== group2 || currentDeformation !== batch.deformation) {
                if (descriptor === undefined)
                  pass.setBindGroup(
                    2,
                    group2,
                    batch.deformation === 'skin'
                      ? pbrSkinMeshDynamicOffsets(0, requireViewSkinTask(view), true)
                      : [0],
                  );
                currentMesh = group2;
                currentDeformation = batch.deformation;
              }
              const vertexKey = rendererRecording ? live.meshBinding.vertex : batch.vertex;
              if (vertexKey !== undefined && currentVertex !== vertexKey) {
                const vertex = rendererRecording
                  ? (live.meshBinding.vertex as Buffer)
                  : resources.buffer(vertexKey as GraphBuffer).unwrap();
                physicalVertex = vertex;
                if (descriptor === undefined) pass.setVertexBuffer(0, vertex);
                currentVertex = vertexKey;
              }
              const indexKey = rendererRecording ? live.meshBinding.index : batch.index;
              const indexFormat = rendererRecording
                ? live.mesh.indexFormat
                : batch.mesh.indexFormat;
              if (
                indexKey !== undefined &&
                (currentIndex !== indexKey ||
                  (rendererRecording && currentIndexFormat !== indexFormat))
              ) {
                const index = rendererRecording
                  ? (indexKey as Buffer)
                  : resources.buffer(indexKey as GraphBuffer).unwrap();
                physicalIndex = index;
                if (descriptor === undefined) pass.setIndexBuffer(index, indexFormat);
                currentIndex = indexKey;
                currentIndexFormat = indexFormat;
              }
              if (indirectBuffer === undefined) {
                const indirect = resources.buffer(outputs.value.indirect);
                if (!indirect.ok) throw indirect.error;
                indirectBuffer = indirect.value;
              }
              // One indirect command per LOD level slot: the GPU cull
              // compacts each member into its selected level's segment.
              const levelStride = batchLevelStride(live.batch);
              const levelCount = batchLodLevelCount(live.batch);
              const windowPhase = phase === 'late' ? 'late' : 'early';
              let windows = live.visibleBindGroups?.[windowPhase];
              if (windows === undefined) {
                const resolvedWindows: BindGroup[] = [];
                for (let level = 0; level < levelCount; level += 1) {
                  const resolved = batch.raster.visibleWindowBindGroup(
                    visibleRegionBase + live.batch.visibleBase + level * levelStride,
                    live.batch.visibleAllocationCapacity ?? live.batch.visibleCapacity,
                  );
                  if (!resolved.ok) throw resolved.error;
                  resolvedWindows.push(resolved.value);
                }
                // Failed construction publishes nothing. Accepted arrays are
                // never edited; physical/range changes replace this owner.
                live.visibleBindGroups ??= {};
                windows = prepareRasterWindows(resolvedWindows);
                live.visibleBindGroups[windowPhase] = windows;
              }
              for (let level = 0; level < levelCount; level += 1) {
                const commandOffset =
                  regionOffset +
                  live.batch.indirectOffset +
                  level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
                const visibleWindow = windows[level];
                if (visibleWindow === undefined)
                  throw new Error('Missing prepared visible binding');
                if (descriptor === undefined) {
                  if (currentVisible !== visibleWindow) {
                    pass.setBindGroup(3, visibleWindow);
                    currentVisible = visibleWindow;
                  }
                  if (live.batch.key.drawKind === 'indexed')
                    pass.drawIndexedIndirect(indirectBuffer, commandOffset);
                  else pass.drawIndirect(indirectBuffer, commandOffset);
                }
                const geometry = production.geometryCapture;
                if (geometry !== undefined && geometry.failure === undefined) {
                  try {
                    if (geometry.commands.length >= GEOMETRY_OBSERVATION_MAX_COMMANDS)
                      geometry.failure = 'command-budget';
                    else {
                      const sources = new Map<number, GeometrySourceIdentity>();
                      for (const candidate of live.batch.candidates) {
                        if (++geometry.members > GEOMETRY_OBSERVATION_MAX_MEMBERS) {
                          geometry.failure = 'source-budget';
                          break;
                        }
                        const slot = production.preparations.forward.cached?.slotAt(
                          candidate.primitiveIndex,
                        );
                        const row =
                          production.preparations.forward.cached?.scene.instanceIndexForSlot(
                            candidate.primitiveIndex,
                            candidate.instanceOrdinal,
                          );
                        if (
                          slot === undefined ||
                          slot.generation !== candidate.generation ||
                          row === undefined
                        ) {
                          geometry.failure = 'source-generation-mismatch';
                          break;
                        }
                        const material = (
                          slot.snapshot.materials[live.batch.key.materialSlot] ??
                          slot.snapshot.material
                        ).snapshot;
                        captureGeometrySource(sources, row, {
                          ...geometry.source(slot),
                          entityKey: slot.entityKey,
                          primitiveSlot: slot.slot,
                          slotGeneration: slot.generation,
                          meshHandle: slot.snapshot.assetHandle ?? 0,
                          drawItemIndex:
                            live.batch.binding?.drawItemIndex ?? candidate.drawItemIndex,
                          materialSlot: live.batch.key.materialSlot,
                          ...(material.materialHandle === undefined
                            ? {}
                            : { materialHandle: material.materialHandle }),
                          ...(material.materialPublication === undefined
                            ? {}
                            : { materialPublication: material.materialPublication.identity }),
                          instanceOrdinal: candidate.instanceOrdinal,
                        });
                      }
                      let gbufferProgram: GeometryGBufferProgram | undefined;
                      if (fragmentEntryPoint === 'fs_gbuffer') {
                        const sourceDigest =
                          batch.diagnosticSourceDigest ??
                          gbufferProgramDigest(batch.artifact.program.source);
                        batch.diagnosticSourceDigest = sourceDigest;
                        gbufferProgram = Object.freeze({
                          scope: 'selected-gpu-driven-gbuffer-artifact' as const,
                          material: batch.artifact.material,
                          pass: batch.artifact.pass,
                          programIdentity: batch.artifact.program.identity,
                          artifactSourceSha256: sourceDigest,
                          specializationKey: batch.artifact.specializationKey ?? null,
                          layoutIdentity: batch.artifact.layoutIdentity,
                          receiptIdentity: batch.artifact.receipt?.receiptIdentity ?? null,
                          receiptGeneration: batch.artifact.receipt?.generation ?? null,
                          vertexEntry:
                            batch.raster.diagnosticGBufferVertexEntry(batch.artifact) ?? null,
                          fragmentEntry:
                            batch.deformation === 'skin' && input.visibleSurface !== undefined
                              ? SKIN_UNCOVERED_GBUFFER_ENTRY
                              : 'fs_gbuffer',
                          pipelineIdentity: getOpaqueResourceIdentity(
                            selectedPipeline.value as object,
                          ),
                          nativeShader: 'unobserved' as const,
                        });
                      }
                      geometry.commands.push({
                        pass: `${filter ?? 'all'}:${fragmentEntryPoint ?? 'default'}`,
                        phase,
                        level,
                        batchId: live.batch.batchId,
                        indirectOffset: commandOffset,
                        visibleBase:
                          visibleRegionBase + live.batch.visibleBase + level * levelStride,
                        bufferIdentity: getOpaqueResourceIdentity(indirectBuffer as object),
                        kind: live.batch.key.drawKind,
                        topology: live.batch.key.topology,
                        ...(gbufferProgram === undefined ? {} : { gbufferProgram }),
                        sources,
                      });
                    }
                  } catch (error) {
                    geometry.failure =
                      error instanceof Error ? error.message : 'source-capture-failed';
                  }
                }
                const surfacePass =
                  isMedium && fragmentEntryPoint === 'fs_nearest_layer'
                    ? 'nearest-layer'
                    : isMedium && fragmentEntryPoint === 'fs_color'
                      ? 'color'
                      : undefined;
                if (surfacePass !== undefined) {
                  frameResources.surfaceSubmissionObservation?.record(surfacePass, {
                    kind:
                      live.batch.key.drawKind === 'indexed'
                        ? 'draw-indexed-indirect'
                        : 'draw-indirect',
                    indirectBufferIdentity: getOpaqueResourceIdentity(indirectBuffer as object),
                    indirectOffset: commandOffset,
                    pipelineIdentity: getOpaqueResourceIdentity(selectedPipeline.value as object),
                    ...(batch.artifact.receipt === undefined
                      ? {}
                      : {
                          receiptIdentity: batch.artifact.receipt.receiptIdentity,
                          receiptGeneration: batch.artifact.receipt.generation,
                        }),
                  });
                }
                this.encodedIndirectDraws += 1;
                if (recordingRun !== undefined) recordingRun.draws += 1;
              }
              if (descriptor !== undefined && bundleKey !== undefined) {
                if (physicalVertex === undefined) throw new Error('Missing prepared vertex buffer');
                // Contiguous stable-ID blocks bound rebuilding to at most 32
                // batches while sharing state and reducing native execute overhead.
                const block = Math.floor(live.batch.batchId / 32);
                if (bundleBlock !== block) flushPrepared();
                bundleBlock = block;
                bundleOwner ??= live;
                if (bundleOwner !== live)
                  live.bundles.retire(bundleKey, production.preparedBundleCounters);
                preparedBindings ??= bundleOwner.bundles.begin(
                  bundleKey,
                  production.device,
                  production.preparedBundleCounters,
                );
                observedBindings.pipeline = selectedPipeline.value;
                observedBindings.view = viewBindGroup;
                observedBindings.material = materialBindGroup;
                observedBindings.materialOffset = materialOffset;
                observedBindings.mesh = group2;
                observedBindings.meshOffsets =
                  batch.deformation === 'skin'
                    ? pbrSkinMeshDynamicOffsets(0, requireViewSkinTask(view), true)
                    : [0];
                observedBindings.vertex = physicalVertex;
                observedBindings.index = indexKey === undefined ? undefined : physicalIndex;
                observedBindings.indexFormat = indexFormat;
                observedBindings.indirect = indirectBuffer;
                observedBindings.indirectOffset = regionOffset + live.batch.indirectOffset;
                observedBindings.indexed = live.batch.key.drawKind === 'indexed';
                observedBindings.windows = windows;
                preparedBindings.push(observedBindings);
              }
            }
            flushPrepared();
            if (preparedBundles.length > 0) {
              const executed = pass.executeBundles(preparedBundles);
              if (!executed.ok) throw executed.error;
            }
            if (retainKey !== undefined && retainedRuns !== undefined)
              production.retainedEncodes.finish(retainKey, identities, retainedRuns);
          },
        });
      },
    });
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
    const previous = preparation.cached;
    const sameInputs =
      previous !== undefined &&
      previous.worldKeys === scene.worldKeys &&
      previous.scene === scene.scene;
    let sameRows = true;
    let fixedMembership = true;
    let missingArtifact: GpuDrivenPreparationError | undefined;
    if (
      sameInputs &&
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
    let rebuiltBatches = 0;
    const serializedStates = new Map<object, string>();
    // Re-pinning the last assembly's versions proves every retained address in
    // this frame, so an edited plan re-joins only its new or changed rows.
    const inputs = previous?.inputs;
    const pinsAdopted =
      sameInputs &&
      inputs?.fixedRows === true &&
      inputs.pins !== undefined &&
      materials !== undefined &&
      inputs.materials !== materials &&
      materials.adoptPins?.(inputs.pins) === true;
    const batchRows = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/plan/rows',
      () => {
        const rows: PreparedBatchRows[] = [];
        for (const sourceBatch of scene.plan.batches) {
          const nativeMembership = MemberCandidates.is(sourceBatch.candidates);
          fixedMembership &&= nativeMembership;
          const execution =
            sourceBatch.binding === undefined
              ? undefined
              : batchExecutions.get(sourceBatch.binding)?.[pass];
          if (sourceBatch.binding === undefined || execution === undefined)
            throw new GpuDrivenPreparationError('missing-material-receipt', {
              reason: 'material-receipt-missing',
              owner: 'material',
              expected: 'shared material execution for every geometry batch',
            });
          // An absent Pass contributes no work to this view. Direct execution
          // remains in the plan so its real fallback still owns those rows.
          if (execution.route === 'none') continue;
          const index = rows.length;
          const geometry =
            execution.route === 'gpu'
              ? scene.meshes?.get(sourceBatch.binding.worldId, sourceBatch.binding.assetHandle)
              : undefined;
          const mesh = meshByBinding.get(sourceBatch.binding);
          const retained = preparation.batches.get(sourceBatch.batchId);
          let renderState: string | undefined;
          if (execution.route === 'gpu') {
            // Shared Pass state is serialized once per assembly, still observing in-place edits.
            const state = execution.pass.renderState;
            renderState = state === undefined ? 'undefined' : serializedStates.get(state);
            if (renderState === undefined && state !== undefined) {
              renderState = JSON.stringify(state);
              serializedStates.set(state, renderState);
            }
          }
          if (
            pinsAdopted &&
            nativeMembership &&
            renderState !== undefined &&
            retained !== undefined &&
            retained.source === sourceBatch &&
            retained.execution === execution &&
            retained.geometry === geometry &&
            retained.renderState === renderState &&
            retained.materialAddress !== undefined &&
            capturedGpuDrivenBatchKey(sourceBatch) !== undefined &&
            retained.value.mesh === mesh &&
            retained.value.meshContentEpoch === mesh?.contentEpoch &&
            samePreparedBatchLod(retained.value.lod, sourceBatch, mesh)
          ) {
            sameRows &&= retained.value === previous?.batchRows[index];
            rows.push(retained.value);
            continue;
          }
          const materialAddress = materials?.logicalForResource(
            sourceBatch.binding.material,
            execution.material,
          );
          if (materialAddress === undefined)
            throw new GpuDrivenPreparationError('resource-not-ready', {
              reason: 'material-resource-missing',
              owner: 'material',
              expected: 'resident shared material row for the accepted batch',
            });
          const geometryAddress =
            execution.route === 'gpu'
              ? materials?.logicalForGeometry(
                  sourceBatch.binding.worldId,
                  sourceBatch.binding.assetHandle,
                  geometry,
                )
              : undefined;
          if (
            geometry !== undefined &&
            sourceBatch.binding.geometry.deformation === 'rigid' &&
            geometryAddress === undefined
          )
            throw new GpuDrivenPreparationError('stale-generation', {
              reason: 'generation-stale',
              owner: 'geometry',
              expected: 'resident shared geometry for the accepted frame',
            });
          // Signature, execution key and artifact all derive from these captured identities.
          if (
            sameInputs &&
            nativeMembership &&
            renderState !== undefined &&
            retained !== undefined &&
            retained.renderState === renderState &&
            capturedGpuDrivenBatchKey(sourceBatch) !== undefined &&
            retained.source === sourceBatch &&
            retained.execution === execution &&
            retained.materialAddress === materialAddress &&
            retained.geometryAddress === geometryAddress &&
            retained.value.mesh === mesh &&
            retained.value.meshContentEpoch === mesh?.contentEpoch &&
            samePreparedBatchLod(retained.value.lod, sourceBatch, mesh)
          ) {
            sameRows &&= retained.value === previous.batchRows[index];
            if (retained.geometry !== geometry)
              preparation.batches.set(sourceBatch.batchId, { ...retained, geometry });
            rows.push(retained.value);
            continue;
          }
          const capturedKey = capturedGpuDrivenBatchKey(sourceBatch);
          const executionKey =
            capturedKey !== undefined && execution.route === 'gpu'
              ? batchExecutionKey(sourceBatch, execution)
              : undefined;
          const materializeBatch = (): GpuDrivenBatch =>
            execution.route !== 'gpu'
              ? Object.freeze({ ...sourceBatch })
              : Object.freeze({
                  ...sourceBatch,
                  materialAddress,
                  logicalResources: true as const,
                  ...(geometryAddress === undefined ? {} : { geometryAddress }),
                  prepared: execution.prepared,
                  key: Object.freeze({
                    ...sourceBatch.key,
                    ...(executionKey ?? batchExecutionKey(sourceBatch, execution)),
                  }),
                });
          let batch: GpuDrivenBatch | undefined;
          let signature: string;
          if (
            capturedKey !== undefined &&
            execution.route === 'gpu' &&
            executionKey !== undefined
          ) {
            // resourceIdentity is already in capturedKey. Compare the retained row's
            // immutable execution fields directly; serialize only the live facts.
            signature = JSON.stringify([
              execution.route,
              materialAddress,
              geometryAddress,
              execution.pass.renderState,
              execution.material.materialHandle,
              execution.material.standardTextureMask,
            ]);
          } else {
            batch = materializeBatch();
            signature = JSON.stringify([
              execution.route,
              materialAddress,
              geometryAddress,
              batch.key,
              execution.route === 'gpu' ? execution.pass.renderState : null,
              execution.route === 'gpu' ? execution.material.materialHandle : null,
              execution.route === 'gpu' ? execution.material.standardTextureMask : null,
            ]);
          }
          const currentBatch = batch ?? sourceBatch;
          const cached = preparation.batches.get(currentBatch.batchId);
          const artifact = execution.route === 'gpu' ? execution.artifact : undefined;
          const prepared =
            batch !== undefined
              ? batch.prepared
              : execution.route === 'gpu'
                ? execution.prepared
                : sourceBatch.prepared;
          if (
            missingArtifact === undefined &&
            execution.route === 'gpu' &&
            artifact === undefined &&
            currentBatch.candidates.length > 0 &&
            prepared?.receiptIdentity !== undefined
          ) {
            missingArtifact = new GpuDrivenPreparationError('missing-material-receipt', {
              reason: 'material-receipt-missing',
              owner: 'material',
              expected: `published artifact for ${prepared.identity.material} (${prepared.receiptIdentity}@${prepared.receiptGeneration})`,
            });
          }
          const sameMeshes =
            cached?.value.mesh === mesh && cached?.value.meshContentEpoch === mesh?.contentEpoch;
          if (
            sameInputs &&
            nativeMembership &&
            cached !== undefined &&
            cached.value.source.candidates === sourceBatch.candidates &&
            cached.value.source.generation === sourceBatch.generation &&
            cached.value.source.contentEpoch === sourceBatch.contentEpoch &&
            cached.signature === signature &&
            (executionKey === undefined ||
              (capturedGpuDrivenBatchKey(cached.source) === capturedKey &&
                cached.value.source.key.preparedIdentity === executionKey.preparedIdentity &&
                cached.value.source.key.pipelineClass === executionKey.pipelineClass &&
                cached.value.source.key.admission === executionKey.admission &&
                cached.value.source.key.materialPass === executionKey.materialPass)) &&
            sameMaterialArtifact(cached.artifact, artifact) &&
            sameMeshes &&
            samePreparedBatchLod(cached.value.lod, currentBatch, mesh)
          ) {
            if (cached.source === sourceBatch) {
              sameRows &&= cached.value === previous.batchRows[index];
              if (cached.execution !== execution || cached.renderState !== renderState)
                preparation.batches.set(currentBatch.batchId, {
                  ...cached,
                  execution,
                  materialAddress,
                  geometryAddress,
                  geometry,
                  renderState,
                });
              rows.push(cached.value);
              continue;
            }
            sameRows = false;
            // Only the aligned visible window moved; rows keep their facts.
            batch ??= materializeBatch();
            const rebased = Object.freeze({
              ...cached.value,
              source: batch,
            });
            preparation.batches.set(currentBatch.batchId, {
              ...cached,
              source: sourceBatch,
              value: rebased,
              execution,
              materialAddress,
              geometryAddress,
              geometry,
              renderState,
            });
            rows.push(rebased);
            continue;
          }
          sameRows = false;
          batch ??= materializeBatch();
          const value = prepareBatchRows(batch, {
            mesh,
            worldKeys: scene.worldKeys,
            execution,
          });
          preparation.batches.set(currentBatch.batchId, {
            source: sourceBatch,
            signature,
            // Retain the observed fields, not the mutable publication wrapper.
            artifact:
              artifact === undefined
                ? undefined
                : {
                    ...artifact,
                    ...(artifact.receipt === undefined ? {} : { receipt: { ...artifact.receipt } }),
                  },
            value,
            execution,
            materialAddress,
            geometryAddress,
            geometry,
            renderState,
          });
          rebuiltBatches += 1;
          rows.push(value);
        }
        return rows;
      },
    );
    // Native plans contain unique batch IDs, and the row loop retains every
    // admitted ID even for a rejected artifact. Equal cardinality therefore
    // proves there are no retired rows; only removals need a membership scan.
    if (preparation.batches.size > batchRows.length) {
      const live = new Set(batchRows.map((rows) => rows.source.batchId));
      for (const batchId of preparation.batches.keys()) {
        if (!live.has(batchId)) preparation.batches.delete(batchId);
      }
    }
    this.preparedBatchBuilds += rebuiltBatches;
    this.planRebuildBatches += rebuiltBatches;
    this.planRebuildCandidates = 0;
    // A failed artifact publication cannot admit filtered or GPU work.
    if (missingArtifact !== undefined) return err(missingArtifact);
    if (
      sameInputs &&
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
    const value = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/plan/admission',
      () =>
        assemblePreparedPlan(
          scene.plan,
          batchRows,
          scene.worldKeys,
          fixedMembership && sameRows && previous?.plan === scene.plan
            ? previous.value.lodPlan
            : undefined,
        ),
    );
    preparation.cached = {
      plan: scene.plan,
      slotAt: scene.slotAt,
      worldKeys: scene.worldKeys,
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
    lod: LodProjectionState,
    lodPrepared: Parameters<typeof shadowLodProjectionState>[0],
    camera: CameraSnapshot,
    capsuleShadowDirectional: boolean,
    directMaterials: import('../scene/material-dispatch').MaterialFrame | undefined,
    shadowMaterials: ShadowMaterialContent | undefined,
    profilePhase?: RecordProfileRunner,
  ): Result<void, RhiError> {
    if (views.length === 0) return this.disableShadowViews();
    this.observedShadowArtifacts = observeShadowArtifacts(
      this.observedShadowArtifacts,
      filtered.materialBatches,
    );
    const artifacts = this.observedShadowArtifacts;
    const lodCamera: LodViewCamera = camera;
    let cullCamera: GpuDrivenOcclusionCamera | undefined;
    // A light view ranks casters by their footprint in its own projection,
    // bounded by the main camera; a view without a matrix follows the main
    // camera. Views sharing a matrix (static and dynamic layers) share one
    // projection.
    const lodByMatrix = new Map<string, Partial<ShadowViewUpdateInput>>();
    const shadowViewLod = (matrix: Float32Array | undefined): Partial<ShadowViewUpdateInput> => {
      if (lod.projectedHeights === undefined) return { lodCamera };
      if (matrix === undefined) {
        return {
          lodCamera,
          lodProjectedHeights: lod.projectedHeights,
          lodSelection: lod.selectionFingerprint,
        };
      }
      const key = matrix.join(',');
      const cached = lodByMatrix.get(key);
      if (cached !== undefined) return cached;
      const projection = shadowLodProjectionState(
        lodPrepared,
        matrix,
        lod,
        scene.slotAt,
        profilePhase,
      );
      const entry: Partial<ShadowViewUpdateInput> = {
        lodCamera: lodViewCameraFromMatrix(matrix),
        lodClampCamera: lodCamera,
        ...(projection.projectedHeights === undefined
          ? {}
          : {
              lodProjectedHeights: projection.projectedHeights,
              lodSelection: projection.selectionFingerprint,
            }),
      };
      lodByMatrix.set(key, entry);
      return entry;
    };
    if (
      this.shadowViews === undefined ||
      this.shadowSource === undefined ||
      this.shadowScene === undefined
    ) {
      return ok(undefined);
    }
    const nextProjections = new Map<string, ReadonlyMap<number, GpuDrivenShadowBatchProjection>>();
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
    let preparedByBatch: ReadonlyMap<number, FilteredProductionPlan['batches'][number]> | undefined;
    const diffs = new ShadowProjectionDiffs(filtered, batchExecutions);
    const sceneTransformBuffer = scene.scene.transformBuffer;
    const sceneTransformBytes = scene.scene.rowCapacity * GPU_SCENE_LAYOUTS.transform.stride;
    const meshBinding = materialRaster.sceneMeshBindGroup(
      sceneTransformBuffer,
      sceneTransformBytes,
    );
    if (!meshBinding.ok) return meshBinding;
    const visibleBindingIdentity = materialRaster.visibleBindingIdentity;
    const skinVisibleBindingIdentity = this.skinRaster?.visibleBindingIdentity;
    const shadowViews = this.shadowViews;
    const { plan: shadowSourcePlan, projectionSource } = this.shadowSource;
    const shadowScene = this.shadowScene;
    const classes = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/shadow-views/caster-classes',
      () => this.shadowCasterClasses.update(scene, shadowScene),
    );
    const projectView = ({
      cameraCull,
      staticLayer: _staticLayer,
      ...input
    }: ShadowViewRequest): Result<ShadowViewUpdate['cache'], RhiError> =>
      runRecordProfilePhase(
        profilePhase,
        'record/gpu-driven-prepare/shadow-views/project-view',
        () => {
          const identityKey = shadowViewIdentityKey(input.identity);
          const previousProjections = this.shadowBatchProjections.get(identityKey);
          const previousSource =
            previousProjections === undefined
              ? undefined
              : this.shadowProjectionSources.get(previousProjections);
          // Membership already invalidates depth through the source plan and bounds.
          // A publication edit can leave both unchanged: observe only receipts this
          // view consumed, before its depth-cache decision, including unsubmitted work.
          // A view whose projections, filtered rows, executions and receipts are the
          // same objects as its last unchanged check cannot observe a new edit.
          const unchangedInputs = this.shadowUnchangedInputs.get(identityKey);
          const sameInputs =
            previousProjections !== undefined &&
            unchangedInputs?.projections === previousProjections &&
            unchangedInputs.filtered === filtered &&
            unchangedInputs.executions === batchExecutions &&
            unchangedInputs.artifacts === artifacts;
          const artifactsChanged =
            !sameInputs &&
            previousSource !== undefined &&
            previousSource.artifacts !== artifacts &&
            previousSource.plan.batches.some((batch) => {
              const key = shadowMaterialKey(batch);
              return artifacts.has(key) && previousSource.artifacts.get(key) !== artifacts.get(key);
            });
          // Projected rows matched previousSource.filtered; unchanged rows keep their mesh.
          const meshesChanged =
            !sameInputs &&
            previousSource !== undefined &&
            previousSource.filtered !== filtered &&
            diffs.rowsChangedSince(previousSource.filtered).changed.some((prepared) => {
              const previous = previousProjections?.get(prepared.batch.batchId);
              return (
                previous !== undefined &&
                (previous.mesh !== prepared.mesh ||
                  previous.meshContentEpoch !== prepared.meshContentEpoch)
              );
            });
          if (artifactsChanged) shadowViews.invalidate('artifact-changed', input.identity);
          else if (meshesChanged) shadowViews.invalidate('content-changed', input.identity);
          else if (
            !sameInputs &&
            previousSource !== undefined &&
            previousSource.executions !== batchExecutions &&
            (previousSource.executions === undefined ||
              diffs.executionsChangedSince(previousSource.executions).size > 0) &&
            previousSource.plan.batches.some((batch) => {
              const execution =
                batch.binding === undefined
                  ? undefined
                  : batchExecutions.get(batch.binding)?.shadow;
              return (
                execution?.route === 'gpu' &&
                !sameShadowMaterial(
                  previousProjections?.get(batch.batchId)?.material,
                  execution.material,
                )
              );
            })
          )
            shadowViews.invalidate('content-changed', input.identity);
          const viewLod = shadowViewLod(input.matrix);
          if (cameraCull !== undefined) cullCamera ??= occlusionCamera(camera);
          const updated = runRecordProfilePhase(
            profilePhase,
            'record/gpu-driven-prepare/shadow-views/project-view/cache-update',
            () =>
              shadowViews.update(
                {
                  ...input,
                  sourcePlan: shadowSourcePlan,
                  scene: shadowScene,
                  inputReads,
                  skin: scene.skin,
                  capsuleDirectional:
                    capsuleShadowDirectional && input.identity.kind === 'directional',
                  ...(directMaterials === undefined || input.identity.layer === 'static'
                    ? {}
                    : { directMaterials }),
                  ...(shadowMaterials === undefined ? {} : { shadowMaterials }),
                  ...viewLod,
                  ...(cameraCull === undefined || cullCamera === undefined
                    ? {}
                    : { cameraCull: { ...cameraCull, camera: cullCamera } }),
                },
                projectionSource,
              ),
          );
          if (!updated.ok) return updated;
          const submission = shadowViews.submission(input.identity);
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
          const skinMeshBinding =
            submission.view.skinTaskBinding() === undefined
              ? undefined
              : this.skinRaster?.sceneMeshBindGroup(
                  sceneTransformBuffer,
                  sceneTransformBytes,
                  submission.view.skinTaskBinding(),
                );
          if (skinMeshBinding !== undefined && !skinMeshBinding.ok) return skinMeshBinding;
          const sameBindings =
            previousSource !== undefined &&
            previousSource.visibleBuffer === visibleBuffer &&
            previousSource.meshBinding === meshBinding.value &&
            previousSource.skinMeshBinding === skinMeshBinding?.value &&
            previousSource.visibleBindingIdentity === visibleBindingIdentity &&
            previousSource.skinVisibleBindingIdentity === skinVisibleBindingIdentity;
          // Moving the camera or casters changes depth, not the binding contract.
          // Source edits outside this view do not replace its draw bindings.
          // Changed plans and ownership compare each batch below; physical changes rebuild.
          // Depth hits already validated drawn content; misses also check live material values.
          if (
            !artifactsChanged &&
            !meshesChanged &&
            previousProjections !== undefined &&
            previousSource !== undefined &&
            sameShadowProjectionLayout(previousSource.plan, submission.plan) &&
            sameBindings &&
            (previousSource.filtered === filtered ||
              (!diffs.rowsChangedSince(previousSource.filtered).removed &&
                diffs
                  .rowsChangedSince(previousSource.filtered)
                  .changed.every(
                    ({ batch, mesh }) =>
                      !previousProjections.has(batch.batchId) ||
                      previousProjections.get(batch.batchId)?.mesh === mesh,
                  )) ||
              submission.plan.batches.every((batch) => {
                preparedByBatch ??= filteredRows(filtered);
                return (
                  preparedByBatch.get(batch.batchId)?.mesh ===
                  previousProjections.get(batch.batchId)?.mesh
                );
              })) &&
            submission.plan.batches.every((batch, index) => {
              // The same retained row, validated against the same execution table.
              if (
                previousSource.executions === batchExecutions &&
                previousSource.plan.batches.at(index) === batch
              )
                return true;
              if (batch.visibleCapacity === 0) return !previousProjections.has(batch.batchId);
              const execution =
                batch.binding === undefined
                  ? undefined
                  : batchExecutions.get(batch.binding)?.shadow;
              const projection = previousProjections.get(batch.batchId);
              if (execution?.route !== 'gpu' || projection?.material !== execution.material)
                return false;
              const entry = execution.pass;
              const shadowRenderState = reflectedRenderState(
                entry.renderState,
                batch.key.reflected === true,
              );
              return (
                projection.shadowVertexEntry === entry.vertexEntry &&
                projection.shadowFragmentEntry === entry.fragmentEntry &&
                (projection.shadowRenderState === shadowRenderState ||
                  JSON.stringify(projection.shadowRenderState) ===
                    JSON.stringify(shadowRenderState))
              );
            })
          ) {
            previousSource.filtered = filtered;
            previousSource.executions = batchExecutions;
            previousSource.artifacts = artifacts;
            nextProjections.set(identityKey, previousProjections);
            return ok(updated.value.cache);
          }
          preparedByBatch ??= filteredRows(filtered);
          const previousBatches = sameBindings ? previousSource.plan.batches : undefined;
          // A topology/depth revision can leave every physical draw projection unchanged.
          // Keep that publication without allocating and filling another complete map.
          let projections: Map<number, GpuDrivenShadowBatchProjection> | undefined =
            previousProjections?.size === submission.plan.batches.length &&
            previousBatches?.every(
              (batch, index) => batch.batchId === submission.plan.batches.at(index)?.batchId,
            )
              ? undefined
              : new Map();
          let previousById: ReadonlyMap<number, GpuDrivenBatch> | undefined;
          let batchIndex = 0;
          // An unchanged batch owner with unchanged prepared row, execution and
          // physical bindings keeps its projection without re-deriving it.
          const retainedOwners =
            sameBindings && previousSource.artifacts === artifacts
              ? diffs.retainedOwners(
                  previousSource.plan,
                  previousSource.filtered,
                  previousSource.executions,
                )
              : undefined;
          for (const batch of submission.plan.batches) {
            if (batch.visibleCapacity === 0) {
              projections ??= new Map(previousProjections);
              projections.delete(batch.batchId);
              batchIndex++;
              continue;
            }
            const retainedProjection = retainedOwners?.(batch)
              ? previousProjections?.get(batch.batchId)
              : undefined;
            if (retainedProjection !== undefined) {
              projections?.set(batch.batchId, retainedProjection);
              batchIndex++;
              continue;
            }
            const prepared = preparedByBatch.get(batch.batchId);
            if (prepared === undefined) {
              return err(
                new RhiError({
                  code: 'internal-error',
                  expected: `prepared shadow mesh batch ${batch.batchId}`,
                  hint: 'keep filtered shadow topology and per-view projection on one frame identity',
                }),
              );
            }
            const execution =
              batch.binding === undefined ? undefined : batchExecutions.get(batch.binding)?.shadow;
            if (batch.binding === undefined || execution?.route !== 'gpu') {
              return err(
                new RhiError({
                  code: 'internal-error',
                  expected: `accepted shared material execution for shadow batch ${batch.batchId}`,
                  hint: 'retain the same geometry binding and material frame through shadow projection',
                }),
              );
            }
            const material = execution.material;
            const shadowEntry = execution.pass;
            const shadowRenderState = reflectedRenderState(
              shadowEntry.renderState,
              batch.key.reflected === true,
            );
            const deformation = batch.prepared?.identity.deformation ?? 'rigid';
            const raster = deformation === 'skin' ? this.skinRaster : materialRaster;
            const projectedMeshBinding =
              deformation === 'skin' ? skinMeshBinding?.value : meshBinding.value;
            const batchArtifact = prepared.artifact;
            const artifactKey =
              previousSource?.artifacts === artifacts ? undefined : shadowMaterialKey(batch);
            const shadowArtifact = execution.artifact;
            if (
              raster === undefined ||
              projectedMeshBinding === undefined ||
              batchArtifact === undefined ||
              shadowArtifact === undefined
            ) {
              return err(
                new RhiError({
                  code: 'rhi-not-available',
                  expected: `${deformation === 'skin' ? 'skinned ' : ''}selected shadow MaterialProgramAbi artifact`,
                  hint: 'publish a matching shadow-pass program before entering the capable shadow lane',
                }),
              );
            }
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
              previousBatch?.batchId === batch.batchId &&
              previousBatch.visibleBase === batch.visibleBase &&
              (previousBatch.visibleAllocationCapacity ?? previousBatch.visibleCapacity) ===
                (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
              previousBatch.indirectOffset === batch.indirectOffset &&
              previousProjection?.mesh === prepared.mesh &&
              previousProjection.meshContentEpoch === prepared.meshContentEpoch &&
              previousProjection.meshBindGroup === projectedMeshBinding &&
              previousProjection.deformation === deformation &&
              previousProjection.visibleBindGroups.length === batchLodLevelCount(batch) &&
              batchLevelStride(previousBatch) === batchLevelStride(batch) &&
              previousProjection.material === material &&
              previousProjection.worldId === batch.binding.worldId &&
              previousProjection.shadowVertexEntry === shadowEntry?.vertexEntry &&
              previousProjection.shadowFragmentEntry === shadowEntry?.fragmentEntry &&
              (previousProjection.shadowRenderState === shadowRenderState ||
                JSON.stringify(previousProjection.shadowRenderState) ===
                  JSON.stringify(shadowRenderState)) &&
              sameMaterialArtifact(previousProjection.shadowArtifact, shadowArtifact) &&
              (artifactKey === undefined ||
                previousSource?.artifacts.get(artifactKey) === artifacts.get(artifactKey))
            ) {
              projections?.set(batch.batchId, previousProjection);
              continue;
            }
            const visibleBindGroups: BindGroup[] = [];
            const levelStride = batchLevelStride(batch);
            for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
              const visibleBindGroup = raster.shadowVisibleWindowBindGroupForBuffer(
                visibleBuffer,
                batch.visibleBase + level * levelStride,
                batch.visibleAllocationCapacity ?? batch.visibleCapacity,
              );
              if (!visibleBindGroup.ok) return visibleBindGroup;
              visibleBindGroups.push(visibleBindGroup.value);
            }
            projections ??= new Map(previousProjections);
            projections.set(batch.batchId, {
              bundles: previousProjection?.bundles ?? new PreparedRasterBundleCache(),
              mesh: prepared.mesh,
              meshContentEpoch: prepared.meshContentEpoch,
              meshBindGroup: projectedMeshBinding,
              visibleBindGroups,
              deformation,
              shadowArtifact,
              ...(shadowRenderState === undefined ? {} : { shadowRenderState }),
              ...(shadowEntry?.vertexEntry === undefined
                ? {}
                : { shadowVertexEntry: shadowEntry.vertexEntry }),
              ...(shadowEntry?.fragmentEntry === undefined
                ? {}
                : { shadowFragmentEntry: shadowEntry.fragmentEntry }),
              material,
              worldId: batch.binding.worldId,
              vertexColorAvailable: prepared.mesh.layoutProjection.attributes.some(
                (attribute) => attribute.key === 'color',
              ),
            });
          }
          const publishedProjections =
            projections === undefined && previousProjections !== undefined
              ? previousProjections
              : publishReadonlyMap(projections ?? new Map());
          nextProjections.set(identityKey, publishedProjections);
          this.shadowUnchangedInputs.set(identityKey, {
            projections: publishedProjections,
            filtered,
            executions: batchExecutions,
            artifacts,
          });
          this.shadowProjectionSources.set(publishedProjections, {
            plan: submission.plan,
            filtered,
            executions: batchExecutions,
            artifacts,
            visibleBuffer,
            meshBinding: meshBinding.value,
            skinMeshBinding: skinMeshBinding?.value,
            visibleBindingIdentity,
            skinVisibleBindingIdentity,
          });
          return ok(updated.value.cache);
        },
      );
    const retained: ShadowViewIdentity[] = [];
    for (const requested of views) {
      const channels = requested.casterChannels ?? 0xffffffff;
      let input = requested;
      if (channels !== 0xffffffff) {
        const restriction = requested.candidatePrimitiveIndices;
        const requestedCandidates =
          restriction === undefined
            ? undefined
            : 'has' in restriction
              ? restriction
              : new Set(restriction);
        const candidatePrimitiveIndices = new Set<number>();
        for (const batch of shadowSourcePlan.batches) {
          for (const candidate of batch.candidates) {
            if (
              (requestedCandidates === undefined ||
                requestedCandidates.has(candidate.primitiveIndex)) &&
              ((scene.slotAt(candidate.primitiveIndex)?.snapshot.shadowChannels ?? 0xffffffff) &
                channels) !==
                0
            )
              candidatePrimitiveIndices.add(candidate.primitiveIndex);
          }
        }
        input = { ...requested, candidatePrimitiveIndices };
      }
      retained.push(input.identity);
      if (!shadowViewHasStaticLayer(input.identity)) {
        const projected = projectView(input);
        if (!projected.ok) return projected;
        continue;
      }
      const staticIdentity: ShadowViewIdentity = { ...input.identity, layer: 'static' };
      const viewClasses = restrictShadowCasterClasses(classes, input.candidatePrimitiveIndices);
      const singleLayer = input.staticLayer === false;
      // A mode change swaps the final layer's caster set and its graph
      // composition. Neither layer's retained depth may survive it: a
      // re-enabled static layer kept its depth while it was not drawn.
      const viewKey = shadowViewIdentityKey(input.identity);
      if (singleLayer !== this.shadowSingleLayerViews.has(viewKey)) {
        if (singleLayer) this.shadowSingleLayerViews.add(viewKey);
        else this.shadowSingleLayerViews.delete(viewKey);
        shadowViews.invalidate('configuration-changed', input.identity);
        shadowViews.invalidate('configuration-changed', staticIdentity);
      }
      if (singleLayer) {
        // Settled casters draw with the rest every time the view rasters;
        // capsule casters leave directional views on the GPU as in two layers.
        const projected = projectView({
          ...input,
          candidatePrimitiveIndices: viewClasses.casterSlots,
        });
        if (!projected.ok) return projected;
        continue;
      }
      // The static layer holds settled casters and is re-rastered only when
      // one of them changes; the final layer copies it and adds the rest.
      retained.push(staticIdentity);
      const staticProjected = projectView({
        ...input,
        identity: staticIdentity,
        candidatePrimitiveIndices: viewClasses.staticSlots,
        ignoredChangeSlots: classes.dynamicSlots,
      });
      if (!staticProjected.ok) return staticProjected;
      if (staticProjected.value === 'invalidated') {
        shadowViews.invalidate('static-layer-changed', input.identity);
      }
      const finalProjected = projectView({
        ...input,
        candidatePrimitiveIndices: viewClasses.dynamicSlots,
      });
      if (!finalProjected.ok) return finalProjected;
    }
    shadowViews.retain(retained);
    this.shadowBatchProjections = publishReadonlyMap(nextProjections);
    return ok(undefined);
  }

  private disableShadowViews(): Result<void, RhiError> {
    this.shadowViews?.retain([]);
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    return ok(undefined);
  }

  dispose(): void {
    for (const frame of this.resourceFrames) frame.release();
    this.resourceFrames.clear();
    if (this.disposed) return;
    this.disposed = true;
    this.view?.dispose();
    this.view = undefined;
    this.materialRaster?.dispose();
    this.materialRaster = undefined;
    this.observedShadowArtifacts = new Map();
    this.skinRaster?.dispose();
    this.skinRaster = undefined;
    for (const preparation of Object.values(this.preparations)) {
      preparation.cached = undefined;
      preparation.batches.clear();
    }
    this.filteredCache = undefined;
    this.liveRasterCache = undefined;
    this.liveRasterBatches = [];
    this.shadowFilteredCache = undefined;
    this.mainFilterContributions.clear();
    this.shadowFilterContributions.clear();
    this.surfaceFrames.clear();
    this.rasterGraphIdentity.clear();
    this.shadowViews?.dispose();
    this.shadowViews = undefined;
    this.shadowSource = undefined;
    this.shadowScene = undefined;
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    this.committedViewClipping = '';
    this.preparationFailure = undefined;
    this.surfaceArtifactInspection = undefined;
    this.overflowRecoveryRequired = false;
  }

  get resourceGeneration(): number | undefined {
    return this.view?.currentResourceGeneration;
  }

  /** Skin task upload bytes belong to the recording's CPU task owner. */
  inspect(paletteUploadBytes = 0): GpuDrivenProductionInspection {
    const view = this.view?.inspect();
    const filtered = this.filteredCache?.value;
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
    const mainTotalDrawCount = this.mainTotalDrawItems;
    const mainClaimedDrawCount = this.telemetryOverflow
      ? 0
      : Math.min(this.gpuOwnedDrawItems, mainTotalDrawCount);
    const mainResidualDrawCount = Math.max(0, mainTotalDrawCount - mainClaimedDrawCount);
    const mainFacts = {
      totalDrawCount: mainTotalDrawCount,
      claimedDrawCount: mainClaimedDrawCount,
      residualDrawCount: mainResidualDrawCount,
    };
    if (mainClaimedDrawCount > 0 || (this.lane !== 'gpu' && this.lane !== 'blocked')) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
        lane: this.lane,
        reason: this.laneReason,
        drawCount: mainClaimedDrawCount,
        ...mainFacts,
      });
    }
    if (this.cpuSemanticFallbackDrawItems > 0) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
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
        channels.push({
          viewPass: 'main',
          viewIndex: 0,
          lane: 'cpu-deformation',
          reason,
          drawCount,
          ...mainFacts,
        });
      }
    }
    if (this.blockedDrawItems > 0) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
        lane: 'blocked',
        reason: 'resource-not-ready',
        drawCount: this.blockedDrawItems,
        ...mainFacts,
        ...(this.preparationFailure === undefined ? {} : { failure: this.preparationFailure }),
      });
    }
    for (const entry of this.shadowViews?.inspect() ?? []) {
      // Retained view resources outlive admission. An idle frame has no
      // current GPU projection and must not publish last frame's channels.
      if (this.submissionState === 'idle' || channels.length >= 32) break;
      if (entry.identity.layer !== undefined) continue;
      const key = shadowViewIdentityKey(entry.identity);
      const layers = [entry.identity, { ...entry.identity, layer: 'static' as const }];
      let total = 0,
        claimed = 0;
      for (const identity of layers)
        for (const batch of this.shadowViews?.submission(identity)?.plan.batches ?? []) {
          total += batch.candidates.length;
          if (batch.visibleCapacity > 0) claimed += batch.candidates.length;
        }
      const effectiveClaimed = this.telemetryOverflow ? 0 : claimed;
      const residual = total - effectiveClaimed;
      if (total === 0) continue;
      const projected = this.shadowBatchProjections.has(key);
      const viewPass =
        entry.identity.kind === 'directional'
          ? 'directional-shadow'
          : entry.identity.kind === 'point'
            ? 'point-shadow'
            : 'spot-shadow';
      if (projected && effectiveClaimed > 0) {
        channels.push({
          viewPass,
          viewIndex: entry.identity.index,
          ...(entry.identity.face === undefined ? {} : { face: entry.identity.face }),
          lane: this.telemetryOverflow ? 'blocked' : 'gpu',
          reason: this.telemetryOverflow ? 'overflow' : 'none',
          drawCount: effectiveClaimed,
          totalDrawCount: total,
          claimedDrawCount: effectiveClaimed,
          residualDrawCount: residual,
        });
      }
      if (residual > 0) {
        channels.push({
          viewPass,
          viewIndex: entry.identity.index,
          ...(entry.identity.face === undefined ? {} : { face: entry.identity.face }),
          lane: this.telemetryOverflow ? 'blocked' : 'cpu-semantic',
          reason: this.telemetryOverflow ? 'overflow' : 'unsupported',
          drawCount: residual,
          totalDrawCount: total,
          claimedDrawCount: effectiveClaimed,
          residualDrawCount: residual,
        });
      }
    }
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
      surfaceFrameRangeBuilds: this.surfaceFrames.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans:
        this.surfaceFrames.surfaceFrameRangeMemberScans +
        (this.materialRaster?.surfaceDynamicFrameMemberScans ?? 0) +
        (this.skinRaster?.surfaceDynamicFrameMemberScans ?? 0),
      surfaceFrameRowAllocations:
        (this.materialRaster?.surfaceDynamicFrameRowAllocations ?? 0) +
        (this.skinRaster?.surfaceDynamicFrameRowAllocations ?? 0),
      surfaceFrameTimeWrites: this.materialRaster?.surfaceDynamicFrameTimeWrites ?? 0,
      gpuOwnedSnapshotsMaterialized: this.gpuOwnedSnapshotsMaterialized,
      filteredPlanBuilds: this.filteredPlanBuilds,
      preparedBatchBuilds: this.preparedBatchBuilds,
      filteredBatchBuilds: this.filteredBatchBuilds,
      planRebuildBatches: this.planRebuildBatches,
      preparedAssemblyHits: this.preparedAssemblyHits,
      planRebuildCandidates: this.planRebuildCandidates,
      lodSelectionChanges: this.lodSelectionChanges,
      shadowCasterFlips: this.shadowCasterClasses.inspect().flips,
      shadowCasterClassification: this.shadowCasterClasses.inspect(),
      shadowViews: this.shadowViews?.inspect() ?? [],
      shadowCasterPendingPromotions: this.shadowCasterClasses.inspect().pendingPromotions,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      sharedInputUploadBytes: this.telemetryPrepared ? (view?.sharedInputUploadBytes ?? 0) : 0,
      suppressionUploadBytes: this.telemetryPrepared ? (view?.suppressionUploadBytes ?? 0) : 0,
      batchUploadBytes: this.telemetryPrepared ? (view?.batchUploadBytes ?? 0) : 0,
      viewConstantsUploadBytes: this.telemetryPrepared ? (view?.viewConstantsUploadBytes ?? 0) : 0,
      batchBindGroupCreates: this.batchBindGroupCreates,
      submissionVisibleCapacity: view?.visibleCapacity ?? 0,
      submissionReservedVisibleEntries: this.liveRasterBatches.reduce(
        (sum, live) => sum + batchVisibleSpan(live.batch),
        0,
      ),
      visibleBufferCapacity: view?.visibleBufferCapacity ?? 0,
      submissionWindowRelocations:
        this.mainFilterContributions.windowCounters.relocations +
        this.shadowFilterContributions.windowCounters.relocations,
      submissionWindowCompactions:
        this.mainFilterContributions.windowCounters.compactions +
        this.shadowFilterContributions.windowCounters.compactions,
      filteredAssemblyPublicationHits:
        this.mainFilterContributions.assemblyCounters.publicationHits +
        this.shadowFilterContributions.assemblyCounters.publicationHits,
      filteredAssemblyHits:
        this.mainFilterContributions.assemblyCounters.batchHits +
        this.shadowFilterContributions.assemblyCounters.batchHits,
      filteredAssemblyBuilds:
        this.mainFilterContributions.assemblyCounters.batchBuilds +
        this.shadowFilterContributions.assemblyCounters.batchBuilds,
      filteredAssemblyChurnFallbacks:
        this.mainFilterContributions.assemblyCounters.churnFallbacks +
        this.shadowFilterContributions.assemblyCounters.churnFallbacks,
      visibleWindowCreates:
        (this.materialRaster?.visibleWindowCounters.creates ?? 0) +
        (this.skinRaster?.visibleWindowCounters.creates ?? 0),
      visibleWindowHits:
        (this.materialRaster?.visibleWindowCounters.hits ?? 0) +
        (this.skinRaster?.visibleWindowCounters.hits ?? 0),
      visibleWindowResets:
        (this.materialRaster?.visibleWindowCounters.resets ?? 0) +
        (this.skinRaster?.visibleWindowCounters.resets ?? 0),
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
      resourceAllocationOwners: Object.freeze({
        ...(view === undefined ? {} : { gpuDrivenView: view.resourceAllocation }),
        ...(this.materialRaster === undefined
          ? {}
          : { materialRaster: this.materialRaster.resourceAllocation }),
        ...(this.skinRaster === undefined
          ? {}
          : { skinRaster: this.skinRaster.resourceAllocation }),
      }),
      ...(resourceClasses === undefined
        ? {}
        : {
            resourceClassCount: resourceClasses.resourceClassCount,
            resourceClassSplits: resourceClasses.resourceClassSplits,
            resourceClassSplitReasons: resourceClasses.resourceClassSplitReasons,
          }),
    };
  }

  /** Read renderer-owned LOD counters copied by the last GPU submission. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    if (!this.telemetryPrepared) return Promise.resolve(undefined);
    const view = this.view;
    const filtered = this.filteredCache?.value;
    const sourceFrame = this.preparations.forward.cached;
    const filteredWorldKeys = this.filteredCache?.prepared.worldKeys;
    const telemetryCandidateCount = this.telemetryCandidateCount;
    if (view === undefined) return Promise.resolve(undefined);
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
        readonly worldKey: number;
        readonly primitiveSlot: number;
        readonly slotGeneration: number;
        readonly artifact?: MaterialShaderArtifact;
      };
      const preparedByBatchId = new Map<number, LodBatchAttribution>(
        filtered.batches.map((prepared) => [
          prepared.batch.batchId,
          {
            batch: prepared.batch,
            worldKey: prepared.worldKey,
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
          if (slot === undefined) continue;
          preparedByBatchId.set(batch.batchId, {
            batch,
            worldKey: filteredWorldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId,
            primitiveSlot: slot.slot,
            slotGeneration: slot.generation,
          });
        }
      }
      const worldSelections = new Map<
        number,
        {
          readonly worldKey: number;
          readonly primitiveSlot: number;
          readonly slotGeneration: number;
          candidateCount: number;
          visible: number;
          occluded: number;
          readonly lodHistogram: Map<number, number>;
        }
      >();
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
        let aggregate = worldSelections.get(prepared.worldKey);
        if (aggregate === undefined) {
          aggregate = {
            worldKey: prepared.worldKey,
            primitiveSlot: prepared.batch.members?.at(0)?.primitiveIndex ?? -1,
            slotGeneration: prepared.batch.members?.at(0)?.generation ?? -1,
            candidateCount: 0,
            visible: 0,
            occluded: 0,
            lodHistogram: new Map(),
          };
          worldSelections.set(prepared.worldKey, aggregate);
        }
        aggregate.candidateCount += batchSelection.candidateCount;
        aggregate.visible += batchSelection.visible;
        aggregate.occluded += batchSelection.occluded;
        for (const row of batchSelection.lodHistogram) {
          aggregate.lodHistogram.set(
            row.level,
            (aggregate.lodHistogram.get(row.level) ?? 0) + row.count,
          );
        }
      }
      return {
        ...selection,
        candidateCount: lodCandidateCount > 0 ? lodCandidateCount : projectedCandidateCount,
        visible: lodCandidateCount > 0 ? lodVisible : selection.visible,
        occluded: Math.max(
          0,
          (lodCandidateCount > 0 ? lodCandidateCount : projectedCandidateCount) -
            (lodCandidateCount > 0 ? lodVisible : selection.visible),
        ),
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
            if (slot === undefined) return [];
            const memberId = this.surfaceFrames.memberId(
              slot.worldId,
              slot.entityKey,
              member.drawItemIndex,
              member.instanceOrdinal,
            );
            return memberId === undefined ? [] : [memberId];
          }),
        ),
        worldSelections: Object.freeze(
          [...worldSelections.values()].map((aggregate) =>
            Object.freeze({
              worldKey: aggregate.worldKey,
              primitiveSlot: aggregate.primitiveSlot,
              slotGeneration: aggregate.slotGeneration,
              candidateCount: aggregate.candidateCount,
              visible: aggregate.visible,
              occluded: aggregate.occluded,
              lodHistogram: Object.freeze(
                [...aggregate.lodHistogram.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([level, count]) => Object.freeze({ level, count })),
              ),
            } satisfies GpuDrivenWorldLodSelectionInspection),
          ),
        ),
      };
    });
  }

  /** Bounded counters from a caller-requested submitted-draw observation. */
  recordDrawSummary(summary: GpuDrawSummary): void {
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

  private sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
}
