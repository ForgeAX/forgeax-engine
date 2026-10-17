import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { componentId, defineComponent } from '../component';
import { Disabled } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  QueryDataRequiresFieldsError,
  QueryDescriptorConflictError,
  QueryIterationActiveError,
  QueryIterationInvalidatedError,
} from '../errors';
import type { QueryRow } from '../query/query';
import type { Table } from '../storage/table';
import { World } from '../world';

import { worldInternal } from '../world-internal';

const Position = defineComponent('QueryPosition', { x: 'f32', y: 'f32' });
const Velocity = defineComponent('QueryVelocity', { x: 'f32', y: 'f32' });
const Selected = defineComponent('QuerySelected', {});

function createWorld(): { world: World; first: EntityHandle; second: EntityHandle } {
  const world = new World();
  const first = world
    .spawn(
      { component: Position, data: { x: 1, y: 2 } },
      { component: Velocity, data: { x: 3, y: 4 } },
      { component: Selected, data: {} },
    )
    .unwrap();
  const second = world.spawn({ component: Position, data: { x: 5, y: 6 } }).unwrap();
  return { world, first, second };
}

describe('executable Query', () => {
  it('validates access roles and tag data at creation', () => {
    const world = new World();
    const conflict = world.query({ read: [Position], write: [Position] });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error).toBeInstanceOf(QueryDescriptorConflictError);
      expect(conflict.error.detail).toEqual({
        componentName: Position.name,
        roles: ['read', 'write'],
      });
    }

    const tagData = world.query({ read: [Selected] });
    expect(tagData.ok).toBe(false);
    if (!tagData.ok) expect(tagData.error).toBeInstanceOf(QueryDataRequiresFieldsError);
  });

  it('reports all duplicate roles for the first conflicting component before tag errors', () => {
    const world = new World();
    const result = world.query({
      read: [Selected, Position, Velocity, Velocity],
      write: [Position],
      optional: [Position],
      with: [Position],
      without: [Position],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(QueryDescriptorConflictError);
      expect(result.error.detail).toEqual({
        componentName: Position.name,
        roles: ['read', 'write', 'optional', 'with', 'without'],
      });
    }
    const repeated = world.query({ with: [Selected, Selected] });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok)
      expect(repeated.error.detail).toEqual({
        componentName: Selected.name,
        roles: ['with', 'with'],
      });
  });

  it('deduplicates temporal predicates while preserving Disabled and sparse membership', () => {
    const world = new World();
    const Sparse = defineComponent('QueryTemporalSparse', {}, { storage: 'sparse' });
    const entity = world
      .spawn(
        { component: Position, data: { x: 1, y: 2 } },
        { component: Sparse, data: {} },
        { component: Disabled, data: {} },
      )
      .unwrap();
    expect([...world.query({ read: [Position] }).unwrap()]).toHaveLength(0);
    const descriptor = {
      read: [Position],
      with: [Disabled],
      changed: [Position, Position, Sparse],
      added: [Sparse, Sparse],
    } as const;
    const first = world.query(descriptor).unwrap();
    const second = world.query(descriptor).unwrap();
    expect([...first].map((row) => row.entity)).toEqual([entity]);
    expect([...first]).toHaveLength(0);
    expect([...second].map((row) => row.entity)).toEqual([entity]);
    expect([...world.query({ read: [Position], without: [Sparse] }).unwrap()]).toHaveLength(0);
  });

  it('iterates each matching entity once and exposes optional data precisely', () => {
    const { world, first, second } = createWorld();
    const query = world
      .query({ read: [Position], optional: [Velocity], with: [Selected] })
      .unwrap();
    const seen: number[] = [];
    for (const row of query) {
      seen.push(row.entity);
      expect(row.has(Position)).toBe(true);
      expect(row.has(Velocity)).toBe(true);
      expect(row.get(Position).x).toBe(1);
      expect(row.get(Velocity)?.x).toBe(3);
    }
    expect(seen).toEqual([first]);
    expect(seen).not.toContain(second);
  });

  it('addresses one matching entity without scanning the query tables', () => {
    const { world, first, second } = createWorld();
    const query = world
      .query({ read: [Position], optional: [Velocity], with: [Selected] })
      .unwrap();

    const row = query.at(first);
    expect(row?.entity).toBe(first);
    expect(row?.get(Position)?.x).toBe(1);
    expect(query.at(second)).toBeUndefined();
  });

  it('checks optional presence without materialising a component row', () => {
    const { world } = createWorld();
    const query = world.query({ read: [Position], optional: [Velocity] }).unwrap();
    const readRowSpy = vi.spyOn(world[worldInternal], 'getQueryRow');

    const presence: boolean[] = [];
    for (const row of query) presence.push(row.has(Velocity));
    expect(presence).toEqual([true, false]);
    expect(readRowSpy).not.toHaveBeenCalled();
  });

  it('row.mut marks one epoch and writes through the component owner', () => {
    const { world, first } = createWorld();
    const query = world.query({ write: [Position], with: [Selected] }).unwrap();
    const before = world[worldInternal].getMutationEpoch();
    for (const row of query) {
      const position = row.mut(Position);
      position.x += 10;
      position.y = 20;
    }
    expect(world[worldInternal].getMutationEpoch()).toBe(before + 1);
    expect(world.get(first, Position).unwrap()).toMatchObject({ x: 11, y: 20 });
  });

  it('spans are zero-copy and span.mut marks the whole range once', () => {
    const { world, first, second } = createWorld();
    const query = world.query({ write: [Position] }).unwrap();
    const spans = query.spans().unwrap();
    const before = world[worldInternal].getMutationEpoch();
    const buffers = new Set(
      world[worldInternal].getGraph().tables.flatMap((table: Table) => {
        const buffer = table.storage.get(componentId(Position))?.fields.get('x')?.view.buffer;
        return buffer === undefined ? [] : [buffer];
      }),
    );
    let count = 0;
    let spanCount = 0;
    let nextX = 42;
    for (const span of spans) {
      spanCount += 1;
      const positions = span.mut(Position);
      count += span.length;
      for (let index = 0; index < span.length; index++) positions.x[index] = nextX++;
      expect(buffers.has(positions.x.buffer)).toBe(true);
    }
    expect(count).toBe(2);
    expect(world[worldInternal].getMutationEpoch()).toBe(before + spanCount);
    expect(world.get(first, Position).unwrap().x).toBe(42);
    expect(world.get(second, Position).unwrap().x).toBe(43);
  });

  it('exposes packed readonly entity identities on each span', () => {
    const { world, first, second } = createWorld();
    const query = world.query({ read: [Position] }).unwrap();
    const spans = [...query.spans().unwrap()];

    expect(spans.reduce((count, span) => count + span.length, 0)).toBe(2);
    expect(spans.flatMap((span) => Array.from(span.entities))).toEqual([first, second]);
    expect(spans[0]?.get(Position).x[0]).toBe(1);
  });

  it('returns structured span capability failures and coalesces changed rows', () => {
    const world = new World();
    const optional = world
      .query({ read: [Position], optional: [Velocity] })
      .unwrap()
      .spans();
    expect(!optional.ok && optional.error.detail.reason).toBe('optional-data');

    const { world: changedWorld, first, second } = createWorld();
    const changedQuery = changedWorld.query({ read: [Position], changed: [Position] }).unwrap();
    expect([...changedQuery.spans().unwrap()].flatMap((span) => Array.from(span.entities))).toEqual(
      [first, second],
    );
    changedWorld.set(second, Position, { x: 9 }).unwrap();
    const changedSpans = [...changedQuery.spans().unwrap()];
    expect(changedSpans).toHaveLength(1);
    expect(Array.from(changedSpans[0]?.entities ?? [])).toEqual([second]);
  });

  it('does not commit observation after partial iteration', () => {
    const { world, first, second } = createWorld();
    const query = world.query({ read: [Position], changed: [Position] }).unwrap();
    const iterator = query[Symbol.iterator]();
    expect(iterator.next().done).toBe(false);
    iterator.return?.();

    const seen: EntityHandle[] = [];
    for (const row of query) seen.push(row.entity);
    expect(seen).toEqual([first, second]);
  });

  it('refreshes retained rows and spans after new table and sparse archetypes', () => {
    const { world, first, second } = createWorld();
    const Extra = defineComponent('QueryRefreshExtra', { value: 'f32' });
    const Flag = defineComponent('QueryRefreshFlag', {}, { storage: 'sparse' });
    const dense = world.query({ read: [Position] }).unwrap();
    const sparse = world.query({ read: [Position], with: [Flag] }).unwrap();
    const absent = world.query({ read: [Extra], without: [Position] }).unwrap();
    const spanEntities = () =>
      [...dense.spans().unwrap()].flatMap((span) => Array.from(span.entities));

    expect(spanEntities()).toEqual([first, second]);
    expect([...sparse]).toHaveLength(0);
    expect([...absent]).toHaveLength(0);
    const third = world
      .spawn(
        { component: Position, data: { x: 7, y: 8 } },
        { component: Extra, data: { value: 9 } },
      )
      .unwrap();
    const other = world.spawn({ component: Extra, data: { value: 10 } }).unwrap();
    world.addComponent(third, { component: Flag, data: {} }).unwrap();

    expect(Array.from(dense, (row) => row.entity)).toEqual([first, second, third]);
    expect(spanEntities()).toEqual([first, second, third]);
    expect(Array.from(sparse, (row) => row.entity)).toEqual([third]);
    expect(Array.from(absent, (row) => row.entity)).toEqual([other]);
    world.despawn(second).unwrap();
    expect(spanEntities()).toEqual([first, third]);
  });

  it('keeps same-frame late writes for the next observation', () => {
    const { world, first } = createWorld();
    const query = world.query({ read: [Position], changed: [Position] }).unwrap();
    expect([...query].length).toBe(2);
    world.set(first, Position, { x: 9 }).unwrap();
    const seen: EntityHandle[] = [];
    for (const row of query) seen.push(row.entity);
    expect(seen).toEqual([first]);
  });

  it('retains empty matching storage and keeps independent observation cursors', () => {
    const Flag = defineComponent('RepopulatedQueryFlag', {}, { storage: 'sparse' });
    const world = new World();
    const original = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
    world.addComponent(original, { component: Flag, data: {} }).unwrap();
    const dense = world.query({ read: [Position] }).unwrap();
    const sparse = world.query({ read: [Position], with: [Flag] }).unwrap();
    const changed = world.query({ read: [Position], changed: [Position] }).unwrap();
    const otherChanged = world.query({ read: [Position], changed: [Position] }).unwrap();
    const added = world.query({ read: [Position], added: [Position] }).unwrap();
    expect(Array.from(dense, (row) => row.entity)).toEqual([original]);
    expect(Array.from(sparse, (row) => row.entity)).toEqual([original]);
    expect([...changed]).toHaveLength(1);
    expect([...otherChanged]).toHaveLength(1);
    expect([...added]).toHaveLength(1);

    world.despawn(original).unwrap();
    expect([...dense.spans().unwrap()]).toHaveLength(0);
    expect([...sparse]).toHaveLength(0);
    const replacement = world.spawn({ component: Position, data: { x: 3, y: 4 } }).unwrap();
    world.addComponent(replacement, { component: Flag, data: {} }).unwrap();
    expect(Array.from(dense, (row) => row.entity)).toEqual([replacement]);
    expect(Array.from(sparse, (row) => row.entity)).toEqual([replacement]);
    expect([...changed.spans().unwrap()].flatMap((span) => Array.from(span.entities))).toEqual([
      replacement,
    ]);
    expect(Array.from(otherChanged, (row) => row.entity)).toEqual([replacement]);
    expect(Array.from(added, (row) => row.entity)).toEqual([replacement]);
    expect([...changed]).toHaveLength(0);
    world.set(replacement, Position, { x: 5 }).unwrap();
    expect([...changed]).toHaveLength(1);
    expect([...otherChanged]).toHaveLength(1);
    expect([...added]).toHaveLength(0);
  });

  it('fails fast on reentry and synchronous structural invalidation', () => {
    const { world } = createWorld();
    const query = world.query({ read: [Position] }).unwrap();
    const iterator = query[Symbol.iterator]();
    expect(iterator.next().done).toBe(false);
    expect(() => query[Symbol.iterator]()).toThrow(QueryIterationActiveError);
    iterator.return?.();

    const invalidated = query[Symbol.iterator]();
    expect(invalidated.next().done).toBe(false);
    world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    expect(() => invalidated.next()).toThrow(QueryIterationInvalidatedError);
  });

  it('infers row access without casts', () => {
    type Row = QueryRow<readonly [typeof Position], readonly [typeof Velocity], readonly []>;
    expectTypeOf<Row['entity']>().toBeNumber();
  });
});
