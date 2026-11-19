import { expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('reads detached native mass, rotated COM and world inverse inertia without waking or notifying', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(10, 2, 3)
        .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }),
    );
    body.userData = 2;
    physics.registerBody(2, body.handle);
    body.setAdditionalMassProperties(
      12,
      { x: 0, y: 1, z: 0 },
      { x: 2, y: 4, z: 8 },
      { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) },
      true,
    );
    body.recomputeMassPropertiesFromColliders();
    body.sleep();
    const before = physics.getBodyMotion(2).unwrap(),
      notified = vi.fn();
    const release = physics.onBodyMotionChange(notified);
    const properties = physics.getBodyMassProperties(2).unwrap();
    expect(properties.mass).toBeCloseTo(12, 5);
    expect(properties.inverseMass).toBeCloseTo(1 / 12, 6);
    expect(properties.centerOfMass).toEqual([9, 2, 3]);
    const expected = [0.375, -0.125, 0, -0.125, 0.375, 0, 0, 0, 0.125];
    properties.inverseInertia.forEach((value, index) => {
      const target = expected[index];
      if (target === undefined) throw new Error(`Missing inertia expectation ${index}`);
      expect(value).toBeCloseTo(target, 6);
    });
    properties.effectiveInverseMass.forEach((value) => {
      expect(value).toBeCloseTo(1 / 12, 6);
    });
    expect(physics.getBodyMotion(2).unwrap()).toEqual(before);
    expect(notified).not.toHaveBeenCalled();
    body.setTranslation({ x: 20, y: 2, z: 3 }, false);
    expect(physics.getBodyMassProperties(2).unwrap().centerOfMass).toEqual([19, 2, 3]);
    expect(properties.centerOfMass).toEqual([9, 2, 3]);
    release();
  } finally {
    physics.dispose();
  }
});

it('reads native locked mobility and immobile bodies and rejects retired entities', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic());
    body.userData = 2;
    physics.registerBody(2, body.handle);
    body.setAdditionalMassProperties(
      12,
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 4, z: 8 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    body.recomputeMassPropertiesFromColliders();
    body.setEnabledTranslations(true, false, true, false);
    body.setEnabledRotations(false, true, false, false);
    const locked = physics.getBodyMassProperties(2).unwrap();
    expect(locked.effectiveInverseMass[1]).toBe(0);
    expect(locked.effectiveInverseMass[0]).toBeCloseTo(1 / 12, 6);
    expect(locked.inverseInertia).toEqual([0, 0, 0, 0, 0.25, 0, 0, 0, 0]);
    for (const [entity, desc] of [
      [3, R.RigidBodyDesc.fixed()],
      [4, R.RigidBodyDesc.kinematicPositionBased()],
    ] as const) {
      const stationary = physics.raw.createRigidBody(desc);
      stationary.userData = entity;
      physics.registerBody(entity, stationary.handle);
      const properties = physics.getBodyMassProperties(entity).unwrap();
      expect(properties.effectiveInverseMass).toEqual([0, 0, 0]);
      expect(properties.inverseInertia).toEqual(Array(9).fill(0));
    }
    physics.removeEntity(2);
    expect(physics.getBodyMassProperties(2).ok).toBe(false);
    expect(physics.getBodyMassProperties(999).ok).toBe(false);
  } finally {
    physics.dispose();
  }
});
