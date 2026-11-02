import { describe, expect, it, vi } from 'vitest';
import { World } from '../index';

describe('World owned buffers', () => {
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
    expect(world.memoryStats().buffers.liveSlots).toBe(1);
    b.release().unwrap();
    expect(world.memoryStats().buffers.liveSlots).toBe(0);
    const next = world.buffers.alloc(Float64Array, 8).unwrap();
    world.buffers.view(next).unwrap()[0] = 61;
    expect(b.release().ok).toBe(false);
    expect(world.buffers.view(next).unwrap()[0]).toBe(61);
    expect(world.memoryStats().readers).toMatchObject({ leases: 0, pendingRetirements: 0 });
  });
  it('trims free cells without invalidating live buffers and reuses trimmed slot metadata', () => {
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
    const capacity = world.memoryStats().buffers.slotCapacity;
    for (let i = 0; i < 300; i++) {
      const h = world.buffers.alloc(Uint8Array, 270000).unwrap();
      world.buffers.release(h).unwrap();
    }
    expect(world.memoryStats().buffers.slotCapacity).toBe(capacity);
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
    expect(world.memoryStats().buffers.liveSlots).toBe(before.liveSlots + 1);
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
  expect(world.memoryStats().buffers.liveSlots).toBe(0);
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
