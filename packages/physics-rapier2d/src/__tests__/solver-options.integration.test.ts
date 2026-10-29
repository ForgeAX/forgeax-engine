import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsOptions,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import physics from '../plugin.js';
import {
  createRapier2DPhysicsWorld,
  type RapierPhysicsWorld2D,
} from '../rapier-physics-world-2d.js';
import { loadRapier2D } from '../wasm-loader.js';

it.each([
  undefined,
  1,
  2,
  8,
  32,
])('constructs a native world with %s solver iterations', async (iterations) => {
  const module = await loadRapier2D();
  if ('code' in module) throw module;
  const options: PhysicsOptions = iterations === undefined ? {} : { solverIterations: iterations };
  const instance = createRapier2DPhysicsWorld(module, options);
  try {
    expect(instance.raw.integrationParameters.numSolverIterations).toBe(iterations ?? 4);
  } finally {
    instance.dispose();
  }
});

it.each([
  undefined,
  2,
])('applies optional plugin precision %s through sixty real fixed steps', async (iterations) => {
  const world = new World();
  const context = await createWorldContext(world, [
    {
      async apply(ctx) {
        if (iterations === undefined) await ctx.plugin(physics);
        else await ctx.plugin(physics, { solverIterations: iterations });
      },
    },
  ]);
  try {
    const instance = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 10, 0] } },
        {
          component: RigidBody,
          data: { type: RigidBodyTypeValue.dynamic, additionalSolverIterations: 3 },
        },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.1 } },
      )
      .unwrap();
    for (let index = 0; index < 60; index += 1) world.update(1 / 60).unwrap();
    expect(world.getResource(FixedTime).tick).toBe(60);
    expect(instance.raw.integrationParameters.numSolverIterations).toBe(iterations ?? 4);
    expect(instance.raw.timestep).toBeCloseTo(1 / 60);
    expect(instance.hasBody(entity)).toBe(true);
    const position = world.get(entity, Transform).unwrap().pos;
    expect(position[1]).toBeGreaterThan(0);
    expect(position[1]).toBeLessThan(9);
    let additions = -1;
    instance.raw.forEachRigidBody((body: { additionalSolverIterations(): number }) => {
      additions = body.additionalSolverIterations();
    });
    expect(additions).toBe(3);
  } finally {
    await context.fiber.dispose();
  }
  expect(world.hasResource('PhysicsWorld')).toBe(false);
});

it('rejects invalid configuration before allocating a native world', async () => {
  const module = await loadRapier2D();
  if ('code' in module) throw module;
  for (const value of [0, -1, 1.5, 33, NaN, Infinity, null]) {
    expect(() => createRapier2DPhysicsWorld(module, { solverIterations: value as number })).toThrow(
      expect.objectContaining({ code: 'invalid-body-config' }),
    );
  }
});
