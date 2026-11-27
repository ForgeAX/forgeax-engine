import { expect, test, vi } from 'vitest';
import { GpuDirtyRanges } from '../gpu-dirty-ranges';
import { GpuTableWrites } from '../gpu-table-writes';

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
    const length = dirty.coalesce(slots);
    expect(
      Array.from({ length }, (_, i) => ({ start: dirty.start(i), end: dirty.end(i) })),
    ).toEqual(expected);
  }
  expect(dirty.coalesce([])).toBe(0);
});

test('compacts rows with constant radix digits in either scratch page', () => {
  const dirty = new GpuDirtyRanges();
  for (const shift of [0, 8, 16, 24]) {
    const slots = [7, 1, 4, 3, 7].map((value) => (value * 2 ** shift) >>> 0);
    const count = dirty.coalesce(slots);
    const actual: number[] = [];
    for (let i = 0; i < count; i++)
      for (let row = dirty.start(i); row < dirty.end(i); row++) actual.push(row);
    expect(actual).toEqual([...new Set(slots)].sort((a, b) => a - b));
  }
});

test('a contiguous 50k-row update allocates only its pair of range endpoints', () => {
  const slots = Array.from({ length: 50_000 }, (_, i) => i + 17);
  const dirty = new GpuDirtyRanges();
  const allocations: number[] = [];
  const original = Uint32Array;
  vi.stubGlobal(
    'Uint32Array',
    new Proxy(original, {
      construct(target, args) {
        allocations.push(args[0] as number);
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    expect(dirty.coalesce(slots)).toBe(1);
    expect([dirty.start(0), dirty.end(0)]).toEqual([17, 50017]);
    expect(allocations).toEqual([1, 1]);
    expect(dirty.coalesce([1, 4, 4, 9], 2)).toBe(2);
    expect([dirty.start(0), dirty.end(0), dirty.start(1), dirty.end(1)]).toEqual([1, 5, 9, 10]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('physical table runs match individual occupied rows across summary growth, retry and reuse', () => {
  const writes = new GpuTableWrites();
  const occupied = new Uint8Array(65536);
  let seed = 2701;
  for (let trial = 0; trial < 6; trial++) {
    for (const boundary of [31, 32, 1023, 1024, 32767, 32768]) {
      writes.addRange(boundary - 2, boundary + 3);
      occupied.fill(1, boundary - 2, boundary + 3);
    }
    for (let i = 0; i < 512; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const row = seed % 65472;
      writes.add(row);
      occupied[row] = 1;
      if ((i & 1) === 0) {
        const after = row + 1 + (seed >>> 26);
        writes.addRange(row, after);
        writes.addRange(row, after);
        occupied.fill(1, row, after);
      }
    }
    const actual = new Uint8Array(occupied.length);
    for (let first = writes.next(0); first >= 0; ) {
      const after = writes.end(first);
      expect(after).toBeGreaterThan(first);
      expect(after).toBeLessThanOrEqual(occupied.length);
      expect(first === 0 || occupied[first - 1] === 0).toBe(true);
      expect(occupied[after] ?? 0).toBe(0);
      actual.fill(1, first, after);
      first = writes.next(after);
    }
    expect(actual.every((value, row) => value === occupied[row])).toBe(true);
    expect(writes.storageBytes).toBeLessThan(occupied.length / 7);
    writes.clear();
    occupied.fill(0);
    expect(writes.next(0)).toBe(-1);
  }
  writes.trim(7);
  expect(writes.storageBytes).toBe(0);
  writes.addRange(20000, 60000);
  writes.addRange(5, 10);
  writes.addRange(8, 20000);
  expect([writes.next(0), writes.end(5), writes.next(60000)]).toEqual([5, 60000, -1]);
  expect(writes.storageBytes).toBe(0);
});
