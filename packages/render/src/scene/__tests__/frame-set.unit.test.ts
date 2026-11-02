import { expect, test } from 'vitest';
import { FrameSet } from '../frame-set';

const KEYS = [0, 1, 31, 32, 63, 1023, 1024, 1025, 4096 + 31, 70_000];

test('paged membership answers has, size and ascending order across word and page edges', () => {
  let set = new FrameSet();
  for (const key of [...KEYS].reverse()) set = set.with(key);
  expect(set.size).toBe(KEYS.length);
  expect([...set]).toEqual(KEYS);
  for (const key of KEYS) expect(set.has(key)).toBe(true);
  for (const key of [2, 30, 33, 1022, 1026, 69_999, -1, 0.5]) expect(set.has(key)).toBe(false);
  expect([...FrameSet.from([...KEYS].reverse())]).toEqual(KEYS);
  expect(FrameSet.from(KEYS).size).toBe(KEYS.length);
});

test('additions and removals keep earlier frames and report exactly the flipped keys', () => {
  const before = FrameSet.from(KEYS);
  const after = before.without(31).without(1024).with(5).with(2047).with(70_001);
  expect(before.has(31)).toBe(true);
  expect(after.has(31)).toBe(false);
  expect(after.with(5)).toBe(after);
  expect(after.without(6)).toBe(after);
  const visited: number[] = [];
  after.changesSince(before, (key) => visited.push(key));
  expect(visited.sort((a, b) => a - b)).toEqual([5, 31, 1024, 2047, 70_001]);
  const emptied = FrameSet.from([4096 + 31]).without(4096 + 31);
  expect(emptied.size).toBe(0);
  expect([...emptied]).toEqual([]);
  expect(() => new FrameSet().with(-1)).toThrow(RangeError);
});

test('ranked keys preserve ascending values through dense and sparse word boundaries', () => {
  const keys = [...KEYS, ...Array.from({ length: 96 }, (_, index) => index + 2048)].sort(
    (a, b) => a - b,
  );
  const before = FrameSet.from(keys);
  expect(keys.map((_, index) => before.at(index))).toEqual(keys);
  expect(before.at(-1)).toBe(keys.at(-1));
  expect(before.at(-keys.length)).toBe(keys[0]);
  expect(before.at(keys.length)).toBeUndefined();
  expect(before.at(Infinity)).toBeUndefined();
  const after = before.without(31).with(4095);
  expect([...after].map((_, index) => after.at(index))).toEqual([...after]);
  expect(before.at(2)).toBe(31);
});

test('borrowed key walks keep fixed membership, independent cursors and ordinary result lifetime', () => {
  const set = FrameSet.from(KEYS);
  const values = [...set];
  const publicWalk = set.values();
  const publicFirst = publicWalk.next();
  publicWalk.next();
  expect(publicFirst.value).toBe(values[0]);
  const first = set.borrowKeys();
  const second = set.borrowKeys();
  expect(first.next().value).toBe(values[0]);
  expect(second.next().value).toBe(values[0]);
  expect(first.next().value).toBe(values[1]);
  expect(second.next().value).toBe(values[1]);
  first.return?.();
  expect(first.next().done).toBe(true);
  expect(second.next().value).toBe(values[2]);
  second.return?.();
  expect([...set.borrowKeys()]).toEqual(values);
  const held = set.borrowKeys();
  const changed = set.without(values[0] as number).with(16384);
  expect([...held]).toEqual(values);
  expect([...changed.borrowKeys()]).toEqual([...changed]);
  const empty = new FrameSet().borrowKeys();
  expect(empty.next().done).toBe(true);
  expect(empty.next().done).toBe(true);
});

test('empty borrowed walks share immutable termination while public results remain independent', () => {
  const first = new FrameSet().borrowKeys();
  const second = FrameSet.from([]).borrowKeys();
  expect(first).toBe(second);
  const terminal = first.next();
  expect(terminal).toEqual({ value: undefined, done: true });
  expect(Object.isFrozen(terminal)).toBe(true);
  expect(second.return?.()).toBe(terminal);
  expect(first.next()).toBe(terminal);
  const ordinary = new FrameSet().values();
  const old = ordinary.next();
  expect(ordinary.next()).not.toBe(old);
  expect(old).toEqual({ value: undefined, done: true });
});
