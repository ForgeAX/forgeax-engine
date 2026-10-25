// @forgeax/engine-geometry - Procedural Platonic solids.
//
// Mirrors Three.js r184 PolyhedronGeometry and its Tetrahedron / Octahedron /
// Icosahedron / Dodecahedron subclasses: createIcosahedronGeometry(radius?,
// detail?) -> Result<MeshAsset, AssetError>. Each base face is split into
// (detail + 1)^2 triangles whose vertices are projected onto the sphere of
// `radius`. Triangles do not share vertices, so a face keeps its own normal.
// Like Three.js, detail 0 has flat face normals and detail > 0 has smooth
// sphere normals; `normals` overrides either.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate } from './box';
import { createPrimitiveAttributes, finishPrimitiveMesh } from './primitive-attributes';

/** Normal choice for a polyhedron: one normal per face, or the sphere normal per vertex. */
export interface PolyhedronOptions {
  /** Default: `'flat'` for detail 0 and `'smooth'` otherwise, as in Three.js. */
  readonly normals?: 'flat' | 'smooth';
}

/** Largest accepted detail; 64 gives 20 * 65^2 * 3 = 253,500 icosahedron vertices. */
const MAX_DETAIL = 64;

type Solid = { readonly vertices: readonly number[]; readonly indices: readonly number[] };

const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;

const TETRAHEDRON: Solid = {
  vertices: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
  indices: [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1],
};

