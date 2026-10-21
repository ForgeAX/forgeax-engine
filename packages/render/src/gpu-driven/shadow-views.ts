import type { box3 } from '@forgeax/engine-math';
import { frustum } from '@forgeax/engine-math';
import {
  type GraphAccess,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Result, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { SHADOW_RASTER_GUARD_TEXELS } from '../components/directional-shadow-filter';
import type { GpuScene } from '../gpu-scene';
import type { ShadowViewIdentity, ShadowViewInvalidationReason } from '../inspection-types';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import {
  type ShadowMaterialContent,
  sameShadowMaterialFrames,
} from '../scene/material-shadow-content';
import { ShadowDepthLayers } from '../shadow-depth-layers';
import { captureBatchLod } from './batch-execution';
import { batchVisibleSpan } from './batch-layout';
import {
  buildBatchAlignedSubmission,
  buildSubmissionCandidateMembership,
  type GpuDrivenBatch,
  type GpuDrivenCandidate,
  type SubmissionCandidateMembershipEntry,
  type SubmissionMembershipWork,
  type SubmissionPlan,
} from './batch-topology';
import { GpuDrawSelection } from './draw-selection';
import { inheritTaskHeaders } from './fixed-task-plan';
import type { LodViewCamera } from './lod-projection.wgsl';
import { ShadowSlotSelection } from './shadow-caster-classes';
import { sameShadowLodLevels, shadowLodLevels } from './shadow-lod-selections';
import {
  type GpuDrivenCullingObservation,
  type GpuDrivenLodSubmitIdentity,
  type GpuDrivenShadowCameraCull,
  GpuDrivenView,
  type GpuDrivenViewGraphResources,
} from './view-gpu';

export type { ShadowViewIdentity, ShadowViewKind } from '../inspection-types';

export type ShadowViewCacheState = 'hit' | 'invalidated';

export interface ShadowViewUpdateInput {
  /** Final depth includes direct casters; fixed shared root covers even non-GPU geometry. */
  readonly directMaterials?: import('../scene/material-dispatch').MaterialFrame;
  readonly shadowMaterials?: ShadowMaterialContent;
  readonly identity: ShadowViewIdentity;
  readonly casterChannels?: number | undefined;
  readonly sourcePlan: SubmissionPlan;
  readonly scene: GpuScene;
  readonly inputReads: import('../gpu-scene-inputs').GpuInputReadFrame;
  readonly planes: Float32Array;
  /** Light view-projection; a value change invalidates the view as `view-changed`. */
  readonly matrix?: Float32Array;
  /** Shadow target edge; a change invalidates the view as `configuration-changed`. */
  readonly targetSize?: number | undefined;
  /**
   * Accepted graph generation. A replacement graph imports new resource
   * projections, so the view refreshes its compute inputs once.
   */
  readonly graphGeneration?: number;
  readonly candidatePrimitiveIndices?:
    | readonly number[]
    | ReadonlySet<number>
    | ShadowSlotSelection;
  /** Main camera whose projection selects LOD levels inside the GPU cull. */
  readonly lodCamera?: LodViewCamera;
  /** CPU mirror of the main-camera heights; only drives `lod-changed` invalidation. */
  readonly lodProjectedHeights?: ReadonlyMap<number, number>;
  /**
   * Discrete LOD levels the heights select. Retained depth is re-rastered
   * only when a level changes; continuous height motion inside a level would
   * only move the cross-fade dither and does not invalidate the view.
   */
  readonly lodSelection?: string;
  /**
   * Reference camera the view's selection stays within
   * `SHADOW_LOD_MAX_COARSER` levels of. A clamped static layer keeps finer
   * retained levels and re-rasters only casters now too coarse for it.
   */
  readonly lodClampCamera?: LodViewCamera;
  /**
   * Slots whose changes this view never draws, e.g. dynamic casters for a
   * static layer. Their boxes do not invalidate the view.
   */
  readonly ignoredChangeSlots?: ReadonlySet<number>;
  /**
   * Main-camera occlusion for a final directional or spot view: a caster whose
   * dilated receiver volume the camera pyramid proves hidden is not drawn. The
   * light matrix comes from `matrix`; other views ignore the input.
   */
  readonly cameraCull?: Omit<GpuDrivenShadowCameraCull, 'lightViewProjection'>;
}

export interface ShadowViewUpdate {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly sourcePlan: SubmissionPlan;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
}

export interface ShadowViewProjection {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
  readonly passNames: readonly string[];
  readonly graphResources: GpuDrivenViewGraphResources | undefined;
}

const viewSelections = new WeakMap<SubmissionPlan, GpuDrawSelection>();

export interface ShadowViewSubmission {
  readonly selection: GpuDrawSelection;
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
}

export interface ShadowViewInspection {
  /** Successful view cache decisions and work in retained-content comparison paths. */
  readonly preparation?: Readonly<ShadowPreparationCounters>;
  readonly shadowBundles?: Readonly<import('./prepared-raster-bundle').PreparedRasterCounters>;
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  /** Present exactly when `cache === 'invalidated'`. */
  readonly invalidationReason?: ShadowViewInvalidationReason;
  readonly generation: number;
  readonly sourceRevision: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly resourceGeneration: number;
  /** World-space caster diameter below which the view skips a caster; 0 disables. */
  readonly minCasterDiameter: number;
  /** In-frustum casters the last observed GPU cull dropped below that diameter. */
  readonly texelCulled?: number;
  /** Casters the last raster skipped because the main camera sees none of their receivers. */
  readonly cameraCulled?: number;
  /** Last successful existing GPU readback, with its own producer identity; may precede this view. */
  readonly lastCullingObservation?: GpuDrivenCullingObservation;
  /** Present when a static layer's miss re-rasters only these regions. */
  readonly dirtyRects?: readonly ShadowDirtyRect[];
}

/**
 * A region of a static shadow layer to re-raster, in normalized target
 * coordinates: x right and y down, `[x0, x1) x [y0, y1)` within `[0, 1]`.
 */
export interface ShadowDirtyRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface SceneBuffers {
  readonly primitive: GpuScene['primitiveBuffer'];
  readonly instance: GpuScene['instanceBuffer'];
  readonly transform: GpuScene['transformBuffer'];
}

export interface ShadowPreparationCounters extends SubmissionMembershipWork {
  cacheHits: number;
  cacheRebuilds: number;
  cacheRebuildReasons: Partial<Record<ShadowViewInvalidationReason, number>>;
  planComparisons: number;
  batchChecks: number;
  candidateScans: number;
  primitiveChecks: number;
}

interface ShadowViewRecord {
  readonly preparation: ShadowPreparationCounters;
  readonly identity: ShadowViewIdentity;
  readonly view: GpuDrivenView;
  sourcePlan: SubmissionPlan;
  plan: SubmissionPlan;
  scene: GpuScene;
  /** Current preparation only; cleared at seal/abort, never a retained depth dependency. */
  frameInput: { input: ShadowViewUpdateInput; plan: SubmissionPlan; bound: boolean } | undefined;
  matrix: Float32Array | undefined;
  targetSize: number | undefined;
  graphGeneration: number | undefined;
  contentRevision: number;
  directMaterials: ShadowViewUpdateInput['directMaterials'];
  shadowMaterials: ShadowMaterialContent | undefined;
  planes: Float32Array;
  candidateSource: ShadowViewUpdateInput['candidatePrimitiveIndices'];
  candidates: ShadowCandidates | undefined;
  /** Geometry ranges survive Pass removal while this view's caster class stays fixed. */
  readonly memberships: WeakMap<FrameList<GpuDrivenCandidate>, FrameList<GpuDrivenCandidate>>;
  lodSelection: string | undefined;
  lodProjectedHeights: ReadonlyMap<number, number> | undefined;
  /** The plan draws skinned casters, so a skin palette change reaches it. */
  skinned: boolean;
  generation: number;
  cache: ShadowViewCacheState;
  invalidationReason: ShadowViewInvalidationReason | undefined;
  invalidated: boolean;
  published: boolean;
  resourceGeneration: number;
  visibleBuffer: GpuDrivenView['visibleBuffer'];
  sceneBuffers: SceneBuffers;
  minCasterDiameter: number;
  texelCulled: number | undefined;
  /** The retained depth omits camera-hidden casters, so it is valid only for that camera. */
  cameraCull: boolean;
  cameraCulled: number | undefined;
  lastCullingObservation: GpuDrivenCullingObservation | undefined;
  /** A partial static-layer miss: only these regions re-raster. */
  dirtyRects: readonly ShadowDirtyRect[] | undefined;
}

function identityKey(identity: ShadowViewIdentity): string {
  return `${identity.kind}:${identity.index}:${identity.face ?? ''}${
    identity.layer === undefined ? '' : `:${identity.layer}`
  }${identity.terrainReceiver === undefined ? '' : `:terrain:${identity.terrainReceiver.worldId}:${identity.terrainReceiver.entityKey}`}`;
}

export function shadowViewIdentityKey(identity: ShadowViewIdentity): string {
  return identityKey(identity);
}

function validateIdentity(identity: ShadowViewIdentity): RhiError | undefined {
  if (!Number.isInteger(identity.index) || identity.index < 0) {
    return new RhiError({
      code: 'internal-error',
      expected: 'shadow view index is a non-negative integer',
      hint: 'publish a stable directional cascade, point face, or spot atlas index',
    });
  }
  if (
    identity.face !== undefined &&
    (!Number.isInteger(identity.face) || identity.face < 0 || identity.face > 5)
  ) {
    return new RhiError({
      code: 'internal-error',
      expected: 'point shadow face is an integer from 0 through 5',
      hint: 'publish a valid cube face for the point shadow view',
    });
  }
  if (identity.layer !== undefined && identity.layer !== 'static') {
    return new RhiError({
      code: 'internal-error',
      expected: "shadow view layer is omitted or 'static'",
      hint: 'publish the final view without a layer and its cached caster layer as static',
    });
  }
  return undefined;
}

const PLANE_FLOATS = 24;
/**
 * A single projected texel bounds subpixel caster suppression in every layer. The
 * texel edge is exact for an orthographic light; a perspective light has no
 * single texel size, so it keeps every caster.
 */
export function shadowMinCasterDiameter(
  matrix: Float32Array | undefined,
  targetSize: number | undefined,
): number {
  if (matrix === undefined || targetSize === undefined || targetSize <= 0) return 0;
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) return 0;
  const scaleX = Math.hypot(matrix[0] ?? 0, matrix[4] ?? 0, matrix[8] ?? 0);
  if (!(scaleX > 0)) return 0;
  // Static/dynamic membership is a cache policy, not a visibility policy.
  // Changing class must not remove a shadow the static layer previously drew.
  return 2 / (scaleX * targetSize);
}

