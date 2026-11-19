import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { isEcsFault, type SystemFailedError } from '../errors';
import { FixedUpdate, Update, World } from '../index';
import { defineSystem } from '../schedule';
import { Time } from '../time';

describe('M4 world scheduling failure boundary', () => {
  it('stops the frame and poisons the World when a system throws', () => {
    const world = new World();
    const systemToken1 = defineSystem({
      name: 'thrower',
      queries: [],
      fn: () => {
        throw new Error('system');
      },
    });
    world.addSystem(Update, systemToken1);

    const result = world.update(1 / 60);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isEcsFault(result.error, 'system-failed')).toBe(true);
    expect(world.execution.health).toBe('poisoned');
    expect(world.update(1 / 60).ok).toBe(false);
  });

  it('poisons a frame when a system returns an expected command failure', () => {
    const world = new World();
    const failure = new Error('command failure');
    const systemToken2 = defineSystem({
      name: 'result-failure',
      queries: [],
      fn: () => err(failure),
    });
    world.addSystem(Update, systemToken2);

    const result = world.update();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isEcsFault(result.error, 'system-failed')).toBe(true);
      expect((result.error as SystemFailedError).detail.cause).toBe(failure);
    }
    expect(world.execution.health).toBe('poisoned');
  });

  it('advances the clock only for a successful frame and keeps fixed order stable', () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.01, maxStepsPerUpdate: 4 } });
    const order: string[] = [];
    const systemToken3 = defineSystem({
      name: 'update',
      queries: [],
      fn: () => order.push('update'),
    });
    world.addSystem(Update, systemToken3);
    const systemToken4 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: () => order.push('fixed'),
    });
    world.addSystem(FixedUpdate, systemToken4);

    expect(world.update(0.02).ok).toBe(true);
    expect(order).toEqual(['update', 'fixed', 'fixed']);
    expect(world.getResource(Time).elapsed).toBeCloseTo(0.02);
  });
});
