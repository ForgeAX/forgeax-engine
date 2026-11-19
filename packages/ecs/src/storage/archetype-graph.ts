// @forgeax/engine-ecs — ArchetypeGraph: manages archetype creation and edge caching.
//
// O(1) archetype migration lookup via cached edges (D-02 / Finding 2).
// Global `generation` counter incremented on each new archetype creation
// (ArchetypeGeneration for query cache incremental update).

import { type Component, type ComponentId, componentId } from '../component';
import { Entity } from '../entity';
import {
  type Archetype,
  type ArchetypeId,
  archetypeComponentIndex,
  createArchetype,
} from './archetype';
import type { SparseTagSet } from './change-detection';
import { createTable, type Table } from './table';

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
  tables: Table[];
  tableDedupByKey: Map<string, Table>;
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
    tables: [],
    tableDedupByKey: new Map(),
    sparseTags: new Map(),
    shared,
  };
}

function getOrCreateTable(
  graph: ArchetypeGraph,
  components: readonly Component[],
  archetypeKey: string,
): Table {
  let tableComponents = components;
  let key = archetypeKey;
  if (components.some((component) => component.storage === 'sparse')) {
    const dense = components.filter((component) => component.storage === 'table');
    // The physical Entity column is required even if a sparse token uses its id.
    if (components[0]?.storage === 'sparse') dense.unshift(Entity);
    tableComponents = dense;
    key = dense.map(componentId).join('+');
  }
  const existing = graph.tableDedupByKey.get(key);
  if (existing !== undefined) return existing;
  const table = createTable(tableComponents, key, graph.tables.length, graph.shared);
  graph.tables.push(table);
  graph.tableDedupByKey.set(key, table);
  return table;
}

/** Canonicalize logical membership once; the table uses its dense subsequence. */
export function getOrCreateArchetype(
  graph: ArchetypeGraph,
  components: readonly Component[],
): Archetype {
  const byId = new Map<ComponentId, Component>();
  byId.set(componentId(Entity), Entity);
  for (const component of components) byId.set(componentId(component), component);
  const ids = [...byId.keys()].sort((a, b) => a - b);
  const key = ids.join('+');
  const existingId = graph.dedupByKey.get(key);
  if (existingId !== undefined) {
    // biome-ignore lint/style/noNonNullAssertion: dedupByKey only ever holds ids that were pushed into archetypes[].
    return graph.archetypes[existingId]!;
  }

  const sorted = ids.map((id) => byId.get(id) as Component);
  const table = getOrCreateTable(graph, sorted, key);
  const archId = graph.archetypes.length;
  const arch = createArchetype(archId, table, key, sorted, ids);
  graph.archetypes.push(arch);
  graph.dedupByKey.set(key, archId);
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

  const target = getOrCreateArchetype(graph, [...src.components, component]);
  src.addEdges.set(componentId, target.id);
  return target;
}

/** Get and cache the target formed by removing one component from `src`. */
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

  const target = getOrCreateArchetype(
    graph,
    src.components.filter((_, index) => src.ids[index] !== componentId),
  );
  src.removeEdges.set(componentId, target.id);
  return target;
}

export function spawnRosterMatches(
  archetype: Archetype,
  componentDatas: readonly { readonly component: Component }[],
): boolean {
  const count = componentDatas.length;
  if (archetype.ids.length !== count + 1) return false;
  for (let index = 0; index < count; index++) {
    const component = (componentDatas[index] as { readonly component: Component }).component;
    if (
      archetype.components[archetypeComponentIndex(archetype, componentId(component))] !== component
    )
      return false;
    for (let other = 0; other < index; other++)
      if ((componentDatas[other] as { readonly component: Component }).component === component)
        return false;
  }
  return true;
}
