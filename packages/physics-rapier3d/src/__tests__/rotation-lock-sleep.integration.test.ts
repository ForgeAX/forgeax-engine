import { createWorldContext, defineComponent, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

test('locked contact bodies stay asleep through normal sync and unrelated ECS writes', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const release = registerPhysicsSystems(world);
  const Annotation = defineComponent('RotationLockSleepAnnotation', {
    revision: { type: 'u32', default: 0 },
  });
  world.components.register(Annotation).unwrap();
  const body = world
    .spawn(
      { component: Transform, data: { pos: [0, 1, 0] } },
      {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.dynamic, lockRotation: true },
      },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.6, 0.3, 0.2] },
      },
      { component: Annotation, data: {} },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.5, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [20, 0.5, 20] },
      },
    )
    .unwrap();
  const unrelated = world.spawn({ component: Transform, data: { pos: [50, 0, 0] } }).unwrap();
  try {
    let solidContact = false;
    for (let step = 0; step < 420; step++) {
      world.update(1 / 60).unwrap();
      solidContact ||= physics
        .getCurrentContacts(body)
        .unwrap()
        .manifolds.some((manifold) => manifold.points.length > 0);
      if (physics.getBodyMotion(body).unwrap().sleeping) break;
    }
    const asleep = physics.getBodyMotion(body).unwrap();
    expect(solidContact).toBe(true);
    expect(asleep.sleeping).toBe(true);
    expect(asleep.angularVelocity).toEqual([0, 0, 0]);
    expect(asleep.position[1]).toBeGreaterThan(0.25);
    expect(asleep.position[1]).toBeLessThan(0.35);

    for (let step = 0; step < 120; step++) {
      world.set(body, Annotation, { revision: step + 1 }).unwrap();
      world.set(unrelated, Transform, { pos: [50 + step, 0, 0] }).unwrap();
      world.set(body, RigidBody, { lockRotation: true }).unwrap();
      world.update(1 / 60).unwrap();
      expect(physics.getBodyMotion(body).unwrap()).toEqual(asleep);
    }
  } finally {
    release();
    await scene.fiber.dispose();
    physics.dispose();
  }
});
