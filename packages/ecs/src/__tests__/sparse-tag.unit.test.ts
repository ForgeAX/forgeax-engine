import { describe, expect, it } from 'vitest';
import type { Component } from '../component';
import { componentId, defineComponent } from '../component';
import { Disabled, Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { SparseStorageRequiresTagError } from '../errors';
import { Update } from '../schedule-token';
import { sparseTagHas } from '../storage/change-detection';
import { World } from '../world';

import { worldInternal } from '../world-internal';

describe('sparse tag storage', () => {
  it('defaults components to table and rejects sparse components with fields', () => {
    const TableTag = defineComponent('DefaultTableTag', {});
    expect(TableTag.storage).toBe('table');
    expect(Disabled.storage).toBe('table');
    expect(() =>
      defineComponent('InvalidSparseData', { value: 'f32' }, { storage: 'sparse' }),
    ).toThrow(SparseStorageRequiresTagError);
  });

  it('shares one Table across Archetypes that differ only by sparse membership', () => {
    const Position = defineComponent('SharedTablePosition', { x: 'f32' });
    const Selected = defineComponent('SharedTableSelected', {}, { storage: 'sparse' });
    const world = new World();
    const plain = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const selected = world
      .spawn({ component: Position, data: { x: 2 } }, { component: Selected, data: {} })
      .unwrap();
    const graph = world[worldInternal].getGraph();
    const plainArchetype = world[worldInternal].getEntityArchetype(plain);
    const selectedArchetype = world[worldInternal].getEntityArchetype(selected);

    expect(plainArchetype).not.toBe(selectedArchetype);
    expect(plainArchetype?.tableId).toBe(selectedArchetype?.tableId);
    expect(graph.tables).toHaveLength(1);
    expect(graph.tables[0]?.components.map((component: Component) => component.name)).toEqual([
      'Entity',
      'SharedTablePosition',
    ]);
  });

  it('flips sparse membership without changing any Table state', () => {
    const Wide = defineComponent('SparseFlipWide', {
      a: 'f32',
      b: 'f32',
      c: 'f32',
      d: 'f32',
    });
    const Selected = defineComponent('SparseFlipSelected', {}, { storage: 'sparse' });
    const world = new World();
    const entity = world.spawn({ component: Wide, data: { a: 1, b: 2, c: 3, d: 4 } }).unwrap();
    const graph = world[worldInternal].getGraph();
    const sourceArchetype = world[worldInternal].getEntityArchetype(entity);
    if (sourceArchetype === undefined) throw new Error('source archetype missing');
    const table = graph.tables[sourceArchetype.tableId];
    if (table === undefined) throw new Error('table missing');
    const tableRow = sourceArchetype.rows[0] ?? -1;
    const before = {
      size: table.size,
      capacity: table.capacity,
      version: table.version,
      fields: [...table.storage.values()].flatMap(({ fields }) =>
        [...fields.values()].map((column) => ({
          buffer: column.view.buffer,
          bytes: new Uint8Array(column.view.buffer).slice(),
        })),
      ),
      epochs: [...table.storage.values()].map(({ epochs }) => ({
        added: epochs.added.slice(),
        changed: epochs.changed.slice(),
      })),
    };

    world.addComponent(entity, { component: Selected, data: {} }).unwrap();
    const selectedArchetype = world[worldInternal].getEntityArchetype(entity);
    expect(selectedArchetype?.tableId).toBe(table.id);
    expect(selectedArchetype?.rows[0]).toBe(tableRow);
    expect(table.size).toBe(before.size);
    expect(table.capacity).toBe(before.capacity);
    expect(table.version).toBe(before.version);
    for (const [index, column] of before.fields.entries()) {
      const current = [...table.storage.values()].flatMap(({ fields }) => [...fields.values()])[
        index
      ];
      expect(current?.view.buffer).toBe(column.buffer);
      expect(new Uint8Array(current?.view.buffer ?? new ArrayBuffer(0))).toEqual(column.bytes);
    }
    expect(
      [...table.storage.values()].map(({ epochs }) => ({
        added: epochs.added,
        changed: epochs.changed,
      })),
    ).toEqual(before.epochs);

    world.removeComponent(entity, Selected).unwrap();
    expect(world[worldInternal].getEntityArchetype(entity)?.tableId).toBe(table.id);
    expect(table.size).toBe(before.size);
    expect(table.version).toBe(before.version);
  });

  it('deduplicates dense table queries and routes sparse predicates through Archetypes', () => {
    const Position = defineComponent('SparseQueryPosition', { x: 'f32' });
    const Selected = defineComponent('SparseQuerySelected', {}, { storage: 'sparse' });
    const world = new World();
    const first = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const second = world
      .spawn({ component: Position, data: { x: 2 } }, { component: Selected, data: {} })
      .unwrap();

    expect(Array.from(world.query({ read: [Position] }).unwrap(), (row) => row.entity)).toEqual([
      first,
      second,
    ]);
    const spans = [
      ...world
        .query({ read: [Position] })
        .unwrap()
        .spans()
        .unwrap(),
    ];
    expect(spans).toHaveLength(1);
    expect(spans[0]?.length).toBe(2);
    expect([...world.query({ with: [Selected] }).unwrap()].map((row) => row.entity)).toEqual([
      second,
    ]);
    expect([...world.query({ without: [Selected] }).unwrap()].map((row) => row.entity)).toEqual([
      first,
    ]);
    const sparseSpan = world
      .query({ with: [Selected] })
      .unwrap()
      .spans();
    expect(sparseSpan.ok).toBe(false);
    if (!sparseSpan.ok) expect(sparseSpan.error.detail.reason).toBe('sparse-component');
  });

  it('keeps sparse Added and Changed evidence generation-safe', () => {
    const Selected = defineComponent('SparseEpochSelected', {}, { storage: 'sparse' });
    const world = new World();
    const added = world.query({ added: [Selected] }).unwrap();
    const changed = world.query({ changed: [Selected] }).unwrap();
    const first = world.spawn({ component: Selected, data: {} }).unwrap();
    expect([...added].map((row) => row.entity)).toEqual([first]);
    expect([...changed].map((row) => row.entity)).toEqual([first]);

    world.set(first, Selected, {}).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([first]);
    world.despawn(first).unwrap();
    const replacement = world.spawn().unwrap();
    expect(replacement as number).not.toBe(first as number);
    const set = world[worldInternal].getGraph().sparseTags.get(componentId(Selected));
    expect(set === undefined ? false : sparseTagHas(set, replacement)).toBe(false);
    expect([...world.query({ with: [Selected] }).unwrap()]).toEqual([]);
  });

  it('routes deferred sparse spawn, add, and remove through the same storage boundary', () => {
    const Selected = defineComponent('DeferredSparseSelected', {}, { storage: 'sparse' });
    const world = new World();
    const existing = world.spawn().unwrap();
    let observed: EntityHandle[] = [];

    world.addSystem(Update, {
      name: 'deferred-sparse-producer',
      queries: [],
      before: ['deferred-sparse-consumer'],
      fn: (_world, _queries, commands) => {
        commands.spawn({ component: Selected, data: {} });
        commands.addComponent(existing, { component: Selected, data: {} });
      },
    });
    world.addSystem(Update, {
      name: 'deferred-sparse-consumer',
      queries: [{ with: [Selected] }],
      fn: (_world, [selected], commands) => {
        observed = Array.from(selected ?? [], (row) => row.entity);
        commands.removeComponent(existing, Selected);
      },
    });

    expect(world.update(0).ok).toBe(true);
    expect(observed).toHaveLength(2);
    expect(world.get(existing, Selected).ok).toBe(false);
    expect([...world.query({ with: [Selected] }).unwrap()]).toHaveLength(1);
  });

  it('reports sparse logical identity without pretending it is Table storage', () => {
    const Selected = defineComponent('SparseInspectSelected', {}, { storage: 'sparse' });
    const world = new World();
    const entity = world.spawn({ component: Selected, data: {} }).unwrap();
    const inspection = world.inspect();
    const archetype = inspection.archetypes.find((item) => item.entityCount === 1);
    const table = inspection.tables[archetype?.tableId ?? -1];

    expect(world.get(entity, Entity).unwrap().self).toBe(entity);
    expect(archetype?.componentNames).toContain('SparseInspectSelected');
    expect(table?.componentNames).not.toContain('SparseInspectSelected');
    expect(inspection.activeComponents).toContain('SparseInspectSelected');
  });
});
