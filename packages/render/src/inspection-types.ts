import type { MaterialSurfacePassKind } from '@forgeax/engine-types';
import type { GBufferOrderDiagnosticInspection } from './gpu-driven/gbuffer-order-diagnostic';
import type { ShadowCasterClassInspection } from './gpu-driven/shadow-caster-classes';
import type { ShadowViewInspection } from './gpu-driven/shadow-views';
/**
 * Renderer-owned inspection PODs. Keeping these projections free of renderer
 * implementation imports prevents the observation contract from reopening the
 * extract/record dependency graph.
 */

import type { RenderGraphResourceAllocationInspection } from '@forgeax/engine-render-graph';
import { type BarrelDistortionMapping, freezeBarrelDistortionMapping } from './barrel-distortion';
import type { DirectionalShadowFilterLabel } from './components/directional-shadow-filter';
import type {
  GpuDrivenPreparationErrorCode,
  GpuDrivenPreparationErrorDetail,
} from './errors/gpu-driven';
import type { DepthOfFieldRequestFailure } from './features/depth-of-field/depth-of-field-params';
import type { PointsLinesInspection } from './points-lines/inspection';
import type { SsrAdmissionIdentity } from './ssr/identity';
import type { SsrSpatialInspection } from './ssr/inspection';
import type { SurfaceGpuIndirectParameters } from './surface/submission-observation';

export type {
  LodOcclusionInspection,
  LodOcclusionInspectionRow,
  LodOcclusionWorldAttribution,
  LodOcclusionWorldInspection,
} from './scene/visibility/inspection';

export type LodOcclusionReceiptViewState = 'rendered' | 'held';

/** One display Camera's identity and existing selector facts for a FrameReceipt. */
export interface LodOcclusionReceiptViewObservation {
  readonly viewKey: string;
  readonly entityKey: number;
  readonly eye?: import('./components/stereo-camera').StereoEye;
  readonly attachmentId: string;
  /** The Camera.historyVersion captured for this submitted view. */
  readonly viewGeneration: number;
  /** This view's graph generation; it is not the composite graph generation. */
  readonly graphGeneration: number;
  readonly state: LodOcclusionReceiptViewState;
  /** Present only when this view produced LOD facts for this receipt. */
  readonly lodOcclusion?: import('./scene/visibility/inspection').LodOcclusionInspection;
}

export type LodOcclusionReceiptUnavailableReason =
  | 'not-captured'
  | 'superseded'
  | 'empty-display-roster'
  | 'held-view'
  | 'attachment-unavailable'
  | 'lease-detached'
  | 'view-retired'
  | 'camera-generation-mismatch'
  | 'graph-generation-mismatch'
  | 'lod-readback-unavailable'
  | 'world-attribution-unavailable'
  | 'unsupported-lod-lane'
  | 'snapshot-too-large';

export type LodOcclusionReceiptCompleteViewObservation = Omit<
  LodOcclusionReceiptViewObservation,
  'state' | 'lodOcclusion'
> & {
  readonly state: 'rendered';
  readonly lodOcclusion: import('./scene/visibility/inspection').LodOcclusionInspection;
};

