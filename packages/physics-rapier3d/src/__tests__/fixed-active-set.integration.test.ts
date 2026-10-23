import { expect, it } from 'vitest';
import type { RigidBody } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

// A parked (dynamic -> fixed) body must leave the native active set: fixed
// bodies never sleep, so staying there kept them in every step's active work.
it('removes a body turned fixed from the active set and restores it when dynamic again', async () => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    const raw = physics.raw;
    const floor = raw.createRigidBody(module.RigidBodyDesc.fixed());
    raw.createCollider(module.ColliderDesc.cuboid(50, 0.1, 50), floor);
    const [left, parked, right] = [0, 2, 4].map((x) => {
      const body = raw.createRigidBody(
        module.RigidBodyDesc.dynamic().setTranslation(x, 1, 0).setCcdEnabled(true),
      );
      raw.createCollider(module.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
      return body;
    }) as [RigidBody, RigidBody, RigidBody];
    const bodies = [left, parked, right];
    const active = () => {
      const handles: number[] = [];
      raw.forEachActiveRigidBody((body) => handles.push(body.handle));
      return handles.sort((a, b) => a - b);
    };
    for (let step = 0; step < 10; step += 1) raw.step();
    expect(active()).toEqual(bodies.map((body) => body.handle).sort((a, b) => a - b));
    parked.setBodyType(module.RigidBodyType.Fixed, true);
    raw.step();
    expect(active()).toEqual([left.handle, right.handle].sort((a, b) => a - b));
    for (let step = 0; step < 30; step += 1) raw.step();
    expect(active()).not.toContain(parked.handle);
    parked.setBodyType(module.RigidBodyType.Dynamic, true);
    raw.step();
    expect(active()).toContain(parked.handle);
    // The remaining active bodies keep simulating and can still fall asleep.
    for (let step = 0; step < 600; step += 1) raw.step();
    expect(active()).toEqual([]);
    expect(bodies.every((body) => body.isSleeping())).toBe(true);
  } finally {
    physics.dispose();
  }
});
