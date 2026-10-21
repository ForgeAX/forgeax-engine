import {
  AnimationPlayer,
  AnimationTargetId,
  advanceAnimationPlayer,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

const targetId = 'a95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;
function fixture(weights: number[], paused = true) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const clips = [0, 6, 12].map((offset) =>
    assets
      .create({
        kind: 'animation-clip',
        duration: 2,
        channels: [
          {
            targetId,
            property: 'translation',
            sampler: {
              input: new Float32Array([0, 2]),
              output: new Float32Array([offset, 0, 0, offset + 2, 0, 0]),
              interpolation: 'LINEAR',
            },
          },
        ],
      } satisfies AnimationClip)
      .unwrap(),
  );
  const player = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: AnimationPlayer,
        data: { clips, times: [0, 0, 0], speeds: [1, 1, 1], weights, paused, looping: true },
      },
    )
    .unwrap() as EntityHandle;
  const target = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: player } },
      { component: AnimationTargetId, data: { value: targetId } },
    )
    .unwrap() as EntityHandle;
  bindAnimationTargets(world, player, [target]).unwrap();
  return { assets, world, player, target };
}

it.each([
  [[1, 0, 0], 0],
  [[0.5, 0.5, 0], 3],
  [[1, 1, 1], 6],
  [[0.6, 0.6, 0], 3],
  [[-1, 1, 0], 6],
] as const)('samples the normalized positive slot weights %j', (weights, x) => {
  const { assets, world, player, target } = fixture([...weights]);
  advanceAnimationPlayer(world, 0.5);
  expect([...world.get(target, Transform).unwrap().pos]).toEqual([x, 0, 0]);
  expect([...world.get(player, AnimationPlayer).unwrap().weights]).toEqual(
    weights.map(Math.fround),
  );
  expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0, 0, 0]);
  assets.dispose();
});

it('advances native Clip identities and wraps reverse time independently', () => {
  const { assets, world, player, target } = fixture([1, 0, 0], false);
  world.set(player, AnimationPlayer, { speeds: [-1, 2, 1], times: [0.25, 1.75, 0] }).unwrap();
  advanceAnimationPlayer(world, 0.5);
  expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([1.75, 0.75, 0.5]);
  expect(world.get(target, Transform).unwrap().pos[0]).toBe(1.75);
  world.set(player, AnimationPlayer, { looping: false, speeds: [2, 1, 1] }).unwrap();
  advanceAnimationPlayer(world, 1);
  expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(2);
  assets.dispose();
});
