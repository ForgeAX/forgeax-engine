import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  physics.setGravity(vec3.create());
  const bodies = [2, 3, 4].map((entity, i) => {
    const b = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(i * 3, 0, 0));
    b.userData = entity;
    physics.registerBody(entity, b.handle);
    return b;
  });
  return { R, physics, bodies };
}
it('counts actual managed impulse joints per live owner without including unrelated Bodies or changing motion', async () => {
  const { physics } = await fixture();
  try {
    const before = physics.getBodyMotion(2).unwrap();
    expect(physics.getBodyConstraintCount(2).unwrap()).toBe(0);
    const lease = physics
      .createManagedJoints([
        {
          kind: 'fixed',
          bodyA: 2,
          bodyB: 3,
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          frameA: [0, 0, 0, 1],
          frameB: [0, 0, 0, 1],
        },
      ])
      .unwrap();
    expect(physics.getBodyConstraintCount(2).unwrap()).toBe(1);
    expect(physics.getBodyConstraintCount(3).unwrap()).toBe(1);
    expect(physics.getBodyConstraintCount(4).unwrap()).toBe(0);
    expect(physics.getBodyMotion(2).unwrap()).toEqual(before);
    lease.dispose();
    expect(physics.getBodyConstraintCount(2).unwrap()).toBe(0);
  } finally {
    physics.dispose();
  }
});
it('includes foreign Native multibody joints absent from the derived roster and releases them exactly', async () => {
  const { R, physics, bodies } = await fixture();
  try {
    const v = { x: 0, y: 0, z: 0 },
      q = { x: 0, y: 0, z: 0, w: 1 };
    const joint = physics.raw.createMultibodyJoint(
      R.JointData.fixed(v, q, v, q),
      required(bodies[0]),
      required(bodies[1]),
      true,
    );
    expect(physics.getDerivedConstraintStates()).toEqual([]);
    expect(physics.getJointCount()).toBe(0);
    expect(physics.getBodyConstraintCount(2).unwrap()).toBe(1);
    expect(physics.getBodyConstraintCount(3).unwrap()).toBe(1);
    expect(physics.getBodyConstraintCount(4).unwrap()).toBe(0);
    physics.raw.removeMultibodyJoint(joint, true);
    expect(physics.getBodyConstraintCount(2).unwrap()).toBe(0);
  } finally {
    physics.dispose();
  }
});
it('rejects missing/retired owners, native execution and disposal without exposing a Native handle', async () => {
  const { physics, bodies } = await fixture();
  expect(physics.getBodyConstraintCount(-1).ok).toBe(false);
  expect(physics.getBodyConstraintCount(900).ok).toBe(false);
  const original = physics.raw.step.bind(physics.raw);
  let refused = false;
  physics.raw.step = (...args: Parameters<typeof original>) => {
    refused = !physics.getBodyConstraintCount(2).ok;
    return original(...args);
  };
  physics.step(1 / 60);
  expect(refused).toBe(true);
  physics.raw.step = original;
  physics.raw.removeRigidBody(required(bodies[0]));
  expect(physics.getBodyConstraintCount(2).ok).toBe(false);
  physics.dispose();
  expect(physics.getBodyConstraintCount(3).ok).toBe(false);
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value');
  return value;
}
