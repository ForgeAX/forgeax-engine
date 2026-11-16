import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { entityIndex } from '../entity-handle';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const A = defineComponent('RecordLocationA', { value: 'f32' });
const B = defineComponent('RecordLocationB', { value: 'f32' });
const Tag = defineComponent('RecordLocationTag', {}, { storage: 'sparse' });

function expectLocations(world: World, live: readonly EntityHandle[]): void {
  const internal = world[worldInternal];
  const records = internal.getRecords();
  const graph = internal.getGraph();
  for (const entity of live) {
    const slot = entityIndex(entity);
    const archetype = graph.archetypes[records.archetypeId[slot] as number];
    expect(archetype).toBeDefined();
    if (archetype === undefined) continue;
    const row = archetype.rows[records.archetypeRow[slot] as number];
    expect(records.tableId[slot]).toBe(archetype.tableId);
    expect(records.tableRow[slot]).toBe(row);
    expect(graph.tables[archetype.tableId]?.entities.view[row as number]).toBe(entity);
  }
}

describe('entity record table location', () => {
  it('tracks table id and row through spawn, migration, tag moves and despawn', () => {
    const world = new World();
    const live: EntityHandle[] = [];
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    for (let step = 0; step < 400; step++) {
      const op = live.length === 0 ? 0 : next(5);
      if (op === 0) {
        live.push(world.spawn({ component: A, data: { value: step } }).unwrap());
        continue;
      }
      const index = next(live.length);
      const entity = live[index] as EntityHandle;
      if (op === 1) {
        if (world.hasComponent(entity, B)) world.removeComponent(entity, B).unwrap();
        else world.addComponent(entity, { component: B, data: { value: step } }).unwrap();
      } else if (op === 2) {
        if (world.hasComponent(entity, Tag)) world.removeComponent(entity, Tag).unwrap();
        else world.addComponent(entity, { component: Tag, data: {} }).unwrap();
      } else if (op === 3) {
        world.despawn(entity).unwrap();
        live.splice(index, 1);
        const slot = entityIndex(entity);
        const records = world[worldInternal].getRecords();
        expect(records.tableId[slot]).toBe(-1);
        expect(records.tableRow[slot]).toBe(-1);
      } else {
        expect(world.get(entity, A).unwrap().value).toBeTypeOf('number');
      }
      expectLocations(world, live);
    }
  });
});