/** Detached, bounded LOD facts for every display view in one completed receipt. */
export type LodOcclusionReceiptObservation =
  | {
      readonly status: 'complete';
      readonly views: readonly LodOcclusionReceiptCompleteViewObservation[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: LodOcclusionReceiptUnavailableReason;
      readonly views: readonly LodOcclusionReceiptViewObservation[];
    };

/**
 * SSR M0 inspection is a detached projection of the consumer admission
 * result. The admission owner remains in `ssr/admission`; this re-export
 * keeps inspection callers on the same typed identity and status vocabulary.
 */
export type {
  SsrAdmissionBudget,
  SsrAdmissionResult,
  SsrAdmissionWork,
  SsrDependenciesInspection,
  SsrFormatReceipt,
  SsrReflectionFallbackReceipt,
  SsrTemporalReceipt,
} from './ssr/admission';
export type { SsrOwnerRecoveryAction } from './ssr/errors';
export type { SsrAdmissionIdentity } from './ssr/identity';
export type {
  SsrSpatialHistoryInspection,
  SsrSpatialInspection,
  SsrSpatialInspectionFailure,
  SsrSpatialInspectionProjection,
} from './ssr/inspection';

export interface LightInspectionInput {
  readonly generation: number;
  readonly candidate: string | undefined;
  readonly accepted: string | undefined;
  readonly lastKnownGood: string | undefined;
  readonly failure: string | undefined;
  readonly failureKeys: readonly string[];
  readonly resourceCount: number;
  readonly uploadBytes: number;
}

export type LightInspection = Readonly<LightInspectionInput>;

export function projectLightInspection(input: LightInspectionInput): LightInspection {
  return Object.freeze({
    generation: input.generation,
    candidate: input.candidate,
    accepted: input.accepted,
    lastKnownGood: input.lastKnownGood,
    failure: input.failure,
    failureKeys: [...input.failureKeys],
    resourceCount: input.resourceCount,
    uploadBytes: input.uploadBytes,
  });
}

export function lightInspectionIdentity(topology: string, generation: number): string {
  return `${topology}:generation-${generation}`;
}

export type BloomGraphStatus = 'empty' | 'valid' | 'invalid';

export interface BloomInspection {
  readonly graphStatus: BloomGraphStatus;
  readonly enabled: boolean;
  readonly levelCount: number;
  readonly levelDimensions: readonly { readonly width: number; readonly height: number }[];
  readonly horizontalPassCount: number;
  readonly verticalPassCount: number;
  readonly targetCount: number;
  readonly targetBytes: number;
  readonly resourceCount: number;
  readonly passCount: number;
  readonly encodeCount: number;
  readonly bindGroupCount: number;
  readonly uploadCount: number;
  /** Descriptor-derived bytes for the active Bloom target child in the compiled graph. */
  readonly residentChildBytes: number;
  readonly generation: number;
  readonly state: 'off' | 'active' | 'retiring';
}

export const emptyBloomInspection = (): BloomInspection => ({
  graphStatus: 'empty',
  enabled: false,
  levelCount: 0,
  levelDimensions: [],
  horizontalPassCount: 0,
  verticalPassCount: 0,
  targetCount: 0,
  targetBytes: 0,
  resourceCount: 0,
  passCount: 0,
  encodeCount: 0,
  bindGroupCount: 0,
  uploadCount: 0,
  residentChildBytes: 0,
  generation: 0,
  state: 'off',
});
export type { TransmissionInspection } from './transmission/inspection';

export interface BatchTopologyInspection {
  readonly windowCompactions?: number;
  readonly windowRelocations?: number;
  readonly revision: number;
  readonly batchCount: number;
  readonly candidateCount: number;
  readonly rebuilds: number;
  readonly patches: number;
  readonly ineligible: number;
  /** Content-only updates that advanced a batch contentEpoch in place. */
  readonly contentPatches?: number;
  /** Submission plan publications (cumulative). */
  readonly planBuilds?: number;
  /** Frozen batches re-published by those plan builds (cumulative). */
  readonly batchesRebuilt?: number;
  /** Number of retained-slot descriptor comparisons. */
  readonly membershipChecks?: number;
  /** Candidate membership records materialized by the owner. */
  readonly membershipAllocations?: number;
  readonly candidateAdds?: number;
  readonly candidateRemoves?: number;
  /** Distinct resource classes represented by this topology. */
  readonly resourceClassCount?: number;
  /** Resource-class groups; range/page changes do not create a new class. */
  readonly resourceClassSplits?: readonly {
    readonly resourceIdentity: string;
    readonly batchIds: readonly number[];
    readonly candidateCount: number;
  }[];
  /** Reasons emitted only when more than one resource class is present. */
  readonly resourceClassSplitReasons?: readonly string[];
}

/**
 * Logical Engine allocation facts in the RenderGraph vocabulary; physical VRAM
 * residency is intentionally unknown. Token ledgers own no imported or
 * byte-unknown handles, so those graph-only counters are absent.
 */
export type GpuResourceAllocationInspection = Omit<
  RenderGraphResourceAllocationInspection,
  'unknownByteSizeCount' | 'importedResourceCount'
>;

/**
 * Detached evidence for the declarative feature host and typed graph. These
 * counters are diagnostic projections only; they do not alter graph admission
 * or prepared-resource retirement semantics.
 */
export interface RenderFeatureHostInspection {
  /** Explicit experiment only: current preparation, not a GPU completion receipt. */
  readonly featureReadOnlyDepthBatchDiagnostic?: {
    readonly frameNumber: number;
    readonly generation: number;
    readonly stage: 'prepared';
    readonly scopes: number;
    readonly beforePasses: number;
    readonly afterPasses: number;
    readonly removedRasterPasses: number;
    readonly admittedPasses: number;
  };
  readonly signatures: readonly {
    readonly featureIdentity: string;
    readonly calls: number;
    readonly typedArrayBytes: number;
    readonly outputChars: number;
    /** Scoped private execution publications; zero/absent means the raw path. */
    readonly nativeCalls?: number;
    readonly cpuMs: number;
    /** Number of exact structural comparisons that reused a detached snapshot. */
    readonly cacheHits: number;
    /** Number of structural changes that allocated a new signature revision. */
    readonly cacheMisses: number;
  }[];
  readonly prepared: {
    readonly retained: number;
    readonly submitted: number;
    readonly released: number;
    readonly releaseFailures: number;
  };
}

export interface RenderFeatureGraphInspection {
  /** Monotonic revision of the last completely validated feature plan set. */
  readonly planRevision: number;
  readonly signatureValidationCalls: number;
  readonly signatureValidationBytes: number;
  readonly signatureValidationChars: number;
  readonly signatureValidationCpuMs: number;
  /** Number of plan validations satisfied by detached structural evidence. */
  readonly signatureValidationCacheHits: number;
  /** Number of plan validations that fell back to canonical serialization. */
  readonly signatureValidationCacheMisses: number;
  readonly ensureCalls: number;
  readonly reuseHits: number;
  readonly rebuildAttempts: number;
  readonly compileAttempts: number;
  readonly compileSuccesses: number;
  readonly compileFailures: number;
  readonly validationFailures: number;
  readonly buildFailures: number;
  readonly compileCpuMs: number;
  /** Build time for candidates that reached compile (excludes failed builds). */
  readonly buildCpuMs: number;
  /** Mutually exclusive first changed dependency; totals equal compileAttempts. */
  readonly compilePrimaryCauses: Readonly<Record<string, number>>;
  /** All changed dependencies; multiple entries can describe one compilation. */
  readonly compileChangedDependencies: Readonly<Record<string, number>>;
  readonly candidatesWithPreparedBatches: number;
  readonly preparedKeyChanges: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly abandoned: number;
  /** Separately compiled view-local work; Host signatures and preparation remain measured above. */
  readonly transientViewGraphs?: import('./features/transient-view-graph').TransientViewGraphInspection;
  readonly last: {
    readonly planSignature: string;
    readonly topologyKey: string | undefined;
    readonly preparedResourceKey: string | undefined;
  };
}

/**
 * Detached output-space barrel facts for the most recently accepted picture.
 * The mapping, extent, and generation fields are one context; consumers must
 * discard the whole projection when its device or frame is retired.
 */
export interface BarrelDistortionInspection {
  readonly effectiveMapping: BarrelDistortionMapping | undefined;
  readonly extent: { readonly width: number; readonly height: number } | undefined;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly lastKnownGood: boolean;
}

export interface BarrelDistortionInspectionInput {
  readonly effectiveMapping: BarrelDistortionMapping | undefined;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly lastKnownGood: boolean;
}

/** Project one immutable, public barrel frame context. */
export function projectBarrelDistortionInspection(
  input: BarrelDistortionInspectionInput,
): BarrelDistortionInspection {
  const effectiveMapping =
    input.effectiveMapping === undefined
      ? undefined
      : freezeBarrelDistortionMapping(input.effectiveMapping);
  return Object.freeze({
    effectiveMapping,
    extent:
      effectiveMapping === undefined
        ? undefined
        : Object.freeze({ width: effectiveMapping.width, height: effectiveMapping.height }),
    frameId: input.frameId,
    deviceGeneration: input.deviceGeneration,
    graphGeneration: input.graphGeneration,
    lastKnownGood: input.lastKnownGood,
  });
}

/** Detached material texture-source probe accounting for the last extract. */
export interface MaterialTextureSourceInspection {
  readonly sourceFieldsVisited: number;
  readonly producerRoutes: Readonly<Record<string, number>>;
}

export interface ProbeBlendRecordInspection {
  readonly objectKey: number;
  readonly generation: number;
  readonly localBlendFraction: number;
  readonly shPreblend: readonly number[];
  readonly byteLength: number;
  readonly candidate: boolean;
  readonly accepted: boolean;
  readonly lastKnownGood: boolean;
  readonly sentinel: string | undefined;
  readonly probeBlendIndex: number;
  readonly contributors: readonly {
    readonly identity: string;
    readonly distance: number;
    readonly radius: number;
    readonly coverage: number;
    readonly q: number;
    readonly qHat: number;
    readonly alpha: number;
  }[];
  readonly qHatSum: number;
  readonly rStar: number;
  readonly fallbackReason: string | undefined;
}

export interface ProbeSkyInspection {
  readonly available: boolean;
  readonly identity: string | undefined;
  readonly sourceKey: string | undefined;
  readonly irradiance: readonly [number, number, number];
  readonly fallbackReason: string | undefined;
}

export interface ProbeBlendInspection {
  readonly activeContributorCount: number;
  readonly admittedProbeCount: number;
  readonly coverage: number;
  readonly skyResidualFraction: number;
  readonly finite: boolean;
  readonly errorCode: 'capacity-exceeded' | 'invalid-admitted-prefix' | undefined;
  readonly records: readonly ProbeBlendRecordInspection[];
  readonly sky: ProbeSkyInspection;
  readonly dirtyVisitCount: number;
  readonly dirtyReasons: readonly string[];
  readonly receipt: {
    readonly activeIdentities: readonly string[];
    readonly admittedIdentities: readonly string[];
    readonly rejectedIdentities: readonly string[];
    readonly stableOrder: readonly string[];
    readonly capacity: number;
    readonly scaleRadius: number;
    readonly finite: boolean;
    readonly overflowReason: 'active-count-exceeds-capacity' | undefined;
  };
}

export interface GpuSceneTableInspection {
  readonly capacity: number;
  readonly bytes: number;
}

type GpuSceneTableName = 'primitive' | 'instance' | 'transform' | 'material';

export interface GpuSceneInspection {
  readonly capacity: number;
  readonly tables: Readonly<Record<GpuSceneTableName, GpuSceneTableInspection>>;
  readonly uploadRanges: number;
  readonly uploadBytes: number;
  readonly capacityGrows: number;
  readonly fullRebuilds: number;
  readonly clearedSlots: number;
  readonly noChangeFrames: number;
  /** Instance transform rows visited by instance-only updates; O(dirty rows) on the range path. */
  readonly instanceRowsVisited: number;
}

/**
 * Closed GPU-driven execution lanes exposed by the detached inspection
 * surface.  `cpu-semantic` keeps the existing material/authoring semantics,
 * while `cpu-deformation` is reserved for skin data that cannot be safely
 * represented by the GPU palette contract.  `blocked` means the renderer
 * refused to promote an incomplete candidate instead of silently changing
 * its meaning.
 */
export type GpuDrivenLane = 'gpu' | 'cpu-semantic' | 'cpu-deformation' | 'blocked';

/** Closed, machine-readable reasons for a lane decision or recovery state. */
export type GpuDrivenLaneReason =
  | 'none'
  | 'reflection-fallback-mrt'
  | 'capability'
  | 'unsupported'
  | 'resource-not-ready'
  | 'shadow-ownership'
  | 'capacity'
  | 'overflow'
  | 'stale-generation'
  | 'device-recovery'
  | 'skin-bounds-missing'
  | 'skin-address-missing';

/**
 * Detached producer failure facts carried by a blocked GPU lane. This keeps
 * owner and recovery machine-readable at the same boundary as the lane
 * decision; callers never need to parse an RhiError hint or shader name.
 */
export interface GpuDrivenPreparationFailureInspection {
  readonly code: GpuDrivenPreparationErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GpuDrivenPreparationErrorDetail;
}

/**
 * One bounded aggregate; never includes a per-draw/live renderer object.
 * Every count uses the same concrete `(drawItem, view-pass)` key unit. `drawCount`
 * is the count for this lane; the remaining fields make conservation explicit
 * when a view mixes GPU-owned and CPU-residual work.
 * These are logical admission counts, not visible draws or GPU commands.
 * Shadow claims include a retained static layer even when the final view
 * only copies that depth and performs no dynamic raster draw this frame.
 */
export interface GpuDrivenLaneSummary {
  readonly viewPass: 'main' | 'directional-shadow' | 'point-shadow' | 'spot-shadow';
  readonly viewIndex: number;
  readonly face?: number;
  readonly lane: GpuDrivenLane;
  readonly reason: GpuDrivenLaneReason;
  readonly drawCount: number;
  readonly totalDrawCount: number;
  readonly claimedDrawCount: number;
  readonly residualDrawCount: number;
  /** First bounded producer failure for a blocked lane, when available. */
  readonly failure?: GpuDrivenPreparationFailureInspection;
}

/**
 * Per-submission structural work projected by the existing RenderScene/GPU
 * Scene owners. These are frame deltas, not lifetime totals, so a stable
 * GPU-only frame is expected to report zero for every field.
 */
export interface GpuDrivenStructureMetrics {
  readonly worldEntitiesScanned: number;
  readonly sceneTableUploadBytes: number;
}

export interface GpuDrivenProductionInspection {
  /** Requested diagnostic and reference-order changes, never GPU execution counts. */
  readonly gbufferBatchOrderDiagnostic?: GBufferOrderDiagnosticInspection;
  /** Exact producer-selected Surface artifact prepared for the last candidate. */
  readonly surfaceArtifact?: {
    readonly material: string;
    readonly specializationKey: string | undefined;
    readonly variantSet: string | undefined;
    readonly layoutIdentity: string;
    readonly receiptIdentity: string;
    readonly receiptGeneration: number;
    readonly directEntry: string;
    readonly sceneIndexEntry: string;
  };
  /** Lifetime count of Surface member-to-frame projections rebuilt after a topology change. */
  readonly surfaceFrameRangeBuilds: number;
  /** Lifetime count of admitted Surface members visited while rebuilding that projection. */
  readonly surfaceFrameMemberScans: number;
  /** Lifetime count of 48-byte Surface frame rows materialized for an actual GPU write. */
  readonly surfaceFrameRowAllocations: number;
  /** Lifetime count of writes to the one renderer-owned shared Surface frame-time value. */
  readonly surfaceFrameTimeWrites: number;
  /** Lifetime count of CPU fallback telemetry traversals. */
  readonly cpuValidationScans: number;
  /** Lifetime count of CPU fallback telemetry cache hits. */
  readonly cpuValidationCacheHits: number;
  /** RenderScene candidate traversal performed for the last prepared frame. */
  readonly worldEntitiesScanned: number;
  /** GPU Scene table bytes uploaded for the last prepared frame. */
  readonly sceneTableUploadBytes: number;
  /** Successful CPU current/previous Skin matrix upload bytes for the last recording, including writes before failure; excludes task headers. GPU compute output is not a CPU upload. */
  readonly paletteUploadBytes: number;
  /** Scene snapshots prepared for admission; unchanged scenes report zero even when views move. */
  readonly gpuOwnedSnapshotsMaterialized: number;
  /** Main-view admission/LOD/binding projections rebuilt for the last frame. */
  readonly filteredPlanBuilds: number;
  /** Source batches whose prepared rows were re-derived for the last frame. */
  readonly preparedBatchBuilds: number;
  /** Source contributions projected (main plus shadow) for the last frame, excluding reused contributions and output group headers. */
  readonly filteredBatchBuilds: number;
  /** Submission-plan batches re-derived for the last frame; zero on a prepared-plan cache hit. */
  readonly planRebuildBatches: number;
  /** Submission-plan candidates re-derived for the last frame; zero on a prepared-plan cache hit. */
  readonly planRebuildCandidates: number;
  /**
   * LOD candidates whose selected raster levels changed since the previous
   * frame over the same prepared plan; a plan rebuild resets the baseline.
   */
  readonly lodSelectionChanges: number;
  /** Existing shadow casters that switched between the static and dynamic layer this frame. */
  readonly shadowCasterFlips: number;
  /** Classification attempts and population before per-view caster selection. */
  readonly shadowCasterClassification: ShadowCasterClassInspection;
  /** Prepared GPU view candidate/batch counts and dirty regions; submit decisions use shadowRaster. */
  readonly shadowViews: readonly ShadowViewInspection[];
  /** Settled dynamic shadow casters waiting for the next static-layer promotion window. */
  readonly shadowCasterPendingPromotions: number;
  readonly gpuOwnedEntityCount: number;
  readonly sharedInputUploadBytes: number;
  /** Dirty words of the per-view primitive suppression bitmap uploaded this frame. */
  readonly suppressionUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly batchBindGroupCreates: number;
  /** Lifetime physical window counters, including both rigid and skin adapters. */
  readonly submissionWindowRelocations?: number;
  readonly submissionVisibleCapacity?: number;
  readonly submissionReservedVisibleEntries?: number;
  readonly visibleBufferCapacity?: number;
  readonly submissionWindowCompactions?: number;
  /** Lifetime filtered assembly counters, separate from contribution projection. */
  readonly filteredAssemblyPublicationHits?: number;
  readonly filteredAssemblyHits?: number;
  readonly filteredAssemblyBuilds?: number;
  readonly filteredAssemblyChurnFallbacks?: number;
  readonly visibleWindowCreates?: number;
  readonly visibleWindowHits?: number;
  readonly visibleWindowResets?: number;
  readonly preparedBundleHits?: number;
  readonly preparedBundleBuilds?: number;
  readonly preparedBundleCommands?: number;
  readonly preparedBundleEvictions?: number;
  readonly viewBindGroupCreates: number;
  readonly topologyRevision: number | undefined;
  readonly validatedGpuOwnedRows: number;
  readonly cpuFallbackDrawItems: number;
  /** Index work accumulated by the real GPU LOD selector for the last submit. */
  readonly geometryWork: number;
  /** Level-0 index work for the same selected candidates. */
  readonly rootGeometryWork: number;
  /** `1 - geometryWork / rootGeometryWork` when the root denominator is non-zero. */
  readonly geometryWorkReduction: number;
  /** Number of selector batches in the last filtered production plan. */
  readonly batchCount: number;
  /** Number of non-zero-capacity indirect raster commands actually encoded. */
  readonly indirectDrawCount: number;
  /** Legacy name retained for existing GPU-driven evidence consumers. */
  readonly encodedIndirectDraws: number;
  /** Bounded view-pass lane aggregates for AI-readable recovery. */
  readonly channels: readonly GpuDrivenLaneSummary[];
  /** GPU resource generation used by the last prepared view, when resident. */
  readonly resourceGeneration: number | undefined;
  readonly candidateCapacity: number;
  readonly batchCapacity: number;
  readonly indirectCapacity: number;
  /** True when the last selector readback reported an incomplete result. */
  readonly overflow: boolean;
  /** Submission state for the current prepared candidate. */
  readonly submitted: boolean;
  /** Number of renderer-device recovery boundaries observed by this owner. */
  readonly recoveryCount: number;
  /** Number of staged candidates aborted before submit. */
  readonly retryCount: number;
  /** Generation of the last fully submitted GPU candidate, if any. */
  readonly lastKnownGoodGeneration: number | undefined;
  /** Aggregate logical allocation facts from available GPU-driven owners. */
  readonly resourceAllocation?: GpuResourceAllocationInspection;
  /** Per-owner facts; absent owners remain unavailable rather than zero-filled. */
  readonly resourceAllocationOwners?: {
    readonly gpuDrivenView?: GpuResourceAllocationInspection;
    readonly materialRaster?: GpuResourceAllocationInspection;
    readonly skinRaster?: GpuResourceAllocationInspection;
  };
  /** Resource-class split facts derived from batch.key.resourceIdentity. */
  readonly resourceClassCount?: number;
  readonly resourceClassSplitReasons?: readonly string[];
  readonly resourceClassSplits?: readonly {
    readonly resourceIdentity: string;
    readonly batchIds: readonly number[];
    readonly candidateCount: number;
  }[];
}

export type DirectionalShadowEffectiveProfile =
  | 'off'
  | DirectionalShadowFilterLabel
  | 'rhi-null-structural';

export type DirectionalShadowProfile = 'off' | DirectionalShadowFilterLabel;

export interface DirectionalShadowInspectionError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

/** Bounded, detached Directional shadow facts for AI-readable inspection. */
export interface DirectionalShadowInspection {
  readonly requested: DirectionalShadowProfile;
  readonly effective: DirectionalShadowEffectiveProfile;
  readonly status: 'accepted' | 'fallback' | 'rejected';
  readonly fallbackReason?: 'webgl2-unsupported' | 'rhi-null-structural' | 'candidate-failed';
  readonly lastKnownGood: boolean;
  readonly pixelEvidence: 'available' | 'not-available';
  readonly cascadeCount: number;
  readonly mapSize: number;
  readonly shadowMapBytes: number;
  readonly writerPasses: number;
  readonly blockerTaps: number;
  readonly filterTapUpperBound: number;
  readonly seamTapUpperBound: number;
  readonly shadowAngularRadius: number | undefined;
  readonly maxPenumbraTexels: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly error?: DirectionalShadowInspectionError;
}

export type ShadowViewKind = 'directional' | 'point' | 'spot';

export interface ShadowViewIdentity {
  readonly kind: ShadowViewKind;
  readonly index: number;
  /** Optional point-light index when `index` identifies the cube face. */
  readonly face?: number;
  /** A distinct directional output for one opaque Terrain receiver instance. */
  readonly terrainReceiver?: import('./terrain/shadow-family').TerrainShadowReceiver;
  /**
   * `'static'` names the retained layer holding only casters that have not
   * changed recently; the view itself (no layer) composes that layer with
   * skinned and recently changed casters, and is the layer receivers sample.
   */
  readonly layer?: 'static';
}

/**
 * Why a shadow view rastered instead of reusing its retained layer. Every
 * member names one real decision site; a hit carries no reason.
 */
export type ShadowViewInvalidationReason =
  /**
   * The layer's target holds no depth: a freshly compiled graph owns a new
   * target, or a renderer-owned static array was allocated or replaced.
   */
  | 'graph-compiled'
  /** Render-feature casters have no content revision the cache can prove. */
  | 'feature-draws'
  /** No cache owner exists for this view (point and spot views without a GPU pool). */
  | 'uncached'
  /** The view has never been published by a submitted frame. */
  | 'first-publication'
  /** The previous frame staged this view but its submit failed. */
  | 'submit-aborted'
  /** A shadow material program or layout publication was replaced. */
  | 'artifact-changed'
  /** The view draws an actual Skin task whose pose is produced per frame. */
  | 'skin-task-demand'
  /** The camera clipping that shadow casters honor changed. */
  | 'view-clipping-changed'
  /** The view's static layer rastered, so the composed layer is rebuilt from it. */
  | 'static-layer-changed'
  /** Map size, cascade count, filter quality, pipeline, or graph topology changed. */
  | 'configuration-changed'
  /** The shared scene, scene buffers, or physical view resources changed. */
  | 'source-changed'
  /** Caster content, World state, catalog, or mesh residency changed. */
  | 'content-changed'
  /** The set of casters admitted to this view changed. */
  | 'membership-changed'
  /** The light view-projection or culling planes changed. */
  | 'view-changed'
  /** The LOD projected heights for this view changed. */
  | 'lod-changed'
  /**
   * The retained layer omits casters the main camera saw no receivers of, so
   * it re-rasters without that cull before it may serve later frames.
   */
  | 'camera-culled';

/** Committed decisions since this view first appeared in the active roster. */
export interface ShadowCacheStatistics {
  readonly decisions: number;
  readonly hits: number;
  readonly rebuilds: number;
  readonly drawCount: number;
  readonly invalidations: Readonly<Partial<Record<ShadowViewInvalidationReason, number>>>;
}

/** CPU commands successfully encoded by one submitted shadow raster pass.
 * Bundle contents and GPU indirect visibility are intentionally not inferred. */
export interface ShadowWorkloadCommands {
  readonly directDraws: number;
  readonly directIndexedDraws: number;
  readonly indirectDraws: number;
  readonly indexedIndirectDraws: number;
  readonly bundleCalls: number;
  /** Known stock prepared bundles only; arbitrary bundle contents stay unobserved. */
  readonly knownBundleIndirectDraws: number;
  readonly knownBundleIndexedIndirectDraws: number;
  readonly directVertexInstances: number | null;
  readonly directIndexInstances: number | null;
}

export interface ShadowWorkloadPass {
  readonly identity: ShadowViewIdentity;
  /** Null on a cache hit: no physical raster pass executed. */
  readonly passName: string | null;
  readonly cache: 'hit' | 'miss';
  readonly invalidationReason?: ShadowViewInvalidationReason;
  readonly commands: ShadowWorkloadCommands;
  readonly indirectActual: 'unobserved';
  readonly bundleContents: 'unobserved';
  /** Historical readback with its own producer identity; never this pass's current work. */
  readonly lastCullingObservation?: import('./gpu-driven/view-gpu').GpuDrivenCullingObservation;
}

/** Frozen at successful submission, never reconstructed from latest inspection. */
export interface ShadowWorkloadObservation {
  readonly status: 'complete' | 'unavailable';
  readonly reason?: 'ui-only' | 'view-not-captured' | 'held-view' | 'observation-budget';
  readonly scope: 'display-views';
  /** Independent Renderer receipt identity, not the Source frame ID. */
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly views: readonly {
    readonly viewKey: string;
    readonly viewId: number;
    readonly attachmentId: string;
    readonly viewGeneration: number;
    readonly eye?: 'left' | 'right';
    readonly graphGeneration: number;
    readonly state: 'rendered' | 'held';
    readonly passes: readonly ShadowWorkloadPass[];
  }[];
}

/** One shadow view decision of the last submitted frame. */
export interface ShadowRasterViewInspection {
  readonly identity: ShadowViewIdentity;
  readonly cache: 'hit' | 'miss';
  readonly statistics: ShadowCacheStatistics;
  /** Present exactly when `cache === 'miss'`. */
  readonly invalidationReason?: ShadowViewInvalidationReason;
  /** Draw commands recorded by this view's raster pass; 0 on a hit. */
  readonly drawCount: number;
  /**
   * In-frustum casters the view's last observed GPU cull dropped as smaller
   * than its texel threshold (1 texel static layer, 2 texels composed layer).
   * Absent until a counter readback was observed or when the view has no
   * single texel size (perspective lights).
   */
  readonly texelCulled?: number;
  /**
   * Casters the view's last observed GPU cull skipped because the main-camera
   * HZB pyramid hides every receiver their shadow could reach. Present only on
   * final directional and spot views that rastered under that cull.
   */
  readonly cameraCulled?: number;
  /**
   * Present when the miss re-rastered only these many dirty regions over the
   * retained static layer instead of clearing it.
   */
  readonly dirtyRectCount?: number;
}

/** Shadow raster work of the last submitted frame. */
export interface ShadowRasterInspection {
  /** Shadow view raster passes that executed. */
  readonly passCount: number;
  /** Draw commands recorded across every executed shadow view pass. */
  readonly drawCount: number;
  readonly views: readonly ShadowRasterViewInspection[];
}

export type ReflectionProbeSelectionInspection =
  | { readonly kind: 'probe'; readonly worldId: number; readonly entityKey: number }
  | { readonly kind: 'skylight' };

export type ReflectionFallbackSource = 'probe' | 'skylight' | 'neutral';

export type ReflectionFallbackState = 'candidate' | 'active' | 'lkg' | 'neutral' | 'unavailable';

/** Detached committed fallback facts; never exposes a live GPU handle. */
export interface ReflectionFallbackReceipt {
  /** Device-scope owner that identifies the renderer transaction. */
  readonly rendererId?: string;
  /** Stable producer identity for this detached projection. */
  readonly producerId?: string;
  /** Stable main-pass renderable identity, when this is a per-renderable row. */
  readonly renderableKey?: string;
  /** Stable producer source identity, never a physical resource handle. */
  readonly sourceKey?: string;
  /** Frame number that produced this detached receipt. */
  readonly frameId?: number;
  readonly source: ReflectionFallbackSource;
  readonly sourceGeneration: number;
  readonly projectionGeneration: number;
  readonly deviceGeneration: number;
  readonly state: ReflectionFallbackState;
  readonly candidateVisible: false;
  readonly coverage: number;
  readonly extent?: readonly [number, number, number];
  readonly brdfSignature: string;
  /** Exact host identity of the detached producer transaction, when bound. */
  readonly identity?: SsrAdmissionIdentity;
}

/**
 * Completed fallback attachment proof, available only when the renderer opts
 * into captureReflectionFallbackReadback. Normal rendering publishes source
 * receipts after GPU completion without copying, mapping, or hashing pixels.
 *
 * This is an aggregate attachment fact, not a per-renderable row.  Row
 * receipts deliberately carry source/coverage identity only, so one pixel
 * cannot be mistaken for every renderable's BRDF result.
 */
export interface ReflectionFallbackReadbackReceipt {
  readonly rendererId: string;
  readonly producerId: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly linearHdr: readonly [number, number, number, number];
  readonly readbackHash: string;
  readonly readbackStatus: 'complete';
}

export type ReflectionFallbackFailureStage =
  | 'prepare'
  | 'filter'
  | 'build'
  | 'encode'
  | 'finish'
  | 'submit'
  | 'completion';

export type ReflectionFallbackRecoveryAction =
  | 'use-LKG'
  | 'use-Skylight'
  | 'use-neutral'
  | 'recapture'
  | 'rebuild'
  | 'retry';

export interface ReflectionFallbackInspection {
  readonly receipt: ReflectionFallbackReceipt;
  readonly failureStage?: ReflectionFallbackFailureStage;
  readonly failureCode?: string;
  readonly expected?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly recoveryAction: ReflectionFallbackRecoveryAction;
}

export interface ReflectionProbeInspection {
  readonly workBudgetPerFrame?: number;
  readonly updates?: readonly {
    readonly worldId: number;
    readonly entityKey: number;
    readonly intent: 'once' | 'on-change' | 'continuous';
    readonly activeGeneration: number;
    readonly requestedRevision: number;
    readonly capturedRevision: number;
    readonly pending: boolean;
    readonly captureStartedFrame: number;
    readonly lastCompletedFrame: number;
    readonly latencyFrames: number | undefined;
  }[];
  readonly selection: ReflectionProbeSelectionInspection;
  readonly factCount: number;
  readonly acceptedCount: number;
  readonly activeCount: number;
  readonly rawFacesCaptured: number;
  readonly filteredStepsCompleted: number;
  readonly filteredMipLevels: readonly number[];
  readonly scheduledRawFaces: number;
  readonly scheduledFilteredSteps: number;
  readonly pipelineReady: boolean;
  readonly pipelineWarmupAttempts: number;
  readonly pipelineWarmupFailure?: string;
  readonly reflectionFallback: ReflectionFallbackReceipt;
  /** Latest bounded fallback failure and owner-directed recovery action. */
  readonly reflectionFallbackInspection: ReflectionFallbackInspection;
  /** Bounded per-renderable projections; no live graph resources are included. */
  readonly reflectionFallbacks?: readonly ReflectionFallbackReceipt[];
  /** Completed frame attachment readback; separate from per-renderable rows. */
  readonly reflectionFallbackReadback?: ReflectionFallbackReadbackReceipt;
}

/** Detached semantic descriptor for the Standard scene-temporal producer. */
export interface TemporalTargetInspection {
  readonly identity: 'standard-scene-temporal';
  readonly producerId: 'forgeax::standard::scene-data';
  readonly schema: 'forgeax::scene-data::temporal-v1';
  readonly targetCount: 1;
  readonly descriptor: {
    readonly format: 'rgba16float';
    readonly width: number;
    readonly height: number;
    readonly sampleCount: 1;
    readonly bytes: number;
  };
}

/** Detached, bounded Motion Blur facts; no graph, device, target, or history handle. */
export type MotionBlurInspectionStatus = 'off' | 'active' | 'reset' | 'limited' | 'invalid';
export type MotionBlurInspectionLane = 'compute' | 'raster-limited';

/**
 * Submission receipt for the admitted compute lane. This is derived from the
 * compiled graph and the resolved feature dispatches after a successful
 * queue submit; capability intent alone never produces this receipt.
 */
export interface MotionBlurExecutionPass {
  readonly name: 'motion-blur-tile-summary' | 'motion-blur';
  readonly kind: 'compute';
  readonly entryPoint: 'tile_summary' | 'reconstruct';
  readonly workgroups: readonly [number, number, number];
}

export interface MotionBlurExecutionReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly program: 'motion-blur-compute';
  readonly outputFormat: 'rgba16float';
  readonly passes: readonly [MotionBlurExecutionPass, MotionBlurExecutionPass];
}

