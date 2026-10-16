import type { PrimitiveTopology } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { BatchTopologyInspection } from '../inspection-types';
import { renderStateHash } from '../pipeline-spec';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';
import { StableRangeAllocator } from '../stable-range-allocator';
import type { PreparedGpuDrivenDraw } from './prepared-draw';

export type { BatchTopologyInspection } from '../inspection-types';

/** High bit in the compact candidate material lane marks a skin palette row. */
export const GPU_DRIVEN_SKIN_FLAG = 0x80000000;

export interface GpuDrivenBatchKey {
  readonly assetHandle: number;
  readonly drawKind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
  /** Stable producer-owned identity; topology never derives this from a shader name. */
  readonly preparedIdentity?: string;
  /** Resource identity projected by the prepared material contract. */
  readonly resourceIdentity?: string;
  /** Closed admission lane for the prepared Standard PBR draw. */
  readonly admission?: 'opaque' | 'alpha-mask';
  /** Graph lane that owns this material after the G-buffer projection. */
  readonly materialPass?: 'deferred' | 'forward-only';
}

export interface GpuDrivenCandidate {
  readonly primitiveIndex: number;
  readonly generation: number;
  readonly drawItemIndex: number;
  readonly instanceOrdinal: number;
}

/**
 * Per-batch LOD selector metadata. The GPU cull selects each candidate's level
 * and appends it to that level's visible segment; the batch owns one indirect
 * command per level.
 */
export interface GpuDrivenBatchLod {
  /** Absolute coverage rows uploaded to the GPU selector; root is implicit. */
  readonly coverages: readonly number[];
  readonly hysteresis?: number;
  /** Adjacent levels blend across a transition band instead of a hard cut. */
  readonly crossfade?: boolean;
  /** Lower-level slots retain author order; unavailable levels have no physical range. */
  readonly ranges?: readonly (
    | {
        readonly first: number;
        readonly count: number;
        readonly baseVertex: number;
      }
    | undefined
  )[];
}

export interface GpuDrivenBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: readonly GpuDrivenCandidate[];
  readonly visibleBase: number;
  readonly visibleCapacity: number;
  /** Reserved per-LOD window; logical candidate count remains visibleCapacity. */
  readonly visibleAllocationCapacity?: number;
  readonly indirectOffset: number;
  /** Producer receipt shared by every member; the batch key includes its generation. */
  readonly prepared?: PreparedGpuDrivenDraw;
  readonly lod?: GpuDrivenBatchLod;
  /**
   * Advances when draw admission or binding facts change without moving a
   * member to another batch. Material row values and per-frame transforms
   * are uploaded through GpuScene and never advance it.
   */
  readonly contentEpoch: number;
}

/** Upper bound of LOD rows per chain; matches the GPU candidate record. */
export const GPU_DRIVEN_LOD_LEVEL_CAPACITY = 8;

/**
 * Consecutive indirect commands (and visible segments) one batch owns: one per
 * selectable LOD level, including the root.
 */
export function batchLodLevelCount(batch: Pick<GpuDrivenBatch, 'lod'>): number {
  const lod = batch.lod;
  if (lod === undefined) return 1;
  return Math.min(
    GPU_DRIVEN_LOD_LEVEL_CAPACITY,
    Math.max(1, lod.coverages.length, (lod.ranges?.length ?? 0) + 1),
  );
}

/** Distance between two level segments of one batch in the visible stream. */
export function batchLevelStride(
  batch: Pick<GpuDrivenBatch, 'visibleCapacity' | 'visibleAllocationCapacity'>,
): number {
  return batch.visibleAllocationCapacity ?? alignInstanceBase(batch.visibleCapacity);
}

/**
 * Visible entries a batch spans: level `l` starts at
 * `visibleBase + l * batchLevelStride(batch)`, so every segment keeps the
 * storage-offset alignment its raster window binding needs.
 */
export function batchVisibleSpan(
  batch: Pick<GpuDrivenBatch, 'lod' | 'visibleCapacity' | 'visibleAllocationCapacity'>,
): number {
  return (
    (batchLodLevelCount(batch) - 1) * batchLevelStride(batch) +
    (batch.visibleAllocationCapacity ?? batch.visibleCapacity)
  );
}

/** Bytes of one indirect command; a batch's level `l` command follows at `+ l * 20`. */
export const GPU_DRIVEN_INDIRECT_COMMAND_BYTES = 20;

export interface SubmissionPlan {
  readonly revision: number;
  readonly batches: readonly GpuDrivenBatch[];
  readonly candidateCount: number;
  readonly visibleCapacity: number;
}

