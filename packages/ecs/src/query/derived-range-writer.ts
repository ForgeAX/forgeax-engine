import { err, ok, type Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import * as componentOwner from '../component';
import { componentId } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { DerivedRangeOutOfBoundsError, SharedKernelFailureError } from '../errors';
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
  readonly structureEpoch: () => number;
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
  /** Publish rows whose values were written directly into a derived column. */
  publishChangedRows(bindingIndex: number, changed: Uint8Array): Result<void, EcsError>;
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

export function createDerivedRangeWriter<R extends Component, C extends Component>(
  world: World,
  component: C,
  source: DerivedRangeBindingSource,
): DerivedRangeWriter<R, C> {
  let boundEpoch = -1;
  let bindingTables: readonly Table[] = [];
  let bindings: readonly DerivedColumnBinding<R, C>[] = [];
  let bindingByTable = new Map<number, number>();
  let runStartBuffers: readonly Int32Array[] = [];
  let runCountBuffers: readonly Int32Array[] = [];

  const rebind = (): void => {
    countAllocation('bindingRebuilds');
    const tables = source.tables();
    const nextBindings: DerivedColumnBinding<R, C>[] = [];
    const nextRunStartBuffers: Int32Array[] = [];
    const nextRunCountBuffers: Int32Array[] = [];
    for (const table of tables) {
      nextBindings.push({
        tableId: table.id,
        entities: (table.storage.get(componentId(Entity))?.fields.get('self')?.view ??
          new Uint32Array(0)) as Uint32Array,
        read: buildWholeColumnShape(table, source.readComponents) as ReadonlyColumnShape<R>,
        write: buildWholeColumnShape(table, source.writeComponents) as MutableColumnShape<C>,
        rowCapacity: table.size,
      });
      // A table with N rows can contain at most N changed runs. These buffers
      // are owned by the structural rebind and reused by every hot call.
      const runCapacity = Math.max(1, table.size);
      nextRunStartBuffers.push(new Int32Array(runCapacity));
      nextRunCountBuffers.push(new Int32Array(runCapacity));
    }
    bindingTables = tables;
    bindings = nextBindings;
    bindingByTable = new Map<number, number>();
    for (let index = 0; index < nextBindings.length; index += 1) {
      const binding = nextBindings[index];
      if (binding !== undefined) bindingByTable.set(binding.tableId, index);
    }
    runStartBuffers = nextRunStartBuffers;
    runCountBuffers = nextRunCountBuffers;
    boundEpoch = source.structureEpoch();
  };

  rebind();

  const writer: DerivedRangeWriter<R, C> = {
    get bindings() {
      if (boundEpoch !== source.structureEpoch()) rebind();
      return bindings;
    },
    locateEntity(entity, cursor) {
      if (world.execution.health === 'poisoned') return false;
      if (boundEpoch !== source.structureEpoch()) rebind();
      const archetype = world[worldInternal].getEntityArchetype(entity);
      if (archetype === undefined) return false;
      const bindingIndex = bindingByTable.get(archetype.tableId);
      if (bindingIndex === undefined) return false;
      const record = world[worldInternal].getRecords()[(entity as unknown as number) & 0x00ffffff];
      if (record === undefined || record.archetypeId !== archetype.id) return false;
      const row = archetype.rows[record.archetypeRow];
      const binding = bindings[bindingIndex];
      if (binding === undefined || row === undefined || row < 0 || row >= binding.rowCapacity) {
        return false;
      }
      cursor.bindingIndex = bindingIndex;
      cursor.row = row;
      return true;
    },
    publishChangedRows(bindingIndex, changed) {
      const poisoned = worldPoisonedError(world.execution);
      if (poisoned !== undefined) return err(poisoned);
      if (boundEpoch !== source.structureEpoch()) rebind();
      const binding = bindings[bindingIndex];
      const table = bindingTables[bindingIndex];
      const runStarts = runStartBuffers[bindingIndex];
      const runCounts = runCountBuffers[bindingIndex];
      if (
        binding === undefined ||
        table === undefined ||
        runStarts === undefined ||
        runCounts === undefined ||
        !Number.isSafeInteger(bindingIndex) ||
        bindingIndex < 0 ||
        changed.length < binding.rowCapacity ||
        table.storage.get(componentOwner.componentId(component)) === undefined
      ) {
        return err(new DerivedRangeOutOfBoundsError(0, changed.length, binding?.rowCapacity ?? 0));
      }
      let runCount = 0;
      let runStart = -1;
      for (let row = 0; row < binding.rowCapacity; row += 1) {
        if ((changed[row] ?? 0) !== 0) {
          if (runStart < 0) runStart = row;
        } else if (runStart >= 0) {
          runStarts[runCount] = runStart;
          runCounts[runCount] = row - runStart;
          runCount += 1;
          runStart = -1;
        }
      }
      if (runStart >= 0) {
        runStarts[runCount] = runStart;
        runCounts[runCount] = binding.rowCapacity - runStart;
        runCount += 1;
      }
      if (runCount === 0) return ok(undefined);
      const previousEpoch = world[worldInternal].getMutationEpoch();
      let epoch: number;
      try {
        epoch = world[worldInternal].nextMutationEpoch();
        const componentIdentifier = componentOwner.componentId(component);
        for (let index = 0; index < runCount; index += 1) {
          world[worldInternal].publishDerivedRange(
            table,
            componentIdentifier,
            runStarts[index] ?? 0,
            runCounts[index] ?? 0,
            epoch,
          );
        }
        changed.fill(0, 0, binding.rowCapacity);
        return ok(undefined);
      } catch (cause) {
        world[worldInternal].restoreMutationEpoch(previousEpoch);
        world[worldInternal].poisonExecution({
          code: 'shared-kernel-failed',
          kernelName: `derived-range:${component.name}:publish`,
          cause,
          partialWrite: true,
          retryable: false,
        });
        return err(new SharedKernelFailureError(component.name, world.identity, cause, true));
      }
    },
    writeRange(bindingIndex, base, start, count, kernel, context) {
      const poisoned = worldPoisonedError(world.execution);
      if (poisoned !== undefined) return err(poisoned);
      if (boundEpoch !== source.structureEpoch()) rebind();
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

      const previousEpoch = world[worldInternal].getMutationEpoch();
      let epoch: number;
      try {
        epoch = world[worldInternal].nextMutationEpoch();
      } catch (cause) {
        return err(cause as EcsError);
      }
      try {
        kernel(binding, base, start, count, context);
        world[worldInternal].publishDerivedRange(
          table,
          componentOwner.componentId(component),
          base + start,
          count,
          epoch,
        );
        return ok(undefined);
      } catch (cause) {
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
    },
    probeAndCommitRange(bindingIndex, base, start, count, probe, commit, context) {
      const poisoned = worldPoisonedError(world.execution);
      if (poisoned !== undefined) return err(poisoned);
      if (boundEpoch !== source.structureEpoch()) rebind();
      const binding = bindings[bindingIndex];
      const table = bindingTables[bindingIndex];
      const runStarts = runStartBuffers[bindingIndex];
      const runCounts = runCountBuffers[bindingIndex];
      if (
        binding === undefined ||
        table === undefined ||
        runStarts === undefined ||
        runCounts === undefined ||
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

      const previousEpoch = world[worldInternal].getMutationEpoch();
      let runCount = 0;
      let epoch = 0;
      let epochReserved = false;
      let runStart = -1;
      try {
        for (let offset = 0; offset < count; offset += 1) {
          const row = base + start + offset;
          const changed = probe(binding, row, context);
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
            commit(binding, row, context);
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
        if (epochReserved) world[worldInternal].restoreMutationEpoch(previousEpoch);
        world[worldInternal].poisonExecution({
          code: 'shared-kernel-failed',
          kernelName: `derived-range:${component.name}:probe`,
          cause,
          partialWrite: true,
          retryable: false,
        });
        return err(new SharedKernelFailureError(component.name, world.identity, cause, true));
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
