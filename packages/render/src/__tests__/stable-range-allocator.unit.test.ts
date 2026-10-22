import { expect, it, vi } from 'vitest';
import { StableRangeAllocator } from '../stable-range-allocator';

/** Count distinct preexisting intervals touched through their six real fields. */
function countRangeVisits(owner: StableRangeAllocator): () => number {
  const visited = new Set<object>();
  const protect = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) protect(item);
      return;
    }
    const node = value as Record<string, unknown>;
    protect(node.left);
    protect(node.right);
    for (const field of ['start', 'count', 'left', 'right', 'height', 'maximum']) {
      if (!Object.hasOwn(node, field)) continue;
      let current = node[field];
      Object.defineProperty(node, field, {
        configurable: true,
        get() {
          visited.add(node);
          return current;
        },
        set(next: unknown) {
          current = next;
        },
      });
    }
  };
  protect((owner as unknown as { free: unknown }).free);
  visited.clear();
  return () => visited.size;
}

it('reuses and coalesces known neighbours without moving live ranges', () => {
  const owner = new StableRangeAllocator();
  const addresses = Array.from({ length: 5 }, () => owner.allocate(8));
  expect(addresses).toEqual([0, 8, 16, 24, 32]);
  owner.release(8, 8);
  owner.release(24, 8);
  owner.release(16, 8);
  expect(owner.allocate(24)).toBe(8);
  expect(owner.requiredCapacity()).toBe(40);
  owner.release(8, 24);
  expect(owner.allocate(5, 7)).toBe(14);
  expect(owner.allocate(6)).toBe(8);
  expect(owner.allocate(13)).toBe(19);
  expect(owner.requiredCapacity()).toBe(40);
});

it('extends an aligned retired tail while retaining its prefix hole', () => {
  const owner = new StableRangeAllocator();
  expect(owner.allocate(5)).toBe(0);
  expect(owner.allocate(3)).toBe(5);
  owner.release(5, 3);
  expect(owner.allocate(10, 7)).toBe(7);
  expect(owner.requiredCapacity()).toBe(17);
  expect(owner.allocate(2)).toBe(5);
  expect(owner.requiredCapacity()).toBe(17);
});

it('does not sort the complete free roster when one middle interval is released', () => {
  const owner = new StableRangeAllocator();
  for (let index = 0; index < 4096; index++) owner.allocate(4);
  for (let index = 0; index < 4096; index += 2) owner.release(index * 4, 4);
  const visits = countRangeVisits(owner);
  const sort = vi.spyOn(Array.prototype, 'sort').mockImplementation(() => {
    throw new Error('global free-range sorting');
  });
  try {
    owner.release(4, 4);
    expect(visits()).toBeLessThan(128);
    expect(owner.allocate(12)).toBe(0);
  } finally {
    sort.mockRestore();
  }
});

it('matches address-first aligned reuse under deterministic interleaved churn', () => {
  const owner = new StableRangeAllocator();
  const occupied = new Set<number>();
  const live: { start: number; count: number }[] = [];
  let seed = 0x3aef128;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 3000; step++) {
    if (live.length > 0 && random() % 3 === 0) {
      const at = random() % live.length;
      const range = live.splice(at, 1)[0];
      if (range === undefined) throw new Error('missing live interval');
      owner.release(range.start, range.count);
      for (let cell = range.start; cell < range.start + range.count; cell++) occupied.delete(cell);
      continue;
    }
    const count = 1 + (random() % 17);
    const alignment = 1 + (random() % 11);
    let expected = 0;
    for (; ; expected += alignment) {
      let free = true;
      for (let cell = expected; cell < expected + count; cell++) {
        if (occupied.has(cell)) {
          free = false;
          break;
        }
      }
      if (free) break;
    }
    const start = owner.allocate(count, alignment);
    expect(start).toBe(expected);
    for (let cell = start; cell < start + count; cell++) {
      expect(occupied.has(cell)).toBe(false);
      occupied.add(cell);
    }
    live.push({ start, count });
  }
});

it('bounds unaligned selection to the address index path under fragmented free space', () => {
  const owner = new StableRangeAllocator();
  for (let index = 0; index < 4096; index++) owner.allocate(index === 4094 ? 20 : 4);
  let address = 0;
  for (let index = 0; index < 4096; index++) {
    const count = index === 4094 ? 20 : 4;
    if (index % 2 === 0) owner.release(address, count);
    address += count;
  }
  const visits = countRangeVisits(owner);
  expect(owner.allocate(12)).toBe(4094 * 4);
  expect(visits()).toBeLessThan(128);
});

it('merges both neighbours when deletion inherits the saved successor', () => {
  const owner = new StableRangeAllocator();
  owner.allocate(10);
  owner.release(4, 1);
  owner.release(0, 1);
  owner.release(8, 1);
  owner.release(5, 3);
  expect(owner.allocate(5)).toBe(4);
  expect(owner.allocate(1)).toBe(0);
  expect(owner.requiredCapacity()).toBe(10);
});

it('reuses exact released sizes without the tree and flushes them before growing', () => {
  const ranges = new StableRangeAllocator(64);
  const a = ranges.allocate(17);
  const b = ranges.allocate(17);
  const tail = ranges.requiredCapacity();
  ranges.release(a, 17);
  ranges.release(b, 17);
  // Exact reuse keeps first-fit address order, not release order.
  expect(ranges.allocate(17)).toBe(a);
  expect(ranges.allocate(17)).toBe(b);
  ranges.release(b, 17);
  ranges.release(a, 17);
  // Another size cannot fit until spare ranges coalesce back into the tree.
  expect(ranges.allocate(34)).toBe(a);
  expect(ranges.requiredCapacity()).toBe(tail);
  // Over the limit, releases coalesce in the tree as before.
  const big = ranges.allocate(48);
  ranges.release(big, 48);
  expect(ranges.allocate(48)).toBe(big);
  ranges.release(big, 48);
  ranges.release(a, 34);
  const merged = ranges.allocate(82);
  expect(merged === a || merged === big).toBe(true);
});

it('keeps alignment and reset semantics for exact spare reuse', () => {
  const ranges = new StableRangeAllocator(64);
  ranges.allocate(1);
  const odd = ranges.allocate(4);
  ranges.release(odd, 4);
  expect(ranges.allocate(4, 4) % 4).toBe(0);
  ranges.reset(1);
  expect(ranges.allocate(4)).toBe(1);
});
