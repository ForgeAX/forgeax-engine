import { expect, it } from 'vitest';
import { createIndexAllocator } from '../../raytracing/index-allocator';

it('appends below capacity, reuses coalesced holes first-fit and returns undefined on overflow', () => {
  const tiles = createIndexAllocator(10, 4);
  expect(tiles.end).toBe(4);
  expect(tiles.allocate(3)).toEqual({ first: 4, end: 7 });
  expect(tiles.allocate(4)).toBeUndefined();
  expect(tiles.end).toBe(7);
  tiles.free({ first: 0, end: 2 });
  tiles.free({ first: 2, end: 4 });
  // Adjacent holes coalesce, so a run spanning both fits.
  expect(tiles.allocate(4)).toEqual({ first: 0, end: 4 });
  tiles.free({ first: 4, end: 7 });
  expect(tiles.allocate(2)).toEqual({ first: 4, end: 6 });
  expect(tiles.allocate(1)).toEqual({ first: 6, end: 7 });
  expect(tiles.allocate(3)).toEqual({ first: 7, end: 10 });
  // Full: the high-water mark never shrinks and overflow allocates nothing.
  expect(tiles.allocate(1)).toBeUndefined();
  expect(tiles.end).toBe(10);
  expect(tiles.allocate(0)).toBeUndefined();
});

it('rejects frees outside the allocation or overlapping a hole', () => {
  const rows = createIndexAllocator(4, 2);
  expect(() => rows.free({ first: 2, end: 3 })).toThrow(/outside/);
  rows.free({ first: 0, end: 1 });
  expect(() => rows.free({ first: 0, end: 2 })).toThrow(/overlaps/);
  expect(() => createIndexAllocator(2, 3)).toThrow();
});
