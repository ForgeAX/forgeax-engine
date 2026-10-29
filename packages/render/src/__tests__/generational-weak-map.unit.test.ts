import { expect, test } from 'vitest';
import {
  GenerationalWeakMap,
  identityOrdinal,
  versionedGet,
  versionedSet,
} from '../scene/generational-weak-map';

test('keys used once per generation keep their exact value across rotations', () => {
  const map = new GenerationalWeakMap<object, object>(4);
  const live = [{}, {}, {}];
  const values = live.map(() => ({}));
  live.forEach((key, index) => {
    map.set(key, values[index] as object);
  });
  for (let frame = 0; frame < 50; frame++) {
    // Every frame replaces two short-lived keys and reads the live ones.
    map.set({}, {});
    map.set({}, {});
    live.forEach((key, index) => {
      expect(map.get(key)).toBe(values[index]);
    });
  }
});

test('a key unused for two generations is forgotten and reported as a miss', () => {
  const map = new GenerationalWeakMap<object, string>(2);
  const idle = {};
  map.set(idle, 'idle');
  for (let index = 0; index < 6; index++) map.set({}, 'churn');
  expect(map.get(idle)).toBeUndefined();
  expect(map.has(idle)).toBe(false);
});

test('set replaces and delete removes the value in both generations', () => {
  const map = new GenerationalWeakMap<object, string>(1);
  const key = {};
  map.set(key, 'a');
  map.set({}, 'rotate');
  map.set({}, 'rotate');
  map.set(key, 'b');
  expect(map.get(key)).toBe('b');
  expect(map.delete(key)).toBe(true);
  expect(map.get(key)).toBeUndefined();
  expect(map.delete(key)).toBe(false);
});

test('versioned entries keep each version of one key independently', () => {
  const map = new GenerationalWeakMap<object, readonly { version: number; value: string }[]>();
  const key = {};
  const a = identityOrdinal({});
  const b = identityOrdinal({});
  expect(a).not.toBe(b);
  versionedSet(map, key, { version: a, value: 'a' });
  versionedSet(map, key, { version: b, value: 'b' });
  expect(versionedGet(map, key, a)?.value).toBe('a');
  expect(versionedGet(map, key, b)?.value).toBe('b');
  versionedSet(map, key, { version: a, value: 'a2' });
  expect(versionedGet(map, key, a)?.value).toBe('a2');
  expect(map.get(key)?.length).toBe(2);
});

test('identity ordinals are stable small integers', () => {
  const value = {};
  const ordinal = identityOrdinal(value);
  expect(identityOrdinal(value)).toBe(ordinal);
  expect(Number.isInteger(ordinal) && ordinal > 0 && ordinal < 2 ** 30).toBe(true);
});
