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
  Result,
  RhiDevice,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialDynamicInputLayout, MaterialRenderState } from '@forgeax/engine-types';
import { isStripTopology } from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  boundGeometryObservationMetadata,
  GEOMETRY_OBSERVATION_MAX_COMMANDS,
  type GeometryObservation,
  unavailableGeometry,
} from '../geometry-observation';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import type {
  GpuDrivenLaneReason,
  GpuDrivenLaneSummary,
  GpuDrivenPreparationFailureInspection,
  GpuDrivenProductionInspection,
  GpuDrivenStructureMetrics,
} from '../inspection-types';
import { reflectedRenderState } from '../material-render-state';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { GpuDrawSummary } from '../record/gpu-draw-receipts';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from '../record/render-context';
import type {
  CameraSnapshot,
  FramePresentationPendingReason,
  RenderRecordPhase,
} from '../render-contract';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import type { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import {
  admitSingleLayerMediumSubmission,
  type SurfaceGpuSubmissionAdmission,
} from '../surface/gpu-driven';
import type { SurfaceSubmissionCandidate } from '../surface/submission-observation';
import { gpuLanePreparesAsynchronously } from './batch-execution';
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
import { EMPTY_GPU_DRAW_SELECTION, type GpuDrawSelection } from './draw-selection';
import { FilteredPlanContributionOwner } from './filtered-plan-contributions';
import {
  type GBufferOrderDiagnosticConfig,
  type GBufferOrderEncodeEvidence,
  gbufferDiagnosticView,
  isGBufferOrderDiagnosticEncode,
  orderGBufferDiagnostic,
} from './gbuffer-order-diagnostic';
import { type LiveRasterBatch, type LiveRasterCache, projectLiveRaster } from './live-raster';
import { type BatchExecutions, prepareHiddenGpuDrivenPipelines } from './material-artifacts';
import {
  type PreparedRasterBundleCache,
  type PreparedRasterCounters,
  type PreparedRasterPass,
  PreparedRasterPassCache,
} from './prepared-raster-bundle';
import { activeFrustum, occlusionCamera, shadowViewClipping } from './production-raster-camera';
import {
  createRasterPipelines,
  type ImportedMeshBuffers,
  importMeshBuffers,
  importSurfaceBuffers,
  isSingleLayerMediumArtifact,
  type ProjectedRasterClass,
  type ProjectedRasterPipelines,
  type RasterPipelineFor,
  type RasterPipelineShape,
  rasterClassFor,
  rasterPipelineShapeKey,
  selectRasterPipeline,
} from './production-raster-classes';
import {
  IndirectPassBindings,
  observeSurfaceDraw,
  observesSurfaceDraws,
  type RasterEncodeCall,
  selectedMaterialSlot,
  visibleWindowsFor,
} from './production-raster-encode';
import {
  type GBufferOrderEvidence,
  type GBufferOrderSources,
  gbufferOrderBatchDepth,
} from './production-raster-gbuffer-order';
import {
  captureGeometrySources,
  type GpuGeometryCapture,
  gbufferGeometryProgram,
} from './production-raster-geometry-capture';
import {
  admittedRasterBatchCount,
  type LodProjectionState,
  lodCoverageMayFade,
  lodProjectionState,
  lodSelectionChangeCount,
  type shadowLodProjectionState,
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
  type PreparedBatch,
  type PreparedProductionPlan,
  patchSuppressedPrimitiveWords,
  suppressedPrimitiveWords,
} from './production-raster-prepare';
import { BatchRowAssembly } from './production-raster-rows';
import {
  createShadowBatchProjection,
  preparedShadowRows,
  publishedShadowProjections,
  restrictShadowCasterChannels,
  retainedShadowOwners,
  retainedShadowProjection,
  type ShadowBatchFacts,
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
  shadowMaterialsChanged,
  shadowMeshesChanged,
  shadowViewLod,
} from './production-raster-shadow';
import {
  observeShadowArtifacts,
  preparationFailureInspection,
  type ShadowArtifactObservations,
  sameEntityKeySet,
} from './production-raster-support';
import { RasterGraphIdentity } from './raster-graph-identity';
import { combineGpuResourceAllocationInspections } from './resource-allocation';
import { preparedAssemblyInputs, samePreparedAssemblyInputs } from './retained-batch-inputs';
import {
  classOwner,
  materialOwner,
  type RetainedPassEncode,
  RetainedRasterEncodes,
  runFacts,
} from './retained-raster-encode';
import { restrictShadowCasterClasses, ShadowCasterClassifier } from './shadow-caster-classes';
import { ShadowProjectionDiffs } from './shadow-projection-diffs';
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
  GpuDrivenView,
  type GpuDrivenViewGraphResources,
  selectGpuLodLane,
} from './view-gpu';

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

/** Active-entity admission of one submission plan; reused while the active set holds. */
interface SubmissionAdmission {
  readonly source: SubmissionPlan;
  readonly sceneCapacity: number;
  readonly activeEntityRevision?: number;
  readonly activeEntityKeys?: ReadonlySet<number>;
  readonly suppressed?: Uint32Array;
  /** The scene rows `suppressed` was derived from, for patching the next admission. */
  readonly slots: PersistentGpuDrivenState['slots'];
  readonly worldKeys: readonly number[] | undefined;
}

/** The main and shadow filtered plans of one prepared plan, with their admission. */
interface FilteredFrame {
  readonly preparedPlan: PreparedProductionPlan;
  readonly lodProjection: LodProjectionState;
  readonly filtered: FilteredProductionPlan;
  readonly admission: SubmissionAdmission;
  readonly shadowFiltered: FilteredProductionPlan | undefined;
}

