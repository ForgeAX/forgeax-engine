import type { GpuDrivenBatchBinding } from './batch-topology';
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
