import { describe, expect, it } from 'vitest';
import { FirstEntryMap } from '../first-entry-map';

describe('single-entry lookup', () => {
  it('keeps Map equality, undefined values and overwrites across fanout', () => {
    const actual = new FirstEntryMap<unknown, unknown>();
    const expected = new Map<unknown, unknown>();
    const object = {};
    const keys = [undefined, NaN, -0, 0, object, {}, 'one', 'two', 100];
    for (const [index, key] of keys.entries()) {
      const value = index === 0 ? undefined : index;
      actual.set(key, value);
      expected.set(key, value);
      for (const candidate of keys) expect(actual.get(candidate)).toBe(expected.get(candidate));
    }
    for (const key of keys) {
      actual.set(key, 'replaced');
      expected.set(key, 'replaced');
    }
    for (const key of keys) expect(actual.get(key)).toBe(expected.get(key));
  });

  it('uses one first slot for NaN and signed zero and handles large fanout', () => {
    for (const first of [NaN, -0]) {
      const map = new FirstEntryMap<number, number>();
      map.set(first, 1).set(Number.isNaN(first) ? NaN : 0, 2);
      expect(map.get(first)).toBe(2);
      for (let key = 1; key <= 512; key++) map.set(key, key);
      for (let key = 1; key <= 512; key++) expect(map.get(key)).toBe(key);
      expect(map.get(first)).toBe(2);
    }
  });
});

it('retains ordered traversal and undefined admission facts when callbacks add fanout', () => {
  const map = new FirstEntryMap<number, string | undefined>();
  map.set(-0, undefined);
  expect(map.has(0)).toBe(true);
  expect(map.has(1)).toBe(false);
  expect(Object.is([...map][0]?.[0], -0)).toBe(false);
  const visited: [number, string | undefined][] = [];
  map.forEach((value, key) => {
    visited.push([key, value]);
    if (key === 0) map.set(1, 'one').set(2, 'two');
    if (key === 1) map.set(2, 'changed').set(3, 'three');
  });
  expect(visited).toEqual([
    [0, undefined],
    [1, 'one'],
    [2, 'changed'],
    [3, 'three'],
  ]);
  expect([...map.values()]).toEqual(visited.map(([, value]) => value));
  expect([...map]).toEqual(visited);
  const iterator = map[Symbol.iterator]();
  expect(iterator.next().value).toEqual([0, undefined]);
  map.set(4, 'four');
  expect([...iterator]).toEqual([
    [1, 'one'],
    [2, 'changed'],
    [3, 'three'],
    [4, 'four'],
  ]);
});
