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
