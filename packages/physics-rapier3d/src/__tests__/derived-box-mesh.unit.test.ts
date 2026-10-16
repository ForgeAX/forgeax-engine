import type { ConvexCompoundShapeInput } from '@forgeax/engine-physics';
import { RigidBodyTypeValue } from '@forgeax/engine-physics';
import { err } from '@forgeax/engine-types';
import { beforeAll, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';
import { createDerivedColliderDesc } from '../derived-collider.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

function shape(pieces: Float32Array[]): ConvexCompoundShapeInput {
  return { kind: 'convex-compound', id: 'precision-box', revision: 1, pieces };
}

it('uses outward indexed faces only after proving all eight original Cartesian corners', () => {
  const vertices = boxPoints([0.6, -0.7, 0.2], [0.7, 1.3, 2.2]);
  const shuffled = new Float32Array(
    [6, 1, 7, 0, 3, 5, 2, 4].flatMap((i) => Array.from(vertices.slice(i * 3, i * 3 + 3))),
  );
  const before = shuffled.slice();
  const desc = createDerivedColliderDesc(rapier, shape([shuffled]));
  expect(desc.shape).toBeInstanceOf(rapier.ConvexPolyhedron);
  const convex = desc.shape as InstanceType<typeof rapier.ConvexPolyhedron>;
  expect(convex.vertices).toBe(shuffled);
  expect(shuffled).toEqual(before);
  expect(desc.translation).toEqual({ x: 0, y: 0, z: 0 });
  const indices = convex.indices as Uint32Array;
  expect(indices).toHaveLength(36);
  expect(new Set(indices).size).toBe(8);
  const center = [0, 1, 2].map((axis) =>
    Array.from(shuffled).reduce((sum, value, i) => sum + (i % 3 === axis ? value / 8 : 0), 0),
  );
  for (let i = 0; i < indices.length; i += 3) {
    const points = [0, 1, 2].map((corner) =>
      Array.from(
        shuffled.slice(
          (indices[i + corner] as number) * 3,
          (indices[i + corner] as number) * 3 + 3,
        ),
      ),
    );
    const a = points[0] as number[],
      b = points[1] as number[],
      c = points[2] as number[];
    const ab = b.map((v, axis) => v - (a[axis] as number));
    const ac = c.map((v, axis) => v - (a[axis] as number));
    const normal = [
      (ab[1] as number) * (ac[2] as number) - (ab[2] as number) * (ac[1] as number),
      (ab[2] as number) * (ac[0] as number) - (ab[0] as number) * (ac[2] as number),
      (ab[0] as number) * (ac[1] as number) - (ab[1] as number) * (ac[0] as number),
    ];
    expect(
      normal.reduce(
        (dot, n, axis) => dot + n * ((a[axis] as number) - (center[axis] as number)),
        0,
      ),
    ).toBeGreaterThan(0);
  }
});

it('keeps invalid or numerically ill-conditioned boxes on hull validation', () => {
  const vertices = boxPoints([0.6, 0, 0], [0.7, 1, 2]);
  const duplicate = vertices.slice();
  duplicate.set(duplicate.slice(3, 6), 0);
  const inset = vertices.slice();
  inset[0] = 0.65;
  const nonfinite = vertices.slice();
  nonfinite[0] = Number.NaN;
  for (const points of [
    vertices.slice(3),
    duplicate,
    inset,
    nonfinite,
    boxPoints([0, 0, 0], [0, 1, 2]),
    boxPoints([0.6, 0, 0], [0.7, 1e-12, 2]),
    boxPoints([16777216, 0, 0], [16777218, 2, 2]),
  ]) {
    const desc = createDerivedColliderDesc(rapier, shape([points]));
    expect(desc.shape).toBeInstanceOf(rapier.ConvexPolyhedron);
    expect((desc.shape as InstanceType<typeof rapier.ConvexPolyhedron>).indices).toBeUndefined();
  }
});

function nativeResult(input: ConvexCompoundShapeInput, indexed: boolean) {
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  try {
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(3, 7, 11)
        .setRotation({ x: Math.sin(0.3), y: 0, z: 0, w: Math.cos(0.3) }),
    );
    const desc = indexed
      ? createDerivedColliderDesc(rapier, input)
      : new rapier.ColliderDesc(
          input.pieces.length === 1
            ? new rapier.ConvexPolyhedron(input.pieces[0])
            : new rapier.Compound(
                input.pieces.map((p) => new rapier.ConvexPolyhedron(p)),
                input.pieces.map(() => ({ x: 0, y: 0, z: 0 })),
                input.pieces.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
              ),
        )
          .setTranslation(...(input.origin ?? [0, 0, 0]))
          .setRotation({
            x: input.rotation?.[0] ?? 0,
            y: input.rotation?.[1] ?? 0,
            z: input.rotation?.[2] ?? 0,
            w: input.rotation?.[3] ?? 1,
          });
    const collider = world.createCollider(desc.setEnabled(true).setDensity(3), body);
    world.step();
    const rays = [-0.65, 0, 0.65].map((x) => {
      // Shape-space rays also cross the gap in the two-piece fixture.
      const hit = collider.shape.castRayAndGetNormal(
        new rapier.Ray({ x, y: 0.5, z: -4 }, { x: 0, y: 0, z: 1 }),
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        10,
        true,
      );
      return hit ? { toi: hit.timeOfImpact, normal: { ...hit.normal } } : null;
    });
    const com = { ...body.localCom() };
    const worldCom = { ...body.worldCom() };
    const inertia = Array.from(body.effectiveAngularInertia().elements) as number[];
    return { mass: body.mass() as number, com, worldCom, inertia, rays };
  } finally {
    world.free();
  }
}