const OCTAHEDRON: Solid = {
  vertices: [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
  indices: [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2],
};

const ICOSAHEDRON: Solid = {
  vertices: [
    -1,
    PHI,
    0,
    1,
    PHI,
    0,
    -1,
    -PHI,
    0,
    1,
    -PHI,
    0,
    0,
    -1,
    PHI,
    0,
    1,
    PHI,
    0,
    -1,
    -PHI,
    0,
    1,
    -PHI,
    PHI,
    0,
    -1,
    PHI,
    0,
    1,
    -PHI,
    0,
    -1,
    -PHI,
    0,
    1,
  ],
  indices: [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ],
};

const DODECAHEDRON: Solid = {
  vertices: [
    // (+-1, +-1, +-1)
    -1,
    -1,
    -1,
    -1,
    -1,
    1,
    -1,
    1,
    -1,
    -1,
    1,
    1,
    1,
    -1,
    -1,
    1,
    -1,
    1,
    1,
    1,
    -1,
    1,
    1,
    1,
    // (0, +-1/phi, +-phi)
    0,
    -INV_PHI,
    -PHI,
    0,
    -INV_PHI,
    PHI,
    0,
    INV_PHI,
    -PHI,
    0,
    INV_PHI,
    PHI,
    // (+-1/phi, +-phi, 0)
    -INV_PHI,
    -PHI,
    0,
    -INV_PHI,
    PHI,
    0,
    INV_PHI,
    -PHI,
    0,
    INV_PHI,
    PHI,
    0,
    // (+-phi, 0, +-1/phi)
    -PHI,
    0,
    -INV_PHI,
    PHI,
    0,
    -INV_PHI,
    -PHI,
    0,
    INV_PHI,
    PHI,
    0,
    INV_PHI,
  ],
  indices: [
    3, 11, 7, 3, 7, 15, 3, 15, 13, 7, 19, 17, 7, 17, 6, 7, 6, 15, 17, 4, 8, 17, 8, 10, 17, 10, 6, 8,
    0, 16, 8, 16, 2, 8, 2, 10, 0, 12, 1, 0, 1, 18, 0, 18, 16, 6, 10, 2, 6, 2, 13, 6, 13, 15, 2, 16,
    18, 2, 18, 3, 2, 3, 13, 18, 1, 9, 18, 9, 11, 18, 11, 3, 4, 14, 12, 4, 12, 0, 4, 0, 8, 11, 9, 5,
    11, 5, 19, 11, 19, 7, 19, 5, 14, 19, 14, 4, 19, 4, 17, 1, 12, 14, 1, 14, 5, 1, 5, 9,
  ],
};

type Vec3 = readonly [number, number, number];

function corner(solid: Solid, index: number): Vec3 {
  const at = (solid.indices[index] ?? 0) * 3;
  return [solid.vertices[at] ?? 0, solid.vertices[at + 1] ?? 0, solid.vertices[at + 2] ?? 0];
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Three.js subdivideFace: (detail + 1)^2 triangles per face, winding preserved. */
function subdivideFace(a: Vec3, b: Vec3, c: Vec3, detail: number, out: Vec3[]): void {
  const cols = detail + 1;
  const grid: Vec3[][] = [];
  for (let i = 0; i <= cols; i++) {
    const aj = lerp(a, c, i / cols);
    const bj = lerp(b, c, i / cols);
    const rows = cols - i;
    const row: Vec3[] = [];
    for (let j = 0; j <= rows; j++) row.push(rows === 0 ? aj : lerp(aj, bj, j / rows));
    grid.push(row);
  }
  for (let i = 0; i < cols; i++) {
    const top = grid[i] ?? [];
    const next = grid[i + 1] ?? [];
    for (let j = 0; j < 2 * (cols - i) - 1; j++) {
      const k = Math.floor(j / 2);
      const triangle =
        j % 2 === 0 ? [top[k + 1], next[k], top[k]] : [top[k + 1], next[k + 1], next[k]];
      for (const vertex of triangle) if (vertex !== undefined) out.push(vertex);
    }
  }
}

/** Longitude in [0, 1) with the same origin as createSphereGeometry's u. */
const azimuth = (x: number, z: number): number => {
  const u = Math.atan2(z, -x) / (2 * Math.PI);
  return u < 0 ? u + 1 : u;
};

/**
 * Spherical UVs (v = 0 at the top, like createSphereGeometry). Each triangle is
 * unwrapped around its centroid longitude so no face spans the seam, and pole
 * vertices take the centroid longitude.
 */
function writeTriangleUvs(uv: Float32Array, position: Float32Array, first: number): void {
  let cx = 0;
  let cz = 0;
  for (let corner = 0; corner < 3; corner++) {
    cx += position[(first + corner) * 3] ?? 0;
    cz += position[(first + corner) * 3 + 2] ?? 0;
  }
  const center = azimuth(cx, cz);
  for (let corner = 0; corner < 3; corner++) {
    const at = first + corner;
    const x = position[at * 3] ?? 0;
    const y = position[at * 3 + 1] ?? 0;
    const z = position[at * 3 + 2] ?? 0;
    const horizontal = Math.hypot(x, z);
    let u = horizontal < 1e-6 * Math.hypot(horizontal, y) ? center : azimuth(x, z);
    if (u - center > 0.5) u -= 1;
    if (u - center < -0.5) u += 1;
    uv[at * 2] = u;
    uv[at * 2 + 1] = Math.atan2(-y, horizontal) / Math.PI + 0.5;
  }
}

function writeFlatNormal(normal: Float32Array, position: Float32Array, first: number): void {
  const p = (corner: number, axis: number) => position[(first + corner) * 3 + axis] ?? 0;
  const e1 = [p(1, 0) - p(0, 0), p(1, 1) - p(0, 1), p(1, 2) - p(0, 2)] as const;
  const e2 = [p(2, 0) - p(0, 0), p(2, 1) - p(0, 1), p(2, 2) - p(0, 2)] as const;
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const length = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1;
  for (let corner = 0; corner < 3; corner++) {
    for (let axis = 0; axis < 3; axis++) {
      normal[(first + corner) * 3 + axis] = (n[axis] ?? 0) / length;
    }
  }
}

function createPolyhedron(
  solid: Solid,
  radius: number,
  detail: number,
  options: PolyhedronOptions,
): Result<MeshAsset, AssetError> {
  if (!(radius > 0) || !Number.isFinite(radius)) return err(degenerate(`radius=${radius}`));
  if (!Number.isInteger(detail) || detail < 0 || detail > MAX_DETAIL) {
    return err(degenerate(`detail=${detail}; an integer in [0, ${MAX_DETAIL}]`));
  }
  const corners: Vec3[] = [];
  for (let face = 0; face < solid.indices.length; face += 3) {
    subdivideFace(
      corner(solid, face),
      corner(solid, face + 1),
      corner(solid, face + 2),
      detail,
      corners,
    );
  }
  const attributes = createPrimitiveAttributes(corners.length);
  for (const [index, [x, y, z]] of corners.entries()) {
    const scale = radius / Math.hypot(x, y, z);
    attributes.position.set([x * scale, y * scale, z * scale], index * 3);
    attributes.normal.set(
      [(x * scale) / radius, (y * scale) / radius, (z * scale) / radius],
      index * 3,
    );
  }
  const flat = (options.normals ?? (detail === 0 ? 'flat' : 'smooth')) === 'flat';
  for (let first = 0; first < corners.length; first += 3) {
    writeTriangleUvs(attributes.uv, attributes.position, first);
    if (flat) writeFlatNormal(attributes.normal, attributes.position, first);
  }
  const indices =
    corners.length > 0xffff ? new Uint32Array(corners.length) : new Uint16Array(corners.length);
  for (let index = 0; index < indices.length; index++) indices[index] = index;
  return finishPrimitiveMesh(attributes, indices);
}

/** Three.js TetrahedronGeometry(radius = 1, detail = 0): 4 faces at detail 0. */
export function createTetrahedronGeometry(
  radius = 1,
  detail = 0,
  options: PolyhedronOptions = {},
): Result<MeshAsset, AssetError> {
  return createPolyhedron(TETRAHEDRON, radius, detail, options);
}

/** Three.js OctahedronGeometry(radius = 1, detail = 0): 8 faces at detail 0. */
export function createOctahedronGeometry(
  radius = 1,
  detail = 0,
  options: PolyhedronOptions = {},
): Result<MeshAsset, AssetError> {
  return createPolyhedron(OCTAHEDRON, radius, detail, options);
}

/** Three.js IcosahedronGeometry(radius = 1, detail = 0): 20 faces at detail 0. */
export function createIcosahedronGeometry(
  radius = 1,
  detail = 0,
  options: PolyhedronOptions = {},
): Result<MeshAsset, AssetError> {
  return createPolyhedron(ICOSAHEDRON, radius, detail, options);
}

/** Three.js DodecahedronGeometry(radius = 1, detail = 0): 12 pentagons (36 triangles) at detail 0. */
export function createDodecahedronGeometry(
  radius = 1,
  detail = 0,
  options: PolyhedronOptions = {},
): Result<MeshAsset, AssetError> {
  return createPolyhedron(DODECAHEDRON, radius, detail, options);
}