/** Bounded renderer-owned Depth of Field facts; no graph or GPU handles. */
export type DepthOfFieldInspectionStatus = 'off' | 'active' | 'reset' | 'invalid' | 'unsupported';

export interface DepthOfFieldInspection {
  readonly enabled: boolean;
  readonly status: DepthOfFieldInspectionStatus;
  readonly requested: {
    readonly focusDistance: number;
    readonly fStop: number;
    readonly sensorHeight: number;
    readonly maxRadiusPixels: number;
    readonly quality: 'low' | 'medium' | 'high';
    readonly blurSide: 'both' | 'near' | 'far';
  };
  readonly effective?: DepthOfFieldInspection['requested'];
  readonly focalLength: number;
  readonly outputExtent: { readonly width: number; readonly height: number };
  readonly workExtent: { readonly width: number; readonly height: number };
  readonly tapCount: 0 | 16 | 32 | 64;
  readonly passCount: number;
  readonly textureBytes: number;
  readonly transparentPolicy: 'opaque-depth-approximation';
  readonly graphGeneration: number;
  readonly deviceGeneration: number;
  readonly lastKnownGood: boolean;
  /** Structured authoring validation facts, when admission rejected the request. */
  readonly error?: DepthOfFieldRequestFailure;
  readonly fallbackReason?:
    | 'zero-radius'
    | 'orthographic-unsupported'
    | 'invalid-params'
    | 'shader-not-ready'
    | 'candidate-failed'
    | 'capability-unavailable'
    | undefined;
}

