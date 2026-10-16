import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { appendArchetypeRow, growArchetype, removeArchetypeRow } from '../storage/archetype';
import { createArchetypeGraph, getOrCreateArchetype } from '../storage/archetype-graph';
import { appendTableRow, growTable, removeTableRow } from '../storage/table';
import { World } from '../world';

describe('Table and Archetype ownership', () => {
  it('stores component columns only on Table and logical membership only on Archetype', () => {
    const Position = defineComponent('TableOwnerPosition', { x: 'f32' });
    const graph = createArchetypeGraph();
    const archetype = getOrCreateArchetype(graph, [componentId(Position)], [Position]);
    const table = graph.tables[archetype.tableId];
    if (table === undefined) throw new Error('table missing');

    expect(table.storage.has(componentId(Entity))).toBe(true);
    expect(table.storage.has(componentId(Position))).toBe(true);
    expect(archetype.rows).toBeInstanceOf(Uint32Array);
    expect('storage' in archetype).toBe(false);
  });

  it('grows logical and physical capacities independently', () => {
    const Position = defineComponent('IndependentCapacityPosition', { x: 'f32' });
    const graph = createArchetypeGraph();
    const archetype = getOrCreateArchetype(graph, [componentId(Position)], [Position]);
    const table = graph.tables[archetype.tableId];
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
    const archetype = getOrCreateArchetype(graph, [componentId(Position)], [Position]);
    const table = graph.tables[archetype.tableId];
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
});
