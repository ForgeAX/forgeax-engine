// @forgeax/engine-ecs — ArchetypeGraph: manages archetype creation and edge caching.
//
// O(1) archetype migration lookup via cached edges (D-02 / Finding 2).
// Global `generation` counter incremented on each new archetype creation
// (ArchetypeGeneration for query cache incremental update).

import type { Component, ComponentId } from '../component';
import * as componentOwner from '../component';
import { type Archetype, type ArchetypeId, archetypeKey, createArchetype } from './archetype';
import type { SparseTagSet } from './change-detection';
import { canonicalComponents, createTable, type Table, type TableId, tableKey } from './table';

/**
 * The ArchetypeGraph owns all archetypes and their edge caches.
 *
 * `archetypes` is the SSOT: a dense array indexed by `ArchetypeId` (the id is
 * allocated as the next array slot, so `archetypes[id].id === id`).
 * `dedupByKey` is a derived index `key → ArchetypeId` used only at archetype
 * creation to dedupe; consumers always read through `archetypes[id]`
 * (architecture-principles.md §1 SSOT, §2 Derive — replaces the historical
 * `byKey: Map<string, Archetype>` / `byId: Archetype[]` pair which carried two
 * full Archetype refs per row).
 */
export interface ArchetypeGraph {
  /** SSOT: dense array indexed by `ArchetypeId` (id == array slot). */
  archetypes: Archetype[];
  /** Derived dedup index: canonical-key string → ArchetypeId. */
  dedupByKey: Map<string, ArchetypeId>;
  /** Global generation counter. Incremented on each new archetype. */
  generation: number;
  tables: Table[];
  activeTables: Set<Table>;
  activeTablesByComponent: Map<ComponentId, Set<Table>>;
  tableDedupByKey: Map<string, TableId>;
  tableGeneration: number;
  sparseTags: Map<ComponentId, SparseTagSet>;
  readonly shared: boolean;
}

/**
 * Create a fresh ArchetypeGraph.
 */
export function createArchetypeGraph(shared = false): ArchetypeGraph {
  return {
    archetypes: [],
    dedupByKey: new Map(),
    generation: 0,
    tables: [],
    activeTables: new Set(),
    activeTablesByComponent: new Map(),
    tableDedupByKey: new Map(),
    tableGeneration: 0,
    sparseTags: new Map(),
    shared,
  };
}

export function getTable(graph: ArchetypeGraph, id: TableId): Table {
  const table = graph.tables[id];
  if (table === undefined) throw new Error(`Table ${id} does not exist.`);
  return table;
}

export function getOrCreateTable(
  graph: ArchetypeGraph,
  components: ReadonlyArray<Component>,
): Table {
  const tableComponents = canonicalComponents(
    components.filter((component) => component.storage === 'table'),
  );
  const key = tableKey(tableComponents.map((component) => componentOwner.componentId(component)));
  const existingId = graph.tableDedupByKey.get(key);
  if (existingId !== undefined) return getTable(graph, existingId);
  const directories = [graph.activeTables];
  for (const component of tableComponents) {
    const id = componentOwner.componentId(component);
    let directory = graph.activeTablesByComponent.get(id);
    if (directory === undefined) {
      directory = new Set();
      graph.activeTablesByComponent.set(id, directory);
    }
    directories.push(directory);
  }
  const table = createTable(tableComponents, graph.tables.length, graph.shared, directories);
  graph.tables.push(table);
  graph.tableDedupByKey.set(key, table.id);
  graph.tableGeneration += 1;
  return table;
}

/**
 * Get or create an archetype for the given component set.
 * ComponentIds are sorted to produce a canonical key.
 */
export function getOrCreateArchetype(
  graph: ArchetypeGraph,
  componentIds: ReadonlyArray<ComponentId>,
  components: ReadonlyArray<Component>,
): Archetype {
  const key = archetypeKey(componentIds);
  const existingId = graph.dedupByKey.get(key);
  if (existingId !== undefined) {
    // biome-ignore lint/style/noNonNullAssertion: dedupByKey only ever holds ids that were pushed into archetypes[].
    return graph.archetypes[existingId]!;
  }

  const fullComponents = canonicalComponents(components);
  const table = getOrCreateTable(graph, fullComponents);
  const archId = graph.archetypes.length;
  const arch = createArchetype(fullComponents, archId, table.id);
  graph.archetypes.push(arch);
  graph.dedupByKey.set(key, archId);
  graph.generation += 1;
  return arch;
}

/**
 * Get the target archetype after adding `componentId` to `src`.
 * Caches the edge for O(1) subsequent lookups.
 */
export function getAddEdge(
  graph: ArchetypeGraph,
  src: Archetype,
  componentId: ComponentId,
  component: Component,
): Archetype {
  const cached = src.addEdges.get(componentId);
  if (cached !== undefined) {
    const target = graph.archetypes[cached];
    if (target) {
      return target;
    }
  }

  // Compute target archetype: src components + new component.
  const newIds = [...src.components.map((c) => componentOwner.componentId(c)), componentId];
  const newComponents = [...src.components, component];
  const target = getOrCreateArchetype(graph, newIds, newComponents);
  src.addEdges.set(componentId, target.id);
  return target;
}

/**
 * Get the target archetype after removing `componentId` from `src`.
 * Caches the edge for O(1) subsequent lookups.
 *
 * Component list is derived from `src.components.filter(c => componentOwner.componentId(c) !== componentId)`
 * (no separate componentRegistry — feat-20260611 AC-09).
 */
export function getRemoveEdge(
  graph: ArchetypeGraph,
  src: Archetype,
  componentId: ComponentId,
): Archetype {
  const cached = src.removeEdges.get(componentId);
  if (cached !== undefined) {
    const target = graph.archetypes[cached];
    if (target) {
      return target;
    }
  }

  // Compute target archetype: src components minus removed component.
  // Derive componentIds from src.components (single-field Archetype).
  const newIds = src.components
    .map((c) => componentOwner.componentId(c))
    .filter((id) => id !== componentId);
  const newComponents = src.components.filter((c) => componentOwner.componentId(c) !== componentId);
  const target = getOrCreateArchetype(graph, newIds, newComponents);
  src.removeEdges.set(componentId, target.id);
  return target;
}
