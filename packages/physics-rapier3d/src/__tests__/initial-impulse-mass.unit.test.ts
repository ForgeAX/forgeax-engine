import { vec3 } from '@forgeax/engine-math';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

it.each([
  0, 0.8, 18,
])('publishes additional mass %s before the first post-sync impulse', async (mass) => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const physics = createRapier3DPhysicsWorld(rapier);
  try {
    physics.setGravity(vec3.create(0, 0, 0));
    const transform = {
      position: { x: 0, y: 3, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 0.38, y: 0.38, z: 0.38 },
    };
    const rigidBody = {
      type: 1,
      mass,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      ccdEnabled: 1,
    };
    const collider = {
      shape: 0,
      mesh: 0 as AssetHandle<'mesh'>,
      halfExtents: [0.38, 0.38, 0.38],
      radius: 0.38,
      halfHeight: 0.38,
      friction: 0.5,
      restitution: 0,
      density: 1,
      isSensor: false,
      collisionGroups: 0xffffffff,
      solverGroups: 0xffffffff,
    };
    physics.ensureBody(1, transform, rigidBody, collider);
    const expectedMass = mass + (2 * 0.38 * 0.38) ** 3;
    expect(physics.getDerivedBodyMass(1)).toBeCloseTo(expectedMass, 5);
    physics.applyBodyImpulse(1, [1.6, 0, 0]).unwrap();
    expect(physics.getBodyMotion(1).unwrap().linearVelocity[0]).toBeCloseTo(1.6 / expectedMass, 4);
    physics.step(1 / 60);
    const velocity = physics.getBodyMotion(1).unwrap().linearVelocity[0];
    expect(velocity).toBeCloseTo(1.6 / expectedMass, 4);
    // An idempotent sync must preserve motion instead of applying creation policy again.
    physics.ensureBody(1, transform, rigidBody, collider);
    expect(physics.getBodyMotion(1).unwrap().linearVelocity[0]).toBe(velocity);
  } finally {
    physics.dispose();
  }
});
