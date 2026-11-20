import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { StableRangeAllocator } from '../stable-range-allocator';
import { capturedGpuDrivenBatchKey } from './batch-key';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import {
  type FilteredGeometry,
  type FilteredPartition,
  type FilteredRow,
  type FilteredRowStage,
  type FilteredWindow,
  filteredWindowConflicts,
  stageFilteredRow,
} from './filtered-contribution';
import { type FilteredTaskContext, FilteredTaskHeaders } from './filtered-task-headers';
import { hasCapturedTaskMembership } from './fixed-task-plan';
import {
  assembleFilteredGroups,
  type FilteredProductionPlan,
  isPreparedBatchRows,
  isPreparedProductionPlan,
  type PreparedBatch,
  type PreparedBatchRows,
  type PreparedProductionPlan,
} from './production-raster-prepare';

type ProfilePart = <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T;
interface RangeReceipt {
  readonly allocator: StableRangeAllocator;
  readonly count: number;
  start: number | undefined;
  state: 'allocating' | 'held' | 'releasing' | 'released';
}
interface RowTransaction {
  headers?: FilteredTaskHeaders;
  previousHeaders?: FilteredTaskHeaders;
  readonly epoch: number;
  readonly ranges: RangeReceipt[];
  readonly ids: number[];
  readonly retired: Set<FilteredWindow>;
  committed: boolean;
}
export interface FilteredResidentContribution {
  readonly taskContext?: FilteredTaskContext;
  readonly plan: SubmissionPlan;
  readonly index: number;
  /** Absence is a completed negative Pass contribution, not a missing preparation. */
  readonly row: PreparedBatchRows | undefined;
  readonly isCurrent: () => boolean;
}

/** One filtered resident projection and its whole-contribution execution selection. */
export interface FilteredExecutionPlans {
  readonly resident: FilteredProductionPlan;
  readonly active: FilteredProductionPlan;
}

/** Object binding partitions survive every material and residency edit. */
export class FilteredPlanContributionOwner {
  private readonly geometry = new Map<number, FilteredGeometry>();
  private readonly windows = new Map<string, FilteredWindow>();
  private readonly prepared = new Map<string, FilteredPartition>();
  private readonly rows = new Map<number, FilteredRow>();
  private active:
    | { readonly sourceIds: ReadonlySet<number>; readonly plan: SubmissionPlan }
    | undefined;
  private epoch = 0;
  private busy = false;
  /** Unknown allocator effects require explicit owner reset, never a guessed rollback. */
  private failure:
    | {
        readonly causes: unknown[];
        readonly transactions: Set<RowTransaction>;
        readonly headers: Set<FilteredTaskHeaders>;
      }
    | undefined;
  private pass = 0;
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private nextId = 0;
  private readonly freeIds: number[] = [];
  private generation = 0;
  private publication: FilteredExecutionPlans | undefined;
  readonly windowCounters = { relocations: 0, compactions: 0 };
  readonly assemblyCounters = {
    publicationHits: 0,
    batchHits: 0,
    batchBuilds: 0,
    churnFallbacks: 0,
  };
  lastWork = { projectedBatches: 0, projectedCandidates: 0, copiedCandidates: 0, reusedGroups: 0 };

  clear(): void {
    const wasBusy = this.busy;
    this.busy = true;
    try {
      const headers = new Set<FilteredTaskHeaders>(this.failure?.headers);
      for (const row of this.rows.values()) if (row.headers !== undefined) headers.add(row.headers);
      for (const transaction of this.failure?.transactions ?? []) {
        if (transaction.headers !== undefined) headers.add(transaction.headers);
        if (transaction.previousHeaders !== undefined) headers.add(transaction.previousHeaders);
      }
      this.epoch++;
      // Numeric allocator reconstruction cannot confirm unknown physical effects.
      if (this.failure?.headers.size === 0) this.failure = undefined;
      this.active = undefined;
      this.geometry.clear();
      this.windows.clear();
      this.prepared.clear();
      this.rows.clear();
      this.visibleRanges.reset();
      this.indirectRanges.reset();
      this.nextId = 0;
      this.freeIds.length = 0;
      this.publication = undefined;
      for (const held of headers)
        try {
          this.retireHeaders(held);
        } catch {
          /* The physical journal retains every cause. */
        }
      if (this.failure !== undefined)
        throw new AggregateError(
          this.failure.causes,
          'Filtered physical retirement remains unconfirmed',
        );
    } finally {
      this.busy = wasBusy;
    }
  }

