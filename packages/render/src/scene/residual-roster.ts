import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import type {
  GpuDrivenBatch,
  GpuDrivenBatchBinding,
  SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { GpuDrawSelection, gpuDrawCoverageKey } from '../gpu-driven/draw-selection';
import { FrameSet } from './frame-set';

/** Cumulative roster work; tests and benches read deltas. */
export interface ResidualRosterWork {
  /** Batches whose residual contribution was re-judged. */
  batches: number;
  /** Source batches checked, including unchanged coverage answers. */
  batchVisits: number;
  /** Member slots added to or removed from the residual set. */
  members: number;
  /** Syncs without persistent evidence that re-judged every batch. */
  cold: number;
}

type CoverageBatches = Map<number, GpuDrivenBatch>;
type CoverageDraws = Map<number, CoverageBatches>;
type CoverageMeshes = Map<number, CoverageDraws>;
type CoverageWorlds = Map<number, CoverageMeshes>;

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
  /** Existing source-batch dependencies, indexed by the selection coverage route. */
  readonly #coverage = new Map<ReturnType<typeof gpuDrawCoverageKey>, CoverageWorlds>();
  readonly #affected = new Set<GpuDrivenBatch>();
  readonly #references = new Map<number, number>();
  #slots = new FrameSet();
  readonly work: ResidualRosterWork = { batches: 0, batchVisits: 0, members: 0, cold: 0 };

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
    const linked =
      previousSources !== undefined &&
      BatchSources.isFixed(previousSources) &&
      BatchSources.isFixed(sources);
    const fixedCoverage =
      GpuDrawSelection.isFixedCoverage(selection) &&
      previousSelection !== undefined &&
      GpuDrawSelection.isFixedCoverage(previousSelection);
    if (!linked || !fixedCoverage) {
      if (!linked) this.work.cold += 1;
      this.#coverage.clear();
      const live = new Set<number>();
      for (const batch of sources) {
        live.add(batch.batchId);
        this.#index(batch, true);
        this.#judge(this.#counted.get(batch.batchId), batch, selection);
      }
      for (const [batchId, batch] of this.#counted)
        if (!live.has(batchId)) this.#judge(batch, undefined, selection);
    } else {
      const affected = this.#affected;
      try {
        if (previousSources !== sources)
          (sources as BatchSources).changesSince(
            previousSources as BatchSources,
            (before, after) => {
              if (before !== undefined) this.#index(before, false);
              if (after !== undefined) this.#index(after, true);
              this.#judge(
                before === undefined ? undefined : this.#counted.get(before.batchId),
                after,
                selection,
              );
            },
          );
        if (previousSelection !== undefined && previousSelection !== selection) {
          // Coverage can follow a peer binding's execution. Visit that complete
          // route's fanout, never only the exact changed binding or every batch.
          for (const binding of selection.changedBindingsSince(previousSelection))
            for (const batch of this.#route(binding)?.values() ?? []) affected.add(batch);
          for (const batch of affected)
            this.#judge(this.#counted.get(batch.batchId), batch, selection);
        }
      } finally {
        affected.clear();
      }
    }
    this.#syncUnbatched(unbatched);
    this.#sources = sources;
    this.#selection = selection;
    return this.#slots;
  }

  #route(binding: GpuDrivenBatchBinding): CoverageBatches | undefined {
    return this.#coverage
      .get(gpuDrawCoverageKey(binding))
      ?.get(binding.worldId)
      ?.get(binding.assetHandle)
      ?.get(binding.drawItemIndex);
  }

  #index(batch: GpuDrivenBatch, add: boolean): void {
    const binding = batch.binding;
    if (binding === undefined) return;
    const key = gpuDrawCoverageKey(binding);
    let worlds = this.#coverage.get(key);
    if (!add) {
      const meshes = worlds?.get(binding.worldId);
      const draws = meshes?.get(binding.assetHandle);
      const batches = draws?.get(binding.drawItemIndex);
      batches?.delete(batch.batchId);
      if (batches?.size === 0) draws?.delete(binding.drawItemIndex);
      if (draws?.size === 0) meshes?.delete(binding.assetHandle);
      if (meshes?.size === 0) worlds?.delete(binding.worldId);
      if (worlds?.size === 0) this.#coverage.delete(key);
      return;
    }
    if (worlds === undefined) {
      worlds = new Map();
      this.#coverage.set(key, worlds);
    }
    let meshes = worlds.get(binding.worldId);
    if (meshes === undefined) {
      meshes = new Map();
      worlds.set(binding.worldId, meshes);
    }
    let draws = meshes.get(binding.assetHandle);
    if (draws === undefined) {
      draws = new Map();
      meshes.set(binding.assetHandle, draws);
    }
    let batches = draws.get(binding.drawItemIndex);
    if (batches === undefined) {
      batches = new Map();
      draws.set(binding.drawItemIndex, batches);
    }
    batches.set(batch.batchId, batch);
  }

  /** Replace one batch's counted contribution with `after`'s, visiting only differing members. */
  #judge(
    before: GpuDrivenBatch | undefined,
    after: GpuDrivenBatch | undefined,
    selection: GpuDrawSelection,
  ): void {
    this.work.batchVisits += 1;
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
