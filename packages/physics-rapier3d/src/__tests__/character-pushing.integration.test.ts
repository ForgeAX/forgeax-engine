import { FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  false,
  true,
])('applies native character push only to solid crates (sensor=%s)', async (sensor) => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const releaseScene = registerPropagateTransforms(world);
  const releasePhysics = registerPhysicsSystems(world);
  const character = world
    .spawn(
      { component: Transform, data: { pos: [-1, 0, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
      },
      { component: CharacterController, data: { autoStepMaxHeight: 0, snapToGroundDist: 0 } },
    )
    .unwrap();
  const crate = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.dynamic, mass: 1, gravityScale: 0 },
      },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [0.4, 0.4, 0.4],
          isSensor: sensor,
          friction: 0,
          restitution: 0,
        },
      },
    )
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'test-push',
      after: ['physicsSyncBackend'],
      before: ['physicsStepSimulation'],
      queries: [],
      fn() {
        physics.moveAndSlide(character, vec3.create(2 / 60, 0, 0));
      },
    })
    .unwrap();
  try {
    for (let frame = 0; frame < 120; frame++) world.update(1 / 60).unwrap();
    const crateX = world.get(crate, Transform).unwrap().pos[0];
    if (sensor) expect(crateX).toBeCloseTo(0, 6);
    else expect(crateX).toBeGreaterThan(0.5);
    expect(world.get(character, Transform).unwrap().pos[0]).toBeGreaterThan(0);
  } finally {
    world.removeSystem(FixedUpdate, 'test-push').unwrap();
    releasePhysics();
    releaseScene();
    physics.dispose();
  }
});