/** Everything one accepted GPU-lane preparation retains for graph projection and commit. */
interface PreparedRasterFrame {
  readonly input: GpuDrivenPrepareInput;
  readonly scene: PersistentGpuDrivenState;
  readonly materials: GpuSceneResourceFrame;
  readonly materialPipelineState: PipelineState;
  readonly preparedPlan: PreparedProductionPlan;
  readonly lodProjection: LodProjectionState;
  readonly filtered: FilteredProductionPlan;
  readonly shadowFiltered: FilteredProductionPlan | undefined;
  readonly liveRasterBatches: readonly LiveRasterBatch[];
  readonly view: GpuDrivenView;
  readonly shadowViewPool: ShadowViewStatePool;
  readonly materialRaster: MaterialAbiRasterAdapter;
  readonly skinRaster: MaterialAbiRasterAdapter | undefined;
  readonly viewClipping: string;
  readonly viewClippingLive: boolean;
}

/** Attachment facts one graph projection compiles its raster classes against. */
interface RasterGraphTarget {
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly rendererRecording: boolean;
  readonly colorFormats: readonly TextureFormat[];
  readonly colorFormatKey: string | undefined;
}

/** One graph projection: its compiled classes and the late region added afterwards. */
interface ProjectedRasterGraph {
  readonly frame: PreparedRasterFrame;
  readonly target: RasterGraphTarget;
  readonly indirect: GraphBuffer;
  readonly rasterClasses: Map<string, ProjectedRasterClass>;
  lateRegion: { readonly indirectByteOffset: number; readonly visibleBase: number } | undefined;
}

type PipelinePreparationJob = (
  entries: readonly ValidatedRenderable[],
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  onPending?: (reason: FramePresentationPendingReason) => void,
  materials?: import('../scene/material-dispatch').MaterialFrame,
) => boolean;

function hasSurfaceArtifact(input: GpuDrivenPrepareInput): boolean {
  if (input.materialArtifact?.receipt?.surface !== undefined) return true;
  if (input.materialSkinArtifact?.receipt?.surface !== undefined) return true;
  if (input.materialArtifacts === undefined) return false;
  for (const artifact of input.materialArtifacts.values()) {
    if (artifact.receipt?.surface !== undefined) return true;
  }
  return false;
}

function mainPlanPhase(part: 'groups' | 'group-key' | 'batches'): RenderRecordPhase {
  if (part === 'groups') return 'record/gpu-driven-prepare/filter/main-plan/groups';
  if (part === 'group-key') return 'record/gpu-driven-prepare/filter/main-plan/groups/key';
  return 'record/gpu-driven-prepare/filter/main-plan/batches';
}

function shadowPlanPhase(part: 'groups' | 'group-key' | 'batches'): RenderRecordPhase {
  if (part === 'groups') return 'record/gpu-driven-prepare/filter/shadow-plan/groups';
  if (part === 'group-key') return 'record/gpu-driven-prepare/filter/shadow-plan/groups/key';
  return 'record/gpu-driven-prepare/filter/shadow-plan/batches';
}

function sameActiveEntities(admission: SubmissionAdmission, input: GpuDrivenPrepareInput): boolean {
  if (input.activeEntityRevision !== undefined && admission.activeEntityRevision !== undefined)
    return input.activeEntityRevision === admission.activeEntityRevision;
  return sameEntityKeySet(admission.activeEntityKeys, input.activeEntityKeys);
}

function createSubmissionAdmission(
  scene: PersistentGpuDrivenState,
  sceneCapacity: number,
  input: GpuDrivenPrepareInput,
  previous: SubmissionAdmission | undefined,
): SubmissionAdmission {
  const { activeEntityRevision, activeEntityKeys } = input;
  const patched =
    activeEntityKeys === undefined ||
    previous?.activeEntityKeys === undefined ||
    previous.suppressed === undefined
      ? undefined
      : patchSuppressedPrimitiveWords(
          {
            slots: previous.slots,
            worldKeys: previous.worldKeys,
            activeEntityKeys: previous.activeEntityKeys,
            words: previous.suppressed,
          },
          scene.slots,
          scene.worldKeys,
          activeEntityKeys,
          sceneCapacity,
        );
  return {
    source: scene.plan,
    sceneCapacity,
    slots: scene.slots,
    worldKeys: scene.worldKeys,
    ...(activeEntityRevision === undefined ? {} : { activeEntityRevision }),
    ...(activeEntityKeys === undefined
      ? {}
      : {
          activeEntityKeys,
          suppressed:
            patched ??
            suppressedPrimitiveWords(scene.slots, scene.worldKeys, activeEntityKeys, sceneCapacity),
        }),
  };
}

function surfaceArtifactInspection(
  artifact: MaterialShaderArtifact | undefined,
): GpuDrivenProductionInspection['surfaceArtifact'] {
  const receipt = artifact?.receipt;
  if (artifact === undefined || receipt === undefined || receipt.sceneIndexEntry === undefined)
    return undefined;
  return Object.freeze({
    material: artifact.material,
    specializationKey: artifact.specializationKey,
    variantSet: artifact.variantSet,
    layoutIdentity: artifact.layoutIdentity,
    receiptIdentity: receipt.receiptIdentity,
    receiptGeneration: receipt.generation,
    directEntry: receipt.directEntry,
    sceneIndexEntry: receipt.sceneIndexEntry,
  });
}

/**
 * Candidate order is the same address carried in rigid visibleItems.z. The
 * shared GPU Scene owns transforms; this projection carries identity only.
 */
const surfaceRowCache = new WeakMap<
  SubmissionPlan,
  { readonly bases: object; readonly layout: number; readonly rows: Uint32Array }
>();

