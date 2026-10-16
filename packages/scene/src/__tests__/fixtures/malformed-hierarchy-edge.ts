import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { componentId } from '../../../../ecs/src/component';
import { entityIndex } from '../../../../ecs/src/entity-handle';
import { ChildOf } from '../../index';

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
  const internal = (world as unknown as WorldWithMalformedInjection)[WORLD_INTERNAL_KEY];
  if (internal === undefined) {
    throw new Error('Malformed hierarchy fixture requires the ECS test injection seam.');
  }
  return internal;
}

/**
 * Scene-owned malformed-edge fixture. Production relationship writes reject
 * stale targets and cycles before touching either side of the relationship.
 * This test-only fixture deliberately corrupts the source column through the
 * existing package-internal graph seam so projection can exercise its
 * fail-closed diagnostics without weakening the public write contract.
 */
export function setMalformedParentEdge(
  world: World,
  child: EntityHandle,
  parent: EntityHandle,
): void {
  const internal = malformedInjection(world);
  const record = internal.getRecords()[entityIndex(child)];
  if (record === undefined || record.archetypeId < 0) {
    throw new Error(`Malformed hierarchy fixture child ${child} is not live.`);
  }
  const graph = internal.getGraph();
  const archetype = graph.archetypes[record.archetypeId];
  if (archetype === undefined) throw new Error(`Missing archetype ${record.archetypeId}.`);
  const table = graph.tables[archetype.tableId];
  const column = table?.storage.get(componentId(ChildOf))?.fields.get('parent');
  const tableRow = archetype.rows[record.archetypeRow];
  if (column === undefined || tableRow === undefined) {
    throw new Error(`Malformed hierarchy fixture child ${child} lacks ChildOf storage.`);
  }
  column.view[tableRow] = parent as number;
  // Keep the corruption internal, but make the source mutation observable to
  // the normal change-token consumers so an already-built projection cannot
  // mask the deliberately malformed value.
  internal.markComponentChanged(child, componentId(ChildOf));
}
