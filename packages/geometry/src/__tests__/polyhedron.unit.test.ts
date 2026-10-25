import {
  createDodecahedronGeometry,
  createIcosahedronGeometry,
  createOctahedronGeometry,
  createTetrahedronGeometry,
} from '@forgeax/engine-geometry';
import type { AssetError, MeshAsset, Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

type Factory = (
  radius?: number,
  detail?: number,
  options?: { normals?: 'flat' | 'smooth' },
) => Result<MeshAsset, AssetError>;

// Three.js r184 base face counts (the dodecahedron's 12 pentagons are 36 triangles).
const SOLIDS: readonly (readonly [string, Factory, number])[] = [
  ['tetrahedron', createTetrahedronGeometry, 4],
  ['octahedron', createOctahedronGeometry, 8],
  ['icosahedron', createIcosahedronGeometry, 20],
  ['dodecahedron', createDodecahedronGeometry, 36],
];

type V3 = [number, number, number];

function mesh(result: Result<MeshAsset, AssetError>): MeshAsset {
  if (!result.ok) throw result.error;
  return result.value;
}

function read(array: ArrayLike<number> | undefined, index: number, size: number): number[] {
  return Array.from({ length: size }, (_, axis) => array?.[index * size + axis] ?? Number.NaN);
}

const sub = (a: number[], b: number[]): V3 => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
  (a[2] ?? 0) - (b[2] ?? 0),
];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const unit = (v: V3): V3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

function triangles(asset: MeshAsset) {
  const position = asset.attributes.position as Float32Array;
  const indices = asset.indices ?? new Uint16Array();
  const out: { p: number[][]; i: number[]; normal: V3 }[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const i = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0];
    const p = i.map((index) => read(position, index, 3));
    out.push({
      p,
      i,
      normal: unit(cross(sub(p[1] ?? [], p[0] ?? []), sub(p[2] ?? [], p[0] ?? []))),
    });
  }
  return out;
}

describe('Platonic solid geometry (Three.js PolyhedronGeometry)', () => {
  it.each(SOLIDS)('%s has Three.js face counts and stays on its sphere', (_, create, faces) => {
    for (const detail of [0, 1, 3]) {
      const asset = mesh(create(2.5, detail));
      const perFace = (detail + 1) ** 2;
      expect(asset.indices?.length).toBe(faces * perFace * 3);
      expect(asset.submeshes[0]?.vertexCount).toBe(faces * perFace * 3);
      const position = asset.attributes.position as Float32Array;
      for (let index = 0; index < position.length / 3; index++) {
        expect(Math.hypot(...read(position, index, 3))).toBeCloseTo(2.5, 5);
      }
      expect(Math.max(...Array.from(asset.aabb ?? []))).toBeLessThanOrEqual(2.5 + 1e-5);
    }
  });

  it.each(SOLIDS)('%s winds every triangle counter-clockwise from outside', (_, create) => {
    for (const detail of [0, 2]) {
      for (const triangle of triangles(mesh(create(1, detail)))) {
        const centroid = [0, 1, 2].map(
          (axis) => triangle.p.reduce((sum, point) => sum + (point[axis] ?? 0), 0) / 3,
        );
        expect(dot(triangle.normal, centroid)).toBeGreaterThan(0);
      }
    }
  });

  it.each(
    SOLIDS,
  )('%s is a closed surface: every edge is shared by exactly two triangles', (_, create) => {
    const edges = new Map<string, number>();
    const key = (point: number[]) => point.map((value) => value.toFixed(4)).join(',');
    for (const triangle of triangles(mesh(create(1, 1)))) {
      for (let corner = 0; corner < 3; corner++) {
        const ends = [
          key(triangle.p[corner] ?? []),
          key(triangle.p[(corner + 1) % 3] ?? []),
        ].sort();
        const edge = ends.join('|');
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    expect(new Set(edges.values())).toEqual(new Set([2]));
  });

  it.each(
    SOLIDS,
  )('%s has flat normals at detail 0 and sphere normals above, like Three.js', (_, create) => {
    const flat = mesh(create(1, 0));
    for (const triangle of triangles(flat)) {
      for (const index of triangle.i) {
        expect(dot(read(flat.attributes.normal, index, 3), triangle.normal)).toBeCloseTo(1, 5);
      }
    }
    const smooth = mesh(create(1, 2));
    const position = smooth.attributes.position as Float32Array;
    for (let index = 0; index < position.length / 3; index++) {
      expect(dot(read(smooth.attributes.normal, index, 3), read(position, index, 3))).toBeCloseTo(
        1,
        5,
      );
    }
    const overridden = mesh(create(1, 2, { normals: 'flat' }));
    for (const triangle of triangles(overridden)) {
      expect(
        dot(read(overridden.attributes.normal, triangle.i[0] ?? 0, 3), triangle.normal),
      ).toBeCloseTo(1, 5);
    }
  });

  it.each(SOLIDS)('%s has seam-free spherical UVs and finite tangents', (_, create) => {
    const asset = mesh(create(1, 1));
    const uv = asset.attributes.uv as Float32Array;
    const tangent = asset.attributes.tangent as Float32Array;
    expect(tangent.length).toBe((uv.length / 2) * 4);
    expect(tangent.every(Number.isFinite)).toBe(true);
    for (const triangle of triangles(asset)) {
      const u = triangle.i.map((index) => uv[index * 2] ?? Number.NaN);
      const v = triangle.i.map((index) => uv[index * 2 + 1] ?? Number.NaN);
      expect(Math.max(...u) - Math.min(...u)).toBeLessThan(0.5);
      for (const value of v) expect(value).toBeGreaterThanOrEqual(0);
      for (const value of v) expect(value).toBeLessThanOrEqual(1);
    }
    // v = 0 is the top, as on createSphereGeometry.
    const position = asset.attributes.position as Float32Array;
    let top = 0;
    for (let index = 0; index < position.length / 3; index++) {
      if ((position[index * 3 + 1] ?? 0) > (position[top * 3 + 1] ?? 0)) top = index;
    }
    expect(uv[top * 2 + 1]).toBeLessThan(0.5);
  });

  it('rejects degenerate radius and detail', () => {
    for (const result of [
      createIcosahedronGeometry(0),
      createIcosahedronGeometry(Number.NaN),
      createOctahedronGeometry(1, -1),
      createDodecahedronGeometry(1, 1.5),
      createTetrahedronGeometry(1, 65),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
    }
  });

  it('switches to 32-bit indices only past the 16-bit range', () => {
    expect(mesh(createIcosahedronGeometry(1, 10)).indices).toBeInstanceOf(Uint16Array);
    expect(mesh(createIcosahedronGeometry(1, 40)).indices).toBeInstanceOf(Uint32Array);
  });
});