function planesError(): RhiError {
  return new RhiError({
    code: 'internal-error',
    expected: 'shadow view publishes six clipping planes',
    hint: 'provide a 24-float frustum plane array before updating the view',
  });
}

function samePrefix(left: Float32Array, right: Float32Array, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameMatrix(left: Float32Array | undefined, right: Float32Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && samePrefix(left, right, left.length);
}

type ShadowCandidates = readonly number[] | FrameSet | ShadowSlotSelection;

function sameCandidates(
  left: ShadowCandidates | undefined,
  right: ShadowCandidates | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (ShadowSlotSelection.isFixed(left) && ShadowSlotSelection.isFixed(right))
    return left.same(right);
  if (
    ShadowSlotSelection.isFixed(left) ||
    ShadowSlotSelection.isFixed(right) ||
    FrameSet.isFixed(left) ||
    FrameSet.isFixed(right)
  )
    return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sceneBuffers(scene: GpuScene): SceneBuffers {
  return {
    primitive: scene.primitiveBuffer,
    instance: scene.instanceBuffer,
    transform: scene.transformBuffer,
  };
}

function sameSceneBuffers(left: SceneBuffers, right: GpuScene): boolean {
  return (
    left.primitive === right.primitiveBuffer &&
    left.instance === right.instanceBuffer &&
    left.transform === right.transformBuffer
  );
}

function candidateIndices(
  values: ShadowViewUpdateInput['candidatePrimitiveIndices'],
): Result<ShadowCandidates | undefined, RhiError> {
  if (values === undefined || FrameSet.isFixed(values) || ShadowSlotSelection.isFixed(values))
    return ok(values);
  const entries = Array.from(values);
  for (const entry of entries) {
    if (!Number.isInteger(entry) || entry < 0) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'shadow candidate primitive indices are non-negative integers',
          hint: 'derive ShadowCaster membership from the shared BatchTopology channel index',
        }),
      );
    }
  }
  return ok(Object.freeze([...new Set(entries)].sort((left, right) => left - right)));
}

/** Actual raw query captures one fixed execution; the record itself is its old-value witness. */
function captureExecution(source: SubmissionPlan, scene: GpuScene): SubmissionPlan {
  const batches = source.batches.map((batch): GpuDrivenBatch => {
    const lod = captureBatchLod(batch);
    const binding = batch.binding === undefined ? undefined : Object.freeze({ ...batch.binding });
    return Object.freeze({
      ...batch,
      key: Object.freeze({ ...batch.key }),
      ...(binding === undefined ? {} : { binding }),
      materialAddress:
        batch.materialAddress ??
        (binding === undefined ? 0 : (scene.materialIndexForResource(binding.material) ?? 0)),
      geometryAddress:
        batch.geometryAddress ??
        (binding === undefined
          ? 0
          : (scene.geometryIndexForResource(binding.worldId, binding.assetHandle) ?? 0)),
      ...(batch.prepared === undefined
        ? {}
        : {
            prepared: Object.freeze({
              ...batch.prepared,
              identity: Object.freeze({ ...batch.prepared.identity }),
            }),
          }),
      ...(lod === undefined ? {} : { lod }),
      candidates: Object.freeze(
        batch.candidates.map((candidate) =>
          Object.freeze({
            primitiveIndex: candidate.primitiveIndex,
            generation: candidate.generation,
            drawItemIndex: candidate.drawItemIndex,
            instanceOrdinal: candidate.instanceOrdinal,
          }),
        ),
      ),
    });
  });
  return Object.freeze({
    revision: source.revision,
    candidateCount: source.candidateCount,
    visibleCapacity: source.visibleCapacity,
    batches: Object.freeze(batches),
  });
}

function projectPlan(
  source: SubmissionPlan,
  primitiveIndices: ShadowCandidates | undefined,
): SubmissionPlan {
  if (primitiveIndices === undefined) return source;
  const membership = buildSubmissionCandidateMembership(source);
  const candidatesByBatch = new Map<number, GpuDrivenCandidate[]>();
  const indices = ShadowSlotSelection.isFixed(primitiveIndices)
    ? [...membership.byPrimitiveIndex.keys()].sort((a, b) => a - b)
    : primitiveIndices;
  for (const primitiveIndex of indices) {
    if (ShadowSlotSelection.isFixed(primitiveIndices) && !primitiveIndices.has(primitiveIndex))
      continue;
    for (const entry of membership.byPrimitiveIndex.get(primitiveIndex) ?? []) {
      let candidates = candidatesByBatch.get(entry.batch.batchId);
      if (candidates === undefined) {
        candidates = [];
        candidatesByBatch.set(entry.batch.batchId, candidates);
      }
      candidates.push(entry.candidate);
    }
  }
  // The aligned submission owns its frozen candidate copies.
  return buildBatchAlignedSubmission(source, candidatesByBatch);
}

function containsCandidate(indices: ShadowCandidates, slot: number): boolean {
  if (FrameSet.isFixed(indices) || ShadowSlotSelection.isFixed(indices)) return indices.has(slot);
  let start = 0,
    end = indices.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2),
      value = indices[middle];
    if (value === slot) return true;
    if (value !== undefined && value < slot) start = middle + 1;
    else end = middle;
  }
  return false;
}

