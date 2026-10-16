import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { componentId, defineComponent } from '../component';
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

  it('keeps same-frame late writes for the next observation', () => {
    const { world, first } = createWorld();
    const query = world.query({ read: [Position], changed: [Position] }).unwrap();
    expect([...query].length).toBe(2);
    world.set(first, Position, { x: 9 }).unwrap();
    const seen: EntityHandle[] = [];
    for (const row of query) seen.push(row.entity);
    expect(seen).toEqual([first]);
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
