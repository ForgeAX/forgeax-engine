import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('excludes every collider of specified ECS bodies before selecting the nearest ray hit', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    for (const [entity, x, groups] of [
      [11, 0, 0x00010001],
      [22, 4, 0x00020002],
      [33, 8, 0x00010001],
    ] as const) {
      const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 0, 0));
      body.userData = entity;
      physics.registerBody(entity, body.handle);
      physics.raw.createCollider(R.ColliderDesc.cuboid(0.5, 1, 1).setCollisionGroups(groups), body);
      if (entity === 11)
        physics.raw.createCollider(R.ColliderDesc.cuboid(0.5, 1, 1).setTranslation(2, 0, 0), body);
    }
    physics.step(1 / 60);
    const origin = vec3.create(0, 0, 0),
      direction = vec3.create(1, 0, 0);
    expect(physics.raycast(origin, direction, 12)?.entity).toBe(11);
    const hit = physics.raycast(origin, direction, 12, undefined, { excludeEntities: [11] });
    expect(hit?.entity).toBe(22);
    expect(hit?.timeOfImpact).toBeCloseTo(3.5, 5);
    if (!hit) throw Error('Missing native hit beyond the excluded compound');
    expect(Array.from(hit.normal)).toEqual([-1, 0, 0]);
    expect(
      physics.raycast(origin, direction, 12, 0x00010001, { excludeEntities: [11] })?.entity,
    ).toBe(33);
    expect(
      physics.raycast(origin, direction, 12, undefined, { excludeEntities: [11, 22, 33] }),
    ).toBeUndefined();
    expect(physics.raycast(origin, direction, 12, undefined, { excludeEntities: [] })?.entity).toBe(
      11,
    );
    expect(physics.raycast(origin, direction, 12)?.entity).toBe(11);
  } finally {
    physics.dispose();
  }
});
