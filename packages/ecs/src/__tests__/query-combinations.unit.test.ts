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
