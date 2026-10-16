import {
  type GpuDrivenResidencyValidationInput,
  ResidencyValidationOwner,
} from '../record/residency-validation-owner';
import { prepareHiddenGpuDrivenPipelines } from './pipeline-preparation';
import { RasterGraphIdentity } from './raster-graph-identity';

export type { GpuDrivenResidencyValidationInput } from '../record/residency-validation-owner';

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
  gpuDrivenDrawKey,
  gpuDrivenMaterialArtifactKey,
  gpuDrivenSourceDrawItemIndex,
} from '../extract/gpu-driven';
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
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  SKIN_UNCOVERED_GBUFFER_ENTRY,
} from '../pbr-pipeline';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { getOpaqueResourceIdentity, worldEntityKey } from '../record/frame-snapshot';
import type { GpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import {
  MATERIAL_PER_ENTITY_STRIDE,
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { CameraSnapshot } from '../render-contract';
import type {
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type {
  GpuDrivenDrawSnapshot,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type {
  DynamicInputRange,
  ReadonlyDynamicInputPage,
  SurfaceDynamicInputFrame,
} from '../surface/dynamic-input';
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
  type GpuDrivenBatch,
  inspectResourceClassSplits,
  type SubmissionPlan,
} from './batch-topology';
import { FilteredPlanContributionOwner } from './filtered-plan-contributions';
import type { LodViewCamera } from './lod-projection.wgsl';
import { materialBindingSignature } from './material-bindings';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
} from './prepared-raster-bundle';
import {
  type GpuDrivenCpuValidationTelemetryCache,
  sameValidatedSourceSequence,
} from './production-cpu-validation';
import { activeFrustum, occlusionCamera, shadowViewClipping } from './production-raster-camera';
import {
  admittedRasterBatchCount,
  gpuDrawEntityCount,
  type LodProjectionState,
  lodProjectionState,
  lodSelectionChangeCount,
  lodViewCameraFromMatrix,
  shadowLodProjectionState,
} from './production-raster-lod';
import { MaterialAbiRasterAdapter, resolveGpuDrivenMeshGroup } from './production-raster-material';
import {
  artifactForPreparedBatch,
  assemblePreparedPlan,
  EMPTY_SHADOW_KEYS,
  type FilteredProductionPlan,
  ownsAllAdmittedDrawItems,
  type PreparationInputs,
  type PreparedBatch,
  type PreparedBatchRows,
  type PreparedProductionPlan,
  prepareBatchRows,
  type ShadowOwnershipSource,
  sameBatchMeshes,
  sameMaterialArtifact,
  shadowArtifactForPreparedBatch,
  shadowArtifactSignature,
  skinLaneReason,
  suppressedPrimitiveWords,
} from './production-raster-prepare';
import { type RasterMeshBinding, RasterMeshBindings } from './raster-mesh-bindings';
import { combineGpuResourceAllocationInspections } from './resource-allocation';
import { restrictShadowCasterClasses, ShadowCasterClassifier } from './shadow-caster-classes';
import { ShadowClaimTable } from './shadow-claims';
import { publishReadonlyMap, sameShadowProjectionLayout } from './shadow-projection-publication';
import { collectShadowViewClaims } from './shadow-view-claims';
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

export interface GpuDrivenShadowBatchProjection {
  /** Batch-owned command closure; retained projection edits validate its physical inputs. */
  readonly bundles: PreparedRasterBundleCache;
  readonly mesh: MeshGpuHandles;
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
  /** Composite entity identity used only for video-resource routing. */
  readonly materialEntityKey: number;
  /** Geometry-owned COLOR_0 fact shared by main and shadow ABI variants. */
  readonly vertexColorAvailable: boolean;
}

/**
 * Renderer-owned join between the scene-index candidate rows and a Surface
 * producer range. The user-facing range keeps its formal instance address;
 * the frame row is assigned after the RenderScene plan has been filtered and
 * its visible bases are known.
 */
interface SurfaceFrameRange {
  readonly frameIndex: number;
  readonly range?: DynamicInputRange;
  readonly directMember: {
    readonly worldIdentity: string;
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

interface SurfaceFrameProjection {
  readonly ranges: readonly SurfaceFrameRange[];
  readonly consumptionRanges: readonly DynamicInputRange[];
  readonly capacity: number;
}

function surfaceDynamicInputError(expected: string, hint: string): RhiError {
  return new RhiError({ code: 'rhi-descriptor-invalid', expected, hint });
}

/**
 * A shadow view the frame asks for. Its camera cull names only the receiver
 * dilation; the main camera it tests against is the one the pyramid was built
 * from, attached here so the two cannot diverge.
 */
export type ShadowViewRequest = Omit<
  ShadowViewUpdateInput,
  'sourcePlan' | 'scene' | 'cameraCull'
> & {
  readonly cameraCull?: ShadowCameraCullDilation;
};

function isSingleLayerMediumArtifact(artifact: MaterialShaderArtifact): boolean {
  return artifact.receipt?.surface?.model === 'single-layer-medium';
}

/**
 * Join Surface ranges to the renderer-owned candidate rows in the visible
 * stream. The GPU culler may assign atomic compact slots in any order, but
 * each rigid member carries its view candidate row in `visibleItems.z`; frame
 * rows are keyed by that row rather than by the compact slot or the GPU Scene
 * instance row, which submeshes of one instance share. The producer's
 * `instanceIndex` remains in the range and is copied into the frame record
 * for the Surface ABI.
 */
function buildSurfaceFrameRanges(
  filtered: FilteredProductionPlan,
  ranges: readonly DynamicInputRange[],
  scene: PersistentGpuDrivenState,
): Result<readonly SurfaceFrameRange[], RhiError> {
  const surfaceMembers: Array<{
    readonly frameIndex: number;
    readonly identity: string;
    readonly directMember: SurfaceFrameRange['directMember'];
  }> = [];
  // Candidate rows follow the encoded plan: batches in order, then candidates.
  let candidateRow = 0;
  for (const prepared of filtered.batches) {
    const firstRow = candidateRow;
    candidateRow += prepared.batch.candidates.length;
    if (!isSingleLayerMediumArtifact(prepared.artifact)) continue;
    for (const [index, candidate] of prepared.batch.candidates.entries()) {
      const slot = scene.slotAt(candidate.primitiveIndex);
      const worldIdentity = slot === undefined ? undefined : scene.worldIdentities?.[slot.worldId];
      const frameIndex = firstRow + index;
      if (slot === undefined || worldIdentity === undefined) {
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected:
              'every admitted medium draw member has a renderer slot and public World identity',
            hint: `rebuild the persistent scene projection before publishing Surface ranges (primitive=${candidate.primitiveIndex})`,
          }),
        );
      }
      surfaceMembers.push({
        frameIndex,
        directMember: {
          worldIdentity,
          worldId: slot.worldId,
          entityKey: slot.entityKey,
          drawItemIndex: candidate.drawItemIndex,
          instanceOrdinal: candidate.instanceOrdinal,
        },
        identity: JSON.stringify([
          worldIdentity,
          slot.entityKey,
          candidate.drawItemIndex,
          candidate.instanceOrdinal,
        ]),
      });
    }
  }
  if (ranges.length === 0) {
    return ok(
      Object.freeze(
        surfaceMembers.map(({ frameIndex, directMember }) => ({ frameIndex, directMember })),
      ),
    );
  }
  const rangeByIdentity = new Map<string, DynamicInputRange>();
  for (const range of ranges) {
    const identity = JSON.stringify([
      range.member.worldIdentity,
      range.member.entityKey,
      range.member.drawItemIndex,
      range.member.instanceOrdinal,
    ]);
    if (rangeByIdentity.has(identity)) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'at most one Surface dynamic range for each stable draw member',
          hint: `remove the duplicate producer range for member ${identity}`,
        }),
      );
    }
    rangeByIdentity.set(identity, range);
  }
  if (ranges.length !== surfaceMembers.length) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'one stable-identity Surface dynamic range for every admitted medium draw member',
        hint: `publish one range per admitted Surface member (ranges=${ranges.length}, members=${surfaceMembers.length})`,
      }),
    );
  }
  const frameRanges: SurfaceFrameRange[] = [];
  for (const member of surfaceMembers) {
    const range = rangeByIdentity.get(member.identity);
    if (range === undefined) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'every admitted medium draw member resolves one stable-identity Surface range',
          hint: `publish the missing producer range for member ${member.identity}`,
        }),
      );
    }
    rangeByIdentity.delete(member.identity);
    frameRanges.push({ frameIndex: member.frameIndex, range, directMember: member.directMember });
  }
  if (rangeByIdentity.size !== 0) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'every Surface range identifies an admitted medium draw member',
        hint: `remove ranges for non-admitted members: ${[...rangeByIdentity.keys()].join(', ')}`,
      }),
    );
  }
  return ok(Object.freeze(frameRanges));
}

function sceneRequiresGpuDrivenArtifact(scene: PersistentGpuDrivenState): boolean {
  return scene.plan.batches.some(
    (batch) =>
      batch.candidates.length > 0 &&
      batch.prepared?.receiptIdentity !== undefined &&
      (batch.prepared.identity.deformation === 'rigid' ||
        batch.prepared.identity.deformation === 'skin'),
  );
}

function nonCpuPreparationFailure(
  scene: PersistentGpuDrivenState,
): { readonly error: GpuDrivenPreparationError; readonly drawKeys: readonly string[] } | undefined {
  const drawKeys: string[] = [];
  let first: GpuDrivenPreparationError | undefined;
  for (const slot of scene.slots) {
    const draws = slot.snapshot.gpuDrivenDraws ?? [];
    for (const [compactIndex, draw] of draws.entries()) {
      const error = draw.preparationError;
      if (error === undefined || error.detail.recovery === 'route-cpu-lane') continue;
      const material = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
      drawKeys.push(
        gpuDrivenDrawKey(
          worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey),
          material.materialHandle ?? -1,
          gpuDrivenSourceDrawItemIndex(draw, compactIndex),
        ),
      );
      first ??= error;
    }
  }
  return first === undefined ? undefined : { error: first, drawKeys };
}

function preparationFailureInspection(
  error: GpuDrivenPreparationError,
): GpuDrivenPreparationFailureInspection {
  return Object.freeze({
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  });
}