  update(
    prepared: PreparedProductionPlan,
    bindings?: ReadonlyMap<string, string>,
    profile?: ProfilePart,
    taskContext?: FilteredTaskContext,
  ): FilteredExecutionPlans {
    if (this.busy || this.failure !== undefined) throw unavailable();
    if (!isPreparedProductionPlan(prepared))
      throw new Error('Filtered projection requires an owned assemblePreparedPlan result');
    const epoch = this.epoch;
    this.busy = true;
    this.lastWork = {
      projectedBatches: 0,
      projectedCandidates: 0,
      copiedCandidates: 0,
      reusedGroups: 0,
    };
    const build = () => {
      const objectBindings = bindings?.size === 0 ? undefined : bindings;
      const pass = ++this.pass;
      // Window keys are owned by one source batch; only rows that dropped or
      // retired a key can release a window. Duplicate rows fall back to a scan.
      const releasedWindows: string[] = [];
      let scanWindows = false;
      const batches: PreparedBatch[] = [];
      const topology: GpuDrivenBatch[] = [];
      let fixedCandidates = true;
      let seenRows = 0;
      for (const row of this.residentRows(prepared, objectBindings)) {
        this.assertEpoch(epoch);
        const source = row.source;
        const retainedRow = this.rows.get(source.batchId);
        if (
          retainedRow !== undefined &&
          this.canReuseRow(retainedRow, row, objectBindings, pass, taskContext)
        ) {
          retainedRow.seen = pass;
          seenRows++;
          for (const batch of retainedRow.topology) {
            topology.push(batch);
            fixedCandidates &&= MemberCandidates.is(batch.candidates);
          }
          for (const batch of retainedRow.batches) batches.push(batch);
          this.assemblyCounters.batchHits += retainedRow.topology.length;
          this.lastWork.reusedGroups += retainedRow.topology.length;
          continue;
        }
        const projected = this.reconcileRow(
          row,
          objectBindings,
          pass,
          () => true,
          false,
          taskContext,
          prepared.residentSource,
        );
        for (const batch of projected.topology) {
          topology.push(batch);
          fixedCandidates &&= MemberCandidates.is(batch.candidates);
        }
        for (const batch of projected.batches) batches.push(batch);
        if (retainedRow !== undefined && retainedRow.seen !== pass) {
          // A replaced row may retire partition windows its last projection owned.
          for (const key of retainedRow.windowKeys)
            if (!projected.windowKeys.includes(key)) releasedWindows.push(key);
        } else if (retainedRow !== undefined) scanWindows = true;
        if (retainedRow?.seen !== pass) seenRows++;
      }
      // Retired rows release their geometry, windows and assembled batches.
      // Every retained row was seen when the counts agree.
      if (this.rows.size !== seenRows)
        for (const [id, retained] of this.rows) {
          if (retained.seen === pass) continue;
          this.rows.delete(id);
          this.geometry.delete(id);
          this.retireHeaders(retained.headers);
          for (const key of retained.windowKeys) releasedWindows.push(key);
        }
      if (scanWindows) {
        const liveWindows = new Set<string>();
        for (const retained of this.rows.values())
          for (const key of retained.windowKeys) liveWindows.add(key);
        for (const key of [...this.windows.keys()])
          if (!liveWindows.has(key)) this.releaseWindow(key);
      } else for (const key of releasedWindows) this.releaseWindow(key);
      this.assertEpoch(epoch);
      const previous = this.publication;
      const resident = this.publish(
        prepared.residentSource,
        batches,
        topology,
        fixedCandidates,
        previous?.resident,
      );
      const active = this.selectActive(prepared, resident, fixedCandidates, previous?.active);
      this.assertEpoch(epoch);
      this.active = {
        sourceIds: new Set(prepared.batchRows.map((row) => row.source.batchId)),
        plan: active.plan,
      };
      if (previous?.resident === resident && previous.active === active) return previous;
      this.publication = Object.freeze({ resident, active });
      return this.publication;
    };
    try {
      const result = profile === undefined ? build() : profile('batches', build);
      this.assertEpoch(epoch);
      return result;
    } catch (error) {
      try {
        this.clear();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Filtered update and cleanup failed');
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** One unbound inactive contribution; neither retirement of other rows nor publication. */
  prepareContribution(
    input: FilteredResidentContribution,
  ): Result<void, RhiError | GpuDrivenPreparationError> {
    if (this.busy || this.failure !== undefined) return err(unavailable());
    this.busy = true;
    const epoch = this.epoch;
    try {
      const { plan, index, row } = input;
      const guard = input.isCurrent.bind(input);
      const current = () => this.current(epoch, guard);
      if (!current()) return err(stale());
      if (!hasCapturedTaskMembership(plan) || !Number.isSafeInteger(index) || index < 0)
        return err(unavailable());
      const origin = plan.batches.at(index);
      if (!validContribution(plan, index, origin, row)) return err(unavailable());
      if (this.active?.sourceIds.has(origin.batchId)) return err(unavailable());
      if (!current()) return err(stale());
      if (row === undefined) {
        this.removeRow(origin.batchId);
      } else {
        const previous = this.rows.get(origin.batchId);
        const projected = this.reconcileRow(
          row,
          undefined,
          this.pass,
          current,
          true,
          input.taskContext,
          plan,
        );
        this.releaseWindows(
          (previous?.windowKeys ?? []).filter((key) => !projected.windowKeys.includes(key)),
        );
      }
      return current() ? ok(undefined) : err(stale());
    } catch (cause) {
      if (cause instanceof RhiError || cause instanceof GpuDrivenPreparationError)
        return err(cause);
      throw cause;
    } finally {
      this.busy = false;
    }
  }

  private current(epoch: number, guard: () => boolean): boolean {
    if (this.epoch !== epoch || this.failure !== undefined) return false;
    const accepted = guard() === true;
    return accepted && this.epoch === epoch && this.failure === undefined;
  }

  private reconcileRow(
    row: PreparedBatchRows,
    bindings: ReadonlyMap<string, string> | undefined,
    pass: number,
    guard: () => boolean,
    background = false,
    taskContext?: FilteredTaskContext,
    source?: SubmissionPlan,
  ): FilteredRow {
    const transaction: RowTransaction = {
      epoch: this.epoch,
      ranges: [],
      ids: [],
      retired: new Set(),
      committed: false,
    };
    const previousHeaders = this.rows.get(row.source.batchId)?.headers;
    if (previousHeaders !== undefined) transaction.previousHeaders = previousHeaders;
    try {
      const stage = stageFilteredRow(row, bindings, {
        geometry: this.geometry.get(row.source.batchId),
        partition: (key) => this.prepared.get(key),
        window: (key) => this.windows.get(key),
        allocate: (previous, capacity, levels) =>
          this.allocateWindow(
            transaction,
            row.source.generation,
            previous,
            capacity,
            levels,
            background,
          ),
      });
      if (background && this.active !== undefined)
        for (const partition of stage.partitions.values())
          if (filteredWindowConflicts(partition.window, this.active.plan)) throw unavailable();
      this.stageHeaders(stage, transaction, background, taskContext, source);
      if (!this.current(transaction.epoch, guard)) throw stale();
      transaction.committed = true;
      this.commitRow(stage, pass, transaction);
      this.assertEpoch(transaction.epoch);
      return stage.row;
    } catch (cause) {
      if (transaction.committed) this.poison(transaction, cause);
      else {
        let headerRetirement: unknown;
        try {
          this.retireHeaders(transaction.headers);
        } catch (failure) {
          headerRetirement = failure;
        }
        try {
          this.releaseRanges(transaction, transaction.ranges);
          if (this.epoch === transaction.epoch && this.failure === undefined)
            this.freeIds.push(...transaction.ids);
        } catch (retirement) {
          throw new AggregateError(
            [cause, retirement, ...(headerRetirement === undefined ? [] : [headerRetirement])],
            'Filtered row rollback failed',
          );
        }
        if (headerRetirement !== undefined)
          throw new AggregateError([cause, headerRetirement], 'Filtered header rollback failed');
      }
      throw cause;
    }
  }

  private assertEpoch(epoch: number): void {
    if (this.epoch !== epoch || this.failure !== undefined) throw stale();
  }

  private stageHeaders(
    stage: FilteredRowStage,
    transaction: RowTransaction,
    background: boolean,
    context: FilteredTaskContext | undefined,
    source: SubmissionPlan | undefined,
  ): void {
    const previous = transaction.previousHeaders;
    if (
      (!background && previous === undefined) ||
      (context === undefined && previous === undefined)
    )
      return;
    if (context === undefined || source === undefined) throw unavailable();
    if (previous?.matches(context, stage.row.topology)) {
      stage.row.headers = previous;
      return;
    }
    const headers = new FilteredTaskHeaders(context.scene, context.device, stage.row.topology);
    transaction.headers = headers;
    headers.prepare(source, stage.row.batches, previous);
    stage.row.headers = headers;
  }

  private canReuseRow(
    retained: FilteredRow | undefined,
    row: PreparedBatchRows,
    bindings: ReadonlyMap<string, string> | undefined,
    pass: number,
    context?: FilteredTaskContext,
  ): boolean {
    return (
      retained !== undefined &&
      retained.row === row &&
      retained.bindings === bindings &&
      retained.seen !== pass &&
      (retained.headers === undefined ||
        (context !== undefined && retained.headers.matches(context, retained.topology)))
    );
  }

  private retireHeaders(held: FilteredTaskHeaders | undefined): void {
    if (held === undefined) return;
    try {
      held.dispose();
    } catch (cause) {
      this.failure ??= { causes: [], transactions: new Set(), headers: new Set() };
      this.failure.causes.push(cause);
      this.failure.headers.add(held);
      throw cause;
    }
  }

  private allocateWindow(
    transaction: RowTransaction,
    sourceGeneration: number,
    previous: FilteredWindow | undefined,
    capacity: number,
    levels: number,
    background: boolean,
  ): FilteredWindow {
    if (transaction.epoch !== this.epoch) throw stale();
    if (previous !== undefined && !background) {
      // The admitted ordinary frame keeps its original range-reuse policy.
      const ranges = this.windowRanges(previous);
      transaction.ranges.push(...ranges);
      this.releaseRanges(transaction, ranges);
      transaction.retired.add(previous);
    }
    const reserved =
      previous !== undefined &&
      previous.sourceGeneration === sourceGeneration &&
      previous.levels === levels &&
      previous.levelCapacity < capacity
        ? Math.max(capacity, Math.ceil(previous.levelCapacity * 1.5))
        : capacity;
    const id = previous?.id ?? this.freeIds.pop() ?? this.nextId++;
    if (previous === undefined) transaction.ids.push(id);
    return {
      id,
      sourceGeneration,
      generation: ++this.generation,
      visibleStart: this.allocateRange(transaction, this.visibleRanges, reserved * levels),
      levelCapacity: reserved,
      indirectStart: this.allocateRange(transaction, this.indirectRanges, levels),
      levels,
    };
  }

  private allocateRange(
    transaction: RowTransaction,
    allocator: StableRangeAllocator,
    count: number,
  ): number {
    if (transaction.epoch !== this.epoch) throw stale();
    const receipt: RangeReceipt = { allocator, count, start: undefined, state: 'allocating' };
    transaction.ranges.push(receipt);
    try {
      receipt.start = allocator.allocate(count);
      receipt.state = 'held';
      return receipt.start;
    } catch (cause) {
      this.poison(transaction, cause);
      throw cause;
    }
  }

  private commitRow(stage: FilteredRowStage, pass: number, transaction: RowTransaction): void {
    const id = stage.row.row.source.batchId;
    const retired: FilteredWindow[] = [];
    this.geometry.set(id, stage.geometry);
    for (const [key, partition] of stage.partitions) {
      const window = this.windows.get(key);
      if (window !== undefined && window !== partition.window) {
        if (!transaction.retired.has(window)) retired.push(window);
        this.windowCounters.relocations++;
      }
      this.windows.set(key, partition.window);
      this.prepared.set(key, partition);
    }
    stage.row.seen = pass;
    this.rows.set(id, stage.row);
    this.assemblyCounters.batchBuilds += stage.built;
    this.assemblyCounters.batchHits += stage.reused;
    this.lastWork.projectedBatches += stage.built;
    this.lastWork.reusedGroups += stage.reused;
    this.lastWork.projectedCandidates += stage.projectedCandidates;
    const ranges = retired.flatMap((window) => this.windowRanges(window));
    transaction.ranges.push(...ranges);
    const failures: unknown[] = [];
    try {
      this.releaseRanges(transaction, ranges);
    } catch (cause) {
      failures.push(cause);
    }
    if (transaction.previousHeaders !== stage.row.headers)
      try {
        this.retireHeaders(transaction.previousHeaders);
      } catch (cause) {
        failures.push(cause);
      }
    if (failures.length > 0) throw new AggregateError(failures, 'Filtered row retirement failed');
  }

  private windowRanges(window: FilteredWindow): RangeReceipt[] {
    return [
      {
        allocator: this.visibleRanges,
        start: window.visibleStart,
        count: window.levelCapacity * window.levels,
        state: 'held',
      },
      {
        allocator: this.indirectRanges,
        start: window.indirectStart,
        count: window.levels,
        state: 'held',
      },
    ];
  }

  private releaseRanges(transaction: RowTransaction, ranges: readonly RangeReceipt[]): void {
    const failures: unknown[] = [];
    for (const range of ranges) {
      if (transaction.epoch !== this.epoch) return;
      if (range.state !== 'held' || range.start === undefined) continue;
      range.state = 'releasing';
      try {
        range.allocator.release(range.start, range.count);
        range.state = 'released';
      } catch (cause) {
        failures.push(cause);
        this.poison(transaction, cause);
      }
    }
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Filtered range retirement failed');
  }

  private releaseWindow(key: string): void {
    const window = this.windows.get(key);
    if (window === undefined) return;
    const transaction: RowTransaction = {
      epoch: this.epoch,
      ranges: this.windowRanges(window),
      ids: [],
      retired: new Set(),
      committed: true,
    };
    this.releaseRanges(transaction, transaction.ranges);
    if (transaction.epoch !== this.epoch) return;
    this.freeIds.push(window.id);
    this.windows.delete(key);
    this.prepared.delete(key);
  }

  private removeRow(id: number): void {
    const held = this.rows.get(id);
    if (held === undefined) return;
    const failures: unknown[] = [];
    try {
      this.releaseWindows(held.windowKeys);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.retireHeaders(held.headers);
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Filtered contribution retirement failed');
    this.rows.delete(id);
    this.geometry.delete(id);
  }

  private releaseWindows(keys: readonly string[]): void {
    const failures: unknown[] = [];
    for (const key of keys)
      try {
        this.releaseWindow(key);
      } catch (cause) {
        failures.push(cause);
      }
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Filtered window retirement failed');
  }

  private poison(transaction: RowTransaction, cause: unknown): void {
    if (transaction.epoch !== this.epoch) return;
    this.failure ??= { causes: [], transactions: new Set(), headers: new Set() };
    this.failure.causes.push(cause);
    this.failure.transactions.add(transaction);
  }

  /** Native omitted rows may survive; raw object binding maps carry no version proof. */
  private residentRows(
    prepared: PreparedProductionPlan,
    bindings: ReadonlyMap<string, string> | undefined,
  ): readonly PreparedBatchRows[] {
    if (
      prepared.source === prepared.residentSource ||
      bindings !== undefined ||
      !hasCapturedTaskMembership(prepared.residentSource) ||
      prepared.residentRows.length === prepared.residentSource.batches.length
    )
      return prepared.residentRows;
    const active = new Set(prepared.source.batches);
    const supplied = new Map(prepared.residentRows.map((row) => [row.origin, row]));
    const rows: PreparedBatchRows[] = [];
    for (const origin of prepared.residentSource.batches) {
      const row = supplied.get(origin);
      if (row !== undefined) {
        rows.push(row);
        continue;
      }
      const held = this.rows.get(origin.batchId);
      if (!active.has(origin) && held?.row.origin === origin && held.bindings === bindings)
        rows.push(held.row);
    }
    return rows;
  }

  private selectActive(
    prepared: PreparedProductionPlan,
    resident: FilteredProductionPlan,
    fixedCandidates: boolean,
    previous: FilteredProductionPlan | undefined,
  ): FilteredProductionPlan {
    if (prepared.source === prepared.residentSource && prepared.batchRows === prepared.residentRows)
      return resident;
    const topology: GpuDrivenBatch[] = [];
    const batches: PreparedBatch[] = [];
    for (const row of prepared.batchRows) {
      const held = this.rows.get(row.source.batchId);
      if (held?.row !== row)
        throw new Error('Active filtered rows must select their exact resident contribution');
      for (const batch of held.topology) topology.push(batch);
      for (const batch of held.batches) batches.push(batch);
    }
    return this.publish(prepared.source, batches, topology, fixedCandidates, previous);
  }

  private publish(
    source: SubmissionPlan,
    batches: readonly PreparedBatch[],
    topology: readonly GpuDrivenBatch[],
    fixedCandidates: boolean,
    previous: FilteredProductionPlan | undefined,
  ): FilteredProductionPlan {
    if (
      previous !== undefined &&
      (previous.projectionSource !== undefined) === fixedCandidates &&
      previous.plan.revision === source.revision &&
      topology.length === previous.plan.batches.length &&
      topology.every((batch, index) => batch === previous.plan.batches.at(index))
    ) {
      this.assemblyCounters.publicationHits++;
      return previous;
    }
    const assembled = assembleFilteredGroups(source, batches, topology);
    return fixedCandidates ? { ...assembled, projectionSource: assembled.plan } : assembled;
  }
}

function validContribution(
  plan: SubmissionPlan,
  index: number,
  origin: GpuDrivenBatch | undefined,
  row: PreparedBatchRows | undefined,
): origin is GpuDrivenBatch {
  if (
    !hasCapturedTaskMembership(plan) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    origin === undefined ||
    capturedGpuDrivenBatchKey(origin) === undefined ||
    !MemberCandidates.is(origin.candidates) ||
    origin.members !== origin.candidates.membersFrame()
  )
    return false;
  return row === undefined || (isPreparedBatchRows(row) && row.origin === origin);
}

function stale(): GpuDrivenPreparationError {
  return new GpuDrivenPreparationError('stale-generation', {
    reason: 'generation-stale',
    owner: 'generation',
    expected: 'the same live Filtered owner and current inactive contribution',
  });
}

function unavailable(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'one current owned inactive native contribution at an exclusive Filtered boundary',
    hint: 'finish active recording, discard invalid work, or reset a failed owner before preparing again',
  });
}
