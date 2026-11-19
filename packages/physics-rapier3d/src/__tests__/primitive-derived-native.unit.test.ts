import { beforeAll, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let R: Rapier3DModule;
beforeAll(async () => {
  R = await loadRapier3D();
  if ('code' in R) throw R;
});
function body(dynamic = false) {
  const physics = createRapier3DPhysicsWorld(R);
  physics.ensureBody(
    1,
    {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      type: dynamic ? 1 : 0,
      mass: 0,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      ccdEnabled: 0,
    },
    undefined,
  );
  return physics;
}
it('admits a zero-segment capsule with native sphere-equivalent volume', () => {
  const physics = body(true);
  try {
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        revision: 1,
        sourceKey: 'zero-capsule',
        bodyType: 'dynamic',
        massProperties: { mode: 'automatic' },
        shapes: [{ kind: 'capsule', id: 'capsule', revision: 1, radius: 0.5, halfHeight: 0 }],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    expect(physics.getBodyMassProperties(1).unwrap().mass).toBeCloseTo(
      (4 * Math.PI * 0.5 ** 3) / 3,
      5,
    );
    expect(
      physics.raycast(new Float32Array([0, 0, -2]), new Float32Array([0, 0, 1]), 4)?.point[2],
    ).toBeCloseTo(-0.5, 5);
  } finally {
    physics.dispose();
  }
});
it('stages exact native primitive types at local poses and atomically publishes their roster', () => {
  const physics = createRapier3DPhysicsWorld(R);
  physics.ensureBody(
    1,
    {
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
    undefined,
  );
  try {
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        revision: 1,
        sourceKey: 'primitives',
        bodyType: 'static',
        shapes: [
          { kind: 'sphere', id: 'ball', revision: 1, radius: 0.75, origin: [0, 2, 0] },
          {
            kind: 'cuboid',
            id: 'box',
            revision: 1,
            halfExtents: [1, 0.5, 0.25],
            origin: [4, 2, 0],
          },
          {
            kind: 'capsule',
            id: 'capsule',
            revision: 1,
            radius: 0.5,
            halfHeight: 1,
            origin: [8, 2, 0],
          },
          {
            kind: 'cylinder',
            id: 'cylinder',
            revision: 1,
            radius: 0.5,
            halfHeight: 1,
            origin: [12, 2, 0],
          },
        ],
      })
      .unwrap();
    expect(
      physics.raycast(new Float32Array([10, 2, -5]), new Float32Array([0, 0, 1]), 10),
    ).toBeUndefined();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    const types: number[] = [];
    physics.raw.forEachCollider((c) => {
      expect(c.isEnabled()).toBe(true);
      types.push(c.shapeType());
    });
    expect(types.sort()).toEqual(
      [R.ShapeType.Ball, R.ShapeType.Cuboid, R.ShapeType.Capsule, R.ShapeType.Cylinder].sort(),
    );
    expect(
      physics.raycast(new Float32Array([10, 2, -5]), new Float32Array([0, 0, 1]), 10)?.point[2],
    ).toBeCloseTo(-0.75, 5);
    const clear = physics
      .prepareDerivedShapeCandidate({ entity: 1, revision: 2, sourceKey: 'primitives', shapes: [] })
      .unwrap();
    physics.admitDerivedShapeCandidate(clear).unwrap();
    physics.step(1 / 60);
    expect(physics.raw.colliders.len()).toBe(0);
  } finally {
    physics.dispose();
  }
});

