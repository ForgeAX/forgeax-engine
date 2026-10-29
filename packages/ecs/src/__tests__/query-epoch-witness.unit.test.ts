import { expect, test, vi } from 'vitest';
import { componentId, defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { getDerivedWriter } from '../internal';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Value = defineComponent('QueryEpochWitnessValue', { x: 'f32' });
const Extra = defineComponent('QueryEpochWitnessExtra', {});
const Second = defineComponent('QueryEpochWitnessSecond', { x: 'f32' });
const Unrelated = defineComponent('QueryEpochWitnessUnrelated', { x: 'f32' });

function fixture() {
  const world = new World();
  const entities = Array.from({ length: 4 }, (_, x) =>
    world.spawn({ component: Value, data: { x } }).unwrap(),
  );
  for (const index of [1, 3])
    world.addComponent(entities[index] as EntityHandle, { component: Extra, data: {} }).unwrap();
  return { world, entities };
}

test.each([
  { mode: 'rows', unrelated: false },
  { mode: 'spans', unrelated: false },
  { mode: 'rows', unrelated: true },
  { mode: 'spans', unrelated: true },
] as const)('$mode candidates do not repeat predicates after unrelated=$unrelated writes', ({
  mode,
  unrelated,
}) => {
  const { world } = fixture();
  const other = world.spawn({ component: Unrelated, data: { x: 0 } }).unwrap();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  const iterator =
    mode === 'rows' ? query[Symbol.iterator]() : query.spans().unwrap()[Symbol.iterator]();
  const upper = world[worldInternal].getMutationEpoch();
  if (unrelated) {
    world.set(other, Unrelated, { x: 1 }).unwrap();
    expect(world[worldInternal].getMutationEpoch()).toBeGreaterThan(upper);
  }
  const index = world[worldInternal].getComponentChangeIndex(componentId(Value));
  if (index === undefined) throw new Error('missing value index');
  const read = vi.spyOn(index, 'get').mockImplementation(() => {
    throw new Error('repeated changed predicate');
  });
  try {
    while (!iterator.next().done) {
      /* consume the already validated cohort */
    }
  } finally {
    read.mockRestore();
    iterator.return?.();
  }
});

test.each([
  { mode: 'rows', predicate: 'changed' },
  { mode: 'spans', predicate: 'changed' },
  { mode: 'rows', predicate: 'added' },
  { mode: 'spans', predicate: 'added' },
] as const)('$mode retain $predicate semantics after a later value write', ({
  mode,
  predicate,
}) => {
  const { world, entities } = fixture();
  const future = entities[3] as EntityHandle;
  const query = world.query({ read: [Value], [predicate]: [Value] }).unwrap();
  const seen: EntityHandle[] = [];
  if (mode === 'rows') {
    const iterator = query[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) throw new Error('missing first row');
    seen.push(first.value.entity);
    world.set(future, Value, { x: -1 }).unwrap();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      seen.push(next.value.entity);
  } else {
    const iterator = query.spans().unwrap()[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) throw new Error('missing first span');
    seen.push(...(first.value.entities as Iterable<EntityHandle>));
    world.set(future, Value, { x: -1 }).unwrap();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      seen.push(...(next.value.entities as Iterable<EntityHandle>));
  }
  expect(seen.includes(future)).toBe(predicate === 'added');
  expect(seen.length).toBe(predicate === 'added' ? 4 : 3);
  expect(Array.from(query, (row) => row.entity)).toEqual(predicate === 'changed' ? [future] : []);
});

test.each([
  { mode: 'rows', consumed: 1 },
  { mode: 'rows', consumed: 4 },
  { mode: 'spans', consumed: 0 },
  { mode: 'spans', consumed: 2 },
  { mode: 'combinations', consumed: 0 },
  { mode: 'combinations', consumed: 1 },
  { mode: 'combinations', consumed: 6 },
] as const)('$mode reject poisoned source before next/commit ($consumed consumed)', ({
  mode,
  consumed,
}) => {
  const { world } = fixture();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  const iterator =
    mode === 'rows'
      ? query[Symbol.iterator]()
      : mode === 'combinations'
        ? query.combinations()[Symbol.iterator]()
        : query.spans().unwrap()[Symbol.iterator]();
  for (let i = 0; i < consumed; i++) expect(iterator.next().done).toBe(false);
  const before = world[worldInternal].getMutationEpoch();
  const writer = getDerivedWriter(world.query({ write: [Value] }).unwrap(), Value).unwrap();
  const result = writer.writeRange(
    0,
    0,
    0,
    1,
    (binding) => {
      binding.write.x[0] = -99;
      throw new Error('injected partial kernel failure');
    },
    undefined,
  );
  expect(result.ok).toBe(false);
  expect(world.execution.health).toBe('poisoned');
  expect(world[worldInternal].getMutationEpoch()).toBe(before);
  expect(() => iterator.next()).toThrowError(expect.objectContaining({ code: 'world-poisoned' }));
  expect(() => query[Symbol.iterator]()).toThrowError(
    expect.objectContaining({ code: 'world-poisoned' }),
  );
});

test.each([
  'rows',
  'spans',
] as const)('%s checks every Changed input after a cross-yield write', (mode) => {
  const { world, entities } = fixture();
  for (const entity of entities)
    world.addComponent(entity, { component: Second, data: { x: 0 } }).unwrap();
  const other = world.spawn({ component: Unrelated, data: { x: 0 } }).unwrap();
  const query = world.query({ read: [Value, Second], changed: [Value, Second] }).unwrap();
  const future = entities[3] as EntityHandle;
  const mutate = () => {
    world.set(other, Unrelated, { x: 1 }).unwrap();
    world.set(future, Second, { x: 9 }).unwrap();
  };
  const seen: EntityHandle[] = [];
  if (mode === 'rows') {
    const iterator = query[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) throw new Error('missing first row');
    seen.push(first.value.entity);
    mutate();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      seen.push(next.value.entity);
  } else {
    const iterator = query.spans().unwrap()[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) throw new Error('missing first span');
    seen.push(...(first.value.entities as Iterable<EntityHandle>));
    mutate();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      seen.push(...(next.value.entities as Iterable<EntityHandle>));
  }
  expect(seen).not.toContain(future);
  expect(seen).toHaveLength(3);
  // Changed inputs are conjunctive; only Second changed after this cursor.
  expect(Array.from(query, (row) => row.entity)).toEqual([]);
});