export interface ResourceClassSplitInspection {
  readonly resourceClassCount: number;
  readonly resourceClassSplits: readonly {
    readonly resourceIdentity: string;
    readonly batchIds: readonly number[];
    readonly candidateCount: number;
  }[];
  readonly resourceClassSplitReasons: readonly string[];
}

/**
 * Attribute batch splits to the prepared resource identity. Draw ranges and
 * dynamic page ranges are deliberately absent from this grouping, so they can
 * never be reported as a resource-class split.
 */
export function inspectResourceClassSplits(
  plan: Pick<SubmissionPlan, 'batches'>,
): ResourceClassSplitInspection {
  const groups = new Map<string, { readonly batchIds: number[]; candidateCount: number }>();
  for (const batch of plan.batches) {
    const resourceIdentity = batch.key.resourceIdentity ?? batch.key.materialResourceClass;
    const group = groups.get(resourceIdentity) ?? { batchIds: [], candidateCount: 0 };
    group.batchIds.push(batch.batchId);
    group.candidateCount += batch.candidates.length;
    groups.set(resourceIdentity, group);
  }
  const resourceClassSplits = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resourceIdentity, group]) =>
      Object.freeze({
        resourceIdentity,
        batchIds: Object.freeze([...group.batchIds].sort((left, right) => left - right)),
        candidateCount: group.candidateCount,
      }),
    );
  const resourceClassSplitReasons =
    resourceClassSplits.length <= 1
      ? []
      : resourceClassSplits.map(({ resourceIdentity }) => `resource-class:${resourceIdentity}`);
  return Object.freeze({
    resourceClassCount: resourceClassSplits.length,
    resourceClassSplits: Object.freeze(resourceClassSplits),
    resourceClassSplitReasons: Object.freeze(resourceClassSplitReasons),
  });
}

export interface SubmissionCandidateMembershipEntry {
  readonly batch: GpuDrivenBatch;
  readonly candidate: GpuDrivenCandidate;
}

/**
 * Immutable reverse membership for one submission topology.
 *
 * Shadow views query the same candidate domain as the main view. Keeping the
 * primitive-to-batch join beside the immutable plan makes that lookup once per
 * topology instead of rescanning every batch for every view.
 */
export interface SubmissionCandidateMembership {
  readonly source: SubmissionPlan;
  readonly byPrimitiveIndex: ReadonlyMap<number, readonly SubmissionCandidateMembershipEntry[]>;
}

const submissionCandidateMembershipCache = new WeakMap<
  SubmissionPlan,
  SubmissionCandidateMembership
>();

export interface SubmissionMembershipWork {
  membershipBuilds: number;
  membershipCandidateScans: number;
}

export function buildSubmissionCandidateMembership(
  source: SubmissionPlan,
  work?: SubmissionMembershipWork,
): SubmissionCandidateMembership {
  const cached = submissionCandidateMembershipCache.get(source);
  if (cached !== undefined) return cached;

  if (work !== undefined) work.membershipBuilds++;
  const mutable = new Map<number, SubmissionCandidateMembershipEntry[]>();
  for (const batch of source.batches) {
    for (const candidate of batch.candidates) {
      if (work !== undefined) work.membershipCandidateScans++;
      const entries = mutable.get(candidate.primitiveIndex) ?? [];
      entries.push({ batch, candidate });
      mutable.set(candidate.primitiveIndex, entries);
    }
  }
  // This builder is the only writer; publish its index directly after sealing rows.
  for (const entries of mutable.values()) Object.freeze(entries);
  const byPrimitiveIndex: ReadonlyMap<number, readonly SubmissionCandidateMembershipEntry[]> =
    mutable;
  const membership: SubmissionCandidateMembership = {
    source,
    byPrimitiveIndex,
  };
  submissionCandidateMembershipCache.set(source, membership);
  return membership;
}

/**
 * Re-project one source topology for a view without changing batch identity.
 * The returned plan only changes candidate windows and keeps batch ids,
 * generations, draw ranges, and indirect offsets from the source plan.
 */
export function buildBatchAlignedSubmission(
  source: SubmissionPlan,
  candidatesByBatch: ReadonlyMap<number, readonly GpuDrivenCandidate[]>,
): SubmissionPlan {
  let visibleBase = 0;
  const batches: GpuDrivenBatch[] = [];
  for (const sourceBatch of source.batches) {
    const candidates = candidatesByBatch.get(sourceBatch.batchId) ?? [];
    if (candidates.length === 0) continue;
    const batch: GpuDrivenBatch = Object.freeze({
      ...sourceBatch,
      candidates: Object.freeze([...candidates]),
    });
    batches.push(batch);
    visibleBase = Math.max(visibleBase, batch.visibleBase + batchVisibleSpan(batch));
  }
  return Object.freeze({
    revision: source.revision,
    batches: Object.freeze(batches),
    candidateCount: batches.reduce((total, batch) => total + batch.candidates.length, 0),
    visibleCapacity: visibleBase,
  });
}

