import { describe, expect, it, vi } from 'vitest';
import { World } from '../index';

describe('World owned buffers', () => {
  it('keeps foreign and released refusal reasons at every grant entry', () => {
    const world = new World();
    const foreign = new World().buffers.alloc(Uint8Array, 4).unwrap();
    const own = world.buffers.alloc(Uint8Array, 4).unwrap();
    world.buffers.release(own).unwrap();
    const operations = [
      (handle: typeof own) => world.buffers.view(handle),
      (handle: typeof own) => world.buffers.resize(handle, 8),
      (handle: typeof own) => world.buffers.release(handle),
      (handle: typeof own) => world.buffers.borrow(handle),
    ];
    for (const operation of operations) {
      for (const handle of [foreign, {} as typeof own]) {
        expect(operation(handle)).toMatchObject({
          ok: false,
          error: { code: 'memory-handle-invalid', detail: { reason: 'wrong-owner' } },
        });
      }
      expect(operation(own)).toMatchObject({
        ok: false,
        error: { code: 'memory-handle-invalid', detail: { reason: 'released' } },
      });
    }
    expect(world.memoryStats().buffers.liveBuffers).toBe(0);
  });
  it('keeps a retired extent alive through its lease after the grant leaves scope', () => {
    const world = new World();
    const lease = (() => {
      const handle = world.buffers.alloc(Uint32Array, 4).unwrap();
      world.buffers.view(handle).unwrap().fill(37);
      const reader = world.buffers.borrow(handle).unwrap();
      world.buffers.release(handle).unwrap();
      return reader;
    })();
    world.trimMemory().unwrap();
    expect([...lease.view]).toEqual([37, 37, 37, 37]);
    expect(world.memoryStats().readers.pendingRetirements).toBe(1);
    expect(world.memoryStats().buffers.liveBuffers).toBe(1);
    const complete = lease.release;
    complete().unwrap();
    world.trimMemory().unwrap();
    expect(world.memoryStats().buffers).toMatchObject({ liveBuffers: 0, committedBytes: 0 });
    expect(complete()).toMatchObject({
      ok: false,
      error: { code: 'memory-handle-invalid', detail: { reason: 'lease-released' } },
    });
  });
  it('accounts for retained capacity and zero grants until their final reader returns', () => {
    const world = new World();
    const zero = world.buffers.alloc(Uint8Array, 0).unwrap();
    const growing = world.buffers.alloc(Uint8Array, 17).unwrap();
    const expectLive = (liveBuffers: number, logicalBytes: number, liveCapacityBytes: number) =>
      expect(world.memoryStats().buffers).toMatchObject({
        liveBuffers,
        logicalBytes,
        liveCapacityBytes,
      });
    expectLive(2, 17, 64);
    world.buffers.resize(growing, 65).unwrap();
    expectLive(2, 65, 256);
    world.buffers.resize(growing, 0).unwrap();
    expectLive(2, 0, 256);
    const a = world.buffers.borrow(zero).unwrap();
    const b = world.buffers.borrow(growing).unwrap();
    world.buffers.release(zero).unwrap();
    world.buffers.release(growing).unwrap();
    world.trimMemory().unwrap();
    expectLive(2, 0, 256);
    a.release().unwrap();
    expectLive(1, 0, 256);
    b.release().unwrap();
    world.trimMemory().unwrap();
    expectLive(0, 0, 0);
    expect(b.release().ok).toBe(false);
    expect(world.buffers.release(growing).ok).toBe(false);
    expectLive(0, 0, 0);
  });
  it('keeps opaque allocation generations separate from reused physical slots', () => {
    const world = new World();
    const first = world.buffers.alloc(Float32Array, 4).unwrap();
    expect(Object.isFrozen(first)).toBe(true);
    world.buffers.view(first).unwrap().fill(12);
    world.buffers.release(first).unwrap();
    const next = world.buffers.alloc(Float32Array, 4).unwrap();
    expect(next).not.toBe(first);
    expect(world.buffers.view(first).ok).toBe(false);
    expect(world.buffers.release(first).ok).toBe(false);
    expect([...world.buffers.view(next).unwrap()]).toEqual([0, 0, 0, 0]);
    expect(new World().buffers.view(next).ok).toBe(false);
  });
  it('preserves the prefix, clears discarded tails and grows across backing classes', () => {
    const world = new World();
    const buffer = world.buffers.alloc(Uint32Array, 2).unwrap();
    world.buffers.view(buffer).unwrap().set([17, 19]);
    world.buffers.resize(buffer, 1024).unwrap();
    expect([...world.buffers.view(buffer).unwrap().slice(0, 3)]).toEqual([17, 19, 0]);
    world.buffers.resize(buffer, 1).unwrap();
    world.buffers.resize(buffer, 3).unwrap();
    expect([...world.buffers.view(buffer).unwrap()]).toEqual([17, 0, 0]);
  });
  it('defers reuse until every real reader returns and rejects duplicate completion', () => {
    const world = new World();
    const buffer = world.buffers.alloc(Float64Array, 8).unwrap();
    world.buffers.view(buffer).unwrap().fill(42);
    const a = world.buffers.borrow(buffer).unwrap();
    const b = world.buffers.borrow(buffer).unwrap();
    expect(world.buffers.resize(buffer, 16).ok).toBe(false);
    world.buffers.release(buffer).unwrap();
    expect(world.memoryStats().readers).toMatchObject({ leases: 2, pendingRetirements: 1 });
    a.release().unwrap();
    expect(b.view[0]).toBe(42);
    expect(world.memoryStats().buffers.liveBuffers).toBe(1);
    b.release().unwrap();
    expect(world.memoryStats().buffers.liveBuffers).toBe(0);
    const next = world.buffers.alloc(Float64Array, 8).unwrap();
    world.buffers.view(next).unwrap()[0] = 61;
    expect(b.release().ok).toBe(false);
    expect(world.buffers.view(next).unwrap()[0]).toBe(61);
    expect(world.memoryStats().readers).toMatchObject({ leases: 0, pendingRetirements: 0 });
  });
  it('trims free backing without invalidating live buffers or retaining retired handles', () => {
    const world = new World();
    const a = world.buffers.alloc(Uint8Array, 16).unwrap();
    const b = world.buffers.alloc(Uint8Array, 16).unwrap();
    world.buffers.view(b).unwrap()[0] = 8;
    world.buffers.release(a).unwrap();
    world.trimMemory().unwrap();
    expect(world.buffers.view(b).unwrap()[0]).toBe(8);
    world.buffers.release(b).unwrap();
    world.trimMemory().unwrap();
    expect(world.memoryStats().buffers.committedBytes).toBe(0);
    expect(world.memoryStats().buffers).not.toHaveProperty('slotCapacity');
    expect(world.memoryStats().buffers).not.toHaveProperty('metadataBytes');
    for (let i = 0; i < 300; i++) {
      const h = world.buffers.alloc(Uint8Array, 270000).unwrap();
      world.buffers.release(h).unwrap();
    }
    expect(world.memoryStats().buffers.liveBuffers).toBe(0);
    expect(world.memoryStats().buffers.committedBytes).toBe(0);
  });
  it('enforces backing budgets and preserves an accepted buffer on rejected growth', () => {
    const world = new World({ memory: { buffers: { maxBytes: 1024 } } });
    const buffer = world.buffers.alloc(Uint8Array, 1024).unwrap();
    world.buffers.view(buffer).unwrap()[0] = 29;
    const failed = world.buffers.resize(buffer, 2048);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('memory-budget-exceeded');
    expect(world.buffers.view(buffer).unwrap()[0]).toBe(29);
    expect(world.buffers.view(buffer).unwrap().length).toBe(1024);
  });
  it('keeps public ownership unchanged after a backing admission failure', () => {
    const world = new World();
    const first = world.buffers.alloc(Uint8Array, 1024).unwrap();
    world.buffers.view(first).unwrap()[0] = 37;
    const before = world.memoryStats().buffers;
    const Native = ArrayBuffer;
    vi.stubGlobal(
      'ArrayBuffer',
      class extends Native {
        constructor() {
          super(0);
          throw new RangeError('controlled owned backing failure');
        }
      },
    );
    try {
      const failed = world.buffers.alloc(Uint8Array, 2048);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('memory-allocation-failed');
      expect(world.memoryStats().buffers).toEqual(before);
      expect(world.buffers.view(first).unwrap()[0]).toBe(37);
    } finally {
      vi.unstubAllGlobals();
    }
    const retry = world.buffers.alloc(Uint8Array, 2048).unwrap();
    expect(world.memoryStats().buffers.liveBuffers).toBe(before.liveBuffers + 1);
    world.buffers.release(retry).unwrap();
    world.buffers.release(first).unwrap();
  });
});