/** Project captured topology without reconstructing its primitive-to-batch join. */
function projectOwnedPlan(
  source: SubmissionPlan,
  primitiveIndices: ShadowCandidates,
  memberships: ShadowViewRecord['memberships'],
): SubmissionPlan {
  // The public projection groups candidates by sorted primitive index. A producer
  // permutation must retain that ordering rather than silently changing GPU rows.
  const batches: GpuDrivenBatch[] = [];
  let candidateCount = 0;
  let visibleCapacity = 0;
  for (const batch of source.batches) {
    const retained = memberships.get(batch.candidates);
    if (retained !== undefined) {
      if (retained.length === 0) continue;
      batches.push(
        retained === batch.candidates ? batch : Object.freeze({ ...batch, candidates: retained }),
      );
      candidateCount += retained.length;
      visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
      continue;
    }
    let selected: GpuDrivenCandidate[] | undefined;
    let previous = -1;
    let ordinal = 0;
    for (const candidate of batch.candidates) {
      const index = ordinal++;
      if (candidate.primitiveIndex < previous) return projectPlan(source, primitiveIndices);
      previous = candidate.primitiveIndex;
      if (containsCandidate(primitiveIndices, candidate.primitiveIndex)) {
        selected?.push(candidate);
      } else if (selected === undefined) {
        selected = batch.candidates.slice(0, index);
      }
    }
    const candidates = selected === undefined ? batch.candidates : Object.freeze(selected);
    memberships.set(batch.candidates, candidates);
    if (candidates.length === 0) continue;
    batches.push(selected === undefined ? batch : Object.freeze({ ...batch, candidates }));
    candidateCount += candidates.length;
    visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
  }
  // Keep a fresh plan for aborted/replaced physical views even when every
  // candidate is selected. The immutable rows remain owned by the source.
  return inheritTaskHeaders(
    source,
    Object.freeze({
      revision: source.revision,
      batches: Object.freeze(batches),
      candidateCount,
      visibleCapacity,
    }),
  );
}

function planDrawsSkin(plan: SubmissionPlan): boolean {
  return plan.batches.some((batch) => batch.prepared?.identity.deformation === 'skin');
}

export function shadowViewLabelPrefix(identity: ShadowViewIdentity): string {
  const prefix = shadowViewKindLabelPrefix(identity);
  return identity.layer === undefined ? prefix : `${prefix}.${identity.layer}`;
}

function shadowViewKindLabelPrefix(identity: ShadowViewIdentity): string {
  switch (identity.kind) {
    case 'directional':
      return `gpu-driven.shadow.directional-cascade-${identity.index}`;
    case 'point':
      return `gpu-driven.shadow.point-cube-face-${identity.index}${
        identity.face === undefined ? '' : `-${identity.face}`
      }`;
    case 'spot':
      return `gpu-driven.shadow.spot-atlas-${identity.index}`;
  }
}

/**
 * Accesses consumed by a shadow raster adapter.  These are the same imported
 * scene and view-local resources written by GpuDrivenView.addPasses(...), so
 * the graph inserts the compute-to-raster dependency without a second graph
 * or a manual barrier owner.
 */
export function shadowViewRasterAccesses(
  resources: GpuDrivenViewGraphResources,
): readonly GraphAccess[] {
  return Object.freeze([
    { resource: resources.primitive, usage: 'storage-read' },
    { resource: resources.instance, usage: 'storage-read' },
    { resource: resources.transform, usage: 'storage-read' },
    { resource: resources.material, usage: 'storage-read' },
    { resource: resources.visible, usage: 'storage-read' },
    { resource: resources.indirect, usage: 'indirect-read' },
  ] satisfies GraphAccess[]);
}

/** Per-view receiver dilation a shadow caster's camera test must cover. */
export type ShadowCameraCullDilation = Pick<
  GpuDrivenShadowCameraCull,
  'ndcDilation' | 'worldDilation'
>;

/**
 * Receiver dilation for a caster's camera test: the lookup's filter radius
 * plus two texels for rasterization and bilinear comparison footprint, and the
 * world-space receiver offset the lighting shader applies before projection.
 */
export function shadowCameraCullDilation(
  filterRadiusTexels: number,
  worldDilation: number,
  mapSize: number | undefined,
): ShadowCameraCullDilation | undefined {
  if (mapSize === undefined || !(mapSize > 0)) return undefined;
  return {
    ndcDilation: ((filterRadiusTexels + SHADOW_RASTER_GUARD_TEXELS) * 2) / mapSize,
    worldDilation,
  };
}

/**
 * Only final directional and spot views cull against the camera. Static
 * layers outlive any one camera, and a point cube's PCF kernel crosses faces,
 * so its per-face receiver prism would not bound what the lookup samples.
 */
function cameraCullEligible(identity: ShadowViewIdentity): boolean {
  return identity.layer === undefined && identity.kind !== 'point';
}

function invalidateRecord(record: ShadowViewRecord, reason: ShadowViewInvalidationReason): void {
  record.dirtyRects = undefined;
  record.invalidated = true;
  record.cache = 'invalidated';
  record.invalidationReason = reason;
}

const boxScratch = new Float32Array(6);

/** No box touches the frustum; an unproven box set touches everything. */
function boundsMissView(
  planes: Float32Array,
  bounds: ReturnType<GpuScene['changedBoundsSince']>,
): boolean {
  if (bounds === 'unbounded') return false;
  const view = planes as unknown as frustum.Frustum;
  for (let offset = 0; offset < bounds.length; offset += 6) {
    boxScratch.set(bounds.subarray(offset, offset + 6));
    if (frustum.intersectsBox(view, boxScratch as unknown as box3.Box3Like)) return false;
  }
  return true;
}

type PrimitiveDraw = SubmissionCandidateMembershipEntry;

function primitiveDraws(
  plan: SubmissionPlan,
  work?: ShadowPreparationCounters,
): ReadonlyMap<number, readonly PrimitiveDraw[]> {
  return buildSubmissionCandidateMembership(plan, work).byPrimitiveIndex;
}

/** Captured raw resource identity participates in the actual encoder read set. */
function sameBinding(a: GpuDrivenBatch['binding'], b: GpuDrivenBatch['binding']): boolean {
  if (a === b) return true;
  return (
    a !== undefined &&
    b !== undefined &&
    a.worldId === b.worldId &&
    a.assetHandle === b.assetHandle &&
    a.material === b.material &&
    a.drawItemIndex === b.drawItemIndex &&
    a.geometry === b.geometry
  );
}

function sameCandidate(left: GpuDrivenCandidate, right: GpuDrivenCandidate): boolean {
  return (
    left === right ||
    (left.primitiveIndex === right.primitiveIndex &&
      left.generation === right.generation &&
      left.drawItemIndex === right.drawItemIndex &&
      left.instanceOrdinal === right.instanceOrdinal)
  );
}

function sameList<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (a: T, b: T) => boolean,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!same(left[index] as T, right[index] as T)) return false;
  }
  return true;
}

function sameShallow(left: object | undefined, right: object | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => leftRecord[key] === rightRecord[key]);
}

function samePrepared(
  left: GpuDrivenBatch['prepared'],
  right: GpuDrivenBatch['prepared'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const { identity: leftIdentity, ...leftRest } = left;
  const { identity: rightIdentity, ...rightRest } = right;
  return sameShallow(leftIdentity, rightIdentity) && sameShallow(leftRest, rightRest);
}

function sameLod(left: GpuDrivenBatch['lod'], right: GpuDrivenBatch['lod']): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.hysteresis === right.hysteresis &&
    left.crossfade === right.crossfade &&
    sameList(left.coverages, right.coverages, Object.is) &&
    sameList(left.ranges, right.ranges, sameShallow)
  );
}

/** Rebind execution descriptors to the view's retained shared membership. */
function adoptSharedExecution(
  previous: ShadowViewRecord,
  source: SubmissionPlan,
): SubmissionPlan | undefined {
  const before = previous.sourcePlan;
  if (before === source) return previous.plan;
  const selectedByBatch = new Map(previous.plan.batches.map((batch) => [batch.batchId, batch]));
  const memberships = previous.memberships;
  for (const batch of before.batches) {
    memberships.set(
      batch.candidates,
      selectedByBatch.get(batch.batchId)?.candidates ?? EMPTY_CANDIDATES,
    );
  }
  const batches: GpuDrivenBatch[] = [];
  let candidateCount = 0;
  let visibleCapacity = 0;
  for (const current of source.batches) {
    const candidates =
      previous.candidates === undefined ? current.candidates : memberships.get(current.candidates);
    // Object membership changed; the ordinary spatial delta path judges it.
    if (candidates === undefined) return undefined;
    if (candidates.length === 0) continue;
    const selected = selectedByBatch.get(current.batchId);
    const unchanged =
      selected !== undefined &&
      selected.generation === current.generation &&
      selected.binding === current.binding &&
      selected.materialAddress === current.materialAddress &&
      selected.visibleBase === current.visibleBase &&
      selected.visibleCapacity === current.visibleCapacity &&
      selected.visibleAllocationCapacity === current.visibleAllocationCapacity &&
      selected.indirectOffset === current.indirectOffset &&
      selected.contentEpoch === current.contentEpoch &&
      sameShallow(selected.key, current.key) &&
      samePrepared(selected.prepared, current.prepared) &&
      sameLod(selected.lod, current.lod);
    const batch = unchanged
      ? selected
      : candidates === current.candidates
        ? current
        : Object.freeze({ ...current, candidates });
    batches.push(batch);
    candidateCount += candidates.length;
    visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
  }
  if (
    batches.length === previous.plan.batches.length &&
    batches.every((batch, index) => batch === previous.plan.batches.at(index))
  )
    return previous.plan;
  return inheritTaskHeaders(
    source,
    Object.freeze({
      revision: source.revision,
      batches: Object.freeze(batches),
      candidateCount,
      visibleCapacity,
    }),
  );
}

