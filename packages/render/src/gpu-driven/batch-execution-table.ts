import type { GpuDrivenBatchBinding } from './batch-topology';
import type { BatchExecutions } from './material-artifacts';

const ROWS_PER_PAGE = 32;
type Binding = GpuDrivenBatchBinding;
type ExecutionVisitor = (
  execution: BatchExecutions,
  binding: Binding,
  table: ReadonlyMap<Binding, BatchExecutions>,
) => void;

/** Binding insertion order belongs to the roster. Execution versions share that
 * roster and the pages they did not edit, independently of in-flight readers. */
export class BatchExecutionTable implements ReadonlyMap<Binding, BatchExecutions> {
  private constructor(
    private readonly bindings: readonly Binding[],
    private readonly indices: Map<Binding, number>,
    private readonly pages: BatchExecutions[][],
  ) {}

  static collect<T>(
    batches: Iterable<T>,
    bindingOf: (batch: T) => Binding,
    resolve: (binding: Binding) => BatchExecutions,
  ): BatchExecutionTable {
    const bindings: Binding[] = [];
    const indices = new Map<Binding, number>();
    const pages: BatchExecutions[][] = [];
    for (const batch of batches) {
      const binding = bindingOf(batch);
      const execution = resolve(binding);
      let index = indices.get(binding);
      if (index === undefined) {
        index = indices.size;
        indices.set(binding, index);
        bindings.push(binding);
        if (index % ROWS_PER_PAGE === 0) pages.push([]);
      }
      (pages[Math.floor(index / ROWS_PER_PAGE)] as BatchExecutions[])[index % ROWS_PER_PAGE] =
        execution;
    }
    return new BatchExecutionTable(bindings, indices, pages);
  }

  reconcile(
    resolve: (prior: BatchExecutions, binding: Binding, index: number) => BatchExecutions,
    rows?: Uint32Array,
    count = rows?.length ?? this.size,
  ): BatchExecutionTable {
    let pages: BatchExecutions[][] | undefined;
    for (let i = 0; i < count; i++) {
      const index = rows === undefined ? i : (rows[i] as number);
      const pageIndex = Math.floor(index / ROWS_PER_PAGE);
      const offset = index % ROWS_PER_PAGE;
      const previous = this.pages[pageIndex] as BatchExecutions[];
      const prior = previous[offset] as BatchExecutions;
      const next = resolve(prior, this.bindings[index] as Binding, index);
      if (prior === next) continue;
      pages ??= this.pages.slice();
      let page = pages[pageIndex] as BatchExecutions[];
      if (page === previous) {
        page = previous.slice();
        pages[pageIndex] = page;
      }
      page[offset] = next;
    }
    return pages === undefined ? this : new BatchExecutionTable(this.bindings, this.indices, pages);
  }

  visitChanges(
    previous: ReadonlyMap<Binding, BatchExecutions>,
    visit: (binding: Binding, before: BatchExecutions, after: BatchExecutions) => void,
  ): boolean {
    if (!(previous instanceof BatchExecutionTable) || previous.bindings !== this.bindings)
      return false;
    for (let index = 0; index < this.pages.length; index++) {
      const page = this.pages[index] as BatchExecutions[];
      const before = previous.pages[index] as BatchExecutions[];
      if (page === before) continue;
      for (let offset = 0; offset < page.length; offset++) {
        const prior = before[offset] as BatchExecutions;
        const next = page[offset] as BatchExecutions;
        if (prior !== next)
          visit(this.bindings[index * ROWS_PER_PAGE + offset] as Binding, prior, next);
      }
    }
    return true;
  }

  private at(index: number): BatchExecutions {
    return (this.pages[Math.floor(index / ROWS_PER_PAGE)] as BatchExecutions[])[
      index % ROWS_PER_PAGE
    ] as BatchExecutions;
  }

  get size(): number {
    return this.bindings.length;
  }
  has(binding: Binding): boolean {
    return this.indices.has(binding);
  }
  get(binding: Binding): BatchExecutions | undefined {
    const index = this.indices.get(binding);
    return index === undefined ? undefined : this.at(index);
  }
  keys(): MapIterator<Binding> {
    return this.bindings.values();
  }
  *values(): MapIterator<BatchExecutions> {
    for (let index = 0; index < this.size; index++) yield this.at(index);
  }
  *entries(): MapIterator<[Binding, BatchExecutions]> {
    for (let index = 0; index < this.size; index++)
      yield [this.bindings[index] as Binding, this.at(index)];
  }
  [Symbol.iterator](): MapIterator<[Binding, BatchExecutions]> {
    return this.entries();
  }
  forEach(visit: ExecutionVisitor, thisArg?: unknown): void {
    for (let index = 0; index < this.size; index++)
      visit.call(thisArg, this.at(index), this.bindings[index] as Binding, this);
  }
}
