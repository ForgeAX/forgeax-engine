import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { batchVisibleSpan } from './batch-layout';
import { MemberCandidates } from './batch-members';
import {
  buildBatchAlignedSubmission,
  buildSubmissionCandidateMembership,
  type GpuDrivenBatch,
  type GpuDrivenCandidate,
  type SubmissionPlan,
} from './batch-topology';
import { ShadowSlotSelection } from './shadow-caster-classes';

/** A view's caster restriction: sorted raw slots or a fixed numeric root. */
export type ShadowCandidates = readonly number[] | FrameSet | ShadowSlotSelection;

/** Membership queries over the slots a plan draws. */
export interface ShadowDrawnSlots {
  has(slot: number): boolean;
}

/** Projections an absent batch's subset survives, so a restored Pass needs no member walk. */
const DORMANT_PROJECTIONS = 64;

function containsSorted(indices: readonly number[], slot: number): boolean {
  let start = 0;
  let end = indices.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    const value = indices[middle] as number;
    if (value === slot) return true;
    if (value < slot) start = middle + 1;
    else end = middle;
  }
  return false;
}

export function shadowCandidateAdmits(candidates: ShadowCandidates, slot: number): boolean {
  if (FrameSet.isFixed(candidates) || ShadowSlotSelection.isFixed(candidates))
    return candidates.has(slot);
  return containsSorted(candidates, slot);
}

