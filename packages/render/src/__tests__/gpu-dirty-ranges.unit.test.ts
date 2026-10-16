import { expect, test } from 'vitest';
import { GpuDirtyRanges } from '../gpu-dirty-ranges';

test('radix range merging matches an independent comparison-sort oracle', () => {
  const dirty = new GpuDirtyRanges();
  let seed = 891;
  for (let trial = 0; trial < 32; trial++) {
    const slots = Array.from({ length: trial * 173 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 4096;
    });
    slots.push(0xffffffff, 0xfffffffe, 0xffffffff);
    const expected: { start: number; end: number }[] = [];
    for (const slot of [...new Set(slots)].sort((a, b) => a - b)) {
      const last = expected.at(-1);
      if (last?.end === slot) last.end++;
      else expected.push({ start: slot, end: slot + 1 });
    }
    expect(dirty.coalesce(slots)).toEqual(expected);
  }
  expect(dirty.coalesce([])).toEqual([]);
});