interface MutableBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: Map<string, GpuDrivenCandidate>;
  readonly prepared: PreparedGpuDrivenDraw | undefined;
  readonly lod: GpuDrivenBatchLod | undefined;
  contentEpoch: number;
  allocation?: {
    visibleStart: number;
    levelCapacity: number;
    indirectStart: number;
    levels: number;
  };
  /** Last published frozen batch; cleared by any membership or content edit. */
  published: GpuDrivenBatch | undefined;
}

interface EligibleGpuDrivenDraw {
  readonly sourceDrawIndex: number;
  readonly key: GpuDrivenBatchKey;
  readonly prepared?: PreparedGpuDrivenDraw;
  readonly lod?: GpuDrivenBatchLod;
}

interface MembershipDraw {
  readonly sourceDrawIndex: number;
  readonly key: GpuDrivenBatchKey;
  readonly batchText: string;
  readonly candidateKeyPrefix: string;
  readonly lod: GpuDrivenBatchLod | undefined;
}

interface MembershipProjection {
  readonly instanceCount: number;
  readonly draws: readonly MembershipDraw[];
  /** Scalar preparation dependencies absent from the batch key. */
  readonly content: readonly (number | boolean | undefined)[];
}

function hasActiveAlphaMask(
  material: RenderSceneSlot['snapshot']['material'],
  prepared: PreparedGpuDrivenDraw,
): boolean {
  const { cutoff, source } = prepared.alphaMask;
  if (cutoff.length === 0 || source.length === 0) return false;
  // Standard's shared receipt describes the alpha-clip interface; the actual
  // mode is selected by its authored cutoff or hash switch. Custom producers own coverage in
  // their receipt, so a declared clip remains masked without guessing a field.
  if (
    prepared.identity.material === 'forgeax::default-standard-pbr' ||
    prepared.identity.material === 'forgeax::pbr-skin' ||
    prepared.identity.material === 'forgeax::default-standard-pbr-skin'
  ) {
    const value = material.paramSnapshot?.[cutoff];
    return (
      (typeof value === 'number' && value > 0) ||
      Number(material.paramSnapshot?.alphaHash ?? 0) > 0.5
    );
  }
  return true;
}

function eligibleDraws(slot: RenderSceneSlot): readonly EligibleGpuDrivenDraw[] {
  return eligibleGpuDrivenDraws(slot.snapshot);
}

/** Shared admission for real scene draws and explicit hidden pipeline requests. */
export function eligibleGpuDrivenDraws(
  snapshot: RenderableSnapshot,
): readonly EligibleGpuDrivenDraw[] {
  const draws = snapshot.gpuDrivenDraws;
  if (
    draws === undefined ||
    draws.length === 0 ||
    snapshot.instances?.instanceCount === 0 ||
    snapshot.localAabb === undefined ||
    snapshot.morph !== undefined ||
    snapshot.spriteInstances !== undefined
  ) {
    return [];
  }
  const result: EligibleGpuDrivenDraw[] = [];
  for (let compactIndex = 0; compactIndex < draws.length; compactIndex += 1) {
    const draw = draws[compactIndex];
    if (draw === undefined) continue;
    const drawItemIndex = gpuDrivenSourceDrawItemIndex(draw, compactIndex);
    const prepared = draw.prepared;
    const material = snapshot.materials[draw.materialSlot] ?? snapshot.material;
    if (prepared !== undefined) {
      // Prepared producer identity is the admission proof; the material
      // identifier is only a consistency check, never a built-in allow-list.
      const materialIdentityMatches =
        material.materialShaderId === undefined ||
        prepared.identity.material === material.materialShaderId;
      const isAlphaBlend =
        material.transparent === true || material.renderState?.blend !== undefined;
      const cpuOnlyMaterialResources =
        (material.textureSources?.size ?? 0) > 0 || (material.videoTextureFields?.size ?? 0) > 0;
      // Indirect draws carry no per-draw setStencilReference; authored stencil
      // state keeps the CPU draw that applies the pass reference.
      const stencilAuthored = material.renderState?.stencil !== undefined;
      const skinReady =
        prepared.identity.deformation !== 'skin' ||
        (snapshot.skin?.storageOrUniform === 'storage' &&
          snapshot.skin.customDataStart >= 0 &&
          Number.isInteger(snapshot.skin.customDataStart) &&
          hasFiniteOrderedBounds(snapshot.skin.bounds) &&
          prepared.skinPaletteAddress !== undefined);
      if (
        !materialIdentityMatches ||
        isAlphaBlend ||
        cpuOnlyMaterialResources ||
        stencilAuthored ||
        (prepared.identity.deformation !== 'rigid' && prepared.identity.deformation !== 'skin') ||
        !skinReady
      )
        continue;
      const preparedIdentity = [
        prepared.identity.material,
        prepared.identity.geometry,
        prepared.identity.deformation,
        ...(prepared.receiptIdentity === undefined ? [] : [prepared.receiptIdentity]),
        prepared.receiptGeneration,
      ].join('|');
      const stateHash = renderStateHash(material.renderState);
      const admission = hasActiveAlphaMask(material, prepared) ? 'alpha-mask' : 'opaque';
      result.push({
        sourceDrawIndex: drawItemIndex,
        key: {
          assetHandle: snapshot.assetHandle,
          drawKind: draw.kind,
          first: prepared.first,
          count: prepared.count,
          baseVertex: prepared.baseVertex,
          materialSlot: draw.materialSlot,
          topology: prepared.topology,
          pipelineClass: stateHash === '' ? preparedIdentity : `${preparedIdentity}|${stateHash}`,
          materialResourceClass: draw.materialResourceClass,
          preparedIdentity,
          resourceIdentity: draw.materialResourceClass,
          admission,
          materialPass: material.deferredPass === true ? 'deferred' : 'forward-only',
        },
        prepared,
        ...drawLod(draw, snapshot),
      });
      continue;
    }
    result.push({
      sourceDrawIndex: drawItemIndex,
      key: {
        assetHandle: snapshot.assetHandle,
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        pipelineClass: draw.pipelineClass,
        materialResourceClass: draw.materialResourceClass,
      },
      ...drawLod(draw, snapshot),
    });
  }
  return result;
}

