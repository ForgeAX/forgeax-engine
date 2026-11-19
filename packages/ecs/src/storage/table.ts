import { type Component, type ComponentId, componentDefinition, componentId } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  type ChangeColumn,
  createChangeColumn,
  growChangeColumn,
  moveChange,
} from './change-column';
import { type Column, createColumn, growColumn } from './column';

const INITIAL_CAPACITY = 64;

export type TableId = number;

interface TableComponentStorage {
  readonly component: Component;
  fields: Map<string, Column>;
  added: Float64Array;
  /** Epoch of the row's last write, with its chunk summary; travels with the row like `added`. */
  changed: ChangeColumn;
}

export interface Table {
  readonly id: TableId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  storage: Map<ComponentId, TableComponentStorage>;
  /** The `Entity.self` column (replaced with the others on growth). */
  entities: Column;
  size: number;
  capacity: number;
  version: number;
}

export function createTable(
  components: readonly Component[],
  key: string,
  id: TableId,
  shared: boolean,
): Table {
  const capacity = INITIAL_CAPACITY;
  const storage = new Map<ComponentId, TableComponentStorage>();
  for (const component of components) {
    const fields = new Map<string, Column>();
    const definition = componentDefinition(component);
    for (const fieldName of definition.fieldNames) {
      const plan = definition.plan.fields[fieldName];
      if (plan !== undefined) fields.set(fieldName, createColumn(plan, capacity, shared));
    }
    storage.set(definition.id, {
      component,
      fields,
      added: new Float64Array(capacity),
      changed: createChangeColumn(capacity),
    });
  }
  const entities = storage.get(componentId(Entity))?.fields.get('self');
  if (entities === undefined) throw new Error('Table has no Entity.self column.');
  return {
    id,
    key,
    components,
    storage,
    entities,
    size: 0,
    capacity,
    version: 0,
  };
}

export function appendTableRow(table: Table, entity: EntityHandle): number {
  if (table.size === table.capacity) growTable(table, table.capacity * 2);
  const row = table.size;
  table.entities.view[row] = entity as number;
  table.size = row + 1;
  return row;
}

export function removeTableRow(
  table: Table,
  row: number,
): { movedEntity: EntityHandle; newRow: number } | null {
  const lastRow = table.size - 1;
  if (row === lastRow) {
    table.size = lastRow;
    return null;
  }
  const movedEntity = (table.entities.view[lastRow] ?? 0) as EntityHandle;
  for (const componentStorage of table.storage.values()) {
    for (const column of componentStorage.fields.values())
      copyColumnRow(column, lastRow, column, row);
    componentStorage.added[row] = componentStorage.added[lastRow] ?? 0;
    moveChange(componentStorage.changed, row, lastRow);
  }
  table.size = lastRow;
  return { movedEntity, newRow: row };
}

/**
 * Copy one row's stride window between same-typed columns. Short strides copy
 * element-wise: a `subarray` per column per row move is pure garbage.
 */
export function copyColumnRow(
  source: Column,
  sourceRow: number,
  target: Column,
  targetRow: number,
): void {
  const arity = source.layout.arity;
  if (arity === 1) {
    target.view[targetRow] = source.view[sourceRow] as number;
    return;
  }
  const from = sourceRow * arity;
  const to = targetRow * arity;
  if (arity <= 64) {
    const sourceView = source.view;
    const targetView = target.view;
    for (let i = 0; i < arity; i++) targetView[to + i] = sourceView[from + i] as number;
    return;
  }
  target.view.set(source.view.subarray(from, from + arity), to);
}

export function growTable(table: Table, targetCapacity: number): void {
  let capacity = table.capacity;
  while (capacity < targetCapacity) capacity *= 2;
  if (capacity === table.capacity) return;
  for (const componentStorage of table.storage.values()) {
    const fields = new Map<string, Column>();
    for (const [fieldName, column] of componentStorage.fields) {
      fields.set(fieldName, growColumn(column, capacity));
    }
    componentStorage.fields = fields;
    const self = fields.get('self');
    if (self !== undefined && componentStorage.component === (Entity as unknown as Component))
      table.entities = self;
    const added = new Float64Array(capacity);
    added.set(componentStorage.added);
    componentStorage.added = added;
    componentStorage.changed = growChangeColumn(componentStorage.changed, capacity);
  }
  table.capacity = capacity;
  table.version += 1;
}
