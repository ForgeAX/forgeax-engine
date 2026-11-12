import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import type { Query } from '../query/query';
import { World } from '../world';

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