it.each([
  [boxPoints([0.6, 0, 0.2], [0.7, 1, 2.2])],
  [boxPoints([-0.7, 0, 0.2], [-0.6, 1, 2.2]), boxPoints([0.6, 0, 0.2], [0.7, 1, 2.2])],
  [boxPoints([16777216, 0, 0], [16777218, 2, 2])],
  [boxPoints([0.6, 0, 0], [0.7, 1e-12, 2])],
])('matches actual hull mass, COM, inertia and ray geometry for precision box %#', (...pieces) => {
  const input = {
    ...shape(pieces),
    origin: [2, 4, 6],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  } as const;
  const old = nativeResult(input, false);
  const next = nativeResult(input, true);
  expect(next.mass).toBeCloseTo(old.mass, 5);
  for (const key of ['x', 'y', 'z'] as const) {
    expect(next.com[key]).toBeCloseTo(old.com[key], 5);
    expect(next.worldCom[key]).toBeCloseTo(old.worldCom[key], 5);
  }
  old.inertia.forEach((value, i) => {
    expect(next.inertia[i]).toBeCloseTo(value, 5);
  });
  expect(next.rays).toEqual(old.rays);
  if (pieces.length === 2) {
    expect(next.rays[0]).not.toBeNull();
    expect(next.rays[1]).toBeNull();
    expect(next.rays[2]).not.toBeNull();
  }
});

it('keeps staging, cancellation and refused replacement massless and transactional for indexed boxes', async () => {
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.ensureBody(
    1,
    {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      type: RigidBodyTypeValue.dynamic,
      mass: 0,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      ccdEnabled: 0,
    },
    undefined,
  );
  const world = physics.raw as NativeWorld;
  let body!: NativeBody;
  world.forEachRigidBody((value) => {
    body = value;
  });
  const state = () => ({
    mass: body.mass(),
    com: { ...body.localCom() },
    position: { ...body.translation() },
    linear: { ...body.linvel() },
    angular: { ...body.angvel() },
  });
  const prepare = (revision: number, offset = 0) =>
    physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'precision',
        revision,
        bodyType: 'dynamic',
        shapes: [{ ...shape([boxPoints([0.6 + offset, 0, 0], [0.7 + offset, 1, 2])]), revision }],
        massProperties: { mode: 'automatic', density: 3 },
      })
      .unwrap();
  try {
    const empty = state(),
      cancelled = prepare(1);
    expect(state()).toEqual(empty);
    physics.cancelDerivedShapeCandidate(cancelled).unwrap();
    expect(state()).toEqual(empty);
    physics.admitDerivedShapeCandidate(prepare(2)).unwrap();
    physics.step(1 / 60);
    const committed = state();
    expect(committed.mass).toBeCloseTo(0.6, 5);
    const replacement = prepare(3, 2);
    expect(state()).toEqual(committed);
    physics
      .admitDerivedShapeCandidate(replacement, () => err(new Error('geometry refused')))
      .unwrap();
    physics.step(1 / 60);
    expect(state()).toEqual(committed);
    expect(physics.getDerivedPublication(1)?.revision).toBe(2);
    expect(world.colliders.len()).toBe(1);
    expect(
      world.castRay(new rapier.Ray({ x: 0.65, y: 0.5, z: -4 }, { x: 0, y: 0, z: 1 }), 10, true),
    ).not.toBeNull();
    expect(
      world.castRay(new rapier.Ray({ x: 2.65, y: 0.5, z: -4 }, { x: 0, y: 0, z: 1 }), 10, true),
    ).toBeNull();
  } finally {
    physics.dispose();
  }
});
