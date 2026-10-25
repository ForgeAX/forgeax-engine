import { err, ok, type Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import * as componentOwner from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  DerivedRangeOutOfBoundsError,
  DerivedWriteActiveError,
  SharedKernelFailureError,
} from '../errors';
import { worldPoisonedError } from '../errors/shared-kernel-errors';
import type { Table } from '../storage/table';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';
import type { MutableColumnShape, ReadonlyColumnShape } from './query';

/** Package-internal whole-column storage owned by one dense query table. */
export interface DerivedColumnBinding<R extends Component, C extends Component> {
  /** Physical table identity for package-internal projection consumers. */
  readonly tableId: number;
  /** Whole entity column; every dense table carries the essential Entity row. */
  readonly entities: Readonly<Uint32Array>;
  readonly read: ReadonlyColumnShape<R>;
  readonly write: MutableColumnShape<C>;
  readonly rowCapacity: number;
}

/** Reusable identity cursor for O(1) dense-table lookup without a row facade. */
export interface DerivedRangeCursor {
  bindingIndex: number;
  row: number;
}

export type DerivedRangeKernel<R extends Component, C extends Component> = (
  binding: DerivedColumnBinding<R, C>,
  base: number,
  start: number,
  count: number,
  context: unknown,
) => void;

/** Package-internal row probe used when the probe already has the derived value in scratch storage. */
export type DerivedRangeRowProbe<R extends Component, C extends Component> = (
  binding: DerivedColumnBinding<R, C>,
  row: number,
  context: unknown,
) => boolean;

/** Package-internal commit for a value prepared by a preceding row probe. */
export type DerivedRangeRowCommit<R extends Component, C extends Component> = (
  binding: DerivedColumnBinding<R, C>,
  row: number,
  context: unknown,
) => void;

interface DerivedRangeBindingSource {
  readonly tables: () => readonly Table[];
  readonly readComponents: readonly Component[];
  readonly writeComponents: readonly Component[];
}

export interface DerivedRangeAllocationTrace {
  subarrayCalls: number;
  shapeAllocations: number;
  closureAllocations: number;
  columnWindowAllocations: number;
  rowFacadeAllocations: number;
  proxyAllocations: number;
  rangeCacheAllocations: number;
  bindingRebuilds: number;
}

let allocationTrace: DerivedRangeAllocationTrace | undefined;

export function beginDerivedRangeAllocationTrace(): void {
  allocationTrace = {
    subarrayCalls: 0,
    shapeAllocations: 0,
    closureAllocations: 0,
    columnWindowAllocations: 0,
    rowFacadeAllocations: 0,
    proxyAllocations: 0,
    rangeCacheAllocations: 0,
    bindingRebuilds: 0,
  };
}

export function endDerivedRangeAllocationTrace(): DerivedRangeAllocationTrace {
  const trace = allocationTrace;
  allocationTrace = undefined;
  return (
    trace ?? {
      subarrayCalls: 0,
      shapeAllocations: 0,
      closureAllocations: 0,
      columnWindowAllocations: 0,
      rowFacadeAllocations: 0,
      proxyAllocations: 0,
      rangeCacheAllocations: 0,
      bindingRebuilds: 0,
    }
  );
}

function countAllocation(name: keyof DerivedRangeAllocationTrace): void {
  const trace = allocationTrace;
  if (trace !== undefined) trace[name] += 1;
}

export interface DerivedRangeWriter<R extends Component, C extends Component> {
  readonly bindings: readonly DerivedColumnBinding<R, C>[];
  /** Locate a live entity in its bound table and return its physical row. */
  locateEntity(entity: EntityHandle, cursor: DerivedRangeCursor): boolean;
  /**
   * Publish distinct producer-known (bindingIndex, row) pairs and return the
   * emitted range count. The producer owns uniqueness; no clean mask is read.
   */
  writeRows(rows: number[], produce: () => void): Result<number, EcsError>;
  writeRange(
    bindingIndex: number,
    base: number,
    start: number,
    count: number,
    kernel: DerivedRangeKernel<R, C>,
    context: unknown,
  ): Result<void, EcsError>;
  /**
   * Probe and commit rows in one pass. The probe must only inspect the derived
   * value prepared in reusable scratch storage; the commit copies that value.
   * The writer publishes only contiguous changed runs and does not allocate in
   * the hot loop.
   */
  probeAndCommitRange(
    bindingIndex: number,
    base: number,
    start: number,
    count: number,
    probe: DerivedRangeRowProbe<R, C>,
    commit: DerivedRangeRowCommit<R, C>,
    context: unknown,
  ): Result<void, EcsError>;
}