function drawLod(
  draw: NonNullable<RenderSceneSlot['snapshot']['gpuDrivenDraws']>[number],
  snapshot: RenderSceneSlot['snapshot'],
): Pick<EligibleGpuDrivenDraw, 'lod'> {
  if (snapshot.lods === undefined) return {};
  const ranges = draw.lodRanges;
  const hysteresis = snapshot.lodHysteresis;
  return {
    lod: Object.freeze({
      coverages: Object.freeze([1, ...snapshot.lods.map((lod) => lod.screenCoverage)]),
      ...(hysteresis === undefined ? {} : { hysteresis }),
      ...(ranges === undefined
        ? {}
        : {
            ranges: Object.freeze(
              ranges.map((range) =>
                range === undefined ? undefined : Object.freeze({ ...range }),
              ),
            ),
          }),
    }),
  };
}

/**
 * Dependencies read by prepareBatchRows / filteredPlan but absent from the
 * batch key. Pipeline, resource bindings, LOD and pass membership already
 * select that key. Material values belong to the independently updated GPU
 * material table: comparing their complete records here both repeats source
 * admission and invalidates draw preparation when only a row value changed.
 */
function preparationContent(
  slot: RenderSceneSlot,
  draws: readonly EligibleGpuDrivenDraw[],
): MembershipProjection['content'] {
  const snapshot = slot.snapshot;
  const skin = snapshot.skin;
  const content: (number | boolean | undefined)[] = [
    skin === undefined ||
      (skin.storageOrUniform === 'storage' &&
        skin.customDataStart >= 0 &&
        Number.isInteger(skin.customDataStart) &&
        skin.buffer !== undefined &&
        hasFiniteOrderedBounds(skin.bounds)),
  ];
  for (const draw of draws) {
    const material = snapshot.materials[draw.key.materialSlot] ?? snapshot.material;
    content.push(
      material.materialHandle,
      material.standardTextureMask,
      typeof material.paramSnapshot?.transmission === 'number' &&
        material.paramSnapshot.transmission > 0,
    );
  }
  return content;
}

function hasFiniteOrderedBounds(bounds: Float32Array | undefined): boolean {
  if (bounds === undefined || bounds.length < 6) return false;
  const minX = bounds[0];
  const minY = bounds[1];
  const minZ = bounds[2];
  const maxX = bounds[3];
  const maxY = bounds[4];
  const maxZ = bounds[5];
  return (
    minX !== undefined &&
    minY !== undefined &&
    minZ !== undefined &&
    maxX !== undefined &&
    maxY !== undefined &&
    maxZ !== undefined &&
    Number.isFinite(minX) &&
    Number.isFinite(minY) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxX) &&
    Number.isFinite(maxY) &&
    Number.isFinite(maxZ) &&
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ
  );
}

function keyText(key: GpuDrivenBatchKey): string {
  return JSON.stringify(key);
}

