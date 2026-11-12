import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, defineSchedule, FixedUpdate, Update, World } from '../index';

describe('World frame memory lifetime', () => {
  it('preserves allocations across systems and fixed ticks, then reuses warm backing', () => {
    const world = new World();
    const views: Uint32Array[] = [];
    world
      .addSystem(FixedUpdate, {
        name: 'fixed-scratch',
        queries: [],
        fn: (world) => {
          const view = world.frameArena.alloc(Uint32Array, 16).unwrap();
          view.fill(views.length + 1);
          views.push(view);
        },
      })
      .unwrap();
    world
      .addSystem(Update, {
        name: 'check-scratch',
        after: [FixedUpdate],
        queries: [],
        fn: (world) => {
          for (let i = 0; i < views.length; i++) expect(views[i]?.[0]).toBe(i + 1);
          expect(world.frameArena.alloc(Float64Array, 8).unwrap().byteOffset % 8).toBe(0);
        },
      })
      .unwrap();
    world.update(3 / 60).unwrap();
    expect(views).toHaveLength(3);
    expect(world.frameArena.isActive).toBe(false);
    const allocations = world.memoryStats().arena.backingAllocations;
    views.length = 0;
    world.update(3 / 60).unwrap();
    expect(world.memoryStats().arena.backingAllocations).toBe(allocations);
    expect(world.frameArena.alloc(Uint32Array, 1).ok).toBe(false);
  });
  it('keeps command input until flush and copies accepted component data out of the arena', () => {
    const Values = defineComponent('ArenaCommandValues', { values: 'array<u32>' });
    const world = new World();
    let frame = 0;
    world
      .addSystem(Update, {
        name: 'spawn-from-arena',
        queries: [],
        fn: (world, _, commands) => {
          const values = world.frameArena.alloc(Uint32Array, 2).unwrap();
          values.fill(++frame);
          commands.spawn({ component: Values, data: { values } });
        },
      })
      .unwrap();
    world.update().unwrap();
    world.update().unwrap();
    const values: number[][] = [];
    for (const row of world.query({ read: [Values] }).unwrap())
      values.push([...row.get(Values).values]);
    expect(values).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
  it('groups synchronous domain runs without closing a previous phase range', () => {
    const world = new World();
    const first = defineSchedule('ArenaFirst');
    const second = defineSchedule('ArenaSecond');
    let prior: Uint8Array;
    world
      .addSystem(first, {
        name: 'first',
        queries: [],
        fn: (world) => {
          prior = world.frameArena.alloc(Uint8Array, 50000).unwrap();
          prior.fill(81);
        },
      })
      .unwrap();
    world
      .addSystem(second, {
        name: 'second',
        queries: [],
        fn: (world) => {
          world.frameArena.alloc(Float64Array, 20000).unwrap().fill(3);
          expect(prior[49999]).toBe(81);
        },
      })
      .unwrap();
    world
      .withFrameArena(() => {
        world.run(first).unwrap();
        return world.run(second);
      })
      .unwrap();
    expect(world.memoryStats().arena.active).toBe(false);
    expect(world.memoryStats().arena.chunks).toBe(2);
  });
  it('closes on a system exception and preserves World poisoning', () => {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'fail',
        queries: [],
        fn: (world) => {
          world.frameArena.alloc(Uint8Array, 4).unwrap();
          throw new Error('failure');
        },
      })
      .unwrap();
    expect(world.update().ok).toBe(false);
    expect(world.memoryStats().arena.active).toBe(false);
    expect(world.execution.health).toBe('poisoned');
  });
  it('rejects reentrant simulation update without resetting active scratch', () => {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'nested',
        queries: [],
        fn: (world) => {
          const bytes = world.frameArena.alloc(Uint8Array, 1).unwrap();
          bytes[0] = 7;
          expect(world.update().ok).toBe(false);
          expect(bytes[0]).toBe(7);
        },
      })
      .unwrap();
    world.update().unwrap();
  });
  it('checks budgets and integer layout before changing arena usage', () => {
    const world = new World({ memory: { arena: { maxBytes: 128, maxScopeBytes: 64 } } });
    world
      .withFrameArena(() => {
        world.frameArena.alloc(Float64Array, 8).unwrap().fill(9);
        const before = world.memoryStats().arena;
        expect(world.frameArena.alloc(Float64Array, 1).ok).toBe(false);
        expect(world.frameArena.alloc(Uint8Array, Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
        expect(world.memoryStats().arena).toEqual(before);
        return ok(undefined);
      })
      .unwrap();
    world.trimMemory().unwrap();
    expect(world.memoryStats().arena.committedBytes).toBe(0);
  });
  it('retires cold spikes after an ordinary frame and never clears capacity during reset', () => {
    const world = new World({ memory: { arena: { retainBytes: 65536 } } });
    world
      .withFrameArena(() => {
        world.frameArena.alloc(Uint8Array, 65536).unwrap().fill(23);
        world.frameArena.alloc(Uint8Array, 2_000_000).unwrap();
        return ok(undefined);
      })
      .unwrap();
    world
      .withFrameArena(() => {
        expect(world.frameArena.alloc(Uint8Array, 1).unwrap()[0]).toBe(23);
        return ok(undefined);
      })
      .unwrap();
    expect(world.memoryStats().arena.committedBytes).toBe(65536);
  });
  it('preserves admitted ranges and accounting when a later chunk fails', () => {
    const world = new World();
    world
      .withFrameArena(() => {
        const first = world.frameArena.alloc(Uint8Array, 65536).unwrap();
        first.fill(73);
        const before = world.memoryStats().arena;
        const Native = ArrayBuffer;
        vi.stubGlobal(
          'ArrayBuffer',
          class extends Native {
            constructor() {
              super(0);
              throw new RangeError('controlled arena backing failure');
            }
          },
        );
        try {
          const failed = world.frameArena.alloc(Uint8Array, 65536);
          expect(failed.ok).toBe(false);
          if (!failed.ok) expect(failed.error.code).toBe('memory-allocation-failed');
          expect(world.memoryStats().arena).toEqual(before);
          expect(first[65535]).toBe(73);
        } finally {
          vi.unstubAllGlobals();
        }
        world.frameArena.alloc(Float64Array, 8192).unwrap().fill(9);
        expect(first[65535]).toBe(73);
        return ok(undefined);
      })
      .unwrap();
    expect(world.execution.health).toBe('healthy');
    expect(world.frameArena.isActive).toBe(false);
  });
  it('closes a returned failure without poisoning and rejects asynchronous frame wrappers', () => {
    const world = new World();
    const failed = world.withFrameArena(() => {
      world.frameArena.alloc(Uint8Array, 4).unwrap();
      return err('expected');
    });
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('healthy');
    expect(world.frameArena.isActive).toBe(false);
    const asynchronous = world.withFrameArena(
      // @ts-expect-error Asynchronous callbacks violate the frame lifetime.
      () => Promise.resolve(ok(undefined)),
    );
    expect(asynchronous.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(world.frameArena.isActive).toBe(false);
  });
  it('closes and poisons an unknown callback exception', () => {
    const world = new World();
    const failed = world.withFrameArena(() => {
      world.frameArena.alloc(Uint8Array, 4).unwrap();
      throw new Error('unknown');
    });
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(world.frameArena.isActive).toBe(false);
  });
  it('rejects a suspended system before another frame can reuse its scratch', async () => {
    const world = new World();
    const Marker = defineComponent('SuspendedArenaCommand', {});
    let resume = () => {};
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const completions: Promise<void>[] = [];
    let invocations = 0;
    world
      .addSystem(Update, {
        name: 'suspended-scratch-reader',
        queries: [],
        fn: (world, _queries, commands) => {
          invocations++;
          commands.spawn({ component: Marker, data: {} });
          const bytes = world.frameArena.alloc(Uint8Array, 8).unwrap();
          bytes.fill(43);
          const completion = suspended.then(() => {
            expect(bytes[0]).toBe(43);
            expect(world.frameArena.alloc(Uint8Array, 1).ok).toBe(false);
          });
          completions.push(completion);
          return completion;
        },
      })
      .unwrap();
    const first = world.update();
    const following = world.update();
    resume();
    await Promise.all(completions);
    expect(first.ok).toBe(false);
    if (!first.ok)
      expect(first.error).toMatchObject({
        code: 'system-failed',
        cause: { code: 'memory-scope-invalid', detail: { reason: 'asynchronous' } },
      });
    expect(following.ok).toBe(false);
    expect(invocations).toBe(1);
    expect(world.inspect().entityCount).toBe(0);
    expect(world.execution.health).toBe('poisoned');
    expect(world.frameArena.isActive).toBe(false);
  });
  it('rejects a generator system without advancing its suspended body', () => {
    const world = new World();
    function* suspended(world: World) {
      world.frameArena.alloc(Uint8Array, 1).unwrap();
      yield;
    }
    world.addSystem(Update, { name: 'generator', queries: [], fn: suspended }).unwrap();
    expect(world.update().ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(world.memoryStats().arena.backingAllocations).toBe(0);
  });
});
