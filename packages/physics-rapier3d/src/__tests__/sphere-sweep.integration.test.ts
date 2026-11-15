import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

it('retains stationary starting overlaps, outside misses and moving sphere hits with native contact data', async () => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    physics.ensureBody(
      1,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'test:sphere-sweep',
        revision: 1,
        shapes: [
          {
            id: 'volume',
            revision: 1,
            kind: 'convex-compound',
            pieces: [boxPoints([-22, -10, -22], [22, 0, 22])],
            isSensor: true,
            collisionGroups: 0x0001_0002,
          },
        ],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    const inside = vec3.create(0, -1.8, 10);
    const overlap = physics.sweepSphereAll(inside, inside, 0.1, 0x0002_0001).unwrap();
    expect(overlap).toHaveLength(1);
    expect(overlap[0]).toMatchObject({ entity: 1, timeOfImpact: 0, initialOverlap: true });
    expect(Array.from(requiredFixtureValue(overlap[0]).point)).toEqual([0, 0, 10]);
    expect(Array.from(requiredFixtureValue(overlap[0]).normal)).toEqual([0, 1, 0]);
    expect(physics.sweepSphereAll(inside, inside, 0.1, 0x0001_0001).unwrap()).toEqual([]);
    expect(physics.sweepSphereAll(inside, inside, 0.1, 0x0002_0002).unwrap()).toEqual([]);
    const outside = vec3.create(0, 1, 10);
    expect(physics.sweepSphereAll(outside, outside, 0.1, 0x0002_0001).unwrap()).toEqual([]);
    const moving = physics
      .sweepSphereAll(outside, vec3.create(0, -1, 10), 0.1, 0x0002_0001)
      .unwrap();
    expect(moving).toHaveLength(1);
    expect(moving[0]).toMatchObject({ entity: 1, initialOverlap: false });
    expect(requiredFixtureValue(moving[0]).timeOfImpact).toBeCloseTo(0.45, 5);
    expect(requiredFixtureValue(moving[0]).point[1]).toBeCloseTo(0, 5);
    expect(requiredFixtureValue(moving[0]).normal[1]).toBeCloseTo(1, 5);
    const exiting = physics
      .sweepSphereAll(inside, vec3.create(0, -0.8, 10), 0.1, 0x0002_0001)
      .unwrap();
    expect(exiting).toHaveLength(1);
    expect(exiting[0]).toMatchObject({ entity: 1, timeOfImpact: 0, initialOverlap: true });
  } finally {
    physics.dispose();
  }
});
