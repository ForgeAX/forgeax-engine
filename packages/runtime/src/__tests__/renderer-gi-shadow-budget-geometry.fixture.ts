import { createHash } from 'node:crypto';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshFromInterleaved,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

export const SHADOW_WALL_POSITION = [0, 0, -3.115] as const;
export const SHADOW_LIGHT_DIRECTION = [0, Math.SQRT1_2, -Math.SQRT1_2] as const;

/** Keep the entire original wall and append one closed, off-view component. */
export function shadowBudgetGeometry(): MeshAsset {
  const wall = createBoxGeometry(8, 8, 0.25).unwrap();
  const component = createBoxGeometry(0.125, 0.125, 0.125).unwrap();
  const input = new Float32Array(48 * 8);
  for (const [part, mesh] of [wall, component].entries()) {
    const position = mesh.attributes.position as Float32Array;
    const normal = mesh.attributes.normal as Float32Array;
    const uv = mesh.attributes.uv as Float32Array;
    for (let vertex = 0; vertex < position.length / 3; vertex++) {
      const offset = (part * 24 + vertex) * 8;
      input.set(position.subarray(vertex * 3, vertex * 3 + 3), offset);
      if (part === 1) {
        input[offset] = (input[offset] ?? 0) + 4.25;
        input[offset + 2] = (input[offset + 2] ?? 0) + 0.5;
      }
      input.set(normal.subarray(vertex * 3, vertex * 3 + 3), offset + 3);
      input.set(uv.subarray(vertex * 2, vertex * 2 + 2), offset + 6);
    }
  }
  if (!wall.indices || !component.indices) throw new Error('indexed shadow fixture required');
  const indices = new Uint32Array(wall.indices.length + component.indices.length);
  indices.set(wall.indices);
  indices.set(
    component.indices.map((index) => index + 24),
    wall.indices.length,
  );
  return meshFromInterleaved(input, indices).unwrap();
}

/** Use the same real offline Field and Card producers as the original box. */
export async function shadowBudgetMesh(): Promise<MeshAsset> {
  const mesh = shadowBudgetGeometry();
  if (!mesh.indices) throw new Error('indexed shadow fixture required');
  const position = mesh.attributes.position as Float32Array;
  const field = (
    await buildVisibilityDistanceField(position, mesh.indices, {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  return {
    ...mesh,
    cardLayout: (await buildMeshCardLayout(position, mesh.indices)).unwrap(),
    distanceField: {
      ...field,
      sectionSidedness: mesh.submeshes.map(() => 0),
      artifact: {
        integrity: {
          algorithm: 'sha256',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        assetCodec: { ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC },
      },
    },
  };
}

type Point = readonly [number, number, number];
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Independent two-sided Moller-Trumbore check; no Engine query or SDF consumer. */
export function shadowTriangleHit(
  origin: Point,
  direction: Point,
  a: Point,
  b: Point,
  c: Point,
): number | undefined {
  const edge1 = subtract(b, a),
    edge2 = subtract(c, a),
    p = cross(direction, edge2);
  const determinant = dot(edge1, p);
  if (Math.abs(determinant) < 1e-12) return undefined;
  const offset = subtract(origin, a),
    inverse = 1 / determinant;
  const u = dot(offset, p) * inverse;
  if (u < -1e-10 || u > 1 + 1e-10) return undefined;
  const q = cross(offset, edge1),
    v = dot(direction, q) * inverse;
  if (v < -1e-10 || u + v > 1 + 1e-10) return undefined;
  const t = dot(edge2, q) * inverse;
  return t > 1e-8 ? t : undefined;
}

/** Check every actual floor Card receiver against every appended triangle. */
export function shadowComponentWitness(mesh: MeshAsset, receivers: readonly Point[]) {
  if (!mesh.indices) throw new Error('indexed shadow fixture required');
  const positions = mesh.attributes.position as Float32Array;
  const vertex = (index: number): Point => [
    (positions[index * 3] ?? NaN) + SHADOW_WALL_POSITION[0],
    (positions[index * 3 + 1] ?? NaN) + SHADOW_WALL_POSITION[1],
    (positions[index * 3 + 2] ?? NaN) + SHADOW_WALL_POSITION[2],
  ];
  let triangleChecks = 0;
  let minimumLateralMargin = Infinity;
  for (const receiver of receivers) {
    if (receiver.some((value) => !Number.isFinite(value)))
      throw new Error('finite receiver evidence required');
    for (let i = 36; i < mesh.indices.length; i += 3) {
      const triangle = [
        vertex(mesh.indices[i] ?? -1),
        vertex(mesh.indices[i + 1] ?? -1),
        vertex(mesh.indices[i + 2] ?? -1),
      ] as const;
      if (triangle.some((point) => point.some((value) => !Number.isFinite(value))))
        throw new Error('finite authored triangle required');
      for (const point of triangle)
        minimumLateralMargin = Math.min(minimumLateralMargin, point[0] - receiver[0]);
      if (shadowTriangleHit(receiver, SHADOW_LIGHT_DIRECTION, ...triangle) !== undefined)
        throw new Error('off-view component crosses a receiver light ray');
      triangleChecks++;
    }
  }
  return {
    receiverCount: receivers.length,
    triangleChecks,
    minimumLateralMargin,
    originalWallTriangles: 12,
    appendedTriangles: 12,
  };
}
