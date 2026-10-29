import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { FrameSet } from './frame-set';

/** Cumulative roster work; tests and benches read deltas. */
export interface ResidualRosterWork {
  /** Batches whose residual contribution was re-judged. */
  batches: number;
  /** Member slots added to or removed from the residual set. */
  members: number;
  /** Syncs without persistent evidence that re-judged every batch. */
  cold: number;
}

/**
 * The residual rows of one view: unbatched geometry and members of batches the
 * GPU selection does not execute. Each sync consumes the batch plan's
 * persistent diff, the unbatched set's diff and the selection's changed
 * bindings, so a frame without such changes costs nothing and the residual
 * set is a fixed, slot-ordered {@link FrameSet}.
 */
export class ResidualRoster {
  #sources: SubmissionPlan['batches'] | undefined;
  #unbatched: ReadonlySet<number> | undefined;
  #selection: GpuDrawSelection | undefined;
  /** Batches counted into the residual set, by batch id. */
  readonly #counted = new Map<number, GpuDrivenBatch>();
  /** Residual contributions per slot: one per counted batch member, one for unbatched. */
  readonly #references = new Map<number, number>();
  #slots = new FrameSet();
  readonly work: ResidualRosterWork = { batches: 0, members: 0, cold: 0 };

  get slots(): FrameSet {
    return this.#slots;
  }

  sync(
    plan: SubmissionPlan,
    unbatched: ReadonlySet<number>,
    selection: GpuDrawSelection,
  ): FrameSet {
    const sources = plan.sourceGroups ?? plan.batches;
    const previousSources = this.#sources;
    const previousSelection = this.#selection;
    const selectionChanged =
      previousSelection !== selection &&
      (previousSelection === undefined ||
        selection.changedBindingsSince(previousSelection).size > 0);
    const linked =
      previousSources !== undefined &&
      BatchSources.isFixed(previousSources) &&
      BatchSources.isFixed(sources);
    if (!linked || selectionChanged) {
      // Coverage of one binding can follow another binding's executions, so a
      // changed selection re-judges every batch; members move only on flips.
      if (!linked) this.work.cold += 1;
      const live = new Set<number>();
      for (const batch of sources) {
        live.add(batch.batchId);
        this.#judge(this.#counted.get(batch.batchId), batch, selection);
      }
      for (const [batchId, batch] of [...this.#counted])
        if (!live.has(batchId)) this.#judge(batch, undefined, selection);
    } else if (previousSources !== sources)
      (sources as BatchSources).changesSince(previousSources as BatchSources, (before, after) =>
        this.#judge(
          before === undefined ? undefined : this.#counted.get(before.batchId),
          after,
          selection,
        ),
      );
    this.#syncUnbatched(unbatched);
    this.#sources = sources;
    this.#selection = selection;
    return this.#slots;
  }

  /** Replace one batch's counted contribution with `after`'s, visiting only differing members. */
  #judge(
    before: GpuDrivenBatch | undefined,
    after: GpuDrivenBatch | undefined,
    selection: GpuDrawSelection,
  ): void {
    const counted =
      after !== undefined && after.binding !== undefined && !selection.coversBinding(after.binding)
        ? after
        : undefined;
    if (before === counted) return;
    this.work.batches += 1;
    if (before !== undefined) this.#counted.delete(before.batchId);
    if (counted !== undefined) this.#counted.set(counted.batchId, counted);
    const beforeMembers = before?.candidates;
    const afterMembers = counted?.candidates;
    if (MemberCandidates.is(beforeMembers) && MemberCandidates.is(afterMembers)) {
      afterMembers.changesSince(beforeMembers, (slot, left, right) => {
        if (left === undefined) this.#reference(slot, 1);
        else if (right === undefined) this.#reference(slot, -1);
      });
      return;
    }
    if (before !== undefined) for (const slot of memberSlots(before)) this.#reference(slot, -1);
    if (counted !== undefined) for (const slot of memberSlots(counted)) this.#reference(slot, 1);
  }

  #syncUnbatched(unbatched: ReadonlySet<number>): void {
    const previous = this.#unbatched;
    if (previous === unbatched) return;
    if (previous !== undefined && FrameSet.isFixed(previous) && FrameSet.isFixed(unbatched))
      unbatched.changesSince(previous, (slot) =>
        this.#reference(slot, unbatched.has(slot) ? 1 : -1),
      );
    else {
      for (const slot of previous ?? []) if (!unbatched.has(slot)) this.#reference(slot, -1);
      for (const slot of unbatched) if (previous?.has(slot) !== true) this.#reference(slot, 1);
    }
    this.#unbatched = unbatched;
  }

  #reference(slot: number, delta: 1 | -1): void {
    const count = (this.#references.get(slot) ?? 0) + delta;
    if (count < 0) throw new Error('Residual roster released an absent member');
    this.work.members += 1;
    if (count === 0) {
      this.#references.delete(slot);
      this.#slots = this.#slots.without(slot);
    } else {
      this.#references.set(slot, count);
      if (count === 1) this.#slots = this.#slots.with(slot);
    }
  }
}

/** One slot per member, whatever the batch's candidate representation. */
function* memberSlots(batch: GpuDrivenBatch): Generator<number> {
  let previous = -1;
  for (const candidate of batch.candidates) {
    if (candidate.primitiveIndex === previous) continue;
    previous = candidate.primitiveIndex;
    yield candidate.primitiveIndex;
  }
}
