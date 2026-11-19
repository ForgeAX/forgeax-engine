import { describe, expect, it, vi } from 'vitest';
import { type BufferHandle, OwnedBuffers } from '../owned-buffers';
import {
  ExtentStore,
  extentBlock,
  extentByteOffset,
  extentLocation,
} from '../storage/extent-store';

it('preserves complete block identities and aligned byte offsets without 32-bit truncation', () => {
  expect(extentLocation(0)).toBe(0);
  for (const block of [1, 32767, 32768, 65536, 0xffffffff]) {
    for (const offset of [0, 16, 64, 256, 65520]) {
      const location = extentLocation(block, offset);
      expect(Number.isSafeInteger(location)).toBe(true);
      expect(extentBlock(location)).toBe(block);
      expect(extentByteOffset(location)).toBe(offset);
    }
  }
});

it('keeps every cell distinct across a full page, reuse and the next page', () => {
  const store = new ExtentStore();
  const locations = Array.from({ length: 4097 }, (_, index) => {
    const location = store.allocate(16);
    new Uint8Array(store.bufferAt(location), extentByteOffset(location), 16).fill(index % 251);
    return location;
  });
  expect(new Set(locations).size).toBe(4097);
  expect(store.bufferAt(locations[0] as number)).toBe(store.bufferAt(locations[4095] as number));
  expect(store.bufferAt(locations[4096] as number)).not.toBe(
    store.bufferAt(locations[0] as number),
  );
  for (const [index, location] of locations.entries()) {
    expect([...new Uint8Array(store.bufferAt(location), extentByteOffset(location), 16)]).toEqual(
      Array(16).fill(index % 251),
    );
  }
  const freed = locations[4096] as number;
  store.releaseLocation(freed);
  expect(store.allocate(16)).toBe(freed);
  expect(store.reused).toBe(true);
  for (const location of locations) store.releaseLocation(location);
  store.trimPages(0);
  expect(store.backingStats()).toMatchObject({ blocks: 0, committedBytes: 0, idleBytes: 0 });
});

