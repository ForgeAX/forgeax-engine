import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  PhysicsSimulationControl,
  PhysicsWorld2DResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import type { RigidBody as NativeBody } from '../../pkg/rapier.mjs';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../rapier-physics-world-2d.js';
import { loadRapier2D } from '../wasm-loader.js';

it('gates native 2D automatic steps and resumes preserved linear momentum without pause debt', async () => {
  const R = await loadRapier2D();
  if ('code' in R) throw R;
  const world = new World(),
    physics = createRapier2DPhysicsWorld(R);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.insertResource(PhysicsWorld2DResource, physics);
  const release = registerPhysicsSystems2D(world);
  try {
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 10, 7] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 } },
        { component: Collider, data: {} },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    let body: NativeBody | undefined;
    physics.raw.forEachRigidBody((candidate: NativeBody) => {
      if (candidate.userData === entity) body = candidate;
    });
    if (!body) throw Error('missing native 2D body');
    body.setLinvel({ x: 3, y: 0 }, true);
    world.update(1 / 60).unwrap();
    const position = { ...body.translation() },
      velocity = { ...body.linvel() },
      control = { paused: true };
    world.insertResource(PhysicsSimulationControl, control);
    for (let i = 0; i < 120; i++) world.update(1 / 60).unwrap();
    expect(body.translation()).toEqual(position);
    expect(body.linvel()).toEqual(velocity);
    control.paused = false;
    world.update(1 / 60).unwrap();
    expect(body.translation().x - position.x).toBeCloseTo(3 / 60, 5);
    expect(world.get(entity, Transform).unwrap().pos[2]).toBe(7);
  } finally {
    release();
    physics.dispose();
  }
});
