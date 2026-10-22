import type { MeshLodLevel, PrimitiveTopology } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { BatchTopologyInspection } from '../inspection-types';
import { isReflectedTransform } from '../material-render-state';
import type { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MeshFrame } from '../scene/mesh-frame';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';
import { type BatchGeometry, captureBatchGeometry } from './batch-execution';
import { batchVisibleSpan } from './batch-layout';
import { BatchSources, MemberCandidates } from './batch-members';
import { inheritTaskHeaders } from './fixed-task-plan';
import { MeshBatchProjection } from './mesh-batches';
import type { PreparedGpuDrivenDraw } from './prepared-draw';

export type { BatchTopologyInspection } from '../inspection-types';

/** Authored instance binding, shared by every submesh execution. */
export interface MeshBatchSource {
  readonly draws: readonly EligibleGpuDrivenDraw[];
  readonly materialOverrides?: NonNullable<RenderableSnapshot['materialOverrides']>;
  readonly material: MaterialResource;
  readonly materials: readonly MaterialResource[];
  readonly materialBindingSources: RenderableSnapshot['materialBindingSources'];
}

export interface GpuDrivenBatchBinding {
  readonly source?: MeshBatchSource;
  readonly worldId: number;
  readonly assetHandle: number;
  readonly lods?: readonly MeshLodLevel['mesh'][];
  readonly material: MaterialResource;
  readonly geometry: BatchGeometry;
  readonly drawItemIndex: number;
}

