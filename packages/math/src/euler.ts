// euler.ts — Euler angle namespace (M4 / T-028)
//
// 6-function surface (≥ 6 lower bound):
//   create / clone / set / fromQuat / toQuat / fromRotationMatrix
//
// Memory layout: plain object `{ x: number, y: number, z: number, order: EulerOrder }`
// (not a Float32Array). Rationale:
//   - need to store length=3 plus a string order; strings cannot live inside a TypedArray
//   - performance-insensitive (euler is only used at the editor/IO boundary; runtime always converts to Quat)
//
// 6 orders (intrinsic rotation; literal order x → y → z):
//   XYZ / YXZ / ZXY / ZYX / YZX / XZY
//
// Degenerate convention (plan-strategy §appendix A degenerate registry #16):
//   - fromQuat(q, order) gimbal-lock (pitch ≈ ±π/2) → pick an equivalent branch; never throws
//   - fromRotationMatrix follows the same convention
//
// Related: requirements §Surface euler lower bound 6 + 6-order full support;
//          plan-strategy §1.1 euler.ts + §appendix A degenerate registry #16 + D-P19 EulerOrder union;
//          wiki/glam-rs-overview Hamilton convention +
//          Three.js Euler.setFromQuaternion / setFromRotationMatrix 6-order formulas.
//
// Degenerate-semantics registry (plan-strategy.md §appendix A; D-P16 dual promise:
// runtime silent + JSDoc `@degrade` + `@example` guard pattern landing together):
//   #16 euler.fromQuat(q, order) gimbal-lock  → pick equivalent branch (no throw)
//   #17 euler.fromRotationMatrix gimbal-lock  → same as above

import * as quat from './quat';
import type { Euler, EulerOrder, Mat3Like, Quat, QuatLike } from './types';

export type { Euler, EulerOrder };

/** Create an Euler, defaulting to (0, 0, 0, 'XYZ'). */
export function create(): Euler {
  return { x: 0, y: 0, z: 0, order: 'XYZ' };
}

/** Allocate a new Euler copy. */
export function clone(a: Euler): Euler {
  return { x: a.x, y: a.y, z: a.z, order: a.order };
}

/** out.x/y/z/order = inputs; returns out (in-place). */
export function set(out: Euler, x: number, y: number, z: number, order: EulerOrder): Euler {
  out.x = x;
  out.y = y;
  out.z = z;
  out.order = order;
  return out;
}

/**
 * out (Quat) = quaternion from euler. Returns out.
 *
 * Routes directly to quat.fromEuler (D-P2 + 6-order coverage already implemented inside quat).
 *
 * @example
 * ```ts
 * euler.toQuat(quatBuf, eulerInstance);
 * ```
 */
export function toQuat(out: Quat, e: Euler): Quat {
  return quat.fromEuler(out, e.x, e.y, e.z, e.order);
}

/**
 * out (Euler) = euler angles from quaternion in given order. Returns out.
 *
 * Implementation path: quat → 3x3 column-major rotation matrix → fromRotationMatrix(order).
 * This concentrates the 6-order formulas in fromRotationMatrix and avoids dual maintenance.
 *
 * @degrade gimbal lock (pitch ≈ ±π/2, sin/cos critical) → set yaw to 0 and let roll absorb the
 *          full rotation (registry #16; same equivalent-branch semantics as Three.js; no throw).
 *
 * @example
 * ```ts
 * euler.fromQuat(out, q, 'XYZ');
 * ```
 */
export function fromQuat(out: Euler, q: QuatLike, order: EulerOrder): Euler {
  // Expand q into a 3x3 column-major rotation matrix (matching the index convention of quat.fromRotationMatrix)
  const x = q[0] as number;
  const y = q[1] as number;
  const z = q[2] as number;
  const w = q[3] as number;
  const xx = x * x;
  const xy = x * y;
  const xz = x * z;
  const yy = y * y;
  const yz = y * z;
  const zz = z * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  // mat3 column-major: m[col*3+row] → m00=col0row0, m01=col0row1, m10=col1row0...
  // R[row][col] maps to m[col*3+row]:
  //   R[0][0]=m00,R[0][1]=m10,R[0][2]=m20
  //   R[1][0]=m01,R[1][1]=m11,R[1][2]=m21
  //   R[2][0]=m02,R[2][1]=m12,R[2][2]=m22
  const m = new Float32Array(9);
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 2 * (xy - wz);
  m[4] = 1 - 2 * (xx + zz);
  m[5] = 2 * (yz + wx);
  m[6] = 2 * (xz + wy);
  m[7] = 2 * (yz - wx);
  m[8] = 1 - 2 * (xx + yy);

  return fromRotationMatrix(out, m, order);
}

