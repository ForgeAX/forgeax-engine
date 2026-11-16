import {
  type ArrayMeta,
  type Component,
  componentDefinition,
  componentId,
  fieldTypeToMetaKey,
  TYPE_METADATA,
} from './component';
import { type EntityHandle, entityIndex } from './entity-handle';
import type { ArrayStore } from './storage/array-store';
import type { Column } from './storage/column';
import type { WorldInternal } from './world-internal';
import type { WorldRead } from './world-read';

/** Read access only; the World remains the storage and identity authority. */
type ArrayReadOwner = Pick<
  WorldInternal,
  'getEntityArchetype' | 'getGraph' | 'getRecords' | 'getArrayStore'
>;

export function copyWorldArray(
  owner: ArrayReadOwner,
  entity: EntityHandle,
  component: Component,
  fieldName: string,
  target: Parameters<WorldRead['copyArray']>[3],
): number | undefined {
  const archetype = owner.getEntityArchetype(entity);
  if (archetype === undefined) return undefined;
  const table = owner.getGraph().tables[archetype.tableId];
  const fields = table?.storage.get(componentId(component))?.fields;
  const column = fields?.get(fieldName);
  const metadata = componentDefinition(component).fields[fieldName]?.arrayMeta;
  if (column === undefined || metadata === undefined) return undefined;
  const row = owner.getRecords().tableRow[entityIndex(entity)] ?? -1;
  if (row < 0) return undefined;
  return copyColumnArray(owner.getArrayStore(), column, metadata, row, target);
}

/** Copy one located row's array field; the caller resolved its table and row. */
export function copyColumnArray(
  store: ArrayStore,
  column: Column,
  metadata: ArrayMeta,
  row: number,
  target: Parameters<WorldRead['copyArray']>[3],
): number | undefined {
  let source: ArrayLike<number>;
  let start: number;
  let count: number;
  if (metadata.length === undefined) {
    const base = row * 3;
    const location = column.view;
    count = location[base + 2] as number;
    if (target.length < count) return undefined;
    // biome-ignore lint/style/noNonNullAssertion: admitted array element types resolve to metadata
    const Ctor = TYPE_METADATA[fieldTypeToMetaKey(metadata.elementType)!]!.viewCtor;
    const view = store.view(location[base] as number, Ctor);
    source = view;
    start = (location[base + 1] as number) / view.BYTES_PER_ELEMENT;
    // Native set handles a target that aliases the same backing.
    if (target.buffer === view.buffer) {
      target.set(view.subarray(start, start + count));
      return count;
    }
  } else {
    count = metadata.length;
    if (target.length < count) return undefined;
    source = column.view;
    start = row * column.arity;
    if (target.buffer === column.view.buffer) {
      target.set(column.view.subarray(start, start + count));
      return count;
    }
  }
  for (let index = 0; index < count; index++) target[index] = source[start + index] as number;
  return count;
}
