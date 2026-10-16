import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import type { RigidBody as NativeRigidBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld, loadRapier3D } from '../index';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
function physicsCase(unrelatedSpawns: number) {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 4, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  const findBody = () => {
    let result: NativeRigidBody | undefined;
    (physics.raw as NativeWorld).forEachRigidBody((body) => {
      if (body.userData === entity) result = body;
    });
    if (result === undefined) throw new Error('native body missing');
    return result;
  };
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    findBody().setLinvel({ x: 3, y: 4, z: 5 }, true);
    const before = { ...findBody().linvel() };
    for (let i = 0; i < unrelatedSpawns; i++) world.spawn().unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    const after = { ...findBody().linvel() };
    return { unrelatedSpawns, before, after };
  } finally {
    physics.dispose();
  }
}

test.each([
  0, 1024, 1025, 4096,
])('preserves native velocity after %i unrelated mutations', (count) => {
  const sample = physicsCase(count);
  expect(sample.after).toEqual(sample.before);
});
