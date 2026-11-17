import { World } from '@forgeax/engine-ecs';
import { Collider, PhysicsWorld2DResource, RigidBody } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import type { RigidBody as NativeBody } from '../../pkg/rapier.mjs';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../rapier-physics-world-2d.js';
import { loadRapier2D } from '../wasm-loader.js';

it('applies the shared sleep creation policy to actual 2D bodies', async () => {
  const R = await loadRapier2D();
  if ('code' in R) throw R;
  const world = new World(),
    physics = createRapier2DPhysicsWorld(R);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.insertResource(PhysicsWorld2DResource, physics);
  const release = registerPhysicsSystems2D(world);
  try {
    const spawn = (canSleep: boolean, x: number) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: RigidBody, data: { canSleep, gravityScale: 0 } },
          { component: Collider, data: {} },
        )
        .unwrap();
    const awake = spawn(false, 0),
      resting = spawn(true, 10);
    world.update(1 / 60).unwrap();
    const bodies = new Map<number, NativeBody>();
    physics.raw.forEachRigidBody((body: NativeBody) => bodies.set(body.userData as number, body));
    for (let frame = 0; frame < 600; frame++) physics.step(1 / 60);
    expect(bodies.get(awake)?.isSleeping()).toBe(false);
    expect(bodies.get(resting)?.isSleeping()).toBe(true);
    world.set(awake, RigidBody, { canSleep: true }).unwrap();
    expect(world.update(1 / 60).ok).toBe(false);
    expect(bodies.get(awake)?.isSleeping()).toBe(false);
  } finally {
    release();
    physics.dispose();
  }
});
