import {
  bufferFieldByteLength,
  type Component,
  type ComponentId,
  componentId,
  componentSchema,
  fieldTypeToMetaKey,
  isManagedBufferField,
  parseManagedArraySchema,
  type ScalarFieldType,
  TYPE_METADATA,
} from '../component';
import { Entity, foldEssentials } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { PROJECTION_BLOCK_SIZE } from './change-detection';
import { arrayCountColumnName, type Column, createColumn, growColumn } from './column';

const INITIAL_CAPACITY = 64;

export type TableId = number;

interface TableComponentStorage {
  readonly component: Component;
  fields: Map<string, Column>;
  added: Float64Array;
}

export interface Table {
  readonly id: TableId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  storage: Map<ComponentId, TableComponentStorage>;
  /** The essential `Entity.self` column (replaced with the others on growth). */
  entities: Column;
  size: number;
  capacity: number;
  version: number;
  membership: Float64Array;
  readonly activeDirectories: readonly Set<Table>[];
}

export function tableKey(componentIds: ReadonlyArray<ComponentId>): string {
  return [...foldEssentials(componentIds)].sort((a, b) => a - b).join('+');
}

export function canonicalComponents(components: ReadonlyArray<Component>): Component[] {
  const byId = new Map<ComponentId, Component>();
  byId.set(componentId(Entity), Entity as unknown as Component);
  for (const component of components) byId.set(componentId(component), component);
  return [...byId.values()].sort((a, b) => componentId(a) - componentId(b));
}

export function createTable(
  components: ReadonlyArray<Component>,
  id: TableId,
  shared = false,
  activeDirectories: readonly Set<Table>[] = [new Set<Table>()],
): Table {
  const sortedComponents = canonicalComponents(components);
  const capacity = INITIAL_CAPACITY;
  const storage = new Map<ComponentId, TableComponentStorage>();
  for (const component of sortedComponents) {
    const fields = new Map<string, Column>();
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
      const arrayMeta = parseManagedArraySchema(fieldType);
      if (arrayMeta !== null && arrayMeta.length !== undefined) {
        const metaKey = fieldTypeToMetaKey(arrayMeta.elementType);
        const scalarType: ScalarFieldType | null =
          metaKey === null ? null : (TYPE_METADATA[metaKey]?.storage ?? null);
        if (scalarType !== null) {
          fields.set(fieldName, createColumn(scalarType, capacity, arrayMeta.length, shared));
        }
        continue;
      }
      if (isManagedBufferField(fieldType) && fieldType !== 'buffer') {
        fields.set(
          fieldName,
          createColumn('u8', capacity, bufferFieldByteLength(fieldType), shared),
        );
        continue;
      }
      const metaKey = fieldTypeToMetaKey(fieldType);
      const scalarType: ScalarFieldType | null =
        metaKey === null ? null : (TYPE_METADATA[metaKey]?.storage ?? null);
      if (scalarType === null) continue;
      const column = createColumn(scalarType, capacity, 1, shared);
      fields.set(fieldName, column);
      if (arrayMeta !== null && arrayMeta.length === undefined) {
        column.countField = arrayCountColumnName(fieldName);
        fields.set(column.countField, createColumn('u32', capacity, 1, shared));
      }
    }
    storage.set(componentId(component), {
      component,
      fields,
      added: new Float64Array(capacity),
    });
  }
  const entities = storage.get(componentId(Entity))?.fields.get('self');
  if (entities === undefined) throw new Error('Table has no Entity.self column.');
  return {
    id,
    key: tableKey(sortedComponents.map((component) => componentId(component))),
    components: sortedComponents,
    storage,
    entities,
    size: 0,
    capacity,
    version: 0,
    membership: new Float64Array(Math.ceil(capacity / PROJECTION_BLOCK_SIZE)),
    activeDirectories,
  };
}

export function appendTableRow(table: Table, entity: EntityHandle, epoch = 0): number {
  if (table.size === table.capacity) growTable(table, table.capacity * 2);
  const row = table.size;
  table.entities.view[row] = entity as number;
  table.size = row + 1;
  if (row === 0) for (const directory of table.activeDirectories) directory.add(table);
  markTableMembership(table, row, epoch);
  return row;
}

export function removeTableRow(
  table: Table,
  row: number,
  epoch = 0,
): { movedEntity: EntityHandle; newRow: number } | null {
  const lastRow = table.size - 1;
  markTableMembership(table, row, epoch);
  markTableMembership(table, lastRow, epoch);
  if (lastRow === 0) for (const directory of table.activeDirectories) directory.delete(table);
  if (row === lastRow) {
    table.size = lastRow;
    return null;
  }
  const movedEntity = (table.entities.view[lastRow] ?? 0) as EntityHandle;
  for (const componentStorage of table.storage.values()) {
    for (const column of componentStorage.fields.values())
      copyColumnRow(column, lastRow, column, row);
    componentStorage.added[row] = componentStorage.added[lastRow] ?? 0;
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
  const arity = source.arity;
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
  }
  const membership = new Float64Array(Math.ceil(capacity / PROJECTION_BLOCK_SIZE));
  membership.set(table.membership);
  table.membership = membership;
  table.capacity = capacity;
  table.version += 1;
}

export function markTableMembership(table: Table, row: number, epoch: number): void {
  table.membership[Math.floor(row / PROJECTION_BLOCK_SIZE)] = epoch;
}
