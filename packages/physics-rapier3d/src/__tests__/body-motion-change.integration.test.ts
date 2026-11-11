import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('observes Native writes and the final sleeping pose without polling quiet bodies', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  physics.setGravity(vec3.create(0, 0, 0));
  try {
    expect(typeof physics.onBodyMotionChange).toBe('function');
    const changed = new Set<number>(),
      independent = new Set<number>();
    const stop = physics.onBodyMotionChange((entity) => changed.add(entity));
    const stopIndependent = physics.onBodyMotionChange((entity) => independent.add(entity));
    const fixed = physics.raw.createRigidBody(R.RigidBodyDesc.fixed());
    fixed.userData = 1;
    physics.registerBody(1, fixed.handle);
    const dynamic = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic());
    dynamic.userData = 2;
    physics.registerBody(2, dynamic.handle);
    physics.raw.createCollider(R.ColliderDesc.ball(0.5), dynamic);
    const kinematic = physics.raw.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    kinematic.userData = 3;
    physics.registerBody(3, kinematic.handle);
    expect([...changed]).toEqual([1, 2, 3]);
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    changed.clear();
    physics.teleport(1, vec3.create(1, 2, 3));
    expect(changed.has(1)).toBe(true);
    expect(physics.getBodyMotion(1).unwrap().position).toEqual([1, 2, 3]);
    changed.clear();
    physics
      .setBodyMotion(1, {
        position: [3, 2, 1],
        rotation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      })
      .unwrap();
    expect(changed.has(1)).toBe(true);
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    changed.clear();
    physics.setKinematicPosition(3, { x: 4, y: 0, z: 0 });
    changed.clear(); // Consuming the request must not lose the completed pose.
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    expect(changed.has(3)).toBe(true);
    expect(physics.getBodyMotion(3).unwrap().position[0]).toBe(4);
    changed.clear();
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    expect(changed.has(3)).toBe(true);
    expect(physics.getBodyMotion(3).unwrap().linearVelocity).toEqual([0, 0, 0]);
    changed.clear();
    physics.applyBodyImpulse(2, [1, 0, 0]).unwrap();
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    expect(changed.has(2)).toBe(true);
    physics.sleepBody(2).unwrap();
    changed.clear();
    physics.step(1 / 60);
    physics.writebackDynamicBodies();
    expect(changed.has(2)).toBe(true);
    expect(physics.getBodyMotion(2).unwrap().sleeping).toBe(true);
    changed.clear();
    for (let i = 0; i < 5; i++) {
      physics.step(1 / 60);
      physics.writebackDynamicBodies();
    }
    expect([...changed]).toEqual([]);
    physics.wakeBody(2).unwrap();
    expect(changed.has(2)).toBe(true);
    physics.removeEntity(1);
    expect(changed.has(1)).toBe(true);
    stop();
    changed.clear();
    independent.clear();
    physics.teleport(3, vec3.create(5, 0, 0));
    expect(changed.size).toBe(0);
    expect(independent.has(3)).toBe(true);
    stopIndependent();
    stopIndependent();
  } finally {
    physics.dispose();
  }
});
