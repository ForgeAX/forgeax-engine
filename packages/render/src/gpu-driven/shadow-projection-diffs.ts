import type { GpuDrivenBatch, GpuDrivenBatchBinding, SubmissionPlan } from './batch-topology';
import type { BatchExecutions } from './material-artifacts';
import type { FilteredProductionPlan } from './production-raster-prepare';

type FilteredRow = FilteredProductionPlan['batches'][number];

/** Filtered rows by batch id; each immutable publication indexes itself at most once. */
const filteredRowsById = new WeakMap<FilteredProductionPlan, ReadonlyMap<number, FilteredRow>>();
export function filteredRows(filtered: FilteredProductionPlan): ReadonlyMap<number, FilteredRow> {
  let rows = filteredRowsById.get(filtered);
  if (rows === undefined) {
    rows = new Map(filtered.batches.map((entry) => [entry.batch.batchId, entry]));
    filteredRowsById.set(filtered, rows);
  }
  return rows;
}

/** Batch owners of one immutable plan, indexed at most once. */
const ownersByPlan = new WeakMap<SubmissionPlan, ReadonlySet<GpuDrivenBatch>>();
function planOwners(plan: SubmissionPlan): ReadonlySet<GpuDrivenBatch> {
  let owners = ownersByPlan.get(plan);
  if (owners === undefined) {
    owners = new Set(plan.batches);
    ownersByPlan.set(plan, owners);
  }
  return owners;
}

/**
 * Shadow projections are validated against one filtered publication and one
 * execution table. Views of one update share these diffs, so a topology edit
 * re-checks only rows whose prepared or execution owner actually changed.
 */
export class ShadowProjectionDiffs {
  private readonly rows = new Map<
    FilteredProductionPlan,
    { readonly changed: readonly FilteredRow[]; readonly removed: boolean }
  >();
  private readonly executions = new Map<object, ReadonlySet<GpuDrivenBatchBinding>>();
  constructor(
    private readonly filtered: FilteredProductionPlan,
    private readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
  ) {}

  rowsChangedSince(previous: FilteredProductionPlan) {
    let diff = this.rows.get(previous);
    if (diff === undefined) {
      const before = filteredRows(previous);
      const changed: FilteredRow[] = [];
      let retained = 0;
      for (const entry of this.filtered.batches) {
        const old = before.get(entry.batch.batchId);
        if (old !== undefined) retained++;
        if (old !== entry) changed.push(entry);
      }
      diff = { changed, removed: retained !== before.size };
      this.rows.set(previous, diff);
    }
    return diff;
  }

  /**
   * Whether a batch owner of the previous projection is unchanged: the same
   * object, with an unchanged filtered row and shadow execution.
   */
  retainedOwners(
    previousPlan: SubmissionPlan,
    previousFiltered: FilteredProductionPlan,
    previousExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions> | undefined,
  ): ((batch: GpuDrivenBatch) => boolean) | undefined {
    if (previousExecutions === undefined) return undefined;
    const owners = planOwners(previousPlan);
    const changedRows =
      previousFiltered === this.filtered
        ? undefined
        : new Set(this.rowsChangedSince(previousFiltered).changed.map((row) => row.batch.batchId));
    const changedBindings =
      previousExecutions === this.batchExecutions
        ? undefined
        : this.executionsChangedSince(previousExecutions);
    return (batch) =>
      owners.has(batch) &&
      changedRows?.has(batch.batchId) !== true &&
      (batch.binding === undefined || changedBindings?.has(batch.binding) !== true);
  }

  executionsChangedSince(
    previous: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
  ): ReadonlySet<GpuDrivenBatchBinding> {
    let changed = this.executions.get(previous);
    if (changed === undefined) {
      const bindings = new Set<GpuDrivenBatchBinding>();
      for (const [binding, execution] of previous)
        if (this.batchExecutions.get(binding)?.shadow !== execution.shadow) bindings.add(binding);
      changed = bindings;
      this.executions.set(previous, changed);
    }
    return changed;
  }
}