export interface GpuDrivenBatchKey {
  readonly drawItemIndex?: number;
  readonly worldId?: number;
  readonly assetHandle: number;
  readonly drawKind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  /** Model parity splits raster work without changing authored material state. */
  readonly reflected?: boolean;
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

/** Source membership is independent of material content and GPU residency. */
export interface GpuDrivenBatchMember {
  readonly primitiveIndex: number;
  readonly generation: number;
  readonly entityKey: number;
  readonly drawItemIndex: number;
  readonly instanceCount: number;
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
  readonly candidates: FrameList<GpuDrivenCandidate>;
  /** Present on native geometry batches; low-level selector plans need only candidates. */
  readonly members?: FrameList<GpuDrivenBatchMember>;
  /** Stable source binding; execution joins this with an accepted material version. */
  readonly binding?: GpuDrivenBatchBinding;
  /** Captured execution address; source-only plans resolve their shared binding when encoded. */
  readonly materialAddress?: number;
  readonly geometryAddress?: number;
  /** Addresses refer to the sealed frame resource mapping, rather than physical rows. */
  readonly logicalResources?: true;
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

export interface SubmissionPlan {
  readonly revision: number;
  readonly batches: FrameList<GpuDrivenBatch>;
  readonly candidateCount: number;
  /** Covers live windows; source plans retain the reserved address high-water. */
  readonly visibleCapacity: number;
  /** The canonical source root precedes per-view Mesh execution expansion. */
  readonly sourceGroups?: BatchSources;
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

export interface SubmissionMembershipWork {
  membershipBuilds: number;
  membershipCandidateScans: number;
}

export function buildSubmissionCandidateMembership(
  source: SubmissionPlan,
  work?: SubmissionMembershipWork,
): SubmissionCandidateMembership {
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
  return membership;
}

/**
 * Re-project one source topology for a view without changing batch identity.
 * The returned plan only changes candidate windows and keeps batch ids,
 * generations, draw ranges, and indirect offsets from the source plan.
 */
export function buildBatchAlignedSubmission(
  source: SubmissionPlan,
  candidatesByBatch: ReadonlyMap<number, FrameList<GpuDrivenCandidate>>,
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
  return inheritTaskHeaders(
    source,
    Object.freeze({
      revision: source.revision,
      batches: Object.freeze(batches),
      candidateCount: batches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    }),
  );
}

interface MutableBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  members: MemberCandidates;
  readonly binding: GpuDrivenBatchBinding;
  readonly lod: GpuDrivenBatchLod | undefined;
  contentEpoch: number;
}

export interface EligibleGpuDrivenDraw {
  readonly binding: GpuDrivenBatchBinding;
  readonly prepared?: PreparedGpuDrivenDraw;
  readonly sourceDrawIndex: number;
  readonly key: GpuDrivenBatchKey;
  readonly lod?: GpuDrivenBatchLod;
}

interface MembershipDraw {
  readonly sourceDrawIndex: number;
  readonly key: GpuDrivenBatchKey;
  readonly batchText: string;
  readonly lod: GpuDrivenBatchLod | undefined;
}

interface MembershipProjection {
  readonly instanceCount: number;
  readonly draws: readonly MembershipDraw[];
}

function eligibleDraws(slot: RenderSceneSlot): readonly EligibleGpuDrivenDraw[] {
  const snapshot = slot.snapshot;
  // Authored hiding removes raster demand; per-view culling retains membership.
  // Explicit candidate preparation consumes eligibleGpuDrivenDraws directly.
  if (snapshot.authorVisible === false) return [];
  const draws = eligibleGpuDrivenDraws(snapshot);
  const first = draws[0];
  if (first === undefined) return [];
  const source: MeshBatchSource = Object.freeze({
    draws: Object.freeze(draws),
    ...(snapshot.materialOverrides === undefined
      ? {}
      : { materialOverrides: snapshot.materialOverrides }),
    material: snapshot.material,
    materials: snapshot.materials,
    materialBindingSources: snapshot.materialBindingSources,
  });
  // Membership is a Mesh and the complete authored binding. Submeshes are
  // executions over this one candidate domain, never independent copies.
  return [
    {
      ...first,
      sourceDrawIndex: 0,
      binding: Object.freeze({ ...first.binding, source }),
      key: {
        ...first.key,
        drawItemIndex: 0,
        materialResourceClass: JSON.stringify([
          // Hand-authored recorder sources may omit the authored table.
          ...(snapshot.materialOverrides === undefined
            ? [
                getOpaqueResourceIdentity(source.material),
                snapshot.materials.map(getOpaqueResourceIdentity),
                snapshot.materialBindingSources,
              ]
            : []),
          (source.materialOverrides ?? []).map((resource) =>
            resource === undefined ? 0 : getOpaqueResourceIdentity(resource),
          ),
        ]),
      },
    },
  ];
}

export function gpuDrivenGeometryEligible(snapshot: RenderableSnapshot): boolean {
  if (
    snapshot.instances?.instanceCount === 0 ||
    (snapshot.localAabb === undefined && snapshot.skinBinding === undefined) ||
    snapshot.morph !== undefined ||
    snapshot.spriteInstances !== undefined
  )
    return false;
  return true;
}

/** Binding admission reads geometry and instance facts, never material content. */
export function eligibleGpuDrivenDraws(
  snapshot: RenderableSnapshot,
): readonly EligibleGpuDrivenDraw[] {
  if (snapshot.assetHandle === undefined) return [];
  const draws = snapshot.gpuDrivenDraws;
  if (draws === undefined || draws.length === 0 || !gpuDrivenGeometryEligible(snapshot)) return [];
  const reflected = isReflectedTransform(snapshot.transform.world);
  const result: EligibleGpuDrivenDraw[] = [];
  for (let compactIndex = 0; compactIndex < draws.length; compactIndex++) {
    const draw = draws[compactIndex];
    if (draw === undefined) continue;
    const geometry = captureBatchGeometry(draw.geometry);
    const material = snapshot.materials[draw.materialSlot] ?? snapshot.material;
    const resourceIdentity = String(getOpaqueResourceIdentity(material));
    const drawItemIndex = gpuDrivenSourceDrawItemIndex(draw, compactIndex);
    result.push({
      sourceDrawIndex: drawItemIndex,
      ...(draw.prepared === undefined ? {} : { prepared: draw.prepared }),
      binding: Object.freeze({
        worldId: snapshot.worldId,
        assetHandle: snapshot.assetHandle,
        ...(snapshot.lods === undefined
          ? {}
          : { lods: Object.freeze(snapshot.lods.map((lod) => lod.mesh)) }),
        material,
        geometry,
        drawItemIndex,
      }),
      key: {
        drawItemIndex,
        worldId: snapshot.worldId,
        assetHandle: snapshot.assetHandle,
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        ...(reflected ? { reflected } : {}),
        pipelineClass: `${geometry.receipt.identity}|${geometry.deformation}`,
        materialResourceClass: resourceIdentity,
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
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0)
    throw new RangeError('GPU batch instanceCount must be a non-negative safe integer');
  return {
    instanceCount,
    draws: draws.map((draw) => ({
      sourceDrawIndex: draw.sourceDrawIndex,
      key: draw.key,
      batchText:
        draw.binding.source?.materialOverrides === undefined
          ? batchText(draw.key, draw.lod)
          : JSON.stringify([
              draw.binding.worldId,
              draw.binding.assetHandle,
              draw.binding.geometry.deformation,
              draw.key.materialResourceClass,
            ]),
      lod: draw.lod,
    })),
  };
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
  private sources = new BatchSources();
  private readonly changedBatches = new Set<MutableBatch>();
  private readonly membershipByPrimitive = new Map<number, MembershipProjection>();
  private readonly ineligiblePrimitives = new Set<number>();
  private unbatchedSnapshot: readonly number[] | undefined;
  private readonly generationByBatchId: number[] = [];
  private readonly freeBatchIds: number[] = [];
  private health: 'ready' | { readonly cause: unknown } = 'ready';
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
  private readonly meshBatches = new MeshBatchProjection();

  rebuild(slots: FrameList<RenderSceneSlot>): void {
    try {
      this.meshBatches.reset();
      this.batches.clear();
      this.sources = new BatchSources();
      this.changedBatches.clear();
      this.membershipByPrimitive.clear();
      this.ineligiblePrimitives.clear();
      this.unbatchedSnapshot = undefined;
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
      this.health = 'ready';
    } catch (cause) {
      this.fail(cause);
    }
  }

  apply(delta: RenderSceneApplyResult): boolean {
    if (this.health !== 'ready') throw this.health.cause;
    try {
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
        const { slot } = update;
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
        if (previous.instanceCount !== next.instanceCount) {
          for (const membership of previous.draws) {
            const batch = this.batches.get(membership.batchText);
            const entry = batch?.members.get(slot.slot);
            if (batch === undefined || entry === undefined)
              throw new Error('Missing retained batch membership');
            const member = Object.freeze({ ...entry.member, instanceCount: next.instanceCount });
            batch.members = batch.members.with(member);
            this.candidateRemoves += Math.max(0, previous.instanceCount - next.instanceCount);
            this.candidateAdds += Math.max(0, next.instanceCount - previous.instanceCount);
            batch.contentEpoch++;
            this.changedBatches.add(batch);
          }
          changed = true;
          topologyChanged = true;
        }
        this.membershipByPrimitive.set(slot.slot, next);
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
    } catch (cause) {
      this.fail(cause);
    }
  }

  /**
   * Publish the immutable plan. Clean batches keep their frozen object while
   * their aligned visible base is unchanged, so downstream per-batch memos
   * survive unrelated membership edits.
   */
  sourcePlan(): SubmissionPlan {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      if (this.cachedPlan === undefined) {
        this.planBuilds++;
        for (const batch of this.changedBatches) this.publish(batch);
        this.changedBatches.clear();
        this.cachedPlan = Object.freeze({
          revision: this.revision,
          batches: this.sources,
          candidateCount: this.sources.weight,
          visibleCapacity: 0,
          sourceGroups: this.sources,
        });
      }
      return this.cachedPlan;
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Actual execution owns draw expansion and physical output-window lifetime. */
  query(source: SubmissionPlan, meshes: MeshFrame | undefined): SubmissionPlan {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      return this.meshBatches.query(source, meshes);
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Maintained by geometry changes; material adoption never inspects primitives. */
  get completeGeometry(): boolean {
    return this.ineligiblePrimitives.size === 0;
  }

  /** Geometry-only roster. Its publication changes independently of GPU batch membership. */
  get unbatchedSlots(): readonly number[] {
    this.unbatchedSnapshot ??= Object.freeze([...this.ineligiblePrimitives]);
    return this.unbatchedSnapshot;
  }

  revisionValue(): number {
    return this.revision;
  }

  inspect(): BatchTopologyInspection {
    const plan = this.sourcePlan();
    const candidateCount = this.sources.weight;
    const resourceClasses = inspectResourceClassSplits(plan);
    return {
      revision: this.revision,
      batchCount: plan.batches.length,
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
      windowCompactions: this.meshBatches.windowCompactions,
      windowRelocations: this.meshBatches.windowRelocations,
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
      if (!this.ineligiblePrimitives.has(slot.slot)) this.unbatchedSnapshot = undefined;
      this.ineligiblePrimitives.add(slot.slot);
      return false;
    }
    if (this.ineligiblePrimitives.delete(slot.slot)) this.unbatchedSnapshot = undefined;
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
          members: new MemberCandidates(),
          binding: draw.binding,
          lod: draw.lod,
          contentEpoch: 0,
        };
        this.batches.set(text, batch);
      }
      const previousCount = batch.members.length;
      batch.contentEpoch += instanceCount - (previousCount === 0 ? 1 : 0);
      const member = Object.freeze({
        primitiveIndex: slot.slot,
        generation: slot.generation,
        entityKey: slot.snapshot.entityKey,
        drawItemIndex: draw.sourceDrawIndex,
        instanceCount,
      });
      // Recreate and compatibility moves admit from an empty page root.
      batch.members = batch.members.with(member);
      this.candidateAdds += instanceCount;
      this.changedBatches.add(batch);
    }
    this.membershipByPrimitive.set(slot.slot, memberships);
    return true;
  }

  private fail(cause: unknown): never {
    this.cachedPlan = undefined;
    this.health = { cause };
    throw cause;
  }

  private publish(batch: MutableBatch): void {
    const candidates = batch.members;
    if (this.sources.get(batch.batchId) !== undefined) {
      this.sources = this.sources.withMembers(batch.batchId, candidates, batch.contentEpoch);
      this.batchesRebuilt++;
      return;
    }
    const published: GpuDrivenBatch = Object.freeze({
      batchId: batch.batchId,
      generation: batch.generation,
      key: batch.key,
      binding: batch.binding,
      candidates,
      members: candidates.membersFrame(),
      visibleBase: 0,
      visibleCapacity: candidates.length,
      indirectOffset: 0,
      ...(batch.lod === undefined ? {} : { lod: batch.lod }),
      contentEpoch: batch.contentEpoch,
    });
    this.sources = this.sources.with(published);
    this.batchesRebuilt++;
  }

  private remove(primitiveIndex: number): boolean {
    if (this.ineligiblePrimitives.delete(primitiveIndex)) this.unbatchedSnapshot = undefined;
    const memberships = this.membershipByPrimitive.get(primitiveIndex);
    this.membershipByPrimitive.delete(primitiveIndex);
    if (memberships === undefined) return false;
    for (const membership of memberships.draws) {
      const batch = this.batches.get(membership.batchText);
      if (batch === undefined) continue;
      batch.members = batch.members.without(primitiveIndex);
      batch.contentEpoch += memberships.instanceCount;
      this.candidateRemoves += memberships.instanceCount;
      if (batch.members.memberCount === 0) {
        this.batches.delete(membership.batchText);
        this.sources = this.sources.without(batch.batchId);
        this.changedBatches.delete(batch);
        this.freeBatchIds.push(batch.batchId);
      } else this.changedBatches.add(batch);
    }

    return true;
  }
}
