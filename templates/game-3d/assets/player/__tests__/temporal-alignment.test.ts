import { animationPlugin, AnimationPlayer, deriveAnimationTargetId } from '@forgeax/engine/animation';
import { FixedTime, Time } from '@forgeax/engine/ecs';
import { createInputSnapshot, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine/input';
import { CharacterController, Collider, ColliderShapeValue, physicsPlugin, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import { GlobalTransform, sceneEntity, scenePlugin, Transform, worldInstantiateSceneAsset, worldResolveSceneEntity } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { describe, expect, it } from 'vitest';
import { camera as cameraPlugin } from '../../camera/camera.pack.ts';
import { sceneWorldFixture } from '../../shared/__tests__/plugin-fixture.ts';
import playerPlugin from '../player.ts';
import { PLAYER_JOINT_NAMES } from '../player-rig.ts';

async function temporalFixture() {
  const { world, ctx, asset } = await sceneWorldFixture();
  await ctx.plugin(scenePlugin());
  await ctx.plugin(animationPlugin());
  await ctx.plugin(physicsPlugin('rapier-3d'));
  const source = world.allocSharedRef('SceneAsset', asset);
  const root = worldInstantiateSceneAsset(world, source, asset, undefined, new Set(), [], undefined, 'scene/showcase').unwrap();
  world.sharedRefs.release(source).unwrap();
  const entity = (key: string) => worldResolveSceneEntity(world, root, sceneEntity('scene/showcase', key)).unwrap();
  const player = entity('player');
  world.set(player, Transform, { pos: [0, 0.91, 0] }).unwrap();
  world.addComponent(player, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
  world.addComponent(player, { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.6 } }).unwrap();
  world.addComponent(player, { component: CharacterController, data: {} }).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, -0.5, 0] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [100, 0.5, 100] } },
  ).unwrap();
  const clip: AnimationClip = {
    kind: 'animation-clip', duration: 10,
    channels: [{ targetId: deriveAnimationTargetId(['Player', PLAYER_JOINT_NAMES[0]!]), property: 'translation', sampler: {
      input: new Float32Array([0, 10]), output: new Float32Array([0, 0, 0, 10, 0, 0]), interpolation: 'LINEAR',
    } }],
  };
  ctx.provide('gameScene', { root });
  ctx.provide('gameHost', { assets: { loadByGuid: async () => ({ ok: true, value: clip }) } } as never);
  let moving = false;
  const empty = createInputSnapshot();
  world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, {
    ...empty, keyboard: { ...empty.keyboard, downCode: (code: string) => moving && code === 'KeyW' },
  });
  await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6.25, gravity: 17, walk: '019fb7ce-1000-7000-8000-000000000001' });
  await ctx.plugin(cameraPlugin);
  for (let step = 0; step < 5; step += 1) world.update(1 / 60).unwrap();
  return { world, ctx, entity, player, move: (active = true) => { moving = active; } };
}

describe('game-3d temporal alignment with native Rapier', () => {
  it('publishes the current player and camera world positions after mixed fixed-step counts', async () => {
    const { world, ctx, entity, move } = await temporalFixture();
    try {
      move();
      for (const dt of [1 / 60, 3 / 60, 1 / 120, 1 / 30, 1 / 60]) {
        const previousTick = world.getResource(FixedTime).tick;
        world.update(dt).unwrap();
        if (dt === 1 / 120) expect(world.getResource(FixedTime).tick).toBe(previousTick);
        if (dt === 3 / 60) expect(world.getResource(FixedTime).tick - previousTick).toBe(3);
        for (const key of ['player', 'camera']) {
          const local = world.get(entity(key), Transform).unwrap().pos;
          const resolved = world.get(entity(key), GlobalTransform).unwrap().world;
          const error = Math.hypot(...Array.from(local, (value, axis) => value - resolved[12 + axis]!));
          expect(error, `${key}, fixed tick ${world.getResource(FixedTime).tick}, dt ${dt}: local ${Array.from(local)}, resolved ${Array.from(resolved).slice(12, 15)}`).toBeLessThan(1e-5);
        }
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it.each([1 / 240, 1 / 60, 3 / 60])('samples current movement intent before animation with update delta %s', async (dt) => {
    const { world, ctx, entity, player, move } = await temporalFixture();
    try {
      move();
      const previousTick = world.getResource(FixedTime).tick;
      world.update(dt).unwrap();
      if (dt === 1 / 240) expect(world.getResource(FixedTime).tick).toBe(previousTick);
      const animation = world.get(player, AnimationPlayer).unwrap();
      expect(animation.weights[0]).toBe(1);
      expect(animation.times[0]).toBeCloseTo(world.getResource(Time).elapsed, 8);
      const sampled = world.get(entity(`player/joint/${PLAYER_JOINT_NAMES[0]}`), Transform).unwrap().pos[0];
      expect(sampled).toBeCloseTo(animation.times[0]!, 6);
      const rendered = world.get(entity(`player/joint/${PLAYER_JOINT_NAMES[0]}`), GlobalTransform).unwrap().world;
      expect(rendered[12]).toBeCloseTo((world.get(player, Transform).unwrap().pos[0] ?? 0) + animation.times[0]!, 6);
      move(false);
      world.update(1 / 240).unwrap();
      expect(world.get(player, AnimationPlayer).unwrap().weights[0]).toBe(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
