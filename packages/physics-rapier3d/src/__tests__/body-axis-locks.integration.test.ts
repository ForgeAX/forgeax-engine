import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: RigidBody,
        data: {
          type: RigidBodyTypeValue.dynamic,
          gravityScale: 0,
          translationAxes: 5,
          rotationAxes: 2,
        },
      },
      { component: Collider, data: { halfExtents: [1, 1, 1] } },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(R);
  physics._syncFromEcs(world, Transform, GlobalTransform);
  return { world, entity, physics };
}

it('enforces authored per-axis freedoms for native impulses and explicit motion, then unlocks', async () => {
  const f = await fixture();
  try {
    const motion = f.physics.getBodyMotion(f.entity).unwrap();
    f.physics
      .setBodyMotion(f.entity, { ...motion, linearVelocity: [1, 2, 3], angularVelocity: [4, 5, 6] })
      .unwrap();
    expect(f.physics.getBodyMotion(f.entity).unwrap().linearVelocity).toEqual([1, 0, 3]);
    expect(f.physics.getBodyMotion(f.entity).unwrap().angularVelocity).toEqual([0, 5, 0]);
    f.physics.applyBodyImpulse(f.entity, [1, 100, 1]).unwrap();
    f.physics.applyBodyAngularImpulse(f.entity, [100, 1, 100]).unwrap();
    for (let i = 0; i < 10; i++) f.physics.step(1 / 60);
    expect(f.physics.getBodyMotion(f.entity).unwrap().position[1]).toBe(0);
    expect(f.physics.getBodyMotion(f.entity).unwrap().angularVelocity[0]).toBe(0);
    expect(f.physics.getBodyMotion(f.entity).unwrap().angularVelocity[2]).toBe(0);
    f.world.set(f.entity, RigidBody, { translationAxes: 7, rotationAxes: 7 }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    f.physics.applyBodyImpulse(f.entity, [0, 10, 0]).unwrap();
    f.physics.applyBodyAngularImpulse(f.entity, [10, 0, 0]).unwrap();
    const after = f.physics.getBodyMotion(f.entity).unwrap();
    expect(after.linearVelocity[1]).toBeGreaterThan(0);
    expect(after.angularVelocity[0]).toBeGreaterThan(0);
  } finally {
    f.physics.dispose();
  }
});

it('clears newly locked velocity axes and retains full rotation-lock precedence', async () => {
  const f = await fixture();
  try {
    const motion = f.physics.getBodyMotion(f.entity).unwrap();
    f.physics
      .setBodyMotion(f.entity, { ...motion, linearVelocity: [1, 0, 3], angularVelocity: [0, 5, 0] })
      .unwrap();
    f.world.set(f.entity, RigidBody, { translationAxes: 0, lockRotation: true }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    const locked = f.physics.getBodyMotion(f.entity).unwrap();
    expect(locked.linearVelocity).toEqual([0, 0, 0]);
    expect(locked.angularVelocity).toEqual([0, 0, 0]);
    f.world.set(f.entity, RigidBody, { lockRotation: false }).unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    f.physics.applyBodyAngularImpulse(f.entity, [10, 10, 10]).unwrap();
    const angular = f.physics.getBodyMotion(f.entity).unwrap().angularVelocity;
    expect(angular[0]).toBe(0);
    expect(angular[1]).toBeGreaterThan(0);
    expect(angular[2]).toBe(0);
  } finally {
    f.physics.dispose();
  }
});

it('preserves axis restrictions when a derived admission restores velocities', async () => {
  const f = await fixture();
  try {
    const candidate = f.physics
      .prepareDerivedShapeCandidate({
        entity: f.entity,
        revision: 1,
        sourceKey: 'hull',
        shapes: [
          {
            id: 'hull',
            revision: 1,
            kind: 'convex-compound',
            pieces: [boxPoints([-1, -1, -1], [1, 1, 1])],
          },
        ],
        massProperties: {
          mode: 'explicit',
          mass: 12,
          centerOfMass: [0, 0, 0],
          principalInertia: [8, 8, 8],
        },
        motion: { centerOfMass: [0, 0, 0], linearVelocity: [1, 2, 3], angularVelocity: [4, 5, 6] },
      })
      .unwrap();
    f.physics.admitDerivedShapeCandidate(candidate).unwrap();
    f.physics.step(1 / 60);
    const after = f.physics.getBodyMotion(f.entity).unwrap();
    expect(after.linearVelocity[1]).toBe(0);
    expect(after.angularVelocity[0]).toBe(0);
    expect(after.angularVelocity[2]).toBe(0);
    expect(after.position[1]).toBe(0);
  } finally {
    f.physics.dispose();
  }
});

it('rejects invalid authored masks before replacing native colliders or velocity', async () => {
  const f = await fixture();
  try {
    const before = f.physics.getBodyMotion(f.entity).unwrap();
    f.world.set(f.entity, RigidBody, { translationAxes: 8 }).unwrap();
    expect(() => f.physics._syncFromEcs(f.world, Transform, GlobalTransform)).toThrow();
    expect(f.physics.getBodyMotion(f.entity).unwrap()).toEqual(before);
    expect(f.physics.hasBody(f.entity)).toBe(true);
  } finally {
    f.physics.dispose();
  }
});
