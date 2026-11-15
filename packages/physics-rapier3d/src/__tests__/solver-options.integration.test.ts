import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsOptions,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import physics from '../plugin.js';
import { requireRapierPhysicsWorld3D } from '../rapier-physics-world-3d';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  undefined,
  1,
  2,
  8,
  32,
])('constructs a native world with %s solver iterations', async (iterations) => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const options: PhysicsOptions = iterations === undefined ? {} : { solverIterations: iterations };
  const instance = createRapier3DPhysicsWorld(module, options);
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
    const instance = requireRapierPhysicsWorld3D(world);
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
  expect(world.hasResource(PhysicsWorldResource)).toBe(false);
});

it('rejects invalid configuration before allocating a native world', async () => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  for (const value of [0, -1, 1.5, 33, NaN, Infinity, null]) {
    expect(() => createRapier3DPhysicsWorld(module, { solverIterations: value as number })).toThrow(
      expect.objectContaining({ code: 'invalid-body-config' }),
    );
  }
});

it('keeps Rapier native profiling off by default and emits only fresh successful step timing', async () => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;

  const ordinary = createRapier3DPhysicsWorld(module);
  expect(ordinary.raw.profilerEnabled).toBe(false);
  const unusedTimingRead = vi.fn(() => 0);
  ordinary.raw.timingStep = unusedTimingRead;
  ordinary.step(1 / 60);
  expect(unusedTimingRead).not.toHaveBeenCalled();
  ordinary.dispose();

  const profiled = createRapier3DPhysicsWorld(module, { profileNativeStepTimings: true });
  expect(profiled.raw.profilerEnabled).toBe(false);
  const samples: Array<{ nativeStepIndex: number; fixedStep: number; timingMs: { step: number } }> =
    [];
  const stopObserving = profiled.observeNativeStepTiming?.((sample) => samples.push(sample));
  expect(profiled.raw.profilerEnabled).toBe(true);

  let latestStepMs = 1;
  profiled.raw.step = vi.fn();
  profiled.raw.timingStep = vi.fn(() => latestStepMs);
  for (const method of [
    'timingUserChanges',
    'timingIslandConstruction',
    'timingBroadPhase',
    'timingNarrowPhase',
    'timingCollisionDetection',
    'timingSolver',
    'timingVelocityAssembly',
    'timingVelocityResolution',
    'timingVelocityUpdate',
    'timingVelocityWriteback',
    'timingCcd',
    'timingCcdToiComputation',
    'timingCcdBroadPhase',
    'timingCcdNarrowPhase',
    'timingCcdSolver',
  ])
    profiled.raw[method] = vi.fn(() => latestStepMs);

  profiled.step(1 / 60);
  latestStepMs = 2;
  profiled.step(1 / 30);
  expect(
    samples.map(({ nativeStepIndex, fixedStep, timingMs }) => [
      nativeStepIndex,
      fixedStep,
      timingMs.step,
    ]),
  ).toEqual([
    [1, 1, 1],
    [2, 2, 2],
  ]);
  expect(Object.isFrozen(samples[0])).toBe(true);
  expect(Object.isFrozen(samples[0]?.timingMs)).toBe(true);

  let releaseMutating = () => {};
  const mutating = vi.fn(() => {
    releaseMutating();
    releaseMutating = profiled.observeNativeStepTiming?.(mutating) ?? (() => {});
  });
  releaseMutating = profiled.observeNativeStepTiming?.(mutating) ?? (() => {});
  profiled.step(1 / 60);
  expect(mutating).toHaveBeenCalledTimes(1);
  releaseMutating();

  profiled.step(0);
  profiled.step(Number.NaN);
  expect(samples).toHaveLength(3);
  profiled.raw.timingStep = vi.fn(() => {
    throw new Error('timing getter failed');
  });
  expect(() => profiled.step(1 / 60)).not.toThrow();
  expect(samples).toHaveLength(3);
  profiled.raw.step = vi.fn(() => {
    throw new Error('native integration failed');
  });
  expect(() => profiled.step(1 / 60)).toThrow();
  expect(samples).toHaveLength(3);
  stopObserving?.();
  expect(profiled.raw.profilerEnabled).toBe(false);
  const releaseBeforeDispose = profiled.observeNativeStepTiming?.(() => {});
  profiled.dispose();
  expect(() => releaseBeforeDispose?.()).not.toThrow();
  const releaseAfterDispose = profiled.observeNativeStepTiming?.(() => {});
  expect(() => releaseAfterDispose?.()).not.toThrow();
});

it('emits each real Rapier step in a multi-substep host update', async () => {
  const world = new World();
  const context = await createWorldContext(world, [
    {
      async apply(ctx) {
        await ctx.plugin(physics, { profileNativeStepTimings: true });
      },
    },
  ]);
  const instance = requireRapierPhysicsWorld3D(world);
  const samples: Array<{ fixedStep: number; deltaSeconds: number }> = [];
  const stopObserving = instance.observeNativeStepTiming?.((sample) => samples.push(sample));
  try {
    expect(world.update(1 / 30).ok).toBe(true);
    expect(world.getResource(FixedTime).tick).toBe(2);
    expect(samples.map(({ fixedStep }) => fixedStep)).toEqual([1, 2]);
    expect(samples.map(({ deltaSeconds }) => deltaSeconds)).toEqual([1 / 60, 1 / 60]);
  } finally {
    stopObserving?.();
    await context.fiber.dispose();
  }
});
