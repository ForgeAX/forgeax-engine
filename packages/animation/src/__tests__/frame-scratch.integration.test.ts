import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, MorphWeights, Transform } from '@forgeax/engine-scene';
import type { AnimationTargetIdValue } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';
import { evaluateAnimationGraph } from '../systems/evaluate-animation-graph';

it('copies graph clocks and morph results out of dirty, reused frame scratch', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const targetId = 'b95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;
  const clip = assets
    .create({
      kind: 'animation-clip',
      duration: 2,
      channels: [
        {
          targetId,
          property: 'weights',
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([0, 0, 2, 4]),
            interpolation: 'LINEAR',
          },
        },
      ],
    })
    .unwrap();
  const graph = assets
    .create(defineAnimationGraph((b) => b.blend([b.clip(clip), b.clip(clip)])).unwrap())
    .unwrap();
  const player = world
    .spawn({ component: AnimationPlayer, data: { graph, nodeSpeeds: [1, 1, 0] } })
    .unwrap();
  const target = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: player } },
      { component: AnimationTargetId, data: { value: targetId } },
      { component: MorphWeights, data: { weights: [0, 0] } },
    )
    .unwrap();
  bindAnimationTargets(world, player, [target]).unwrap();
  const dirty = () =>
    world
      .withFrameArena(() => {
        world.frameArena.alloc(Float64Array, 256).unwrap().fill(Number.NaN);
        return ok(undefined);
      })
      .unwrap();
  dirty();
  evaluateAnimationGraph(world, 0.5);
  advanceAnimationPlayer(world, 0);
  expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0.5, 0.5]);
  expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual([0.5, 1]);
  const requests = world.memoryStats().arena.requests;
  dirty();
  // Managed component bytes remain valid after the source arena is overwritten.
  expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0.5, 0.5]);
  expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual([0.5, 1]);
  evaluateAnimationGraph(world, 0.25);
  advanceAnimationPlayer(world, 0);
  expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual([0.75, 1.5]);
  expect(world.memoryStats().arena.requests).toBeGreaterThan(requests + 1);
  expect(world.frameArena.isActive).toBe(false);
});
