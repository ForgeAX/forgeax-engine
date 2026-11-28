import type { MeshLodLevel, PrimitiveTopology } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { BatchTopologyInspection } from '../inspection-types';
import { isReflectedTransform } from '../material-render-state';
import type { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { TreeFrame } from '../scene/frame-tree-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import { drawPoseReflected, drawPoseStorage, SceneDrawSlot, slotContent } from '../scene/mesh-draw';
import type { MeshFrame } from '../scene/mesh-frame';
import { hasRasterDemand } from '../scene/raster-demand';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';
import type { RowContent } from '../scene/row-contents';
import { sphereProjectedHeight } from '../scene/visibility/lod-selector';
import { type BatchGeometry, captureBatchGeometry } from './batch-execution';
import { batchVisibleSpan } from './batch-layout';
import { BatchSources, MemberCandidates } from './batch-members';
import {
  BatchResidency,
  type RenderResidencyGroup,
  type RenderResidencySelection,
} from './batch-residency';
import { inheritTaskHeaders } from './fixed-task-plan';
import { MeshBatchProjection, type MeshExecutionPlans } from './mesh-batches';
import type { PreparedGpuDrivenDraw } from './prepared-draw';
import {
  type RowGroup,
  type RowMaterialGroup,
  RowMaterialMembers,
  rowMaterialResource,
  rowMaterialSlot,
} from './row-materials';

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
  readonly assetHandle: number;
  readonly lods?: readonly MeshLodLevel['mesh'][];
  readonly material: MaterialResource;
  readonly geometry: BatchGeometry;
  readonly drawItemIndex: number;
  /** Members deform by their GPU Scene morph row in the vertex stage and draw LOD0. */
  readonly morph?: true;
  /** Group of a row-material binding; it owns the rows of every material it holds. */
  readonly rowGroup?: RowMaterialGroup;
}

export interface GpuDrivenBatchKey {
  readonly drawItemIndex?: number;
  readonly assetHandle: number;
  /** Source-local residency partition; distinct groups never share a candidate domain. */
  readonly residencyGroup?: number;
  readonly drawKind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  /** Model parity splits raster work without changing authored material state. */
  readonly reflected?: boolean;
  /** Morphed members share the Mesh stream; only their LOD0 policy differs. */
  readonly morph?: true;
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
  /** Members read their material through their own GPU Scene row, not the batch binding. */
  readonly rowMaterial?: true;
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
  /** Source-only execution selection over this exact resident source baseline. */
  readonly resident?: SubmissionPlan;
}

/** Fixed definition whose membership currency is proved by its issuing topology. */
export interface ResidentGroupPlan {
  readonly plan: SubmissionPlan;
  matches(current: SubmissionPlan): boolean;
}

const residentGroupPlans = new WeakMap<ResidentGroupPlan, RenderResidencyGroup>();

export function matchesResidentGroupPlan(
  captured: ResidentGroupPlan,
  plan: SubmissionPlan,
  current: SubmissionPlan,
): boolean {
  return residentGroupPlans.has(captured) && captured.plan === plan && captured.matches(current);
}

/** Constrain an already-resolved native contribution to the issuing group's partition. */
export function matchesResidentGroupBatch(
  captured: ResidentGroupPlan,
  plan: SubmissionPlan,
  batch: GpuDrivenBatch,
): boolean {
  const group = residentGroupPlans.get(captured);
  return group !== undefined && captured.plan === plan && batch.key.residencyGroup === group.id;
}

