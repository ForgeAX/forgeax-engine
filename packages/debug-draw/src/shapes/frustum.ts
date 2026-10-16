// @forgeax/engine-debug-draw -- frustum shape geometry (M3 / w21)
//
// Pure geometry decomposition: invert viewProj matrix, transform 8 NDC
// corners to world space, draw 12 edges (24 vertices).
// Returns null when the viewProj is near-singular (determinant ~ 0).
// No staging / GPU concerns; consumed by DebugDraw class.

import { type Mat4, mat4 } from '@forgeax/engine-math';

function at(m: { readonly [index: number]: number }, i: number): number {
  return m[i] as number;
}

/**
 * Generate 24 vertices (12 edges) for a frustum wireframe from a view-projection matrix.
 * Returns null if the matrix is near-singular (|det| < 1e-10).
 */
export function frustumVertices(viewProj: Mat4): [number, number, number][] | null {
  const m = viewProj;

  // 4x4 determinant
  const det =
    at(m, 0) *
      (at(m, 5) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
        at(m, 9) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) +
        at(m, 13) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7))) -
    at(m, 4) *
      (at(m, 1) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
        at(m, 9) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
        at(m, 13) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3))) +
    at(m, 8) *
      (at(m, 1) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) -
        at(m, 5) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
        at(m, 13) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3))) -
    at(m, 12) *
      (at(m, 1) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7)) -
        at(m, 5) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3)) +
        at(m, 9) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3)));

  if (Math.abs(det) < 1e-10) {
    return null;
  }

  // 4x4 inverse via cofactor expansion
  const invDet = 1.0 / det;
  const inv = mat4.create();
  inv[0] =
    (at(m, 5) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
      at(m, 9) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) +
      at(m, 13) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7))) *
    invDet;
  inv[1] =
    -(
      at(m, 1) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
      at(m, 9) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
      at(m, 13) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3))
    ) * invDet;
  inv[2] =
    (at(m, 1) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) -
      at(m, 5) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
      at(m, 13) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3))) *
    invDet;
  inv[3] =
    -(
      at(m, 1) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7)) -
      at(m, 5) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3)) +
      at(m, 9) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3))
    ) * invDet;
  inv[4] =
    -(
      at(m, 4) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
      at(m, 8) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) +
      at(m, 12) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7))
    ) * invDet;
  inv[5] =
    (at(m, 0) * (at(m, 10) * at(m, 15) - at(m, 14) * at(m, 11)) -
      at(m, 8) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
      at(m, 12) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3))) *
    invDet;
  inv[6] =
    -(
      at(m, 0) * (at(m, 6) * at(m, 15) - at(m, 14) * at(m, 7)) -
      at(m, 4) * (at(m, 2) * at(m, 15) - at(m, 14) * at(m, 3)) +
      at(m, 12) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3))
    ) * invDet;
  inv[7] =
    (at(m, 0) * (at(m, 6) * at(m, 11) - at(m, 10) * at(m, 7)) -
      at(m, 4) * (at(m, 2) * at(m, 11) - at(m, 10) * at(m, 3)) +
      at(m, 8) * (at(m, 2) * at(m, 7) - at(m, 6) * at(m, 3))) *
    invDet;
  inv[8] =
    (at(m, 4) * (at(m, 9) * at(m, 15) - at(m, 13) * at(m, 11)) -
      at(m, 8) * (at(m, 5) * at(m, 15) - at(m, 13) * at(m, 7)) +
      at(m, 12) * (at(m, 5) * at(m, 11) - at(m, 9) * at(m, 7))) *
    invDet;
  inv[9] =
    -(
      at(m, 0) * (at(m, 9) * at(m, 15) - at(m, 13) * at(m, 11)) -
      at(m, 8) * (at(m, 1) * at(m, 15) - at(m, 13) * at(m, 3)) +
      at(m, 12) * (at(m, 1) * at(m, 11) - at(m, 9) * at(m, 3))
    ) * invDet;
  inv[10] =
    (at(m, 0) * (at(m, 5) * at(m, 15) - at(m, 13) * at(m, 7)) -
      at(m, 4) * (at(m, 1) * at(m, 15) - at(m, 13) * at(m, 3)) +
      at(m, 12) * (at(m, 1) * at(m, 7) - at(m, 5) * at(m, 3))) *
    invDet;
  inv[11] =
    -(
      at(m, 0) * (at(m, 5) * at(m, 11) - at(m, 9) * at(m, 7)) -
      at(m, 4) * (at(m, 1) * at(m, 11) - at(m, 9) * at(m, 3)) +
      at(m, 8) * (at(m, 1) * at(m, 7) - at(m, 5) * at(m, 3))
    ) * invDet;
  inv[12] =
    -(
      at(m, 4) * (at(m, 9) * at(m, 14) - at(m, 13) * at(m, 10)) -
      at(m, 8) * (at(m, 5) * at(m, 14) - at(m, 13) * at(m, 6)) +
      at(m, 12) * (at(m, 5) * at(m, 10) - at(m, 9) * at(m, 6))
    ) * invDet;
  inv[13] =
    (at(m, 0) * (at(m, 9) * at(m, 14) - at(m, 13) * at(m, 10)) -
      at(m, 8) * (at(m, 1) * at(m, 14) - at(m, 13) * at(m, 2)) +
      at(m, 12) * (at(m, 1) * at(m, 10) - at(m, 9) * at(m, 2))) *
    invDet;
  inv[14] =
    -(
      at(m, 0) * (at(m, 5) * at(m, 14) - at(m, 13) * at(m, 6)) -
      at(m, 4) * (at(m, 1) * at(m, 14) - at(m, 13) * at(m, 2)) +
      at(m, 12) * (at(m, 1) * at(m, 6) - at(m, 5) * at(m, 2))
    ) * invDet;
  inv[15] =
    (at(m, 0) * (at(m, 5) * at(m, 10) - at(m, 9) * at(m, 6)) -
      at(m, 4) * (at(m, 1) * at(m, 10) - at(m, 9) * at(m, 2)) +
      at(m, 8) * (at(m, 1) * at(m, 6) - at(m, 5) * at(m, 2))) *
    invDet;

  // 8 WebGPU NDC corners: x,y in {-1,1}, z in [0,1].
  // Connecting both Z planes supports forward and Reverse-Z projections.
  const ndc: [number, number, number, number][] = [
    [-1, -1, 0, 1],
    [1, -1, 0, 1],
    [-1, 1, 0, 1],
    [1, 1, 0, 1],
    [-1, -1, 1, 1],
    [1, -1, 1, 1],
    [-1, 1, 1, 1],
    [1, 1, 1, 1],
  ];

  const corners: [number, number, number][] = ndc.map(([nx, ny, nz, nw]) => {
    const cx = at(inv, 0) * nx + at(inv, 4) * ny + at(inv, 8) * nz + at(inv, 12) * nw;
    const cy = at(inv, 1) * nx + at(inv, 5) * ny + at(inv, 9) * nz + at(inv, 13) * nw;
    const cz = at(inv, 2) * nx + at(inv, 6) * ny + at(inv, 10) * nz + at(inv, 14) * nw;
    const cw = at(inv, 3) * nx + at(inv, 7) * ny + at(inv, 11) * nz + at(inv, 15) * nw;
    const iw = 1.0 / cw;
    return [cx * iw, cy * iw, cz * iw] as [number, number, number];
  });

  // 12 edges
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [4, 5],
    [4, 6],
    [5, 7],
    [6, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const result: [number, number, number][] = [];
  for (const [ai, bi] of edges) {
    const ac = corners[ai] as [number, number, number];
    const bc = corners[bi] as [number, number, number];
    result.push([ac[0], ac[1], ac[2]]);
    result.push([bc[0], bc[1], bc[2]]);
  }
  return result;
}