/**
 * LOD members share a batch only with an identical LOD chain: the batch owns
 * one indirect command per level, and each command draws that level's range
 * for the members the GPU cull selected into it.
 */
function batchText(key: GpuDrivenBatchKey, lod: GpuDrivenBatchLod | undefined): string {
  return lod === undefined ? keyText(key) : `${keyText(key)}|lod:${JSON.stringify(lod)}`;
}

function membershipProjection(
  slot: RenderSceneSlot,
  draws = eligibleDraws(slot),
): MembershipProjection {
  const instanceCount = slot.snapshot.instances?.instanceCount ?? 1;
  return {
    instanceCount,
    draws: draws.map((draw) => ({
      sourceDrawIndex: draw.sourceDrawIndex,
      key: draw.key,
      batchText: batchText(draw.key, draw.lod),
      candidateKeyPrefix: `${slot.slot}:${draw.sourceDrawIndex}:`,
      lod: draw.lod,
    })),
    content: preparationContent(slot, draws),
  };
}

function alignInstanceBase(value: number): number {
  // Raster binds each batch's visible-index and compact-transform segment at
  // a static storage-buffer offset. WebGPU requires those offsets to satisfy
  // minStorageBufferOffsetAlignment (256 bytes on the portable baseline), so
  // both the u32 stream (64 entries) and mat4 stream (4 entries) align when
  // the shared instance base is a multiple of 64.
  return Math.ceil(value / 64) * 64;
}

type LodHeightSource = Pick<RenderableSnapshot, 'localAabb' | 'transform'>;

/** Conservative world-space bounding radius of a snapshot's local AABB; NaN without one. */
function worldBoundsRadius(snapshot: LodHeightSource): number {
  const aabb = snapshot.localAabb;
  if (aabb === undefined || aabb.length < 6) return Number.NaN;
  const halfX = Math.abs((aabb[3] ?? 0) - (aabb[0] ?? 0)) * 0.5;
  const halfY = Math.abs((aabb[4] ?? 0) - (aabb[1] ?? 0)) * 0.5;
  const halfZ = Math.abs((aabb[5] ?? 0) - (aabb[2] ?? 0)) * 0.5;
  const world = snapshot.transform.world;
  const worldHalfX =
    Math.abs(world[0] ?? 0) * halfX +
    Math.abs(world[4] ?? 0) * halfY +
    Math.abs(world[8] ?? 0) * halfZ;
  const worldHalfY =
    Math.abs(world[1] ?? 0) * halfX +
    Math.abs(world[5] ?? 0) * halfY +
    Math.abs(world[9] ?? 0) * halfZ;
  const worldHalfZ =
    Math.abs(world[2] ?? 0) * halfX +
    Math.abs(world[6] ?? 0) * halfY +
    Math.abs(world[10] ?? 0) * halfZ;
  return Math.hypot(worldHalfX, worldHalfY, worldHalfZ);
}

export type LodHeightCamera = Pick<
  CameraSnapshot,
  'position' | 'projection' | 'fov' | 'orthoTop' | 'orthoBottom'
>;

export function projectedHeightForCandidate(
  slot: RenderSceneSlot,
  camera: LodHeightCamera,
): number {
  return projectedHeightForSnapshot(slot.snapshot, camera);
}

/** Same projected height the GPU LOD projection measures, for one renderable snapshot. */
export function projectedHeightForSnapshot(
  snapshot: LodHeightSource,
  camera: LodHeightCamera,
): number {
  const aabb = snapshot.localAabb;
  if (aabb === undefined || aabb.length < 6) return Number.NaN;
  const centerX = ((aabb[0] ?? 0) + (aabb[3] ?? 0)) * 0.5;
  const centerY = ((aabb[1] ?? 0) + (aabb[4] ?? 0)) * 0.5;
  const centerZ = ((aabb[2] ?? 0) + (aabb[5] ?? 0)) * 0.5;
  const world = snapshot.transform.world;
  const dx =
    (world[0] ?? 0) * centerX +
    (world[4] ?? 0) * centerY +
    (world[8] ?? 0) * centerZ +
    (world[12] ?? 0) -
    (camera.position[0] ?? 0);
  const dy =
    (world[1] ?? 0) * centerX +
    (world[5] ?? 0) * centerY +
    (world[9] ?? 0) * centerZ +
    (world[13] ?? 0) -
    (camera.position[1] ?? 0);
  const dz =
    (world[2] ?? 0) * centerX +
    (world[6] ?? 0) * centerY +
    (world[10] ?? 0) * centerZ +
    (world[14] ?? 0) -
    (camera.position[2] ?? 0);
  return measureProjectedHeight({
    radius: worldBoundsRadius(snapshot),
    depth: Math.hypot(dx, dy, dz),
    projection: camera.projection,
    fov: camera.fov,
    orthoHeight: Math.abs(camera.orthoTop - camera.orthoBottom),
  });
}

