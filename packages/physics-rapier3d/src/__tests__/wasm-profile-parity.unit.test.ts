import { expect, it } from 'vitest';
import scalar from '../../pkg/rapier.mjs';
import simd from '../../pkg/rapier-simd.mjs';

type NativeWorld = InstanceType<typeof scalar.World>;

function state(world: NativeWorld): number[][] {
  const rows: number[][] = [];
  world.forEachRigidBody((body) => {
    const position = body.translation();
    const rotation = body.rotation();
    const velocity = body.linvel();
    const angular = body.angvel();
    rows.push([
      body.handle,
      body.bodyType(),
      Number(body.isSleeping()),
      position.x,
      position.y,
      position.z,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
      velocity.x,
      velocity.y,
      velocity.z,
      angular.x,
      angular.y,
      angular.z,
    ]);
  });
  return rows;
}

function fixture(module: typeof scalar): NativeWorld {
  const world = new module.World({ x: 0, y: -9.81, z: 0 });
  const floor = world.createRigidBody(module.RigidBodyDesc.fixed());
  world.createCollider(module.ColliderDesc.cuboid(8, 0.1, 8).setTranslation(0, -0.1, 0), floor);
  for (let index = 0; index < 128; index++) {
    const body = world.createRigidBody(
      module.RigidBodyDesc.dynamic()
        .setTranslation(
          (index % 4) * 0.12,
          0.5 + Math.floor(index / 16) * 0.12,
          (Math.floor(index / 4) % 4) * 0.12,
        )
        .setCcdEnabled(true)
        .setLinearDamping(0.15)
        .setAngularDamping(0.25),
    );
    const collider =
      index % 3 === 0
        ? module.ColliderDesc.capsule(0.025, 0.05)
        : index % 3 === 1
          ? module.ColliderDesc.ball(0.05)
          : module.ColliderDesc.cuboid(0.05, 0.05, 0.05);
    world.createCollider(
      collider
        .setMass(0.02)
        .setFriction(0.8)
        .setRestitution(0.04)
        .setActiveEvents(module.ActiveEvents.COLLISION_EVENTS),
      body,
    );
  }
  const fast = world.createRigidBody(
    module.RigidBodyDesc.dynamic()
      .setTranslation(3, 2, 0)
      .setLinvel(0, -100, 0)
      .setCcdEnabled(true),
  );
  world.createCollider(module.ColliderDesc.ball(0.05).setMass(0.02), fast);
  return world;
}

it('keeps scalar and SIMD contacts, body motion and sleeping identical across fixed steps', async () => {
  await scalar.init();
  await simd.init();
  const before = fixture(scalar);
  const after = fixture(simd);
  const scalarEvents = new scalar.EventQueue(true);
  const simdEvents = new simd.EventQueue(true);
  try {
    let eventCount = 0;
    for (let step = 0; step < 240; step++) {
      before.step(scalarEvents);
      after.step(simdEvents);
      const original: number[][] = [];
      const optimized: number[][] = [];
      scalarEvents.drainCollisionEvents((a, b, started) => original.push([a, b, Number(started)]));
      simdEvents.drainCollisionEvents((a, b, started) => optimized.push([a, b, Number(started)]));
      eventCount += original.length;
      expect(optimized, `ordered events at step ${step}`).toEqual(original);
      expect(state(after), `body state at step ${step}`).toEqual(state(before));
    }
    expect(eventCount).toBeGreaterThan(0);
  } finally {
    scalarEvents.free();
    simdEvents.free();
    before.free();
    after.free();
  }
});

it('restores a scalar native snapshot into SIMD without changing subsequent motion', async () => {
  await scalar.init();
  await simd.init();
  const original = fixture(scalar);
  for (let step = 0; step < 60; step++) original.step();
  const restored = simd.World.restoreSnapshot(original.takeSnapshot());
  try {
    expect(state(restored)).toEqual(state(original));
    for (let step = 0; step < 60; step++) {
      original.step();
      restored.step();
      expect(state(restored), `restored step ${step}`).toEqual(state(original));
    }
  } finally {
    original.free();
    restored.free();
  }
});
