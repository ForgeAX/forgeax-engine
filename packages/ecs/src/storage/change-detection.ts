// @forgeax/engine-ecs — per-entity and per-resource change ticks.

import type { Component } from '../component';
import * as componentOwner from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';

import type { ArchetypeGraph } from './archetype-graph';

export const PROJECTION_BLOCK_SIZE = 256;

const INITIAL_SPARSE_CAPACITY = 64;

export interface ComponentEpochColumns {
  added: Float64Array;
  changed: Float64Array;
  blocks: Float64Array;
}

export function createComponentEpochColumns(capacity: number): ComponentEpochColumns {
  return {
    added: new Float64Array(capacity),
    changed: new Float64Array(capacity),
    blocks: new Float64Array(Math.ceil(capacity / PROJECTION_BLOCK_SIZE)),
  };
}

export function growComponentEpochColumns(
  columns: ComponentEpochColumns,
  capacity: number,
): ComponentEpochColumns {
  const added = new Float64Array(capacity);
  const changed = new Float64Array(capacity);
  added.set(columns.added);
  changed.set(columns.changed);
  const blocks = new Float64Array(Math.ceil(capacity / PROJECTION_BLOCK_SIZE));
  blocks.set(columns.blocks);
  return { added, changed, blocks };
}

export function copyComponentEpoch(
  source: ComponentEpochColumns,
  sourceRow: number,
  target: ComponentEpochColumns,
  targetRow: number,
): void {
  target.added[targetRow] = source.added[sourceRow] ?? 0;
  target.changed[targetRow] = source.changed[sourceRow] ?? 0;
  const block = Math.floor(targetRow / PROJECTION_BLOCK_SIZE);
  target.blocks[block] = Math.max(target.blocks[block] ?? 0, target.changed[targetRow] ?? 0);
}

export interface SparseTagSet {
  readonly component: Component;
  sparse: Int32Array;
  dense: Uint32Array;
  added: Float64Array;
  changed: Float64Array;
  size: number;
}

export function createSparseTagSet(component: Component): SparseTagSet {
  const sparse = new Int32Array(INITIAL_SPARSE_CAPACITY);
  sparse.fill(-1);
  return {
    component,
    sparse,
    dense: new Uint32Array(INITIAL_SPARSE_CAPACITY),
    added: new Float64Array(INITIAL_SPARSE_CAPACITY),
    changed: new Float64Array(INITIAL_SPARSE_CAPACITY),
    size: 0,
  };
}

export function sparseTagIndex(set: SparseTagSet, entity: EntityHandle): number {
  const denseIndex = set.sparse[entityIndex(entity)] ?? -1;
  return denseIndex >= 0 && set.dense[denseIndex] === (entity as number) ? denseIndex : -1;
}

export function sparseTagHas(set: SparseTagSet, entity: EntityHandle): boolean {
  return sparseTagIndex(set, entity) >= 0;
}

export function insertSparseTag(set: SparseTagSet, entity: EntityHandle, epoch: number): number {
  const present = sparseTagIndex(set, entity);
  if (present >= 0) {
    set.changed[present] = epoch;
    return present;
  }
  growSparseSlots(set, entityIndex(entity) + 1);
  if (set.size === set.dense.length) growSparseDense(set, set.size + 1);
  const denseIndex = set.size;
  set.dense[denseIndex] = entity as number;
  set.added[denseIndex] = epoch;
  set.changed[denseIndex] = epoch;
  set.sparse[entityIndex(entity)] = denseIndex;
  set.size += 1;
  return denseIndex;
}

export function removeSparseTag(set: SparseTagSet, entity: EntityHandle): boolean {
  const denseIndex = sparseTagIndex(set, entity);
  if (denseIndex < 0) return false;
  const lastIndex = set.size - 1;
  set.sparse[entityIndex(entity)] = -1;
  if (denseIndex !== lastIndex) {
    const movedEntity = set.dense[lastIndex] as EntityHandle;
    set.dense[denseIndex] = movedEntity as number;
    set.added[denseIndex] = set.added[lastIndex] ?? 0;
    set.changed[denseIndex] = set.changed[lastIndex] ?? 0;
    set.sparse[entityIndex(movedEntity)] = denseIndex;
  }
  set.size = lastIndex;
  return true;
}

