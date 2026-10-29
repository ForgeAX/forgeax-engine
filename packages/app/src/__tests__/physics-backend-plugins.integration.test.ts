import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import physics2d from '@forgeax/engine-physics-rapier2d';
import physics3d from '@forgeax/engine-physics-rapier3d';
import { startNativePlugin } from '@forgeax/engine-plugin';
import { expect, it } from 'vitest';

it.each([
  ['2d', physics2d],
  ['3d', physics3d],
] as const)('activates, simulates and retires the selected %s backend', async (_dimension, plugin) => {
  const world = new World();
  const context = await createWorldContext(world);
  try {
    const started = await startNativePlugin(context, plugin);
    expect(started.ok).toBe(true);
    if (!started.ok) throw started.error;
    expect(world.components.resolve(RigidBody.name)).toBe(RigidBody);
    expect(world.components.resolve(Collider.name)).toBe(Collider);
    expect(world.hasResource('PhysicsWorld')).toBe(true);
    expect(context.get('physics')).toBe(world.getResource('PhysicsWorld'));
    const { Transform } = await import('@forgeax/engine-scene');
    const body = world
      .spawn(
        { component: Transform, data: { pos: [0, 5, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
      )
      .unwrap();
    for (let frame = 0; frame < 60; frame++) world.update(1 / 60).unwrap();
    expect(world.get(body, Transform).unwrap().pos[1]).toBeLessThan(5);
    world.despawn(body).unwrap();
  } finally {
    await context.fiber.dispose();
  }
  expect(world.hasResource('PhysicsWorld')).toBe(false);
  expect(world.components.resolve(RigidBody.name)).toBeUndefined();
  expect(world.inspect().systems.some((system) => system.name.startsWith('physics'))).toBe(false);
});