/** Stable compatibility grouping; per-view visibility never mutates this owner. */
export class BatchTopology {
  private readonly batches = new Map<string, MutableBatch>();
  private readonly membershipByPrimitive = new Map<number, MembershipProjection>();
  private readonly ineligiblePrimitives = new Set<number>();
  private readonly generationByBatchId: number[] = [];
  private readonly freeBatchIds: number[] = [];
  private revision = 0;
  private rebuilds = 0;
  private patches = 0;
  private contentPatches = 0;
  private planBuilds = 0;
  private batchesRebuilt = 0;
  private membershipChecks = 0;
  private membershipAllocations = 0;
  private candidateAdds = 0;
  private candidateRemoves = 0;
  private cachedPlan: SubmissionPlan | undefined;
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private windowCompactions = 0;
  private windowRelocations = 0;

  rebuild(slots: readonly RenderSceneSlot[]): void {
    this.batches.clear();
    this.visibleRanges.reset();
    this.indirectRanges.reset();
    this.membershipByPrimitive.clear();
    this.ineligiblePrimitives.clear();
    // Every id becomes free with its generation retained, so a rebuilt batch
    // never repeats a published `(batchId, generation)` with other contents.
    this.freeBatchIds.length = 0;
    for (let batchId = this.generationByBatchId.length - 1; batchId >= 0; batchId -= 1) {
      this.freeBatchIds.push(batchId);
    }
    for (const slot of slots) this.add(slot);
    this.revision += 1;
    this.rebuilds += 1;
    this.cachedPlan = undefined;
  }

  apply(delta: RenderSceneApplyResult): boolean {
    let changed = false;
    let topologyChanged = false;
    for (const removed of delta.removedSlots) {
      const removedChanged = this.remove(removed.slot);
      changed = removedChanged || changed;
      topologyChanged = removedChanged || topologyChanged;
    }
    for (const slot of delta.recreatedSlots) {
      const removedChanged = this.remove(slot.slot);
      const addedChanged = this.add(slot);
      changed = removedChanged || addedChanged || changed;
      topologyChanged = removedChanged || addedChanged || topologyChanged;
    }
    // Membership depends on source descriptors and instance cardinality.
    // Root matrices feed visibility without changing this dependency.
    const contentUpdatedSlots = delta.contentUpdatedSlots;
    const instanceUpdatedSlots = delta.instanceUpdatedSlots;
    const membershipUpdates = new Map<number, { slot: RenderSceneSlot; content: boolean }>();
    for (const slot of contentUpdatedSlots) {
      membershipUpdates.set(slot.slot, { slot, content: true });
    }
    // Instance cardinality is a membership input, including in mixed updates.
    for (const slot of instanceUpdatedSlots) {
      if (!membershipUpdates.has(slot.slot)) {
        membershipUpdates.set(slot.slot, { slot, content: false });
      }
    }
    for (const update of membershipUpdates.values()) {
      const { slot, content } = update;
      const eligible = eligibleDraws(slot);
      const next = membershipProjection(slot, eligible);
      // The projection is one descriptor per eligible source draw; candidate
      // identities are derived from the stable ordinal and are not stored as
      // N per-instance comparison records.
      this.membershipAllocations += next.draws.length;
      const previous = this.membershipByPrimitive.get(slot.slot);
      this.membershipChecks += 1;
      const topologyStable =
        previous !== undefined &&
        previous.instanceCount === next.instanceCount &&
        previous.draws.length === next.draws.length &&
        previous.draws.every((membership, index) => {
          const candidate = next.draws[index];
          return (
            candidate !== undefined &&
            membership.sourceDrawIndex === candidate.sourceDrawIndex &&
            membership.batchText === candidate.batchText
          );
        });
      if (!topologyStable) {
        const removedChanged = this.remove(slot.slot);
        const addedChanged = this.add(slot, eligible, next);
        changed = removedChanged || addedChanged || changed;
        topologyChanged = removedChanged || addedChanged || topologyChanged;
        continue;
      }
      this.membershipByPrimitive.set(slot.slot, next);
      if (!content) continue;
      const contentChanged =
        previous.content.length !== next.content.length ||
        previous.content.some((value, index) => value !== next.content[index]);
      let patched = false;
      for (let index = 0; index < next.draws.length; index += 1) {
        const membership = next.draws[index];
        if (membership === undefined) continue;
        // The batch text carries the LOD chain, so a LOD edit already moved
        // the member to another batch above.
        if (!contentChanged) continue;
        const batch = this.batches.get(membership.batchText);
        if (batch !== undefined) {
          batch.contentEpoch += 1;
          batch.published = undefined;
          patched = true;
        }
      }
      if (patched) {
        changed = true;
        this.contentPatches += 1;
        this.cachedPlan = undefined;
      }
    }
    for (const slot of delta.createdSlots) {
      const addedChanged = this.add(slot);
      changed = addedChanged || changed;
      topologyChanged = addedChanged || topologyChanged;
    }
    if (topologyChanged) {
      this.revision += 1;
      this.patches += 1;
      this.cachedPlan = undefined;
    }
    return changed;
  }