function surfaceVisibleRows(
  plan: SubmissionPlan,
  scene: PersistentGpuDrivenState,
  visibleSurface: GpuDrivenPrepareInput['visibleSurface'],
): Uint32Array | undefined {
  if (visibleSurface === undefined) return undefined;
  // Rows derive only from the plan and the surface addresses: an unchanged
  // layout reuses the immutable array, so a steady frame does no candidate walk.
  const cached = surfaceRowCache.get(plan);
  if (cached?.bases === visibleSurface.slotBases && cached.layout === visibleSurface.layout)
    return cached.rows;
  const rows = new Uint32Array(plan.candidateCount);
  let row = 0;
  for (const batch of plan.batches) {
    for (const candidate of batch.candidates) {
      const base = visibleSurface.slotBases.get(candidate.primitiveIndex) ?? 0;
      const instanceCount =
        scene.slotAt(candidate.primitiveIndex)?.snapshot.instances?.instanceCount ?? 1;
      rows[row++] =
        base === 0
          ? 0
          : base +
            (batch.binding?.drawItemIndex ?? candidate.drawItemIndex) * instanceCount +
            candidate.instanceOrdinal;
    }
  }
  surfaceRowCache.set(plan, {
    bases: visibleSurface.slotBases,
    layout: visibleSurface.layout,
    rows,
  });
  return rows;
}

function isSkinPreparedBatch({ batch }: PreparedBatch): boolean {
  return batch.prepared?.identity.deformation === 'skin';
}

function rebindRaster(
  raster: MaterialAbiRasterAdapter,
  input: GpuDrivenPrepareInput,
  visibleBuffer: Buffer,
): Result<MaterialAbiRasterAdapter, RhiError> {
  const probe = raster.ensureProbeBlendRecordBuffer(input.probeBlendRecordBuffer);
  if (!probe.ok) return probe;
  const rebound = raster.ensureVisibleBuffer(visibleBuffer);
  if (!rebound.ok) return rebound;
  return ok(raster);
}

function sceneTransformBytes(scene: PersistentGpuDrivenState): number {
  return scene.scene.transformByteLength;
}

function bindSceneTables(
  raster: MaterialAbiRasterAdapter,
  scene: PersistentGpuDrivenState,
  view: GpuDrivenView,
): void {
  const rowCapacity = scene.scene.rowCapacity;
  raster.ensureSceneTables(
    scene.scene.instanceBuffer,
    rowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
    scene.scene.primitiveBuffer,
    rowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
    view.visibleSurfaceRowsBuffer,
    // Only morph rows read the arena; rigid scenes keep their raster groups (and
    // retained bundles) stable when the arena reallocates.
    scene.scene.hasMorphRows ? view.sceneInputBuffer : undefined,
  );
}

function shadowDirectRequired(
  scene: PersistentGpuDrivenState,
  executions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
): boolean {
  if (scene.completeGeometry !== true) return true;
  return scene.plan.batches.some((batch) => {
    const execution =
      batch.binding === undefined ? undefined : executions.get(batch.binding)?.shadow;
    return execution === undefined || execution.route === 'direct';
  });
}

function runPipelinePreparations(
  jobs: ReadonlyMap<string, PipelinePreparationJob>,
  entries: readonly ValidatedRenderable[],
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  onPending: ((reason: FramePresentationPendingReason) => void) | undefined,
  materials: import('../scene/material-dispatch').MaterialFrame | undefined,
): boolean {
  let ready = true;
  for (const prepare of jobs.values())
    if (!prepare(entries, artifacts, onPending, materials)) ready = false;
  return ready;
}

/** One stock encode's retained-run state and the pass identities gating it. */
interface RetainedEncode {
  readonly key: PreparedRasterPass;
  readonly identities: readonly unknown[];
  readonly runs: RetainedPassEncode;
  readonly facts: (owner: object, out: unknown[]) => void;
}

/** End of the contiguous stable-ID block starting at `start`. */
function retainedRunEnd(lives: readonly LiveRasterBatch[], start: number): number {
  const block = Math.floor((lives[start] as LiveRasterBatch).batch.batchId / 32);
  let end = start + 1;
  while (
    end < lives.length &&
    Math.floor((lives[end] as LiveRasterBatch).batch.batchId / 32) === block
  )
    end++;
  return end;
}

function requireLateRegion(
  projected: ProjectedRasterGraph,
): NonNullable<ProjectedRasterGraph['lateRegion']> {
  if (projected.lateRegion === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: 'addLateOcclusion(...) before a late-phase GPU-driven encode',
      hint: 'add the late HZB cull between the early and late geometry passes',
    });
  }
  return projected.lateRegion;
}

/**
 * Scene-index templates read numeric values from GPU Scene. Their retained
 * uniform declaration only satisfies the shared layout; a frame-local material
 * slot must not invalidate those commands. Full-custom programs that
 * reference the uniform retain its offset.
 */
function bindMaterialSlot(
  bindings: IndirectPassBindings,
  batch: ProjectedRasterClass,
  frameResources: GpuDrivenStandardPbrFrameResources,
  globalMaterialSlot: number,
): void {
  const prepared = frameResources.prepareMaterialBinding(globalMaterialSlot);
  if (prepared === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: `material bind group for global slot ${globalMaterialSlot}`,
      hint: 'keep GPU-driven material selection on the main-pass producer contract',
    });
  }
  bindings.observeRunMaterial(globalMaterialSlot, prepared.group, prepared.byteOffset);
  const offset = batch.artifact.program.materialUniformRequired === false ? 0 : prepared.byteOffset;
  bindings.bindMaterial(prepared.group, offset);
}