/** Once shader-read content is proven equal, physical material addresses are not depth facts. */
function sameShadowExecution(a: SubmissionPlan, b: SubmissionPlan): boolean {
  if (a.batches.length !== b.batches.length) return false;
  return a.batches.every((left, index) => {
    const right = b.batches.at(index);
    if (
      right === undefined ||
      left.candidates !== right.candidates ||
      left.generation !== right.generation ||
      left.batchId !== right.batchId ||
      left.geometryAddress !== right.geometryAddress ||
      left.binding?.geometry !== right.binding?.geometry ||
      left.binding?.worldId !== right.binding?.worldId ||
      left.binding?.assetHandle !== right.binding?.assetHandle ||
      !sameLod(left.lod, right.lod)
    )
      return false;
    const x = left.key,
      y = right.key;
    return (
      x.drawKind === y.drawKind &&
      x.first === y.first &&
      x.count === y.count &&
      x.baseVertex === y.baseVertex &&
      x.topology === y.topology &&
      x.drawItemIndex === y.drawItemIndex &&
      x.materialSlot === y.materialSlot
    );
  });
}

const EMPTY_CANDIDATES: FrameList<GpuDrivenCandidate> = Object.freeze([]);

/**
 * Drawn content of one candidate: its batch's shared key, prepared receipt and
 * LOD facts plus the candidate row. A member's own preparation facts change
 * only with a scene update of its slot, which the change-log check judges.
 */
function sameDraw(left: PrimitiveDraw, right: PrimitiveDraw): boolean {
  const a = left.batch;
  const b = right.batch;
  return (
    (a === b ||
      (sameBinding(a.binding, b.binding) &&
        sameShallow(a.key, b.key) &&
        samePrepared(a.prepared, b.prepared) &&
        sameLod(a.lod, b.lod))) &&
    sameCandidate(left.candidate, right.candidate)
  );
}

/** Primitives whose drawn content differs between two plans: added, removed, or changed. */
export function changedPrimitives(
  previous: SubmissionPlan,
  next: SubmissionPlan,
  out: Set<number>,
  counters?: ShadowPreparationCounters,
): void {
  if (counters !== undefined) counters.planComparisons++;
  if (previous === next) return;
  const affected = new Set<number>();
  const count = Math.max(previous.batches.length, next.batches.length);
  for (let index = 0; index < count; index++) {
    if (counters !== undefined) counters.batchChecks++;
    const before = previous.batches.at(index);
    const after = next.batches.at(index);
    if (before === after) continue;
    if (
      before !== undefined &&
      after !== undefined &&
      before.candidates.length === after.candidates.length &&
      before.candidates.every((candidate, row) => {
        if (counters !== undefined) counters.candidateScans += 2;
        return candidate.primitiveIndex === after.candidates.at(row)?.primitiveIndex;
      })
    ) {
      for (let row = 0; row < before.candidates.length; row++) {
        const left = before.candidates.at(row),
          right = after.candidates.at(row);
        if (left === undefined || right === undefined) continue;
        if (counters !== undefined) {
          counters.candidateScans += 2;
          counters.primitiveChecks++;
        }
        if (!sameDraw({ batch: before, candidate: left }, { batch: after, candidate: right }))
          out.add(left.primitiveIndex);
      }
      continue;
    }
    for (const batch of [before, after]) {
      if (batch === undefined) continue;
      for (const candidate of batch.candidates) {
        if (counters !== undefined) counters.candidateScans++;
        affected.add(candidate.primitiveIndex);
      }
    }
  }
  if (affected.size === 0) return;
  const before = primitiveDraws(previous, counters);
  const after = primitiveDraws(next, counters);
  for (const primitive of affected) {
    if (counters !== undefined) counters.primitiveChecks++;
    if (!sameList(before.get(primitive), after.get(primitive), sameDraw)) out.add(primitive);
  }
}

/**
 * Two plans with the same draws also share every buffer offset, so a view may
 * keep the retained plan object and its uploaded candidate rows.
 */
function sameSubmissionLayout(left: SubmissionPlan, right: SubmissionPlan): boolean {
  if (
    left.candidateCount !== right.candidateCount ||
    left.visibleCapacity !== right.visibleCapacity ||
    left.batches.length !== right.batches.length
  ) {
    return false;
  }
  for (let index = 0; index < left.batches.length; index += 1) {
    const a = left.batches.at(index);
    const b = right.batches.at(index);
    if (
      a === undefined ||
      b === undefined ||
      a.batchId !== b.batchId ||
      a.generation !== b.generation ||
      a.visibleBase !== b.visibleBase ||
      a.visibleCapacity !== b.visibleCapacity ||
      a.indirectOffset !== b.indirectOffset ||
      a.visibleAllocationCapacity !== b.visibleAllocationCapacity ||
      a.materialAddress !== b.materialAddress ||
      a.geometryAddress !== b.geometryAddress ||
      a.logicalResources !== b.logicalResources ||
      !sameBinding(a.binding, b.binding) ||
      a.contentEpoch !== b.contentEpoch ||
      a.candidates.length !== b.candidates.length
    ) {
      return false;
    }
    for (let row = 0; row < a.candidates.length; row += 1) {
      if (a.candidates.at(row)?.primitiveIndex !== b.candidates.at(row)?.primitiveIndex)
        return false;
    }
  }
  return true;
}

/**
 * Primitives whose retained LOD levels no longer serve the next selection.
 * With `keepFiner` a retained level finer than the next one still serves it,
 * so only a caster now drawn finer than retained is stale.
 */
function changedLodPrimitives(
  previous: ShadowViewRecord,
  plan: SubmissionPlan,
  heights: ReadonlyMap<number, number> | undefined,
  keepFiner: boolean,
  out: Set<number>,
): void {
  const before = shadowLodLevels(previous.plan, previous.lodProjectedHeights);
  const after = shadowLodLevels(plan, heights);
  for (const [primitive, level] of after) {
    const retained = before.get(primitive);
    if (sameShadowLodLevels(retained, level)) continue;
    if (keepFiner && retained !== undefined && level.finest >= retained.finest) {
      continue;
    }
    out.add(primitive);
  }
  for (const primitive of before.keys()) if (!after.has(primitive)) out.add(primitive);
}

/** A clamped static layer keeps retained levels finer than it now selects. */
function keepsFinerLod(input: ShadowViewUpdateInput): boolean {
  return input.identity.layer === 'static' && input.lodClampCamera !== undefined;
}

/** Most regions one partial static redraw clears and re-rasters. */
const MAX_DIRTY_RECTS = 4;
/** Above this share of the layer a full redraw is cheaper than scissored regions. */
const MAX_DIRTY_COVERAGE = 0.5;
/** Changed boxes beyond this count fall back to a full redraw. */
const MAX_DIRTY_BOXES = 64;
/** Normalized margin around each projected box, covering raster rounding. */
const DIRTY_RECT_MARGIN = 1 / 256;

type MutableRect = { x0: number; y0: number; x1: number; y1: number };

const cornerScratch = new Float32Array(4);

