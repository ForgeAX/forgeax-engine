import { Collider, ColliderShapeValue, RigidBody, snapshotCollider, registerPhysicsComponents } from '@forgeax/engine-physics';
import { World } from '@forgeax/engine-ecs';
import { loadRapier2D } from '../src/wasm-loader';
import { createRapier2DPhysicsWorld } from '../src/rapier-physics-world-2d';
import { expect, test } from 'vitest';

test.each(['cylinder', 'cone', 'convexHull', 'trimesh'] as const)('G28: 2D rejects %s without leaking a native body', async shape => {
  const rapier = await loadRapier2D();
  if ('code' in rapier) throw rapier;
  const world = new World(); registerPhysicsComponents(world);
  const entity = world.spawn({ component: Collider, data: { shape: ColliderShapeValue[shape] } }, { component: RigidBody, data: {} }).unwrap();
  const physics = createRapier2DPhysicsWorld(rapier);
  const rigidBody = world.get(entity, RigidBody).unwrap();
  const collider = snapshotCollider(world.get(entity, Collider).unwrap());
  try {
    expect(() => physics.ensureBody(entity, { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, rigidBody, collider)).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
    expect(physics.hasBody(entity)).toBe(false);
    let bodies = 0; physics.raw.forEachRigidBody(() => { bodies++; });
    expect(bodies).toBe(0);
  } finally { physics.dispose(); }
});
