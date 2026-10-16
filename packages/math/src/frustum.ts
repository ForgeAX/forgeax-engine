// frustum.ts — view-frustum plane extraction and intersection tests (M1 / w4).
//
// Frustum representation: Float32Array(24) — 6 planes × 4 floats (nx, ny, nz, d) each,
// normalized. Plane equation: nx*x + ny*y + nz*z + d = 0, positive side = inside frustum.
//
// Planes are extracted from a combined view-projection matrix (column-major) by
// combining rows per the Gribb/Hartmann method (Gribb/Hartmann 2001 "Fast
// Extraction of Viewing Frustum Planes from the World-View-Projection Matrix").
// Plane normalization is built into fromViewProjection internally (D-6).
//
// Surface: create / fromViewProjection / intersectsBox / intersectsSphere.
//
// Related: requirements §AC-01 (frustum function signatures + test coverage);
//          plan-strategy §D-6 (internal normalization).

import type { Box3Like } from './box3';
import type { Mat4Like, Vec3Like } from './types';

/**
 * Frustum storage: Float32Array(24) — 6 planes × 4 floats each (nx, ny, nz, d).
 * Local brand (not part of the seven-piece SSOT; same rationale as Box3).
 */
export type Frustum = Float32Array & { readonly __frustum: void };

/** Allocate a new Frustum (zero-initialized 6 planes). */
export function create(): Frustum {
  return new Float32Array(24) as Frustum;
}

/**
 * Extract 6 frustum planes (left, right, bottom, top, lower-Z, upper-Z) from a
 * combined WebGPU [0,1] view-projection matrix (column-major, right-handed).
 *
 * Uses Gribb/Hartmann method: each plane = sum or difference of VP rows,
 * then normalized so (nx, ny, nz) is a unit vector and d is the signed
 * distance from origin. Plane inside-half-space is nx*x + ny*y + nz*z + d > 0.
 *
 * Writes to `out` and returns it.
 *
 * @example
 * ```ts
 * const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
 * const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
 * const vp = mat4.create();
 * mat4.multiply(vp, proj, view);
 * const f = frustum.fromViewProjection(frustum.create(), vp);
 * ```
 */
export function fromViewProjection(out: Frustum, vp: Mat4Like): Frustum {
  const m0 = vp[0] as number;
  const m1 = vp[1] as number;
  const m2 = vp[2] as number;
  const m3 = vp[3] as number;
  const m4 = vp[4] as number;
  const m5 = vp[5] as number;
  const m6 = vp[6] as number;
  const m7 = vp[7] as number;
  const m8 = vp[8] as number;
  const m9 = vp[9] as number;
  const m10 = vp[10] as number;
  const m11 = vp[11] as number;
  const m12 = vp[12] as number;
  const m13 = vp[13] as number;
  const m14 = vp[14] as number;
  const m15 = vp[15] as number;

  // Left plane: row3 + row0
  let nx = m3 + m0,
    ny = m7 + m4,
    nz = m11 + m8,
    d = m15 + m12;
  let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  out[3] = d;

  // Right plane: row3 - row0
  nx = m3 - m0;
  ny = m7 - m4;
  nz = m11 - m8;
  d = m15 - m12;
  len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[4] = nx;
  out[5] = ny;
  out[6] = nz;
  out[7] = d;

  // Bottom plane: row3 + row1
  nx = m3 + m1;
  ny = m7 + m5;
  nz = m11 + m9;
  d = m15 + m13;
  len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[8] = nx;
  out[9] = ny;
  out[10] = nz;
  out[11] = d;

  // Top plane: row3 - row1
  nx = m3 - m1;
  ny = m7 - m5;
  nz = m11 - m9;
  d = m15 - m13;
  len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[12] = nx;
  out[13] = ny;
  out[14] = nz;
  out[15] = d;

  // Lower Z clip plane: row2 (WebGPU 0 <= z <= w).
  // This is the near plane for forward Z and the far plane for Reverse-Z.
  nx = m2;
  ny = m6;
  nz = m10;
  d = m14;
  len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[16] = nx;
  out[17] = ny;
  out[18] = nz;
  out[19] = d;

  // Upper Z clip plane: row3 - row2 (near for Reverse-Z).
  nx = m3 - m2;
  ny = m7 - m6;
  nz = m11 - m10;
  d = m15 - m14;
  len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    const il = 1 / len;
    nx *= il;
    ny *= il;
    nz *= il;
    d *= il;
  }
  out[20] = nx;
  out[21] = ny;
  out[22] = nz;
  out[23] = d;

  return out;
}

/**
 * Test whether an AABB intersects the frustum. Conservative: returns `true` when
 * the box straddles a plane boundary, even if partially outside.
 *
 * For each plane, the signed distance of both the positive-most corner (p-vertex)
 * and negative-most corner (n-vertex) are tested. The box is outside only when
 * the p-vertex is on the negative side of any plane.
 */
export function intersectsBox(f: Frustum, box: Box3Like): boolean {
  const bx = box[0] as number;
  const by = box[1] as number;
  const bz = box[2] as number;
  const bX = box[3] as number;
  const bY = box[4] as number;
  const bZ = box[5] as number;

  // For each plane, compute the p-vertex (most positive along plane normal)
  // and test if it's on the negative side. If so, box is entirely outside.
  for (let i = 0; i < 6; i++) {
    const off = i * 4;
    const nx = f[off] as number;
    const ny = f[off + 1] as number;
    const nz = f[off + 2] as number;
    const d = f[off + 3] as number;

    // p-vertex: corner maximizing dot(normal, corner) = corner select via sign of normal
    const px = nx >= 0 ? bX : bx;
    const py = ny >= 0 ? bY : by;
    const pz = nz >= 0 ? bZ : bz;

    if (nx * px + ny * py + nz * pz + d < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Test whether a sphere intersects the frustum. Conservative: returns `true`
 * when the sphere straddles a plane boundary.
 *
 * Computes signed distance from the sphere center to each plane;
 * outside when distance < -radius.
 */
export function intersectsSphere(f: Frustum, center: Vec3Like, radius: number): boolean {
  const cx = center[0] as number;
  const cy = center[1] as number;
  const cz = center[2] as number;

  for (let i = 0; i < 6; i++) {
    const off = i * 4;
    const nx = f[off] as number;
    const ny = f[off + 1] as number;
    const nz = f[off + 2] as number;
    const sd = f[off + 3] as number; // plane's d (signed distance from origin)

    const dist = nx * cx + ny * cy + nz * cz + sd;
    if (dist < -radius) {
      return false;
    }
  }
  return true;
}
