// mat4.ts — 4x4 matrix namespace (M3 / T-021 base + T-022 projection)
//
// Base functions (T-021): create / clone / identity / equals / multiply / transpose /
//   invert / scale / translate / rotate / lookAt / compose / decompose / fromQuat /
//   fromTranslation / fromScaling / fromRotation
// Projection functions (T-022): perspective / perspectiveNO / perspectiveReverseZ /
//   orthographic / orthographicNO / orthographicReverseZ
//
// Surface: 23+ functions (≥ 22 lower bound).
//
// Memory layout: column-major 16 floats (compatible with WebGL/WebGPU shader uniforms);
// index mapping m[col*4 + row]. translation lives in col 3 → indices 12, 13, 14.
//
// Naming convention (D-3):
//   - perspective / orthographic = WebGPU [0, 1] NDC (short names go to the primary target)
//   - perspectiveNO / orthographicNO = WebGL/OpenGL [-1, 1] NDC
//   - perspectiveReverseZ / orthographicReverseZ = reversed-Z (far→0, near→1)
//
// Degenerate convention:
//   - invert(singular) → out = identity (D-P1; returns out, not null)
//   - lookAt(eye=target) → out = identity (D-P17; same convention as D-P1)
//   - perspective(near>=far) / fovy<=0 / aspect<=0 → numerically undefined but does not throw
//
// Four ironclad rules (gl-matrix wiki / research §F1):
//   1. Out-param first; 2. Aliasing-safe; 3. Module-as-namespace; 4. Float32Array by default.
//
// Related: requirements §Surface mat4 lower bound 22 + AC-04 three projection tiers complete +
//          AC-05 reversed-Z fixture + AC-06 never raises (silent degrade) + AC-08 invert returns out, not null;
//          plan-strategy §6 M3 + D-P1/D-P3/D-P17 + R-P1 aliasing-singular;
//          wiki/wgpu-matrix-overview.md / gl-matrix-overview.md / reversed-z-projection.md.
//
// Degenerate-semantics registry (plan-strategy.md §appendix A numbering; mat portion has 5 of the
// AC-07 ≥ 8 hard lower-bound entries):
//   #3  mat4.invert(singular)              → out = identity (D-P1)
//   #4  mat4.lookAt(eye=target)            → out = identity (D-P17)
//   #5  mat4.lookAt(up // forward)         → auto-select alternative up
//   #6  mat4.decompose(m with shear)       → silent best-effort decomposition
//   #7  mat4.perspective(near>=far) etc.   → numerically undefined but does not throw

import { EPS_DET, EPS_NORMALIZE } from './_internal/epsilon';
import type { Mat4, Mat4Like, Quat, QuatLike, Vec3, Vec3Like } from './types';
import * as vec3 from './vec3';

export type { Mat4, Mat4Like };

/** Create a Mat4 (default all zero; callers usually call identity() right after). */
export function create(): Mat4 {
  return new Float32Array(16) as Mat4;
}

/**
 * Create one non-overlapping matrix view of caller-owned packed f32 storage.
 * @degrade An invalid matrix window returns a detached zero matrix.
 */
export function view(storage: Float32Array, index = 0): Mat4 {
  if (!Number.isSafeInteger(index) || index < 0 || index * 16 + 16 > storage.length)
    return create();
  return new Float32Array(storage.buffer, storage.byteOffset + index * 64, 16) as Mat4;
}

/** Allocate a new Mat4 copy. */
export function clone(a: Mat4Like): Mat4 {
  const r = new Float32Array(16) as Mat4;
  for (let i = 0; i < 16; i++) r[i] = a[i] as number;
  return r;
}

