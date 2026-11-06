import { animationPlugin, AnimationPlayer, deriveAnimationTargetId } from '@forgeax/engine/animation';
import { FixedTime, Time } from '@forgeax/engine/ecs';
import { createInputSnapshot, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine/input';
import { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { GlobalTransform, sceneEntity, scenePlugin, Transform, worldInstantiateSceneAsset, worldResolveSceneEntity } from '@forgeax/engine/scene';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { AnimationClip } from '@forgeax/engine/types';
import { describe, expect, it, vi } from 'vitest';
import { camera as cameraPlugin } from '../../camera/camera.pack.ts';
import { sceneWorldFixture } from '../../shared/__tests__/plugin-fixture.ts';
import playerPlugin, { ThirdPersonRig } from '../player.ts';
import { prepareConvoyAssets } from '../convoy-model.ts';
import { PLAYER_JOINT_NAMES, PLAYER_TRANSFORM_SECONDS, PLAYER_COLLIDER } from '../player-rig.ts';

import { PACKAGE_IDS } from '../../shared/asset-refs.ts';
const convoy = prepareConvoyAssets(512, PACKAGE_IDS.character).assets;

async function temporalFixture() {
  const { world, ctx, asset, assets } = await sceneWorldFixture();
  await ctx.plugin(scenePlugin());
  await ctx.plugin(animationPlugin());
  await ctx.plugin(physics3d);
  const source = assets.create(asset).unwrap();
  const root = worldInstantiateSceneAsset(world, source, asset, undefined, new Set(), undefined, 'scene/showcase').unwrap();
  assets.release(source).unwrap();
  const entity = (key: string) => worldResolveSceneEntity(world, root, sceneEntity('scene/showcase', key)).unwrap();
  const player = entity('player');
  world.set(player, Transform, { pos: [0, PLAYER_COLLIDER.radius + PLAYER_COLLIDER.halfHeight + 0.01, 0] }).unwrap();
  world.addComponent(player, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
  world.addComponent(player, { component: Collider, data: { shape: ColliderShapeValue.capsule, ...PLAYER_COLLIDER } }).unwrap();
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
  vi.spyOn(assets, 'load').mockImplementation(async (guid) => assets.create((typeof guid === 'string' ? guid : AssetGuid.format(guid)).endsWith('000000000001') ? clip : (typeof guid === 'string' ? guid : AssetGuid.format(guid)).endsWith('000000000002') ? convoy['animation/player-transform'] : convoy['animation/player-wheels']));
  ctx.provide('gameHost', { assets } as never);
  let moving = false, steering = false, transformPressed = false;
  const empty = createInputSnapshot();
  world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, {
    ...empty, keyboard: { ...empty.keyboard, downCode: (code: string) => (moving && code === 'KeyW') || (steering && code === 'KeyD'), justPressedCode: (code: string) => { if (code !== 'KeyT' || !transformPressed) return false; transformPressed = false; return true; } },
  });
  await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6.25, gravity: 17, walk: '019fb7ce-1000-7000-8000-000000000001', transform: '019fb7ce-1000-7000-8000-000000000002', wheels: '019fb7ce-1000-7000-8000-000000000003' });
  await ctx.plugin(cameraPlugin);
  for (let step = 0; step < 5; step += 1) world.update(1 / 60).unwrap();
  return { world, ctx, entity, player, move: (active = true) => { moving = active; }, transform: () => { transformPressed = true; }, steer: (active = true) => { steering = active; } };
}

describe('game-3d temporal alignment with native Rapier', () => {
  it('holds the actual truck endpoint and restores the robot after reverse transformation', async () => {
    const { world, ctx, entity, player, transform, move } = await temporalFixture();
    try {
      transform();
      for (let frame = 0; frame < Math.ceil((PLAYER_TRANSFORM_SECONDS + 0.5) / 0.1); frame++) world.update(0.1).unwrap();
      expect(world.get(player, AnimationPlayer).unwrap().times[1]).toBeCloseTo(PLAYER_TRANSFORM_SECONDS, 5);
      expect(world.get(entity('player/joint/HeadSlide'), Transform).unwrap().pos[1]).toBeCloseTo(-0.195, 5);
      expect(world.get(entity('player/joint/HeadSlideBase'), Transform).unwrap().pos[1]).toBeCloseTo(-0.195, 5);
      expect(world.get(entity('player/joint/AbdomenSlide'), Transform).unwrap().pos[1]).toBeCloseTo(0.46, 5);
      expect(world.get(entity('player/joint/Thigh.L'), Transform).unwrap().quat[0]).toBeCloseTo(-Math.SQRT1_2, 5);
      for (let frame = 0; frame < 5; frame++) world.update(0.1).unwrap();
      expect(world.get(entity('player/joint/HeadSlide'), Transform).unwrap().pos[1]).toBeCloseTo(-0.195, 5);
      move();
      transform();
      for (let frame = 0; frame < 110; frame++) world.update(0.037).unwrap();
      expect(world.get(entity('player/joint/HeadSlide'), Transform).unwrap().pos[1]).toBeCloseTo(0, 5);
      expect(world.get(entity('player/joint/HeadSlideBase'), Transform).unwrap().pos[1]).toBeCloseTo(0, 5);
      expect(world.get(entity('player/joint/AbdomenSlide'), Transform).unwrap().pos[1]).toBeCloseTo(0, 5);
      expect(world.get(entity('player/joint/Thigh.L'), Transform).unwrap().quat[0]).toBeCloseTo(0, 5);
    } finally { await ctx.fiber.dispose(); }
  });
  it('accelerates and steers the truck, then brakes without a movement command', async () => {
    const { world, ctx, player, transform, move, steer } = await temporalFixture();
    try {
      transform();
      for (let frame = 0; frame < Math.ceil((PLAYER_TRANSFORM_SECONDS + 0.5) / 0.1); frame++) world.update(0.1).unwrap();
      const start = Array.from(world.get(player, Transform).unwrap().pos);
      move(); steer();
      for (let frame = 0; frame < 8; frame++) world.update(0.1).unwrap();
      const rig = world.get(player, ThirdPersonRig).unwrap();
      expect(rig.vehicleSpeed).toBeGreaterThan(1);
      expect(rig.facingX).toBeGreaterThan(0.05);
      const end = world.get(player, Transform).unwrap().pos;
      expect(Math.hypot(end[0]! - start[0]!, end[2]! - start[2]!)).toBeGreaterThan(0.3);
      move(false); steer(false);
      for (let frame = 0; frame < 20; frame++) world.update(0.1).unwrap();
      expect(world.get(player, ThirdPersonRig).unwrap().vehicleSpeed).toBe(0);
    } finally { await ctx.fiber.dispose(); }
  });

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