function growSparseSlots(set: SparseTagSet, targetCapacity: number): void {
  if (targetCapacity <= set.sparse.length) return;
  let capacity = set.sparse.length;
  while (capacity < targetCapacity) capacity *= 2;
  const sparse = new Int32Array(capacity);
  sparse.fill(-1);
  sparse.set(set.sparse);
  set.sparse = sparse;
}

function growSparseDense(set: SparseTagSet, targetCapacity: number): void {
  let capacity = set.dense.length;
  while (capacity < targetCapacity) capacity *= 2;
  const dense = new Uint32Array(capacity);
  dense.set(set.dense);
  set.dense = dense;
  const added = new Float64Array(capacity);
  added.set(set.added);
  set.added = added;
  const changed = new Float64Array(capacity);
  changed.set(set.changed);
  set.changed = changed;
}

export interface ChangeTicks {
  added: number;
  changed: number;
}

interface EntityLocation {
  readonly archetypeId: number;
  readonly archetypeRow: number;
}

export function readComponentChange(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentId: number,
): ChangeTicks | undefined {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagIndex(sparseSet, entity);
    if (denseIndex < 0) return undefined;
    return {
      added: sparseSet.added[denseIndex] ?? 0,
      changed: sparseSet.changed[denseIndex] ?? 0,
    };
  }
  const archetype = graph.archetypes[location.archetypeId];
  if (archetype === undefined) return undefined;
  const epochs = graph.tables[archetype.tableId]?.storage.get(componentId)?.epochs;
  if (epochs === undefined) return undefined;
  const tableRow = archetype.rows[location.archetypeRow] ?? -1;
  return {
    added: epochs.added[tableRow] ?? 0,
    changed: epochs.changed[tableRow] ?? 0,
  };
}

export function markComponentsAdded(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentIds: readonly number[],
  epoch: number,
): void {
  const archetype = graph.archetypes[location.archetypeId];
  const table = archetype === undefined ? undefined : graph.tables[archetype.tableId];
  const tableRow = archetype?.rows[location.archetypeRow] ?? -1;
  for (const componentId of componentIds) {
    const component = archetype?.components.find(
      (candidate) => componentOwner.componentId(candidate) === componentId,
    );
    if (component?.storage === 'sparse') {
      insertSparseTag(getOrCreateSparseTagSet(graph, component), entity, epoch);
      continue;
    }
    const epochs = table?.storage.get(componentId)?.epochs;
    if (epochs === undefined) continue;
    epochs.added[tableRow] = epoch;
    publishComponentRange(epochs, tableRow, 1, epoch);
  }
}

export function markComponentChanged(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentId: number,
  epoch: () => number,
): void {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagIndex(sparseSet, entity);
    if (denseIndex >= 0) sparseSet.changed[denseIndex] = epoch();
    return;
  }
  const archetype = graph.archetypes[location.archetypeId];
  if (archetype === undefined) return;
  const epochs = graph.tables[archetype.tableId]?.storage.get(componentId)?.epochs;
  if (epochs === undefined) return;
  const tableRow = archetype.rows[location.archetypeRow] ?? -1;
  publishComponentRange(epochs, tableRow, 1, epoch());
}

/** Row evidence and its conservative block summary share the World epoch. */
export function publishComponentRange(
  columns: ComponentEpochColumns,
  start: number,
  count: number,
  epoch: number,
): void {
  if (count === 0) return;
  if (count === 1) {
    columns.changed[start] = epoch;
    columns.blocks[Math.floor(start / PROJECTION_BLOCK_SIZE)] = epoch;
    return;
  }
  columns.changed.fill(epoch, start, start + count);
  columns.blocks.fill(
    epoch,
    Math.floor(start / PROJECTION_BLOCK_SIZE),
    Math.ceil((start + count) / PROJECTION_BLOCK_SIZE),
  );
}

export function getOrCreateSparseTagSet(graph: ArchetypeGraph, component: Component): SparseTagSet {
  const current = graph.sparseTags.get(componentOwner.componentId(component));
  if (current !== undefined) return current;
  const set = createSparseTagSet(component);
  graph.sparseTags.set(componentOwner.componentId(component), set);
  return set;
}
