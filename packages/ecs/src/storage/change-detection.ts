// @forgeax/engine-ecs — per-entity and per-resource change ticks.

import type { Component } from '../component';
import * as componentOwner from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';

import { archetypeComponentIndex } from './archetype';
import type { ArchetypeGraph } from './archetype-graph';
import {
  type ChangeColumn,
  createChangeColumn,
  growChangeColumn,
  moveChange,
  stampChange,
} from './change-column';
import type { EntityRecords } from './entity-records';

const INITIAL_SPARSE_CAPACITY = 64;

export interface SparseTagSet {
  readonly component: Component;
  sparse: Int32Array;
  dense: Uint32Array;
  added: Float64Array;
  /** Last write per dense index; a tag's presence write moves it like `added`. */
  changed: ChangeColumn;
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
    changed: createChangeColumn(INITIAL_SPARSE_CAPACITY),
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
    moveChange(set.changed, denseIndex, lastIndex);
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
  set.changed = growChangeColumn(set.changed, capacity);
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
  const added = archetype.table.storage.get(componentId)?.added;
  if (added === undefined) return undefined;
  return added[records.tableRow[slot] ?? -1] ?? 0;
}

/**
 * Changed epoch from the table column of a dense component, or undefined for a
 * sparse component or a slot without a table row.
 */
/** Sparse tag dense index of a live slot, or -1 when the tag is absent. */
function sparseTagSlotIndex(set: SparseTagSet, slot: number): number {
  const denseIndex = set.sparse[slot] ?? -1;
  return denseIndex >= 0 && entityIndex(set.dense[denseIndex] as EntityHandle) === slot
    ? denseIndex
    : -1;
}

/**
 * Last write epoch of a live slot's component: its table row for a dense
 * component, its tag entry for a sparse one; undefined when neither holds it.
 */
export function readComponentChanged(
  graph: ArchetypeGraph,
  records: EntityRecords,
  slot: number,
  componentId: number,
): number | undefined {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagSlotIndex(sparseSet, slot);
    return denseIndex < 0 ? undefined : (sparseSet.changed.epochs[denseIndex] ?? 0);
  }
  const archetype = graph.archetypes[records.archetypeId[slot] as number];
  if (archetype === undefined) return undefined;
  const changed = archetype.table.storage.get(componentId)?.changed;
  if (changed === undefined) return undefined;
  return changed.epochs[records.tableRow[slot] ?? -1] ?? 0;
}

/** Stamp a live slot's component write epoch in its table row or tag entry. */
export function writeComponentChanged(
  graph: ArchetypeGraph,
  records: EntityRecords,
  slot: number,
  componentId: number,
  epoch: number,
): void {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagSlotIndex(sparseSet, slot);
    if (denseIndex >= 0) stampChange(sparseSet.changed, denseIndex, epoch);
    return;
  }
  const archetype = graph.archetypes[records.archetypeId[slot] as number];
  if (archetype === undefined) return;
  const changed = archetype.table.storage.get(componentId)?.changed;
  if (changed === undefined) return;
  const row = records.tableRow[slot] ?? -1;
  if (row >= 0) stampChange(changed, row, epoch);
}

export function markComponentsAdded(
  graph: ArchetypeGraph,
  records: EntityRecords,
  slot: number,
  entity: EntityHandle,
  componentIds: ArrayLike<number>,
  componentMutationEpochs: number[],
  epoch: number,
): void {
  const archetype = graph.archetypes[records.archetypeId[slot] as number];
  if (archetype === undefined) return;
  const tableRow = records.tableRow[slot] as number;
  for (let index = 0; index < componentIds.length; index++) {
    const id = componentIds[index] as number;
    const storage = archetype.table.storage.get(id);
    if (storage !== undefined) {
      storage.added[tableRow] = epoch;
      stampChange(storage.changed, tableRow, epoch);
    } else {
      const component = archetype.components[archetypeComponentIndex(archetype, id)];
      if (component?.storage === 'sparse') {
        const set = getOrCreateSparseTagSet(graph, component);
        stampChange(set.changed, insertSparseTag(set, entity, epoch), epoch);
      }
    }
    componentMutationEpochs[id] = epoch;
  }
}

function getOrCreateSparseTagSet(graph: ArchetypeGraph, component: Component): SparseTagSet {
  const current = graph.sparseTags.get(componentOwner.componentId(component));
  if (current !== undefined) return current;
  const set = createSparseTagSet(component);
  graph.sparseTags.set(componentOwner.componentId(component), set);
  return set;
}