/**
 * out (Euler) = euler from a 3x3 rotation matrix m (column-major, length 9) in `order`. Returns out.
 *
 * Uses the Three.js Euler.setFromRotationMatrix formulas (intrinsic rotation + Hamilton convention).
 * Each of the 6 orders has an analytic formula; near gimbal-lock (middle axis sin/cos near ±1)
 * an equivalent branch is selected.
 *
 * @degrade gimbal lock → middle axis is fixed at ±π/2; the remaining two axes degenerate
 * (one is set to 0; the other absorbs the rotation).
 *
 * @example
 * ```ts
 * euler.fromRotationMatrix(out, mat3InstanceColumnMajor, 'XYZ');
 * ```
 */
export function fromRotationMatrix(out: Euler, m: Mat3Like, order: EulerOrder): Euler {
  // Column-major indexing (matches quat.fromRotationMatrix):
  //   m00 m01 m02 = column 0 (col=0)'s row=0/1/2
  //   m10 m11 m12 = column 1 (col=1)'s row=0/1/2
  //   m20 m21 m22 = column 2 (col=2)'s row=0/1/2
  // Mathematically R[row][col] = m[c*3 + r].
  // Thus, in the Three.js formulas, m11 (R[0][0]) corresponds to our m[0],
  //                                m12 (R[0][1]) corresponds to m[3],
  //                                m13 (R[0][2]) corresponds to m[6],
  //                                m21 (R[1][0]) corresponds to m[1], etc.
  // For readability and alignment with Three.js naming, alias (_ij denotes R[i-1][j-1]):
  const _11 = m[0] as number;
  const _21 = m[1] as number;
  const _31 = m[2] as number;
  const _12 = m[3] as number;
  const _22 = m[4] as number;
  const _32 = m[5] as number;
  const _13 = m[6] as number;
  const _23 = m[7] as number;
  const _33 = m[8] as number;

  out.order = order;
  switch (order) {
    case 'XYZ':
      out.y = Math.asin(clamp11(_13));
      if (Math.abs(_13) < 1 - 1e-7) {
        out.x = Math.atan2(-_23, _33);
        out.z = Math.atan2(-_12, _11);
      } else {
        // gimbal lock
        out.x = Math.atan2(_32, _22);
        out.z = 0;
      }
      break;
    case 'YXZ':
      out.x = Math.asin(-clamp11(_23));
      if (Math.abs(_23) < 1 - 1e-7) {
        out.y = Math.atan2(_13, _33);
        out.z = Math.atan2(_21, _22);
      } else {
        out.y = Math.atan2(-_31, _11);
        out.z = 0;
      }
      break;
    case 'ZXY':
      out.x = Math.asin(clamp11(_32));
      if (Math.abs(_32) < 1 - 1e-7) {
        out.y = Math.atan2(-_31, _33);
        out.z = Math.atan2(-_12, _22);
      } else {
        out.y = 0;
        out.z = Math.atan2(_21, _11);
      }
      break;
    case 'ZYX':
      out.y = Math.asin(-clamp11(_31));
      if (Math.abs(_31) < 1 - 1e-7) {
        out.x = Math.atan2(_32, _33);
        out.z = Math.atan2(_21, _11);
      } else {
        out.x = 0;
        out.z = Math.atan2(-_12, _22);
      }
      break;
    case 'YZX':
      out.z = Math.asin(clamp11(_21));
      if (Math.abs(_21) < 1 - 1e-7) {
        out.x = Math.atan2(-_23, _22);
        out.y = Math.atan2(-_31, _11);
      } else {
        out.x = 0;
        out.y = Math.atan2(_13, _33);
      }
      break;
    case 'XZY':
      out.z = Math.asin(-clamp11(_12));
      if (Math.abs(_12) < 1 - 1e-7) {
        out.x = Math.atan2(_32, _22);
        out.y = Math.atan2(_13, _11);
      } else {
        out.x = Math.atan2(-_23, _33);
        out.y = 0;
      }
      break;
    default:
      // Silent fallback to 'XYZ' (same convention as quat.fromEuler D-P2)
      out.y = Math.asin(clamp11(_13));
      if (Math.abs(_13) < 1 - 1e-7) {
        out.x = Math.atan2(-_23, _33);
        out.z = Math.atan2(-_12, _11);
      } else {
        out.x = Math.atan2(_32, _22);
        out.z = 0;
      }
      out.order = 'XYZ';
      break;
  }

  return out;
}

/**
 * Internal: clamp to [-1, 1] to keep asin from receiving out-of-range inputs (floating-point error
 * may make |x| slightly > 1; same guard as Three.js; not counted in the surface).
 */
function clamp11(v: number): number {
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}
