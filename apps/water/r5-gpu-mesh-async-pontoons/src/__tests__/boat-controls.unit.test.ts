import { defineSystem } from '@forgeax/engine/ecs';
import { PhysicsSimulation, PhysicsSync, PhysicsWorldResource } from '@forgeax/engine/physics';
import { createWorldContext, FixedUpdate, World } from '@forgeax/engine/ecs';
import { vec3 } from '@forgeax/engine/math';
import { Collider, type PhysicsWorld, RigidBody } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { expect, it } from 'vitest';
import { applyBoatControls } from '../boat-controls';

it('moves the native boat with motor and rudder forces without writing its pose', async () => {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  physics.setGravity(vec3.create());
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { mass: 125 } },
      { component: Collider, data: { halfExtents: [1.8, 0.3, 0.75] } },
    )
    .unwrap();
  let throttle = 1;
  let steering = 0;
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'boatControlTest',
        after: [PhysicsSync],
        before: [PhysicsSimulation],
        queries: [],
        fn: () =>
          applyBoatControls(physics, entity, {
            throttle,
            steering,
            cargoKg: 0,
            cargoPositionM: [0, 0, 0],
          }),
      }),
    )
    .unwrap();
  try {
    for (let tick = 0; tick < 60; tick++) world.update(1 / 60).unwrap();
    const underway = physics.getCommittedBodyDynamics?.(entity).unwrap();
    expect(underway?.linearVelocityMps[0]).toBeGreaterThan(1);
    expect(underway?.positionM[0]).toBeGreaterThan(0.5);
    steering = 1;
    for (let tick = 0; tick < 20; tick++) world.update(1 / 60).unwrap();
    const turning = physics.getCommittedBodyDynamics?.(entity).unwrap();
    expect(Math.abs(turning?.angularVelocityRadps[1] ?? 0)).toBeGreaterThan(0.1);
    throttle = 0;
    steering = 0;
    const speed = Math.hypot(...(turning?.linearVelocityMps ?? []));
    for (let tick = 0; tick < 10; tick++) world.update(1 / 60).unwrap();
    expect(
      Math.hypot(...(physics.getCommittedBodyDynamics?.(entity).unwrap().linearVelocityMps ?? [])),
    ).toBeCloseTo(speed, 3);
  } finally {
    await context.fiber.dispose();
  }
});

it('relocates cargo weight into a roll torque without applying duplicate total gravity', async () => {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { mass: 200 } },
        { component: Collider, data: { halfExtents: [1.8, 0.3, 0.75], isSensor: true } },
      )
      .unwrap();
  const centered = spawn(),
    loaded = spawn();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'cargoControlTest',
        after: [PhysicsSync],
        before: [PhysicsSimulation],
        queries: [],
        fn: () =>
          applyBoatControls(physics, loaded, {
            throttle: 0,
            steering: 0,
            cargoKg: 75,
            cargoPositionM: [0, 0.95, 0.55],
          }),
      }),
    )
    .unwrap();
  try {
    for (let tick = 0; tick < 10; tick++) world.update(1 / 60).unwrap();
    const a = physics.getCommittedBodyDynamics?.(centered).unwrap();
    const b = physics.getCommittedBodyDynamics?.(loaded).unwrap();
    expect(b?.massKg).toBeCloseTo(a?.massKg ?? 0);
    expect(b?.linearVelocityMps[1]).toBeCloseTo(a?.linearVelocityMps[1] ?? 0, 4);
    expect(Math.abs(b?.angularVelocityRadps[0] ?? 0)).toBeGreaterThan(0.1);
    expect(a?.angularVelocityRadps[0]).toBeCloseTo(0, 5);
  } finally {
    await context.fiber.dispose();
  }
});
