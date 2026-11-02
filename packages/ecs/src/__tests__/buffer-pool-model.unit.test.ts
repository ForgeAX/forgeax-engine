import { describe, expect, it, vi } from 'vitest';
import { BufferPool } from '../buffer-pool';

describe('BufferPool state model', () => {
  it.each([
    1, 19, 257, 65537,
  ])('preserves owned ranges through churn, growth and trim (seed %s)', (seed) => {
    const pool = new BufferPool();
    const live = new Map<number, Uint8Array>();
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let step = 0; step < 500; step++) {
      const ids = [...live.keys()];
      const id = ids[next() % Math.max(1, ids.length)];
      const action = next() % 4;
      if (id === undefined || (action === 0 && live.size < 32)) {
        const length = next() % 1000;
        const a = pool.alloc(length).unwrap();
        const expected = new Uint8Array(length).fill(step % 251);
        a.view.set(expected);
        live.set(a.id, expected);
      } else if (action === 1) {
        pool.release(id).unwrap();
        live.delete(id);
      } else if (action === 2) {
        const old = live.get(id) as Uint8Array;
        const expected = new Uint8Array(old.length + (next() % 300));
        expected.set(old);
        pool.grow(id, expected.length).unwrap();
        live.set(id, expected);
      } else pool.trim(0, 4);
      expect(pool._liveCount()).toBe(live.size);
      for (const [key, expected] of live) expect(pool.view(key)).toEqual(expected);
    }
    for (const id of live.keys()) pool.release(id);
    pool.trim();
    expect(pool.stats().committedBytes).toBe(0);
  });
  it('keeps both the live prefix and bookkeeping on a controlled growth failure', () => {
    const pool = new BufferPool();
    const owned = pool.alloc(8).unwrap();
    owned.view.fill(73);
    const before = pool.stats();
    const Native = ArrayBuffer;
    vi.stubGlobal(
      'ArrayBuffer',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('controlled');
        }
      },
    );
    let result: ReturnType<BufferPool['grow']>;
    try {
      result = pool.grow(owned.id, 500000);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.ok).toBe(false);
    expect(pool.stats()).toEqual(before);
    expect([...pool.view(owned.id)]).toEqual(Array(8).fill(73));
  });
});