function assertSynchronous(value: unknown): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
    throw new Error('Derived numeric callbacks must complete synchronously');
}

/** Borrowed numeric bindings resolve only their own physical table's growth. */
class ColumnBinding<R extends Component, C extends Component>
  implements DerivedColumnBinding<R, C>
{
  private version = -1;
  private input!: ReadonlyColumnShape<R>;
  private output!: MutableColumnShape<C>;
  private identities!: Uint32Array;

  constructor(
    private readonly table: Table,
    private readonly reads: readonly Component[],
    private readonly writes: readonly Component[],
  ) {
    this.refresh();
  }

  get tableId(): number {
    return this.table.id;
  }
  get rowCapacity(): number {
    return this.table.size;
  }
  get entities(): Readonly<Uint32Array> {
    this.refresh();
    return this.identities;
  }
  get read(): ReadonlyColumnShape<R> {
    this.refresh();
    return this.input;
  }
  get write(): MutableColumnShape<C> {
    this.refresh();
    return this.output;
  }

  private refresh(): void {
    if (this.version === this.table.version) return;
    countAllocation('bindingRebuilds');
    this.input = buildWholeColumnShape(this.table, this.reads) as ReadonlyColumnShape<R>;
    this.output = buildWholeColumnShape(this.table, this.writes) as MutableColumnShape<C>;
    this.identities = this.table.storage.get(componentOwner.componentId(Entity))?.fields.get('self')
      ?.view as Uint32Array;
    this.version = this.table.version;
  }
}

