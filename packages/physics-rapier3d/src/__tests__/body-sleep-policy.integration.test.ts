import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { Collider, RigidBody, registerPhysicsComponents } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('honors the ECS automatic-sleep creation policy without per-frame wake commands', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R),
    world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  const release = registerPhysicsComponents(world);
  physics.setGravity(vec3.create(0, 0, 0));
  const spawn = (canSleep: boolean, x: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: RigidBody, data: { canSleep, mass: 8 } },
        { component: Collider, data: { density: 0 } },
      )
      .unwrap();
  try {
    const awake = spawn(false, 0),
      resting = spawn(true, 10);
    physics._syncFromEcs(world, Transform, GlobalTransform);
    for (let frame = 0; frame < 600; frame++) physics.step(1 / 60);
    expect(physics.getBodyMotion(awake).unwrap().sleeping).toBe(false);
    expect(physics.getBodyMotion(resting).unwrap().sleeping).toBe(true);
    world.set(awake, RigidBody, { linearDamping: 1.8 }).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    for (let frame = 0; frame < 600; frame++) physics.step(1 / 60);
    expect(physics.getBodyMotion(awake).unwrap().sleeping).toBe(false);
    const before = physics.getBodyMotion(awake).unwrap();
    world.set(awake, RigidBody, { canSleep: true, mass: 99 }).unwrap();
    expect(() => physics._syncFromEcs(world, Transform, GlobalTransform)).toThrow(
      'creation policy',
    );
    expect(physics.getBodyMotion(awake).unwrap()).toEqual(before);
  } finally {
    physics.dispose();
    release();
  }
});
