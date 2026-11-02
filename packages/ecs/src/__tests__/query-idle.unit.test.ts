import { expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { QueryIterationActiveError } from '../errors';
import { World } from '../world';

it('refreshes retained visitors across sparse membership and optional-column migration', () => {
  const Value = defineComponent('VisitorSparseValue', { value: 'f32' });
  const Extra = defineComponent('VisitorOptionalValue', { value: 'f32' });
  const Flag = defineComponent('VisitorSparseFlag', {}, { storage: 'sparse' });
  const world = new World();
  world.spawn({ component: Value, data: { value: 1 } }, { component: Flag, data: {} }).unwrap();
  const second = world
    .spawn({ component: Value, data: { value: 2 } }, { component: Extra, data: { value: 3 } })
    .unwrap();
  const query = world.query({ read: [Value], optional: [Extra], with: [Flag] }).unwrap();
  const observed = () => {
    const values: unknown[] = [];
    query.forEach((row) => {
      values.push([row.entity, row.get(Value).value, row.get(Extra)?.value]);
    });
    expect(values).toEqual(
      Array.from(query, (row) => [row.entity, row.get(Value).value, row.get(Extra)?.value]),
    );
    return values;
  };
  expect(observed()).toHaveLength(1);
  world.addComponent(second, { component: Flag, data: {} }).unwrap();
  expect(observed()).toHaveLength(2);
  world.removeComponent(second, Extra).unwrap();
  expect(observed()).toContainEqual([second, 2, undefined]);
});

it('keeps synchronous visitors independent from completed and detached iterators', () => {
  const Value = defineComponent('VisitorValue', { value: 'f32' });
  const world = new World();
  const first = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
  const second = world.spawn({ component: Value, data: { value: 2 } }).unwrap();
  const query = world.query({ read: [Value] }).unwrap();
  const other = world.query({ read: [Value] }).unwrap();
  const old = query[Symbol.iterator]();
  const next = old.next;
  const close = old.return;
  expect(next().value.entity).toBe(first);
  close?.();
  for (let repeat = 0; repeat < 3; repeat++) {
    const observed: number[] = [];
    query.forEach((row) => {
      const entity = row.entity;
      close?.();
      expect(() => query.forEach(() => {})).toThrow(QueryIterationActiveError);
      other.forEach(() => {
        expect(row.entity).toBe(entity);
      });
      observed.push(entity);
    });
    expect(observed).toEqual([first, second]);
    expect(next().done).toBe(true);
  }
});

it('commits a temporal visitor only after completion and releases it after callback failure', () => {
  const Value = defineComponent('VisitorChangedValue', { value: 'f32' });
  const world = new World();
  const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  expect(() =>
    query.forEach(() => {
      throw new Error('visitor failed');
    }),
  ).toThrow('visitor failed');
  const observed: number[] = [];
  query.forEach((row) => {
    observed.push(row.entity);
  });
  expect(observed).toEqual([entity]);
  query.forEach(() => {
    throw new Error('unchanged row visited');
  });
  world.set(entity, Value, { value: 2 }).unwrap();
  query.forEach((row) => {
    expect(row.get(Value).value).toBe(2);
  });
});

it('rejects structural mutation during a visitor and refreshes its next traversal', () => {
  const Value = defineComponent('VisitorStructuralValue', { value: 'f32' });
  const world = new World();
  const first = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
  const query = world.query({ read: [Value] }).unwrap();
  let second: typeof first | undefined;
  expect(() =>
    query.forEach(() => {
      second = world.spawn({ component: Value, data: { value: 2 } }).unwrap();
    }),
  ).toThrow('invalidated');
  const observed: number[] = [];
  query.forEach((row) => {
    observed.push(row.entity);
  });
  expect(observed).toEqual([first, second]);
});

it('uses component epochs to skip idle changed-query row scans', () => {
  const Value = defineComponent('IdleValue', { value: 'f32' });
  const world = new World();
  const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  expect([...query]).toHaveLength(1);
  const probe = vi.spyOn(
    query as unknown as { changeMatches: (...args: unknown[]) => boolean },
    'changeMatches',
  );
  expect([...query]).toHaveLength(0);
  expect(probe).not.toHaveBeenCalled();
  world.set(entity, Value, { value: 2 }).unwrap();
  expect([...query]).toHaveLength(1);
});
