import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, MorphWeights, Name, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { animationPlugin } from '../plugin';

const TARGET_ID = 'b95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;

function weightsClip(): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId: TARGET_ID,
        property: 'weights',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 0, 1, 2, 3, 4]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

async function setupTarget(
  withWeights: boolean,
): Promise<{ world: World; player: EntityHandle; target: EntityHandle }> {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  await createWorldContext(world, [animationPlugin()]);
  const clip = world.allocSharedRef('AnimationClip', weightsClip());
  const player = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  world.addComponent(player, { component: Name, data: { value: 'Root' } }).unwrap();
  world
    .addComponent(player, {
      component: AnimationPlayer,
      data: { clips: [clip], times: [0], weights: [1], speeds: [0], paused: true },
    })
    .unwrap();
  const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  world.addComponent(target, { component: Name, data: { value: 'Morph' } }).unwrap();
  world.addComponent(target, { component: ChildOf, data: { parent: player } }).unwrap();
  world.addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } }).unwrap();
  if (withWeights) {
    world
      .addComponent(target, { component: MorphWeights, data: { weights: [0, 0, 0, 0] } })
      .unwrap();
  }
  expect(bindAnimationTargets(world, player, [target]).ok).toBe(true);
  return { world, player, target };
}

afterEach(() => vi.restoreAllMocks());

describe('morph weights animation contract', () => {
  it.each([
    0, 0.25, 0.5, 0.999,
  ])('samples four morph elements per-element at t=%s, not quaternion interpolation', async (time) => {
    const { world, player, target } = await setupTarget(true);
    world.set(player, AnimationPlayer, { times: [time] }).unwrap();
    world.update(0);
    const expected = [time, time * 2, time * 3, time * 4];
    expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual(
      expected.map((value) => expect.closeTo(value, 5)),
    );
  });

  it('emits the exact missing MorphWeights diagnostic and does not draw a base substitute', async () => {
    const { world } = await setupTarget(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    world.update(0.25);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'animation-target-morph-weights-missing',
        detail: expect.objectContaining({ property: 'weights', expectedWeightCount: 4 }),
      }),
    );
  });
});
