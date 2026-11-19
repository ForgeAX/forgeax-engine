import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

const query = () => ({
  origin: [0, 2, 3] as const,
  motion: [10, 0, 0] as const,
  radius: 0.5,
  maxHits: 12,
});
async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  const box = (entity: number, x: number, groups = 0x00010001, sensor = false) => {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 2, 3));
    body.userData = entity;
    physics.registerBody(entity, body.handle);
    const collider = physics.raw.createCollider(
      R.ColliderDesc.cuboid(0.5, 1, 1).setCollisionGroups(groups).setSensor(sensor),
      body,
    );
    return { body, collider };
  };
  return { R, physics, box };
}

it('sweeps the actual sphere volume and returns detached world-space target witnesses', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(5, 2, 3));
    body.userData = 9;
    physics.registerBody(9, body.handle);
    physics.raw.createCollider(R.ColliderDesc.cuboid(0.5, 1, 1), body);
    physics.step(1 / 60);
    const result = physics
      .sweepSphere({ origin: [0, 2, 3], motion: [10, 0, 0], radius: 0.5, maxHits: 12 })
      .unwrap();
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.hits[0]?.entity).toBe(9);
    expect(result.hits[0]?.fraction).toBeCloseTo(0.4, 4);
    expect(result.hits[0]?.point[0]).toBeCloseTo(4.5, 4);
    expect(result.hits[0]?.normal).toEqual([-1, 0, 0]);
  } finally {
    physics.dispose();
  }
});

it('hits geometry outside the ray and respects native groups, sensors and body exclusions', async () => {
  const { physics, box } = await fixture();
  try {
    box(1, 5);
    box(2, 8, 0x00020002);
    box(3, 2, 0x00010001, true);
    physics.step(1 / 60);
    expect(
      physics
        .sweepSphere(query())
        .unwrap()
        .hits.map((hit) => hit.entity),
    ).toEqual([3]);
    expect(
      physics
        .sweepSphere({ ...query(), filterMask: 0x00010001, includeSensors: false })
        .unwrap()
        .hits.map((hit) => hit.entity),
    ).toEqual([1]);
    expect(
      physics
        .sweepSphere({ ...query(), excludeEntities: [1, 3] })
        .unwrap()
        .hits.map((hit) => hit.entity),
    ).toEqual([2]);
    expect(physics.sweepSphere({ ...query(), filterMask: 0 }).unwrap().hits).toEqual([]);
    const origin = vec3.create(0, 3.25, 3);
    expect(physics.raycast(origin, vec3.create(1, 0, 0), 10)).toBeUndefined();
    expect(
      physics.sweepSphere({ ...query(), origin: [0, 3.25, 3], includeSensors: false }).unwrap().hits
        .length,
    ).toBeGreaterThan(0);
  } finally {
    physics.dispose();
  }
});

it('keeps the first-impact contact batch, excludes farther geometry and reports truncation', async () => {
  const { R, physics, box } = await fixture();
  try {
    const { body } = box(9, 5);
    physics.raw.createCollider(R.ColliderDesc.cuboid(0.5, 1, 1), body);
    box(10, 8);
    box(11, 5);
    physics.step(1 / 60);
    const result = physics.sweepSphere(query()).unwrap();
    expect(result.hits.map((hit) => hit.entity).sort((a, b) => a - b)).toEqual([9, 11]);
    expect(result.truncated).toBe(false);
    expect(result.hits[0]?.point[0]).toBeCloseTo(4.5, 4);
    expect(result.hits[1]?.point[0]).toBeCloseTo(4.5, 4);
    const bounded = physics.sweepSphere({ ...query(), maxHits: 1 }).unwrap();
    expect(bounded.hits).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
    const first = result.hits[0];
    if (!first) throw Error('missing native hit');
    Reflect.set(first.point, 0, 1234);
    expect(physics.sweepSphere(query()).unwrap().hits[0]?.point[0]).toBeCloseTo(4.5, 4);
  } finally {
    physics.dispose();
  }
});