it('keeps 2KiB retained buffers in their actual class through reader retirement', () => {
  const world = new World();
  const owners = Array.from({ length: 64 }, () => world.buffers.alloc(Uint8Array, 2048).unwrap());
  const readers = owners.map((owner, index) => {
    world.buffers.view(owner).unwrap()[0] = index;
    return world.buffers.borrow(owner).unwrap();
  });
  expect(world.memoryStats().buffers.liveCapacityBytes).toBe(64 * 2048);
  for (const owner of owners) world.buffers.release(owner).unwrap();
  expect(world.memoryStats().readers.pendingRetirements).toBe(64);
  readers.forEach((reader, index) => {
    expect(reader.view[0]).toBe(index);
    reader.release().unwrap();
  });
  world.trimMemory();
  expect(world.memoryStats().buffers.liveBuffers).toBe(0);
  expect(world.memoryStats().buffers.committedBytes).toBe(0);
});

it('refreshes leased windows after logical resize and growth without touching adjacent storage', () => {
  const world = new World();
  const guard = world.buffers.alloc(Float32Array, 4).unwrap();
  const buffer = world.buffers.alloc(Float32Array, 4).unwrap();
  world.buffers.view(guard).unwrap().fill(71);
  world.buffers.view(buffer).unwrap().set([1, 2, 3, 4]);
  const first = world.buffers.borrow(buffer).unwrap();
  expect(first.view.byteOffset).toBeGreaterThan(0);
  expect([...first.view]).toEqual([1, 2, 3, 4]);
  expect(world.buffers.resize(buffer, 2).ok).toBe(false);
  first.release().unwrap();
  world.buffers.resize(buffer, 2).unwrap();
  const shorter = world.buffers.borrow(buffer).unwrap();
  expect([...shorter.view]).toEqual([1, 2]);
  shorter.release().unwrap();
  world.buffers.resize(buffer, 512).unwrap();
  const grown = world.buffers.borrow(buffer).unwrap();
  expect(grown.view.length).toBe(512);
  expect([...grown.view.slice(0, 5)]).toEqual([1, 2, 0, 0, 0]);
  expect([...world.buffers.view(guard).unwrap()]).toEqual([71, 71, 71, 71]);
  world.buffers.release(buffer).unwrap();
  expect(grown.view[1]).toBe(2);
  grown.release().unwrap();
  world.buffers.release(guard).unwrap();
});

