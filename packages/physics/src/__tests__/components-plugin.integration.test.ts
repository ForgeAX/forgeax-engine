import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  CharacterController,
  Collider,
  CollidingEntities,
  physicsComponentsPlugin,
  RigidBody,
} from '../index';

describe('physics component vocabulary plugin', () => {
  it('registers schemas without loading or starting a physics backend', async () => {
    const world = new World();
    const context = await createWorldContext(world, [physicsComponentsPlugin()]);

    expect(world.components.resolve(RigidBody.name)).toBe(RigidBody);
    expect(world.components.resolve(Collider.name)).toBe(Collider);
    expect(world.components.resolve(CharacterController.name)).toBe(CharacterController);
    expect(world.components.resolve(CollidingEntities.name)).toBe(CollidingEntities);
    expect(world.hasResource('PhysicsWorld')).toBe(false);

    await context.fiber.dispose();
    expect(world.components.resolve(RigidBody.name)).toBeUndefined();
  });
});
