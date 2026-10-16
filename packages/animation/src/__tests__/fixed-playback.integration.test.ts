import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer, animationPlugin } from '../index';

describe('fixed animation playback', () => {
  it('rejects an invalid transported cadence before installing World contributions', () => {
    try {
      animationPlugin(undefined, { cadence: 'invalid' as 'fixed' });
      expect.fail('invalid cadence was accepted');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'animation-solver-options-invalid',
        detail: { reason: 'animation cadence must be update or fixed' },
      });
    }
  });
  it('advances the existing player exactly once per fixed step and holds on render-only ticks', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });
    const context = await createWorldContext(world, [
      scenePlugin(),
      animationPlugin(undefined, { cadence: 'fixed' }),
    ]);
    const clip = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 10,
      channels: [],
    });
    const player = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: AnimationPlayer,
          data: { clips: [clip], times: [0], weights: [1], speeds: [1] },
        },
      )
      .unwrap();
    world.update(1 / 240).unwrap();
    expect(world.getResource(FixedTime).tick).toBe(0);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(0);
    world.update(3 / 60).unwrap();
    expect(world.getResource(FixedTime).tick).toBe(3);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBeCloseTo(3 / 60, 10);
    const before = world.get(player, AnimationPlayer).unwrap().times[0];
    world.update(0).unwrap();
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(before);
    await context.fiber.dispose();
  });
});
