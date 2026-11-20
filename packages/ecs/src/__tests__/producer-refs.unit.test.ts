import { describe, expect, it, vi } from 'vitest';
import { defineSystem, Update, World } from '../index';
import { releaseUnadoptedUniqueRef } from '../internal';

describe('unadopted managed allocation cancellation', () => {
  it('retires the producer payload exactly once without creating a temporary holder entity', () => {
    const world = new World();
    const cleanup = vi.fn();
    const payload = { source: 'candidate' };
    const handle = world.allocUniqueRef('UnadoptedFixture', payload, cleanup);
    releaseUnadoptedUniqueRef(world, handle).unwrap();
    expect(world.resolveUniqueRef(handle).ok).toBe(false);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(payload);
    expect(world.inspect().entityCount).toBe(0);
    expect(releaseUnadoptedUniqueRef(world, handle).ok).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps a reused allocation independent of an older producer cancellation', () => {
    const world = new World();
    const first = world.allocUniqueRef('UnadoptedFixture', { generation: 1 });
    releaseUnadoptedUniqueRef(world, first).unwrap();
    const cleanup = vi.fn();
    const payload = { generation: 2 };
    const next = world.allocUniqueRef('UnadoptedFixture', payload, cleanup);
    expect(releaseUnadoptedUniqueRef(world, first)).toMatchObject({
      ok: false,
      error: { code: 'unique-ref-stale' },
    });
    expect(world.resolveUniqueRef(next).unwrap()).toBe(payload);
    expect(cleanup).not.toHaveBeenCalled();
    releaseUnadoptedUniqueRef(world, next).unwrap();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not mutate a poisoned World during a producer cleanup attempt', () => {
    const world = new World();
    const cleanup = vi.fn();
    const handle = world.allocUniqueRef('UnadoptedFixture', { value: 1 }, cleanup);
    world
      .addSystem(
        Update,
        defineSystem({
          name: 'poison-producer-fixture',
          queries: [],
          fn: () => {
            throw new Error('fixture failure');
          },
        }),
      )
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(false);
    expect(releaseUnadoptedUniqueRef(world, handle)).toMatchObject({
      ok: false,
      error: { code: 'world-poisoned' },
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(world.resolveUniqueRef(handle).ok).toBe(true);
  });
});
