import { vec2 as v2 } from '@forgeax/engine/math';
import {
  Collider,
  ColliderShapeValue,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import type { RapierPhysicsWorld2D } from '@forgeax/engine/physics-rapier2d';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { tryResource, waitForPhysicsWorld, waitUntil } from './support/live';
import { positionOf } from './support/rapier3d';

const vec2 = v2.create;

export default defineFeature({
  title: 'Rapier 2D backend',
  catalog: '2D Rapier backend',
  kind: 'probe',
  appOptions: { plugins: [physicsPlugin('rapier-2d')] },
  summary:
    'physicsPlugin("rapier-2d") loads the 2D Rapier WASM and inserts a PhysicsWorld2D resource. Bodies use Transform x/y and Collider halfExtents x/y; raycast and teleport take Vec2.',
  expect:
    'All checks pass: the 2D resource appears, a dynamic box falls onto a static floor in the XY plane, a Vec2 raycast hits the floor, teleport moves the box, and despawn removes the native body.',
  async setup({ world, frames, hud }) {
    const checks = new CheckList();
    spawnCamera(world);
    const { physics, waitedFrames } = await waitForPhysicsWorld<RapierPhysicsWorld2D>(
      world,
      frames,
    );
    checks.ok(
      'PhysicsWorld2D resource inserted',
      physics !== undefined,
      `waited ${waitedFrames} frames`,
    );
    if (physics === undefined) return { checks: () => checks.items };
    hud.status(`Rapier 2D ready after ${waitedFrames} frames`);
    checks.near(
      'default 2D gravity is -9.81 on Y',
      physics.getGravity()[1] ?? Number.NaN,
      -9.81,
      1e-4,
    );
    const floor = world
      .spawn(
        { component: Transform, data: { pos: [0, -0.5, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 0.5] },
        },
      )
      .unwrap();
    const box = world
      .spawn(
        { component: Transform, data: { pos: [0, 4, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5] },
        },
      )
      .unwrap();
    const created = await waitUntil(frames, () => physics.hasBody(box) && physics.hasBody(floor));
    checks.ok(
      'both 2D bodies created by the sync phase',
      created !== undefined,
      `bodies=${physics.getBodyCount()}`,
    );
    const landed = await waitUntil(
      frames,
      () => Math.abs(positionOf(world, box)[1] - 0.5) < 0.05,
      600,
    );
    checks.ok(
      'dynamic box falls and rests on the floor (y=0.5)',
      landed !== undefined,
      `y=${positionOf(world, box)[1]}`,
    );
    const hit = physics.raycast(vec2(3, 5), vec2(0, -1), 20);
    checks.ok('Vec2 raycast hits the floor entity', hit?.entity === floor, `entity=${hit?.entity}`);
    checks.near('raycast hit y is the floor top', hit?.point[1] ?? Number.NaN, 0, 0.02);
    physics.setGravity(vec2(0, 0));
    physics.teleport(box, vec2(-4, 3), 0);
    const moved = await waitUntil(frames, () => Math.abs(positionOf(world, box)[0] + 4) < 0.02, 60);
    checks.ok(
      'teleport moves the box to (-4, 3)',
      moved !== undefined,
      `pos=${positionOf(world, box).join(',')}`,
    );
    world.despawn(box);
    const removed = await waitUntil(frames, () => !physics.hasBody(box), 60);
    checks.ok(
      'despawn removes the native body',
      removed !== undefined,
      `bodies=${physics.getBodyCount()}`,
    );
    checks.ok('resource still owned by the plugin', tryResource(world) === physics);
    return { checks: () => checks.items };
  },
});
