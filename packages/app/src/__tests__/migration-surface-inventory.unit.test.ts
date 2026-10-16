import { Time, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

describe('M4 time ownership inventory', () => {
  it('advances the protected Time resource only through World.update', () => {
    const world = new World();
    expect(() =>
      world.insertResource(Time, { delta: 1, elapsed: 1, maxDeltaSeconds: 1 }),
    ).toThrow();
    world.update(1 / 60).unwrap();
    expect(world.getResource(Time).delta).toBeCloseTo(1 / 60);
  });
});
