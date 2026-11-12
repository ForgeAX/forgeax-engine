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

async function movePastObstacle(groups: number, sensor: boolean, capsule: boolean) {
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
        data: {
          shape: ColliderShapeValue.capsule,
          radius: 0.3,
          halfHeight: 0.5,
          collisionGroups: 0x00020001,
        },
      },
      { component: CharacterController, data: { autoStepMaxHeight: 0, snapToGroundDist: 0 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: RigidBody,
        data: { type: capsule ? RigidBodyTypeValue.kinematic : RigidBodyTypeValue.static },
      },
      {
        component: Collider,
        data: {
          shape: capsule ? ColliderShapeValue.capsule : ColliderShapeValue.cuboid,
          radius: 0.3,
          halfHeight: 0.5,
          halfExtents: [0.4, 1, 0.4],
          collisionGroups: groups,
          isSensor: sensor,
        },
      },
    )
    .unwrap();
  // Admit both colliders and update Rapier's query pipeline before the tested sweep.
  world.update(1 / 30).unwrap();
  let moved: number | undefined;
  world
    .addSystem(FixedUpdate, {
      name: 'test-character-collision-groups',
      queries: [],
      after: ['physicsSyncBackend'],
      before: ['physicsStepSimulation'],
      fn() {
        if (moved === undefined) moved = physics.moveAndSlide(character, vec3.create(2, 0, 0))[0];
      },
    })
    .unwrap();
  try {
    world.update(1 / 30).unwrap();
    if (moved === undefined) throw new Error('Native KCC sweep system did not execute');
    return moved;
  } finally {
    world.removeSystem(FixedUpdate, 'test-character-collision-groups').unwrap();
    releasePhysics();
    releaseScene();
    physics.dispose();
  }
}

it.each([
  {
    name: 'character rejects the other character membership',
    groups: 0x00040002,
    sensor: false,
    capsule: true,
    blocks: false,
  },
  {
    name: 'other character rejects the moving membership',
    groups: 0x00010004,
    sensor: false,
    capsule: true,
    blocks: false,
  },
  {
    name: 'reciprocal character groups collide',
    groups: 0x00010002,
    sensor: false,
    capsule: true,
    blocks: true,
  },
  {
    name: 'reciprocal static obstacle groups collide',
    groups: 0x00010002,
    sensor: false,
    capsule: false,
    blocks: true,
  },
  {
    name: 'sensor remains excluded despite reciprocal groups',
    groups: 0x00010002,
    sensor: true,
    capsule: true,
    blocks: false,
  },
])('uses native reciprocal collision groups: $name', async ({
  groups,
  sensor,
  capsule,
  blocks,
}) => {
  const moved = await movePastObstacle(groups, sensor, capsule);
  if (blocks) expect(moved).toBeLessThan(0.6);
  else expect(moved).toBeCloseTo(2, 5);
});
