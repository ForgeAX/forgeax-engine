// mat3.ts — 3x3 matrix namespace (M3 / T-020)
//
// 10-function surface (≥ 10 lower bound):
//   create / clone / identity / equals / multiply / transpose / invert /
//   scale / fromMat4 / normalMatrix
//
// Memory layout lock (D-P4): 9 floats packed column-major; index mapping m[col*3 + row].
// Primary use: CPU normal matrix (normalMatrix = transpose(invert(upper-left mat3 of mat4)));
// callers that upload directly to a GPU UBO should pad to mat4 themselves
// (see R4 + the reserved toGpuLayout hook).
//
// Degenerate convention (same as D-P1): invert(singular) → write identity into out, return out (does not return null).
//
// Four ironclad rules (gl-matrix wiki / research §F1):
//   1. Out-param first (except for query functions, the first parameter = out, return out)
//   2. Aliasing-safe (out may equal an input; read all source data into locals first)
//   3. Module-as-namespace (pure functions; no class, no this)
//   4. Float32Array by default (V8 elements-kinds consistency)
//
// Related: requirements §Surface mat3 lower bound 10 + AC-04 (normalMatrix);
//          plan-strategy D-P4 9-float lock + D-P1 invert writes identity;
//          wiki/gl-matrix-overview Out-param four ironclad rules;
//          wiki/typescript-branded-types §7.2 factory template.
//
// Degenerate-semantics registry (plan-strategy.md §appendix A; shares numbering #3 with mat4):
//   - mat3.invert(singular)        → out = identity (same convention as D-P1)
//   - mat3.normalMatrix(singular)  → out = identity (via the internal branch in mat3.invert)

import { EPS_DET } from './_internal/epsilon';
import type { Mat3, Mat3Like, Mat4Like, Vec3Like } from './types';

export type { Mat3, Mat3Like };

/** Create a Mat3 (default all zero; callers usually call identity() right after). */
export function create(): Mat3 {
  return new Float32Array(9) as Mat3;
}

/** Allocate a new Mat3 copy. */
export function clone(a: Mat3Like): Mat3 {
  return Float32Array.of(
    a[0] as number,
    a[1] as number,
    a[2] as number,
    a[3] as number,
    a[4] as number,
    a[5] as number,
    a[6] as number,
    a[7] as number,
    a[8] as number,
  ) as Mat3;
}

/** out = 3x3 identity (column-major [1,0,0, 0,1,0, 0,0,1]). Returns out. */
export function identity(out: Mat3): Mat3 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

/** Approximate equality: each element differs by ≤ epsilon. NaN inputs always return false. */
export function equals(a: Mat3Like, b: Mat3Like, epsilon = 1e-6): boolean {
  for (let i = 0; i < 9; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (Number.isNaN(av) || Number.isNaN(bv)) return false;
    if (Math.abs(av - bv) > epsilon) return false;
  }
  return true;
}

/**
 * out = a * b (column-major matrix multiply). Returns out.
 *
 * Aliasing-safe: out may equal a or b; reads all 18 source elements into locals first.
 */
export function multiply(out: Mat3, a: Mat3Like, b: Mat3Like): Mat3 {
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a10 = a[3] as number;
  const a11 = a[4] as number;
  const a12 = a[5] as number;
  const a20 = a[6] as number;
  const a21 = a[7] as number;
  const a22 = a[8] as number;
  const b00 = b[0] as number;
  const b01 = b[1] as number;
  const b02 = b[2] as number;
  const b10 = b[3] as number;
  const b11 = b[4] as number;
  const b12 = b[5] as number;
  const b20 = b[6] as number;
  const b21 = b[7] as number;
  const b22 = b[8] as number;
  out[0] = a00 * b00 + a10 * b01 + a20 * b02;
  out[1] = a01 * b00 + a11 * b01 + a21 * b02;
  out[2] = a02 * b00 + a12 * b01 + a22 * b02;
  out[3] = a00 * b10 + a10 * b11 + a20 * b12;
  out[4] = a01 * b10 + a11 * b11 + a21 * b12;
  out[5] = a02 * b10 + a12 * b11 + a22 * b12;
  out[6] = a00 * b20 + a10 * b21 + a20 * b22;
  out[7] = a01 * b20 + a11 * b21 + a21 * b22;
  out[8] = a02 * b20 + a12 * b21 + a22 * b22;
  return out;
}

/**
 * out = transpose(a). Returns out.
 *
 * Aliasing-safe (transpose(m, m) is legal; reads the 6 off-diagonal elements into locals first).
 */
export function transpose(out: Mat3, a: Mat3Like): Mat3 {
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a12 = a[5] as number;
  const a10 = a[3] as number;
  const a20 = a[6] as number;
  const a21 = a[7] as number;
  out[0] = a[0] as number;
  out[1] = a10;
  out[2] = a20;
  out[3] = a01;
  out[4] = a[4] as number;
  out[5] = a21;
  out[6] = a02;
  out[7] = a12;
  out[8] = a[8] as number;
  return out;
}

