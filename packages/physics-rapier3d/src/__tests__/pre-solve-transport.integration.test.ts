import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';

it.each([
  'scalar',
  'simd',
] as const)('retains incoming contact velocities through the generated %s WASM ABI', async (transport) => {
  const module =
    transport === 'scalar'
      ? (await import('../../pkg/rapier.mjs')).default
      : (await import('../../pkg/rapier-simd.mjs')).default;
  await module.init();
  const physics = createRapier3DPhysicsWorld(module);
  try {
    const raw = physics.raw;
    raw.gravity = { x: 0, y: 0, z: 0 };
    const wall = raw.createRigidBody(module.RigidBodyDesc.fixed());
    wall.userData = 1;
    raw.createCollider(module.ColliderDesc.cuboid(0.25, 2, 2).setFriction(0), wall);
    physics.registerBody(1, wall.handle);
    const actor = raw.createRigidBody(
      module.RigidBodyDesc.dynamic().setTranslation(-0.51, 0, 0).setLinvel(12, 0, 0),
    );
    actor.userData = 2;
    raw.createCollider(module.ColliderDesc.cuboid(0.25, 0.25, 0.25).setFriction(0), actor);
    physics.registerBody(2, actor.handle);
    physics.step(1 / 60);
    const contacts = physics.getCurrentContacts(2).unwrap().manifolds;
    expect(contacts.length).toBeGreaterThan(0);
    for (const contact of contacts) {
      expect(contact.preSolveVelocities).toHaveLength(contact.points.length);
      for (const velocity of contact.preSolveVelocities) {
        expect(velocity?.body).toEqual([12, 0, 0]);
        expect(velocity?.other).toEqual([0, 0, 0]);
      }
    }
    expect(actor.linvel().x).toBeLessThan(2);
  } finally {
    physics.dispose();
  }
});