function shadowOwnershipFailureInspection(
  viewPass: GpuDrivenLaneSummary['viewPass'],
): GpuDrivenPreparationFailureInspection {
  return preparationFailureInspection(
    new GpuDrivenPreparationError('shadow-ownership', {
      reason: 'shadow-ownership-missing',
      owner: 'shadow',
      expected: 'one GPU-compatible owner for every declared ShadowCaster pass',
      actual: `${viewPass} contains a residual ShadowCaster draw item`,
      recovery: 'route-cpu-lane',
    }),
  );
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

function sameEntityKeySet(
  left: ReadonlySet<number> | undefined,
  right: ReadonlySet<number> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

function shadowMaterialKey(batch: Pick<GpuDrivenBatch, 'prepared'>): string {
  const prepared = batch.prepared;
  const captured =
    prepared === undefined ? undefined : capturedPreparedMaterialArtifactKey(prepared);
  if (captured !== undefined) return captured;
  return gpuDrivenMaterialArtifactKey({
    material: prepared?.identity.material ?? '',
    deformation: prepared?.identity.deformation ?? 'rigid',
    receiptIdentity: prepared?.receiptIdentity ?? '',
    receiptGeneration: prepared?.receiptGeneration ?? 0,
  });
}

type ShadowArtifactObservations = ReadonlyMap<string, string | undefined>;

/** The GPU-driven bridge to the existing four-group Standard PBR pipeline. */

export interface PreparedGpuDrivenFrame {
  readonly topologySignature: string;
  /** @internal Private stock-recorder identity; borrowed graph projections keep topologySignature. */
  readonly _recordingTopologySignature?: string;
  /** Composition-local world indices mapped to the stable identities used by draw keys. */
  readonly worldKeys: readonly number[];
  /** True when every source draw item/instance is claimed by the GPU lane. */
  readonly ownsAllDrawItems: boolean;
  /** True only when the extracted ShadowCaster channel is fully represented. */
  readonly ownsAllShadowCasters?: boolean;
  /** Concrete main-pass draw identities claimed by the GPU projection. */
  readonly drawKeys?: ReadonlySet<string>;
  /** Numeric retention captured with the exact draw-key publication. */
  readonly cacheEntityKeys?: ReadonlySet<number>;
  readonly standardPbrFrameResources: GpuDrivenStandardPbrFrameResources;
  /** Published Surface admission and its pass lane decision. */
  readonly surfaceSubmission?: SurfaceGpuSubmissionAdmission;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: (submittedGraphGeneration?: number) => void;
  /** @internal Retires superseded view buffers when graph compilation promotes them. */
  readonly _commitGpuResourceReplacement?: () => void;
  /** @internal Discards staged shadow cache publication after a failed frame. */
  readonly _abortResourceReplacement?: () => void;
  /** @internal Marks validated dynamic ranges consumed only after queue submit. */
  readonly _consumeSurfaceDynamicInput?: (frameNumber: number) => Result<void, RhiError>;
  /** Concrete ShadowCaster keys claimed by the GPU subset for this frame. */
  readonly shadowDrawKeys?: ReadonlySet<string>;
  /** View-scoped ShadowCaster claims consumed by each shadow record pass. */
  readonly shadowDrawKeysByView?: ReadonlyMap<string, ReadonlySet<string>>;
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

export interface RecoveryCapabilityFacts {
  readonly generation: number;
  readonly shaderCompilation: boolean;
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly indirectDrawing: boolean;
  readonly multisample: boolean;
}

export type RecoveryCapabilityOutcome =
  | {
      readonly status: 'ready' | 'fallback';
      readonly generation: number;
      readonly disabled: readonly string[];
    }
  | {
      readonly status: 'disabled';
      readonly generation: number;
      readonly disabled: readonly string[];
      readonly allocations: 0;
    }
  | {
      readonly status: 'refused';
      readonly generation: number;
      readonly failedOwner: 'shader-material-pipeline';
      readonly resourceKind: 'pipeline';
    };

export function classifyRecoveryCapability(
  facts: RecoveryCapabilityFacts,
): RecoveryCapabilityOutcome {
  if (!facts.shaderCompilation) {
    return {
      status: 'refused',
      generation: facts.generation,
      failedOwner: 'shader-material-pipeline',
      resourceKind: 'pipeline',
    };
  }
  if (!facts.compute || !facts.storageBuffer || !facts.indirectDrawing) {
    return {
      status: 'disabled',
      generation: facts.generation,
      disabled: ['gpu-driven'],
      allocations: 0,
    };
  }
  return {
    status: facts.multisample ? 'ready' : 'fallback',
    generation: facts.generation,
    disabled: [],
  };
}

type RasterPipelineFor = (
  formats: readonly TextureFormat[],
  formatKey?: string,
  preparation?: boolean,
) => Result<RenderPipeline, RhiError>;

/** One filtered batch as the compiled raster encoder reads it on each frame. */
interface LiveRasterBatch {
  readonly batch: GpuDrivenBatch;
  readonly classKey: string;
  readonly recordingClassKey: string;
  readonly mesh: MeshGpuHandles;
  readonly meshBinding: RasterMeshBinding;
  /**
   * Entity identity of every candidate, in candidate order. The plan holds all
   * resident candidates, so the frame material table may omit any one of them;
   * the batch shares one material slot, so any listed entity names it.
   */
  readonly materialEntityKeys: readonly number[];
  /** Complete LOD windows, retained independently for the two visible regions. */
  visibleBindGroups: { early?: readonly BindGroup[]; late?: readonly BindGroup[] } | undefined;
  readonly bundles: PreparedRasterBundleCache;
}

export class GpuDrivenProduction {
  private disposed = false;
  private readonly preparedBundleCounters: PreparedRasterCounters = {
    hits: 0,
    builds: 0,
    commands: 0,
    evictions: 0,
  };
  private view: GpuDrivenView | undefined;
  private materialRaster: MaterialAbiRasterAdapter | undefined;
  private skinRaster: MaterialAbiRasterAdapter | undefined;
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
  /** Per-source-batch preparation, valid while its global inputs hold. */
  private readonly preparedBatches = new Map<
    number,
    {
      readonly generation: number;
      readonly contentEpoch: number;
      readonly artifact: MaterialShaderArtifact | undefined;
      readonly value: PreparedBatchRows;
    }
  >();
  private preparedCache:
    | {
        readonly plan: SubmissionPlan;
        readonly slotAt: PersistentGpuDrivenState['slotAt'];
        readonly worldKeys: readonly number[] | undefined;
        readonly scene: PersistentGpuDrivenState['scene'];
        readonly meshResidencyEpoch: number;
        readonly batchRows: readonly PreparedBatchRows[];
        readonly value: PreparedProductionPlan;
      }
    | undefined;
  private readonly mainFilterContributions = new FilteredPlanContributionOwner();
  private readonly shadowFilterContributions = new FilteredPlanContributionOwner();
  private filteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly bindingSignature: string | null | undefined;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  /** Live draw facts of the latest prepared frame, read by compiled raster encoders. */
  private liveRasterBatches: readonly LiveRasterBatch[] = [];
  private liveRasterCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly visibleBuffer: Buffer;
        readonly rigidBindings: object;
        readonly skinBindings: object | undefined;
        readonly value: readonly LiveRasterBatch[];
        readonly meshBindings: RasterMeshBindings;
      }
    | undefined;
  /** Per-frame admission facts; recomputed only when the active entity set changes. */
  private admissionCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly sceneCapacity: number;
        readonly activeEntityRevision?: number;
        readonly activeEntityKeys?: ReadonlySet<number>;
        readonly suppressed?: Uint32Array;
        readonly ownsAllDrawItems: boolean;
      }
    | undefined;
  private surfaceFrameRangeCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly slots: PersistentGpuDrivenState['slots'];
        readonly allocationRevision: number;
        readonly page: ReadonlyDynamicInputPage | undefined;
        readonly projectionRevision: number;
        readonly value: SurfaceFrameProjection;
      }
    | undefined;
  private consumedSurfaceInput:
    | {
        readonly page: ReadonlyDynamicInputPage;
        readonly projectionRevision: number;
        readonly contentRevision: number;
        readonly bufferGeneration: number;
        readonly deviceGeneration: number;
      }
    | undefined;
  private surfaceFrameRangeBuilds = 0;
  private surfaceFrameRangeMemberScans = 0;
  private shadowFilteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly membership: ShadowClaimTable | undefined;
        readonly legacyBindingSignature: string;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private gpuOwnedSnapshotsMaterialized = 0;
  private filteredPlanBuilds = 0;
  private preparedBatchBuilds = 0;
  private filteredBatchBuilds = 0;
  private planRebuildBatches = 0;
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
  private shadowSourcePlan: SubmissionPlan | undefined;
  private shadowScene: PersistentGpuDrivenState['scene'] | undefined;
  private shadowBatchProjections = publishReadonlyMap(
    new Map<string, ReadonlyMap<number, GpuDrivenShadowBatchProjection>>(),
  );
  private shadowDrawKeysByView = publishReadonlyMap(new Map<string, ReadonlySet<string>>());
  /** Draw bindings follow physical resources and topology, independently of depth invalidation. */
  private readonly shadowProjectionSources = new WeakMap<
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    {
      readonly plan: SubmissionPlan;
      filtered: FilteredProductionPlan;
      claims: ShadowClaimTable | undefined;
      artifacts: ShadowArtifactObservations;
      readonly visibleBuffer: Buffer;
      readonly meshBinding: BindGroup;
      readonly skinMeshBinding: BindGroup | undefined;
      readonly visibleBindingIdentity: object;
      readonly skinVisibleBindingIdentity: object | undefined;
    }
  >();
  private readonly shadowCasterClasses = new ShadowCasterClassifier();
  private shadowExpectedDrawKeys: ReadonlySet<string> = EMPTY_SHADOW_KEYS;
  private shadowOwnershipCache: ShadowOwnershipSource | undefined;
  private surfaceSubmission: SurfaceGpuSubmissionAdmission | undefined;
  private surfaceArtifactInspection: GpuDrivenProductionInspection['surfaceArtifact'];
  private skinPaletteBuffer: Buffer | undefined;
  private committedPaletteContentRevision: number | undefined;
  private committedViewClipping = '';
  /** Observed publication fields; raw artifact wrappers and receipts may mutate in place. */
  private observedShadowArtifacts: ShadowArtifactObservations = new Map();
  private readonly residencyValidation = new ResidencyValidationOwner();
  private cpuValidationTelemetryCache: GpuDrivenCpuValidationTelemetryCache | undefined;
  private cpuValidationCacheHits = 0;
  private cpuValidationScans = 0;
  private structureMetrics: GpuDrivenStructureMetrics = {
    worldEntitiesScanned: 0,
    sceneTableUploadBytes: 0,
    paletteUploadBytes: 0,
  };
  private readonly rasterGraphIdentity = new RasterGraphIdentity();

  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly recoveryCount = 0,
  ) {}

  private resolveSurfaceFrameRanges(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
  ): Result<SurfaceFrameProjection, RhiError> {
    const ranges = frame?.ranges ?? [];
    const projectionRevision = frame?.projectionRevision ?? 0;
    if (!Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return err(
        surfaceDynamicInputError(
          'the Surface projection revision is a non-negative safe integer',
          'advance the producer-owned projection revision only when membership or addresses change',
        ),
      );
    }
    const cached = this.surfaceFrameRangeCache;
    if (
      cached?.filtered === filtered &&
      cached.slots === scene.slots &&
      cached.allocationRevision === scene.scene.allocationRevision &&
      cached.page === frame?.page &&
      cached.projectionRevision === projectionRevision
    ) {
      return ok(cached.value);
    }
    this.surfaceFrameRangeBuilds += 1;
    for (const prepared of filtered.batches) {
      if (!isSingleLayerMediumArtifact(prepared.artifact)) continue;
      this.surfaceFrameRangeMemberScans += prepared.batch.candidates.length;
    }
    const built = buildSurfaceFrameRanges(filtered, ranges, scene);
    if (!built.ok) return built;
    let capacity = 1;
    const consumptionRanges: DynamicInputRange[] = [];
    for (const entry of built.value) {
      capacity = Math.max(capacity, entry.frameIndex + 1);
      if (entry.range !== undefined) consumptionRanges.push(entry.range);
    }
    const value = {
      ranges: built.value,
      consumptionRanges: Object.freeze(consumptionRanges),
      capacity,
    };
    return ok(value);
  }

  private rememberSurfaceFrameProjection(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
    value: SurfaceFrameProjection,
  ): void {
    this.surfaceFrameRangeCache = {
      filtered,
      slots: scene.slots,
      allocationRevision: scene.scene.allocationRevision,
      page: frame?.page,
      projectionRevision: frame?.projectionRevision ?? 0,
      value,
    };
  }

  private consumeSurfaceDynamicInput(
    page: ReadonlyDynamicInputPage,
    ranges: readonly DynamicInputRange[],
    projectionRevision: number,
    frameNumber: number,
  ): Result<void, RhiError> {
    const consumed = this.consumedSurfaceInput;
    if (
      consumed?.page === page &&
      consumed.projectionRevision === projectionRevision &&
      consumed.contentRevision === page.contentRevision &&
      consumed.bufferGeneration === page.bufferGeneration &&
      consumed.deviceGeneration === page.deviceGeneration
    ) {
      return ok(undefined);
    }
    for (const range of ranges) {
      const receipt = page.consume(range, frameNumber);
      if (!receipt.ok) {
        return err(
          surfaceDynamicInputError(
            'each submitted Surface dynamic range was uploaded before graph consumption',
            receipt.error.hint,
          ),
        );
      }
    }
    this.consumedSurfaceInput = {
      page,
      projectionRevision,
      contentRevision: page.contentRevision,
      bufferGeneration: page.bufferGeneration,
      deviceGeneration: page.deviceGeneration,
    };
    return ok(undefined);
  }

  /**
   * Reuse the last producer-resolved residency rows when all source identity
   * and generation fences still match. Renderables and dispatch entries are
   * checked element-by-element as well as by their stable object identities so
   * an accidental in-place mutation cannot reuse stale renderable indices.
   */
  reuseResidencyValidation(
    input: GpuDrivenResidencyValidationInput,
  ): readonly ValidatedRenderable[] | undefined {
    return this.residencyValidation.reuse(input, this.device);
  }

  /** Publish the producer-owned rows after a completed residency validation. */
  rememberResidencyValidation(
    input: GpuDrivenResidencyValidationInput,
    value: readonly ValidatedRenderable[],
  ): void {
    this.residencyValidation.remember(input, value);
  }

  private applyCpuValidationTelemetry(cache: GpuDrivenCpuValidationTelemetryCache): void {
    this.gpuOwnedDrawItems = cache.gpuOwnedDrawCount;
    this.mainTotalDrawItems = cache.totalDrawItems;
    this.validatedGpuOwnedRows = cache.gpuOwnedRows;
    this.cpuFallbackDrawItems = cache.cpuFallbackDrawItems;
    this.cpuSemanticFallbackDrawItems = cache.cpuSemanticFallbackDrawItems;
    this.cpuDeformationFallbackDrawItems = cache.cpuDeformationFallbackDrawItems;
    this.cpuDeformationReasons.clear();
    for (const [reason, count] of cache.cpuDeformationReasons) {
      this.cpuDeformationReasons.set(reason, count);
    }
    this.blockedDrawItems = cache.blockedDrawItems;
  }

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

  prepare(input: {
    readonly scene: PersistentGpuDrivenState | undefined;
    /** The already selected frame lane; Surface still shares its retained resource owner. */
    readonly geometryLane?: 'automatic' | 'direct';
    readonly visibleSurface?: import('../raytracing/visible-surface').VisibleSurfaceProjection;
    readonly temporalSources?: readonly ValidatedRenderable[];
    readonly camera: CameraSnapshot;
    /** GPU meshes projected by retained RenderScene slot, never raw asset handle. */
    readonly meshBySlot: ReadonlyMap<number, MeshGpuHandles>;
    readonly viewBindGroupLayout: BindGroupLayout;
    readonly meshResidencyEpoch: number;
    /** Optional for legacy Standard callers; omitted means non-HDRP. */
    readonly hdrp?: boolean;
    /** Explicit Standard topology; cluster resources are bound by main-pass. */
    readonly clustered?: boolean;
    readonly materialBindingClasses?: ReadonlyMap<string, string>;
    /** Cooked producer artifact selected from the frame material catalog. */
    readonly materialArtifact?: MaterialShaderArtifact;
    /** Compatibility input for callers that have not migrated their name. */
    readonly standardPbrArtifact?: MaterialShaderArtifact;
    /** Cooked producer artifact for the GPU skinning variant. */
    readonly materialSkinArtifact?: MaterialShaderArtifact;
    /** Compatibility input for callers that have not migrated their name. */
    readonly standardPbrSkinArtifact?: MaterialShaderArtifact;
    /** Per-draw producer artifacts keyed by prepared identity and receipt. */
    readonly materialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
    /** Per-draw shadow-pass artifacts keyed by the same prepared identity. */
    readonly shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
    /** Retained ProbeBlend record page; slot N is addressed at aligned lane N+1. */
    readonly probeBlendRecordBuffer?: Buffer;
    readonly materialPipelineState?: PipelineState;
    readonly standardPbrPipelineState?: PipelineState;
    /** Existing renderer owner that builds the selected artifact PSO/BGL. */
    readonly materialPipelineFactory?: MaterialPipelineFactory;
    readonly materialPipelinePreparationFactory?: MaterialPipelineFactory;
    /** Extracted ShadowCaster ownership keyed by concrete draw item and pass. */
    readonly shadowCasterDrawKeys?: ReadonlySet<string>;
    /** Structured ShadowCaster ownership facts for exact pass admission. */
    readonly shadowCasterMembership?: readonly ShadowCasterMembership[];
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
  }): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    this.surfaceArtifactInspection = undefined;
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.preparedBatchBuilds = 0;
    this.filteredBatchBuilds = 0;
    this.planRebuildBatches = 0;
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
      paletteUploadBytes: 0,
    };
    this.lane = 'cpu-semantic';
    this.laneReason = 'capability';
    this.submissionState = 'idle';
    this.shadowExpectedDrawKeys = EMPTY_SHADOW_KEYS;
    this.surfaceSubmission = undefined;
    const capability = classifyRecoveryCapability({
      generation: 0,
      shaderCompilation: true,
      compute: this.device.caps.compute,
      storageBuffer: this.device.caps.storageBuffer,
      indirectDrawing: this.device.caps.indirectDrawing,
      multisample: true,
    });
    if (
      input.scene === undefined ||
      (input.hdrp === true && input.clustered !== true) ||
      selectGpuLodLane(this.device.caps) === 'cpu' ||
      capability.status === 'disabled'
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
    const preparationFailure = nonCpuPreparationFailure(scene);
    if (preparationFailure !== undefined) {
      this.gpuOwnedEntityCount = 0;
      // A capable candidate that cannot be prepared is a stopped promotion,
      // not a CPU-semantic lane. Keep the concrete rejected draw count in the
      // detached channel so an inspector can repair the producer and retry the
      // same view-pass without guessing from an error string.
      this.blockedDrawItems = preparationFailure.drawKeys.length;
      this.mainTotalDrawItems = Math.max(
        this.mainTotalDrawItems,
        scene.plan.batches.reduce((total, batch) => total + batch.candidates.length, 0),
      );
      this.lane = 'blocked';
      this.laneReason = 'resource-not-ready';
      this.preparationFailure = preparationFailureInspection(preparationFailure.error);
      return err(preparationFailure.error);
    }
    const materialArtifact = input.materialArtifact ?? input.standardPbrArtifact;
    const skinArtifact = input.materialSkinArtifact ?? input.standardPbrSkinArtifact;
    const materialPipelineState = input.materialPipelineState ?? input.standardPbrPipelineState;
    const bindingSignature = materialBindingSignature(input.materialBindingClasses);
    const legacyBindings = bindingSignature ?? undefined;
    if (
      (materialArtifact === undefined && input.materialArtifacts === undefined) ||
      materialPipelineState === undefined
    ) {
      this.gpuOwnedEntityCount = 0;
      this.laneReason = 'resource-not-ready';
      if (sceneRequiresGpuDrivenArtifact(input.scene)) {
        this.blockedDrawItems = input.scene.plan.batches.reduce(
          (total, batch) => total + batch.candidates.length,
          0,
        );
        this.mainTotalDrawItems = Math.max(this.mainTotalDrawItems, this.blockedDrawItems);
        this.lane = 'blocked';
        const failure =
          materialArtifact === undefined && input.materialArtifacts === undefined
            ? new GpuDrivenPreparationError('missing-material-receipt', {
                reason: 'material-receipt-missing',
                owner: 'material',
                expected: 'producer-owned MaterialProgramAbi GPU-driven artifact',
              })
            : new GpuDrivenPreparationError('resource-not-ready', {
                reason: 'material-resource-missing',
                owner: 'material',
                expected: 'producer-owned GPU-driven material pipeline state',
              });
        this.preparationFailure = preparationFailureInspection(failure);
        return err(failure);
      }
      return ok(undefined);
    }
    const rebuilt = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/plan',
      () =>
        this.assemblePrepared(
          scene,
          input.meshBySlot,
          input.meshResidencyEpoch,
          materialArtifact,
          skinArtifact,
          input.materialArtifacts,
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
        if (preparedPlan.drawKeys.size === 0) return ok(undefined);
        this.shadowSourcePlan = undefined;
        this.shadowScene = undefined;
        this.liveRasterBatches = [];
        this.disableShadowViews();
        const view = this.view;
        const shadowViews = this.shadowViews;
        return ok({
          topologySignature: 'direct',
          worldKeys: scene.worldKeys ?? [],
          ownsAllDrawItems: false,
          ownsAllShadowCasters: false,
          drawKeys: EMPTY_SHADOW_KEYS,
          shadowDrawKeys: EMPTY_SHADOW_KEYS,
          standardPbrFrameResources: {
            materialBindGroups: [],
            materialSlotIndicesByEntity: new Map(),
            materialStride: MATERIAL_PER_ENTITY_STRIDE,
            sceneMaterialBuffer: scene.scene.materialBuffer,
          },
          ...(shadowViews === undefined ? {} : { shadowViewPool: shadowViews }),
          _commitResourceReplacement: () => {
            // A successful direct graph releases the superseded GPU graph's
            // imports and shadows. It does not submit a new GPU geometry generation.
            view?._commitResourceReplacement();
            shadowViews?._commitResourceReplacement();
          },
          _abortResourceReplacement: () => shadowViews?._abortResourceReplacement(),
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
          bindingSignature === undefined ||
          filtered === undefined ||
          this.filteredCache?.prepared !== preparedPlan ||
          this.filteredCache.bindingSignature !== bindingSignature
        ) {
          filtered = runRecordProfilePhase(
            input.profilePhase,
            'record/gpu-driven-prepare/filter/main-plan',
            () =>
              this.mainFilterContributions.update(
                preparedPlan,
                // Prepared rows own ordinary Main dependencies. Raw inputs
                // retain their complete observation and callback scope.
                legacyBindings === undefined ? 'main' : legacyBindings,
                undefined,
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
            bindingSignature,
            value: filtered,
          };
          this.filteredBatchBuilds += this.mainFilterContributions.lastWork.projectedBatches;
        }
        runRecordProfilePhase(input.profilePhase, 'record/gpu-driven-prepare/filter/counts', () => {
          this.gpuOwnedEntityCount = gpuDrawEntityCount(filtered.drawKeys);
          this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        });
        if (filtered.batches.length === 0) return undefined;
        let shadowOwnership: ShadowOwnershipSource | undefined;
        let shadowFiltered: FilteredProductionPlan | undefined;
        // An explicit empty ownership publication has no shadow work. Missing
        // ownership still means unrestricted legacy admission, not an empty set.
        if ((input.shadowCasterMembership?.length ?? input.shadowCasterDrawKeys?.size) !== 0) {
          const ownership = runRecordProfilePhase(
            input.profilePhase,
            'record/gpu-driven-prepare/filter/shadow-ownership',
            () =>
              this.shadowOwnershipSource(input.shadowCasterDrawKeys, input.shadowCasterMembership),
          );
          shadowOwnership = ownership;
          const shadowMembership = ownership.claims;
          shadowFiltered = this.shadowFilteredCache?.value;
          if (
            shadowFiltered === undefined ||
            this.shadowFilteredCache?.prepared !== preparedPlan ||
            this.shadowFilteredCache.membership !== shadowMembership ||
            this.shadowFilteredCache.legacyBindingSignature !== (legacyBindings ?? '')
          ) {
            shadowFiltered = runRecordProfilePhase(
              input.profilePhase,
              'record/gpu-driven-prepare/filter/shadow-plan',
              () =>
                this.shadowFilterContributions.update(
                  preparedPlan,
                  legacyBindings ?? '',
                  ownership.claims,
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
              prepared: preparedPlan,
              membership: shadowMembership,
              legacyBindingSignature: legacyBindings ?? '',
              value: shadowFiltered,
            };
          }
        }
        const sceneCapacity = scene.scene.rowCapacity;
        const cachedAdmission = this.admissionCache;
        const admissionMatches =
          cachedAdmission !== undefined &&
          cachedAdmission.prepared === preparedPlan &&
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
                  prepared: preparedPlan,
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
                          preparedPlan,
                          input.activeEntityKeys,
                          sceneCapacity,
                        ),
                      }),
                  ownsAllDrawItems: ownsAllAdmittedDrawItems(preparedPlan, input.activeEntityKeys),
                },
        );
        this.admissionCache = admission;
        return {
          lodProjection,
          filtered,
          admission,
          shadowOwnership,
          shadowFiltered,
        };
      },
    );
    if (filterStage === undefined) {
      this.laneReason = 'unsupported';
      return ok(undefined);
    }
    const { lodProjection, filtered, admission, shadowOwnership, shadowFiltered } = filterStage;
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
    this.shadowSourcePlan = shadowFiltered?.plan;
    this.shadowScene = scene.scene;
    const shadowCasterKeys = shadowOwnership?.casterKeys;
    this.shadowExpectedDrawKeys = shadowCasterKeys ?? EMPTY_SHADOW_KEYS;
    if (
      shadowOwnership !== undefined &&
      shadowFiltered !== undefined &&
      shadowOwnership.ownsAllFor !== shadowFiltered
    ) {
      shadowOwnership.ownsAllFor = shadowFiltered;
      shadowOwnership.ownsAll =
        shadowCasterKeys === undefined ||
        [...shadowCasterKeys].every((key) => shadowFiltered.shadowDrawKeys.has(key));
    }
    const ownsAllShadowCasters = shadowOwnership?.ownsAll ?? true;
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
              : base + candidate.drawItemIndex * instanceCount + candidate.instanceOrdinal;
        }
      }
    }
    const updated = this.view.update(
      filtered.plan,
      scene.scene,
      activeFrustum(input.camera),
      input.camera,
      0,
      admission.suppressed,
      undefined,
      occlusionCamera(input.camera),
      surfaceRows,
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
    const representativeArtifact = filtered.materialBatches[0]?.artifact;
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
    const skinBatch = filtered.batches.find(
      ({ batch }) => batch.prepared?.identity.deformation === 'skin',
    );
    if (skinBatch !== undefined) {
      const skinPrimitive = skinBatch.batch.candidates[0]?.primitiveIndex;
      const skinSnapshot =
        skinPrimitive === undefined ? undefined : scene.slotAt(skinPrimitive)?.snapshot.skin;
      const skinAllocator = materialPipelineState.skinPaletteAllocator;
      const selectedSkinArtifact = skinBatch.artifact;
      if (skinSnapshot === undefined || skinAllocator === null || skinAllocator === undefined) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'skinned material artifact and persistent palette owner',
            hint: 'keep missing skin producer resources on the CPU deformation path',
          }),
        );
      }
      if (this.skinRaster === undefined) {
        const created = MaterialAbiRasterAdapter.create({
          device: this.device,
          pipelineState: materialPipelineState,
          artifact: selectedSkinArtifact,
          visibleBuffer,
          deformation: 'skin',
          paletteBuffer: skinSnapshot.buffer,
          paletteBindingWindowBytes: skinAllocator.bindingWindowBytes,
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
        const palette = this.skinRaster.ensurePaletteBuffer(
          skinSnapshot.buffer,
          skinAllocator.bindingWindowBytes,
        );
        if (!palette.ok) return palette;
      }
      if (this.skinPaletteBuffer !== skinSnapshot.buffer) {
        this.skinPaletteBuffer = skinSnapshot.buffer;
        this.shadowBatchProjections = publishReadonlyMap(new Map());
        this.shadowViews?.invalidateSkinned();
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
      const surfaceFrameRangesResult = this.resolveSurfaceFrameRanges(
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
      this.rememberSurfaceFrameProjection(
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
    // A pose can change while conservative bounds, allocation and scene rows
    // remain unchanged. Read the palette owner, never optional telemetry.
    const paletteContentRevision = materialPipelineState.skinPaletteAllocator?.contentRevision;
    if (paletteContentRevision !== this.committedPaletteContentRevision)
      shadowViewPool.invalidateSkinned();
    // Shadow depth bakes the camera clipping casters opt into. A retained
    // layer, including one that survives a graph recompile, must not keep it.
    const viewClipping = shadowViewClipping(input.camera);
    if (viewClipping !== this.committedViewClipping) shadowViewPool.invalidateViewClipping();
    // Visible items address GPU Scene instance rows directly: the vertex
    // stage reads current/previous transforms, temporal flags and material
    // rows from the scene tables, so no per-batch row projection exists.
    const sceneIdentity = this.sceneIdentity(scene.scene);
    const viewInspection = view.inspect();
    const liveRaster = this.liveRaster(filtered, scene, visibleBuffer, materialRaster, skinRaster);
    if (!liveRaster.ok) return liveRaster;
    this.liveRasterBatches = liveRaster.value;
    const graphIdentity = this.rasterGraphIdentity.update(
      filtered,
      sceneIdentity,
      viewInspection,
      liveRaster.value,
      materialRaster.visibleBindingIdentity,
      skinRaster?.visibleBindingIdentity,
    );
    const signature = `gpu:${getOpaqueResourceIdentity(graphIdentity.raw)}`;
    const recordingSignature = `gpu:${getOpaqueResourceIdentity(graphIdentity.recording)}`;
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
    const production = this;
    const surfaceDynamicInputForCommit =
      this.surfaceSubmission !== undefined && input.surfaceDynamicInput !== undefined
        ? {
            page: input.surfaceDynamicInput.page,
            ranges: this.surfaceFrameRangeCache?.value.consumptionRanges ?? [],
            projectionRevision: input.surfaceDynamicInput.projectionRevision,
          }
        : undefined;
    return ok({
      get topologySignature() {
        const shadow = shadowTopologySignature();
        return shadow.length === 0 ? signature : `${signature}|shadow=${shadow}`;
      },
      get _recordingTopologySignature() {
        const shadow = shadowTopologySignature();
        return shadow.length === 0 ? recordingSignature : `${recordingSignature}|shadow=${shadow}`;
      },
      ownsAllDrawItems: admission.ownsAllDrawItems,
      worldKeys: scene.worldKeys ?? [],
      ownsAllShadowCasters,
      drawKeys: filtered.drawKeys,
      cacheEntityKeys: preparedPlan.cacheEntityKeys,
      shadowDrawKeys: shadowFiltered?.shadowDrawKeys ?? EMPTY_SHADOW_KEYS,
      ...(this.surfaceSubmission === undefined
        ? {}
        : { surfaceSubmission: this.surfaceSubmission }),
      get shadowDrawKeysByView() {
        return production.shadowDrawKeysByView;
      },
      standardPbrFrameResources: {
        resourceGeneration: viewInspection.resourceGeneration,
        materialBindGroups: [],
        materialSlotIndicesByEntity: new Map(),
        materialStride: MATERIAL_PER_ENTITY_STRIDE,
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
              surfaceDirectInstances: (directInput) => {
                const resolved = materialRaster.directSurfaceInstances(directInput);
                if (!resolved.ok) return resolved;
                const firstInstanceOrdinal = directInput.firstInstanceOrdinal ?? 0;
                const memberIds: string[] = [];
                for (let index = 0; index < directInput.instanceCount; index += 1) {
                  const instanceOrdinal = firstInstanceOrdinal + index;
                  const frameRange = this.surfaceFrameRangeCache?.value.ranges.find(
                    ({ directMember }) =>
                      directMember.worldId === directInput.worldId &&
                      directMember.entityKey === directInput.entityKey &&
                      directMember.drawItemIndex === directInput.drawItemIndex &&
                      directMember.instanceOrdinal === instanceOrdinal,
                  );
                  if (frameRange === undefined) {
                    return err(
                      surfaceDynamicInputError(
                        'every direct Surface command resolves the retained public member identity',
                        `rebuild the Surface projection for world=${directInput.worldId}, entity=${directInput.entityKey}, draw=${directInput.drawItemIndex}, instance=${instanceOrdinal}`,
                      ),
                    );
                  }
                  memberIds.push(
                    JSON.stringify([
                      frameRange.directMember.worldIdentity,
                      frameRange.directMember.entityKey,
                      frameRange.directMember.drawItemIndex,
                      frameRange.directMember.instanceOrdinal,
                    ]),
                  );
                }
                return ok({ ...resolved.value, memberIds: Object.freeze(memberIds) });
              },
            }),
      },
      _commitGpuResourceReplacement: () => {
        view._commitResourceReplacement();
      },
      _commitResourceReplacement: (submittedGraphGeneration) => {
        view._commitResourceReplacement();
        shadowViewPool._commitResourceReplacement(submittedGraphGeneration);
        this.committedPaletteContentRevision = paletteContentRevision;
        this.committedViewClipping = viewClipping;
        this.submissionState = 'submitted';
        this.lastKnownGoodGeneration = view.inspect().resourceGeneration;
      },
      _abortResourceReplacement: () => {
        materialRaster.abortSurfaceDynamicInput();
        skinRaster?.abortSurfaceDynamicInput();
        shadowViewPool._abortResourceReplacement();
        this.submissionState = 'aborted';
        this.retryCount += 1;
      },
      ...(surfaceDynamicInputForCommit === undefined ||
      surfaceDynamicInputForCommit.ranges.length === 0
        ? {}
        : {
            _consumeSurfaceDynamicInput: (frameNumber: number) =>
              this.consumeSurfaceDynamicInput(
                surfaceDynamicInputForCommit.page,
                surfaceDynamicInputForCommit.ranges,
                surfaceDynamicInputForCommit.projectionRevision,
                frameNumber,
              ),
          }),
      projectShadow: (graph, identity, forceCompute = false, cameraPyramid) => {
        if (!shadowViewPool.isActive(identity) || shadowViewPool.submission(identity) === undefined)
          return ok(undefined);
        return shadowViewPool.project(graph, identity, forceCompute, cameraPyramid);
      },
      updateShadowViews: (views) =>
        shadowFiltered !== undefined && shadowFiltered.plan.batches.length > 0 && views.length > 0
          ? this.updateShadowViews(
              views,
              input.shadowMaterialArtifacts,
              shadowFiltered,
              scene,
              shadowOwnership?.claims,
              lodProjection,
              preparedPlan,
              input.camera,
              input.capsuleShadowDirectional === true,
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
        if (materialRaster !== undefined && filtered.batches.length > 0) {
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
            const live = liveRaster.value[liveIndex];
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
            const standardTextureMask = rendererRecording
              ? prepared.standardTextureMask
              : undefined;
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
                          ...(fragmentEntry === 'fs_temporal'
                            ? { vertexEntry: 'vs_temporal' }
                            : {}),
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
          if (rasterClasses.size === 0) {
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
              (!isStandardPbrMaterialShader(batch.artifact.material) ||
                batch.deformation !== 'rigid' ||
                (live.batch.lod?.coverages.length ?? 0) <= 1)
            )
              return undefined;
            const isMedium = isSingleLayerMediumArtifact(batch.artifact);
            if (
              (filter === 'single-layer-medium' && !isMedium) ||
              ((filter === 'opaque' ||
                filter === 'deferred-opaque' ||
                filter === 'forward-only-opaque') &&
                isMedium) ||
              (filter === 'deferred-opaque' && live.batch.key.materialPass !== 'deferred') ||
              (filter === 'forward-only-opaque' && live.batch.key.materialPass === 'deferred')
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
                    const selected = new Set<RasterPipelineFor>();
                    for (const live of production.liveRasterBatches) {
                      const batch = rasterClassFor(live, filter, fragmentEntryPoint);
                      if (batch !== undefined)
                        selected.add(selectPipeline(batch, fragmentEntryPoint, coverageOnly));
                    }
                    const ownedFormats = [...formats],
                      formatKey = ownedFormats.join(',');
                    preparationJobs.set(key, (entries, artifacts) => {
                      let ready = true;
                      for (const pipelineFor of selected)
                        if (!pipelineFor(ownedFormats, formatKey, true).ok) ready = false;
                      if (
                        !prepareHiddenGpuDrivenPipelines({
                          entries,
                          artifacts,
                          factory: preparationFactory,
                          formats: ownedFormats,
                          sampleCount,
                          shaderUvSetCount: materialPipelineState.standardPbrShaderUvSetCount,
                          filter,
                          fragmentEntry: fragmentEntryPoint,
                          coverageOnly,
                          visibleSurface: input.visibleSurface !== undefined,
                        })
                      )
                        ready = false;
                      return ready;
                    });
                  },
                  preparePipelines: (entries = [], artifacts) => {
                    let ready = true;
                    for (const prepare of preparationJobs.values())
                      if (!prepare(entries, artifacts)) ready = false;
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
                  : JSON.stringify([
                      filter,
                      fragmentEntryPoint,
                      coverageOnly,
                      phase,
                      descriptor.colorFormats,
                      descriptor.depthStencilFormat,
                      descriptor.sampleCount ?? 1,
                      descriptor.depthReadOnly ?? false,
                      descriptor.stencilReadOnly ?? false,
                    ]);
              let bundleOwner: LiveRasterBatch | undefined;
              let bundleBlock = -1;
              let preparedBindings: PreparedRasterBindings[] = [];
              const flushPrepared = () => {
                if (
                  descriptor !== undefined &&
                  bundleKey !== undefined &&
                  bundleOwner !== undefined &&
                  preparedBindings.length > 0
                ) {
                  preparedBundles.push(
                    bundleOwner.bundles.resolve(
                      bundleKey,
                      production.device,
                      descriptor,
                      preparedBindings,
                      production.preparedBundleCounters,
                    ),
                  );
                }
                preparedBindings = [];
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
              const slotsByEntity = frameResources.materialSlotIndicesByEntity;
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
              for (const live of production.liveRasterBatches) {
                const batch = rasterClassFor(live, filter, fragmentEntryPoint);
                if (batch === undefined) continue;
                const isMedium = isSingleLayerMediumArtifact(batch.artifact);
                let globalMaterialSlot =
                  slotsByEntity.size === 0 ? live.batch.key.materialSlot : undefined;
                for (const entityKey of live.materialEntityKeys) {
                  if (globalMaterialSlot !== undefined) break;
                  globalMaterialSlot = slotsByEntity.get(entityKey)?.[live.batch.key.materialSlot];
                }
                // No candidate reached this frame's material producer, so the
                // view admitted none of them and the indirect count is zero.
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
                const materialBindGroup = frameResources.materialBindGroups[globalMaterialSlot];
                if (materialBindGroup === undefined) {
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
                    : globalMaterialSlot * frameResources.materialStride;
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
                let group2: BindGroup | undefined;
                if (rendererRecording && batch.clustered && batch.deformation === 'rigid') {
                  rigidClusterGroup ??= frameResources.clusterBindGroupForMesh?.(
                    sceneTransformBuffer,
                    sceneTransformBytes,
                  );
                  group2 = rigidClusterGroup;
                } else {
                  group2 = resolveGpuDrivenMeshGroup({
                    clustered: batch.clustered,
                    deformation: batch.deformation,
                    meshBindGroup: batch.meshBindGroup,
                    sceneTransformBuffer,
                    sceneTransformBytes,
                    frameResources,
                    skinPaletteBinding: batch.raster.skinPaletteBinding(),
                  });
                }
                if (group2 === undefined) {
                  throw new RhiError({
                    code: 'rhi-not-available',
                    expected: 'clustered Standard group(2) BindGroup for GPU-driven batch',
                    hint: 'publish the frame-owned cluster lighting resources before indirect encode',
                  });
                }
                if (currentMesh !== group2 || currentDeformation !== batch.deformation) {
                  if (descriptor === undefined)
                    pass.setBindGroup(2, group2, batch.deformation === 'skin' ? [0, 0, 0] : [0]);
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
                  live.visibleBindGroups[windowPhase] = resolvedWindows;
                  windows = resolvedWindows;
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
                }
                if (descriptor !== undefined && bundleKey !== undefined) {
                  if (physicalVertex === undefined)
                    throw new Error('Missing prepared vertex buffer');
                  // Contiguous stable-ID blocks bound rebuilding to at most 32
                  // batches while sharing state and reducing native execute overhead.
                  const block = Math.floor(live.batch.batchId / 32);
                  if (bundleBlock !== block) flushPrepared();
                  bundleBlock = block;
                  bundleOwner ??= live;
                  if (bundleOwner !== live)
                    live.bundles.retire(bundleKey, production.preparedBundleCounters);
                  preparedBindings.push({
                    pipeline: selectedPipeline.value,
                    view: viewBindGroup,
                    material: materialBindGroup,
                    materialOffset,
                    mesh: group2,
                    skin: batch.deformation === 'skin',
                    vertex: physicalVertex,
                    ...(indexKey === undefined || physicalIndex === undefined
                      ? {}
                      : { index: physicalIndex }),
                    indexFormat,
                    indirect: indirectBuffer,
                    indirectOffset: regionOffset + live.batch.indirectOffset,
                    indexed: live.batch.key.drawKind === 'indexed',
                    windows,
                  });
                }
              }
              flushPrepared();
              if (preparedBundles.length > 0) {
                const executed = pass.executeBundles(preparedBundles);
                if (!executed.ok) throw executed.error;
              }
            },
          });
        }
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'material ABI raster projection branch',
            hint: 'preserve the selected-artifact branch as the only raster owner',
          }),
        );
      },
    });
  }

  /** Bind each filtered batch to its raster class and material representative. */
  private liveRaster(
    filtered: FilteredProductionPlan,
    scene: PersistentGpuDrivenState,
    visibleBuffer: Buffer,
    rigid: MaterialAbiRasterAdapter,
    skin: MaterialAbiRasterAdapter | undefined,
  ): Result<readonly LiveRasterBatch[], RhiError> {
    const cached = this.liveRasterCache;
    const rigidBindings = rigid.visibleBindingIdentity;
    const skinBindings = skin?.visibleBindingIdentity;
    if (cached?.filtered === filtered) {
      if (
        cached.visibleBuffer !== visibleBuffer ||
        cached.rigidBindings !== rigidBindings ||
        cached.skinBindings !== skinBindings
      ) {
        // Content writes keep the bindings. Physical replacement resets only
        // the affected adapter's windows, without revisiting candidate rows.
        for (const live of cached.value) {
          if (
            cached.visibleBuffer !== visibleBuffer ||
            (live.batch.prepared?.identity.deformation === 'skin'
              ? cached.skinBindings !== skinBindings
              : cached.rigidBindings !== rigidBindings)
          ) {
            live.visibleBindGroups = undefined;
          }
        }
        this.liveRasterCache = {
          filtered,
          visibleBuffer,
          rigidBindings,
          skinBindings,
          value: cached.value,
          meshBindings: cached.meshBindings,
        };
      }
      return ok(cached.value);
    }
    const value: LiveRasterBatch[] = [];
    const meshBindings = new RasterMeshBindings();
    const previousById = new Map(cached?.value.map((live) => [live.batch.batchId, live]));
    for (const prepared of filtered.batches) {
      const retained = previousById.get(prepared.batch.batchId);
      const previous =
        retained?.batch.generation === prepared.batch.generation ? retained : undefined;
      const batch = prepared.batch;
      const deformation = batch.prepared?.identity.deformation ?? 'rigid';
      // Bindings describe physical windows, independent of their current
      // candidates/material. Reuse the previous ordered slot only when both
      // LOD phases still address exactly the same resources and ranges.
      // The late base is the view's allocated capacity, fixed per buffer.
      const visibleBindGroups =
        previous !== undefined &&
        cached?.visibleBuffer === visibleBuffer &&
        (deformation === 'skin'
          ? cached.skinBindings === skinBindings
          : cached.rigidBindings === rigidBindings) &&
        (previous.batch.prepared?.identity.deformation ?? 'rigid') === deformation &&
        previous.batch.visibleBase === batch.visibleBase &&
        (previous.batch.visibleAllocationCapacity ?? previous.batch.visibleCapacity) ===
          (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
        batchLevelStride(previous.batch) === batchLevelStride(batch) &&
        batchLodLevelCount(previous.batch) === batchLodLevelCount(batch)
          ? previous.visibleBindGroups
          : undefined;
      const reusedEntityKeys =
        previous?.batch.candidates === batch.candidates ? previous.materialEntityKeys : undefined;
      const materialEntityKeys: number[] = [];
      let previousPrimitive = -1;
      for (const candidate of previous?.batch.candidates === batch.candidates
        ? []
        : prepared.batch.candidates) {
        if (candidate.primitiveIndex === previousPrimitive) continue;
        previousPrimitive = candidate.primitiveIndex;
        const slot = scene.slotAt(candidate.primitiveIndex);
        if (slot === undefined) {
          return err(
            new RhiError({
              code: 'internal-error',
              expected: 'batch candidate entity for global material slot projection',
              hint: 'preserve the retained scene identity when projecting the GPU batch',
            }),
          );
        }
        materialEntityKeys.push(worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey));
      }
      value.push({
        batch: prepared.batch,
        classKey: prepared.rasterClassKey,
        recordingClassKey: prepared.recordingRasterClassKey,
        mesh: prepared.mesh,
        meshBinding: meshBindings.forMesh(prepared.mesh),
        materialEntityKeys: reusedEntityKeys ?? materialEntityKeys,
        visibleBindGroups,
        bundles: previous?.bundles ?? new PreparedRasterBundleCache(),
      });
    }
    const frozen = Object.freeze(value);
    this.liveRasterCache = {
      filtered,
      visibleBuffer,
      rigidBindings,
      skinBindings,
      value: frozen,
      meshBindings,
    };
    return ok(frozen);
  }

  private assemblePrepared(
    scene: PersistentGpuDrivenState,
    meshBySlot: ReadonlyMap<number, MeshGpuHandles>,
    meshResidencyEpoch: number,
    materialArtifact: MaterialShaderArtifact | undefined,
    skinArtifact: MaterialShaderArtifact | undefined,
    materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    profilePhase?: RecordProfileRunner,
  ): Result<PreparedProductionPlan, GpuDrivenPreparationError> {
    const previous = this.preparedCache;
    const sameInputs =
      previous !== undefined &&
      previous.slotAt === scene.slotAt &&
      previous.worldKeys === scene.worldKeys &&
      previous.scene === scene.scene;
    const meshChanges =
      previous?.scene === scene.scene && previous.meshResidencyEpoch !== meshResidencyEpoch
        ? new Set<number>()
        : undefined;
    const inputs: PreparationInputs = {
      slotAt: scene.slotAt,
      meshBySlot,
      worldKeys: scene.worldKeys,
      materialArtifact,
      skinArtifact,
      materialArtifacts,
    };
    let sameRows = true;
    let missingArtifact: GpuDrivenPreparationError | undefined;
    let rebuiltBatches = 0;
    let rebuiltCandidates = 0;
    const batchRows = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/plan/rows',
      () =>
        scene.plan.batches.map((batch, index) => {
          const cached = this.preparedBatches.get(batch.batchId);
          const artifact = artifactForPreparedBatch(
            batch,
            materialArtifacts,
            materialArtifact,
            skinArtifact,
          );
          const prepared = batch.prepared;
          if (
            missingArtifact === undefined &&
            artifact === undefined &&
            batch.candidates.length > 0 &&
            prepared?.receiptIdentity !== undefined
          ) {
            missingArtifact = new GpuDrivenPreparationError('missing-material-receipt', {
              reason: 'material-receipt-missing',
              owner: 'material',
              expected: `published artifact for ${prepared.identity.material} (${prepared.receiptIdentity}@${prepared.receiptGeneration})`,
            });
          }
          const sameMeshes =
            cached === undefined || sameBatchMeshes(cached.value, meshBySlot, meshChanges);
          if (
            sameInputs &&
            cached !== undefined &&
            cached.generation === batch.generation &&
            cached.contentEpoch === batch.contentEpoch &&
            sameMaterialArtifact(cached.artifact, artifact) &&
            sameMeshes
          ) {
            if (cached.value.source === batch) {
              sameRows &&= cached.value === previous.batchRows[index];
              return cached.value;
            }
            sameRows = false;
            // Only the aligned visible window moved; rows keep their facts.
            const rebased = Object.freeze({
              ...cached.value,
              source: batch,
            });
            this.preparedBatches.set(batch.batchId, {
              ...cached,
              value: rebased,
            });
            return rebased;
          }
          sameRows = false;
          const value = prepareBatchRows(batch, inputs);
          this.preparedBatches.set(batch.batchId, {
            generation: batch.generation,
            contentEpoch: batch.contentEpoch,
            // Retain the observed fields, not the mutable publication wrapper.
            artifact:
              artifact === undefined
                ? undefined
                : {
                    ...artifact,
                    ...(artifact.receipt === undefined ? {} : { receipt: { ...artifact.receipt } }),
                  },
            value,
          });
          rebuiltBatches += 1;
          rebuiltCandidates += batch.candidates.length;
          return value;
        }),
    );
    // Native plans contain unique batch IDs, and the row loop retains every
    // current ID even for a rejected artifact. Equal cardinality therefore
    // proves there are no retired rows; only removals need a membership scan.
    if (this.preparedBatches.size > batchRows.length) {
      const live = new Set(batchRows.map((rows) => rows.source.batchId));
      for (const batchId of this.preparedBatches.keys()) {
        if (!live.has(batchId)) this.preparedBatches.delete(batchId);
      }
    }
    this.preparedBatchBuilds += rebuiltBatches;
    this.planRebuildBatches = rebuiltBatches;
    this.planRebuildCandidates = rebuiltCandidates;
    if (meshChanges !== undefined) scene.scene.noteMeshContentChanged(meshChanges);
    // Row memoization is independent of submission. Preserve all observed mesh
    // invalidation before refusing the candidate, so retry cannot hide changes
    // behind the rows already refreshed above. No filtered/GPU work is admitted.
    if (missingArtifact !== undefined) return err(missingArtifact);
    if (sameInputs && previous.plan === scene.plan && sameRows) {
      if (previous.meshResidencyEpoch !== meshResidencyEpoch)
        this.preparedCache = { ...previous, meshResidencyEpoch };
      return ok(previous.value);
    }
    this.gpuOwnedSnapshotsMaterialized = scene.slots.length;
    const value = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/plan/admission',
      () => assemblePreparedPlan(scene.plan, batchRows, scene.slots, scene.worldKeys),
    );
    this.preparedCache = {
      plan: scene.plan,
      slotAt: scene.slotAt,
      worldKeys: scene.worldKeys,
      scene: scene.scene,
      meshResidencyEpoch,
      batchRows,
      value,
    };
    return ok(value);
  }

  private shadowOwnershipSource(
    drawKeys: ReadonlySet<string> | undefined,
    membership: readonly ShadowCasterMembership[] | undefined,
  ): ShadowOwnershipSource {
    const cached = this.shadowOwnershipCache;
    const unrestricted = drawKeys === undefined && membership === undefined;
    if (
      cached !== undefined &&
      (unrestricted ? cached.claims === undefined : cached.claims?.matches(drawKeys, membership))
    )
      return cached;
    const claims = unrestricted ? undefined : new ShadowClaimTable(drawKeys, membership);
    const source: ShadowOwnershipSource = {
      casterKeys: claims?.casterKeys,
      ownsAllFor: undefined,
      ownsAll: false,
      claims,
    };
    this.shadowOwnershipCache = source;
    return source;
  }

  private observeShadowArtifacts(
    batches: readonly PreparedBatch[],
    artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  ): ShadowArtifactObservations {
    const previous = this.observedShadowArtifacts;
    const next = new Map<string, string | undefined>();
    let changed = false;
    for (const { batch, artifact: fallback } of batches) {
      const key = shadowMaterialKey(batch);
      const signature = shadowArtifactSignature(
        shadowArtifactForPreparedBatch(batch, artifacts, fallback),
      );
      next.set(key, signature);
      if (!previous.has(key) || previous.get(key) !== signature) changed = true;
    }
    if (changed || previous.size !== next.size) this.observedShadowArtifacts = next;
    return this.observedShadowArtifacts;
  }

  updateShadowViews(
    views: readonly ShadowViewRequest[],
    shadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    filtered: FilteredProductionPlan,
    scene: PersistentGpuDrivenState,
    shadowClaims: ShadowClaimTable | undefined,
    lod: LodProjectionState,
    lodPrepared: Parameters<typeof shadowLodProjectionState>[0],
    camera: CameraSnapshot,
    capsuleShadowDirectional: boolean,
    profilePhase?: RecordProfileRunner,
  ): Result<void, RhiError> {
    if (views.length === 0) return this.disableShadowViews();
    const artifacts = this.observeShadowArtifacts(
      filtered.materialBatches,
      shadowMaterialArtifacts,
    );
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
      this.shadowSourcePlan === undefined ||
      this.shadowScene === undefined
    ) {
      return ok(undefined);
    }
    const nextProjections = new Map<string, ReadonlyMap<number, GpuDrivenShadowBatchProjection>>();
    const nextShadowDrawKeysByView = new Map<string, ReadonlySet<string>>();
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
    const sceneTransformBuffer = scene.scene.transformBuffer;
    const sceneTransformBytes = scene.scene.rowCapacity * GPU_SCENE_LAYOUTS.transform.stride;
    const meshBinding = materialRaster.sceneMeshBindGroup(
      sceneTransformBuffer,
      sceneTransformBytes,
    );
    if (!meshBinding.ok) return meshBinding;
    const skinMeshBinding = this.skinRaster?.sceneMeshBindGroup(
      sceneTransformBuffer,
      sceneTransformBytes,
    );
    if (skinMeshBinding !== undefined && !skinMeshBinding.ok) return skinMeshBinding;
    const visibleBindingIdentity = materialRaster.visibleBindingIdentity;
    const skinVisibleBindingIdentity = this.skinRaster?.visibleBindingIdentity;
    const shadowViews = this.shadowViews;
    const shadowSourcePlan = this.shadowSourcePlan;
    const shadowScene = this.shadowScene;
    // assembleFilteredGroups owns these frozen batch records. Without LOD,
    // projection reads only their captured scalar fields and candidate lists;
    // no borrowed range getters can be skipped between views.
    const projectionSource = shadowSourcePlan.batches.every((batch) => batch.lod === undefined)
      ? shadowSourcePlan
      : undefined;
    const classes = runRecordProfilePhase(
      profilePhase,
      'record/gpu-driven-prepare/shadow-views/caster-classes',
      () => this.shadowCasterClasses.update(scene.slots, shadowScene, capsuleShadowDirectional),
    );
    const projectView = (
      { cameraCull, ...input }: ShadowViewRequest,
      inheritedClaims: ReadonlySet<string> | undefined,
      inheritedSource: ReadonlySet<string> | undefined,
    ): Result<ShadowViewUpdate['cache'], RhiError> =>
      runRecordProfilePhase(
        profilePhase,
        'record/gpu-driven-prepare/shadow-views/project-view',
        () => {
          const identityKey = shadowViewIdentityKey(input.identity);
          const previousProjections = this.shadowBatchProjections.get(identityKey);
          const previousClaims = this.shadowDrawKeysByView.get(identityKey);
          const previousSource =
            previousProjections === undefined
              ? undefined
              : this.shadowProjectionSources.get(previousProjections);
          // Membership already invalidates depth through the source plan and bounds.
          // A publication edit can leave both unchanged: observe only receipts this
          // view consumed, before its depth-cache decision, including unsubmitted work.
          const artifactsChanged =
            previousSource !== undefined &&
            previousSource.artifacts !== artifacts &&
            previousSource.plan.batches.some((batch) => {
              const key = shadowMaterialKey(batch);
              return artifacts.has(key) && previousSource.artifacts.get(key) !== artifacts.get(key);
            });
          if (artifactsChanged) shadowViews.invalidate('artifact-changed', input.identity);
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
            previousProjections !== undefined &&
            previousClaims !== undefined &&
            previousSource !== undefined &&
            sameShadowProjectionLayout(previousSource.plan, submission.plan) &&
            (previousSource.claims === shadowClaims || previousSource.filtered === filtered) &&
            sameBindings &&
            inheritedClaims === inheritedSource &&
            (previousSource.filtered === filtered ||
              submission.plan.batches.every((batch) => {
                preparedByBatch ??= new Map(
                  filtered.batches.map((entry) => [entry.batch.batchId, entry]),
                );
                return (
                  preparedByBatch.get(batch.batchId)?.mesh ===
                  previousProjections.get(batch.batchId)?.mesh
                );
              })) &&
            ((updated.value.cache === 'hit' && previousSource.claims === shadowClaims) ||
              submission.plan.batches.every((batch) => {
                const first = batch.candidates[0];
                const slot = first === undefined ? undefined : scene.slotAt(first.primitiveIndex);
                const material =
                  slot?.snapshot.materials[batch.key.materialSlot] ?? slot?.snapshot.material;
                const projection = previousProjections.get(batch.batchId);
                if (
                  first === undefined ||
                  slot === undefined ||
                  material === undefined ||
                  projection?.material !== material
                )
                  return false;
                if (previousSource.claims === shadowClaims) return true;
                // The accepted filtered plan proves the same claim keys and
                // admission, but entry names are consumed only here. Observe
                // each batch representative before retaining its map and the
                // view's claims; instance ordinals cannot change those values.
                const entry = shadowClaims?.claim(slot, first).entry;
                return (
                  projection.shadowVertexEntry === entry?.vertexEntry &&
                  projection.shadowFragmentEntry === entry?.fragmentEntry &&
                  (projection.shadowRenderState === entry?.renderState ||
                    JSON.stringify(projection.shadowRenderState) ===
                      JSON.stringify(entry?.renderState))
                );
              }))
          ) {
            previousSource.filtered = filtered;
            previousSource.claims = shadowClaims;
            previousSource.artifacts = artifacts;
            nextShadowDrawKeysByView.set(identityKey, previousClaims);
            nextProjections.set(identityKey, previousProjections);
            return ok(updated.value.cache);
          }
          nextShadowDrawKeysByView.set(
            identityKey,
            collectShadowViewClaims(
              updated.value.plan,
              scene,
              shadowClaims,
              filtered,
              inheritedClaims,
            ),
          );
          preparedByBatch ??= new Map(
            filtered.batches.map((entry) => [entry.batch.batchId, entry]),
          );
          const previousBatches = sameBindings ? previousSource.plan.batches : undefined;
          // A topology/depth revision can leave every physical draw projection unchanged.
          // Keep that publication without allocating and filling another complete map.
          let projections: Map<number, GpuDrivenShadowBatchProjection> | undefined =
            previousProjections !== undefined &&
            previousProjections.size === submission.plan.batches.length &&
            previousBatches?.every(
              (batch, index) => batch.batchId === submission.plan.batches[index]?.batchId,
            )
              ? undefined
              : new Map();
          let previousById: ReadonlyMap<number, GpuDrivenBatch> | undefined;
          let batchIndex = 0;
          for (const batch of submission.plan.batches) {
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
            const firstCandidate = batch.candidates[0];
            const firstSlot =
              firstCandidate === undefined
                ? undefined
                : scene.slotAt(firstCandidate.primitiveIndex);
            const material =
              firstSlot?.snapshot.materials[batch.key.materialSlot] ?? firstSlot?.snapshot.material;
            if (firstSlot === undefined || material === undefined) {
              return err(
                new RhiError({
                  code: 'internal-error',
                  expected: `material snapshot for shadow batch ${batch.batchId}`,
                  hint: 'keep the GPU-driven shadow material projection aligned with the retained slot',
                }),
              );
            }
            // The claim owns its consumed entry/state values. A new ownership
            // publication changes membership, not every physical draw binding.
            const shadowEntry =
              firstCandidate === undefined
                ? undefined
                : shadowClaims?.claim(firstSlot, firstCandidate).entry;
            const deformation = batch.prepared?.identity.deformation ?? 'rigid';
            const raster = deformation === 'skin' ? this.skinRaster : materialRaster;
            const projectedMeshBinding =
              deformation === 'skin' ? skinMeshBinding?.value : meshBinding.value;
            const batchArtifact = prepared.artifact;
            const artifactKey =
              previousSource?.artifacts === artifacts ? undefined : shadowMaterialKey(batch);
            const shadowArtifact = shadowArtifactForPreparedBatch(
              batch,
              shadowMaterialArtifacts,
              batchArtifact,
            );
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
            let previousBatch = previousBatches?.[batchIndex];
            batchIndex++;
            if (previousBatches !== undefined && previousBatch?.batchId !== batch.batchId) {
              previousById ??= new Map(previousBatches.map((entry) => [entry.batchId, entry]));
              previousBatch = previousById.get(batch.batchId);
            }
            const previousProjection = previousProjections?.get(batch.batchId);
            const previousFirst = previousBatch?.candidates[0];
            if (
              previousBatch?.batchId === batch.batchId &&
              previousBatch.visibleBase === batch.visibleBase &&
              (previousBatch.visibleAllocationCapacity ?? previousBatch.visibleCapacity) ===
                (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
              previousBatch.indirectOffset === batch.indirectOffset &&
              previousFirst?.primitiveIndex === firstCandidate?.primitiveIndex &&
              previousFirst?.generation === firstCandidate?.generation &&
              previousFirst?.drawItemIndex === firstCandidate?.drawItemIndex &&
              previousProjection?.mesh === prepared.mesh &&
              previousProjection.meshBindGroup === projectedMeshBinding &&
              previousProjection.deformation === deformation &&
              previousProjection.visibleBindGroups.length === batchLodLevelCount(batch) &&
              batchLevelStride(previousBatch) === batchLevelStride(batch) &&
              previousProjection.material === material &&
              previousProjection.materialEntityKey ===
                worldEntityKey(firstSlot.snapshot.worldId, firstSlot.snapshot.entityKey) &&
              previousProjection.shadowVertexEntry === shadowEntry?.vertexEntry &&
              previousProjection.shadowFragmentEntry === shadowEntry?.fragmentEntry &&
              (previousProjection.shadowRenderState === shadowEntry?.renderState ||
                JSON.stringify(previousProjection.shadowRenderState) ===
                  JSON.stringify(shadowEntry?.renderState)) &&
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
              meshBindGroup: projectedMeshBinding,
              visibleBindGroups,
              deformation,
              shadowArtifact,
              ...(shadowEntry?.renderState === undefined
                ? {}
                : { shadowRenderState: shadowEntry.renderState }),
              ...(shadowEntry?.vertexEntry === undefined
                ? {}
                : { shadowVertexEntry: shadowEntry.vertexEntry }),
              ...(shadowEntry?.fragmentEntry === undefined
                ? {}
                : { shadowFragmentEntry: shadowEntry.fragmentEntry }),
              material,
              materialEntityKey: worldEntityKey(
                firstSlot.snapshot.worldId,
                firstSlot.snapshot.entityKey,
              ),
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
          this.shadowProjectionSources.set(publishedProjections, {
            plan: submission.plan,
            filtered,
            claims: shadowClaims,
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
    for (const input of views) {
      retained.push(input.identity);
      if (!shadowViewHasStaticLayer(input.identity)) {
        const projected = projectView(input, undefined, undefined);
        if (!projected.ok) return projected;
        continue;
      }
      // The static layer holds settled casters and is re-rastered only when
      // one of them changes; the final layer copies it and adds the rest.
      const staticIdentity: ShadowViewIdentity = { ...input.identity, layer: 'static' };
      const viewClasses = restrictShadowCasterClasses(classes, input.candidatePrimitiveIndices);
      retained.push(staticIdentity);
      const staticProjected = projectView(
        {
          ...input,
          identity: staticIdentity,
          candidatePrimitiveIndices: viewClasses.staticSlots,
          ignoredChangeSlots: viewClasses.dynamicSet,
        },
        undefined,
        undefined,
      );
      if (!staticProjected.ok) return staticProjected;
      if (staticProjected.value === 'invalidated') {
        shadowViews.invalidate('static-layer-changed', input.identity);
      }
      const finalProjected = projectView(
        {
          ...input,
          candidatePrimitiveIndices:
            input.identity.kind === 'directional'
              ? viewClasses.directionalDynamicSlots
              : viewClasses.dynamicSlots,
        },
        nextShadowDrawKeysByView.get(shadowViewIdentityKey(staticIdentity)),
        this.shadowDrawKeysByView.get(shadowViewIdentityKey(staticIdentity)),
      );
      if (!finalProjected.ok) return finalProjected;
    }
    shadowViews.retain(retained);
    this.shadowBatchProjections = publishReadonlyMap(nextProjections);
    this.shadowDrawKeysByView = publishReadonlyMap(nextShadowDrawKeysByView);
    return ok(undefined);
  }

  private disableShadowViews(): Result<void, RhiError> {
    this.shadowViews?.retain([]);
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    this.shadowDrawKeysByView = publishReadonlyMap(new Map());
    return ok(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view?.dispose();
    this.view = undefined;
    this.materialRaster?.dispose();
    this.materialRaster = undefined;
    this.observedShadowArtifacts = new Map();
    this.skinRaster?.dispose();
    this.skinRaster = undefined;
    this.preparedCache = undefined;
    this.filteredCache = undefined;
    this.liveRasterCache = undefined;
    this.liveRasterBatches = [];
    this.shadowFilteredCache = undefined;
    this.mainFilterContributions.clear();
    this.shadowFilterContributions.clear();
    this.shadowOwnershipCache = undefined;
    this.surfaceFrameRangeCache = undefined;
    this.consumedSurfaceInput = undefined;
    this.rasterGraphIdentity.clear();
    this.residencyValidation.clear();
    this.cpuValidationTelemetryCache = undefined;
    this.shadowViews?.dispose();
    this.shadowViews = undefined;
    this.shadowSourcePlan = undefined;
    this.shadowScene = undefined;
    this.shadowBatchProjections = publishReadonlyMap(new Map());
    this.shadowDrawKeysByView = publishReadonlyMap(new Map());
    this.shadowExpectedDrawKeys = EMPTY_SHADOW_KEYS;
    this.skinPaletteBuffer = undefined;
    this.committedPaletteContentRevision = undefined;
    this.committedViewClipping = '';
    this.preparationFailure = undefined;
    this.surfaceArtifactInspection = undefined;
    this.overflowRecoveryRequired = false;
  }

  get resourceGeneration(): number | undefined {
    return this.view?.currentResourceGeneration;
  }

  inspect(): GpuDrivenProductionInspection {
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
      const claimed = this.shadowDrawKeysByView.get(key)?.size ?? 0;
      const total = Math.max(this.shadowExpectedDrawKeys.size, claimed);
      const effectiveClaimed = this.telemetryOverflow ? 0 : Math.min(claimed, total);
      const residual = Math.max(0, total - effectiveClaimed);
      if (total === 0) continue;
      // The final view can have no dynamic batches while its current
      // projection inherits valid claims from the retained static depth.
      // Admission counts that work regardless of whether it re-rasterizes.
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
        const failure = shadowOwnershipFailureInspection(viewPass);
        channels.push({
          viewPass,
          viewIndex: entry.identity.index,
          ...(entry.identity.face === undefined ? {} : { face: entry.identity.face }),
          lane: 'blocked',
          reason: this.telemetryOverflow ? 'overflow' : 'shadow-ownership',
          drawCount: residual,
          totalDrawCount: total,
          claimedDrawCount: effectiveClaimed,
          residualDrawCount: residual,
          failure,
        });
      }
    }
    return {
      ...(this.surfaceArtifactInspection === undefined
        ? {}
        : { surfaceArtifact: this.surfaceArtifactInspection }),
      residencyValidationScans: this.residencyValidation.scans,
      residencyValidationCacheHits: this.residencyValidation.hits,
      cpuValidationScans: this.cpuValidationScans,
      cpuValidationCacheHits: this.cpuValidationCacheHits,
      ...this.structureMetrics,
      surfaceFrameRangeBuilds: this.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans:
        this.surfaceFrameRangeMemberScans +
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
      planRebuildCandidates: this.planRebuildCandidates,
      lodSelectionChanges: this.lodSelectionChanges,
      shadowCasterFlips: this.shadowCasterClasses.inspect().flips,
      shadowCasterClassification: this.shadowCasterClasses.inspect(),
      shadowViews: this.shadowViews?.inspect() ?? [],
      shadowCasterPendingPromotions: this.shadowCasterClasses.inspect().pendingPromotions,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      candidateUploadBytes: this.telemetryPrepared ? (view?.candidateUploadBytes ?? 0) : 0,
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
            primitiveSlot: prepared.primitiveSlot,
            slotGeneration: prepared.slotGeneration,
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
      const slotAt = this.preparedCache?.slotAt;
      const filteredWorldKeys = this.filteredCache?.prepared.worldKeys;
      if (slotAt !== undefined) {
        for (const batch of filtered.plan.batches) {
          if (preparedByBatchId.has(batch.batchId)) continue;
          const candidate = batch.candidates[0];
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
            primitiveSlot: prepared.primitiveSlot,
            slotGeneration: prepared.slotGeneration,
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
            const slot = this.preparedCache?.slotAt(member.primitiveIndex);
            if (slot === undefined) return [];
            const frameRange = this.surfaceFrameRangeCache?.value.ranges.find(
              ({ directMember }) =>
                directMember.worldId === slot.worldId &&
                directMember.entityKey === slot.entityKey &&
                directMember.drawItemIndex === member.drawItemIndex &&
                directMember.instanceOrdinal === member.instanceOrdinal,
            );
            if (frameRange === undefined) return [];
            return [
              JSON.stringify([
                frameRange.directMember.worldIdentity,
                frameRange.directMember.entityKey,
                frameRange.directMember.drawItemIndex,
                frameRange.directMember.instanceOrdinal,
              ]),
            ];
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
   * Classify GPU ownership before submit. With a reuse token, changed material,
   * draw, claims or World routing facts must replace their identity or token.
   * Raw callers mutating those aliases omit the token.
   */
  recordCpuValidation(
    validated: readonly { readonly source: RenderableSnapshot }[],
    gpuOwnedDrawKeys: ReadonlySet<string>,
    cacheKey?: string,
    worldKeys?: readonly number[],
  ): GpuDrivenDrawReceipts {
    const cached = this.cpuValidationTelemetryCache;
    if (
      cacheKey !== undefined &&
      cached !== undefined &&
      cached.cacheKey === cacheKey &&
      sameValidatedSourceSequence(cached.validatedSources, validated) &&
      cached.gpuOwnedDrawKeys === gpuOwnedDrawKeys &&
      cached.worldKeys === worldKeys
    ) {
      this.applyCpuValidationTelemetry(cached);
      this.cpuValidationCacheHits += 1;
      return cached.drawReceipts;
    }
    this.cpuFallbackDrawItems = 0;
    this.cpuSemanticFallbackDrawItems = 0;
    this.cpuDeformationFallbackDrawItems = 0;
    this.cpuDeformationReasons.clear();
    this.blockedDrawItems = 0;
    let gpuOwnedRows = 0;
    let totalDrawItems = 0;
    const renderableIndices: number[] = [];
    const submeshIndices: number[] = [];
    const ownedDraws = new Map<RenderableSnapshot, readonly boolean[]>();
    const addDeformationReason = (
      reason: 'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    ): void => {
      this.cpuDeformationReasons.set(reason, (this.cpuDeformationReasons.get(reason) ?? 0) + 1);
    };
    let renderableIndex = -1;
    let row: (typeof validated)[number];
    let cpuResidual = false;
    let ownedCompactIndices: boolean[] | undefined;
    let capturedEntity: number | undefined;
    // One callback per validation invocation, shared across rows. Raw iteration
    // keeps native IteratorClose/next-method semantics; trusted rows stay dense.
    const classifyDraw = (draw: GpuDrivenDrawSnapshot, compactIndex: number): void => {
      const material = row.source.materials[draw.materialSlot] ?? row.source.material;
      let entity: number;
      if (cacheKey === undefined) {
        entity = worldEntityKey(
          worldKeys?.[row.source.worldId] ?? row.source.worldId,
          row.source.entityKey,
        );
      } else {
        capturedEntity ??= worldEntityKey(
          worldKeys?.[row.source.worldId] ?? row.source.worldId,
          row.source.entityKey,
        );
        entity = capturedEntity;
      }
      const materialHandle = material.materialHandle ?? -1;
      const submeshIndex = gpuDrivenSourceDrawItemIndex(draw, compactIndex);
      const key = gpuDrivenDrawKey(entity, materialHandle, submeshIndex);
      if (gpuOwnedDrawKeys.has(key)) {
        renderableIndices.push(renderableIndex);
        submeshIndices.push(submeshIndex);
        ownedCompactIndices ??= [];
        ownedCompactIndices[compactIndex] = true;
        return;
      }
      this.cpuFallbackDrawItems += 1;
      cpuResidual = true;
      const skinReason = skinLaneReason(row.source);
      if (skinReason !== undefined) {
        this.cpuDeformationFallbackDrawItems += 1;
        addDeformationReason(skinReason);
      } else if (draw.preparationError?.detail.recovery === 'route-cpu-lane') {
        // Geometry/UV incompatibility is an explicit semantic CPU lane,
        // not a failed capable submission.
        this.cpuSemanticFallbackDrawItems += 1;
      } else if (draw.preparationError?.detail.owner === 'skin') {
        this.cpuDeformationFallbackDrawItems += 1;
        addDeformationReason(
          draw.preparationError.detail.reason === 'skin-address-missing'
            ? 'skin-address-missing'
            : 'resource-not-ready',
        );
      } else if (draw.preparationError !== undefined) {
        this.blockedDrawItems += 1;
      } else {
        this.cpuSemanticFallbackDrawItems += 1;
      }
    };
    for (const currentRow of validated) {
      row = currentRow;
      renderableIndex++;
      const draws = row.source.gpuDrivenDraws ?? [];
      if (draws.length === 0) {
        totalDrawItems += 1;
        this.cpuFallbackDrawItems += 1;
        const skinReason = skinLaneReason(row.source);
        if (skinReason !== undefined) {
          this.cpuDeformationFallbackDrawItems += 1;
          addDeformationReason(skinReason);
        } else {
          this.cpuSemanticFallbackDrawItems += 1;
        }
        continue;
      }
      totalDrawItems += draws.length;
      cpuResidual = false;
      ownedCompactIndices = undefined;
      capturedEntity = undefined;
      if (cacheKey === undefined) {
        for (const [compactIndex, draw] of draws.entries()) classifyDraw(draw, compactIndex);
      } else {
        for (let compactIndex = 0; compactIndex < draws.length; compactIndex++) {
          classifyDraw(draws[compactIndex] as GpuDrivenDrawSnapshot, compactIndex);
        }
      }
      // A row is only CPU-validated when it still has a CPU residual. GPU-only
      // rows are already admitted by the concrete draw-key set and must not
      // inflate the per-frame CPU validation budget.
      if (ownedCompactIndices !== undefined) {
        if (cpuResidual) gpuOwnedRows += 1;
        ownedDraws.set(row.source, Object.freeze(ownedCompactIndices));
      }
    }
    this.gpuOwnedDrawItems = gpuOwnedDrawKeys.size;
    this.mainTotalDrawItems = totalDrawItems;
    this.validatedGpuOwnedRows = gpuOwnedRows;
    this.cpuValidationScans += 1;
    // Consume accepted indices after submit while retaining current row
    // wrappers on cache hits.
    const drawReceipts = Object.freeze({
      renderableIndices: Object.freeze(renderableIndices),
      submeshIndices: Object.freeze(submeshIndices),
      ownedDraws,
    });
    if (cacheKey !== undefined) {
      this.cpuValidationTelemetryCache = {
        cacheKey,
        validatedSources: validated.map((row) => row.source),
        gpuOwnedDrawKeys,
        worldKeys,
        gpuOwnedDrawCount: this.gpuOwnedDrawItems,
        totalDrawItems: this.mainTotalDrawItems,
        gpuOwnedRows: this.validatedGpuOwnedRows,
        cpuFallbackDrawItems: this.cpuFallbackDrawItems,
        cpuSemanticFallbackDrawItems: this.cpuSemanticFallbackDrawItems,
        cpuDeformationFallbackDrawItems: this.cpuDeformationFallbackDrawItems,
        cpuDeformationReasons: new Map(this.cpuDeformationReasons),
        blockedDrawItems: this.blockedDrawItems,
        drawReceipts,
      };
    }
    return drawReceipts;
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