/** Actual view work, including source-only selector plans before receipt preparation. */
export function planDrawsSkin(plan: SubmissionPlan): boolean {
  return plan.batches.some(
    (batch) =>
      batch.candidates.length > 0 &&
      (batch.prepared?.identity.deformation ?? batch.binding?.geometry.deformation) === 'skin',
  );
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

export function buildSubmissionCandidateMembership(
  source: SubmissionPlan,
): SubmissionCandidateMembership {
  const mutable = new Map<number, SubmissionCandidateMembershipEntry[]>();
  for (const batch of source.batches) {
    for (const candidate of batch.candidates) {
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
  binding: GpuDrivenBatchBinding;
  /** A row-material batch moved its binding to another held material. */
  bindingChanged: boolean;
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

interface MembershipCandidate extends EligibleGpuDrivenDraw {
  readonly memberGroup?: RowGroup;
}

interface MembershipDraw {
  readonly sourceDrawIndex: number;
  readonly batchText: string;
}

interface MembershipProjection {
  readonly instanceCount: number;
  readonly draws: readonly MembershipDraw[];
}

/**
 * Slot-indexed batch membership. Equal projections are one shared interned
 * value, so rows of one template hold a reference rather than their own
 * descriptor, key and batch text.
 */
class MembershipColumn {
  private readonly bySlot: (MembershipProjection | undefined)[] = [];
  private readonly interned = new Map<
    string,
    { readonly projection: MembershipProjection; holders: number }
  >();
  private readonly keys = new WeakMap<MembershipProjection, string>();
  /** Bulk admission sets many rows from one shared projection; reuse its key. */
  private recent:
    | {
        readonly input: MembershipProjection;
        readonly key: string;
        readonly shared: { readonly projection: MembershipProjection; holders: number };
      }
    | undefined;

  get(slot: number): MembershipProjection | undefined {
    return this.bySlot[slot];
  }

  set(slot: number, projection: MembershipProjection): void {
    const recent = this.recent;
    let shared =
      recent !== undefined &&
      recent.input === projection &&
      this.interned.get(recent.key) === recent.shared
        ? recent.shared
        : undefined;
    if (shared !== undefined) {
      shared.holders++;
      this.delete(slot);
      this.bySlot[slot] = shared.projection;
      return;
    }
    let key = '';
    for (const draw of projection.draws)
      key += `${draw.sourceDrawIndex}\u0000${draw.batchText}\u0001`;
    key += projection.instanceCount;
    shared = this.interned.get(key);
    if (shared === undefined) {
      const frozen = Object.freeze({
        instanceCount: projection.instanceCount,
        draws: Object.freeze(projection.draws.map((draw) => Object.freeze({ ...draw }))),
      });
      shared = { projection: frozen, holders: 0 };
      this.interned.set(key, shared);
      this.keys.set(frozen, key);
    }
    shared.holders++;
    this.recent = { input: projection, key, shared };
    this.delete(slot);
    this.bySlot[slot] = shared.projection;
  }

  delete(slot: number): void {
    const previous = this.bySlot[slot];
    if (previous === undefined) return;
    this.bySlot[slot] = undefined;
    const key = this.keys.get(previous);
    const shared = key === undefined ? undefined : this.interned.get(key);
    if (shared !== undefined && --shared.holders === 0 && key !== undefined)
      this.interned.delete(key);
  }

  clear(): void {
    this.recent = undefined;
    this.bySlot.length = 0;
    this.interned.clear();
  }
}

/**
 * Rows of one interned content share every field reference this projection
 * reads, so consecutive admissions of one template reuse the previous row's
 * frozen draws instead of rebuilding keys and binding records per row.
 */
let recentEligible:
  | {
      readonly content: RowContent;
      readonly reflected: boolean;
      readonly rowGroup: RowGroup | undefined;
      readonly draws: readonly MembershipCandidate[];
    }
  | undefined;
let recentMembership:
  | { readonly draws: readonly EligibleGpuDrivenDraw[]; readonly projection: MembershipProjection }
  | undefined;

function sameEligibleInputs(a: RowContent, b: RowContent): boolean {
  return (
    a.assetHandle === b.assetHandle &&
    a.gpuDrivenDraws === b.gpuDrivenDraws &&
    a.material === b.material &&
    a.materials === b.materials &&
    a.materialOverrides === b.materialOverrides &&
    a.materialBindingSources === b.materialBindingSources &&
    a.lods === b.lods &&
    a.lodHysteresis === b.lodHysteresis &&
    a.authorVisible === b.authorVisible &&
    a.residencyGroup === b.residencyGroup &&
    a.skinBinding === b.skinBinding &&
    (a.localAabb === undefined) === (b.localAabb === undefined) &&
    a.morph === undefined &&
    b.morph === undefined &&
    a.instances === undefined &&
    b.instances === undefined &&
    a.spriteInstances === undefined &&
    b.spriteInstances === undefined
  );
}

const noMembershipCandidates: readonly MembershipCandidate[] = Object.freeze([]);

function eligibleDraws(
  slot: RenderSceneSlot,
  rows: Pick<RowMaterialMembers<object, unknown>, 'group'>,
): readonly MembershipCandidate[] {
  const content = slotContent(slot);
  // Hidden and unpublished geometry has no raster membership to classify.
  if (!hasRasterDemand(content) || !content.gpuDrivenDraws?.length) return noMembershipCandidates;
  const reflected =
    slot instanceof SceneDrawSlot
      ? isReflectedTransform(slot.poseColumn, slot.poseOffset)
      : CapturedSceneTransform.reflected(slot.snapshot.transform);
  const rowGroup = rows.group(content);
  const recent = recentEligible;
  if (
    recent !== undefined &&
    recent.reflected === reflected &&
    recent.rowGroup === rowGroup &&
    sameEligibleInputs(recent.content, content)
  )
    return recent.draws;
  const draws = eligibleDrawsUncached(content, reflected, rowGroup);
  recentEligible = { content, reflected, rowGroup, draws };
  return draws;
}

function eligibleDrawsUncached(
  snapshot: RowContent,
  reflected: boolean,
  rowGroup: RowGroup | undefined,
): readonly MembershipCandidate[] {
  const rowClass = rowGroup?.text;
  const draws = rowMaterialDraws(projectGpuDrivenDraws(snapshot, reflected), snapshot, rowGroup);
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
      ...(rowGroup === undefined ? {} : { memberGroup: rowGroup }),
      sourceDrawIndex: 0,
      binding: Object.freeze({ ...first.binding, source }),
      key: {
        ...first.key,
        drawItemIndex: 0,
        ...(snapshot.residencyGroup === undefined
          ? {}
          : { residencyGroup: snapshot.residencyGroup.id }),
        ...(rowClass === undefined ? {} : { rowMaterial: true as const }),
        materialResourceClass:
          rowClass ??
          JSON.stringify([
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

/**
 * Executions of a row-material row that read each member's own material slot:
 * every slot of an explicit table, or slot 0 of a one-entry override (other
 * slots are the shared Mesh defaults).
 */
function rowMaterialDraws(
  draws: readonly EligibleGpuDrivenDraw[],
  snapshot: RowContent,
  rowGroup: RowMaterialGroup | undefined,
): readonly EligibleGpuDrivenDraw[] {
  if (rowGroup === undefined) return draws;
  return draws.map((draw) =>
    rowMaterialSlot(snapshot, draw.key.materialSlot)
      ? {
          ...draw,
          binding: { ...draw.binding, rowGroup },
          key: { ...draw.key, rowMaterial: true as const, materialResourceClass: rowGroup.text },
        }
      : draw,
  );
}

export function gpuDrivenGeometryEligible(snapshot: RowContent): boolean {
  if (
    snapshot.instances?.instanceCount === 0 ||
    (snapshot.localAabb === undefined && snapshot.skinBinding === undefined) ||
    snapshot.spriteInstances !== undefined
  )
    return false;
  return true;
}

/** Binding admission reads geometry and instance facts, never material content. */
export function eligibleGpuDrivenDraws(
  snapshot: RenderableSnapshot,
): readonly EligibleGpuDrivenDraw[] {
  return projectGpuDrivenDraws(snapshot, snapshot);
}

function projectGpuDrivenDraws(
  snapshot: RowContent,
  pose: boolean | Pick<RenderableSnapshot, 'transform'>,
): readonly EligibleGpuDrivenDraw[] {
  if (snapshot.assetHandle === undefined) return [];
  const draws = snapshot.gpuDrivenDraws;
  if (draws === undefined || draws.length === 0 || !gpuDrivenGeometryEligible(snapshot)) return [];
  const reflected = typeof pose === 'boolean' ? pose : drawPoseReflected(pose);
  // Morphed rows deform LOD0 vertices by their own GPU Scene weights.
  const morph = snapshot.morph !== undefined;
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
        assetHandle: snapshot.assetHandle,
        ...(snapshot.lods === undefined || morph
          ? {}
          : { lods: Object.freeze(snapshot.lods.map((lod) => lod.mesh)) }),
        material,
        geometry,
        drawItemIndex,
        ...(morph ? { morph } : {}),
      }),
      key: {
        drawItemIndex,
        assetHandle: snapshot.assetHandle,
        ...(snapshot.residencyGroup === undefined
          ? {}
          : { residencyGroup: snapshot.residencyGroup.id }),
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        ...(reflected ? { reflected } : {}),
        ...(morph ? { morph } : {}),
        pipelineClass: `${geometry.receipt.identity}|${geometry.deformation}`,
        materialResourceClass: resourceIdentity,
      },
      ...(morph ? {} : drawLod(draw, snapshot)),
    });
  }
  return result;
}

function drawLod(
  draw: NonNullable<RowContent['gpuDrivenDraws']>[number],
  snapshot: RowContent,
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
  draws: readonly EligibleGpuDrivenDraw[],
): MembershipProjection {
  const instanceCount = slotContent(slot).instances?.instanceCount ?? 1;
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0)
    throw new RangeError('GPU batch instanceCount must be a non-negative safe integer');
  const recent = recentMembership;
  if (
    recent !== undefined &&
    recent.draws === draws &&
    recent.projection.instanceCount === instanceCount
  )
    return recent.projection;
  const projection = membershipProjectionUncached(instanceCount, draws);
  recentMembership = { draws, projection };
  return projection;
}

function membershipProjectionUncached(
  instanceCount: number,
  draws: readonly EligibleGpuDrivenDraw[],
): MembershipProjection {
  return {
    instanceCount,
    draws: draws.map((draw) => ({
      sourceDrawIndex: draw.sourceDrawIndex,
      batchText:
        draw.binding.source?.materialOverrides === undefined
          ? batchText(draw.key, draw.lod)
          : JSON.stringify([
              draw.binding.assetHandle,
              draw.binding.geometry.deformation,
              draw.key.materialResourceClass,
              draw.key.morph === true,
              draw.key.residencyGroup,
            ]),
    })),
  };
}

type LodHeightSource = Pick<RenderableSnapshot, 'localAabb' | 'transform'>;

/** Conservative world-space bounding radius of a snapshot's local AABB; NaN without one. */
function worldBoundsRadius(aabb: Float32Array, world: Float32Array, offset: number): number {
  const halfX = Math.abs((aabb[3] ?? 0) - (aabb[0] ?? 0)) * 0.5;
  const halfY = Math.abs((aabb[4] ?? 0) - (aabb[1] ?? 0)) * 0.5;
  const halfZ = Math.abs((aabb[5] ?? 0) - (aabb[2] ?? 0)) * 0.5;
  const worldHalfX =
    Math.abs(world[offset + 0] ?? 0) * halfX +
    Math.abs(world[offset + 4] ?? 0) * halfY +
    Math.abs(world[offset + 8] ?? 0) * halfZ;
  const worldHalfY =
    Math.abs(world[offset + 1] ?? 0) * halfX +
    Math.abs(world[offset + 5] ?? 0) * halfY +
    Math.abs(world[offset + 9] ?? 0) * halfZ;
  const worldHalfZ =
    Math.abs(world[offset + 2] ?? 0) * halfX +
    Math.abs(world[offset + 6] ?? 0) * halfY +
    Math.abs(world[offset + 10] ?? 0) * halfZ;
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
  if (slot instanceof SceneDrawSlot) {
    const aabb = slot.content.localAabb;
    return aabb === undefined || aabb.length < 6
      ? Number.NaN
      : projectedHeightForBounds(aabb, slot.poseColumn, camera, slot.poseOffset);
  }
  return projectedHeightForSnapshot(slot.snapshot, camera);
}

/** Same projected height the GPU LOD projection measures, for one renderable snapshot. */
export function projectedHeightForSnapshot(
  snapshot: LodHeightSource,
  camera: LodHeightCamera,
): number {
  const aabb = snapshot.localAabb;
  if (aabb === undefined || aabb.length < 6) return Number.NaN;
  const pose = drawPoseStorage(snapshot);
  return projectedHeightForBounds(
    aabb,
    CapturedSceneTransform.column(pose),
    camera,
    CapturedSceneTransform.offset(pose),
  );
}

/** Bound and matrix are read independently, including a collection's current composed matrix. */
export function projectedHeightForBounds(
  aabb: Float32Array,
  world: Float32Array,
  camera: LodHeightCamera,
  offset = 0,
): number {
  const centerX = ((aabb[0] ?? 0) + (aabb[3] ?? 0)) * 0.5;
  const centerY = ((aabb[1] ?? 0) + (aabb[4] ?? 0)) * 0.5;
  const centerZ = ((aabb[2] ?? 0) + (aabb[5] ?? 0)) * 0.5;
  const dx =
    (world[offset + 0] ?? 0) * centerX +
    (world[offset + 4] ?? 0) * centerY +
    (world[offset + 8] ?? 0) * centerZ +
    (world[offset + 12] ?? 0) -
    (camera.position[0] ?? 0);
  const dy =
    (world[offset + 1] ?? 0) * centerX +
    (world[offset + 5] ?? 0) * centerY +
    (world[offset + 9] ?? 0) * centerZ +
    (world[offset + 13] ?? 0) -
    (camera.position[1] ?? 0);
  const dz =
    (world[offset + 2] ?? 0) * centerX +
    (world[offset + 6] ?? 0) * centerY +
    (world[offset + 10] ?? 0) * centerZ +
    (world[offset + 14] ?? 0) -
    (camera.position[2] ?? 0);
  return sphereProjectedHeight(
    worldBoundsRadius(aabb, world, offset),
    Math.hypot(dx, dy, dz),
    camera.projection,
    camera.fov,
    Math.abs(camera.orthoTop - camera.orthoBottom),
  );
}

/** Stable compatibility grouping; per-view visibility never mutates this owner. */
export class BatchTopology {
  private readonly batches = new Map<string, MutableBatch>();
  private sources = new BatchSources();
  // Both roots borrow the same published batches. A gate edit touches only its indexed batches.
  private activeSources = this.sources;
  private readonly sourceBatchesByGroup = new Map<number, Set<number>>();
  private readonly changedBatches = new Set<MutableBatch>();
  private readonly membershipByPrimitive = new MembershipColumn();
  /** Geometry rows without native batch membership; a fixed set diffs against earlier frames. */
  private unbatched = new FrameSet();
  private readonly rowMaterials = new RowMaterialMembers<MutableBatch, GpuDrivenBatchBinding>();
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
  private executionPlan: SubmissionPlan | undefined;
  private readonly residency = new BatchResidency(() => this.health === 'ready');
  private readonly meshBatches = new MeshBatchProjection();

  rebuild(slots: FrameList<RenderSceneSlot>): void {
    try {
      this.meshBatches.reset();
      this.executionPlan = undefined;
      this.residency.reset();
      this.batches.clear();
      this.sources = new BatchSources();
      this.activeSources = this.sources;
      this.sourceBatchesByGroup.clear();
      this.changedBatches.clear();
      this.membershipByPrimitive.clear();
      this.unbatched = new FrameSet();
      this.rowMaterials.clear();
      // Every id becomes free with its generation retained, so a rebuilt batch
      // never repeats a published `(batchId, generation)` with other contents.
      this.freeBatchIds.length = 0;
      for (let batchId = this.generationByBatchId.length - 1; batchId >= 0; batchId -= 1) {
        this.freeBatchIds.push(batchId);
      }
      const pendingMembers = new Map<MutableBatch, GpuDrivenBatchMember | GpuDrivenBatchMember[]>();
      for (const slot of slots) this.add(slot, undefined, undefined, pendingMembers);
      for (const [batch, members] of pendingMembers)
        batch.members = Array.isArray(members)
          ? MemberCandidates.fromMembers(members)
          : batch.members.with(members);
      this.revision += 1;
      this.rebuilds += 1;
      this.cachedPlan = undefined;
      this.executionPlan = undefined;
      this.health = 'ready';
    } catch (cause) {
      this.fail(cause);
    }
  }

  apply(delta: RenderSceneApplyResult): boolean {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      let changed = false;
      this.residency.beginDelta(delta);
      for (const removed of delta.removedSlots) {
        if (this.remove(removed.slot)) changed = true;
      }
      for (const slot of delta.recreatedSlots) {
        if (this.remove(slot.slot)) changed = true;
        if (this.add(slot)) changed = true;
      }
      // The scene commit issues one final row per slot. Full content already
      // includes instance cardinality; the instance-only lane is disjoint.
      for (const slot of delta.contentUpdatedSlots) {
        if (this.updateMembership(slot, true)) changed = true;
      }
      for (const slot of delta.instanceUpdatedSlots) {
        if (this.updateMembership(slot, false)) changed = true;
      }
      for (const slot of delta.createdSlots) {
        if (this.add(slot)) changed = true;
      }
      if (changed) {
        this.revision += 1;
        this.patches += 1;
        this.cachedPlan = undefined;
        this.executionPlan = undefined;
      }
      return changed;
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Re-project one slot's membership; a stable projection patches its members in place. */
  private updateMembership(slot: RenderSceneSlot, content: boolean): boolean {
    const eligible = eligibleDraws(slot, this.rowMaterials);
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
      return removedChanged || addedChanged;
    }
    if (content) this.contentPatches += 1;
    const retargeted = this.retargetRowMaterial(slot, next, eligible[0]);
    if (previous.instanceCount !== next.instanceCount) {
      for (const membership of previous.draws) {
        const batch = this.batches.get(membership.batchText);
        const member = batch?.members.get(slot.slot);
        if (batch === undefined || member === undefined)
          throw new Error('Missing retained batch membership');
        batch.members = batch.members.with({ ...member, instanceCount: next.instanceCount });
        this.candidateRemoves += Math.max(0, previous.instanceCount - next.instanceCount);
        this.candidateAdds += Math.max(0, next.instanceCount - previous.instanceCount);
        batch.contentEpoch++;
        this.changedBatches.add(batch);
      }
      this.membershipByPrimitive.set(slot.slot, next);
      return true;
    }
    this.membershipByPrimitive.set(slot.slot, next);
    return retargeted;
  }

  /**
   * A stable row-material row may still address another material of the same
   * class. Its per-material membership follows, and the batch binding moves
   * when its material lost the last member.
   */
  private retargetRowMaterial(
    slot: RenderSceneSlot,
    projection: MembershipProjection,
    draw: MembershipCandidate | undefined,
  ): boolean {
    const content = slotContent(slot);
    const material = rowMaterialResource(content);
    if (material === undefined || this.rowMaterials.materialOf(slot.slot) === material)
      return false;
    const batch =
      projection.draws[0] === undefined
        ? undefined
        : this.batches.get(projection.draws[0].batchText);
    if (draw?.memberGroup === undefined || batch === undefined || batch.key.rowMaterial !== true)
      return false;
    const binding = this.rowMaterials.retarget(
      batch,
      slot.slot,
      content,
      draw.binding,
      draw.memberGroup,
    );
    return binding !== undefined && this.rebind(batch, binding);
  }

  private rebind(batch: MutableBatch, binding: GpuDrivenBatchBinding): boolean {
    if (batch.members.memberCount === 0) return false;
    batch.binding = binding;
    batch.bindingChanged = true;
    batch.contentEpoch++;
    this.changedBatches.add(batch);
    return true;
  }

  /**
   * Adopt the accepted material frame. Only rows whose material changed batch
   * class move; numeric edits stay in the GPU Scene material row.
   */
  adoptMaterials(
    materials: MaterialFrame,
    slotAt: (slot: number) => RenderSceneSlot | undefined,
  ): boolean {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      let changed = false;
      for (const index of this.rowMaterials.adopt(materials)) {
        const slot = slotAt(index);
        if (slot !== undefined && this.updateMembership(slot, false)) changed = true;
      }
      if (changed) {
        this.revision += 1;
        this.patches += 1;
        this.cachedPlan = undefined;
        this.executionPlan = undefined;
      }
      return changed;
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Source-local owner capability; the initial execution intent is closed. */
  createResidencyGroup(): RenderResidencyGroup {
    if (this.health !== 'ready') throw this.health.cause;
    return this.residency.create();
  }

  /** The same gate observation drives material demand and batch selection. */
  captureResidencySelection(): RenderResidencySelection {
    if (this.health !== 'ready') throw this.health.cause;
    return this.residency.captureSelection();
  }

  /** Resident data qualification does not change when execution gates toggle. */
  captureResidentSelection(): RenderResidencySelection {
    if (this.health !== 'ready') throw this.health.cause;
    return this.residency.captureSelection('resident');
  }

  hasResidencyGroup(group: RenderResidencyGroup): boolean {
    return this.health === 'ready' && this.residency.owns(group);
  }

  /** Compare only this fixed group's source/physical facts; unrelated edits keep their owners. */
  captureResidencyGroupPlan(
    group: RenderResidencyGroup,
    plan: SubmissionPlan,
  ): ResidentGroupPlan | undefined {
    if (
      !this.hasResidencyGroup(group) ||
      !this.meshBatches.isResidentPlan(plan) ||
      plan.sourceGroups !== this.residentSourcePlan().batches ||
      !(plan.batches instanceof TreeFrame)
    )
      return undefined;
    const claimRevision = this.residency.claimRevision(group);
    let sources = plan.sourceGroups;
    let executions = plan.batches;
    if (sources === undefined) return undefined;
    const captured = Object.freeze({
      plan,
      matches: (current: SubmissionPlan) => {
        if (
          !this.hasResidencyGroup(group) ||
          this.residency.claimRevision(group) !== claimRevision ||
          !this.meshBatches.isResidentPlan(current) ||
          current.sourceGroups !== this.residentSourcePlan().batches ||
          current.sourceGroups === undefined ||
          !(current.batches instanceof TreeFrame)
        )
          return false;
        let changed = false;
        const inspect = (before: GpuDrivenBatch | undefined, after: GpuDrivenBatch | undefined) => {
          if (before?.key.residencyGroup === group.id || after?.key.residencyGroup === group.id)
            changed = true;
        };
        current.sourceGroups.changesSince(sources, inspect);
        current.batches.changesSince(executions, inspect);
        if (changed) return false;
        // Only an already-proved equivalent immutable root becomes the next diff baseline.
        sources = current.sourceGroups;
        executions = current.batches;
        return true;
      },
    });
    residentGroupPlans.set(captured, group);
    return captured;
  }

  /** Internal execution intent only; this is not a preparation/commit receipt. */
  setResidencyGroupActive(group: RenderResidencyGroup, active: boolean): void {
    if (this.health !== 'ready') throw this.health.cause;
    if (!this.residency.setActive(group, active)) return;
    this.activeSources = this.selectGroup(this.activeSources, group.id, active);
    this.executionPlan = undefined;
  }

  /** Forget only an empty group, after the same Scene delta retired every claim. */
  retireResidencyGroup(group: RenderResidencyGroup): void {
    this.residency.retire(group);
    this.executionPlan = undefined;
  }

  /** Resident source facts retain inactive candidates, without claiming GPU readiness. */
  residentSourcePlan(): SubmissionPlan {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      if (this.cachedPlan === undefined) {
        this.planBuilds++;
        if (this.sources.length === 0 && this.changedBatches.size > 0) {
          const { resident, active } = BatchSources.fromBatches(
            this.initialSourceBatches(),
            (batch) =>
              batch.key.residencyGroup === undefined ||
              this.residency.isActive(batch.key.residencyGroup),
          );
          this.sources = resident;
          this.activeSources = active;
        } else {
          for (const batch of this.changedBatches) this.publish(batch);
        }
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

  /** The execution source is derived from the same resident batches, never re-admitted. */
  sourcePlan(): SubmissionPlan {
    const resident = this.residentSourcePlan();
    if (this.activeSources.length === this.sources.length) {
      this.executionPlan = undefined;
      return resident;
    }
    this.executionPlan ??= this.selectSourcePlan(resident, this.activeSources);
    return this.executionPlan;
  }

  /** Prospective demand only: preserve active rows and add exactly one closed group. */
  preparationSourcePlan(group: RenderResidencyGroup): SubmissionPlan {
    if (!this.hasResidencyGroup(group))
      throw new Error('Preparation requires a live owned residency group');
    const resident = this.residentSourcePlan();
    if (this.residency.isActive(group.id)) return this.sourcePlan();
    return this.selectSourcePlan(resident, this.selectGroup(this.activeSources, group.id, true));
  }

  private selectGroup(selected: BatchSources, group: number, active: boolean): BatchSources {
    for (const batchId of this.sourceBatchesByGroup.get(group) ?? [])
      selected = active ? selected.withPublished(this.sources, batchId) : selected.without(batchId);
    return selected.length === this.sources.length ? this.sources : selected;
  }

  private selectSourcePlan(resident: SubmissionPlan, selected: BatchSources): SubmissionPlan {
    return selected !== this.sources
      ? Object.freeze({
          revision: resident.revision,
          batches: selected,
          sourceGroups: selected,
          candidateCount: selected.weight,
          visibleCapacity: 0,
          resident,
        })
      : resident;
  }

  /** Actual execution owns draw expansion and physical output-window lifetime. */
  query(
    source: SubmissionPlan,
    meshes: MeshFrame | undefined,
    materials?: MaterialFrame,
  ): MeshExecutionPlans {
    if (this.health !== 'ready') throw this.health.cause;
    try {
      return this.meshBatches.query(source, meshes, materials);
    } catch (cause) {
      this.fail(cause);
    }
  }

  /** Maintained by geometry changes; material adoption never inspects primitives. */
  get completeGeometry(): boolean {
    return this.unbatchedSlots.size === 0;
  }

  /** Geometry-only roster. Its publication changes independently of GPU batch membership. */
  get unbatchedSlots(): FrameSet {
    return this.residency.selectUnbatched(this.unbatched);
  }

  /** Background preparation reads the complete resident residual footprint. */
  get residentUnbatchedSlots(): FrameSet {
    return this.unbatched;
  }

  revisionValue(): number {
    return this.revision;
  }

  /** A same-handle mesh content patch keeps every draw fact; only content epochs change. */
  recordContentPatch(): void {
    this.contentPatches += 1;
  }

  inspect(): BatchTopologyInspection {
    const plan = this.residentSourcePlan();
    const candidateCount = this.sources.weight;
    const resourceClasses = inspectResourceClassSplits(plan);
    return {
      revision: this.revision,
      batchCount: plan.batches.length,
      candidateCount,
      rebuilds: this.rebuilds,
      patches: this.patches,
      ineligible: this.unbatched.size,
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
    draws?: readonly MembershipCandidate[],
    projection?: MembershipProjection,
    pendingMembers?: Map<MutableBatch, GpuDrivenBatchMember | GpuDrivenBatchMember[]>,
  ): boolean {
    this.residency.admit(slot);
    draws ??= eligibleDraws(slot, this.rowMaterials);
    const content = slotContent(slot);
    if (draws.length === 0) {
      this.unbatched = hasRasterDemand(content)
        ? this.unbatched.with(slot.slot)
        : this.unbatched.without(slot.slot);
      return false;
    }
    this.unbatched = this.unbatched.without(slot.slot);
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
          bindingChanged: false,
          lod: draw.lod,
          contentEpoch: 0,
        };
        this.batches.set(text, batch);
      }
      if (draw.memberGroup !== undefined)
        this.rowMaterials.add(batch, slot.slot, content, draw.binding, draw.memberGroup);
      const pending = pendingMembers?.get(batch);
      const firstMember = pending === undefined && batch.members.length === 0;
      batch.contentEpoch += instanceCount - (firstMember ? 1 : 0);
      const member = {
        primitiveIndex: slot.slot,
        generation: slot.generation,
        entityKey: slot.entityKey,
        drawItemIndex: draw.sourceDrawIndex,
        instanceCount,
      };
      if (pendingMembers === undefined) batch.members = batch.members.with(member);
      else if (pending === undefined) pendingMembers.set(batch, member);
      else if (Array.isArray(pending)) pending.push(member);
      else pendingMembers.set(batch, [pending, member]);
      this.candidateAdds += instanceCount;
      this.changedBatches.add(batch);
    }
    this.membershipByPrimitive.set(slot.slot, memberships);
    return true;
  }

  private fail(cause: unknown): never {
    this.cachedPlan = undefined;
    this.executionPlan = undefined;
    this.health = { cause };
    throw cause;
  }

  private sourceBatch(batch: MutableBatch): GpuDrivenBatch {
    const candidates = batch.members;
    return {
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
    };
  }

  private indexSourceBatch(batch: MutableBatch): void {
    const group = batch.key.residencyGroup;
    if (group === undefined) return;
    let ids = this.sourceBatchesByGroup.get(group);
    if (ids === undefined) {
      ids = new Set();
      this.sourceBatchesByGroup.set(group, ids);
    }
    ids.add(batch.batchId);
  }

  private *initialSourceBatches(): IterableIterator<GpuDrivenBatch> {
    for (const batch of this.changedBatches) {
      this.indexSourceBatch(batch);
      batch.bindingChanged = false;
      this.batchesRebuilt++;
      yield this.sourceBatch(batch);
    }
  }

  private publish(batch: MutableBatch): void {
    const candidates = batch.members;
    const previous = this.sources;
    const existing = previous.get(batch.batchId);
    const group = batch.key.residencyGroup;
    if (existing === undefined) this.indexSourceBatch(batch);
    this.sources =
      existing !== undefined && !batch.bindingChanged
        ? previous.withMembers(batch.batchId, candidates, batch.contentEpoch)
        : previous.with(this.sourceBatch(batch));
    batch.bindingChanged = false;
    if (group === undefined || this.residency.isActive(group))
      this.activeSources =
        this.activeSources === previous
          ? this.sources
          : this.activeSources.withPublished(this.sources, batch.batchId);
    this.batchesRebuilt++;
  }

  private remove(primitiveIndex: number): boolean {
    this.unbatched = this.unbatched.without(primitiveIndex);
    const memberships = this.membershipByPrimitive.get(primitiveIndex);
    this.membershipByPrimitive.delete(primitiveIndex);
    if (memberships === undefined) return false;
    for (const membership of memberships.draws) {
      const batch = this.batches.get(membership.batchText);
      if (batch === undefined) continue;
      batch.members = batch.members.without(primitiveIndex);
      const binding = this.rowMaterials.remove(batch, primitiveIndex);
      if (binding !== undefined) this.rebind(batch, binding);
      batch.contentEpoch += memberships.instanceCount;
      this.candidateRemoves += memberships.instanceCount;
      if (batch.members.memberCount === 0) {
        this.batches.delete(membership.batchText);
        this.removePublished(batch);
        this.changedBatches.delete(batch);
        this.freeBatchIds.push(batch.batchId);
      } else this.changedBatches.add(batch);
    }

    return true;
  }

  private removePublished(batch: MutableBatch): void {
    const previous = this.sources;
    if (previous.get(batch.batchId) === undefined) return;
    const group = batch.key.residencyGroup;
    if (group !== undefined) {
      const ids = this.sourceBatchesByGroup.get(group);
      ids?.delete(batch.batchId);
      if (ids?.size === 0) this.sourceBatchesByGroup.delete(group);
    }
    this.sources = previous.without(batch.batchId);
    if (this.activeSources === previous) this.activeSources = this.sources;
    else if (this.activeSources.get(batch.batchId) !== undefined)
      this.activeSources = this.activeSources.without(batch.batchId);
    if (this.activeSources.length === this.sources.length) this.activeSources = this.sources;
  }
}
