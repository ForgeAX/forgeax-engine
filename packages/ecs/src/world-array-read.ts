import { type Component, componentDefinition, componentId } from './component';
import { type EntityHandle, entityIndex } from './entity-handle';
import type { WorldInternal } from './world-internal';
import type { WorldRead } from './world-read';

/** Read access only; the World remains the storage and identity authority. */
type ArrayReadOwner = Pick<
  WorldInternal,
  'getEntityArchetype' | 'getGraph' | 'getRecords' | 'getArrayView'
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
  const row = archetype.rows[owner.getRecords().archetypeRow[entityIndex(entity)] as number];
  if (row === undefined) return undefined;
  const count =
    metadata.length ??
    (column.countField === undefined ? 0 : (fields?.get(column.countField)?.view[row] ?? 0));
  if (target.length < count) return undefined;
  if (metadata.length === undefined) {
    const source = owner.getArrayView(entity, component, fieldName);
    if (source === undefined) return undefined;
    target.set(source);
  } else {
    const start = row * column.arity;
    // Native set handles overlap and conversion between different numeric representations.
    if (target.buffer === column.view.buffer)
      target.set(column.view.subarray(start, start + count));
    else
      for (let index = 0; index < count; index++)
        target[index] = column.view[start + index] as number;
  }
  return count;
}
