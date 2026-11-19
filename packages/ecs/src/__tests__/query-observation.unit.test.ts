import { describe, expect, it, test } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { getDerivedWriter } from '../internal';
import type { Query } from '../query/query';
import { World } from '../world';
import { worldInternal } from '../world-internal';

describe('query-epoch-witness', () => {
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
    try {
      while (!iterator.next().done) {
        /* consume the already validated cohort */
      }
    } finally {
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
  ] as const)('$mode reject poisoned source before next/commit ($consumed consumed)', ({
    mode,
    consumed,
  }) => {
    const { world } = fixture();
    const query = world.query({ read: [Value], changed: [Value] }).unwrap();
    const iterator =
      mode === 'rows' ? query[Symbol.iterator]() : query.spans().unwrap()[Symbol.iterator]();
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
});

describe('query-mark-observed', () => {
  const Value = defineComponent('QueryMarkObservedValue', { x: 'f32' });
  const Other = defineComponent('QueryMarkObservedOther', { x: 'f32' });

  function changedEntities(query: Query<readonly []>): EntityHandle[] {
    const seen: EntityHandle[] = [];
    for (const span of query.spans().unwrap()) {
      for (let row = 0; row < span.length; row++) seen.push(span.entities[row] as EntityHandle);
    }
    return seen;
  }

  function drain(query: Query<readonly []>): void {
    for (const _span of query.spans().unwrap()) {
      /* observation only */
    }
  }

  describe('Query.markObserved', () => {
    it.each([
      'changed',
      'added',
    ] as const)('advances a %s cursor exactly like a completed drain', (predicate) => {
      const world = new World();
      const entities = Array.from({ length: 6 }, (_, x) =>
        world.spawn({ component: Value, data: { x } }).unwrap(),
      );
      const make = () =>
        (predicate === 'changed'
          ? world.query({ changed: [Value] }).unwrap()
          : world.query({ added: [Value] }).unwrap()) as unknown as Query<readonly []>;
      const drained = make();
      const marked = make();
      const steps: Array<() => void> = [
        () => {},
        () => world.set(entities[1] as EntityHandle, Value, { x: 10 }).unwrap(),
        () => {
          world.set(entities[4] as EntityHandle, Value, { x: 11 }).unwrap();
          world.set(entities[2] as EntityHandle, Value, { x: 12 }).unwrap();
        },
        () => {
          world.spawn({ component: Value, data: { x: 13 } }).unwrap();
        },
        () => {
          world.spawn({ component: Other, data: { x: 0 } }).unwrap();
        },
      ];
      for (const step of steps) {
        step();
        drain(drained);
        marked.markObserved();
        // Nothing visible was left behind by either.
        expect(changedEntities(marked)).toEqual(changedEntities(drained));
        // Later edits are seen identically by both cursors.
        step();
        expect(changedEntities(marked)).toEqual(changedEntities(drained));
      }
    });

    it('keeps the active-iteration guard of a drain', () => {
      const world = new World();
      world.spawn({ component: Value, data: { x: 0 } }).unwrap();
      const query = world.query({ changed: [Value] }).unwrap() as unknown as Query<readonly []>;
      const iterator = query.spans().unwrap()[Symbol.iterator]();
      expect(() => query.markObserved()).toThrow();
      iterator.return?.();
      expect(() => query.markObserved()).not.toThrow();
      expect(changedEntities(query)).toEqual([]);
    });
  });
});
