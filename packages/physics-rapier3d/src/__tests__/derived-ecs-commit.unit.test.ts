import { createWorldContext, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  1, 3,
])('synchronizes one geometry commit for %i fragments before that native step', async (count) => {
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  physics.setGravity(vec3.create(0, 0, 0));
  world.insertResource('PhysicsWorld', physics);
  const release = registerPhysicsSystems(world);
  const source = world
    .spawn(
      { component: Transform, data: { pos: [3, 3, 3] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] } },
    )
    .unwrap();
  const fragments = Array.from({ length: count }, (_, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [3 + index * 5, 3, 3] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      )
      .unwrap(),
  );
  try {
    world.update(1 / 60).unwrap();
    let replacement: typeof source | undefined;
    const candidates = fragments.map((fragment) =>
      physics
        .prepareDerivedShapeCandidate({
          entity: fragment,
          sourceKey: 'fragment',
          revision: 1,
          bodyType: 'dynamic',
          shapes: [
            {
              kind: 'convex-compound',
              id: 'fragment',
              revision: 1,
              pieces: [boxPoints([-1, -1, -1], [1, 1, 1])],
            },
          ],
          massProperties: { mode: 'automatic', density: 1 },
        })
        .unwrap(),
    );
    let commits = 0;
    physics
      .admitDerivedShapeCandidates(candidates, () => {
        commits++;
        world.despawn(source).unwrap();
        replacement = world
          .spawn(
            { component: Transform, data: { pos: [30, 3, 3] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
            {
              component: Collider,
              data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
            },
          )
          .unwrap();
        return ok(undefined);
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(commits).toBe(1);
    expect(physics.hasBody(source)).toBe(false);
    expect(replacement).toBeDefined();
    expect(physics.hasBody(replacement as number)).toBe(true);
    for (const [index, fragment] of fragments.entries()) {
      const motion = physics.getBodyMotion(fragment).unwrap();
      expect(motion.position).toEqual([3 + index * 5, 3, 3]);
      expect(motion.linearVelocity).toEqual([0, 0, 0]);
      expect(motion.angularVelocity).toEqual([0, 0, 0]);
      expect(physics.getCurrentContacts(fragment).unwrap().manifolds).toEqual([]);
    }
    expect(physics.raycast(vec3.create(30, 3, 0), vec3.create(0, 0, 1), 10)?.entity).toBe(
      replacement,
    );
  } finally {
    release();
    await scene.fiber.dispose();
    physics.dispose();
  }
});
