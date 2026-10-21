import { describe, expect, it } from 'vitest';
import { BufferPool } from '../buffer-pool';

describe('managed buffer slot ownership', () => {
  it('cannot mutate a released slot or move a parked allocation to another bucket', () => {
    const pool = new BufferPool();
    const allocated = pool.alloc(12);
    if (!allocated.ok) throw allocated.error;
    pool.release(allocated.value.id);
    expect(pool.grow(allocated.value.id, 64).ok).toBe(false);
    expect(pool.setLogicalLength(allocated.value.id, 8).ok).toBe(false);
    const next = pool.alloc(16);
    if (!next.ok) throw next.error;
    expect(pool.byteCapacity(next.value.id)).toBe(16);
    expect(next.value.view).toEqual(new Uint8Array(16));
  });
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
  ])('rejects invalid logical length %s without changing live bytes', (length) => {
    const pool = new BufferPool();
    const allocated = pool.alloc(8);
    if (!allocated.ok) throw allocated.error;
    allocated.value.view.fill(7);
    expect(pool.setLogicalLength(allocated.value.id, length).ok).toBe(false);
    expect(pool.view(allocated.value.id)).toEqual(new Uint8Array(8).fill(7));
  });
  it('keeps byte length, backing capacity and zeroed tails together through growth and reuse', () => {
    const pool = new BufferPool();
    const allocated = pool.alloc(8);
    if (!allocated.ok) throw allocated.error;
    const { id } = allocated.value;
    allocated.value.view.fill(7);
    expect(pool.setLogicalLength(id, 4).ok).toBe(true);
    expect(pool.grow(id, 50).ok).toBe(true);
    expect(pool.view(id).length).toBe(50);
    expect(pool.byteCapacity(id)).toBe(64);
    expect([...pool.view(id)]).toEqual([...Array(4).fill(7), ...Array(46).fill(0)]);
    pool.release(id);
    expect(pool.view(id).length).toBe(0);
    expect(pool.byteCapacity(id)).toBe(0);
    const next = pool.alloc(40);
    if (!next.ok) throw next.error;
    expect(next.value.id).toBe(id);
    expect(next.value.view).toEqual(new Uint8Array(40));
  });
});
