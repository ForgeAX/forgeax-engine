import { componentId } from '@forgeax/engine-ecs/internal';

const WORLD_INTERNAL_KEY = Symbol.for('forgeax.ecs.worldInternal');

// Dawn-only test fixture: public relationship writes reject malformed edges;
// this private column seam supplies the controlled damage required by the
// same-process Scene recovery journey.
export function setMalformedParentEdge(world, child, parent, childOf) {
  // This fixture is the only app-side consumer of the controlled corruption
  // hook. It is deliberately test-only and does not import ECS source or
  // expose raw storage through the SDK surface.
  const internal = world[WORLD_INTERNAL_KEY];
  if (internal === undefined) {
    throw new Error('Malformed hierarchy fixture requires the ECS test injection seam.');
  }
  const record = internal.getRecords()[child & 0x00ffffff];
  if (record === undefined || record.archetypeId < 0) {
    throw new Error(`Malformed hierarchy fixture child ${child} is not live.`);
  }
  const graph = internal.getGraph();
  const archetype = graph.archetypes[record.archetypeId];
  const table = archetype === undefined ? undefined : graph.tables[archetype.tableId];
  const column = table?.storage.get(componentId(childOf))?.fields.get('parent');
  const tableRow = archetype?.rows[record.archetypeRow];
  if (column === undefined || tableRow === undefined) {
    throw new Error(`Malformed hierarchy fixture child ${child} lacks ChildOf storage.`);
  }
  column.view[tableRow] = parent;
  // Keep the corruption private while making the source change visible to an
  // already-created projection cache.
  internal.markComponentChanged(child, componentId(childOf));
}