export interface MotionBlurInspection {
  readonly enabled: boolean;
  readonly status: MotionBlurInspectionStatus;
  /** Capability-selected implementation lane; raster is explicitly limited. */
  readonly lane: MotionBlurInspectionLane;
  readonly shutterAngle: number;
  readonly maxRadiusPixels: number;
  readonly sampleCount: number;
  /** Target presentation rate used by the accepted exposure calculation. */
  readonly targetFps: number;
  /** Bounded tier selected from the authored sample budget. */
  readonly effectiveSampleCount: 0 | 4 | 8 | 16;
  readonly temporalDemand: 'none' | 'scene-data-temporal-v1';
  readonly passName: 'motion-blur';
  readonly historyWrites: 0;
  /** Zero when demand is disabled; compute uses one summary plus one fused pass. */
  readonly passCount: 0 | 1 | 2;
  readonly tapBudget: 0 | 4 | 8 | 16;
  /** Present only when the current accepted frame executed both compute passes. */
  readonly execution?: MotionBlurExecutionReceipt;
  readonly resetReason?: import('./temporal/view').TemporalResetReason;
  readonly lastFailure?: 'invalid-params' | 'scene-data-unavailable' | 'submit-failure';
}

export type RenderSceneResyncReason =
  | 'attach'
  | 'asset-catalog-changed'
  | 'shared-ref-changed'
  | 'unsupported-change'
  | 'non-rigid-lane'
  | 'explicit-invalidate';