/** out = 4x4 identity. Returns out. */
export function identity(out: Mat4): Mat4 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** Approximate equality: each element differs by ≤ epsilon. NaN inputs always return false. */
export function equals(a: Mat4Like, b: Mat4Like, epsilon = 1e-6): boolean {
  for (let i = 0; i < 16; i++) {
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
 * Aliasing-safe: out may equal a or b; reads all 32 source elements into locals first.
 */
export function multiply(out: Mat4, a: Mat4Like, b: Mat4Like): Mat4 {
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a03 = a[3] as number;
  const a10 = a[4] as number;
  const a11 = a[5] as number;
  const a12 = a[6] as number;
  const a13 = a[7] as number;
  const a20 = a[8] as number;
  const a21 = a[9] as number;
  const a22 = a[10] as number;
  const a23 = a[11] as number;
  const a30 = a[12] as number;
  const a31 = a[13] as number;
  const a32 = a[14] as number;
  const a33 = a[15] as number;
  const b00 = b[0] as number;
  const b01 = b[1] as number;
  const b02 = b[2] as number;
  const b03 = b[3] as number;
  const b10 = b[4] as number;
  const b11 = b[5] as number;
  const b12 = b[6] as number;
  const b13 = b[7] as number;
  const b20 = b[8] as number;
  const b21 = b[9] as number;
  const b22 = b[10] as number;
  const b23 = b[11] as number;
  const b30 = b[12] as number;
  const b31 = b[13] as number;
  const b32 = b[14] as number;
  const b33 = b[15] as number;
  out[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  out[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  out[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  out[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
  out[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  out[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  out[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  out[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
  out[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  out[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  out[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  out[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
  out[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  out[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  out[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  out[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
  return out;
}

/** out = transpose(a). Returns out. Aliasing-safe (transpose(m, m) is legal). */
export function transpose(out: Mat4, a: Mat4Like): Mat4 {
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a03 = a[3] as number;
  const a12 = a[6] as number;
  const a13 = a[7] as number;
  const a23 = a[11] as number;
  const a10 = a[4] as number;
  const a20 = a[8] as number;
  const a30 = a[12] as number;
  const a21 = a[9] as number;
  const a31 = a[13] as number;
  const a32 = a[14] as number;
  out[0] = a[0] as number;
  out[1] = a10;
  out[2] = a20;
  out[3] = a30;
  out[4] = a01;
  out[5] = a[5] as number;
  out[6] = a21;
  out[7] = a31;
  out[8] = a02;
  out[9] = a12;
  out[10] = a[10] as number;
  out[11] = a32;
  out[12] = a03;
  out[13] = a13;
  out[14] = a23;
  out[15] = a[15] as number;
  return out;
}

/**
 * out = invert(a). Returns out.
 *
 * @degrade a singular (|det| < EPS_DET) → out = identity (D-P1; AC-08: returns out, not null).
 * @degrade aliasing invert(out, out) where out is singular → reads 16 elements into locals before
 *          falling back; R-P1 pins the behavior so that out is overwritten with identity.
 *
 * @example
 * ```ts
 * import { mat4 } from '@forgeax/engine-math';
 *
 * const inv = mat4.invert(mat4.create(), m);
 * // If m is singular, inv === identity (no NaN, no null); callers may keep using it.
 * // For explicit diagnostics, the caller builds its own guard (the library never console.warns):
 * //   const EPS = 1e-12;
 * //   if (mat4.equals(inv, mat4.identity(mat4.create()))) console.warn('mat4.invert: singular input');
 * ```
 */
export function invert(out: Mat4, a: Mat4Like): Mat4 {
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a03 = a[3] as number;
  const a10 = a[4] as number;
  const a11 = a[5] as number;
  const a12 = a[6] as number;
  const a13 = a[7] as number;
  const a20 = a[8] as number;
  const a21 = a[9] as number;
  const a22 = a[10] as number;
  const a23 = a[11] as number;
  const a30 = a[12] as number;
  const a31 = a[13] as number;
  const a32 = a[14] as number;
  const a33 = a[15] as number;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

  if (Math.abs(det) < EPS_DET) {
    return identity(out);
  }

  const invDet = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

/**
 * out = a * Scale(v). Returns out. Aliasing-safe (reads the source diagonal columns into locals first).
 */
export function scale(out: Mat4, a: Mat4Like, v: Vec3Like): Mat4 {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  out[0] = (a[0] as number) * x;
  out[1] = (a[1] as number) * x;
  out[2] = (a[2] as number) * x;
  out[3] = (a[3] as number) * x;
  out[4] = (a[4] as number) * y;
  out[5] = (a[5] as number) * y;
  out[6] = (a[6] as number) * y;
  out[7] = (a[7] as number) * y;
  out[8] = (a[8] as number) * z;
  out[9] = (a[9] as number) * z;
  out[10] = (a[10] as number) * z;
  out[11] = (a[11] as number) * z;
  out[12] = a[12] as number;
  out[13] = a[13] as number;
  out[14] = a[14] as number;
  out[15] = a[15] as number;
  return out;
}

/**
 * out = a * Translate(v) (translate by v in a's local coordinates). Returns out. Aliasing-safe.
 */
export function translate(out: Mat4, a: Mat4Like, v: Vec3Like): Mat4 {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  if (a === out) {
    out[12] =
      (a[0] as number) * x + (a[4] as number) * y + (a[8] as number) * z + (a[12] as number);
    out[13] =
      (a[1] as number) * x + (a[5] as number) * y + (a[9] as number) * z + (a[13] as number);
    out[14] =
      (a[2] as number) * x + (a[6] as number) * y + (a[10] as number) * z + (a[14] as number);
    out[15] =
      (a[3] as number) * x + (a[7] as number) * y + (a[11] as number) * z + (a[15] as number);
    return out;
  }
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a03 = a[3] as number;
  const a10 = a[4] as number;
  const a11 = a[5] as number;
  const a12 = a[6] as number;
  const a13 = a[7] as number;
  const a20 = a[8] as number;
  const a21 = a[9] as number;
  const a22 = a[10] as number;
  const a23 = a[11] as number;
  out[0] = a00;
  out[1] = a01;
  out[2] = a02;
  out[3] = a03;
  out[4] = a10;
  out[5] = a11;
  out[6] = a12;
  out[7] = a13;
  out[8] = a20;
  out[9] = a21;
  out[10] = a22;
  out[11] = a23;
  out[12] = a00 * x + a10 * y + a20 * z + (a[12] as number);
  out[13] = a01 * x + a11 * y + a21 * z + (a[13] as number);
  out[14] = a02 * x + a12 * y + a22 * z + (a[14] as number);
  out[15] = a03 * x + a13 * y + a23 * z + (a[15] as number);
  return out;
}

/**
 * out = a * Rotate(axis, rad) (build the rotation via the Rodrigues formula then right-multiply a).
 * Returns out.
 *
 * @degrade axis is the zero vector (lengthSq < EPS_NORMALIZE) → out = a (no rotation; identity behavior).
 *
 * @example
 * ```ts
 * mat4.rotate(out, mat4.identity(mat4.create()), [0, 1, 0], Math.PI / 2);
 * // Guard: if (vec3.lengthSq(axis) < EPS_NORMALIZE) skip;
 * ```
 */
export function rotate(out: Mat4, a: Mat4Like, axis: Vec3Like, rad: number): Mat4 {
  let x = axis[0] as number;
  let y = axis[1] as number;
  let z = axis[2] as number;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < EPS_NORMALIZE) {
    // zero-axis degenerate: copy a to out (no rotation)
    if (out !== a) {
      for (let i = 0; i < 16; i++) out[i] = a[i] as number;
    }
    return out;
  }
  const invLen = 1 / Math.sqrt(lenSq);
  x *= invLen;
  y *= invLen;
  z *= invLen;
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const t = 1 - c;

  // rotation matrix R column-major (3x3 embedded into the upper-left of 4x4)
  const r00 = x * x * t + c;
  const r01 = y * x * t + z * s;
  const r02 = z * x * t - y * s;
  const r10 = x * y * t - z * s;
  const r11 = y * y * t + c;
  const r12 = z * y * t + x * s;
  const r20 = x * z * t + y * s;
  const r21 = y * z * t - x * s;
  const r22 = z * z * t + c;

  // out = a * R (read a then write out; aliasing-safe)
  const a00 = a[0] as number;
  const a01 = a[1] as number;
  const a02 = a[2] as number;
  const a03 = a[3] as number;
  const a10 = a[4] as number;
  const a11 = a[5] as number;
  const a12 = a[6] as number;
  const a13 = a[7] as number;
  const a20 = a[8] as number;
  const a21 = a[9] as number;
  const a22 = a[10] as number;
  const a23 = a[11] as number;

  out[0] = a00 * r00 + a10 * r01 + a20 * r02;
  out[1] = a01 * r00 + a11 * r01 + a21 * r02;
  out[2] = a02 * r00 + a12 * r01 + a22 * r02;
  out[3] = a03 * r00 + a13 * r01 + a23 * r02;
  out[4] = a00 * r10 + a10 * r11 + a20 * r12;
  out[5] = a01 * r10 + a11 * r11 + a21 * r12;
  out[6] = a02 * r10 + a12 * r11 + a22 * r12;
  out[7] = a03 * r10 + a13 * r11 + a23 * r12;
  out[8] = a00 * r20 + a10 * r21 + a20 * r22;
  out[9] = a01 * r20 + a11 * r21 + a21 * r22;
  out[10] = a02 * r20 + a12 * r21 + a22 * r22;
  out[11] = a03 * r20 + a13 * r21 + a23 * r22;
  out[12] = a[12] as number;
  out[13] = a[13] as number;
  out[14] = a[14] as number;
  out[15] = a[15] as number;
  return out;
}

/**
 * out = view matrix lookAt(eye, target, up) (right-handed; camera looks toward -z at target).
 * Returns out.
 *
 * @degrade eye === target (distanceSq < EPS_NORMALIZE) → out = identity (D-P17, same convention as D-P1).
 * @degrade up collinear with the view direction (cross degenerate) → auto-select an alternative up
 *          (first (0,0,1), then (0,1,0)).
 *
 * @example
 * ```ts
 * mat4.lookAt(out, [0, 0, 5], [0, 0, 0], [0, 1, 0]);
 * // Guard: if (vec3.distanceSq(eye, target) < EPS_NORMALIZE) skip;
 * ```
 */
export function lookAt(out: Mat4, eye: Vec3Like, target: Vec3Like, up: Vec3Like): Mat4 {
  const ex = eye[0] as number;
  const ey = eye[1] as number;
  const ez = eye[2] as number;
  const tx = target[0] as number;
  const ty = target[1] as number;
  const tz = target[2] as number;
  const upx = up[0] as number;
  const upy = up[1] as number;
  const upz = up[2] as number;

  // forward = normalize(eye - target) (right-handed: camera looks toward -z, so the z axis = eye - target)
  let fx = ex - tx;
  let fy = ey - ty;
  let fz = ez - tz;
  const fLenSq = fx * fx + fy * fy + fz * fz;
  if (fLenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const fInv = 1 / Math.sqrt(fLenSq);
  fx *= fInv;
  fy *= fInv;
  fz *= fInv;

  // right = normalize(cross(up, forward))
  let rx = upy * fz - upz * fy;
  let ry = upz * fx - upx * fz;
  let rz = upx * fy - upy * fx;
  let rLenSq = rx * rx + ry * ry + rz * rz;
  if (rLenSq < EPS_NORMALIZE) {
    // up collinear with forward: pick alternative up = (0, 0, 1); if still collinear pick (0, 1, 0)
    rx = 0 * fz - 1 * fy;
    ry = 1 * fx - 0 * fz;
    rz = 0 * fy - 0 * fx;
    rLenSq = rx * rx + ry * ry + rz * rz;
    if (rLenSq < EPS_NORMALIZE) {
      rx = 0 * fz - 0 * fy;
      ry = 0 * fx - 1 * fz;
      rz = 1 * fy - 0 * fx;
      rLenSq = rx * rx + ry * ry + rz * rz;
    }
  }
  const rInv = 1 / Math.sqrt(rLenSq);
  rx *= rInv;
  ry *= rInv;
  rz *= rInv;

  // newUp = cross(forward, right)
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  // column-major: col0 = right, col1 = newUp, col2 = forward, col3 = -view * eye
  out[0] = rx;
  out[1] = ux;
  out[2] = fx;
  out[3] = 0;
  out[4] = ry;
  out[5] = uy;
  out[6] = fy;
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = fz;
  out[11] = 0;
  out[12] = -(rx * ex + ry * ey + rz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = -(fx * ex + fy * ey + fz * ez);
  out[15] = 1;
  return out;
}

/**
 * out = T(translation) * R(rotation) * S(scale) (TRS affine composition). Returns out.
 */
export function compose(out: Mat4, t: Vec3Like, r: QuatLike, s: Vec3Like): Mat4 {
  // build R (from quat) first, then scale each column, finally write translation
  const x = r[0] as number;
  const y = r[1] as number;
  const z = r[2] as number;
  const w = r[3] as number;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = s[0] as number;
  const sy = s[1] as number;
  const sz = s[2] as number;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = t[0] as number;
  out[13] = t[1] as number;
  out[14] = t[2] as number;
  out[15] = 1;
  return out;
}

/**
 * Decompose m into (translation, rotation quat, scale).
 *
 * @degrade m contains shear (non-pure affine) → silent best-effort decomposition (matches
 * Three.js behavior; does not throw).
 *
 * @example
 * ```ts
 * const t = vec3.create(); const r = quat.create(); const s = vec3.create();
 * mat4.decompose(t, r, s, m);
 * // Guard: callers should avoid introducing shear matrices at the ECS-design layer.
 * ```
 */
export function decompose(out_t: Vec3, out_r: Quat, out_s: Vec3, m: Mat4Like): void {
  // translation
  out_t[0] = m[12] as number;
  out_t[1] = m[13] as number;
  out_t[2] = m[14] as number;

  // length of each column = scale
  const sx = Math.hypot(m[0] as number, m[1] as number, m[2] as number);
  const sy = Math.hypot(m[4] as number, m[5] as number, m[6] as number);
  const sz = Math.hypot(m[8] as number, m[9] as number, m[10] as number);

  // handle the determinant sign: negative det → flip sx
  // simplified det check: use the upper-left 3x3 determinant
  const det =
    (m[0] as number) *
      ((m[5] as number) * (m[10] as number) - (m[6] as number) * (m[9] as number)) -
    (m[1] as number) *
      ((m[4] as number) * (m[10] as number) - (m[6] as number) * (m[8] as number)) +
    (m[2] as number) * ((m[4] as number) * (m[9] as number) - (m[5] as number) * (m[8] as number));
  const sxFinal = det < 0 ? -sx : sx;

  out_s[0] = sxFinal;
  out_s[1] = sy;
  out_s[2] = sz;

  // extract rotation: divide each column of m's upper-left 3x3 by scale to get the pure rotation matrix → convert to quat
  const invSx = sxFinal === 0 ? 0 : 1 / sxFinal;
  const invSy = sy === 0 ? 0 : 1 / sy;
  const invSz = sz === 0 ? 0 : 1 / sz;
  const r00 = (m[0] as number) * invSx;
  const r01 = (m[1] as number) * invSx;
  const r02 = (m[2] as number) * invSx;
  const r10 = (m[4] as number) * invSy;
  const r11 = (m[5] as number) * invSy;
  const r12 = (m[6] as number) * invSy;
  const r20 = (m[8] as number) * invSz;
  const r21 = (m[9] as number) * invSz;
  const r22 = (m[10] as number) * invSz;

  // rotation matrix → quat (Shoemake's method; case-split on the sign of trace)
  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out_r[0] = (r12 - r21) * s;
    out_r[1] = (r20 - r02) * s;
    out_r[2] = (r01 - r10) * s;
    out_r[3] = 0.25 / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    out_r[0] = 0.25 * s;
    out_r[1] = (r10 + r01) / s;
    out_r[2] = (r20 + r02) / s;
    out_r[3] = (r12 - r21) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    out_r[0] = (r10 + r01) / s;
    out_r[1] = 0.25 * s;
    out_r[2] = (r21 + r12) / s;
    out_r[3] = (r20 - r02) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    out_r[0] = (r20 + r02) / s;
    out_r[1] = (r21 + r12) / s;
    out_r[2] = 0.25 * s;
    out_r[3] = (r01 - r10) / s;
  }
}

/** out = 4x4 rotation matrix from quaternion (no translation, no scale). Returns out. */
export function fromQuat(out: Mat4, q: QuatLike): Mat4 {
  const x = q[0] as number;
  const y = q[1] as number;
  const z = q[2] as number;
  const w = q[3] as number;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;
  out[4] = xy - wz;
  out[5] = 1 - (xx + zz);
  out[6] = yz + wx;
  out[7] = 0;
  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - (xx + yy);
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** out = pure translation matrix (translation added to identity). Returns out. */
export function fromTranslation(out: Mat4, v: Vec3Like): Mat4 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = v[0] as number;
  out[13] = v[1] as number;
  out[14] = v[2] as number;
  out[15] = 1;
  return out;
}

/** out = pure scaling matrix diag(v.x, v.y, v.z, 1). Returns out. */
export function fromScaling(out: Mat4, v: Vec3Like): Mat4 {
  out[0] = v[0] as number;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = v[1] as number;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = v[2] as number;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/**
 * out = pure rotation matrix from axis-angle. Returns out.
 *
 * @degrade axis is the zero vector → out = identity (same convention as rotate).
 *
 * @example
 * ```ts
 * mat4.fromRotation(out, [0, 1, 0], Math.PI / 2);
 * mat4.fromRotation(out, [0, 0, 0], 1);  // → identity (zero-axis degenerate, AC-06 no throw)
 * ```
 */
export function fromRotation(out: Mat4, axis: Vec3Like, rad: number): Mat4 {
  let x = axis[0] as number;
  let y = axis[1] as number;
  let z = axis[2] as number;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const invLen = 1 / Math.sqrt(lenSq);
  x *= invLen;
  y *= invLen;
  z *= invLen;
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const t = 1 - c;
  out[0] = x * x * t + c;
  out[1] = y * x * t + z * s;
  out[2] = z * x * t - y * s;
  out[3] = 0;
  out[4] = x * y * t - z * s;
  out[5] = y * y * t + c;
  out[6] = z * y * t + x * s;
  out[7] = 0;
  out[8] = x * z * t + y * s;
  out[9] = y * z * t - x * s;
  out[10] = z * z * t + c;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

// ============================================================
// Projection family (T-022) — three perspective tiers + three orthographic tiers
// ============================================================
//
// Naming convention (D-3 + wiki/wgpu-matrix-overview / wiki/gl-matrix-overview):
//   `perspective` / `orthographic`             = WebGPU [0, 1] NDC (short names borrowed from wgpu-matrix)
//   `perspectiveNO` / `orthographicNO`         = WebGL/OpenGL [-1, 1] NDC (NO=Negative-One, borrowed from gl-matrix)
//   `perspectiveReverseZ` / `orthographicReverseZ` = reversed-Z (far→0, near→1; covers finite + infinite)
//
// AC-04 three projection tiers complete + AC-05 reversed-Z numeric fixture (error ≤ 1e-5)
// + AC-06 never raises (silent degrade).
// reversed-Z numeric correctness: see wiki/reversed-z-projection.md §7.2 / §7.3 / §7.4.

/**
 * out = perspective projection (**WebGPU [0, 1] NDC** short name, D-3). Returns out.
 *
 * Right-handed; z_eye negative values lie in the frustum; near → ndc_z=0, far → ndc_z=1.
 * Naming borrowed from wgpu-matrix (short name for WebGPU), unlike gl-matrix (short name for WebGL).
 * Supports both finite far and infinite far (far=Infinity, aligned with wgpu-matrix
 * `m[10]=-1, m[14]=-near`).
 *
 * @degrade near >= far or fovy <= 0 or aspect <= 0 → numerically undefined but does not throw
 * (plan §appendix A #7).
 *
 * @example
 * ```ts
 * mat4.perspective(out, Math.PI / 4, canvas.width / canvas.height, 0.1, 1000);
 * mat4.perspective(out, Math.PI / 4, aspect, 0.1, Infinity); // infinite-far trick
 * // Guard: if (!(near < far && fovy > 0 && aspect > 0)) handleInvalid();
 * ```
 */
export function perspective(
  out: Mat4,
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  out[0] = f / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = f;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[11] = -1;
  out[12] = 0;
  out[13] = 0;
  out[15] = 0;

  if (far === Number.POSITIVE_INFINITY) {
    // infinite-far trick (aligned with wgpu-matrix): m[10]=-1, m[14]=-near
    out[10] = -1;
    out[14] = -near;
  } else {
    const nf = 1 / (near - far);
    out[10] = far * nf;
    out[14] = far * near * nf;
  }
  return out;
}

/**
 * out = perspective projection (**WebGL/OpenGL [-1, 1] NDC**; *NO* = Negative-One, borrowed from gl-matrix).
 *
 * Right-handed, near → ndc_z=-1, far → ndc_z=+1.
 *
 * @degrade Same as perspective.
 *
 * @example
 * ```ts
 * mat4.perspectiveNO(out, Math.PI / 4, canvas.width / canvas.height, 0.1, 1000);
 * mat4.perspectiveNO(out, Math.PI / 4, aspect, 0.1, Infinity); // infinite-far
 * // Guard: if (!(near < far && fovy > 0 && aspect > 0)) handleInvalid();
 * ```
 */
export function perspectiveNO(
  out: Mat4,
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  out[0] = f / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = f;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[11] = -1;
  out[12] = 0;
  out[13] = 0;
  out[15] = 0;

  if (far === Number.POSITIVE_INFINITY) {
    out[10] = -1;
    out[14] = -2 * near;
  } else {
    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  }
  return out;
}

/**
 * out = reversed-Z perspective projection (**WebGPU [0, 1] NDC, near→1 far→0**). Returns out.
 *
 * Precision gain: matches the float dense region ([0, 0.01]) to the slowly-varying far end of 1/z.
 * Under the standard test conditions `near=0.1, far=10000`, NVIDIA reports a reversed-Z + float32
 * depth error rate of 0% (vs. high error rate for the standard mapping). See
 * `.forgeax-harness/knowledge-base/wiki/reversed-z-projection.md` §5.
 *
 * GPU-side companion switches (5 places must be flipped together):
 *   1. depthCompare: 'greater' (vs 'less')
 *   2. depthClearValue: 0.0 (vs 1.0)
 *   3. depth format: 'depth32float' (mandatory; fixed-point loses most of the gain)
 *   4. depth bias: inverted (avoid worsening z-fighting)
 *   5. multiple passes must share the reversed-Z convention
 *
 * Supports finite and infinite far (from wiki §3.3 / §4.2 derivations):
 *   - finite: m[10]=near/(far-near), m[14]=near*far/(far-near)
 *   - infinite (far=Infinity): m[10]=0, m[14]=near (lim f→∞ limit values)
 *
 * Numeric fixture (AC-05 error ≤ 1e-5): see __tests__/_fixtures.ts.
 *
 * @degrade Same as perspective.
 *
 * @example
 * ```ts
 * mat4.perspectiveReverseZ(out, Math.PI / 4, aspect, 0.1, 100);
 * mat4.perspectiveReverseZ(out, Math.PI / 4, aspect, 0.1, Infinity); // infinite far
 * // GPU companion: pipeline.depthCompare = 'greater'; passDesc.depthClearValue = 0.0;
 * ```
 */
export function perspectiveReverseZ(
  out: Mat4,
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  out[0] = f / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = f;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[11] = -1;
  out[12] = 0;
  out[13] = 0;
  out[15] = 0;

  if (far === Number.POSITIVE_INFINITY) {
    out[10] = 0;
    out[14] = near;
  } else {
    const fn = 1 / (far - near);
    out[10] = near * fn;
    out[14] = near * far * fn;
  }
  return out;
}

/**
 * out = orthographic projection (**WebGPU [0, 1] NDC** short name, D-3). Returns out.
 *
 * @degrade near >= far or left >= right or top <= bottom → numerically undefined but does not throw.
 *
 * @example
 * ```ts
 * mat4.orthographic(out, -10, 10, 10, -10, 0.1, 100);
 * // Guard: if (!(left < right && top > bottom && near < far)) handleInvalid();
 * ```
 */
export function orthographic(
  out: Mat4,
  left: number,
  right: number,
  top: number,
  bottom: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * bt;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = nf; // [0,1] NDC: near→0, far→1 → m[10] = 1/(near-far), m[14] = near/(near-far)
  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = near * nf;
  out[15] = 1;
  return out;
}

/** out = orthographic projection (**WebGL/OpenGL [-1, 1] NDC**, *NO*). Returns out. */
export function orthographicNO(
  out: Mat4,
  left: number,
  right: number,
  top: number,
  bottom: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * bt;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 2 * nf; // [-1,1] NDC: near→-1, far→1
  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = (near + far) * nf;
  out[15] = 1;
  return out;
}

/**
 * out = reversed-Z orthographic projection (**WebGPU [0, 1] NDC, near→1 far→0**;
 * D-P3 self-extension).
 *
 * Pairs with perspectiveReverseZ to form a symmetric three-tier surface; in orthographic
 * projection the reversed-Z precision gain is small (ortho is linear in z), but it is kept to
 * avoid LLM single-pass-scan cognitive load (charter proposition 1).
 * Note: this function is an @forgeax/engine-math self-extension; wgpu-matrix / gl-matrix have no matching
 * name (see plan-strategy D-P3 + README quick-ref table footnote).
 */
export function orthographicReverseZ(
  out: Mat4,
  left: number,
  right: number,
  top: number,
  bottom: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const fn = 1 / (far - near); // reversed-Z [0,1]: near→1, far→0
  out[0] = -2 * lr;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * bt;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  // Derivation: -m[10]*near + m[14] = 1, -m[10]*far + m[14] = 0
  //   → m[10] = 1/(far-near), m[14] = far/(far-near)
  out[10] = fn;
  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = far * fn;
  out[15] = 1;
  return out;
}

// ============================================================
// Transform reverse surface (M1 / t6) — mat4 → vec3 cross-type transforms
// ============================================================
//
// 3 functions / +3 surface (mat4 23 → 26 / total 115 → 119, AC-03):
//   - transformVec3: (x, y, z, 1) multiplied by 4×4 + perspective divide + w'=0 explicit guard (D-4 silent)
//   - transformPoint: ES alias of transformVec3 (OQ-1 / S-1, saves 16 LOC)
//   - transformDirection: takes m's upper-left 3×3 (no translation column) + vec3.normalize (OQ-2 / S-2)
//
// Degenerate convention (D-4 library-wide silent fall-back):
//   - transformVec3 / transformPoint: w' = 0 (perspective divide by zero) → out = (0, 0, 0)
//   - transformDirection: |out| = 0 → vec3.normalize silently falls back to (0, 0, 0)
//
// Related: requirements §3.1 mat4 rows 1/2/3 + §11 surface full table mat4 23→26;
//          research Finding 1 (alias evidence) + Finding 2 (take 3×3 + normalize) +
//          Finding 4 (w'=0 explicit guard stricter than upstreams);
//          plan-strategy §2 S-1 / S-2 + §3 R-1 countermeasure + §6 M1 scope section.

/**
 * out = M * (v.x, v.y, v.z, 1) (with perspective divide by w'). Returns out.
 *
 * For affine m this is equivalent to transformPoint (treats v as a "position" that participates
 * in the transform, including translation).
 * Aliasing-safe: reads v.xyz into locals before writing out.
 *
 * @degrade w' = 0 (perspective divide by zero) → out = (0, 0, 0) (D-4 silent convention; avoids
 *          NaN/Infinity propagation; stricter than the implicit 1/0 = Infinity behavior of
 *          Three.js / gl-matrix).
 *
 * @example
 * ```ts
 * mat4.transformVec3(out, projViewModel, v);
 * // Guard: if (out[0] === 0 && out[1] === 0 && out[2] === 0 && wasNonZero(v)) {
 * //   // w'=0 degenerate branch; the caller diagnoses as needed
 * // }
 * ```
 */
export function transformVec3(out: Vec3, m: Mat4Like, v: Vec3Like): Vec3 {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  const m00 = m[0] as number;
  const m01 = m[1] as number;
  const m02 = m[2] as number;
  const m03 = m[3] as number;
  const m10 = m[4] as number;
  const m11 = m[5] as number;
  const m12 = m[6] as number;
  const m13 = m[7] as number;
  const m20 = m[8] as number;
  const m21 = m[9] as number;
  const m22 = m[10] as number;
  const m23 = m[11] as number;
  const m30 = m[12] as number;
  const m31 = m[13] as number;
  const m32 = m[14] as number;
  const m33 = m[15] as number;

  const w = m03 * x + m13 * y + m23 * z + m33;
  if (w === 0) {
    // D-4 silent convention: perspective divide by zero → (0, 0, 0)
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const invW = 1 / w;
  out[0] = (m00 * x + m10 * y + m20 * z + m30) * invW;
  out[1] = (m01 * x + m11 * y + m21 * z + m31) * invW;
  out[2] = (m02 * x + m12 * y + m22 * z + m32) * invW;
  return out;
}

/**
 * out = M * (v.x, v.y, v.z, 1) (with perspective divide by w'). Returns out.
 *
 * Treats v as a "position", including the translation column (shares the same function body as
 * transformVec3; OQ-1 / S-1).
 * Aliasing-safe; reference-equal with transformVec3: `mat4.transformPoint === mat4.transformVec3`.
 *
 * @degrade w' = 0 (perspective divide by zero) → out = (0, 0, 0) (D-4 silent convention;
 *          same as transformVec3).
 *
 * @example
 * ```ts
 * mat4.transformPoint(out, modelMatrix, [1, 2, 3]);
 * // (1,2,3) → world-space position, including translation
 * ```
 */
export const transformPoint = transformVec3;

/**
 * out = normalize(M_3x3 * v) (uses m's upper-left 3×3, no translation column). Returns out.
 *
 * Treats v as a "direction" and does **not** apply translation; the result is unit-normalized via
 * `vec3.normalize` (OQ-2 / S-2).
 * Aliasing-safe: reads v.xyz into locals before writing out.
 *
 * @degrade |out| = 0 (singular m + arbitrary v / m_3x3 maps v to the zero vector) → vec3.normalize
 *          silently falls back to (0, 0, 0) (library-wide D-4 convention).
 *
 * @example
 * ```ts
 * const worldNormal = vec3.create();
 * mat4.transformDirection(worldNormal, modelMatrix, localNormal);
 * // Normal-vector transform: ignores translation; a unit-length input + orthogonal matrix
 * // guarantees a unit-length output.
 * ```
 */
export function transformDirection(out: Vec3, m: Mat4Like, v: Vec3Like): Vec3 {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  const m00 = m[0] as number;
  const m01 = m[1] as number;
  const m02 = m[2] as number;
  const m10 = m[4] as number;
  const m11 = m[5] as number;
  const m12 = m[6] as number;
  const m20 = m[8] as number;
  const m21 = m[9] as number;
  const m22 = m[10] as number;
  out[0] = m00 * x + m10 * y + m20 * z;
  out[1] = m01 * x + m11 * y + m21 * z;
  out[2] = m02 * x + m12 * y + m22 * z;
  // S-2: reuse vec3.normalize's silent convention (|out|=0 → out=(0,0,0)); do not inline copy.
  return vec3.normalize(out, out);
}

// ============================================================
// world-mat4 basis / translation accessors
// (feat-20260601-unify-transform-local-global-mat4-drop-globaltrans M1 w6)
// ============================================================
//
// Decompose a world-space mat4 into its translation + the three orthonormal
// basis directions. Placed adjacent to transformDirection because they share
// the same normalization convention (vec3.normalize's |out|=0 → (0,0,0) D-4
// fallback). The Transform world column (array<f32, 16>) is the producer; the
// audio listener / camera-orientation consumers read forward/up via these.
//
// Layout (column-major, m[col*4 + row]):
//   col0 = m[0..2]  = right   col1 = m[4..6]  = up
//   col2 = m[8..10] = forward col3 = m[12..14] = translation
//
// Sign (RL-4): getForward returns -normalize(col2) so it aligns with the
// historical single-quaternion oracle quat.transformVec3(q, (0, 0, -1)) -- a
// camera/listener looking down -Z in its local frame.

/**
 * World-space translation = col 3 (m[12], m[13], m[14]). Read verbatim, not
 * normalized (translation has magnitude).
 */
export function getTranslation(out: Vec3, m: Mat4Like): Vec3 {
  out[0] = m[12] as number;
  out[1] = m[13] as number;
  out[2] = m[14] as number;
  return out;
}

/**
 * World-space forward = `-normalize(col2)` (RL-4: -Z look convention; matches
 * `quat.transformVec3(q, [0, 0, -1])`). Degenerate zero column → (0,0,0).
 */
export function getForward(out: Vec3, m: Mat4Like): Vec3 {
  out[0] = -(m[8] as number);
  out[1] = -(m[9] as number);
  out[2] = -(m[10] as number);
  return vec3.normalize(out, out);
}

/** World-space up = `normalize(col1)`. Degenerate zero column → (0,0,0). */
export function getUp(out: Vec3, m: Mat4Like): Vec3 {
  out[0] = m[4] as number;
  out[1] = m[5] as number;
  out[2] = m[6] as number;
  return vec3.normalize(out, out);
}

/** World-space right = `normalize(col0)`. Degenerate zero column → (0,0,0). */
export function getRight(out: Vec3, m: Mat4Like): Vec3 {
  out[0] = m[0] as number;
  out[1] = m[1] as number;
  out[2] = m[2] as number;
  return vec3.normalize(out, out);
}

// ============================================================
// unproject (feat-20260529-picking-raycasting-screen-to-entity M2 w7)
// ============================================================
//
// Map an NDC point back to world space via the inverse view-projection matrix.
// Internally constructs vec4 (ndc.x, ndc.y, ndc.z, 1) and delegates to transformVec3,
// which performs the 4×4 multiply + perspective divide by w'.
//
// WebGPU [0,1] NDC z convention (D-NDC / research Finding 6):
//   near plane → z=0, far plane → z=1
//
// Related: plan-tasks.json w7; requirements in-scope #3;
//          research Finding 3 (transformVec3 built-in w-divide).

/**
 * Unproject an NDC point to world space.
 *
 * `ndcPoint` is in NDC space: x,y ∈ [-1,1], z ∈ [0,1] (WebGPU convention).
 * `invVP` is the inverse of the view-projection matrix.
 *
 * @example
 * ```ts
 * const worldPoint = vec3.create();
 * mat4.unproject(worldPoint, [0, 0, 0], invVP); // near-plane centre → world
 * mat4.unproject(worldPoint, [0, 0, 1], invVP); // far-plane centre → world
 * ```
 */
export function unproject(out: Vec3, ndcPoint: Vec3Like, invVP: Mat4Like): Vec3 {
  return transformVec3(out, invVP, ndcPoint);
}

// ============================================================
// projectPoint — world → NDC dual of unproject
// (roadmap 2026-06-15 game-demo-engine-gaps G-4: HUD anchor / worldToScreen)
// ============================================================
//
// Map a world-space point to NDC via the view-projection matrix. Caller maps
// NDC.xy ∈ [-1,1] to viewport pixels (DOM y-down → flip y), and inspects NDC.z
// for "behind camera" / "outside far plane" culling.
//
// Pairs with unproject (NDC → world); both are intent-revealing aliases of
// transformVec3 + perspective divide (D-4 silent w'=0 → out=(0,0,0) inherited).

/**
 * Project a world-space point to NDC space through a view-projection matrix.
 *
 * `worldPos` is a position (treated with translation column, not a direction).
 * `viewProj` is `proj × view` (eye→clip composed with world→eye).
 * Output NDC is WebGPU convention: x,y ∈ [-1,1], z ∈ [0,1] (near=0 / far=1).
 *
 * To map NDC to viewport pixels (DOM y-down):
 *   px = (ndc.x * 0.5 + 0.5) * vpWidth
 *   py = (1 - (ndc.y * 0.5 + 0.5)) * vpHeight
 * `ndc.z < 0` or `ndc.z > 1` means the point is outside the depth range
 * (behind near or beyond far); callers typically skip drawing the HUD anchor.
 *
 * @degrade w' = 0 (point lies on the camera plane) → out = (0, 0, 0)
 *          (D-4 silent convention; inherited from transformVec3).
 *
 * @example
 * ```ts
 * const ndc = vec3.create();
 * mat4.projectPoint(ndc, worldPos, viewProj);
 * if (ndc[2] >= 0 && ndc[2] <= 1) {
 *   const px = (ndc[0] * 0.5 + 0.5) * canvas.width;
 *   const py = (1 - (ndc[1] * 0.5 + 0.5)) * canvas.height;
 *   // anchor DOM tooltip at (px, py)
 * }
 * ```
 */
export function projectPoint(out: Vec3, worldPos: Vec3Like, viewProj: Mat4Like): Vec3 {
  return transformVec3(out, viewProj, worldPos);
}

// ============================================================
// computeViewProj (feat-20260617-host-engine-contract-and-video-cutscene M2 w6)
// ============================================================
//
// Convenience composition: out = perspective(fov,aspect,near,far) * lookAt(eye,target,up).
// Plain numeric / Vec3Like params only — keeps math zero-dep (plan-strategy D-1).
//
// Related: requirements AC-03; plan-strategy D-1; research Finding 4.

/**
 * Compute a combined view-projection matrix from camera parameters.
 *
 * This is a convenience composition of `mat4.perspective * mat4.lookAt`, not a primitive.
 * All parameters are plain numbers / Vec3Like — no runtime POD types (math zero-dep).
 *
 * @param out Mat4 to write the result into.
 * @param eye Camera position in world space.
 * @param target Point the camera looks at.
 * @param up Approximate up direction.
 * @param fovYRadians Vertical field of view in radians.
 * @param aspect Aspect ratio (width / height).
 * @param near Near clip distance (positive).
 * @param far Far clip distance (positive, or Infinity for infinite-far).
 * @returns `out` (same Mat4 instance).
 */
export function computeViewProj(
  out: Mat4,
  eye: Vec3Like,
  target: Vec3Like,
  up: Vec3Like,
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const view = lookAt(create(), eye, target, up);
  const proj = perspective(create(), fovYRadians, aspect, near, far);
  return multiply(out, proj, view);
}
