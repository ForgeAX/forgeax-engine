import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';

test.each([
  'none',
  'unrelated-1025',
  'friction',
  'gravityScale',
  'linearDamping',
  'angularDamping',
  'additionalSolverIterations',
  'shape',
] as const)('R2-P1: native momentum after %s mutation', async (mutation) => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
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
  const body = (): NativeBody => {
    let result: NativeBody | undefined;
    (physics.raw as NativeWorld).forEachRigidBody((candidate) => {
      if (candidate.userData === entity) result = candidate;
    });
    if (result === undefined) throw new Error('Native body missing');
    return result;
  };
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    body().setLinvel({ x: 3, y: 4, z: 5 }, true);
    body().setAngvel({ x: 0, y: 2, z: 0 }, true);
    const before = { linear: { ...body().linvel() }, angular: { ...body().angvel() } };
    if (mutation === 'unrelated-1025') for (let i = 0; i < 1025; i++) world.spawn().unwrap();
    if (mutation === 'friction') world.set(entity, Collider, { friction: 0.2 }).unwrap();
    if (mutation === 'linearDamping') world.set(entity, RigidBody, { linearDamping: 0.7 }).unwrap();
    if (mutation === 'angularDamping')
      world.set(entity, RigidBody, { angularDamping: 0.7 }).unwrap();
    if (mutation === 'additionalSolverIterations')
      world.set(entity, RigidBody, { additionalSolverIterations: 8 }).unwrap();
    if (mutation === 'shape') world.set(entity, Collider, { radius: 0.8 }).unwrap();
    if (mutation === 'gravityScale') world.set(entity, RigidBody, { gravityScale: 0 }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    const after = { linear: { ...body().linvel() }, angular: { ...body().angvel() } };
    expect(after).toEqual(before);
    if (mutation === 'additionalSolverIterations')
      expect(body().additionalSolverIterations()).toBe(8);
  } finally {
    physics.dispose();
  }
});

test('removing Collider retires an active overlap while preserving the native body', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const sensor = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.sphere, radius: 1, isSensor: true },
      },
    )
    .unwrap();
  const fixed = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 1 } },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    expect(physics.getCollisionPairs().get(sensor)).toContain(fixed);
    physics.drainCollisionEvents();

    world.removeComponent(sensor, Collider).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);

    expect(physics.hasBody(sensor)).toBe(true);
    expect(physics.getCollisionPairs().get(sensor)).not.toContain(fixed);
    expect(physics.drainCollisionEvents()).toContainEqual(
      expect.objectContaining({ type: 'stopped', entityA: sensor, entityB: fixed }),
    );
  } finally {
    physics.dispose();
  }
});
