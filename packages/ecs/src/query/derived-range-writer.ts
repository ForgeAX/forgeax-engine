import { err, ok, type Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import * as componentOwner from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  createDerivedRangeOutOfBoundsError,
  createSharedKernelFailureError,
  DerivedWriteActiveError,
  worldPoisonedError,
} from '../errors';
import type { Table } from '../storage/table';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';
import type { MutableColumnShape, ReadonlyColumnShape } from './query';

/** Package-internal whole-column storage owned by one dense query table. */
export interface DerivedColumnBinding<R extends Component, C extends Component> {
  /** Physical table identity for package-internal projection consumers. */
  readonly tableId: number;
  /** Whole entity column; every dense table carries the Entity row. */
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
   * Binding index of a matched table, or -1. Rosters are current after
   * reading `bindings` and stay fixed for the duration of `writeRows`.
   */
  bindingOfTable(tableId: number): number;
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
    readonly table: Table,
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
  const owner = world[worldInternal];
  const bindings: ColumnBinding<R, C>[] = [];
  const bindingByTableId: number[] = [];
  const changedCounts: number[] = [];
  const touchedBindings: number[] = [];
  const outputId = componentOwner.componentId(component);
  const assertEpoch = (epoch: number, structure: number): void => {
    if (owner.getMutationEpoch() !== epoch || owner.getStructureEpoch() !== structure)
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
      bindings.push(binding);
      bindingByTableId[table.id] = index;
    }
  };
  const beginWrite = (): EcsError | undefined => {
    if (!owner.beginDerivedWrite()) return new DerivedWriteActiveError();
    let ready = false;
    try {
      const poisoned = worldPoisonedError(world.execution);
      ready = poisoned === undefined;
      return poisoned;
    } finally {
      if (!ready) owner.endDerivedWrite();
    }
  };

  const bindRange = (
    index: number,
    base: number,
    start: number,
    count: number,
  ): ColumnBinding<R, C> | EcsError => {
    syncTables();
    const binding = bindings[index];
    return binding !== undefined &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      Number.isSafeInteger(base) &&
      base >= 0 &&
      Number.isSafeInteger(start) &&
      start >= 0 &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      base + start + count <= binding.rowCapacity &&
      binding.table.storage.has(outputId)
      ? binding
      : createDerivedRangeOutOfBoundsError(start, count, binding?.rowCapacity ?? 0);
  };

  const publish = (
    binding: ColumnBinding<R, C>,
    start: number,
    count: number,
    epoch: number,
  ): void => owner.publishDerivedRange(binding.table, outputId, start, count, epoch);

  const failPublication = (
    cause: unknown,
    previousEpoch: number,
    epoch: number,
    phase: '' | ':publish',
  ) => {
    if (epoch !== 0 && owner.getMutationEpoch() === epoch)
      owner.restoreMutationEpoch(previousEpoch);
    owner.poisonExecution({
      code: 'shared-kernel-failed',
      kernelName: `derived-range:${component.name}${phase}`,
      cause,
      partialWrite: true,
      retryable: false,
    });
    return err(createSharedKernelFailureError(component.name, world.identity, cause, true));
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
      const archetype = owner.getEntityArchetype(entity);
      if (archetype === undefined) return false;
      const bindingIndex = bindingByTableId[archetype.table.id];
      if (bindingIndex === undefined) return false;
      const records = owner.records;
      const slot = (entity as unknown as number) & 0x00ffffff;
      if (records.archetypeId[slot] !== archetype.id) return false;
      const row = records.tableRow[slot] as number;
      const binding = bindings[bindingIndex];
      if (binding === undefined || row < 0 || row >= binding.rowCapacity) {
        return false;
      }
      cursor.bindingIndex = bindingIndex;
      cursor.row = row;
      return true;
    },
    bindingOfTable(tableId) {
      return bindingByTableId[tableId] ?? -1;
    },
    writeRows(rows, produce) {
      const failure = beginWrite();
      if (failure !== undefined) return err(failure);
      try {
        const previousEpoch = owner.getMutationEpoch();
        const structure = owner.getStructureEpoch();
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
            if (
              binding === undefined ||
              !Number.isSafeInteger(row) ||
              row < 0 ||
              row >= binding.rowCapacity
            )
              throw createDerivedRangeOutOfBoundsError(row, 1, binding?.rowCapacity ?? 0);
            const count = changedCounts[bindingIndex] ?? 0;
            if (count === 0) {
              // Membership is a property of the table, so one check per binding.
              if (!binding.table.storage.has(outputId))
                throw createDerivedRangeOutOfBoundsError(row, 1, binding.rowCapacity);
              touchedBindings.push(bindingIndex);
            }
            changedCounts[bindingIndex] = count + 1;
          }
          const epoch = owner.nextMutationEpoch();
          reservedEpoch = epoch;
          let ranges = 0;
          for (let index = 0; index < rows.length; ) {
            const bindingIndex = rows[index] as number;
            const binding = bindings[bindingIndex] as ColumnBinding<R, C>;
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
            publish(binding, start, count, epoch);
            ranges++;
          }
          return ok(ranges);
        } catch (cause) {
          return failPublication(cause, previousEpoch, reservedEpoch, ':publish');
        } finally {
          for (const bindingIndex of touchedBindings) changedCounts[bindingIndex] = 0;
          touchedBindings.length = 0;
        }
      } finally {
        owner.endDerivedWrite();
      }
    },
    writeRange(bindingIndex, base, start, count, kernel, context) {
      const failure = beginWrite();
      if (failure !== undefined) return err(failure);
      try {
        const binding = bindRange(bindingIndex, base, start, count);
        if (!(binding instanceof ColumnBinding)) return err(binding);
        if (count === 0) return ok(undefined);

        const structure = owner.getStructureEpoch();
        const previousEpoch = owner.getMutationEpoch();
        let epoch: number;
        try {
          epoch = owner.nextMutationEpoch();
        } catch (cause) {
          return err(cause as EcsError);
        }
        try {
          assertSynchronous(kernel(binding, base, start, count, context));
          assertEpoch(epoch, structure);
          publish(binding, base + start, count, epoch);
          return ok(undefined);
        } catch (cause) {
          return failPublication(cause, previousEpoch, epoch, '');
        }
      } finally {
        owner.endDerivedWrite();
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