export interface PersistentRenderSceneInspection {
  readonly worldEntitiesScanned: number;
  readonly fullRebuilds: number;
  readonly noChangeFrames: number;
  readonly deltaFrames: number;
  readonly transformUpdates: number;
  readonly lastResyncReason: RenderSceneResyncReason | undefined;
  readonly projectionRecords: number;
  /** Allocation/cache evidence for instance bounds derivation. */
  readonly instanceBoundsCache?: {
    readonly hits: number;
    readonly misses: number;
    readonly derives: number;
    readonly invalidations: number;
    readonly rowUpdates: number;
    readonly nodeVisits: number;
  };
  /** Numeric probe ownership facts; no GPU handles or object graph references. */
  readonly probeBlend?: ProbeBlendInspection;
  readonly topology: BatchTopologyInspection;
  readonly gpu:
    | { readonly status: 'inactive' }
    | { readonly status: 'unsupported'; readonly reason: 'storage-buffer-unavailable' }
    | ({ readonly status: 'resident' } & GpuSceneInspection)
    | { readonly status: 'rebuild-pending' }
    | { readonly status: 'error' };
  /** Bounded retained authoring observations; no graph or backend handles. */
  readonly pointsLines: readonly PointsLinesInspection[];
  /** Last actually encoded Surface work, fenced by the renderer submission owner. */
  readonly submission?: {
    readonly sequence: number;
    readonly frameId: number;
    readonly requestedLane: 'direct' | 'gpu-driven';
    readonly actualLane: 'direct' | 'gpu-driven';
    /** Current-frame topology fact when a normal GPU lane was intentionally bypassed. */
    readonly actualLaneReason?: GpuDrivenLaneReason;
    readonly deviceGeneration: number;
    readonly graphGeneration: number;
    readonly viewIdentity: 'main:0';
    readonly resourceGeneration: number | undefined;
    readonly status: 'submitted' | 'completed';
    readonly passes: readonly {
      readonly pass: MaterialSurfacePassKind;
      /** Total commands actually encoded, including rows beyond the bounded sample. */
      readonly commandCount: number;
      readonly totalCommandCount: number;
      readonly savedCommandCount: number;
      readonly droppedCommandCount: number;
      readonly truncated: boolean;
      readonly memberEvidence:
        | 'direct-command-members'
        | 'direct-command-members-truncated'
        | 'indirect-readback-required'
        | 'indirect-visible-readback'
        | 'indirect-visible-readback-truncated';
      readonly memberIds?: readonly string[];
      /** Decoded GPU command words bound to this submission/readback fence. */
      readonly indirectParameters?: readonly SurfaceGpuIndirectParameters[];
      readonly commands: readonly (
        | {
            readonly kind: 'draw' | 'draw-indexed';
            readonly count: number;
            readonly first: number;
            readonly instanceCount: number;
            readonly firstInstance: number;
            readonly surfaceFrameBase: number;
            readonly memberIds: readonly string[];
            readonly pipelineIdentity: number;
            readonly programEvidence: 'producer-receipt' | 'missing';
            readonly receiptIdentity?: string;
            readonly receiptGeneration?: number;
          }
        | {
            readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
            readonly indirectBufferIdentity: number;
            readonly indirectOffset: number;
            readonly pipelineIdentity: number;
            readonly programEvidence: 'producer-receipt' | 'missing';
            readonly receiptIdentity?: string;
            readonly receiptGeneration?: number;
          }
      )[];
    }[];
  };
}