export function createDerivedRangeWriter<R extends Component, C extends Component>(
  world: World,
  component: C,
  source: DerivedRangeBindingSource,
): DerivedRangeWriter<R, C> {
  const bindingTables: Table[] = [];
  const bindings: DerivedColumnBinding<R, C>[] = [];
  const bindingByTable = new Map<number, number>();
  const runStartBuffers: Int32Array[] = [];
  const runCountBuffers: Int32Array[] = [];
  const changedCounts: number[] = [];
  const touchedBindings: number[] = [];
  const assertEpoch = (epoch: number, structure: number): void => {
    if (
      world[worldInternal].getMutationEpoch() !== epoch ||
      world[worldInternal].getStructureEpoch() !== structure
    )
      throw new Error('Derived numeric producer mutated the World outside its declared columns');
  };

  const syncTables = (): void => {
    // The query's matched owner roster only appends. Existing bindings and
    // their borrowed numeric views survive unrelated structural mutations.
    const tables = source.tables();
    for (let index = bindings.length; index < tables.length; index++) {
      const table = tables[index];
      if (table === undefined) continue;
      const binding = new ColumnBinding<R, C>(table, source.readComponents, source.writeComponents);
      bindingTables.push(table);
      bindings.push(binding);
      bindingByTable.set(table.id, index);
    }
  };
  const prepareRunBuffers = (index: number, rows: number): void => {
    const needed = Math.max(1, Math.ceil(rows / 2));
    if ((runStartBuffers[index]?.length ?? 0) >= needed) return;
    runStartBuffers[index] = new Int32Array(needed);
    runCountBuffers[index] = new Int32Array(needed);
  };

  syncTables();

  const writer: DerivedRangeWriter<R, C> = {
    get bindings() {
      syncTables();
      return bindings;
    },
    locateEntity(entity, cursor) {
      if (world.execution.health === 'poisoned') return false;
      syncTables();
      const archetype = world[worldInternal].getEntityArchetype(entity);
      if (archetype === undefined) return false;
      const bindingIndex = bindingByTable.get(archetype.tableId);
      if (bindingIndex === undefined) return false;
      const records = world[worldInternal].getRecords();
      const slot = (entity as unknown as number) & 0x00ffffff;
      if (records.archetypeId[slot] !== archetype.id) return false;
      const row = archetype.rows[records.archetypeRow[slot] as number];
      const binding = bindings[bindingIndex];
      if (binding === undefined || row === undefined || row < 0 || row >= binding.rowCapacity) {
        return false;
      }
      cursor.bindingIndex = bindingIndex;
      cursor.row = row;
      return true;
    },
    writeRows(rows, produce) {
      if (!world[worldInternal].beginDerivedWrite()) return err(new DerivedWriteActiveError());
      try {
        const poisoned = worldPoisonedError(world.execution);
        if (poisoned !== undefined) return err(poisoned);
        const previousEpoch = world[worldInternal].getMutationEpoch();
        const structure = world[worldInternal].getStructureEpoch();
        let reservedEpoch = 0;
        try {
          syncTables();
          assertSynchronous(produce());
          assertEpoch(previousEpoch, structure);
          if (rows.length === 0) return ok(0);
          // The producer already guarantees distinct pairs. Count only that
          // actual work, so a completely changed table emits one range without
          // sorting its rows or rediscovering them through a full mask.
          for (let index = 0; index < rows.length; index += 2) {
            const bindingIndex = rows[index] ?? -1;
            const row = rows[index + 1] ?? -1;
            const binding = bindings[bindingIndex];
            const table = bindingTables[bindingIndex];
            if (
              !Number.isSafeInteger(bindingIndex) ||
              !Number.isSafeInteger(row) ||
              bindingIndex < 0 ||
              row < 0 ||
              binding === undefined ||
              table === undefined ||
              row >= binding.rowCapacity ||
              !table.storage.has(componentOwner.componentId(component))
            )
              throw new DerivedRangeOutOfBoundsError(row, 1, binding?.rowCapacity ?? 0);
            const count = changedCounts[bindingIndex] ?? 0;
            if (count === 0) touchedBindings.push(bindingIndex);
            changedCounts[bindingIndex] = count + 1;
          }
          const epoch = world[worldInternal].nextMutationEpoch();
          reservedEpoch = epoch;
          let ranges = 0;
          for (let index = 0; index < rows.length; ) {
            const bindingIndex = rows[index] as number;
            const binding = bindings[bindingIndex] as DerivedColumnBinding<R, C>;
            if (changedCounts[bindingIndex] === -1) {
              index += 2;
              continue;
            }
            let start = rows[index + 1] as number;
            let count = 1;
            index += 2;
            if (changedCounts[bindingIndex] === binding.rowCapacity) {
              start = 0;
              count = binding.rowCapacity;
              changedCounts[bindingIndex] = -1;
            } else {
              while (
                index < rows.length &&
                rows[index] === bindingIndex &&
                rows[index + 1] === start + count
              ) {
                count++;
                index += 2;
              }
            }
            world[worldInternal].publishDerivedRange(
              bindingTables[bindingIndex] as Table,
              componentOwner.componentId(component),
              start,
              count,
              epoch,
            );
            ranges++;
          }
          return ok(ranges);
        } catch (cause) {
          if (reservedEpoch !== 0 && world[worldInternal].getMutationEpoch() === reservedEpoch)
            world[worldInternal].restoreMutationEpoch(previousEpoch);
          world[worldInternal].poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: `derived-range:${component.name}:publish`,
            cause,
            partialWrite: true,
            retryable: false,
          });
          return err(new SharedKernelFailureError(component.name, world.identity, cause, true));
        } finally {
          for (const bindingIndex of touchedBindings) changedCounts[bindingIndex] = 0;
          touchedBindings.length = 0;
        }
      } finally {
        world[worldInternal].endDerivedWrite();
      }
    },
    writeRange(bindingIndex, base, start, count, kernel, context) {
      if (!world[worldInternal].beginDerivedWrite()) return err(new DerivedWriteActiveError());
      try {
        const poisoned = worldPoisonedError(world.execution);
        if (poisoned !== undefined) return err(poisoned);
        syncTables();
        const binding = bindings[bindingIndex];
        const table = bindingTables[bindingIndex];
        if (
          binding === undefined ||
          table === undefined ||
          !Number.isSafeInteger(bindingIndex) ||
          !Number.isSafeInteger(base) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(count) ||
          bindingIndex < 0 ||
          base < 0 ||
          start < 0 ||
          count < 0 ||
          base + start + count > binding.rowCapacity ||
          table.storage.get(componentOwner.componentId(component)) === undefined
        ) {
          return err(new DerivedRangeOutOfBoundsError(start, count, binding?.rowCapacity ?? 0));
        }
        if (count === 0) return ok(undefined);

        const structure = world[worldInternal].getStructureEpoch();
        const previousEpoch = world[worldInternal].getMutationEpoch();
        let epoch: number;
        try {
          epoch = world[worldInternal].nextMutationEpoch();
        } catch (cause) {
          return err(cause as EcsError);
        }
        try {
          assertSynchronous(kernel(binding, base, start, count, context));
          assertEpoch(epoch, structure);
          world[worldInternal].publishDerivedRange(
            table,
            componentOwner.componentId(component),
            base + start,
            count,
            epoch,
          );
          return ok(undefined);
        } catch (cause) {
          if (world[worldInternal].getMutationEpoch() === epoch)
            world[worldInternal].restoreMutationEpoch(previousEpoch);
          world[worldInternal].poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: `derived-range:${component.name}`,
            cause,
            partialWrite: true,
            retryable: false,
          });
          return err(new SharedKernelFailureError(component.name, world.identity, cause, true));
        }
      } finally {
        world[worldInternal].endDerivedWrite();
      }
    },
    probeAndCommitRange(bindingIndex, base, start, count, probe, commit, context) {
      if (!world[worldInternal].beginDerivedWrite()) return err(new DerivedWriteActiveError());
      try {
        const poisoned = worldPoisonedError(world.execution);
        if (poisoned !== undefined) return err(poisoned);
        syncTables();
        const binding = bindings[bindingIndex];
        const table = bindingTables[bindingIndex];
        if (
          binding === undefined ||
          table === undefined ||
          !Number.isSafeInteger(bindingIndex) ||
          !Number.isSafeInteger(base) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(count) ||
          bindingIndex < 0 ||
          base < 0 ||
          start < 0 ||
          count < 0 ||
          base + start + count > binding.rowCapacity ||
          table.storage.get(componentOwner.componentId(component)) === undefined
        ) {
          return err(new DerivedRangeOutOfBoundsError(start, count, binding?.rowCapacity ?? 0));
        }
        if (count === 0) return ok(undefined);

        prepareRunBuffers(bindingIndex, count);
        const runStarts = runStartBuffers[bindingIndex] as Int32Array;
        const runCounts = runCountBuffers[bindingIndex] as Int32Array;
        const structure = world[worldInternal].getStructureEpoch();
        const previousEpoch = world[worldInternal].getMutationEpoch();
        let runCount = 0;
        let epoch = 0;
        let epochReserved = false;
        let runStart = -1;
        try {
          for (let offset = 0; offset < count; offset += 1) {
            const row = base + start + offset;
            const changed = probe(binding, row, context);
            if (typeof changed !== 'boolean')
              throw new Error('Derived row probe must return a synchronous boolean');
            assertEpoch(epochReserved ? epoch : previousEpoch, structure);
            if (changed) {
              if (!epochReserved) {
                try {
                  epoch = world[worldInternal].nextMutationEpoch();
                  epochReserved = true;
                } catch (cause) {
                  // Nothing has been committed yet. Keep the World healthy and
                  // preserve the source error so the caller can retry unchanged.
                  return err(cause as EcsError);
                }
              }
              if (runStart < 0) runStart = row;
              assertSynchronous(commit(binding, row, context));
            } else if (runStart >= 0) {
              runStarts[runCount] = runStart;
              runCounts[runCount] = row - runStart;
              runCount += 1;
              runStart = -1;
            }
          }
          if (runStart >= 0) {
            runStarts[runCount] = runStart;
            runCounts[runCount] = base + start + count - runStart;
            runCount += 1;
          }

          assertEpoch(epochReserved ? epoch : previousEpoch, structure);
          // Every changed run in this call shares the epoch reserved immediately
          // before the first commit. Publication remains deferred until the
          // complete probe/commit pass has succeeded.
          if (runCount > 0) {
            const componentIdentifier = componentOwner.componentId(component);
            for (let index = 0; index < runCount; index += 1) {
              const runStartValue = runStarts[index] ?? 0;
              const runLength = runCounts[index] ?? 0;
              world[worldInternal].publishDerivedRange(
                table,
                componentIdentifier,
                runStartValue,
                runLength,
                epoch,
              );
            }
          }
          return ok(undefined);
        } catch (cause) {
          if (epochReserved && world[worldInternal].getMutationEpoch() === epoch)
            world[worldInternal].restoreMutationEpoch(previousEpoch);
          world[worldInternal].poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: `derived-range:${component.name}:probe`,
            cause,
            partialWrite: true,
            retryable: false,
          });
          return err(new SharedKernelFailureError(component.name, world.identity, cause, true));
        }
      } finally {
        world[worldInternal].endDerivedWrite();
      }
    },
  };
  return writer;
}

function buildWholeColumnShape(
  table: Table,
  components: readonly Component[],
): Record<string, unknown> {
  countAllocation('shapeAllocations');
  const shape: Record<string, unknown> = {};
  for (const component of components) {
    const fields = table.storage.get(componentOwner.componentId(component))?.fields;
    if (fields === undefined) continue;
    for (const [fieldName, column] of fields) shape[fieldName] = column.view;
  }
  return shape;
}