/** The normalized target rect a world box projects to; undefined when it crosses the eye plane. */
function projectBox(
  matrix: Float32Array,
  boxes: Float32Array,
  offset: number,
): MutableRect | null | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = boxes[offset + (corner & 1 ? 3 : 0)] as number;
    const y = boxes[offset + (corner & 2 ? 4 : 1)] as number;
    const z = boxes[offset + (corner & 4 ? 5 : 2)] as number;
    for (let row = 0; row < 4; row += 1) {
      cornerScratch[row] =
        (matrix[row] as number) * x +
        (matrix[4 + row] as number) * y +
        (matrix[8 + row] as number) * z +
        (matrix[12 + row] as number);
    }
    const w = cornerScratch[3] as number;
    if (!(w > 1e-6)) return undefined;
    const u = ((cornerScratch[0] as number) / w) * 0.5 + 0.5;
    const v = 0.5 - ((cornerScratch[1] as number) / w) * 0.5;
    x0 = Math.min(x0, u);
    y0 = Math.min(y0, v);
    x1 = Math.max(x1, u);
    y1 = Math.max(y1, v);
  }
  if (!Number.isFinite(x0 + y0 + x1 + y1)) return undefined;
  const rect = {
    x0: Math.max(0, x0 - DIRTY_RECT_MARGIN),
    y0: Math.max(0, y0 - DIRTY_RECT_MARGIN),
    x1: Math.min(1, x1 + DIRTY_RECT_MARGIN),
    y1: Math.min(1, y1 + DIRTY_RECT_MARGIN),
  };
  return rect.x0 >= rect.x1 || rect.y0 >= rect.y1 ? null : rect;
}

const rectArea = (rect: MutableRect): number => (rect.x1 - rect.x0) * (rect.y1 - rect.y0);

/**
 * Merges projected boxes into at most {@link MAX_DIRTY_RECTS} rects, each step
 * joining the pair whose union adds the least area. Undefined asks for a full
 * redraw: too many boxes, a box crossing the eye plane, or too much coverage.
 */
export function shadowDirtyRects(
  matrix: Float32Array,
  boxSets: readonly Float32Array[],
): readonly ShadowDirtyRect[] | undefined {
  let boxCount = 0;
  for (const boxes of boxSets) boxCount += boxes.length / 6;
  if (boxCount > MAX_DIRTY_BOXES) return undefined;
  const rects: MutableRect[] = [];
  for (const boxes of boxSets) {
    for (let offset = 0; offset < boxes.length; offset += 6) {
      const rect = projectBox(matrix, boxes, offset);
      if (rect === undefined) return undefined;
      if (rect !== null) rects.push(rect);
    }
  }
  const union = (a: MutableRect, b: MutableRect): MutableRect => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  });
  const overlaps = (a: MutableRect, b: MutableRect): boolean =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (;;) {
    let best: [number, number] | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i] as MutableRect;
        const b = rects[j] as MutableRect;
        // Overlapping rects always merge so no texel is drawn twice.
        const cost = overlaps(a, b)
          ? Number.NEGATIVE_INFINITY
          : rectArea(union(a, b)) - rectArea(a) - rectArea(b);
        if (cost < bestCost) {
          bestCost = cost;
          best = [i, j];
        }
      }
    }
    if (
      best === undefined ||
      (rects.length <= MAX_DIRTY_RECTS && bestCost !== Number.NEGATIVE_INFINITY)
    ) {
      break;
    }
    const [i, j] = best;
    rects[i] = union(rects[i] as MutableRect, rects[j] as MutableRect);
    rects.splice(j, 1);
  }
  let coverage = 0;
  for (const rect of rects) coverage += rectArea(rect);
  if (coverage > MAX_DIRTY_COVERAGE) return undefined;
  return Object.freeze(rects.map((rect) => Object.freeze(rect)));
}

/**
 * A retained static layer whose only miss is scene or membership content
 * re-rasters just the regions every changed box projects to. The view, its
 * target and matrix must be unchanged; the boxes are the scene changes the
 * layer draws plus every box of a primitive whose drawn content changed.
 */
function partialStaticRects(
  previous: ShadowViewRecord,
  input: ShadowViewUpdateInput,
  reason: ShadowViewInvalidationReason,
  retainedRevision: number,
  plan: SubmissionPlan,
): readonly ShadowDirtyRect[] | undefined {
  if (
    input.identity.layer !== 'static' ||
    (reason !== 'content-changed' && reason !== 'membership-changed' && reason !== 'lod-changed') ||
    previous.invalidated ||
    !previous.published ||
    previous.matrix === undefined ||
    input.matrix === undefined ||
    previous.scene !== input.scene ||
    !sameSceneBuffers(previous.sceneBuffers, input.scene) ||
    previous.resourceGeneration !== previous.view.computeResourceGeneration ||
    previous.targetSize !== input.targetSize ||
    !sameMatrix(previous.matrix, input.matrix) ||
    !sameShadowContent(previous, input) ||
    !samePrefix(previous.planes, input.planes, PLANE_FLOATS)
  ) {
    return undefined;
  }
  const scene = input.scene;
  const changedContent = scene.changedBoundsSince(
    retainedRevision,
    input.ignoredChangeSlots,
    primitiveDraws(previous.plan, previous.preparation),
  );
  if (changedContent === 'unbounded') return undefined;
  const changed = new Set<number>();
  changedPrimitives(previous.plan, plan, changed, previous.preparation);
  if (previous.lodSelection !== input.lodSelection) {
    changedLodPrimitives(previous, plan, input.lodProjectedHeights, keepsFinerLod(input), changed);
  }
  const changedDraws = scene.slotBoundsSince(retainedRevision, changed);
  if (changedDraws === 'unbounded') return undefined;
  return shadowDirtyRects(input.matrix, [changedContent, changedDraws]);
}

function sameViewResources(previous: ShadowViewRecord, scene: GpuScene): boolean {
  return (
    previous.scene === scene &&
    sameSceneBuffers(previous.sceneBuffers, scene) &&
    previous.visibleBuffer === previous.view.visibleBuffer &&
    previous.resourceGeneration === previous.view.computeResourceGeneration
  );
}

/** Asset changes have no geometric dirty boxes; they require a full static redraw. */
function sameShadowContent(previous: ShadowViewRecord, input: ShadowViewUpdateInput): boolean {
  return (
    sameShadowMaterialFrames(previous.directMaterials, input.directMaterials) &&
    (input.shadowMaterials === undefined
      ? previous.shadowMaterials === undefined
      : input.shadowMaterials.same(previous.shadowMaterials))
  );
}

function passNames(identity: ShadowViewIdentity): readonly string[] {
  const prefix = shadowViewLabelPrefix(identity);
  return Object.freeze([
    `${prefix}.view-reset`,
    `${prefix}.frustum-compact`,
    `${prefix}.finalize-indirect`,
  ]);
}

function graphStateError(identity: ShadowViewIdentity): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'ShadowViewStatePool.update(...) precedes project(...)',
    hint: 'publish the shared scene, topology channel, and view planes before graph projection',
    detail: {
      resourceLabel: identityKey(identity),
      field: 'state',
      expected: 'updated',
      actual: 'not-updated',
    },
  });
}

/**
 * Renderer-owned shadow view state. The pool shares one scene/topology source;
 * each directional, point, or spot entry owns only view constants, visibility,
 * counters, indirect arguments, and its cache decision.
 */
export class ShadowViewStatePool {
  private readonly records = new Map<string, ShadowViewRecord>();
  // Only this pool's captured executions enter the cache, never caller plans.
  private drawnMemberships = new WeakMap<
    SubmissionPlan,
    ReadonlyMap<number, readonly PrimitiveDraw[]>
  >();
  private readonly activeKeys = new Set<string>();
  private readonly retiring = new Map<string, ShadowViewRecord>();
  private readonly pendingPublication = new Set<string>();
  /** Depth behind every static layer; it outlives compiled graphs with the pool. */
  readonly staticLayers: ShadowDepthLayers;

