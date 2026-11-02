import { describe, expect, it, vi } from 'vitest';
import { BufferPool } from '../buffer-pool';

describe('BufferPool allocation admission', () => {
  it('reuses dedicated slot metadata without retaining large backing', () => {
    const pool = new BufferPool();
    const ids = new Set<number>();
    for (let i = 0; i < 128; i++) {
      const allocation = pool.alloc(262_145).unwrap();
      ids.add(allocation.id);
      pool.release(allocation.id);
      expect(pool.backingBuffer(allocation.id)).toBeUndefined();
    }
    expect(ids.size).toBe(1);
    expect(pool._liveCount()).toBe(0);
  });

  it('returns a failed pooled backing allocation without consuming an identity', () => {
    const pool = new BufferPool();
    const Native = ArrayBuffer;
    let failure: unknown;
    let result: ReturnType<BufferPool['alloc']> | undefined;
    vi.stubGlobal(
      'ArrayBuffer',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('controlled backing failure');
        }
      },
    );
    try {
      result = pool.alloc(1024);
    } catch (error) {
      failure = error;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(failure).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(pool._liveCount()).toBe(0);
    expect(pool.alloc(1024).unwrap().id).toBe(1);
  });

  it('prepares expanded slot metadata before changing published allocations', () => {
    const pool = new BufferPool();
    for (let id = 1; id < 64; id++) pool.alloc(16).unwrap().view.fill(id);
    const before = pool.stats();
    const Native = Uint32Array;
    let result: ReturnType<BufferPool['alloc']> | undefined;
    vi.stubGlobal(
      'Uint32Array',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('controlled metadata failure');
        }
      },
    );
    try {
      result = pool.alloc(16);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result?.ok).toBe(false);
    expect(pool.stats()).toEqual(before);
    for (let id = 1; id < 64; id++) expect([...pool.view(id)]).toEqual(new Array(16).fill(id));
    expect(pool.alloc(16).unwrap().id).toBe(64);
  });
});
