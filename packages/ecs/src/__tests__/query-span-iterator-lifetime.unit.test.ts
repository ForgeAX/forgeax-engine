import { expect, it } from 'vitest';
import { defineComponent } from '../component';
import { QueryIterationActiveError, QueryIterationInvalidatedError } from '../errors';
import { World } from '../world';

const Value = defineComponent('SpanIteratorLifetimeValue', { x: 'f32' });
const Other = defineComponent('SpanIteratorLifetimeOther', { y: 'f32' });

it('keeps detached span callbacks once-only across later traversals', () => {
  const world = new World();
  const entity = world.spawn({ component: Value, data: { x: 1 } }).unwrap();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  const iterable = query.spans().unwrap();
  const first = iterable[Symbol.iterator]();
  const next = first.next;
  const close = first.return;
  if (close === undefined) throw new Error('Missing span close');
  expect(first.next).toBe(next);
  expect(first.return).toBe(close);
  const held = next();
  if (held.done) throw new Error('Missing initial span');
  close();
  // A partial traversal must not advance the changed observation.
  const current = iterable[Symbol.iterator]();
  expect(() => iterable[Symbol.iterator]()).toThrow(QueryIterationActiveError);
  close();
  expect(next().done).toBe(true);
  expect(() => iterable[Symbol.iterator]()).toThrow(QueryIterationActiveError);
  const step = current.next();
  expect(step.done).toBe(false);
  expect(step).not.toBe(held);
  expect(step.value).not.toBe(held.value);
  expect(current.next().done).toBe(true);
  expect(held.done).toBe(false);
  expect(Array.from(held.value.entities)).toEqual([entity]);
  expect(Array.from(iterable)).toHaveLength(0);
  world.set(entity, Value, { x: 2 }).unwrap();
  expect(Array.from(iterable)).toHaveLength(1);
});

it('closes invalidated span callbacks without affecting their replacement', () => {
  const world = new World();
  world.spawn({ component: Value, data: { x: 1 } }).unwrap();
  const iterable = world
    .query({ read: [Value] })
    .unwrap()
    .spans()
    .unwrap();
  const stale = iterable[Symbol.iterator]();
  const next = stale.next;
  const close = stale.return;
  world.spawn({ component: Other, data: { y: 1 } }).unwrap();
  expect(next).toThrow(QueryIterationInvalidatedError);
  const current = iterable[Symbol.iterator]();
  close?.();
  expect(next().done).toBe(true);
  expect(current.next().done).toBe(false);
  expect(current.next().done).toBe(true);
});