it('keeps detached release callbacks independent after later borrows and slot reuse', () => {
  const world = new World();
  const buffer = world.buffers.alloc(Uint32Array, 4).unwrap();
  const first = world.buffers.borrow(buffer).unwrap();
  const completeFirst = first.release;
  completeFirst().unwrap();
  const second = world.buffers.borrow(buffer).unwrap();
  expect(completeFirst().ok).toBe(false);
  world.buffers.release(buffer).unwrap();
  expect(world.memoryStats().readers).toMatchObject({ leases: 1, pendingRetirements: 1 });
  second.release().unwrap();
  const replacement = world.buffers.alloc(Uint32Array, 4).unwrap();
  world.buffers.view(replacement).unwrap()[0] = 91;
  expect(completeFirst().ok).toBe(false);
  expect(world.buffers.view(replacement).unwrap()[0]).toBe(91);
  world.buffers.release(replacement).unwrap();
});

it('bounds slab maintenance independently of live dedicated backing', () => {
  const world = new World({ memory: { buffers: { retainBytes: 0 } } });
  const live = Array.from({ length: 100 }, () => world.buffers.alloc(Uint8Array, 1024).unwrap());
  const small = world.buffers.alloc(Uint8Array, 16).unwrap();
  expect(world.memoryStats().buffers.committedBytes).toBe(100 * 1024 + 65536);
  world.buffers.release(small).unwrap();
  expect(world.memoryStats().buffers.committedBytes).toBe(100 * 1024);
  for (const handle of live) {
    expect(world.buffers.view(handle).unwrap().length).toBe(1024);
    world.buffers.release(handle).unwrap();
  }
});

