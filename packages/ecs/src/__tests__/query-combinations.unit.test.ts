import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const Position = defineComponent('CombinationPosition', { x: 'f32' });

describe('Query.combinations', () => {
  it('uses the same filtered entity order as row iteration', () => {
    const world = new World();
    const entities = [1, 2, 3].map((x) =>
      world.spawn({ component: Position, data: { x } }).unwrap(),
    );
    const query = world.query({ read: [Position] }).unwrap();
    const pairs = [...query.combinations()].map((rows) => rows.map((row) => row.entity));
    expect(pairs).toEqual([
      [entities[0], entities[1]],
      [entities[0], entities[2]],
      [entities[1], entities[2]],
    ]);
  });

  it('supports k-tuples and yields none when k exceeds the match count', () => {
    const world = new World();
    for (const x of [1, 2, 3]) world.spawn({ component: Position, data: { x } }).unwrap();
    const query = world.query({ read: [Position] }).unwrap();
    expect([...query.combinations(3)]).toHaveLength(1);
    expect([...query.combinations(4)]).toEqual([]);
  });

  it('does not commit change observation when combination iteration stops early', () => {
    const world = new World();
    const entities = [1, 2, 3].map((x) =>
      world.spawn({ component: Position, data: { x } }).unwrap(),
    );
    const query = world.query({ read: [Position], changed: [Position] }).unwrap();
    const iterator = query.combinations(2)[Symbol.iterator]();
    expect(iterator.next().done).toBe(false);
    iterator.return?.();

    expect(Array.from(query, (row) => row.entity)).toEqual(entities);
  });
});

it('keeps stable sparse rows and optional facts across retained combinations', () => {
  const world = new World();
  const Selected = defineComponent('CombinationSelected', {}, { storage: 'sparse' });
  const Tint = defineComponent('CombinationTint', { value: 'f32' });
  const first = world
    .spawn({ component: Position, data: { x: 1 } }, { component: Selected, data: {} })
    .unwrap();
  const excluded = world.spawn({ component: Position, data: { x: 2 } }).unwrap();
  const second = world
    .spawn(
      { component: Position, data: { x: 3 } },
      { component: Selected, data: {} },
      { component: Tint, data: { value: 0 } },
    )
    .unwrap();
  const query = world.query({ read: [Position], optional: [Tint], with: [Selected] }).unwrap();
  const pairs = [...query.combinations()];
  expect(pairs.map((pair) => pair.map((row) => row.entity))).toEqual([[first, second]]);
  expect(pairs[0]?.map((row) => row.get(Position).x)).toEqual([1, 3]);
  expect(pairs[0]?.map((row) => row.get(Tint)?.value)).toEqual([undefined, 0]);
  world.set(first, Position, { x: 9 }).unwrap();
  expect(pairs[0]?.[0]?.get(Position).x).toBe(9);
  expect(pairs[0]?.some((row) => row.entity === excluded)).toBe(false);
});

it('fences nested traversals and structural edits then releases the query after failure', () => {
  const world = new World();
  for (const x of [1, 2, 3]) world.spawn({ component: Position, data: { x } }).unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  const iterator = query.combinations()[Symbol.iterator]();
  expect(iterator.next().done).toBe(false);
  expect(() => query[Symbol.iterator]()).toThrowError(
    expect.objectContaining({ code: 'query-iteration-active' }),
  );
  world.spawn({ component: Position, data: { x: 4 } }).unwrap();
  expect(() => iterator.next()).toThrowError(
    expect.objectContaining({ code: 'query-iteration-invalidated' }),
  );
  expect([...query.combinations()]).toHaveLength(6);
});

it('commits only the completed temporal observation and keeps later writes observable', () => {
  const world = new World();
  const entities = [1, 2, 3].map((x) => world.spawn({ component: Position, data: { x } }).unwrap());
  const query = world.query({ read: [Position], changed: [Position] }).unwrap();
  const iterator = query.combinations()[Symbol.iterator]();
  expect(iterator.next().done).toBe(false);
  const changed = entities[0] as NonNullable<(typeof entities)[0]>;
  world.set(changed, Position, { x: 10 }).unwrap();
  while (!iterator.next().done) {
    /* Complete the accepted observation. */
  }
  expect(Array.from(query, (row) => row.entity)).toEqual([changed]);
  expect([...query.combinations()]).toEqual([]);
});
