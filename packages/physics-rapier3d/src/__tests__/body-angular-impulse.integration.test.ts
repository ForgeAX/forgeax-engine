import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('applies a native angular impulse without changing linear momentum or collider identity', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic());
    body.userData = 2;
    physics.registerBody(2, body.handle);
    const collider = physics.raw.createCollider(R.ColliderDesc.cuboid(1, 1, 1).setMass(12), body);
    physics.raw.propagateModifiedBodyPositionsToColliders();
    body.recomputeMassPropertiesFromColliders();
    physics.sleepBody(2).unwrap();
    const before = physics.getBodyMotion(2).unwrap();
    physics.applyBodyAngularImpulse(2, [0, 8, 0]).unwrap();
    const after = physics.getBodyMotion(2).unwrap();
    expect(after.sleeping).toBe(false);
    expect(after.angularVelocity[1]).toBeCloseTo(1, 5);
    expect(after.linearVelocity).toEqual(before.linearVelocity);
    expect(after.position).toEqual(before.position);
    expect(after.rotation).toEqual(before.rotation);
    expect(body.collider(0).handle).toBe(collider.handle);
  } finally {
    physics.dispose();
  }
});

it('refuses missing bodies, static bodies and invalid angular impulses before mutation', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed());
    body.userData = 2;
    physics.registerBody(2, body.handle);
    const before = physics.getBodyMotion(2).unwrap();
    expect(physics.applyBodyAngularImpulse(999, [0, 1, 0]).ok).toBe(false);
    expect(physics.applyBodyAngularImpulse(2, [0, 1, 0]).ok).toBe(false);
    expect(physics.applyBodyAngularImpulse(2, [0, NaN, 0]).ok).toBe(false);
    expect(physics.getBodyMotion(2).unwrap()).toEqual(before);
  } finally {
    physics.dispose();
  }
});
