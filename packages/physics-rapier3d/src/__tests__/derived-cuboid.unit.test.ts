import type { ConvexCompoundShapeInput } from '@forgeax/engine-physics';
import { beforeAll, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createDerivedColliderDesc } from '../derived-collider.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

function shape(pieces: Float32Array[]): ConvexCompoundShapeInput {
  return { kind: 'convex-compound', id: 'solid', revision: 1, pieces };
}

it('uses the native cuboid for exactly eight box corners, regardless of vertex order', () => {
  const points = boxPoints([-2, -1, -3], [2, 1, 3]);
  const shuffled = new Float32Array(
    [6, 1, 7, 0, 3, 5, 2, 4].flatMap((i) => Array.from(points.slice(i * 3, i * 3 + 3))),
  );
  const desc = createDerivedColliderDesc(rapier, shape([shuffled]));
  expect(desc.shape.type).toBe(rapier.ShapeType.Cuboid);
  expect(desc.translation).toEqual({ x: 0, y: 0, z: 0 });
});

it('retains the collider frame and native cuboid child for an off-center box', () => {
  const desc = createDerivedColliderDesc(rapier, shape([boxPoints([-2, -1, -3], [4, 5, 1])]));
  expect(desc.translation).toEqual({ x: 0, y: 0, z: 0 });
  expect(desc.shape).toBeInstanceOf(rapier.Compound);
  const compound = desc.shape as InstanceType<typeof rapier.Compound>;
  expect(compound.shapes).toHaveLength(1);
  expect(compound.shapes[0]?.type).toBe(rapier.ShapeType.Cuboid);
  expect(compound.positions).toEqual([{ x: 1, y: 2, z: -1 }]);
});

it('keeps non-box hulls and duplicate or inset corners on the convex path', () => {
  const tetrahedron = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const duplicate = boxPoints([-1, -1, -1], [1, 1, 1]);
  duplicate.set(duplicate.slice(3, 6), 0);
  const inset = boxPoints([-1, -1, -1], [1, 1, 1]);
  inset[0] = -0.999;
  for (const vertices of [tetrahedron, duplicate, inset]) {
    expect(createDerivedColliderDesc(rapier, shape([vertices])).shape.type).toBe(
      rapier.ShapeType.ConvexPolyhedron,
    );
  }
});

it('retains hulls whose exact f32 endpoints have no exact f32 center', () => {
  const vertices = boxPoints([16777216, 0, 0], [16777218, 2, 2]);
  const desc = createDerivedColliderDesc(rapier, shape([vertices]));
  expect(desc.shape.type).toBe(rapier.ShapeType.ConvexPolyhedron);
  expect(desc.translation).toEqual({ x: 0, y: 0, z: 0 });
});

it('preserves translated, rotated, nonuniform box geometry and its automatic mass', () => {
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  try {
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(3, 7, 11));
    const input = {
      ...shape([boxPoints([1, 2, 3], [3, 6, 9])]),
      origin: [2, 4, 6],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    } as const;
    const desc = createDerivedColliderDesc(rapier, input).setEnabled(true).setDensity(2);
    world.createCollider(desc, body);
    world.step();
    expect(body.mass()).toBeCloseTo(96, 4);
    // Local center (2,4,6), rotated around Z, then shape origin and body position.
    const center = body.worldCom();
    expect(center.x).toBeCloseTo(1, 5);
    expect(center.y).toBeCloseTo(13, 5);
    expect(center.z).toBeCloseTo(23, 5);
    const hit = world.castRay(
      new rapier.Ray({ x: 1, y: 13, z: 0 }, { x: 0, y: 0, z: 1 }),
      40,
      true,
    );
    expect(hit?.timeOfImpact).toBeCloseTo(20, 5);
    expect(
      world.castRay(new rapier.Ray({ x: 4, y: 13, z: 0 }, { x: 0, y: 0, z: 1 }), 40, true),
    ).toBeNull();
  } finally {
    world.free();
  }
});

it('retains compound holes and mixed hull geometry with one collider', () => {
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  try {
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic());
    const input = shape([
      boxPoints([-3, -1, -1], [-1, 1, 1]),
      boxPoints([1, -1, -1], [3, 1, 1]),
      new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0, 5, 0, 1]),
    ]);
    world.createCollider(
      createDerivedColliderDesc(rapier, input).setEnabled(true).setDensity(6),
      body,
    );
    world.step();
    expect(world.colliders.len()).toBe(1);
    expect(body.mass()).toBeCloseTo(97, 3);
    for (const x of [-2, 2, 5.1]) {
      expect(
        world.castRay(new rapier.Ray({ x, y: 0.1, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true),
      ).not.toBeNull();
    }
    expect(
      world.castRay(new rapier.Ray({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true),
    ).toBeNull();
  } finally {
    world.free();
  }
});
