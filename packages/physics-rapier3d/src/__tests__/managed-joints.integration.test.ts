import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  type ManagedJointInput,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld, loadRapier3D, registerPhysicsSystems } from '../index.js';

async function fixture() {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const unregister = registerPhysicsSystems(world);
  const bodies = [0, 1, 2].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 4, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 0 } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.sphere, radius: 0.2, density: 1 },
        },
      )
      .unwrap(),
  );
  world.update(1 / 60).unwrap();
  const joint = (a: number, b: number): ManagedJointInput => ({
    kind: 'hinge',
    bodyA: bodies[a] as number,
    bodyB: bodies[b] as number,
    anchorA: [0.5, 0, 0],
    anchorB: [-0.5, 0, 0],
    axisA: [0, 0, 1],
    axisB: [0, 0, 1],
    limits: [-0.5, 0.5],
  });
  return {
    world,
    physics,
    bodies,
    joint,
    dispose: async () => {
      unregister();
      physics.dispose();
      await context.fiber.dispose();
    },
  };
}

describe('ordinary managed constraints on the real Rapier solver', () => {
  it('rejects malformed JSON joint groups before native allocation', async () => {
    const f = await fixture();
    try {
      for (const input of [
        null,
        {},
        [null],
        [f.joint(0, 1), null],
        [{ ...f.joint(0, 1), contactsEnabled: 'yes' }],
      ]) {
        const result = f.physics.createManagedJoints(
          input as unknown as readonly ManagedJointInput[],
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('managed-joint-invalid');
        expect(f.physics.getJointCount()).toBe(0);
      }
    } finally {
      await f.dispose();
    }
  });

  it('retains positive collider-derived mass and isotropic sphere inertia in the native body', async () => {
    const f = await fixture();
    try {
      let native: NativeBody | undefined;
      (f.physics.raw as NativeWorld).forEachRigidBody((body) => {
        if (body.userData === f.bodies[0]) native = body;
      });
      if (!native) throw new Error('native fixture body missing');
      const mass = (4 / 3) * Math.PI * 0.2 ** 3;
      expect(native.mass()).toBeCloseTo(mass, 6);
      const inertia = native.principalInertia();
      for (const axis of [inertia.x, inertia.y, inertia.z])
        expect(axis).toBeCloseTo(0.4 * mass * 0.2 ** 2, 6);
    } finally {
      await f.dispose();
    }
  });

  it('validates a whole group before any native constraint and releases its lease idempotently', async () => {
    const f = await fixture();
    try {
      const invalid = f.physics.createManagedJoints([
        f.joint(0, 1),
        { ...f.joint(1, 2), anchorA: [NaN, 0, 0] },
      ]);
      expect(invalid.ok).toBe(false);
      expect(f.physics.getJointCount()).toBe(0);
      const lease = f.physics.createManagedJoints([f.joint(0, 1), f.joint(1, 2)]).unwrap();
      expect(f.physics.getJointCount()).toBe(2);
      f.physics.applyBodyImpulse(f.bodies[2] as number, [0, 0, 1]).unwrap();
      for (let i = 0; i < 120; i++) f.world.update(1 / 60).unwrap();
      for (const body of f.bodies) {
        const motion = f.physics.getBodyMotion(body).unwrap();
        expect(
          [
            ...motion.position,
            ...motion.rotation,
            ...motion.linearVelocity,
            ...motion.angularVelocity,
          ].every(Number.isFinite),
        ).toBe(true);
      }
      lease.dispose();
      lease.dispose();
      expect(f.physics.getJointCount()).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('rolls back the first constraint when the second native allocation fails', async () => {
    const f = await fixture();
    const original = f.physics.raw.createImpulseJoint.bind(f.physics.raw);
    let calls = 0;
    try {
      f.physics.raw.createImpulseJoint = (...args: Parameters<typeof original>) => {
        if (++calls === 2) throw new Error('managed-joint-allocation-fault');
        return original(...args);
      };
      const result = f.physics.createManagedJoints([f.joint(0, 1), f.joint(1, 2)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('managed-physics-failed');
      expect(f.physics.getJointCount()).toBe(0);
    } finally {
      f.physics.raw.createImpulseJoint = original;
      await f.dispose();
    }
  });
  it('reports rebuild-required when rollback cannot retire a native handle', async () => {
    const f = await fixture();
    const create = f.physics.raw.createImpulseJoint.bind(f.physics.raw);
    const remove = f.physics.raw.removeImpulseJoint.bind(f.physics.raw);
    let calls = 0;
    try {
      f.physics.raw.createImpulseJoint = (...args: Parameters<typeof create>) => {
        if (++calls === 2) throw new Error('managed-joint-allocation-fault');
        return create(...args);
      };
      f.physics.raw.removeImpulseJoint = () => {
        throw new Error('managed-joint-cleanup-fault');
      };
      const result = f.physics.createManagedJoints([f.joint(0, 1), f.joint(1, 2)]);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === 'managed-physics-failed')
        expect(result.error.detail.recovery).toBe('rebuild-required');
      expect(f.physics.getJointCount()).toBe(1);
    } finally {
      f.physics.raw.createImpulseJoint = create;
      f.physics.raw.removeImpulseJoint = remove;
      await f.dispose();
    }
  });
});
