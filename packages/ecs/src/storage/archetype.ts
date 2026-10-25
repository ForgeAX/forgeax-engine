import type { Component, ComponentId } from '../component';
import { componentId } from '../component';
import { foldEssentials } from '../entity';
import type { TableId } from './table';

const INITIAL_CAPACITY = 64;

export type ArchetypeId = number;

export interface Archetype {
  readonly id: ArchetypeId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  /** Sorted ids parallel to `components`; membership never re-derives identity. */
  readonly ids: Int32Array;
  readonly tableId: TableId;
  rows: Uint32Array;
  size: number;
  capacity: number;
  addEdges: Map<ComponentId, ArchetypeId>;
  removeEdges: Map<ComponentId, ArchetypeId>;
}

export function archetypeKey(componentIds: ReadonlyArray<ComponentId>): string {
  return [...foldEssentials(componentIds)].sort((a, b) => a - b).join('+');
}

export function createArchetype(
  components: ReadonlyArray<Component>,
  id: ArchetypeId,
  tableId: TableId,
): Archetype {
  const byId = new Map<ComponentId, Component>();
  for (const component of components) byId.set(componentId(component), component);
  const sorted = [...byId.values()].sort((a, b) => componentId(a) - componentId(b));
  return {
    id,
    key: archetypeKey(sorted.map((component) => componentId(component))),
    components: sorted,
    ids: Int32Array.from(sorted, (component) => componentId(component)),
    tableId,
    rows: new Uint32Array(INITIAL_CAPACITY),
    size: 0,
    capacity: INITIAL_CAPACITY,
    addEdges: new Map(),
    removeEdges: new Map(),
  };
}

/** Index of `id` in the owner's sorted roster, or -1. */
export function archetypeComponentIndex(archetype: Archetype, id: ComponentId): number {
  const ids = archetype.ids;
  let lo = 0,
    hi = ids.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    const candidateId = ids[middle] as number;
    if (candidateId === id) return middle;
    if (candidateId < id) lo = middle + 1;
    else hi = middle;
  }
  return -1;
}

/** Membership derives from the owner's already sorted component roster. */
export function archetypeHasComponent(archetype: Archetype, id: ComponentId): boolean {
  return archetypeComponentIndex(archetype, id) >= 0;
}

export function appendArchetypeRow(archetype: Archetype, tableRow: number): number {
  if (archetype.size === archetype.capacity) growArchetype(archetype, archetype.capacity * 2);
  const row = archetype.size;
  archetype.rows[row] = tableRow;
  archetype.size = row + 1;
  return row;
}

export function removeArchetypeRow(
  archetype: Archetype,
  row: number,
): { movedTableRow: number; newRow: number } | null {
  const lastRow = archetype.size - 1;
  if (row === lastRow) {
    archetype.size = lastRow;
    return null;
  }
  const movedTableRow = archetype.rows[lastRow] ?? 0;
  archetype.rows[row] = movedTableRow;
  archetype.size = lastRow;
  return { movedTableRow, newRow: row };
}

export function growArchetype(archetype: Archetype, targetCapacity: number): void {
  let capacity = archetype.capacity;
  while (capacity < targetCapacity) capacity *= 2;
  if (capacity === archetype.capacity) return;
  const rows = new Uint32Array(capacity);
  rows.set(archetype.rows);
  archetype.rows = rows;
  archetype.capacity = capacity;
}