  /**
   * Publish the immutable plan. Clean batches keep their frozen object while
   * their aligned visible base is unchanged, so downstream per-batch memos
   * survive unrelated membership edits.
   */
  plan(): SubmissionPlan {
    if (this.cachedPlan !== undefined) return this.cachedPlan;
    this.planBuilds += 1;
    const ordered = [...this.batches.values()].sort((left, right) => left.batchId - right.batchId);
    let liveVisibleUnits = 0;
    let liveIndirectUnits = 0;
    for (const batch of ordered) {
      const levels = batchLodLevelCount({ ...(batch.lod === undefined ? {} : { lod: batch.lod }) });
      const required = Math.max(1, Math.ceil(batch.candidates.size / 64));
      const previous = batch.allocation;
      if (
        previous === undefined ||
        previous.levelCapacity < required ||
        previous.levelCapacity > required * 4 ||
        previous.levels !== levels
      ) {
        if (previous !== undefined) {
          this.visibleRanges.release(
            previous.visibleStart,
            previous.levelCapacity * previous.levels,
          );
          this.windowRelocations += 1;
        }
        const indirectStart =
          previous?.levels === levels
            ? previous.indirectStart
            : this.indirectRanges.allocate(levels);
        if (previous !== undefined && previous.levels !== levels)
          this.indirectRanges.release(previous.indirectStart, previous.levels);
        batch.allocation = {
          visibleStart: this.visibleRanges.allocate(required * levels),
          levelCapacity: required,
          indirectStart,
          levels,
        };
      }
      const allocation = batch.allocation;
      if (allocation === undefined) throw new Error('batch has no window allocation');
      liveVisibleUnits += allocation.levelCapacity * allocation.levels;
      liveIndirectUnits += allocation.levels;
    }
    if (
      this.visibleRanges.requiredCapacity() > Math.max(16, liveVisibleUnits * 2) ||
      this.indirectRanges.requiredCapacity() > Math.max(16, liveIndirectUnits * 2)
    ) {
      this.visibleRanges.reset();
      this.indirectRanges.reset();
      this.windowCompactions += 1;
      for (const batch of ordered) {
        const allocation = batch.allocation;
        if (allocation === undefined) throw new Error('batch has no window allocation');
        allocation.visibleStart = this.visibleRanges.allocate(
          allocation.levelCapacity * allocation.levels,
        );
        allocation.indirectStart = this.indirectRanges.allocate(allocation.levels);
      }
    }
    let visibleCapacity = 0;
    let candidateCount = 0;
    const batches = ordered.map((batch): GpuDrivenBatch => {
      const allocation = batch.allocation;
      if (allocation === undefined) throw new Error('batch has no window allocation');
      const visibleBase = allocation.visibleStart * 64;
      const indirectOffset = allocation.indirectStart * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
      let published = batch.published;
      if (
        published === undefined ||
        published.visibleBase !== visibleBase ||
        published.indirectOffset !== indirectOffset ||
        published.visibleAllocationCapacity !== allocation.levelCapacity * 64
      ) {
        const candidates =
          published?.candidates ??
          Object.freeze(
            [...batch.candidates.values()].sort(
              (left, right) =>
                left.primitiveIndex - right.primitiveIndex ||
                left.drawItemIndex - right.drawItemIndex ||
                left.instanceOrdinal - right.instanceOrdinal,
            ),
          );
        published = Object.freeze({
          batchId: batch.batchId,
          generation: batch.generation,
          key: batch.key,
          candidates,
          visibleBase,
          visibleCapacity: candidates.length,
          visibleAllocationCapacity: allocation.levelCapacity * 64,
          indirectOffset,
          ...(batch.prepared === undefined ? {} : { prepared: batch.prepared }),
          ...(batch.lod === undefined ? {} : { lod: batch.lod }),
          contentEpoch: batch.contentEpoch,
        });
        batch.published = published;
        this.batchesRebuilt += 1;
      }
      visibleCapacity = Math.max(visibleCapacity, visibleBase + batchVisibleSpan(published));
      candidateCount += published.candidates.length;
      return published;
    });
    this.cachedPlan = Object.freeze({
      revision: this.revision,
      batches: Object.freeze(batches),
      candidateCount,
      visibleCapacity,
    });
    return this.cachedPlan;
  }