function shadowViewPass(
  kind: ShadowViewIdentity['kind'],
): 'directional-shadow' | 'point-shadow' | 'spot-shadow' {
  if (kind === 'directional') return 'directional-shadow';
  if (kind === 'point') return 'point-shadow';
  return 'spot-shadow';
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
  private geometryCapture: GpuGeometryCapture | undefined;
  beginGeometryObservation(source: GpuGeometryCapture['source'] | undefined): void {
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
  /** The frame whose live batches are current; stock graphs project new classes from it. */
  private currentRasterFrame: PreparedRasterFrame | undefined;
  /** Stock raster classes projected after their graph compiled. */
  readonly lateRasterClasses = { projected: 0, failed: 0 };
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
  private lodSelectionChanges = 0;
  private lodSelectionBaseline:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly selections: readonly (readonly number[])[];
      }
    | undefined;
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
  ) {}

  static forDevice(
    device: RhiDevice,
    shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ): GpuDrivenProduction {
    return new GpuDrivenProduction(device, shaderModuleFactory);
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
    this.resetFrameObservation(input);
    if (
      input.scene === undefined ||
      (input.hdrp === true && input.clustered !== true) ||
      selectGpuLodLane(this.device.caps) === 'cpu'
    ) {
      this.gpuOwnedEntityCount = 0;
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
    if (input.geometryLane === 'direct' && !hasSurfaceArtifact(input))
      return this.prepareDirectFrame(scene, materials, preparedPlan);
    const filterStage = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter',
      () => this.filterFrame(input, scene, materials, preparedPlan),
    );
    if (filterStage === undefined) {
      this.laneReason = 'unsupported';
      return ok(undefined);
    }
    return this.prepareGpuFrame(input, scene, materials, materialPipelineState, filterStage);
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
    preparedPlan: PreparedProductionPlan,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError> {
    this.gpuOwnedEntityCount = 0;
    this.laneReason = 'unsupported';
    // Main grouping has no shadow claim filter: every admitted draw has
    // a candidate group. Preserve its empty/CPU-only resource fallback.
    if (!preparedPlan.batchRows.some((row) => row.fact !== undefined)) return ok(undefined);
    this.shadowSource = undefined;
    this.shadowScene = undefined;
    this.liveRasterBatches = [];
    this.currentRasterFrame = undefined;
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
      _trackSubmittedWork: (completed) => materials.submit(completed),
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
    const lodProjection = this.observeLodProjection(input, scene, preparedPlan);
    const filtered = this.mainFilteredPlan(input, preparedPlan);
    runRecordProfilePhase(input.profilePhase, 'record/gpu-driven-prepare/filter/counts', () => {
      this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
    });
    const shadowFiltered =
      input.shadowViews === true ? this.shadowFilteredPlan(input, scene, materials) : undefined;
    if (filtered.batches.length === 0 && (shadowFiltered?.batches.length ?? 0) === 0)
      return undefined;
    const admission = this.submissionAdmission(input, scene);
    this.admissionCache = admission;
    return { preparedPlan, lodProjection, filtered, admission, shadowFiltered };
  }

  private observeLodProjection(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    preparedPlan: PreparedProductionPlan,
  ): LodProjectionState {
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
    this.lodSelectionBaseline = { prepared: preparedPlan, selections: lodProjection.selections };
    return lodProjection;
  }

  /**
   * Empty ordinary bindings cannot change a retained prepared plan. Nonempty
   * maps still check their admitted values; raw inputs retain their complete
   * observation fence and custom-get behavior.
   */
  private mainFilteredPlan(
    input: GpuDrivenPrepareInput,
    preparedPlan: PreparedProductionPlan,
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
        ),
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
        ),
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
    const sceneCapacity = scene.scene.rowCapacity;
    const cached = this.admissionCache;
    const matches =
      cached !== undefined &&
      cached.source === scene.plan &&
      cached.sceneCapacity === sceneCapacity &&
      sameActiveEntities(cached, input);
    return runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter/admission',
      () => (matches ? cached : createSubmissionAdmission(scene, sceneCapacity, input, cached)),
    );
  }

  private prepareGpuFrame(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    materials: GpuSceneResourceFrame,
    materialPipelineState: PipelineState,
    { preparedPlan, lodProjection, filtered, admission, shadowFiltered }: FilteredFrame,
  ): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    const surfaceArtifact = filtered.materialBatches.find(({ artifact }) =>
      isSingleLayerMediumArtifact(artifact),
    )?.artifact;
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
        lodProjection,
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
    const updated = view.update(
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

  /** Frame rows are keyed by GPU Scene instance row and bound whole by both adapters. */
  private prepareSurfaceInput(
    input: GpuDrivenPrepareInput,
    scene: PersistentGpuDrivenState,
    filtered: FilteredProductionPlan,
    materialRaster: MaterialAbiRasterAdapter,
    skinRaster: MaterialAbiRasterAdapter | undefined,
    layout: MaterialDynamicInputLayout | undefined,
  ): Result<void, RhiError> {
    const projection = this.surfaceFrames.resolve(filtered, input.surfaceDynamicInput, scene);
    if (!projection.ok) return projection;
    const capacity = Math.max(scene.scene.rowCapacity, projection.value.capacity);
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
      );
      if (!skinSurfaceInput.ok) return skinSurfaceInput;
    }
    const committed = materialRaster.commitSurfaceDynamicInput();
    if (!committed.ok) return committed;
    if (skinRaster !== undefined) {
      const skinCommitted = skinRaster.commitSurfaceDynamicInput();
      if (!skinCommitted.ok) return skinCommitted;
    }
    this.surfaceFrames.remember(filtered, input.surfaceDynamicInput, scene, projection.value);
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
  private publishGpuFrame(frame: PreparedRasterFrame): PreparedGpuDrivenFrame {
    this.currentRasterFrame = frame;
    const { input, scene, materials, filtered, view, shadowViewPool, materialRaster, skinRaster } =
      frame;
    const viewInspection = view.inspect();
    // The graph imports scene and view buffers live, so neither a replaced
    // material table nor grown view storage is a graph dependency: key the
    // raster graph on the view's pass-list generation only.
    const graphIdentity = this.rasterGraphIdentity.update(
      filtered,
      this.sceneIdentity(scene.scene),
      { ...viewInspection, resourceGeneration: view.graphResourceGeneration },
      frame.liveRasterBatches,
      materialRaster.visibleBindingIdentity,
      skinRaster?.visibleBindingIdentity,
    );
    const discardSignature = frame.viewClippingLive ? '|view-clipping' : '';
    const signature = `gpu:${getOpaqueResourceIdentity(graphIdentity.raw)}${discardSignature}`;
    const recordingSignature = `gpu:${getOpaqueResourceIdentity(graphIdentity.recording)}${discardSignature}`;
    const production = this;
    const surfaceSubmission = this.surfaceSubmission;
    const consumeSurfaceDynamicInput =
      surfaceSubmission === undefined
        ? undefined
        : this.surfaceFrames.consumer(input.surfaceDynamicInput);
    return {
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
        const shadow = production.shadowTopologySignature();
        return shadow.length === 0 ? signature : `${signature}|shadow=${shadow}`;
      },
      get _recordingTopologySignature() {
        const shadow = production.shadowTopologySignature();
        return shadow.length === 0 ? recordingSignature : `${recordingSignature}|shadow=${shadow}`;
      },
      worldKeys: scene.worldKeys ?? [],
      selection: filtered.selection,
      shadowDirectRequired: shadowDirectRequired(scene, input.batchExecutions),
      ...(surfaceSubmission === undefined ? {} : { surfaceSubmission }),
      standardPbrFrameResources: {
        resourceGeneration: viewInspection.resourceGeneration,
        prepareMaterialBinding: () => undefined,
        materialSlotIndicesByBinding: new Map(),
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
        this.lastKnownGoodGeneration = view.inspect().resourceGeneration;
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
        return shadowViewPool.project(graph, identity, forceCompute, cameraPyramid);
      },
      updateShadowViews: (views) => this.updateFrameShadowViews(frame, views),
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
    return (
      this.shadowViews
        ?.inspect()
        .map((entry) => `${shadowViewIdentityKey(entry.identity)}:${entry.graphGeneration}`)
        .join('|') ?? ''
    );
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
  ): Result<void, RhiError> {
    const { shadowFiltered, input } = frame;
    if (shadowFiltered === undefined || views.length === 0) return this.disableShadowViews();
    return this.updateShadowViews(
      views,
      shadowFiltered,
      input.batchExecutions,
      frame.scene,
      frame.materials.inputReads(),
      frame.lodProjection,
      frame.preparedPlan,
      input.camera,
      input.capsuleShadowDirectional === true,
      input.materialFrame,
      input.shadowMaterials,
      input.profilePhase,
    );
  }

  /** Graph-time projection: import buffers, compile raster classes, expose encode. */
  private projectGraph(
    frame: PreparedRasterFrame,
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
    graph: RenderGraphBuilder<RenderPipelineFrame>,
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
      const classKey = target.rendererRecording ? live?.recordingClassKey : live?.classKey;
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
    }
    if (target.rendererRecording) this.rasterGraphIdentity.built(rasterClasses.keys());
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
  ): ProjectedRasterClass | undefined {
    if (
      projected.target.rendererRecording &&
      live.batch.visibleCapacity !== 0 &&
      !projected.rasterClasses.has(live.recordingClassKey) &&
      !this.projectLateRasterClass(projected, live)
    )
      return undefined;
    return rasterClassFor(
      projected.rasterClasses,
      projected.target.rendererRecording,
      live,
      filter,
      fragmentEntryPoint,
    );
  }

  private projectLateRasterClass(projected: ProjectedRasterGraph, live: LiveRasterBatch): boolean {
    const frame = this.currentRasterFrame;
    const index = frame?.liveRasterBatches.indexOf(live) ?? -1;
    const prepared = index < 0 ? undefined : frame?.filtered.batches[index];
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
    const meshBindGroup = raster.sceneMeshBindGroup(
      frame.scene.scene.transformBuffer,
      sceneTransformBytes(frame.scene),
      frame.view.skinTaskBinding(),
    );
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
    return ok({
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
    });
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
    return {
      raster,
      prepared,
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
      renderState: recording ? prepared.renderState : undefined,
      standardTextureMask: recording ? prepared.standardTextureMask : undefined,
      preparationFactory: frame.input.materialPipelinePreparationFactory,
      visibleSurface: frame.input.visibleSurface !== undefined,
    };
  }

  /** The renderer-facing projection contract over one compiled raster class set. */
  private rasterProjection(
    projected: ProjectedRasterGraph,
    accesses: readonly GraphAccess[],
    outputs: GpuDrivenViewGraphResources,
  ): RenderPipelineGpuDrivenProjection {
    const preparationFactory = projected.frame.input.materialPipelinePreparationFactory;
    const preparationJobs = new Map<string, PipelinePreparationJob>();
    return {
      accesses,
      ...(projected.target.rendererRecording && preparationFactory !== undefined
        ? {
            registerPipelinePreparation: (
              formats,
              filter,
              fragmentEntryPoint,
              coverageOnly = false,
            ) =>
              this.registerPipelinePreparation(
                projected,
                preparationJobs,
                preparationFactory,
                formats,
                filter,
                fragmentEntryPoint,
                coverageOnly,
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
        ),
    };
  }

  /** Register the real PSOs one graph pass will bind, without drawing or culling. */
  private registerPipelinePreparation(
    projected: ProjectedRasterGraph,
    jobs: Map<string, PipelinePreparationJob>,
    factory: MaterialPipelineFactory,
    formats: readonly TextureFormat[],
    filter: RenderPipelineGpuDrivenFilter | undefined,
    fragmentEntryPoint: string | undefined,
    coverageOnly: boolean,
  ): void {
    const key = JSON.stringify([formats, filter, fragmentEntryPoint, coverageOnly]);
    if (jobs.has(key)) return;
    // Classes may join a compiled stock graph; select pipelines from the
    // current live batches whenever that set is replaced.
    let selectedFor: readonly LiveRasterBatch[] | undefined;
    const selected = new Map<RasterPipelineFor, MaterialShaderArtifact>();
    const select = () => {
      if (selectedFor === this.liveRasterBatches) return;
      selectedFor = this.liveRasterBatches;
      selected.clear();
      for (const live of this.liveRasterBatches) {
        const batch = this.classFor(projected, live, filter, fragmentEntryPoint);
        if (batch !== undefined)
          selected.set(
            selectRasterPipeline(batch, fragmentEntryPoint, coverageOnly),
            batch.artifact,
          );
      }
    };
    select();
    const { frame, target } = projected;
    const ownedFormats = [...formats];
    const formatKey = ownedFormats.join(',');
    jobs.set(key, (entries, artifacts, onPending, materials) => {
      select();
      let ready = true;
      for (const [pipelineFor, artifact] of selected)
        if (!pipelineFor(ownedFormats, formatKey, gpuLanePreparesAsynchronously(artifact)).ok) {
          ready = false;
          onPending?.({
            code: 'scene-pipeline-preparation',
            pass: (fragmentEntryPoint ?? filter ?? 'forward').slice(0, 256),
            shader: artifact.material.slice(0, 256),
          });
        }
      if (
        !prepareHiddenGpuDrivenPipelines({
          entries,
          artifacts,
          materials,
          resolve: frame.input.materialArtifactResolver,
          factory,
          formats: ownedFormats,
          sampleCount: target.sampleCount,
          shaderUvSetCount: frame.materialPipelineState.standardPbrShaderUvSetCount,
          filter,
          fragmentEntry: fragmentEntryPoint,
          coverageOnly,
          visibleSurface: frame.input.visibleSurface !== undefined,
          viewClipping: frame.viewClippingLive,
          ...(onPending === undefined ? {} : { onPending }),
        })
      )
        ready = false;
      return ready;
    });
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
            `${filter ?? ''}/${fragmentEntryPoint ?? ''}/${coverageOnly ? 1 : 0}/${phase}`,
            descriptor,
          );
    const bindings = new IndirectPassBindings(pass, viewBindGroup, descriptor, bundlePass);
    if (descriptor === undefined) pass.setBindGroup(0, viewBindGroup, [0, 0]);
    const colorFormats = frameResources.colorFormats ?? target.colorFormats;
    const call: RasterEncodeCall = {
      resources,
      frameResources,
      filter,
      fragmentEntryPoint,
      coverageOnly,
      phase,
      colorFormats,
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
      this.retainedEncodes.finish(retained.key, retained.identities, retained.runs);
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
    const { frameResources, fragmentEntryPoint, coverageOnly, colorFormats, formatKey } = call;
    if (
      !projected.target.rendererRecording ||
      bindings.direct ||
      bundlePass === undefined ||
      this.geometryCapture !== undefined
    )
      return undefined;
    const { scene } = projected.frame;
    const indirect = call.resources.buffer(projected.indirect);
    const slotsByBinding = frameResources.materialSlotIndicesByBinding;
    const identities = [
      viewBindGroup,
      slotsByBinding.size === 0,
      indirect.ok ? indirect.value : undefined,
      call.regionOffset,
      call.visibleRegionBase,
      formatKey,
      projected.rasterClasses,
      scene.scene.transformBuffer,
      sceneTransformBytes(scene),
    ];
    const runs = this.retainedEncodes.begin(
      bundlePass,
      identities,
      (slot) => materialOwner(frameResources.prepareMaterialBinding(slot)),
      (cls) =>
        classOwner(
          selectRasterPipeline(
            cls as ProjectedRasterClass,
            fragmentEntryPoint,
            coverageOnly,
          )(colorFormats, formatKey),
          this.resolveMeshGroup(projected, call, bindings, cls as ProjectedRasterClass),
        ),
    );
    const facts = runFacts(
      (live) =>
        this.classFor(projected, live as LiveRasterBatch, call.filter, fragmentEntryPoint) !==
        undefined,
      slotsByBinding,
      frameResources.selectedMaterialSlots,
    );
    return { key: bundlePass, identities, runs, facts };
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
      const end = retainedRunEnd(lives, start);
      bindings.startRun();
      const reused = retained.runs.reuse(lives, start, end, retained.facts);
      if (reused !== undefined) {
        bindings.replayRun(reused, this.preparedBundleCounters);
        this.encodedIndirectDraws += reused.draws;
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
        this.classFor(projected, live, filter, fragmentEntryPoint),
        rasterClasses.get(rendererRecording ? live.recordingClassKey : live.classKey),
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
    const batch = this.classFor(projected, live, call.filter, call.fragmentEntryPoint);
    if (batch === undefined) return;
    const globalMaterialSlot = selectedMaterialSlot(live, frameResources);
    if (globalMaterialSlot === undefined) return;
    const selectedPipeline = selectRasterPipeline(
      batch,
      call.fragmentEntryPoint,
      call.coverageOnly,
    )(call.colorFormats, call.formatKey);
    if (!selectedPipeline.ok) throw selectedPipeline.error;
    bindings.bindPipeline(selectedPipeline.value);
    bindMaterialSlot(bindings, batch, frameResources, globalMaterialSlot);
    const group2 = this.meshGroupFor(projected, call, bindings, batch);
    bindings.observeRunClass(batch, selectedPipeline.value, group2);
    bindings.bindMesh(group2, batch.deformation, frame.view);
    if (target.rendererRecording)
      bindings.bindRecordedGeometry(live.meshBinding, live.mesh.indexFormat);
    else
      bindings.bindGraphGeometry(batch.vertex, batch.index, batch.mesh.indexFormat, call.resources);
    if (!bindings.hasIndirect) {
      const indirect = call.resources.buffer(projected.indirect);
      if (!indirect.ok) throw indirect.error;
      bindings.indirect = indirect.value;
    }
    const windows = visibleWindowsFor(live, batch, call);
    this.encodeLevels(projected, call, bindings, live, batch, windows);
    bindings.recordBundle(
      live,
      windows,
      call.regionOffset + live.batch.indirectOffset,
      frame.view,
      this.device,
      this.preparedBundleCounters,
    );
  }

  /**
   * Every rigid cluster draw reads this projection's whole scene table and
   * this encode's lighting. Stock recording resolves it on first use; skin
   * palettes and pipeline-transition rebinding stay separate.
   */
  private meshGroupFor(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    batch: ProjectedRasterClass,
  ): BindGroup {
    const group2 = this.resolveMeshGroup(projected, call, bindings, batch);
    if (group2 === undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'clustered Standard group(2) BindGroup for GPU-driven batch',
        hint: 'publish the frame-owned cluster lighting resources before indirect encode',
      });
    }
    return group2;
  }

  private resolveMeshGroup(
    projected: ProjectedRasterGraph,
    call: RasterEncodeCall,
    bindings: IndirectPassBindings,
    batch: ProjectedRasterClass,
  ): BindGroup | undefined {
    const { scene, view } = projected.frame;
    const transformBytes = sceneTransformBytes(scene);
    if (projected.target.rendererRecording && batch.clustered && batch.deformation === 'rigid') {
      bindings.rigidClusterGroup ??= call.frameResources.clusterBindGroupForMesh?.(
        scene.scene.transformBuffer,
        transformBytes,
      );
      return bindings.rigidClusterGroup;
    }
    // The compiled class keeps its first mesh group; the Skin task buffers it
    // binds belong to the view and may have grown since, so resolve the
    // current group (cached per physical buffer set) for every encode.
    const raster =
      batch.deformation === 'skin' ? projected.frame.skinRaster : projected.frame.materialRaster;
    const current = batch.clustered
      ? undefined
      : raster?.sceneMeshBindGroup(
          scene.scene.transformBuffer,
          transformBytes,
          view.skinTaskBinding(),
        );
    return resolveGpuDrivenMeshGroup({
      clustered: batch.clustered,
      deformation: batch.deformation,
      meshBindGroup: current?.ok === true ? current.value : batch.meshBindGroup,
      sceneTransformBuffer: scene.scene.transformBuffer,
      sceneTransformBytes: transformBytes,
      frameResources: call.frameResources,
      skinTaskBinding: view.skinTaskBinding(),
    });
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
    const previous = preparation.cached;
    const sameInputs =
      previous !== undefined &&
      previous.worldKeys === scene.worldKeys &&
      previous.scene === scene.scene;
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
    const assembly = new BatchRowAssembly(
      preparation,
      pass,
      scene,
      materials,
      batchExecutions,
      meshByBinding,
      sameInputs,
    );
    const batchRows = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/plan/rows',
      () => assembly.assemble(),
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
    this.preparedBatchBuilds += assembly.rebuiltBatches;
    this.planRebuildBatches += assembly.rebuiltBatches;
    this.planRebuildCandidates = 0;
    // A failed artifact publication cannot admit filtered or GPU work.
    if (assembly.missingArtifact !== undefined) return err(assembly.missingArtifact);
    const { sameRows, fixedMembership, serializedStates } = assembly;
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
    const meshBinding = materialRaster.sceneMeshBindGroup(
      scene.scene.transformBuffer,
      sceneTransformBytes(scene),
    );
    if (!meshBinding.ok) return meshBinding;
    const pass: ShadowProjectionPass = {
      filtered,
      executions: batchExecutions,
      artifacts,
      diffs,
      scene,
      pool: shadowViews,
      sourcePlan: shadowSource.plan,
      projectionSource: shadowSource.projectionSource,
      shadowScene,
      inputReads,
      lod,
      lodPrepared,
      camera,
      capsuleShadowDirectional,
      directMaterials,
      shadowMaterials,
      profilePhase,
      materialRaster,
      meshBinding: meshBinding.value,
      visibleBindingIdentity: materialRaster.visibleBindingIdentity,
      skinVisibleBindingIdentity: this.skinRaster?.visibleBindingIdentity,
      lodByMatrix: new Map(),
      cullCamera: undefined,
      preparedByBatch: undefined,
      next: new Map(),
    };
    const classes = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/shadow-views/caster-classes',
      () => this.shadowCasterClasses.update(scene, shadowScene),
    );
    const retained: ShadowViewIdentity[] = [];
    for (const requested of views) {
      const projected = this.projectRequestedShadowView(pass, requested, classes, retained);
      if (!projected.ok) return projected;
    }
    this.shadowChannelSlots.retainRequested();
    shadowViews.retain(retained);
    this.shadowBatchProjections = publishReadonlyMap(pass.next);
    return ok(undefined);
  }

  /** One requested view projects as a single final layer or a static/final pair. */
  private projectRequestedShadowView(
    pass: ShadowProjectionPass,
    requested: ShadowViewRequest,
    classes: ReturnType<ShadowCasterClassifier['update']>,
    retained: ShadowViewIdentity[],
  ): Result<void, RhiError> {
    const input = restrictShadowCasterChannels(requested, this.shadowChannelSlots, pass);
    retained.push(input.identity);
    if (!shadowViewHasStaticLayer(input.identity)) return this.projectShadowView(pass, input);
    const staticIdentity: ShadowViewIdentity = { ...input.identity, layer: 'static' };
    const viewClasses = restrictShadowCasterClasses(classes, input.candidatePrimitiveIndices);
    const singleLayer = input.staticLayer === false;
    this.syncShadowLayerMode(pass.pool, input.identity, staticIdentity, singleLayer);
    if (singleLayer) {
      // Settled casters draw with the rest every time the view rasters;
      // capsule casters leave directional views on the GPU as in two layers.
      return this.projectShadowView(pass, {
        ...input,
        candidatePrimitiveIndices: viewClasses.casterSlots,
      });
    }
    // The static layer holds settled casters and is re-rastered only when one
    // of them changes; the final layer copies it and adds the rest.
    retained.push(staticIdentity);
    const staticProjected = this.projectShadowViewCache(pass, {
      ...input,
      identity: staticIdentity,
      candidatePrimitiveIndices: viewClasses.staticSlots,
      ignoredChangeSlots: classes.dynamicSlots,
    });
    if (!staticProjected.ok) return staticProjected;
    if (staticProjected.value === 'invalidated') {
      pass.pool.invalidate('static-layer-changed', input.identity);
    }
    return this.projectShadowView(pass, {
      ...input,
      candidatePrimitiveIndices: viewClasses.dynamicSlots,
    });
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
    { cameraCull, staticLayer: _staticLayer, ...input }: ShadowViewRequest,
  ): Result<ShadowViewUpdate['cache'], RhiError> {
    return runRecordProfilePhase(
      pass.profilePhase,
      'record/gpu-driven-prepare/shadow-views/project-view',
      () => this.projectShadowViewBatches(pass, input, cameraCull),
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
    const skinMeshBinding = this.shadowSkinMeshBinding(pass, submission.view);
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
    const viewLod = shadowViewLod(pass, input.matrix);
    if (cameraCull !== undefined) pass.cullCamera ??= occlusionCamera(pass.camera);
    const cullCamera = pass.cullCamera;
    const { directMaterials, shadowMaterials } = pass;
    return runRecordProfilePhase(
      pass.profilePhase,
      'record/gpu-driven-prepare/shadow-views/project-view/cache-update',
      () =>
        pass.pool.update(
          {
            ...input,
            sourcePlan: pass.sourcePlan,
            scene: pass.shadowScene,
            inputReads: pass.inputReads,
            skin: pass.scene.skin,
            capsuleDirectional:
              pass.capsuleShadowDirectional && input.identity.kind === 'directional',
            ...(directMaterials === undefined || input.identity.layer === 'static'
              ? {}
              : { directMaterials }),
            ...(shadowMaterials === undefined ? {} : { shadowMaterials }),
            ...viewLod,
            ...(cameraCull === undefined || cullCamera === undefined
              ? {}
              : { cameraCull: { ...cameraCull, camera: cullCamera } }),
          },
          pass.projectionSource,
        ),
    );
  }

  private shadowSkinMeshBinding(
    pass: ShadowProjectionPass,
    view: GpuDrivenView,
  ): Result<BindGroup, RhiError> | undefined {
    const skinTask = view.skinTaskBinding();
    if (skinTask === undefined) return undefined;
    return this.skinRaster?.sceneMeshBindGroup(
      pass.scene.scene.transformBuffer,
      sceneTransformBytes(pass.scene),
      skinTask,
    );
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
      const facts = this.shadowBatchFacts(pass, batch, viewBindings);
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
      const created = createShadowBatchProjection(
        batch,
        facts.value,
        viewBindings.visibleBuffer,
        previousProjection,
      );
      if (!created.ok) return created;
      projections ??= new Map(previousProjections);
      projections.set(batch.batchId, created.value);
    }
    return ok(projections);
  }

  /** The physical draw facts a GPU shadow batch would project in this view. */
  private shadowBatchFacts(
    pass: ShadowProjectionPass,
    batch: GpuDrivenBatch,
    viewBindings: ShadowViewBindings,
  ): Result<ShadowBatchFacts, RhiError> {
    const prepared = preparedShadowRows(pass).get(batch.batchId);
    if (prepared === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: `prepared shadow mesh batch ${batch.batchId}`,
          hint: 'keep filtered shadow topology and per-view projection on one frame identity',
        }),
      );
    }
    const binding = batch.binding;
    const execution = binding === undefined ? undefined : pass.executions.get(binding)?.shadow;
    if (binding === undefined || execution?.route !== 'gpu') {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: `accepted shared material execution for shadow batch ${batch.batchId}`,
          hint: 'retain the same geometry binding and material frame through shadow projection',
        }),
      );
    }
    const deformation = batch.prepared?.identity.deformation ?? 'rigid';
    const skin = deformation === 'skin';
    const raster = skin ? this.skinRaster : pass.materialRaster;
    const meshBindGroup = skin ? viewBindings.skinMeshBinding : viewBindings.meshBinding;
    const shadowArtifact = execution.artifact;
    if (
      raster === undefined ||
      meshBindGroup === undefined ||
      prepared.artifact === undefined ||
      shadowArtifact === undefined
    ) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `${skin ? 'skinned ' : ''}selected shadow MaterialProgramAbi artifact`,
          hint: 'publish a matching shadow-pass program before entering the capable shadow lane',
        }),
      );
    }
    return ok({
      raster,
      mesh: prepared.mesh,
      meshContentEpoch: prepared.meshContentEpoch,
      meshBindGroup,
      deformation,
      shadowArtifact,
      shadowRenderState: reflectedRenderState(
        execution.pass.renderState,
        batch.key.reflected === true,
      ),
      shadowEntry: execution.pass,
      material: execution.material,
      worldId: binding.worldId,
    });
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
    this.currentRasterFrame = undefined;
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
    this.settleDrawSummary();
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
      lodSelectionChanges: this.lodSelectionChanges,
      shadowCasterFlips: this.shadowCasterClasses.inspect().flips,
      shadowCasterClassification: this.shadowCasterClasses.inspect(),
      shadowViews: this.shadowViews?.inspect() ?? [],
      shadowCasterPendingPromotions: this.shadowCasterClasses.inspect().pendingPromotions,
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
    for (const entry of this.shadowViews?.inspect() ?? []) {
      if (this.submissionState === 'idle' || channels.length >= 32) break;
      if (entry.identity.layer !== undefined) continue;
      let total = 0;
      let claimed = 0;
      for (const identity of [entry.identity, { ...entry.identity, layer: 'static' as const }])
        for (const batch of this.shadowViews?.submission(identity)?.plan.batches ?? []) {
          total += batch.candidates.length;
          if (batch.visibleCapacity > 0) claimed += batch.candidates.length;
        }
      if (total === 0) continue;
      this.pushShadowLaneChannels(channels, entry.identity, total, claimed);
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
          if (slot === undefined || slot.generation !== candidate?.generation) continue;
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
            // A slot reused after the copy was encoded is another row.
            if (slot === undefined || slot.generation !== member.generation) return [];
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

  private sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
}
