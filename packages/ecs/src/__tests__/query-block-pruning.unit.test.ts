import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { QueryIterationInvalidatedError } from '../errors';
import { World } from '../world';

const Value = defineComponent('BlockQueryValue', { value: 'f32' });
const Other = defineComponent('BlockQueryOther', { value: 'f32' });
const Sparse = defineComponent('BlockQuerySparse', {}, { storage: 'sparse' });
const entities = (query: Iterable<{ readonly entity: number }>) =>
  Array.from(query, (row) => row.entity);
const at = <T>(rows: readonly T[], index: number): T => {
  const entity = rows[index];
  if (entity === undefined) throw new Error('Missing fixture entity');
  return entity;
};
const populate = (world: World, count: number) =>
  Array.from({ length: count }, (_, value) =>
    world.spawn({ component: Value, data: { value } }).unwrap(),
  );

describe('dense temporal query iteration', () => {
  it('matches the span owner across untouched blocks, migrations and packed-row removal', () => {
    const world = new World();
    const rows = populate(world, 521);
    const query = world.query({ read: [Value], changed: [Value] }).unwrap();
    const spanQuery = world.query({ read: [Value], changed: [Value] }).unwrap();
    const spanEntities = () =>
      Array.from(spanQuery.spans().unwrap()).flatMap((span) => Array.from(span.entities));
    expect(entities(query)).toEqual(spanEntities());
    for (const index of [2, 193, 520])
      world.set(at(rows, index), Value, { value: -index }).unwrap();
    expect(entities(query)).toEqual(spanEntities());
    world.addComponent(at(rows, 193), { component: Other, data: { value: 1 } }).unwrap();
    world.despawn(at(rows, 2)).unwrap();
    world.set(at(rows, 519), Value, { value: -1 }).unwrap();
    expect(entities(query)).toEqual(spanEntities());
    expect(entities(query)).toEqual([]);
  });

  it('preserves changed and added conjunction across new dense tables', () => {
    const world = new World();
    const rows = populate(world, 257);
    const query = world.query({ read: [Value], changed: [Value], added: [Other] }).unwrap();
    expect(entities(query)).toEqual([]);
    world.addComponent(at(rows, 0), { component: Other, data: { value: 0 } }).unwrap();
    world.addComponent(at(rows, 256), { component: Other, data: { value: 0 } }).unwrap();
    world.set(at(rows, 256), Value, { value: -1 }).unwrap();
    expect(entities(query)).toEqual([rows[256]]);
    world.set(at(rows, 0), Value, { value: -1 }).unwrap();
    expect(entities(query)).toEqual([]);
  });

  it('keeps upper-bound, early-return and structural invalidation semantics', () => {
    const world = new World();
    const rows = populate(world, 257);
    const query = world.query({ read: [Value], changed: [Value] }).unwrap();
    entities(query);
    world.set(at(rows, 0), Value, { value: -1 }).unwrap();
    const iterator = query[Symbol.iterator]();
    expect(iterator.next().value?.entity).toBe(rows[0]);
    world.set(at(rows, 256), Value, { value: -1 }).unwrap();
    expect(iterator.next().done).toBe(true);
    expect(entities(query)).toEqual([rows[256]]);
    world.set(at(rows, 0), Value, { value: -2 }).unwrap();
    const early = query[Symbol.iterator]();
    early.next();
    early.return?.();
    expect(entities(query)).toEqual([rows[0]]);
    const invalidated = query[Symbol.iterator]();
    populate(world, 1);
    expect(() => invalidated.next()).toThrow(QueryIterationInvalidatedError);
  });

  it('keeps sparse temporal membership and independent World cursors', () => {
    const first = new World();
    const second = new World();
    const a = populate(first, 129);
    const b = populate(second, 129);
    first.addComponent(at(a, 128), { component: Sparse, data: {} }).unwrap();
    second.addComponent(at(b, 0), { component: Sparse, data: {} }).unwrap();
    const q1 = first.query({ read: [Value], with: [Sparse], changed: [Value] }).unwrap();
    const q2 = second.query({ read: [Value], with: [Sparse], changed: [Value] }).unwrap();
    expect(entities(q1)).toEqual([a[128]]);
    expect(entities(q2)).toEqual([b[0]]);
    first.set(at(a, 128), Value, { value: -1 }).unwrap();
    expect(entities(q1)).toEqual([a[128]]);
    expect(entities(q2)).toEqual([]);
  });
});