export function sameShadowCandidates(
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

/** Raw projection: candidates grouped by sorted slot, each row owning frozen copies. */
export function projectShadowCandidates(
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

/** Slots whose admission may differ; undefined when the roots are not comparable. */
function selectionChanges(
  before: ShadowCandidates | undefined,
  after: ShadowCandidates | undefined,
): number[] | undefined {
  const changed: number[] = [];
  if (before === after) return changed;
  const visit = (slot: number) => changed.push(slot);
  if (FrameSet.isFixed(before) && FrameSet.isFixed(after)) after.changesSince(before, visit);
  else if (ShadowSlotSelection.isFixed(before) && ShadowSlotSelection.isFixed(after)) {
    if (!after.changesSince(before, visit)) return undefined;
  } else return undefined;
  return changed;
}

interface LayerRow {
  readonly source: GpuDrivenBatch;
  readonly selected: FrameList<GpuDrivenCandidate>;
  readonly batch: GpuDrivenBatch;
}

/** A subset whose batch left the source; it stays valid for the selection it was cut with. */
interface DormantRow extends LayerRow {
  readonly candidates: ShadowCandidates | undefined;
  readonly since: number;
}

/**
 * One caster selection of one fixed source: per-batch member subsets that
 * share the source entries. A successor patches only changed selection slots
 * and edited member paths; absent batches keep their subsets dormant.
 */
export interface ShadowLayerProjection {
  readonly source: SubmissionPlan;
  readonly candidates: ShadowCandidates | undefined;
  readonly rows: ReadonlyMap<number, LayerRow>;
  readonly dormant: ReadonlyMap<number, DormantRow>;
  readonly generation: number;
  readonly drawn: ShadowDrawnSlots;
  readonly batches: readonly GpuDrivenBatch[];
  readonly candidateCount: number;
  readonly visibleCapacity: number;
  /** The selection is unchanged and every current batch keeps a retained member root. */
  readonly membershipKnown: boolean;
  /** Raw candidate lists: rows re-filter whole edited batches. */
  readonly listed: boolean;
}

/** Shared execution fields an unchanged subset row keeps from its retained batch. */
function sameExecutionRow(retained: GpuDrivenBatch, current: GpuDrivenBatch): boolean {
  return (
    retained.generation === current.generation &&
    retained.binding === current.binding &&
    retained.materialAddress === current.materialAddress &&
    retained.geometryAddress === current.geometryAddress &&
    retained.logicalResources === current.logicalResources &&
    retained.visibleBase === current.visibleBase &&
    retained.visibleCapacity === current.visibleCapacity &&
    retained.visibleAllocationCapacity === current.visibleAllocationCapacity &&
    retained.indirectOffset === current.indirectOffset &&
    retained.contentEpoch === current.contentEpoch &&
    retained.key === current.key &&
    retained.prepared === current.prepared &&
    retained.lod === current.lod
  );
}

/** A member row draws a slot when it holds a weighted entry for it. */
function memberDrawn(batches: readonly GpuDrivenBatch[]): ShadowDrawnSlots {
  return {
    has: (slot) =>
      batches.some(
        (batch) => ((batch.candidates as MemberCandidates).get(slot)?.instanceCount ?? 0) > 0,
      ),
  };
}

export interface ShadowLayerWork {
  /** Slots judged against the selection, including whole-batch selections. */
  layerSlotVisits: number;
  /** Batches whose subset was cut from all members, without a comparable predecessor. */
  layerBatchSelections: number;
  /** Retained subsets patched because they hold a changed or edited slot. */
  layerBatchPatches: number;
}

/** Ascending slot changes, so each batch intersects them by its own member range. */
function sortedChanges(changed: readonly number[] | undefined): readonly number[] | undefined {
  if (changed === undefined || changed.length < 2) return changed;
  for (let index = 1; index < changed.length; index++)
    if ((changed[index - 1] as number) >= (changed[index] as number))
      return [...new Set(changed)].sort((a, b) => a - b);
  return changed;
}

/**
 * Project `source` through `candidates`, patching `previous` when its roots
 * are comparable. Without them a batch selects its members once.
 */
export function projectShadowLayer(
  previous: ShadowLayerProjection | undefined,
  source: SubmissionPlan,
  candidates: ShadowCandidates | undefined,
  work?: ShadowLayerWork,
): ShadowLayerProjection {
  const admitted =
    candidates === undefined
      ? () => true
      : (slot: number) => {
          if (work !== undefined) work.layerSlotVisits++;
          return shadowCandidateAdmits(candidates, slot);
        };
  const comparable = previous !== undefined && !previous.listed ? previous : undefined;
  const changed = sortedChanges(
    comparable === undefined ? undefined : selectionChanges(comparable.candidates, candidates),
  );
  const generation = (previous?.generation ?? 0) + 1;
  let membershipKnown = changed?.length === 0;
  const rows = new Map<number, LayerRow>();
  const batches: GpuDrivenBatch[] = [];
  let candidateCount = 0;
  let visibleCapacity = 0;
  let retainedRows = 0;
  const batchSlots: number[] = [];
  for (const batch of source.batches) {
    const members = batch.candidates;
    // Raw candidate lists cannot be patched by member path.
    if (!MemberCandidates.is(members)) return projectListedLayer(previous, source, candidates);
    let row: LayerRow | undefined =
      changed === undefined ? undefined : comparable?.rows.get(batch.batchId);
    const retainedRow = row;
    let slots = changed;
    if (row !== undefined) retainedRows++;
    else {
      const dormant = comparable?.dormant.get(batch.batchId);
      slots =
        dormant === undefined
          ? undefined
          : sortedChanges(selectionChanges(dormant.candidates, candidates));
      if (slots !== undefined) row = dormant;
      if (slots?.length !== 0) membershipKnown = false;
    }
    let selected: MemberCandidates;
    if (row === undefined || slots === undefined) {
      if (work !== undefined) work.layerBatchSelections++;
      selected = members.selectMembers(admitted);
    } else {
      // A retained subset only holds slots of its source members, and every
      // removed member is a member edit: other selection changes cannot touch it.
      batchSlots.length = 0;
      members.heldSlots(slots, batchSlots);
      if (row.source.candidates !== members) {
        membershipKnown = false;
        members.changesSince(row.source.candidates as MemberCandidates, (slot) =>
          batchSlots.push(slot),
        );
      }
      const retained = row.selected as MemberCandidates;
      if (batchSlots.length === 0) selected = retained;
      else {
        if (work !== undefined) work.layerBatchPatches++;
        selected = members.patchSelection(retained, batchSlots, admitted);
      }
    }
    const projected =
      row !== undefined &&
      row.selected === selected &&
      (row.source === batch || sameExecutionRow(row.batch, batch))
        ? row.batch
        : selected === members
          ? batch
          : Object.freeze({ ...batch, candidates: selected });
    rows.set(
      batch.batchId,
      retainedRow !== undefined &&
        retainedRow.source === batch &&
        retainedRow.selected === selected &&
        retainedRow.batch === projected
        ? retainedRow
        : { source: batch, selected, batch: projected },
    );
    if (selected.length === 0) continue;
    batches.push(projected);
    candidateCount += selected.length;
    visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
  }
  const dormant = new Map<number, DormantRow>();
  if (comparable !== undefined) {
    for (const [batchId, row] of comparable.dormant)
      if (!rows.has(batchId) && generation - row.since <= DORMANT_PROJECTIONS)
        dormant.set(batchId, row);
    if (retainedRows !== comparable.rows.size) {
      for (const [batchId, row] of comparable.rows)
        if (!rows.has(batchId))
          dormant.set(batchId, { ...row, candidates: comparable.candidates, since: generation });
    }
  }
  const frozen = Object.freeze(batches);
  return Object.freeze({
    source,
    candidates,
    rows,
    dormant,
    generation,
    drawn: memberDrawn(frozen),
    batches: frozen,
    candidateCount,
    visibleCapacity,
    membershipKnown,
    listed: false,
  });
}

/** Ordered admitted candidates; undefined when the row is not sorted by slot. */
function admittedList(
  list: FrameList<GpuDrivenCandidate>,
  candidates: ShadowCandidates | undefined,
): FrameList<GpuDrivenCandidate> | undefined {
  if (candidates === undefined) return list;
  const selected: GpuDrivenCandidate[] = [];
  let previous = -1;
  for (const candidate of list) {
    if (candidate.primitiveIndex < previous) return undefined;
    previous = candidate.primitiveIndex;
    if (shadowCandidateAdmits(candidates, candidate.primitiveIndex)) selected.push(candidate);
  }
  return selected.length === list.length ? list : Object.freeze(selected);
}

function drawnList(batches: readonly GpuDrivenBatch[]): ShadowDrawnSlots {
  const drawn = new Set<number>();
  for (const batch of batches)
    for (const candidate of batch.candidates) drawn.add(candidate.primitiveIndex);
  return drawn;
}

/**
 * Raw candidate lists keep a row while its list and the selection stay the
 * same; a row out of slot order regroups the whole source.
 */
function projectListedLayer(
  previous: ShadowLayerProjection | undefined,
  source: SubmissionPlan,
  candidates: ShadowCandidates | undefined,
): ShadowLayerProjection {
  const sameSelection =
    previous?.listed === true && sameShadowCandidates(previous.candidates, candidates);
  let membershipKnown = sameSelection;
  const rows = new Map<number, LayerRow>();
  const batches: GpuDrivenBatch[] = [];
  let candidateCount = 0;
  let visibleCapacity = 0;
  for (const batch of source.batches) {
    const row = sameSelection ? previous?.rows.get(batch.batchId) : undefined;
    let selected = row?.source.candidates === batch.candidates ? row.selected : undefined;
    if (selected === undefined) {
      membershipKnown = false;
      selected = admittedList(batch.candidates, candidates);
      if (selected === undefined) {
        const regrouped = projectShadowCandidates(source, candidates);
        const regroupedBatches = Object.freeze([...regrouped.batches]);
        return Object.freeze({
          source,
          candidates,
          rows: new Map(),
          dormant: new Map(),
          generation: (previous?.generation ?? 0) + 1,
          drawn: drawnList(regroupedBatches),
          batches: regroupedBatches,
          candidateCount: regrouped.candidateCount,
          visibleCapacity: regrouped.visibleCapacity,
          membershipKnown: false,
          listed: true,
        });
      }
    }
    const projected =
      row?.source === batch && row.selected === selected
        ? row.batch
        : selected === batch.candidates
          ? batch
          : Object.freeze({ ...batch, candidates: selected });
    rows.set(batch.batchId, { source: batch, selected, batch: projected });
    if (selected.length === 0) continue;
    batches.push(projected);
    candidateCount += selected.length;
    visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
  }
  return Object.freeze({
    source,
    candidates,
    rows,
    dormant: new Map(),
    generation: (previous?.generation ?? 0) + 1,
    drawn: drawnList(batches),
    batches: Object.freeze(batches),
    candidateCount,
    visibleCapacity,
    membershipKnown,
    listed: true,
  });
}