it('preserves committed primitive queries on cancellation and reuses only identical geometry', () => {
  const physics = body();
  const input = (revision: number, radius: number) => ({
    entity: 1,
    revision,
    sourceKey: 'sphere',
    shapes: [{ kind: 'sphere' as const, id: 'ball', revision, radius }],
  });
  try {
    const first = physics.prepareDerivedShapeCandidate(input(1, 1)).unwrap();
    physics.admitDerivedShapeCandidate(first).unwrap();
    physics.step(1 / 60);
    const handles: number[] = [];
    physics.raw.forEachCollider((c) => handles.push(c.handle));
    const staged = physics.prepareDerivedShapeCandidate(input(2, 2)).unwrap();
    expect(physics.raw.colliders.len()).toBe(2);
    physics.cancelDerivedShapeCandidate(staged).unwrap();
    physics.step(1 / 60);
    expect(physics.raw.colliders.len()).toBe(1);
    expect(
      physics.raycast(new Float32Array([0, 0, -5]), new Float32Array([0, 0, 1]), 10)?.point[2],
    ).toBeCloseTo(-1, 5);
    const same = physics.prepareDerivedShapeCandidate(input(3, 1)).unwrap();
    physics.admitDerivedShapeCandidate(same).unwrap();
    physics.step(1 / 60);
    const reused: number[] = [];
    physics.raw.forEachCollider((c) => reused.push(c.handle));
    expect(reused).toEqual(handles);
    const larger = physics.prepareDerivedShapeCandidate(input(4, 2)).unwrap();
    physics.admitDerivedShapeCandidate(larger).unwrap();
    physics.step(1 / 60);
    expect(physics.raw.colliders.len()).toBe(1);
    expect(
      physics.raycast(new Float32Array([0, 0, -5]), new Float32Array([0, 0, 1]), 10)?.point[2],
    ).toBeCloseTo(-2, 5);
  } finally {
    physics.dispose();
  }
});

it.each([
  'capsule',
  'cylinder',
] as const)('applies %s local rotations to the native curved primitive', (kind) => {
  const physics = body();
  try {
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        revision: 1,
        sourceKey: 'rotated',
        shapes: [
          {
            kind,
            id: 'rotated',
            revision: 1,
            radius: 0.5,
            halfHeight: 2,
            rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          },
        ],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    expect(
      physics.raycast(new Float32Array([1.5, 0, -3]), new Float32Array([0, 0, 1]), 6)?.point[2],
    ).toBeCloseTo(-0.5, 4);
    expect(
      physics.raycast(new Float32Array([0, 1.5, -3]), new Float32Array([0, 0, 1]), 6),
    ).toBeUndefined();
  } finally {
    physics.dispose();
  }
});

it('derives native sphere mass analytically and recovers detached primitive dimensions', () => {
  const physics = body(true),
    fresh = body(true);
  try {
    const halfExtents: [number, number, number] = [1, 2, 3];
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        revision: 1,
        sourceKey: 'mass',
        bodyType: 'dynamic',
        massProperties: { mode: 'automatic' },
        shapes: [
          { kind: 'sphere', id: 'ball', revision: 1, radius: 0.75, density: 2 },
          { kind: 'cuboid', id: 'box', revision: 1, halfExtents, density: 0, origin: [5, 0, 0] },
        ],
      })
      .unwrap();
    halfExtents.fill(100);
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    expect(physics.getBodyMassProperties(1).unwrap().mass).toBeCloseTo(
      (4 * Math.PI * 0.75 ** 3 * 2) / 3,
      4,
    );
    const snapshot = physics.captureDerivedPhysicsState();
    const box = snapshot.bodies[0]?.shapes.find((s) => s.kind === 'cuboid');
    if (box?.kind !== 'cuboid') throw Error('missing recovery box');
    expect(box.halfExtents).toEqual([1, 2, 3]);
    fresh.restoreDerivedPhysicsState(snapshot).unwrap();
    fresh.step(1 / 60);
    Reflect.set(box.halfExtents, 0, 50);
    const restored = fresh
      .captureDerivedPhysicsState()
      .bodies[0]?.shapes.find((s) => s.kind === 'cuboid');
    if (restored?.kind !== 'cuboid') throw Error('missing restored box');
    expect(restored.halfExtents).toEqual([1, 2, 3]);
    expect(fresh.getBodyMassProperties(1).unwrap().mass).toBeCloseTo(
      physics.getBodyMassProperties(1).unwrap().mass,
      4,
    );
  } finally {
    fresh.dispose();
    physics.dispose();
  }
});
