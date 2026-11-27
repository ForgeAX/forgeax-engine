import { err, ok, type Result } from '@forgeax/engine-types';
import { type Component, componentId } from '../component';
import { type EntityHandle, entityGeneration, entityIndex } from '../entity-handle';
import type { ArrayStore } from '../storage/array-store';
import { type ChangeColumn, stampChange } from '../storage/change-column';
import { type Column, columnArrayLength, copyColumnArray } from '../storage/column';
import type { Table } from '../storage/table';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';
import type { WorldRead } from '../world-read';

/** One table's storage for the looked-up components, in request order. */
export interface EntityLookupColumns {
  /** Requested field columns; undefined where the table lacks the component. */
  readonly fields: readonly (Column | undefined)[];
  /** Per requested component: added and changed epochs by row. */
  readonly added: readonly (Float64Array | undefined)[];
  readonly changed: readonly (ChangeColumn | undefined)[];
}

/**
 * Random access to a fixed set of components by entity: one location lookup,
 * then direct column reads on the entity's table. Column sets are cached per
 * table and rebuilt when the table grows.
 */
export interface EntityLookup {
  /** Locate a live entity; on success `slot`, `row` and `columns` describe it. */
  get(entity: EntityHandle): boolean;
  readonly slot: number;
  readonly tableId: number;
  readonly row: number;
  readonly columns: EntityLookupColumns;
  /**
   * Backing of variable array fields. A located row's field column holds
   * `[block, byteOffset, count]` at `row * 3`; its elements are
   * `arrays.u32(block)[byteOffset / 4 + i]` for 4-byte element types.
   */
  readonly arrays: ArrayStore;
  /**
   * Position on a row the caller already located in a table, skipping the
   * entity resolution. The row must hold a live entity.
   */
  at(tableId: number, row: number): boolean;
  /** Live element count of the located row's array field; undefined when absent. */
  arrayLength(field: number): number | undefined;
  /** Copy the located row's array field into `target`; undefined when absent. */
  copyArray(field: number, target: Parameters<WorldRead['copyArray']>[3]): number | undefined;
  /**
   * Flag a requested component on the located row as changed. Supply a reserved batch
   * epoch or issue one for this row. An absent component consumes no epoch.
   */
  markChanged(component: number, epoch?: number): boolean;
  /**
   * Reserve one mutation epoch for a batch of `markChanged` calls; an
   * exhausted epoch counter is returned, leaving the World unchanged.
   */
  nextEpoch(): Result<number, EcsError>;
}

interface CachedColumns extends EntityLookupColumns {
  readonly version: number;
}

const EMPTY: CachedColumns = { version: -1, fields: [], added: [], changed: [] };

export function createEntityLookup(
  world: World,
  components: readonly Component[],
  fields: readonly (readonly [component: number, field: string])[],
): EntityLookup {
  const internal = world[worldInternal];
  const graph = internal.graph;
  const records = internal.records;
  const arrays = internal.arrayStore;
  const ids = components.map((component) => componentId(component));
  const cache: (CachedColumns | undefined)[] = [];
  let located: CachedColumns = EMPTY;

  const columnsOf = (target: Table): CachedColumns => {
    const cached = cache[target.id];
    if (cached?.version === target.version) return cached;
    const columns = fields.map(([component, field]) =>
      target.storage.get(ids[component] as number)?.fields.get(field),
    );
    const built: CachedColumns = {
      version: target.version,
      fields: columns,
      added: ids.map((id) => target.storage.get(id)?.added),
      changed: ids.map((id) => target.storage.get(id)?.changed),
    };
    cache[target.id] = built;
    return built;
  };

  const lookup = {
    slot: -1,
    tableId: -1,
    arrays,
    row: -1,
    columns: EMPTY,
    get(entity: EntityHandle): boolean {
      const slot = entityIndex(entity);
      if (!records.isLive(slot, entityGeneration(entity))) return false;
      const table = graph.archetypes[records.archetypeId[slot] as number]?.table;
      const row = records.tableRow[slot] as number;
      if (table === undefined) return false;
      lookup.slot = slot;
      lookup.tableId = table.id;
      lookup.row = row;
      located = columnsOf(table);
      lookup.columns = located;
      return true;
    },
    at(tableId: number, row: number): boolean {
      const table = graph.tables[tableId];
      if (table === undefined) return false;
      lookup.slot = entityIndex(table.entities.view[row] as EntityHandle);
      lookup.tableId = tableId;
      lookup.row = row;
      located = columnsOf(table);
      lookup.columns = located;
      return true;
    },
    arrayLength(field: number): number | undefined {
      const column = located.fields[field];
      return column === undefined ? undefined : columnArrayLength(column, lookup.row);
    },
    copyArray(field: number, target: Parameters<WorldRead['copyArray']>[3]): number | undefined {
      const column = located.fields[field];
      return column === undefined ? undefined : copyColumnArray(arrays, column, lookup.row, target);
    },
    markChanged(component: number, epoch?: number): boolean {
      const changed = lookup.columns.changed[component];
      if (changed === undefined) return false;
      epoch ??= internal.nextMutationEpoch();
      stampChange(changed, lookup.row, epoch);
      internal.publishLocatedChange(lookup.slot, ids[component] as number, epoch);
      return true;
    },
    nextEpoch(): Result<number, EcsError> {
      try {
        return ok(internal.nextMutationEpoch());
      } catch (cause) {
        return err(cause as EcsError);
      }
    },
  };
  return lookup;
}