it('advances bounded slab maintenance even when every page is live', () => {
  const world = new World({ memory: { buffers: { retainBytes: 0 } } });
  world.buffers.alloc(Uint8Array, 16).unwrap();
  world.buffers.alloc(Uint8Array, 64).unwrap();
  for (let index = 0; index < 512; index++) world.buffers.alloc(Uint8Array, 256).unwrap();
  const lastPage = world.buffers.alloc(Uint8Array, 256).unwrap();

  world.buffers.maintain();
  expect(world.memoryStats().buffers.committedBytes).toBe(5 * 65536);
  world.buffers.release(lastPage).unwrap();
  expect(world.memoryStats().buffers.committedBytes).toBe(4 * 65536);
});

it('reclaims an unpublished extent when a growth copy fails', () => {
  const world = new World();
  const handle = world.buffers.alloc(Uint8Array, 1024).unwrap();
  const view = world.buffers.view(handle).unwrap();
  view.fill(37);
  const Native = Uint8Array;
  vi.stubGlobal(
    'Uint8Array',
    class extends Native {
      constructor() {
        super(0);
        throw new RangeError('controlled post-allocation copy failure');
      }
    },
  );
  try {
    expect(world.buffers.resize(handle, 2048).ok).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(world.buffers.view(handle).unwrap()).toBe(view);
  expect([...view]).toEqual(Array(1024).fill(37));
  world.trimMemory().unwrap();
  expect(world.memoryStats().buffers).toMatchObject({
    liveBuffers: 1,
    logicalBytes: 1024,
    liveCapacityBytes: 1024,
    committedBytes: 1024,
    copiedBytes: 0,
    zeroedBytes: 0,
  });
});

it('reclaims reused backing when tail initialization fails before publication', () => {
  const world = new World();
  const dirty = world.buffers.alloc(Uint8Array, 2048).unwrap();
  world.buffers.view(dirty).unwrap().fill(9);
  world.buffers.release(dirty).unwrap();
  const handle = world.buffers.alloc(Uint8Array, 1024).unwrap();
  const view = world.buffers.view(handle).unwrap();
  view.fill(51);
  const Native = Uint8Array;
  vi.stubGlobal(
    'Uint8Array',
    class extends Native {
      constructor() {
        super(0);
        throw new RangeError('controlled tail initialization failure');
      }
    },
  );
  try {
    expect(world.buffers.resize(handle, 1500).ok).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(world.buffers.view(handle).unwrap()).toBe(view);
  expect([...view]).toEqual(Array(1024).fill(51));
  world.trimMemory().unwrap();
  expect(world.memoryStats().buffers).toMatchObject({
    liveBuffers: 1,
    committedBytes: 1024,
    copiedBytes: 0,
    zeroedBytes: 0,
  });
});