  private constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ) {
    this.staticLayers = new ShadowDepthLayers(device);
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  }): Result<ShadowViewStatePool, RhiError> {
    return ok(new ShadowViewStatePool(input.device, input.shaderModuleFactory));
  }

  update(
    input: ShadowViewUpdateInput,
    // @internal Exact privately assembled source; raw callers keep full observations.
    projectionSource?: SubmissionPlan,
  ): Result<ShadowViewUpdate, RhiError> {
    const identityError = validateIdentity(input.identity);
    if (identityError !== undefined) return err(identityError);
    if (input.planes.length < PLANE_FLOATS) return err(planesError());
    const fixedSource = projectionSource === input.sourcePlan;
    if (!fixedSource)
      input = { ...input, sourcePlan: captureExecution(input.sourcePlan, input.scene) };
    const key = identityKey(input.identity);
    const previous = this.records.get(key);
    const candidateSource = input.candidatePrimitiveIndices;
    const normalized = candidateIndices(candidateSource);
    if (!normalized.ok) return normalized;
    const candidates = normalized.value;
    const sameRestriction = sameCandidates(previous?.candidates, candidates);
    this.activeKeys.add(key);
    this.retiring.delete(key);
    const retainedRevision = previous?.contentRevision;
    const structureMiss = this.structureInvalidationReason(previous, input);
    let invalidationReason =
      structureMiss ??
      (previous !== undefined && !samePrefix(previous.planes, input.planes, PLANE_FLOATS)
        ? 'view-changed'
        : undefined);
    const sameSource =
      fixedSource &&
      previous !== undefined &&
      previous.sourcePlan === input.sourcePlan &&
      sameCandidates(previous.candidates, candidates);
    const memberships =
      fixedSource && previous !== undefined && sameCandidates(previous.candidates, candidates)
        ? previous.memberships
        : new WeakMap<FrameList<GpuDrivenCandidate>, FrameList<GpuDrivenCandidate>>();
    const executionPlan =
      fixedSource &&
      previous?.published &&
      sameViewResources(previous, input.scene) &&
      projectionSource === input.sourcePlan &&
      sameCandidates(previous.candidates, candidates)
        ? adoptSharedExecution(previous, input.sourcePlan)
        : undefined;
    const sameDepthExecution =
      previous !== undefined &&
      executionPlan !== undefined &&
      input.shadowMaterials?.same(previous.shadowMaterials) === true &&
      sameShadowExecution(previous.plan, executionPlan);
    const executionChanged =
      executionPlan !== undefined && executionPlan !== previous?.plan && !sameDepthExecution;
    if (executionChanged) invalidationReason ??= 'content-changed';
    // Depth changes do not change candidate rows. Only a replaced or aborted
    // physical view must re-project an otherwise identical source for upload.
    let selectedPlan =
      executionPlan ??
      (sameSource &&
      previous?.published &&
      !previous.invalidated &&
      sameViewResources(previous, input.scene)
        ? previous.plan
        : projectionSource === undefined
          ? projectPlan(input.sourcePlan, candidates)
          : this.projectSourcePlan(
              input,
              candidates,
              previous?.plan,
              projectionSource,
              memberships,
            ));
    // Raw values were observed above. Reuse the old fixed execution only after
    // comparing those values, including the physical task addresses.
    if (
      !fixedSource &&
      previous !== undefined &&
      sameSubmissionLayout(previous.plan, selectedPlan)
    ) {
      const changed = new Set<number>();
      changedPrimitives(previous.plan, selectedPlan, changed, previous.preparation);
      if (changed.size === 0) selectedPlan = previous.plan;
    }
    if (invalidationReason === undefined && previous !== undefined) {
      invalidationReason = this.retainedContentReason(
        previous,
        input,
        retainedRevision ?? previous.contentRevision,
        selectedPlan,
        sameSource || sameDepthExecution,
        sameRestriction,
      );
    }
    // Depth rastered under a camera cull lacks casters a moved camera may see,
    // so it is never reused. Changed content keeps culling every frame; a
    // quiet view re-rasters once without the cull so it can be retained.
    if (invalidationReason === undefined && previous?.cameraCull === true) {
      invalidationReason = 'camera-culled';
    }
    if (invalidationReason === undefined && previous !== undefined) {
      previous.frameInput = { input, plan: selectedPlan, bound: false };
      previous.preparation.cacheHits++;
      previous.cache = 'hit';
      previous.invalidationReason = undefined;
      previous.sourcePlan = input.sourcePlan;
      previous.candidateSource = candidateSource;
      previous.candidates = candidates;
      previous.directMaterials = input.directMaterials;
      previous.shadowMaterials = input.shadowMaterials;
      return ok({
        identity: previous.identity,
        cache: 'hit',
        generation: previous.generation,
        sourcePlan: previous.sourcePlan,
        plan: previous.plan,
        view: previous.view,
      });
    }

    const dirtyRects =
      previous === undefined || invalidationReason === undefined || executionChanged
        ? undefined
        : partialStaticRects(
            previous,
            input,
            invalidationReason,
            retainedRevision ?? previous.contentRevision,
            selectedPlan,
          );
    const planes = new Float32Array(input.planes.subarray(0, PLANE_FLOATS));
    let view = previous?.view;
    if (view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
        labelPrefix: `${shadowViewLabelPrefix(input.identity)}.view`,
        shadowCameraCull: cameraCullEligible(input.identity),
      });
      if (!created.ok) return created;
      view = created.value;
    }
    const minCasterDiameter = shadowMinCasterDiameter(input.matrix, input.targetSize);
    const cameraCull =
      input.cameraCull !== undefined &&
      input.matrix !== undefined &&
      invalidationReason !== 'camera-culled' &&
      view.cameraCullBound
        ? { ...input.cameraCull, lightViewProjection: input.matrix }
        : undefined;
    const updated = view.update(
      selectedPlan,
      input.scene,
      input.inputReads,
      planes,
      input.lodCamera,
      minCasterDiameter,
      undefined,
      input.lodClampCamera,
      undefined,
      undefined,
      cameraCull,
    );
    if (!updated.ok) return updated;
    const generation = (previous?.generation ?? 0) + 1;
    const preparation = previous?.preparation ?? {
      cacheHits: 0,
      cacheRebuilds: 0,
      cacheRebuildReasons: {},
      membershipBuilds: 0,
      membershipCandidateScans: 0,
      planComparisons: 0,
      batchChecks: 0,
      candidateScans: 0,
      primitiveChecks: 0,
    };
    preparation.cacheRebuilds++;
    const reason = invalidationReason ?? 'first-publication';
    preparation.cacheRebuildReasons[reason] = (preparation.cacheRebuildReasons[reason] ?? 0) + 1;
    const record: ShadowViewRecord = {
      preparation,
      identity: Object.freeze({ ...input.identity }),
      view,
      sourcePlan: input.sourcePlan,
      plan: selectedPlan,
      scene: input.scene,
      frameInput: undefined,
      matrix: input.matrix === undefined ? undefined : new Float32Array(input.matrix),
      targetSize: input.targetSize,
      graphGeneration: input.graphGeneration,
      contentRevision: input.scene.contentRevision,
      directMaterials: input.directMaterials,
      shadowMaterials: input.shadowMaterials,
      planes,
      candidateSource,
      candidates,
      memberships,
      lodSelection: input.lodSelection,
      lodProjectedHeights: input.lodProjectedHeights,
      skinned: planDrawsSkin(selectedPlan),
      generation,
      cache: 'invalidated',
      invalidationReason,
      invalidated: false,
      published: false,
      resourceGeneration: view.computeResourceGeneration,
      visibleBuffer: view.visibleBuffer,
      sceneBuffers: sceneBuffers(input.scene),
      minCasterDiameter,
      texelCulled: previous?.texelCulled,
      cameraCull: cameraCull !== undefined,
      cameraCulled: cameraCull === undefined ? undefined : previous?.cameraCulled,
      lastCullingObservation: previous?.lastCullingObservation,
      dirtyRects,
    };
    this.records.set(key, record);
    this.pendingPublication.add(key);
    return ok({
      identity: record.identity,
      cache: 'invalidated',
      generation,
      sourcePlan: record.sourcePlan,
      plan: record.plan,
      view: record.view,
    });
  }

  private structureInvalidationReason(
    previous: ShadowViewRecord | undefined,
    input: ShadowViewUpdateInput,
  ): ShadowViewInvalidationReason | undefined {
    if (previous === undefined) return 'first-publication';
    if (previous.invalidated) return previous.invalidationReason ?? 'first-publication';
    if (!previous.published) return 'first-publication';
    if (!sameViewResources(previous, input.scene)) {
      return 'source-changed';
    }
    if (previous.targetSize !== input.targetSize) return 'configuration-changed';
    if (input.identity.layer !== 'static' && previous.graphGeneration !== input.graphGeneration) {
      return 'graph-compiled';
    }
    if (!sameMatrix(previous.matrix, input.matrix)) return 'view-changed';
    if (!sameShadowContent(previous, input)) return 'content-changed';
    if (!this.sceneChangesMissView(previous, input)) return 'content-changed';
    return undefined;
  }

  private primitiveDraws(
    plan: SubmissionPlan,
    work: ShadowPreparationCounters,
  ): ReadonlyMap<number, readonly PrimitiveDraw[]> {
    let value = this.drawnMemberships.get(plan);
    if (value === undefined) {
      value = primitiveDraws(plan, work);
      this.drawnMemberships.set(plan, value);
    }
    return value;
  }

  /**
   * Scene content changed after the retained revision only matters when an old
   * or new world box of a changed slot touches this view's retained frustum.
   */
  private sceneChangesMissView(previous: ShadowViewRecord, input: ShadowViewUpdateInput): boolean {
    const current = input.scene.contentRevision;
    if (previous.contentRevision === current) return true;
    if (input.scene.changedSlotsSince(previous.contentRevision)?.length === 0) {
      previous.contentRevision = current;
      return true;
    }
    const changed = input.scene.changedBoundsSince(
      previous.contentRevision,
      input.ignoredChangeSlots,
      // A removed dynamic caster is absent from the current ignored set but
      // never wrote this static depth. New static members are checked below
      // through changedPrimitives and their old/new bounds.
      input.identity.layer === 'static'
        ? this.primitiveDraws(previous.plan, previous.preparation)
        : undefined,
    );
    if (!boundsMissView(previous.planes, changed)) return false;
    previous.contentRevision = current;
    return true;
  }

  /** Share camera-independent projection only within the pending submission. */
  private projectSourcePlan(
    input: ShadowViewUpdateInput,
    candidates: ShadowCandidates | undefined,
    previousPlan: SubmissionPlan | undefined,
    projectionSource: SubmissionPlan,
    memberships: ShadowViewRecord['memberships'],
  ): SubmissionPlan {
    if (input.sourcePlan !== projectionSource) return projectPlan(input.sourcePlan, candidates);
    if (candidates === undefined) return input.sourcePlan;
    for (const key of this.pendingPublication) {
      const record = this.records.get(key);
      if (
        record !== undefined &&
        !record.invalidated &&
        record.sourcePlan === input.sourcePlan &&
        // This fallback must give an aborted/replaced view a new identity,
        // even when another pending view still draws its old accepted plan.
        record.plan !== previousPlan &&
        sameCandidates(record.candidates, candidates)
      ) {
        for (const batch of input.sourcePlan.batches) {
          const selected = record.memberships.get(batch.candidates);
          if (selected !== undefined) memberships.set(batch.candidates, selected);
        }
        return record.plan;
      }
    }
    return projectOwnedPlan(input.sourcePlan, candidates, memberships);
  }

  /**
   * A retained view re-rasters only when a primitive whose drawn content or
   * discrete LOD level differs between the retained plan and the next plan
   * touches the retained frustum, judged by every box the primitive occupied
   * since the retained revision. Otherwise the record adopts the next plan so
   * later compute and recording stay consistent with the scene, and stays a hit.
   */
  private retainedContentReason(
    previous: ShadowViewRecord,
    input: ShadowViewUpdateInput,
    retainedRevision: number,
    plan: SubmissionPlan,
    sameSource: boolean,
    sameRestriction: boolean,
  ): ShadowViewInvalidationReason | undefined {
    const sameLod = previous.lodSelection === input.lodSelection;
    if (sameSource && sameLod) return undefined;
    const scene = input.scene;
    if (!sameLod) {
      const lodChanged = new Set<number>();
      changedLodPrimitives(
        previous,
        plan,
        input.lodProjectedHeights,
        keepsFinerLod(input),
        lodChanged,
      );
      if (!boundsMissView(previous.planes, scene.slotBoundsSince(retainedRevision, lodChanged))) {
        return 'lod-changed';
      }
    }
    let adopted = previous.plan;
    if (plan !== previous.plan) {
      const changed = new Set<number>();
      changedPrimitives(previous.plan, plan, changed, previous.preparation);
      if (!boundsMissView(previous.planes, scene.slotBoundsSince(retainedRevision, changed))) {
        // Physical source changes were rejected before this content check.
        // A replaced plan changes drawn content, whose old/new bounds still
        // permit a partial static redraw, including casters now drawn dynamically.
        return sameRestriction ? 'content-changed' : 'membership-changed';
      }
      adopted =
        changed.size === 0 && sameSubmissionLayout(previous.plan, plan) ? previous.plan : plan;
    }
    if (adopted === previous.plan && sameLod) return undefined;
    const resourceGeneration = previous.view.computeResourceGeneration;
    const updated = previous.view.update(
      adopted,
      scene,
      input.inputReads,
      previous.planes,
      input.lodCamera,
      previous.minCasterDiameter,
      undefined,
      input.lodClampCamera,
    );
    if (!updated.ok || previous.view.computeResourceGeneration !== resourceGeneration) {
      return 'source-changed';
    }
    previous.sourcePlan = input.sourcePlan;
    previous.plan = adopted;
    // Kept finer levels stay the retained reference until a re-raster.
    if (!keepsFinerLod(input)) previous.lodProjectedHeights = input.lodProjectedHeights;
    previous.lodSelection = input.lodSelection;
    previous.skinned = planDrawsSkin(adopted);
    return undefined;
  }

  project<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
    identity: ShadowViewIdentity,
    forceCompute = false,
    cameraPyramid?: GraphTextureView,
  ): Result<ShadowViewProjection, RenderGraphError> {
    const record = this.records.get(identityKey(identity));
    if (record === undefined) return err(graphStateError(identity));
    const cacheHit = record.cache === 'hit' && !record.invalidated;
    if (forceCompute && cacheHit) {
      const pending = record.frameInput;
      if (pending === undefined) return err(graphStateError(identity));
      const { input, plan } = pending;
      if (!pending.bound) {
        const refreshed = record.view.update(
          plan,
          input.scene,
          input.inputReads,
          record.planes,
          input.lodCamera,
          record.minCasterDiameter,
          undefined,
          input.lodClampCamera,
        );
        if (!refreshed.ok)
          return err(
            new RenderGraphError({
              code: 'pass-encode-failed',
              expected: 'current leased inputs for forced shadow compute',
              hint: 'prepare this view in the current open read domain before graph projection',
              detail: {
                passName: shadowViewLabelPrefix(identity),
                passKind: 'compute',
                cause: refreshed.error,
              },
            }),
          );
        record.plan = plan;
        record.sourcePlan = input.sourcePlan;
        record.resourceGeneration = record.view.computeResourceGeneration;
        record.visibleBuffer = record.view.visibleBuffer;
        record.sceneBuffers = sceneBuffers(input.scene);
        pending.bound = true;
      }
    }
    // A graph replacement must carry the shadow compute passes even when the
    // view itself is a cache hit. The graph owns the pass list, so omitting
    // compute work while importing a replacement graph would leave its
    // indirect arguments stale. The normal pool contract still skips work on
    // a cache hit; graph projection opts in explicitly at that boundary.
    const includeCompute = forceCompute || !cacheHit;
    let forceComputePending = forceCompute;
    let lastFrame: FrameCtx | undefined;
    let executeForFrame = false;
    const executeCompute = (frame: FrameCtx): boolean => {
      if (frame !== lastFrame) {
        lastFrame = frame;
        const currentRecord = this.records.get(identityKey(record.identity));
        executeForFrame =
          forceComputePending ||
          currentRecord === undefined ||
          currentRecord.cache !== 'hit' ||
          currentRecord.invalidated;
        forceComputePending = false;
      }
      return executeForFrame;
    };
    const projected = record.view.addPasses(
      builder,
      shadowViewLabelPrefix(record.identity),
      includeCompute,
      undefined,
      includeCompute ? executeCompute : undefined,
      false,
      cameraPyramid,
    );
    if (!projected.ok) return projected;
    return ok({
      identity: record.identity,
      cache: cacheHit ? 'hit' : 'invalidated',
      generation: record.generation,
      plan: record.plan,
      view: record.view,
      passNames: includeCompute ? passNames(record.identity) : Object.freeze([]),
      graphResources: projected.value,
    });
  }

  invalidate(reason: ShadowViewInvalidationReason, identity?: ShadowViewIdentity): void {
    if (identity === undefined) {
      for (const record of this.records.values()) invalidateRecord(record, reason);
      return;
    }
    const record = this.records.get(identityKey(identity));
    if (record !== undefined) invalidateRecord(record, reason);
  }

  /** A skin palette change reaches only views whose plan draws skinned casters. */
  invalidateSkinned(): void {
    for (const record of this.records.values()) {
      if (record.skinned) invalidateRecord(record, 'skin-palette-changed');
    }
  }

  /** Camera clipping reaches every shadow raster through the view uniforms. */
  invalidateViewClipping(): void {
    for (const record of this.records.values()) invalidateRecord(record, 'view-clipping-changed');
  }

  cacheState(identity: ShadowViewIdentity): ShadowViewCacheState | undefined {
    const record = this.records.get(identityKey(identity));
    if (record === undefined) return undefined;
    return record.invalidated ? 'invalidated' : record.cache;
  }

  /** The reason an active view misses this frame; undefined on a hit. */
  invalidationReason(identity: ShadowViewIdentity): ShadowViewInvalidationReason | undefined {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined || !this.activeKeys.has(key)) return 'uncached';
    if (!record.invalidated && record.cache === 'hit') return undefined;
    return record.invalidationReason ?? 'first-publication';
  }

  /**
   * The regions a missed static layer re-rasters; undefined for a full redraw.
   * Only meaningful while {@link invalidationReason} reports a miss.
   */
  dirtyRects(identity: ShadowViewIdentity): readonly ShadowDirtyRect[] | undefined {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined || !this.activeKeys.has(key) || record.invalidated) return undefined;
    return record.cache === 'invalidated' ? record.dirtyRects : undefined;
  }

  /** Casters the view's last observed GPU cull dropped below its minimum diameter. */
  texelCulled(identity: ShadowViewIdentity): number | undefined {
    const key = identityKey(identity);
    return this.activeKeys.has(key) ? this.records.get(key)?.texelCulled : undefined;
  }

  /** Casters the view's last raster skipped as hidden from the main camera. */
  cameraCulled(identity: ShadowViewIdentity): number | undefined {
    const key = identityKey(identity);
    return this.activeKeys.has(key) ? this.records.get(key)?.cameraCulled : undefined;
  }

  isActive(identity: ShadowViewIdentity): boolean {
    return this.activeKeys.has(identityKey(identity));
  }

  submission(identity: ShadowViewIdentity): ShadowViewSubmission | undefined {
    const key = identityKey(identity);
    if (!this.activeKeys.has(key)) return undefined;
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    let selection = viewSelections.get(record.plan);
    if (selection === undefined) {
      selection = new GpuDrawSelection(record.plan.batches);
      viewSelections.set(record.plan, selection);
    }
    return {
      selection,
      identity: record.identity,
      cache: record.cache,
      generation: record.generation,
      plan: record.plan,
      view: record.view,
    };
  }

  /**
   * Keep only the active view identities for the current frame. Removed light
   * views are disposed through their own queue-fenced resource owner instead
   * of remaining in inspection or changing the compiled topology forever.
   */
  retain(identities: readonly ShadowViewIdentity[]): void {
    const active = new Set(identities.map(identityKey));
    for (const [key, record] of this.records) {
      if (active.has(key)) continue;
      this.activeKeys.delete(key);
      record.frameInput = undefined;
      this.retiring.set(key, record);
    }
  }

  /** End the current preparation without retaining its global mapping/read domain. */
  _closeInputReads(): void {
    for (const key of this.activeKeys) {
      const record = this.records.get(key);
      if (record !== undefined) record.frameInput = undefined;
    }
  }

  /**
   * @internal Commit after queue submit. The stock graph forces every projected
   * view's compute and fresh-target raster on compile, so that submission also
   * accepts its graph generation. Raw owners omit it and keep explicit invalidation.
   */
  _commitResourceReplacement(submittedGraphGeneration?: number): void {
    this._closeInputReads();
    for (const record of this.records.values()) record.view._commitResourceReplacement();
    for (const key of this.pendingPublication) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      record.published = true;
      // A palette-only re-cull keeps the same candidates and view, so its
      // texel count cannot change and does not deserve a readback.
      const recount =
        record.texelCulled === undefined || record.invalidationReason !== 'skin-palette-changed';
      if ((record.minCasterDiameter > 0 && recount) || record.cameraCull) {
        void this.observeCulling(key, record);
      }
    }
    this.pendingPublication.clear();
    if (submittedGraphGeneration !== undefined) {
      for (const key of this.activeKeys) {
        const record = this.records.get(key);
        if (record?.published && record.identity.layer !== 'static')
          record.graphGeneration = submittedGraphGeneration;
      }
    }
    this.staticLayers._commit();
    for (const [key, record] of this.retiring) {
      record.view.dispose();
      this.records.delete(key);
      this.retiring.delete(key);
    }
  }

  /**
   * Abort a staged frame before its queue submit barrier. A candidate view
   * must not become a cache hit merely because graph encoding succeeded: the
   * next frame has to rebuild it after any submit/finish failure.
   */
  _abortResourceReplacement(): void {
    this._closeInputReads();
    for (const key of this.pendingPublication) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      record.published = false;
      invalidateRecord(record, 'submit-aborted');
    }
    this.pendingPublication.clear();
    this.staticLayers._abort();
  }

  /** @internal Call only for an explicit diagnostic, after updates and before graph execution.
   * This does not force a telemetry copy or map: retained/skipped views keep the old receipt.
   */
  _setTelemetrySubmit(
    submit: (GpuDrivenLodSubmitIdentity & { readonly graphGeneration?: number }) | undefined,
  ): void {
    for (const key of this.activeKeys) {
      const record = this.records.get(key);
      record?.view._setCullingTelemetrySubmit(
        submit === undefined || record === undefined
          ? undefined
          : {
              frameId: submit.frameId,
              deviceGeneration: submit.deviceGeneration,
              ...(submit.graphGeneration === undefined
                ? {}
                : { graphGeneration: submit.graphGeneration }),
              viewKey: key,
              viewGeneration: record.generation,
              sourceRevision: record.sourcePlan.revision,
            },
      );
    }
  }

  /**
   * Read the cull counters a view copied on the compute that was just
   * submitted. Only re-culled views pay a readback; a retained layer keeps
   * the count of the cull that produced it. A pending map makes the next
   * frame skip its telemetry copy, never its raster work. A view re-culled
   * every frame is replaced before its readback lands, so the count goes to
   * the view's current record.
   */
  private observeCulling(key: string, record: ShadowViewRecord): Promise<void> {
    return record.view.readCullingCounts().then((selection) => {
      const current = this.records.get(key);
      if (selection === undefined || current?.view !== record.view) return;
      if (selection.observation !== undefined)
        current.lastCullingObservation = selection.observation;
      current.texelCulled = selection.texelCulled;
      if (record.cameraCull && current.cameraCull) current.cameraCulled = selection.cameraCulled;
    });
  }

  inspect(): readonly ShadowViewInspection[] {
    return Object.freeze(
      [...this.records.values()]
        .filter((record) => this.activeKeys.has(identityKey(record.identity)))
        .sort((left, right) =>
          identityKey(left.identity).localeCompare(identityKey(right.identity)),
        )
        .map((record) => {
          const view = record.view.inspect();
          return Object.freeze({
            preparation: Object.freeze({
              ...record.preparation,
              cacheRebuildReasons: Object.freeze({ ...record.preparation.cacheRebuildReasons }),
            }),
            ...(view.shadowBundles === undefined ? {} : { shadowBundles: view.shadowBundles }),
            identity: record.identity,
            cache: record.cache,
            ...(record.cache === 'hit' || record.invalidationReason === undefined
              ? {}
              : { invalidationReason: record.invalidationReason }),
            generation: record.generation,
            sourceRevision: record.sourcePlan.revision,
            candidateCount: record.plan.candidateCount,
            batchCount: record.plan.batches.length,
            resourceGeneration: view.resourceGeneration,
            minCasterDiameter: record.minCasterDiameter,
            ...(record.lastCullingObservation === undefined
              ? {}
              : { lastCullingObservation: record.lastCullingObservation }),
            ...(record.texelCulled === undefined ? {} : { texelCulled: record.texelCulled }),
            ...(record.cameraCulled === undefined ? {} : { cameraCulled: record.cameraCulled }),
            ...(record.cache === 'invalidated' && record.dirtyRects !== undefined
              ? { dirtyRects: record.dirtyRects }
              : {}),
          });
        }),
    );
  }

  dispose(): void {
    this.drawnMemberships = new WeakMap();
    const views = new Set([...this.records.values()].map((record) => record.view));
    for (const view of views) view.dispose();
    this.staticLayers.dispose();
    this.records.clear();
    this.activeKeys.clear();
    this.retiring.clear();
    this.pendingPublication.clear();
  }
}

export { ShadowViewStatePool as GpuDrivenShadowViewPool };

/**
 * Caster classes are renderer-global, so every final view of every light kind
 * retains a static layer; only the static layer itself has none.
 */
export function shadowViewHasStaticLayer(identity: ShadowViewIdentity): boolean {
  return identity.layer === undefined;
}
