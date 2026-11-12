import { expect, it, vi } from 'vitest';
import { FrameIntersection, FrameSet } from '../frame-set';

it('matches intersection through sparse edits and preserves captured membership', () => {
  const query = new FrameIntersection();
  let left = new FrameSet();
  let right = new FrameSet();
  const a = new Set<number>();
  const b = new Set<number>();
  const captured: { members: FrameSet; expected: number[] }[] = [];
  let random = 73;
  for (let step = 0; step < 1200; step++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const key = (random >>> 8) % 8192;
    if ((random & 1) === 0) {
      if (a.delete(key)) left = left.without(key);
      else {
        a.add(key);
        left = left.with(key);
      }
    } else if (b.delete(key)) right = right.without(key);
    else {
      b.add(key);
      right = right.with(key);
    }
    if (step % 3 !== 0) continue;
    const members = query.sync(left, right);
    const expected = [...a].filter((key) => b.has(key)).sort((x, y) => x - y);
    expect([...members]).toEqual(expected);
    expect(query.sync(left, right)).toBe(members);
    if (step % 120 === 0) captured.push({ members, expected });
  }
  for (const frame of captured) expect([...frame.members]).toEqual(frame.expected);
});

it.each([16, 4096])('does not enumerate N=%i members again after one known edit', (count) => {
  const query = new FrameIntersection();
  const left = FrameSet.from(Array.from({ length: count }, (_, key) => key * 2));
  const right = FrameSet.from(Array.from({ length: count }, (_, key) => key * 2 + 1));
  const before = query.sync(left, right);
  expect(before.size).toBe(0);
  const next = left.with(1);
  const iterate = FrameSet.prototype[Symbol.iterator];
  let sourceReads = 0;
  const read = vi.spyOn(FrameSet.prototype, Symbol.iterator).mockImplementation(function (
    this: FrameSet,
  ) {
    if (this === next || this === right) {
      sourceReads++;
      throw new Error('full source enumeration after a known edit');
    }
    return iterate.call(this);
  });
  try {
    const current = query.sync(next, right);
    expect([...current]).toEqual([1]);
    expect([...before]).toEqual([]);
    expect(query.sync(next, right)).toBe(current);
    expect(sourceReads).toBe(0);
  } finally {
    read.mockRestore();
  }
});

it('does not enumerate a large source when the other cold set is empty', () => {
  const large = FrameSet.from(Array.from({ length: 4096 }, (_, key) => key));
  const iterate = FrameSet.prototype[Symbol.iterator];
  const read = vi.spyOn(FrameSet.prototype, Symbol.iterator).mockImplementation(function (
    this: FrameSet,
  ) {
    if (this === large)
      throw new Error('cold empty intersection must not enumerate the populated source');
    return iterate.call(this);
  });
  try {
    expect(new FrameIntersection().sync(large, new FrameSet()).size).toBe(0);
  } finally {
    read.mockRestore();
  }
});