it('returns world normals on rotated targets and stationary initial overlaps without waking a body', async () => {
  const { R, physics } = await fixture();
  try {
    const body = physics.raw.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(5, 2, 3)
        .setGravityScale(0)
        .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) }),
    );
    body.userData = 9;
    physics.registerBody(9, body.handle);
    physics.raw.createCollider(R.ColliderDesc.cuboid(0.5, 2, 1), body);
    physics.step(1 / 60);
    physics.sleepBody(9).unwrap();
    const before = physics.getBodyMotion(9).unwrap(),
      hit = physics.sweepSphere(query()).unwrap().hits[0];
    if (!hit) throw Error('missing rotated target');
    expect(hit.normal[0]).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(hit.normal[1]).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(hit.point[1]).toBeGreaterThan(2);
    expect(hit.point[2]).toBeCloseTo(3, 2);
    const overlap = physics
      .sweepSphere({ ...query(), origin: [5, 2, 3], motion: [0, 0, 0] })
      .unwrap();
    expect(overlap.hits[0]?.fraction).toBe(0);
    expect(overlap.hits[0]?.point.every(Number.isFinite)).toBe(true);
    expect(physics.getBodyMotion(9).unwrap()).toEqual(before);
  } finally {
    physics.dispose();
  }
});

it('refuses invalid inputs, disposed worlds and reentrant queries with explicit Results', async () => {
  const { physics, box } = await fixture();
  box(9, 5);
  physics.step(1 / 60);
  try {
    for (const [field, value] of [
      ['radius', 0],
      ['radius', 1e-60],
      ['radius', Infinity],
      ['maxHits', 0],
      ['maxHits', 0.5],
      ['origin', [NaN, 2, 3]],
      ['motion', [1e40, 0, 0]],
      ['filterMask', -1],
      ['excludeEntities', [-1]],
      ['includeSensors', 'yes'],
    ] as const) {
      const input = query();
      Reflect.set(input, field, value);
      expect(physics.sweepSphere(input)).toMatchObject({
        ok: false,
        error: { code: 'physics-query-invalid' },
      });
    }
    const step = physics.raw.step.bind(physics.raw);
    let rejected = false;
    physics.raw.step = (...args: unknown[]) => {
      rejected = !physics.sweepSphere(query()).ok;
      return step(...args);
    };
    physics.step(1 / 60);
    expect(rejected).toBe(true);
    physics.raw.step = step;
  } finally {
    physics.dispose();
  }
  expect(physics.sweepSphere(query())).toMatchObject({
    ok: false,
    error: { code: 'physics-query-unavailable' },
  });
});

it('excludes despawned ECS generations before native reconciliation', async () => {
  const { physics } = await fixture(),
    world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  const release = registerPhysicsComponents(world);
  try {
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [5, 2, 3] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        { component: Collider, data: {} },
      )
      .unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    expect(physics.sweepSphere(query()).unwrap().hits[0]?.entity).toBe(entity);
    world.despawn(entity).unwrap();
    expect(physics.sweepSphere(query()).unwrap().hits).toEqual([]);
  } finally {
    physics.dispose();
    release();
  }
});

it('retains coincident sphere TOI contacts even when strict overlap rejects the boundary pose', async () => {
  const { R, physics } = await fixture();
  try {
    for (const entity of [9, 10]) {
      const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(5, 2, 3));
      body.userData = entity;
      physics.registerBody(entity, body.handle);
      physics.raw.createCollider(R.ColliderDesc.ball(0.5), body);
    }
    physics.step(1 / 60);
    const result = physics.sweepSphere({ ...query(), radius: 0.28 }).unwrap();
    expect(result.hits.map((hit) => hit.entity).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(result.hits[0]?.fraction).toBe(result.hits[1]?.fraction);
    expect(physics.sweepSphere({ ...query(), radius: 0.28, maxHits: 1 }).unwrap().truncated).toBe(
      true,
    );
  } finally {
    physics.dispose();
  }
});

it('queries committed native compound geometry and rejects its paired admission boundary', async () => {
  const { R, physics } = await fixture();
  try {
    const body = physics.raw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(5, 2, 3));
    body.userData = 9;
    physics.registerBody(9, body.handle);
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 9,
        revision: 1,
        sourceKey: 'sweep-compound',
        bodyType: 'static',
        shapes: [
          {
            id: 'hull',
            revision: 1,
            kind: 'convex-compound',
            pieces: [boxPoints([-0.5, -1, -1], [0.5, 1, 1])],
          },
        ],
        massProperties: { mode: 'automatic', density: 1 },
      })
      .unwrap();
    let rejected = false;
    physics
      .admitDerivedShapeCandidate(candidate, () => {
        rejected = !physics.sweepSphere(query()).ok;
        return ok(undefined);
      })
      .unwrap();
    physics.step(1 / 60);
    expect(rejected).toBe(true);
    const result = physics.sweepSphere(query()).unwrap();
    expect(result.hits[0]?.entity).toBe(9);
    expect(result.hits[0]?.point[0]).toBeCloseTo(4.5, 3);
  } finally {
    physics.dispose();
  }
});

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
