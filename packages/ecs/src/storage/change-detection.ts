// @forgeax/engine-ecs — per-entity and per-resource change ticks.

import type { Component } from '../component';
import * as componentOwner from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';

import { archetypeComponentIndex } from './archetype';
import type { ArchetypeGraph } from './archetype-graph';
import type { EntityRecords } from './entity-records';

export const PROJECTION_BLOCK_SIZE = 256;

const INITIAL_SPARSE_CAPACITY = 64;

export interface SparseTagSet {
  readonly component: Component;
  sparse: Int32Array;
  dense: Uint32Array;
  added: Float64Array;
  size: number;
}

function createSparseTagSet(component: Component): SparseTagSet {
  const sparse = new Int32Array(INITIAL_SPARSE_CAPACITY);
  sparse.fill(-1);
  return {
    component,
    sparse,
    dense: new Uint32Array(INITIAL_SPARSE_CAPACITY),
    added: new Float64Array(INITIAL_SPARSE_CAPACITY),
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

function insertSparseTag(set: SparseTagSet, entity: EntityHandle, epoch: number): number {
  const present = sparseTagIndex(set, entity);
  if (present >= 0) {
    return present;
  }
  growSparseSlots(set, entityIndex(entity) + 1);
  if (set.size === set.dense.length) growSparseDense(set, set.size + 1);
  const denseIndex = set.size;
  set.dense[denseIndex] = entity as number;
  set.added[denseIndex] = epoch;
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
}

export interface ChangeTicks {
  added: number;
  changed: number;
}

export function readComponentAdded(
  graph: ArchetypeGraph,
  records: EntityRecords,
  slot: number,
  entity: EntityHandle,
  componentId: number,
): number | undefined {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagIndex(sparseSet, entity);
    if (denseIndex < 0) return undefined;
    return sparseSet.added[denseIndex] ?? 0;
  }
  const archetype = graph.archetypes[records.archetypeId[slot] as number];
  if (archetype === undefined) return undefined;
  const added = graph.tables[archetype.tableId]?.storage.get(componentId)?.added;
  if (added === undefined) return undefined;
  const tableRow = archetype.rows[records.archetypeRow[slot] as number] ?? -1;
  return added[tableRow] ?? 0;
}

export function markComponentsAdded(
  graph: ArchetypeGraph,
  records: EntityRecords,
  slot: number,
  entity: EntityHandle,
  componentIds: ArrayLike<number>,
  epoch: number,
): void {
  const archetype = graph.archetypes[records.archetypeId[slot] as number];
  const table = archetype === undefined ? undefined : graph.tables[archetype.tableId];
  const tableRow = archetype?.rows[records.archetypeRow[slot] as number] ?? -1;
  for (let index = 0; index < componentIds.length; index++) {
    const componentId = componentIds[index] as number;
    const component =
      archetype === undefined
        ? undefined
        : archetype.components[archetypeComponentIndex(archetype, componentId)];
    if (component?.storage === 'sparse') {
      insertSparseTag(getOrCreateSparseTagSet(graph, component), entity, epoch);
      continue;
    }
    const added = table?.storage.get(componentId)?.added;
    if (added !== undefined) added[tableRow] = epoch;
  }
}

function getOrCreateSparseTagSet(graph: ArchetypeGraph, component: Component): SparseTagSet {
  const current = graph.sparseTags.get(componentOwner.componentId(component));
  if (current !== undefined) return current;
  const set = createSparseTagSet(component);
  graph.sparseTags.set(componentOwner.componentId(component), set);
  return set;
}
