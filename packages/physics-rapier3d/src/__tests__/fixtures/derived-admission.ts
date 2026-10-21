import { vec3 } from '@forgeax/engine-math';
import { toShared } from '@forgeax/engine-types';
import { createRapier3DPhysicsWorld } from '../../rapier-physics-world-3d.js';
import { loadRapier3D } from '../../wasm-loader.js';

export async function derivedAdmissionFixture(residentBodies = 2) {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  physics.setGravity(vec3.create());
  for (const entity of Array.from({ length: residentBodies }, (_, index) => index + 1)) {
    physics.ensureBody(
      entity,
      {
        position: { x: entity * 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      {
        shape: 0,
        mesh: toShared<'MeshAsset'>(0),
        halfExtents: [0.5, 0.5, 0.5],
        radius: 0.5,
        halfHeight: 0.5,
        friction: 0.5,
        restitution: 0,
        density: 1,
        isSensor: false,
        collisionGroups: 0xffffffff,
        solverGroups: 0xffffffff,
      },
    );
    const points = new Float32Array([
      -1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
    ]);
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity,
        sourceKey: `body:${entity}`,
        revision: 1,
        bodyType: entity <= 2 ? 'dynamic' : 'static',
        shapes: [{ id: 'box', revision: 1, kind: 'convex-compound', pieces: [points] }],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    if (entity % 32 === 0) physics.step(1 / 60);
  }
  physics.step(1 / 60);
  const prepare = () =>
    physics
      .prepareDerivedBodyTypeCandidates(
        [1, 2].map((entity) => {
          const publication = physics.getDerivedPublication(entity);
          if (!publication) throw Error('missing receipt');
          return { publication, bodyType: 'static' as const };
        }),
      )
      .unwrap();
  return { physics, prepare };
}
