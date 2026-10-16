import type { EntityHandle, World, Component } from '@forgeax/engine-ecs';
import { componentId } from '@forgeax/engine-ecs/internal';

const WORLD_INTERNAL_KEY: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof WORLD_INTERNAL_KEY;

interface MalformedRecord {
  readonly archetypeId: number;
  readonly archetypeRow: number;
}

interface MalformedColumn {
  readonly view: { [index: number]: number };
}

interface MalformedComponentStorage {
  readonly fields: Map<string, MalformedColumn>;
}

interface MalformedTable {
  readonly storage: Map<number, MalformedComponentStorage>;
}

interface MalformedArchetype {
  readonly tableId: number;
  readonly rows: readonly number[];
}

interface MalformedGraph {
  readonly archetypes: readonly (MalformedArchetype | undefined)[];
  readonly tables: readonly (MalformedTable | undefined)[];
}

interface MalformedWorldInternal {
  readonly getRecords: () => readonly (MalformedRecord | undefined)[];
  readonly getGraph: () => MalformedGraph;
  readonly markComponentChanged: (entity: EntityHandle, componentId: number) => void;
}

interface WorldWithMalformedInjection {
  readonly [WORLD_INTERNAL_KEY]: MalformedWorldInternal;
}

function malformedInjection(world: World): MalformedWorldInternal {
  const candidate = (world as unknown as WorldWithMalformedInjection)[WORLD_INTERNAL_KEY];
  if (candidate === undefined) {
    throw new Error('Malformed hierarchy fixture requires the ECS test injection seam.');
  }
  return candidate;
}

/**
 * Test-owned malformed relationship fixture. Public World.set rejects stale
 * targets and cycles before mutation; the Dawn/Browser journeys still need a
 * controlled damaged source column to exercise Scene diagnostics and recovery.
 * Keep this seam private to the hello fixture and never expose it as a runtime
 * relationship editing API.
 */
export function setMalformedParentEdge(
  world: World,
  child: EntityHandle,
  parent: EntityHandle,
  childOf: Component,
): void {
  const internal = malformedInjection(world);
  const record = internal.getRecords()[(child as number) & 0x00ffffff];
  if (record === undefined || record.archetypeId < 0) {
    throw new Error(`Malformed hierarchy fixture child ${child} is not live.`);
  }
  const graph = internal.getGraph();
  const archetype = graph.archetypes[record.archetypeId];
  if (archetype === undefined) throw new Error(`Missing archetype ${record.archetypeId}.`);
  const table = graph.tables[archetype.tableId];
  const column = table?.storage.get(componentId(childOf))?.fields.get('parent');
  const tableRow = archetype.rows[record.archetypeRow];
  if (column === undefined || tableRow === undefined) {
    throw new Error(`Malformed hierarchy fixture child ${child} lacks ChildOf storage.`);
  }
  column.view[tableRow] = parent as number;
  // Invalidate existing Scene projections without routing malformed input
  // through the public relationship writer, which correctly rejects it.
  internal.markComponentChanged(child, componentId(childOf));
}