/**
 * out = invert(a). Returns out.
 *
 * @degrade a singular (|det| < EPS_DET) → out = identity (same convention as D-P1; does not return null).
 *
 * @example
 * ```ts
 * // Caller-side guard:
 * const det = mat3DetForGuard(m); // caller computes det to decide whether to invert
 * const inv = mat3.invert(mat3.create(), m);
 * // If m is singular, inv === identity (no NaN; safe to keep using).
 * ```
 */
export function invert(out: Mat3, a: Mat3Like): Mat3 {
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a10 = a[3] as number;
  const a11 = a[4] as number;
  const a12 = a[5] as number;
  const a20 = a[6] as number;
  const a21 = a[7] as number;
  const a22 = a[8] as number;

  // cofactors (column-major → derive from row/col indices)
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;

  if (Math.abs(det) < EPS_DET) {
    return identity(out);
  }

  const invDet = 1 / det;
  out[0] = b01 * invDet;
  out[1] = (-a22 * a01 + a02 * a21) * invDet;
  out[2] = (a12 * a01 - a02 * a11) * invDet;
  out[3] = b11 * invDet;
  out[4] = (a22 * a00 - a02 * a20) * invDet;
  out[5] = (-a12 * a00 + a02 * a10) * invDet;
  out[6] = b21 * invDet;
  out[7] = (-a21 * a00 + a01 * a20) * invDet;
  out[8] = (a11 * a00 - a01 * a10) * invDet;
  return out;
}

/**
 * out = a * Scale(v) (per-column scale). Returns out.
 *
 * v takes the first 3 components (aligned with mat4.scale's vec3 input); mat3's third column is the z scale.
 */
export function scale(out: Mat3, a: Mat3Like, v: Vec3Like): Mat3 {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  out[0] = (a[0] as number) * x;
  out[1] = (a[1] as number) * x;
  out[2] = (a[2] as number) * x;
  out[3] = (a[3] as number) * y;
  out[4] = (a[4] as number) * y;
  out[5] = (a[5] as number) * y;
  out[6] = (a[6] as number) * z;
  out[7] = (a[7] as number) * z;
  out[8] = (a[8] as number) * z;
  return out;
}

/**
 * out = mat3 extracted from mat4's upper-left 3x3 (drop the 4th row and 4th column). Returns out.
 *
 * Column-major mapping: mat4 col0 [0..2] / col1 [4..6] / col2 [8..10] → mat3 col0/1/2.
 */
export function fromMat4(out: Mat3, m: Mat4Like): Mat3 {
  out[0] = m[0] as number;
  out[1] = m[1] as number;
  out[2] = m[2] as number;
  out[3] = m[4] as number;
  out[4] = m[5] as number;
  out[5] = m[6] as number;
  out[6] = m[8] as number;
  out[7] = m[9] as number;
  out[8] = m[10] as number;
  return out;
}

/**
 * out = transpose(invert(upper-left 3x3 of m)) (the normal-transform matrix). Returns out.
 *
 * Used to transform normals from model space to world / view space; when m has a non-uniform
 * scale, normals must use normalMatrix (the upper-left 3x3 of m alone is incorrect).
 *
 * CPU utility; render shaders derive normals from the world transform.
 *
 * @degrade upper-left 3x3 singular -> out = identity (same convention as D-P1, via mat3.invert).
 *
 * @example
 * ```ts
 * const N = mat3.normalMatrix(mat3.create(), modelViewMat);
 * // vertex shader: normal_view = N * normal_model
 * ```
 */
export function normalMatrix(out: Mat3, m: Mat4Like): Mat3 {
  // 1. extract the upper-left 3x3
  const m00 = m[0] as number;
  const m01 = m[1] as number;
  const m02 = m[2] as number;
  const m10 = m[4] as number;
  const m11 = m[5] as number;
  const m12 = m[6] as number;
  const m20 = m[8] as number;
  const m21 = m[9] as number;
  const m22 = m[10] as number;

  // 2. inline invert + transpose (combine the two steps; avoid a temporary allocation)
  const b01 = m22 * m11 - m12 * m21;
  const b11 = -m22 * m10 + m12 * m20;
  const b21 = m21 * m10 - m11 * m20;
  const det = m00 * b01 + m01 * b11 + m02 * b21;

  if (Math.abs(det) < EPS_DET) {
    return identity(out);
  }

  const invDet = 1 / det;
  // Elements of invert(upper-left), then transpose (swap rows/cols)
  // invert column-major:
  //   inv[0]=b01*invDet      inv[3]=b11*invDet      inv[6]=b21*invDet
  //   inv[1]=...              inv[4]=...              inv[7]=...
  //   inv[2]=...              inv[5]=...              inv[8]=...
  // After transpose (i, j) = inv (j, i)
  // More directly: transposing the invert result = transpose(invert).
  // The transpose(invert) elements are written out below:
  out[0] = b01 * invDet;
  out[3] = (-m22 * m01 + m02 * m21) * invDet;
  out[6] = (m12 * m01 - m02 * m11) * invDet;
  out[1] = b11 * invDet;
  out[4] = (m22 * m00 - m02 * m20) * invDet;
  out[7] = (-m12 * m00 + m02 * m10) * invDet;
  out[2] = b21 * invDet;
  out[5] = (-m21 * m00 + m01 * m20) * invDet;
  out[8] = (m11 * m00 - m01 * m10) * invDet;
  return out;
}
