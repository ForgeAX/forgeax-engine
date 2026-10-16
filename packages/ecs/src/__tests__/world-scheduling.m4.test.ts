import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { SystemFailedError } from '../errors';
import { FixedUpdate, Update, World } from '../index';

describe('M4 world scheduling failure boundary', () => {
  it('stops the frame and poisons the World when a system throws', () => {
    const world = new World();
    world.addSystem(Update, {
      name: 'thrower',
      queries: [],
      fn: () => {
        throw new Error('system');
      },
    });

    const result = world.update(1 / 60);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SystemFailedError);
    expect(world.execution.health).toBe('poisoned');
    expect(world.update(1 / 60).ok).toBe(false);
  });

  it('poisons a frame when a system returns an expected command failure', () => {
    const world = new World();
    const failure = new Error('command failure');
    world.addSystem(Update, { name: 'result-failure', queries: [], fn: () => err(failure) });

    const result = world.update();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SystemFailedError);
      expect((result.error as SystemFailedError).detail.cause).toBe(failure);
    }
    expect(world.execution.health).toBe('poisoned');
  });

  it('advances the clock only for a successful frame and keeps fixed order stable', () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.01, maxStepsPerUpdate: 4 } });
    const order: string[] = [];
    world.addSystem(Update, { name: 'update', queries: [], fn: () => order.push('update') });
    world.addSystem(FixedUpdate, {
      name: 'fixed',
      queries: [],
      fn: () => order.push('fixed'),
    });

    expect(world.update(0.02).ok).toBe(true);
    expect(order).toEqual(['update', 'fixed', 'fixed']);
    expect(world.getResource<{ elapsed: number }>('Time').elapsed).toBeCloseTo(0.02);
  });
});