// These cases follow the public owner across the removal of numeric backing IDs.
describe('owned backing admission and lifetime', () => {
  it.each([
    [16, 16],
    [17, 64],
    [64, 64],
    [65, 256],
    [256, 256],
    [257, 1024],
    [1024, 1024],
    [1025, 2048],
    [2048, 2048],
    [2049, 4096],
    [4096, 4096],
    [4097, 16384],
    [16384, 16384],
    [16385, 65536],
    [65536, 65536],
    [65537, 262144],
    [262144, 262144],
    [262145, 262145],
  ])('retains the owned capacity policy for request%s ->capacity%s', (requested, capacity) => {
    const buffers = new OwnedBuffers();
    const h = buffers.alloc(Uint8Array, requested).unwrap();
    expect(buffers.view(h).unwrap().byteLength).toBe(requested);
    expect(buffers.memoryStats().logicalBytes).toBe(requested);
    expect(buffers.memoryStats().liveCapacityBytes).toBe(capacity);
  });
  it('releases odd exact dedicated backing without reviving an old grant', () => {
    const buffers = new OwnedBuffers();
    const grants = new Set<BufferHandle>();
    for (let i = 0; i < 128; i++) {
      const handle = buffers.alloc(Uint8Array, 262145).unwrap();
      grants.add(handle);
      expect(buffers.view(handle).unwrap().length).toBe(262145);
      buffers.release(handle).unwrap();
      expect(buffers.view(handle).ok).toBe(false);
      expect(buffers.memoryStats().committedBytes).toBe(0);
    }
    expect(grants.size).toBe(128);
    expect(buffers.memoryStats().liveBuffers).toBe(0);
  });
  it('refuses a failed backing allocation without publishing an owner', () => {
    const buffers = new OwnedBuffers();
    const before = buffers.memoryStats();
    const Native = ArrayBuffer;
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
      const result = buffers.alloc(Uint8Array, 1024);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('memory-allocation-failed');
      expect(buffers.memoryStats()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
    const retry = buffers.alloc(Uint8Array, 1024).unwrap();
    expect(buffers.view(retry).unwrap()).toEqual(new Uint8Array(1024));
    expect(buffers.memoryStats().liveBuffers).toBe(1);
  });
  it('grows owner count without allocating another typed slot table', () => {
    const buffers = new OwnedBuffers();
    const grants = Array.from({ length: 63 }, (_, index) => {
      const handle = buffers.alloc(Uint8Array, 16).unwrap();
      buffers
        .view(handle)
        .unwrap()
        .fill(index + 1);
      return handle;
    });
    const Native = Uint32Array;
    vi.stubGlobal(
      'Uint32Array',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('no slot metadata should be allocated');
        }
      },
    );
    try {
      buffers.alloc(Uint8Array, 16).unwrap();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(buffers.memoryStats().liveBuffers).toBe(64);
    grants.forEach((handle, index) => {
      expect([...buffers.view(handle).unwrap()]).toEqual(Array(16).fill(index + 1));
    });
  });
  it('caches live views and preserves them on failed resize', () => {
    const buffers = new OwnedBuffers({ maxBytes: 65536 + 1024 });
    const handle = buffers.alloc(Uint8Array, 8).unwrap();
    const view = buffers.view(handle).unwrap();
    view.fill(7);
    expect(buffers.view(handle).unwrap()).toBe(view);
    expect(buffers.resize(handle, 65537).ok).toBe(false);
    expect(buffers.view(handle).unwrap()).toBe(view);
    buffers.resize(handle, 4).unwrap();
    const shorter = buffers.view(handle).unwrap();
    expect(shorter).not.toBe(view);
    expect([...view]).toEqual([7, 7, 7, 7, 0, 0, 0, 0]);
    buffers.resize(handle, 12).unwrap();
    const larger = buffers.view(handle).unwrap();
    expect(larger).not.toBe(shorter);
    expect([...larger]).toEqual([7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
    buffers.resize(handle, 1024).unwrap();
    expect(buffers.view(handle).unwrap().buffer).not.toBe(larger.buffer);
    buffers.release(handle).unwrap();
    expect(buffers.view(handle).ok).toBe(false);
    const next = buffers.alloc(Uint8Array, 16).unwrap();
    expect(next).not.toBe(handle);
    expect(buffers.view(next).unwrap()).not.toBe(larger);
  });
  it('cannot resize a released grant or let it affect its replacement', () => {
    const buffers = new OwnedBuffers();
    const handle = buffers.alloc(Uint8Array, 12).unwrap();
    buffers.release(handle).unwrap();
    expect(buffers.resize(handle, 64).ok).toBe(false);
    expect(buffers.resize(handle, 8).ok).toBe(false);
    const next = buffers.alloc(Uint8Array, 16).unwrap();
    expect(buffers.memoryStats().liveCapacityBytes).toBe(16);
    expect(buffers.view(next).unwrap()).toEqual(new Uint8Array(16));
  });
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
  ])('rejects invalid logical length %s without changing live bytes', (length) => {
    const buffers = new OwnedBuffers();
    const handle = buffers.alloc(Uint8Array, 8).unwrap();
    const view = buffers.view(handle).unwrap();
    view.fill(7);
    expect(buffers.resize(handle, length).ok).toBe(false);
    expect(buffers.view(handle).unwrap()).toBe(view);
    expect(view).toEqual(new Uint8Array(8).fill(7));
  });
  it('keeps logical length, capacity and zeroed tails together across growth', () => {
    const buffers = new OwnedBuffers();
    const handle = buffers.alloc(Uint8Array, 8).unwrap();
    buffers.view(handle).unwrap().fill(7);
    buffers.resize(handle, 4).unwrap();
    buffers.resize(handle, 50).unwrap();
    expect(buffers.memoryStats().liveCapacityBytes).toBe(64);
    expect([...buffers.view(handle).unwrap()]).toEqual([...Array(4).fill(7), ...Array(46).fill(0)]);
    buffers.release(handle).unwrap();
    const next = buffers.alloc(Uint8Array, 40).unwrap();
    expect(buffers.view(next).unwrap()).toEqual(new Uint8Array(40));
  });
  it('clears only the reused tail beyond a growth copy', () => {
    const buffers = new OwnedBuffers();
    const dirty = buffers.alloc(Uint8Array, 2000).unwrap();
    buffers.view(dirty).unwrap().fill(9);
    buffers.release(dirty).unwrap();
    const handle = buffers.alloc(Uint8Array, 700).unwrap();
    buffers.view(handle).unwrap().fill(5);
    const before = buffers.memoryStats();
    buffers.resize(handle, 1500).unwrap();
    expect(buffers.memoryStats().zeroedBytes - before.zeroedBytes).toBe(2048 - 700);
    expect(buffers.memoryStats().copiedBytes - before.copiedBytes).toBe(700);
    expect([...buffers.view(handle).unwrap()]).toEqual([
      ...Array(700).fill(5),
      ...Array(800).fill(0),
    ]);
    buffers.resize(handle, 2048).unwrap();
    expect(
      buffers
        .view(handle)
        .unwrap()
        .subarray(700)
        .every((byte) => byte === 0),
    ).toBe(true);
  });
  it('clears dirty slab cells beyond a growth copy', () => {
    const buffers = new OwnedBuffers();
    const cells = Array.from({ length: 8 }, () => {
      const handle = buffers.alloc(Uint8Array, 64).unwrap();
      buffers.view(handle).unwrap().fill(3);
      return handle;
    });
    for (const handle of cells) buffers.release(handle).unwrap();
    const handle = buffers.alloc(Uint8Array, 10).unwrap();
    buffers.view(handle).unwrap().fill(6);
    buffers.resize(handle, 60).unwrap();
    expect([...buffers.view(handle).unwrap()]).toEqual([
      ...Array(10).fill(6),
      ...Array(50).fill(0),
    ]);
    buffers.resize(handle, 64).unwrap();
    expect(
      buffers
        .view(handle)
        .unwrap()
        .subarray(10)
        .every((byte) => byte === 0),
    ).toBe(true);
  });
  it.each([
    1, 19, 257, 65537,
  ])('preserves all live bytes through churn, growth and trim (seed %s)', (seed) => {
    const buffers = new OwnedBuffers({ retainBytes: 0 });
    const live = new Map<BufferHandle<Uint8Array>, Uint8Array>();
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let step = 0; step < 500; step++) {
      const handles = [...live.keys()];
      const handle = handles[next() % Math.max(1, handles.length)];
      const action = next() % 4;
      if (handle === undefined || (action === 0 && live.size < 32)) {
        const length = next() % 1000;
        const fresh = buffers.alloc(Uint8Array, length).unwrap();
        const expected = new Uint8Array(length).fill(step % 251);
        buffers.view(fresh).unwrap().set(expected);
        live.set(fresh, expected);
      } else if (action === 1) {
        buffers.release(handle).unwrap();
        live.delete(handle);
      } else if (action === 2) {
        const old = live.get(handle) as Uint8Array;
        const expected = new Uint8Array(old.length + (next() % 300));
        expected.set(old);
        buffers.resize(handle, expected.length).unwrap();
        live.set(handle, expected);
      } else buffers.maintain();
      expect(buffers.memoryStats().liveBuffers).toBe(live.size);
      for (const [key, expected] of live) expect(buffers.view(key).unwrap()).toEqual(expected);
    }
    for (const handle of live.keys()) buffers.release(handle).unwrap();
    buffers.trim();
    expect(buffers.memoryStats().committedBytes).toBe(0);
  });
  it('keeps old bytes, view and counters on controlled backing growth failure', () => {
    const buffers = new OwnedBuffers();
    const handle = buffers.alloc(Uint8Array, 8).unwrap();
    const view = buffers.view(handle).unwrap();
    view.fill(73);
    const before = buffers.memoryStats();
    const Native = ArrayBuffer;
    vi.stubGlobal(
      'ArrayBuffer',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('controlled growth failure');
        }
      },
    );
    try {
      expect(buffers.resize(handle, 500000).ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(buffers.memoryStats()).toEqual(before);
    expect(buffers.view(handle).unwrap()).toBe(view);
    expect([...view]).toEqual(Array(8).fill(73));
  });
});