/** Lifetime hit/miss counts of one per-frame cache; sample twice for a rate. */
export interface FrameCacheCounters {
  readonly hits: number;
  readonly misses: number;
}

/**
 * Per-frame cache evidence. Keys are input revisions, never the frame index,
 * so a camera-only frame is expected to hit every cache except where noted:
 * - `visibilityProjection`: one lookup per primary view projection; keyed on
 *   the culled visible set, facet draw revision and stable slot identity.
 * - `temporalSnapshots`: actual consumed temporal reads, including repeated query consumers.
 * - `transparentSort`: one lookup per frame with more than one transparent
 *   entry; a hit reuses the previous order after an O(n) order check against
 *   the current camera.
 * - `renderBundles`: one lookup per recorded command segment of a
 *   bundle-eligible scene pass; a miss re-records only that segment.
 */
export interface MaterialUniformCacheInspection {
  readonly packHits: number;
  readonly packMisses: number;
  readonly uploadRanges: number;
  readonly uploadedLogicalBytes: number;
  readonly skippedUploads: number;
}

export interface RenderFrameCacheInspection {
  readonly materialUniforms?: MaterialUniformCacheInspection;
  readonly materialPipelineRequests?: FrameCacheCounters & { readonly keyCharacters: number };
  readonly visibilityProjection: FrameCacheCounters;
  readonly temporalSnapshots: FrameCacheCounters;
  readonly transparentSort: FrameCacheCounters;
  readonly renderBundles: FrameCacheCounters;
}

export type RenderSceneInspection = PersistentRenderSceneInspection & {
  readonly gpuDriven: GpuDrivenProductionInspection;
  readonly frameCaches: RenderFrameCacheInspection;
};

export interface CameraViewInspection {
  readonly bloom: BloomInspection;
  readonly ssr: SsrSpatialInspection;
  readonly dynamicResolution:
    | import('./pipeline/dynamic-resolution').DynamicResolutionInspection
    | undefined;
  readonly entityKey: number;
  /** Present on the derived eye views of a StereoCamera. */
  readonly eye?: import('./components/stereo-camera').StereoEye;
  readonly viewport: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
  readonly renderedFrames: number;
  readonly output: 'screen' | 'texture';
  readonly passes: readonly string[];
  readonly temporal: import('./temporal/inspection').TemporalInspection;
  readonly frustum: { readonly total: number; readonly culled: number };
  readonly visibility: { readonly explicitlyHidden: number };
  /** This view's diffuse GI lane; field budgets are split across views (`share`). */
  readonly diffuseGi?: import('./render-contract').RenderInspection['diffuseGi'];
}
