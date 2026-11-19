import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { Entity } from '../entity';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { appendArchetypeRow, growArchetype, removeArchetypeRow } from '../storage/archetype';
import { createArchetypeGraph, getOrCreateArchetype } from '../storage/archetype-graph';
import { appendTableRow, growTable, removeTableRow } from '../storage/table';
import { World } from '../world';
import { worldInternal } from '../world-internal';

describe('table-archetype-mapping', () => {
  describe('Table and Archetype ownership', () => {
    it('stores component columns only on Table and logical membership only on Archetype', () => {
      const Position = defineComponent('TableOwnerPosition', { x: 'f32' });
      const graph = createArchetypeGraph();
      const archetype = getOrCreateArchetype(graph, [Position]);
      const table = archetype.table;
      if (table === undefined) throw new Error('table missing');

      expect(table.storage.has(componentId(Entity))).toBe(true);
      expect(table.storage.has(componentId(Position))).toBe(true);
      expect(archetype.rows).toBeInstanceOf(Uint32Array);
      expect('storage' in archetype).toBe(false);
    });

    it('grows logical and physical capacities independently', () => {
      const Position = defineComponent('IndependentCapacityPosition', { x: 'f32' });
      const graph = createArchetypeGraph();
      const archetype = getOrCreateArchetype(graph, [Position]);
      const table = archetype.table;
      if (table === undefined) throw new Error('table missing');
      const archetypeCapacity = archetype.capacity;
      const tableCapacity = table.capacity;

      growArchetype(archetype, archetypeCapacity * 2);
      expect(archetype.capacity).toBe(archetypeCapacity * 2);
      expect(table.capacity).toBe(tableCapacity);

      growTable(table, tableCapacity * 2);
      expect(table.capacity).toBe(tableCapacity * 2);
      expect(archetype.capacity).toBe(archetypeCapacity * 2);
    });

    it('keeps archetypeRow to tableRow explicit across independent swap-pop', () => {
      const Position = defineComponent('SwapMappingPosition', { x: 'f32' });
      const graph = createArchetypeGraph();
      const archetype = getOrCreateArchetype(graph, [Position]);
      const table = archetype.table;
      if (table === undefined) throw new Error('table missing');
      const first = 0x01000001 as EntityHandle;
      const second = 0x02000002 as EntityHandle;
      const firstTableRow = appendTableRow(table, first);
      const secondTableRow = appendTableRow(table, second);
      appendArchetypeRow(archetype, firstTableRow);
      appendArchetypeRow(archetype, secondTableRow);

      expect(removeArchetypeRow(archetype, 0)).toEqual({ movedTableRow: 1, newRow: 0 });
      expect(archetype.rows[0]).toBe(1);
      expect(removeTableRow(table, 0)).toEqual({ movedEntity: second, newRow: 0 });
      expect(table.storage.get(componentId(Entity))?.fields.get('self')?.view[0]).toBe(second);
    });

    it('world migration and despawn maintain both mapping layers', () => {
      const Position = defineComponent('WorldMappingPosition', { x: 'f32' });
      const Selected = defineComponent('WorldMappingSelected', {});
      const world = new World();
      const first = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
      const second = world.spawn({ component: Position, data: { x: 2 } }).unwrap();

      world.addComponent(first, { component: Selected, data: {} }).unwrap();
      expect(world.get(first, Position).unwrap().x).toBe(1);
      expect(world.get(second, Position).unwrap().x).toBe(2);

      world.despawn(first).unwrap();
      expect(world.get(second, Entity).unwrap().self).toBe(second);
      expect([...world.query({ read: [Position] }).unwrap()].map((row) => row.entity)).toEqual([
        second,
      ]);
    });
    it('repairs both indexes through interleaved sparse, dense and despawn transitions', () => {
      const Value = defineComponent('MixedMappingValue', { x: 'f32' });
      const Dense = defineComponent('MixedMappingDense', { y: 'f32' });
      const Sparse = defineComponent('MixedMappingSparse', {}, { storage: 'sparse' });
      const world = new World();
      const entities = Array.from({ length: 12 }, (_, x) =>
        world.spawn({ component: Value, data: { x } }).unwrap(),
      );
      const alive = new Map(entities.map((entity, x) => [entity, x]));
      for (const [x, entity] of entities.entries()) {
        if (x % 2) world.addComponent(entity, { component: Sparse, data: {} }).unwrap();
      }
      const check = () => {
        const seen = new Map<EntityHandle, number>();
        for (const row of world.query({ read: [Value, Entity] }).unwrap()) {
          expect(row.get(Entity).self).toBe(row.entity);
          seen.set(row.entity, row.get(Value).x);
        }
        expect(seen).toEqual(alive);
        for (const [entity, x] of alive) expect(world.get(entity, Value).unwrap().x).toBe(x);
      };
      for (const [x, entity] of entities.entries()) {
        world.addComponent(entity, { component: Dense, data: { y: x + 100 } }).unwrap();
        check();
        if (x % 2) world.removeComponent(entity, Sparse).unwrap();
        else world.addComponent(entity, { component: Sparse, data: {} }).unwrap();
        check();
        expect(world.get(entity, Dense).unwrap().y).toBe(x + 100);
        world.removeComponent(entity, Dense).unwrap();
        check();
        world.despawn(entity).unwrap();
        alive.delete(entity);
        check();
      }
    });
  });
});

describe('entity-records-location', () => {
  const A = defineComponent('RecordLocationA', { value: 'f32' });
  const B = defineComponent('RecordLocationB', { value: 'f32' });
  const Tag = defineComponent('RecordLocationTag', {}, { storage: 'sparse' });

  function expectLocations(world: World, live: readonly EntityHandle[]): void {
    const internal = world[worldInternal];
    const records = internal.records;
    const graph = internal.graph;
    for (const entity of live) {
      const slot = entityIndex(entity);
      const archetype = graph.archetypes[records.archetypeId[slot] as number];
      expect(archetype).toBeDefined();
      if (archetype === undefined) continue;
      const row = archetype.rows[records.archetypeRow[slot] as number];
      expect(graph.tables[archetype.table.id]).toBe(archetype.table);
      expect(records.tableRow[slot]).toBe(row);
      expect(archetype.table?.entities.view[row as number]).toBe(entity);
    }
  }

  describe('entity record table location', () => {
    it('stores one generation and three location words per reserved slot', () => {
      const world = new World();
      for (let value = 0; value < 70; value++) {
        world.spawn({ component: A, data: { value } }).unwrap();
      }
      const { generation } = world[worldInternal].records;
      expect(generation.length).toBeGreaterThanOrEqual(70);
      expect(world.memoryStats().entityRecordBytes).toBe(generation.length * 14);
    });

    it('locates table rows through spawn, migration, tag moves and despawn', () => {
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
          const records = world[worldInternal].records;
          expect(records.archetypeId[slot]).toBe(-1);
          expect(records.tableRow[slot]).toBe(-1);
        } else {
          expect(world.get(entity, A).unwrap().value).toBeTypeOf('number');
        }
        expectLocations(world, live);
      }
    });
  });
});
