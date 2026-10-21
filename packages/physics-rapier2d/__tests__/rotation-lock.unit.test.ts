import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform, registerPropagateTransforms } from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import type { RigidBody as NativeBody, World as NativeWorld } from '../pkg/rapier.mjs';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../src/rapier-physics-world-2d.js';
import { loadRapier2D } from '../src/wasm-loader.js';

test.each([
  false,
  true,
])('2D ECS lock create=%s holds contact orientation and supports live unlock/relock', async (lockedAtCreation) => {
  const rapier = await loadRapier2D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 1, 0], quat: [0, 0, Math.sin(0.2), Math.cos(0.2)] },
      },
      {
        component: RigidBody,
        data: {
          type: RigidBodyTypeValue.dynamic,
          ...(lockedAtCreation ? { lockRotation: true } : {}),
        },
      },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.8, 0.3, 0.2] },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [20, 0.5, 20] },
      },
    )
    .unwrap();
  const physics = createRapier2DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  registerPropagateTransforms(world);
  registerPhysicsSystems2D(world);
  try {
    world.update(1 / 60).unwrap();
    let nativeBody: NativeBody | undefined;
    (physics.raw as NativeWorld).forEachRigidBody((candidate) => {
      if (candidate.userData === entity) nativeBody = candidate;
    });
    if (nativeBody === undefined) throw new Error('Missing native body');
    const body = nativeBody;
    const mass = body.mass();
    if (!lockedAtCreation) {
      expect(world.get(entity, RigidBody).unwrap().lockRotation).toBe(false);
      body.applyTorqueImpulse(0.5, true);
      expect(body.angvel()).not.toBe(0);
      world.set(entity, RigidBody, { lockRotation: true }).unwrap();
    }
    const rotation = body.rotation();
    world.update(1 / 60).unwrap();
    expect(body.rotation()).toBeCloseTo(rotation, 6);
    expect(body.angvel()).toBe(0);
    expect(body.mass()).toBeCloseTo(mass, 6);
    let touchedGround = false;
    for (let i = 0; i < 90; i++) {
      body.addTorque(0.2, true);
      body.applyTorqueImpulse(0.05, true);
      const p = body.translation();
      body.applyImpulseAtPoint({ x: 0, y: 0.001 }, { x: p.x + 0.4, y: p.y }, true);
      world.update(1 / 60).unwrap();
      (physics.raw as NativeWorld).contactPairsWith(body.collider(0), () => {
        touchedGround = true;
      });
      expect(body.angvel()).toBe(0);
      expect(body.rotation()).toBeCloseTo(rotation, 6);
    }
    expect(touchedGround).toBe(true);
    world.set(entity, RigidBody, { lockRotation: false }).unwrap();
    world.update(1 / 60).unwrap();
    body.applyTorqueImpulse(1, true);
    expect(body.angvel()).not.toBe(0);
    world.update(1 / 60).unwrap();
    expect(body.rotation()).not.toBe(rotation);
  } finally {
    physics.dispose();
  }
});