  inspect(): BatchTopologyInspection {
    let candidateCount = 0;
    for (const batch of this.batches.values()) candidateCount += batch.candidates.size;
    const resourceClasses = inspectResourceClassSplits(this.plan());
    return {
      revision: this.revision,
      batchCount: this.batches.size,
      candidateCount,
      rebuilds: this.rebuilds,
      patches: this.patches,
      ineligible: this.ineligiblePrimitives.size,
      contentPatches: this.contentPatches,
      planBuilds: this.planBuilds,
      batchesRebuilt: this.batchesRebuilt,
      membershipChecks: this.membershipChecks,
      membershipAllocations: this.membershipAllocations,
      candidateAdds: this.candidateAdds,
      candidateRemoves: this.candidateRemoves,
      windowCompactions: this.windowCompactions,
      windowRelocations: this.windowRelocations,
      resourceClassCount: resourceClasses.resourceClassCount,
      resourceClassSplits: resourceClasses.resourceClassSplits,
      resourceClassSplitReasons: resourceClasses.resourceClassSplitReasons,
    };
  }

  private add(
    slot: RenderSceneSlot,
    draws = eligibleDraws(slot),
    projection?: MembershipProjection,
  ): boolean {
    if (draws.length === 0) {
      this.ineligiblePrimitives.add(slot.slot);
      return false;
    }
    this.ineligiblePrimitives.delete(slot.slot);
    const memberships = projection ?? membershipProjection(slot, draws);
    const instanceCount = memberships.instanceCount;
    if (projection === undefined) this.membershipAllocations += memberships.draws.length;
    for (let drawIndex = 0; drawIndex < draws.length; drawIndex++) {
      const draw = draws[drawIndex];
      const membership = memberships.draws[drawIndex];
      if (draw === undefined || membership === undefined) continue;
      const text = membership.batchText;
      if (instanceCount === 0) continue;
      let batch = this.batches.get(text);
      if (batch === undefined) {
        const reused = this.freeBatchIds.pop();
        const batchId = reused ?? this.generationByBatchId.length;
        const generation = reused === undefined ? 0 : (this.generationByBatchId[batchId] ?? -1) + 1;
        this.generationByBatchId[batchId] = generation;
        batch = {
          batchId,
          generation,
          key: Object.freeze(draw.key),
          candidates: new Map(),
          prepared: draw.prepared,
          lod: draw.lod,
          contentEpoch: 0,
          published: undefined,
        };
        this.batches.set(text, batch);
      }
      const previousCount = batch.candidates.size;
      batch.contentEpoch += instanceCount - (previousCount === 0 ? 1 : 0);
      batch.published = undefined;
      for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal += 1) {
        const candidateKey = `${slot.slot}:${draw.sourceDrawIndex}:${instanceOrdinal}`;
        batch.candidates.set(
          candidateKey,
          Object.freeze({
            primitiveIndex: slot.slot,
            generation: slot.generation,
            drawItemIndex: draw.sourceDrawIndex,
            instanceOrdinal,
          }),
        );
        this.candidateAdds += 1;
      }
    }
    this.membershipByPrimitive.set(slot.slot, memberships);
    return true;
  }

  private remove(primitiveIndex: number): boolean {
    this.ineligiblePrimitives.delete(primitiveIndex);
    const memberships = this.membershipByPrimitive.get(primitiveIndex);
    this.membershipByPrimitive.delete(primitiveIndex);
    if (memberships === undefined) return false;
    for (const membership of memberships.draws) {
      const batch = this.batches.get(membership.batchText);
      if (batch === undefined) continue;
      for (
        let instanceOrdinal = 0;
        instanceOrdinal < memberships.instanceCount;
        instanceOrdinal += 1
      ) {
        const candidateKey = `${membership.candidateKeyPrefix}${instanceOrdinal}`;
        if (!batch.candidates.delete(candidateKey)) continue;
        batch.published = undefined;
        batch.contentEpoch += 1;
        this.candidateRemoves += 1;
      }
      if (batch.candidates.size === 0) {
        if (batch.allocation !== undefined) {
          this.visibleRanges.release(
            batch.allocation.visibleStart,
            batch.allocation.levelCapacity * batch.allocation.levels,
          );
          this.indirectRanges.release(batch.allocation.indirectStart, batch.allocation.levels);
        }
        this.batches.delete(membership.batchText);
        this.freeBatchIds.push(batch.batchId);
      }
    }

    return true;
  }
}
