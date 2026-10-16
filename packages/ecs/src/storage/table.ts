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
import {
  type ComponentEpochColumns,
  copyComponentEpoch,
  createComponentEpochColumns,
  growComponentEpochColumns,
  PROJECTION_BLOCK_SIZE,
} from './change-detection';
import { arrayCountColumnName, type Column, createColumn, growColumn } from './column';

const INITIAL_CAPACITY = 64;

export type TableId = number;

export interface TableComponentStorage {
  readonly component: Component;
  fields: Map<string, Column>;
  epochs: ComponentEpochColumns;
}

export interface Table {
  readonly id: TableId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  storage: Map<ComponentId, TableComponentStorage>;
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
      fields.set(fieldName, createColumn(scalarType, capacity, 1, shared));
      if (arrayMeta !== null && arrayMeta.length === undefined) {
        fields.set(arrayCountColumnName(fieldName), createColumn('u32', capacity, 1, shared));
      }
    }
    storage.set(componentId(component), {
      component,
      fields,
      epochs: createComponentEpochColumns(capacity),
    });
  }
  return {
    id,
    key: tableKey(sortedComponents.map((component) => componentId(component))),
    components: sortedComponents,
    storage,
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
  const self = table.storage.get(componentId(Entity))?.fields.get('self');
  if (self !== undefined) self.view[row] = entity as number;
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
  const movedEntity = (table.storage.get(componentId(Entity))?.fields.get('self')?.view[lastRow] ??
    0) as EntityHandle;
  for (const componentStorage of table.storage.values()) {
    for (const column of componentStorage.fields.values()) {
      const arity = column.arity;
      column.view.set(column.view.subarray(lastRow * arity, lastRow * arity + arity), row * arity);
    }
    copyComponentEpoch(componentStorage.epochs, lastRow, componentStorage.epochs, row);
  }
  table.size = lastRow;
  return { movedEntity, newRow: row };
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
    componentStorage.epochs = growComponentEpochColumns(componentStorage.epochs, capacity);
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
