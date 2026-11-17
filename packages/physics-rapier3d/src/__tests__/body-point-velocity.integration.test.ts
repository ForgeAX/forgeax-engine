import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('reads native point velocity including angular velocity around an offset center of mass', async () => {
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
    body.setLinvel({ x: 3, y: 4, z: 5 }, true);
    body.setAngvel({ x: 0, y: 0, z: 2 }, true);
    const before = physics.getBodyMotion(2).unwrap();
    expect(physics.getBodyPointVelocity(2, [12, 1, 0]).unwrap()).toEqual([3, 8, 5]);
    expect(physics.getBodyMotion(2).unwrap()).toEqual(before);
  } finally {
    physics.dispose();
  }
});

it('reads stationary bodies and rejects missing bodies or invalid points without mutation', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed());
    body.userData = 2;
    physics.registerBody(2, body.handle);
    expect(physics.getBodyPointVelocity(2, [3, 4, 5]).unwrap()).toEqual([0, 0, 0]);
    expect(physics.getBodyPointVelocity(999, [0, 0, 0]).ok).toBe(false);
    expect(physics.getBodyPointVelocity(2, [NaN, 0, 0]).ok).toBe(false);
  } finally {
    physics.dispose();
  }
});
