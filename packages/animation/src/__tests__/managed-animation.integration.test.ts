import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { animationPlugin } from '../plugin';

const firstId = 'c95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;
const secondId = 'd95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;
const clip = (targetId: AnimationTargetIdValue, end: number): AnimationClip => ({
  kind: 'animation-clip',
  duration: 1,
  channels: [
    {
      targetId,
      property: 'translation',
      sampler: {
        input: new Float32Array([0, 1]),
        output: new Float32Array([0, 0, 0, end, 0, 0]),
        interpolation: 'LINEAR',
      },
    },
  ],
});

test('native playback adopts clip edits and graph references without a payload provider', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const context = await createWorldContext(world, [scenePlugin(), animationPlugin()]);
  const first = assets.create(clip(firstId, 2)).unwrap();
  const second = assets.create(clip(secondId, 12)).unwrap();
  const graph = assets.create(defineAnimationGraph((b) => b.clip(first)).unwrap()).unwrap();
  const player = world
    .spawn(
      { component: Transform, data: {} },
      { component: AnimationPlayer, data: { graph, nodeTimes: [0.5], nodeSpeeds: [0] } },
    )
    .unwrap();
  const target = (id: AnimationTargetIdValue) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: player } },
        { component: AnimationTargetId, data: { value: id } },
      )
      .unwrap();
  const a = target(firstId),
    b = target(secondId);
  bindAnimationTargets(world, player, [a, b]).unwrap();
  assets.release(first).unwrap();
  world.update(0).unwrap();
  expect(world.get(a, Transform).unwrap().pos[0]).toBe(1);
  expect(world.get(player, AnimationPlayer).unwrap().clips[0]).toBe(first);
  assets.update(first, { channels: clip(secondId, 8).channels }).unwrap();
  world.update(0).unwrap();
  expect(world.get(b, Transform).unwrap().pos[0]).toBe(4);
  const version = assets.snapshot(graph).unwrap();
  const before = assets.read(graph).unwrap();
  expect(assets.update(graph, { nodes: [{ type: 'blend', children: [0], weight: 1 }] }).ok).toBe(
    false,
  );
  expect(assets.read(graph).unwrap()).toEqual(before);
  expect(version.matchesCurrent()).toBe(true);
  assets.update(graph, { nodes: [{ type: 'clip', clip: second, weight: 1 }] }).unwrap();
  world.update(0).unwrap();
  expect(world.get(b, Transform).unwrap().pos[0]).toBe(6);
  expect(world.get(player, AnimationPlayer).unwrap().clips[0]).toBe(second);
  expect(version.matchesCurrent()).toBe(false);
  expect(world.sharedRefs._liveCount()).toBe(0);
  version.dispose();
  expect(assets.read(first).ok).toBe(false);
  world.despawn(player).unwrap();
  world.despawn(a).unwrap();
  world.despawn(b).unwrap();
  assets.release(graph).unwrap();
  assets.release(second).unwrap();
  await context.fiber.dispose();
  assets.dispose();
});
