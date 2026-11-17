import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  const box = (entity: number, x: number, sensor = false, groups = 0x00010001) => {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 0, 0));
    body.userData = entity;
    physics.registerBody(entity, body.handle);
    physics.raw.createCollider(
      R.ColliderDesc.cuboid(0.5, 4, 4).setSensor(sensor).setCollisionGroups(groups),
      body,
    );
    return body;
  };
  return { R, physics, box };
}
const base = { origin: [0, 0, 0] as const, motion: [10, 0, 0] as const, maxHits: 8 };

it('casts actual oriented primitive volumes instead of a ray or bounding sphere', async () => {
  const { physics, box } = await fixture();
  try {
    box(9, 5);
    physics.step(1 / 60);
    const cast = (
      shape: Parameters<typeof physics.sweepShape>[0]['shape'],
      rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
    ) => physics.sweepShape({ ...base, shape, rotation }).unwrap().hits[0]?.fraction;
    expect(cast({ kind: 'sphere', radius: 0.5 })).toBeCloseTo(0.4, 4);
    expect(cast({ kind: 'cuboid', halfExtents: [2, 0.5, 0.5] })).toBeCloseTo(0.25, 4);
    expect(
      cast({ kind: 'cuboid', halfExtents: [2, 0.5, 0.5] }, [0, Math.SQRT1_2, 0, Math.SQRT1_2]),
    ).toBeCloseTo(0.4, 4);
    expect(cast({ kind: 'capsule', radius: 0.5, halfHeight: 2 })).toBeCloseTo(0.4, 4);
    expect(cast({ kind: 'capsule', radius: 0.5, halfHeight: 0 })).toBeCloseTo(0.4, 4);
    expect(
      cast({ kind: 'capsule', radius: 0.5, halfHeight: 2 }, [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    ).toBeCloseTo(0.2, 4);
    expect(cast({ kind: 'cylinder', radius: 0.5, halfHeight: 2 })).toBeCloseTo(0.4, 4);
    expect(
      cast({ kind: 'cylinder', radius: 0.5, halfHeight: 2 }, [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    ).toBeCloseTo(0.25, 4);
  } finally {
    physics.dispose();
  }
});

it('can ignore initial body overlaps for movement without changing stationary or later queries', async () => {
  const { physics, box } = await fixture();
  try {
    box(1, 0);
    box(9, 5);
    physics.step(1 / 60);
    const query = { ...base, shape: { kind: 'cuboid' as const, halfExtents: [1, 1, 1] as const } };
    expect(physics.sweepShape(query).unwrap().hits[0]?.entity).toBe(1);
    const result = physics.sweepShape({ ...query, initialOverlap: 'ignore' }).unwrap();
    expect(result.hits.map((hit) => hit.entity)).toEqual([9]);
    expect(result.hits[0]?.fraction).toBeCloseTo(0.35, 4);
    expect(
      physics.sweepShape({ ...query, motion: [0, 0, 0], initialOverlap: 'ignore' }).unwrap().hits[0]
        ?.entity,
    ).toBe(1);
    expect(physics.sweepShape(query).unwrap().hits[0]?.entity).toBe(1);
  } finally {
    physics.dispose();
  }
});

it('queries stationary hull footprints and keeps native sensor/group/exclusion policy', async () => {
  const { physics, box } = await fixture();
  try {
    box(1, 0);
    box(2, 2.4);
    box(3, 1, true);
    box(4, -1, false, 0x00020002);
    physics.step(1 / 60);
    const query = {
      ...base,
      motion: [0, 0, 0] as const,
      shape: { kind: 'cuboid' as const, halfExtents: [2, 0.5, 0.5] as const },
      excludeEntities: [1],
      includeSensors: false,
      filterMask: 0x00010001,
    };
    const result = physics.sweepShape(query).unwrap();
    expect(result.hits.map((hit) => hit.entity)).toEqual([2]);
    expect(result.hits[0]?.fraction).toBe(0);
    expect(result.hits[0]?.point.every(Number.isFinite)).toBe(true);
    expect(result.hits[0]?.normal.every(Number.isFinite)).toBe(true);
    expect(physics.sweepShape({ ...query, excludeEntities: [1, 2] }).unwrap().hits).toEqual([]);
    expect(physics.sweepShape({ ...query, filterMask: 0 }).unwrap().hits).toEqual([]);
  } finally {
    physics.dispose();
  }
});

it('returns the first-impact body batch, reports truncation and detaches witnesses', async () => {
  const { physics, box } = await fixture();
  try {
    box(9, 5);
    box(10, 5);
    box(11, 8);
    physics.step(1 / 60);
    const query = { ...base, shape: { kind: 'cuboid' as const, halfExtents: [1, 1, 1] as const } };
    const result = physics.sweepShape(query).unwrap();
    expect(result.hits.map((hit) => hit.entity).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(result.hits[0]?.fraction).toBeCloseTo(0.35, 4);
    expect(physics.sweepShape({ ...query, maxHits: 1 }).unwrap().truncated).toBe(true);
    const first = result.hits[0];
    if (!first) throw Error('Missing native box hit');
    Reflect.set(first.point, 0, 123);
    expect(physics.sweepShape(query).unwrap().hits[0]?.point[0]).toBeCloseTo(4.5, 4);
  } finally {
    physics.dispose();
  }
});

it('rejects malformed primitive geometry/rotation and disposed query boundaries', async () => {
  const { physics } = await fixture();
  const query = { ...base, shape: { kind: 'cuboid' as const, halfExtents: [1, 1, 1] as const } };
  try {
    for (const [field, value] of [
      ['rotation', [0, 0, 0, 0]],
      ['rotation', [0, 0, 0, Infinity]],
      ['shape', { kind: 'cuboid', halfExtents: [1, -1, 1] }],
      ['shape', { kind: 'sphere', radius: 0 }],
      ['shape', { kind: 'capsule', radius: 1, halfHeight: -1 }],
      ['shape', { kind: 'cylinder', radius: 1, halfHeight: 0 }],
      ['shape', { kind: 'cone', radius: 1 }],
      ['shape', null],
    ] as const) {
      const invalid = { ...query };
      Reflect.set(invalid, field, value);
      expect(physics.sweepShape(invalid)).toMatchObject({
        ok: false,
        error: { code: 'physics-query-invalid' },
      });
    }
  } finally {
    physics.dispose();
  }
  expect(physics.sweepShape(query)).toMatchObject({
    ok: false,
    error: { code: 'physics-query-unavailable' },
  });
});
