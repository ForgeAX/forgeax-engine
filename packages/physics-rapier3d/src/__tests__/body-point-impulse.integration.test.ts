import { expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('applies a native world-point impulse around offset COM, wakes and notifies without moving pose', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(10, 0, 0));
    body.userData = 2;
    physics.registerBody(2, body.handle);
    body.setAdditionalMassProperties(
      12,
      { x: 0, y: 1, z: 0 },
      { x: 8, y: 8, z: 8 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    body.recomputeMassPropertiesFromColliders();
    body.sleep();
    const before = physics.getBodyMotion(2).unwrap(),
      notified = vi.fn();
    const release = physics.onBodyMotionChange(notified);
    physics.applyBodyImpulseAtPoint(2, [0, 4, 0], [12, 1, 0]).unwrap();
    const after = physics.getBodyMotion(2).unwrap();
    expect(after.position).toEqual(before.position);
    expect(after.rotation).toEqual(before.rotation);
    expect(after.linearVelocity[1]).toBeCloseTo(1 / 3, 6);
    expect(after.angularVelocity).toEqual([0, 0, 1]);
    expect(after.sleeping).toBe(false);
    expect(notified).toHaveBeenCalledExactlyOnceWith(2);
    release();
    physics
      .setBodyMotion(2, { ...before, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] })
      .unwrap();
    physics.applyBodyImpulseAtPoint(2, [0, 4, 0], [10, 1, 0]).unwrap();
    expect(physics.getBodyMotion(2).unwrap().angularVelocity).toEqual([0, 0, 0]);
  } finally {
    physics.dispose();
  }
});

it('rejects missing, nondynamic and nonfinite point impulses before mutating or waking', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    for (const [entity, desc] of [
      [2, R.RigidBodyDesc.dynamic()],
      [3, R.RigidBodyDesc.fixed()],
      [4, R.RigidBodyDesc.kinematicPositionBased()],
    ] as const) {
      const body = physics.raw.createRigidBody(desc);
      body.userData = entity;
      physics.registerBody(entity, body.handle);
      if (entity === 2) body.sleep();
    }
    const before = physics.getBodyMotion(2).unwrap(),
      notified = vi.fn();
    const release = physics.onBodyMotionChange(notified);
    expect(physics.applyBodyImpulseAtPoint(999, [1, 0, 0], [0, 0, 0]).ok).toBe(false);
    expect(physics.applyBodyImpulseAtPoint(2, [NaN, 0, 0], [0, 0, 0]).ok).toBe(false);
    expect(physics.applyBodyImpulseAtPoint(2, [1, 0, 0], [Infinity, 0, 0]).ok).toBe(false);
    for (const entity of [3, 4])
      expect(physics.applyBodyImpulseAtPoint(entity, [1, 0, 0], [0, 0, 0]).ok).toBe(false);
    expect(physics.getBodyMotion(2).unwrap()).toEqual(before);
    expect(notified).not.toHaveBeenCalled();
    release();
  } finally {
    physics.dispose();
  }
});
