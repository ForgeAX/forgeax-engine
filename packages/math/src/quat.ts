// quat.ts — quaternion namespace (M4 / T-027)
//
// 23-function surface (≥ 16 lower bound):
//   create / clone / identity / fromAxisAngle / fromEuler / fromRotationMatrix /
//   fromLookAt / fromUnitVectors / multiply / rotateAxis / slerp / nlerp / invert /
//   conjugate / dot / length / lengthSq / transformVec3 / normalize / eulerY /
//   right / up / forward
//
// Memory layout lock: Float32Array length 4 [x, y, z, w], **Hamilton convention**
// (graphics mainstream: glm / Three.js / wgpu-matrix / DirectXMath / glam are all Hamilton (x,y,z,w)).
// Identity = [0, 0, 0, 1].
//
// Degenerate convention (plan-strategy §appendix A degenerate registry #8-#13):
//   - fromAxisAngle(0-axis, _) → identity (same convention as the M2 baseline)
//   - fromEuler(x, y, z, 'unknown') → silent fallback to 'XYZ' (D-P2 + AC-06 no throw)
//   - slerp(a, b, t) when dot(a,b) < -EPS_SLERP_DOT_LIMIT → negate b then slerp normally (D-P6)
//   - slerp(a, b, t) when |dot| > 1 - EPS_SLERP_DOT_LIMIT → falls back to nlerp (avoids acos blow-up)
//   - fromUnitVectors(v, -v) → pick perpendicular axis (prefer (0,1,0); fall back to (1,0,0) if
//                              collinear with v) and 180° rotation (D-P18)
//   - fromUnitVectors(v, v) → identity
//   - normalize(zero quat) → out = zero (same convention as vec.normalize)
//
// Four ironclad rules (gl-matrix wiki / research §F1):
//   1. Out-param first; 2. Aliasing-safe; 3. Module-as-namespace; 4. Float32Array by default.
//
// Related: requirements §Surface quat lower bound 16 + AC-06 no throw + AC-08 naming alignment +
//          AC-01 brand + boundary-case quat row;
//          plan-strategy §6 M4 + D-P2/D-P6/D-P18 + §appendix A degenerate registry #8-#13;
//          research §Finding 3 glam Hamilton + §fact-correction 4 fromEuler unknown silenced;
//          wiki/gl-matrix-overview §quat degenerate anchor + wiki/glam-rs-overview §Hamilton +
//          wiki/wgpu-matrix-overview §quat namespace.
//
// Degenerate-semantics registry (plan-strategy.md §appendix A; shares numbering with mat;
// D-P16 dual promise: runtime silent + JSDoc `@degrade` + `@example` guard pattern landing together):
//   #8  quat.fromAxisAngle(0-axis, _)              → out = identity
//   #9  quat.fromEuler(_, _, _, unknown)           → silently computes as 'XYZ' (D-P2)
//   #10 quat.slerp(a, b, t) dot < -1+ε            → negate b then slerp (D-P6)
//   #11 quat.slerp(a, b, t) |dot| > 1-ε           → falls back to nlerp
//   #12 quat.fromUnitVectors(v, -v)                → perpendicular-axis 180° rotation (D-P18)
//   #13 quat.fromUnitVectors(v, v)                 → out = identity

import { EPS_NORMALIZE, EPS_QUAT_PARALLEL, EPS_SLERP_DOT_LIMIT } from './_internal/epsilon';
import { lengthSq4, normalize4 } from './_internal/scalar';
import type { EulerOrder, Mat3Like, Quat, QuatLike, Vec3, Vec3Like } from './types';

export type { Quat, QuatLike };

// Canonical axes for the local-basis accessors (right / up / forward). −Z is the
// forward convention (RL-4), matching mat4.getForward and fromLookAt.
const UNIT_X = [1, 0, 0] as const;
const UNIT_Y = [0, 1, 0] as const;
const UNIT_NEG_Z = [0, 0, -1] as const;

/** Create a Quat (default all zero; callers usually call identity() right after). */
export function create(): Quat {
  return new Float32Array(4) as Quat;
}

/** Allocate a new Quat copy. */
export function clone(a: QuatLike): Quat {
  return Float32Array.of(a[0] as number, a[1] as number, a[2] as number, a[3] as number) as Quat;
}

/** out = identity quaternion [0, 0, 0, 1]. Returns out. */
export function identity(out: Quat): Quat {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  return out;
}

/**
 * out = quaternion representing rotation by angleRadians around axis. Returns out.
 *
 * axis does not have to be pre-normalized; this function normalizes it internally.
 *
 * @degrade axis is the zero vector (lengthSq < EPS_NORMALIZE) → out = identity
 * (no throw, registry #8).
 *
 * @example
 * ```ts
 * quat.fromAxisAngle(out, [0, 1, 0], Math.PI / 2);
 * // Guard: if (vec3.lengthSq(axis) < EPS_NORMALIZE) skip;
 * ```
 */
export function fromAxisAngle(out: Quat, axis: Vec3Like, angleRadians: number): Quat {
  const ax = axis[0] as number;
  const ay = axis[1] as number;
  const az = axis[2] as number;
  const lenSq = ax * ax + ay * ay + az * az;
  if (lenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const inv = 1 / Math.sqrt(lenSq);
  const half = angleRadians / 2;
  const s = Math.sin(half);
  out[0] = ax * inv * s;
  out[1] = ay * inv * s;
  out[2] = az * inv * s;
  out[3] = Math.cos(half);
  return out;
}

/**
 * out = quaternion from intrinsic Euler angles (x, y, z, order). Returns out.
 *
 * Angle unit = **radians** (aligned with wgpu-matrix / Three.js; research §fact-correction 4
 * deviates from gl-matrix's degrees).
 * 6 orders: XYZ / YXZ / ZXY / ZYX / YZX / XZY (intrinsic rotation: literal order x → y → z).
 * Implementation: split each axis rotation into single-axis quaternions, then Hamilton-multiply
 * in `order`.
 *
 * @degrade order outside the EulerOrder union (only possible via `as any` cast) →
 *          **silently computes as if 'XYZ'** (D-P2 + AC-06 no throw; registry #9).
 *
 * @example
 * ```ts
 * quat.fromEuler(out, 0.5, 0.3, 0.1, 'XYZ');
 * quat.fromEuler(out, 0.5, 0.3, 0.1, 'unknown' as any); // silently computed as 'XYZ'
 * // Guard: pass an EulerOrder union literal; the TS layer already blocks unknown strings.
 * ```
 */
export function fromEuler(out: Quat, x: number, y: number, z: number, order: EulerOrder): Quat {
  // Single-axis half-angle quat coefficients
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  // Formulas from Three.js Quaternion.setFromEuler (intrinsic rotation, Hamilton convention).
  // 6 orders dispatched via switch; unknown silently falls back to XYZ (D-P2).
  switch (order) {
    case 'XYZ':
      out[0] = s1 * c2 * c3 + c1 * s2 * s3;
      out[1] = c1 * s2 * c3 - s1 * c2 * s3;
      out[2] = c1 * c2 * s3 + s1 * s2 * c3;
      out[3] = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'YXZ':
      out[0] = s1 * c2 * c3 + c1 * s2 * s3;
      out[1] = c1 * s2 * c3 - s1 * c2 * s3;
      out[2] = c1 * c2 * s3 - s1 * s2 * c3;
      out[3] = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case 'ZXY':
      out[0] = s1 * c2 * c3 - c1 * s2 * s3;
      out[1] = c1 * s2 * c3 + s1 * c2 * s3;
      out[2] = c1 * c2 * s3 + s1 * s2 * c3;
      out[3] = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'ZYX':
      out[0] = s1 * c2 * c3 - c1 * s2 * s3;
      out[1] = c1 * s2 * c3 + s1 * c2 * s3;
      out[2] = c1 * c2 * s3 - s1 * s2 * c3;
      out[3] = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case 'YZX':
      out[0] = s1 * c2 * c3 + c1 * s2 * s3;
      out[1] = c1 * s2 * c3 + s1 * c2 * s3;
      out[2] = c1 * c2 * s3 - s1 * s2 * c3;
      out[3] = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case 'XZY':
      out[0] = s1 * c2 * c3 - c1 * s2 * s3;
      out[1] = c1 * s2 * c3 - s1 * c2 * s3;
      out[2] = c1 * c2 * s3 + s1 * s2 * c3;
      out[3] = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    default:
      // D-P2 + AC-06: unknown order silently falls back to 'XYZ' (no throw, no console.warn).
      out[0] = s1 * c2 * c3 + c1 * s2 * s3;
      out[1] = c1 * s2 * c3 - s1 * c2 * s3;
      out[2] = c1 * c2 * s3 + s1 * s2 * c3;
      out[3] = c1 * c2 * c3 - s1 * s2 * s3;
      break;
  }
  return out;
}

/**
 * out = quaternion from a 3x3 rotation matrix m (column-major, length 9). Returns out.
 *
 * Implementation: Shepperd's case-split (branch on trace / largest diagonal entry); numerically
 * more stable than the direct trace method (avoids sqrt(0) when trace ≈ -1).
 *
 * Assumption: m is a pure rotation matrix (|det|=1, columns orthogonal). If not, the result is
 * undefined but does not throw.
 *
 * @degrade m is not a pure rotation (contains shear / scale) → numerically undefined but does
 *          not throw (AC-06 no throw; callers should normalize column vectors first or avoid
 *          introducing non-pure-rotation matrices at the ECS-design layer).
 *
 * @example
 * ```ts
 * quat.fromRotationMatrix(out, mat3InstanceColumnMajor);
 * ```
 */
export function fromRotationMatrix(out: Quat, m: Mat3Like): Quat {
  const m00 = m[0] as number;
  const m01 = m[1] as number;
  const m02 = m[2] as number;
  const m10 = m[3] as number;
  const m11 = m[4] as number;
  const m12 = m[5] as number;
  const m20 = m[6] as number;
  const m21 = m[7] as number;
  const m22 = m[8] as number;

  // m is column-major: m[col*3+row] → m00 is col=0,row=0; m01 is col=0,row=1.
  // Rotation matrix R[row][col]:
  //   R[0][0]=m00, R[1][0]=m01, R[2][0]=m02
  //   R[0][1]=m10, R[1][1]=m11, R[2][1]=m12
  //   R[0][2]=m20, R[1][2]=m21, R[2][2]=m22
  // Shepperd's formulas use R[i][j]; here the column-major indices are equivalent:
  //   trace = R[0][0]+R[1][1]+R[2][2] = m00+m11+m22
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[0] = (m12 - m21) * s; // (R[2][1] - R[1][2])
    out[1] = (m20 - m02) * s; // (R[0][2] - R[2][0])
    out[2] = (m01 - m10) * s; // (R[1][0] - R[0][1])
    out[3] = 0.25 / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[0] = 0.25 * s;
    out[1] = (m10 + m01) / s;
    out[2] = (m20 + m02) / s;
    out[3] = (m12 - m21) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[0] = (m10 + m01) / s;
    out[1] = 0.25 * s;
    out[2] = (m21 + m12) / s;
    out[3] = (m20 - m02) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[0] = (m20 + m02) / s;
    out[1] = (m21 + m12) / s;
    out[2] = 0.25 * s;
    out[3] = (m01 - m10) / s;
  }
  return out;
}

/**
 * out = orientation quaternion for an object placed at `eye` and facing `target`. Returns out.
 *
 * This is the ergonomic camera/look-at helper: it yields the WORLD-space orientation an entity's
 * Transform.rotation needs so that its local -z axis points from `eye` toward `target` (the camera
 * convention, matching `mat4.lookAt`). Use it instead of hand-wiring
 * `mat4.lookAt → mat4.invert → mat3.fromMat4 → quat.fromRotationMatrix`; that chain is easy to get
 * wrong (notably `fromRotationMatrix` takes a mat3, but `Mat4Like`≡`Mat3Like`≡`ArrayLike<number>`,
 * so passing a mat4 typechecks and silently reads garbage → NaN → nothing renders).
 *
 * Convenience composition (like `mat4.computeViewProj`), not a primitive: it builds the same
 * right/newUp/forward basis as `mat4.lookAt` and reuses `fromRotationMatrix` for the extraction.
 *
 * @degrade eye ≈ target (|eye-target| < EPS_NORMALIZE) → out = identity (same convention as
 *          `mat4.lookAt` degenerate #4; no throw, AC-06).
 * @degrade up collinear with the view direction → alternative up auto-selected (same as
 *          `mat4.lookAt` #5).
 *
 * @example
 * ```ts
 * // aim a camera at the origin
 * const q = quat.fromLookAt(quat.create(), [-2.5, 4.5, 9], [0, 0, 0], [0, 1, 0]);
 * world.set(cameraEntity, Transform, { pos: [-2.5, 4.5, 9], rot: q });
 * ```
 */
export function fromLookAt(out: Quat, eye: Vec3Like, target: Vec3Like, up: Vec3Like): Quat {
  const ex = eye[0] as number;
  const ey = eye[1] as number;
  const ez = eye[2] as number;

  // forward = normalize(eye - target): the object's local -z points at the target, so +z = eye - target
  // (right-handed camera convention, identical to mat4.lookAt).
  let fx = ex - (target[0] as number);
  let fy = ey - (target[1] as number);
  let fz = ez - (target[2] as number);
  const fLenSq = fx * fx + fy * fy + fz * fz;
  if (fLenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const fInv = 1 / Math.sqrt(fLenSq);
  fx *= fInv;
  fy *= fInv;
  fz *= fInv;

  const upx = up[0] as number;
  const upy = up[1] as number;
  const upz = up[2] as number;

  // right = normalize(cross(up, forward)); degrade path mirrors mat4.lookAt (#5 alternative up).
  let rx = upy * fz - upz * fy;
  let ry = upz * fx - upx * fz;
  let rz = upx * fy - upy * fx;
  let rLenSq = rx * rx + ry * ry + rz * rz;
  if (rLenSq < EPS_NORMALIZE) {
    // up collinear with forward: pick alternative up = (0, 0, 1); if still collinear pick (0, 1, 0)
    rx = -fy;
    ry = fx;
    rz = 0;
    rLenSq = rx * rx + ry * ry + rz * rz;
    if (rLenSq < EPS_NORMALIZE) {
      rx = 0;
      ry = -fz;
      rz = fy;
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

  // World rotation columns are the basis vectors themselves (col0=right, col1=up, col2=forward) —
  // this is the transpose of mat4.lookAt's view rotation, i.e. the camera's world orientation.
  // Pack column-major into a length-9 mat3 for fromRotationMatrix (SSOT for the Shepperd extraction).
  // Per-call alloc mirrors mat4.computeViewProj's convenience-composition grain (camera orientation
  // is set rarely; no module-scoped mutable state to reason about).
  const m3 = new Float32Array(9);
  m3[0] = rx;
  m3[1] = ry;
  m3[2] = rz;
  m3[3] = ux;
  m3[4] = uy;
  m3[5] = uz;
  m3[6] = fx;
  m3[7] = fy;
  m3[8] = fz;
  return fromRotationMatrix(out, m3);
}

/**
 * out = quaternion that rotates the unit vector v to w (shortest arc). Returns out.
 *
 * Assumes v and w are normalized; if not, the caller is responsible.
 *
 * @degrade v ≈ w (dot > 1 - EPS_QUAT_PARALLEL) → out = identity (registry #13).
 * @degrade v ≈ -w (dot < -1 + EPS_QUAT_PARALLEL) → pick a perpendicular axis and do a 180°
 *          rotation (prefer (0,1,0); fall back to (1,0,0) when collinear with v;
 *          registry #12 + D-P18).
 *
 * @example
 * ```ts
 * quat.fromUnitVectors(out, [1,0,0], [0,1,0]); // 90° around Z
 * quat.fromUnitVectors(out, [1,0,0], [-1,0,0]); // 180° opposite: pick (0,1,0) axis
 * ```
 */
export function fromUnitVectors(out: Quat, v: Vec3Like, w: Vec3Like): Quat {
  const vx = v[0] as number;
  const vy = v[1] as number;
  const vz = v[2] as number;
  const wx = w[0] as number;
  const wy = w[1] as number;
  const wz = w[2] as number;

  const d = vx * wx + vy * wy + vz * wz;

  if (d > 1 - EPS_QUAT_PARALLEL) {
    // same direction: identity
    return identity(out);
  }

  if (d < -1 + EPS_QUAT_PARALLEL) {
    // opposite direction: pick a perpendicular axis (D-P18).
    // Prefer (0, 1, 0); when v is collinear with (0, 1, 0) (|vy| ~ 1) fall back to (1, 0, 0).
    let ax: number;
    let ay: number;
    let az: number;
    if (Math.abs(vy) < 1 - EPS_QUAT_PARALLEL) {
      // axis = normalize(cross(v, (0, 1, 0)))
      ax = -vz;
      ay = 0;
      az = vx;
    } else {
      // v is collinear with (0, 1, 0) → use (1, 0, 0)
      // axis = normalize(cross(v, (1, 0, 0)))
      ax = 0;
      ay = vz;
      az = -vy;
    }
    const axLen = Math.sqrt(ax * ax + ay * ay + az * az);
    if (axLen < EPS_NORMALIZE) {
      // extreme safety net (theoretically unreachable): write identity, no throw
      return identity(out);
    }
    const axInv = 1 / axLen;
    out[0] = ax * axInv;
    out[1] = ay * axInv;
    out[2] = az * axInv;
    out[3] = 0; // cos(PI/2) = 0
    return out;
  }

  // General case: half-vector method (numerically stable; consensus of wgpu-matrix / Three.js)
  // q = (cross(v, w), 1 + dot(v, w)), then normalize
  const cx = vy * wz - vz * wy;
  const cy = vz * wx - vx * wz;
  const cz = vx * wy - vy * wx;
  const sw = 1 + d;
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz + sw * sw);
  const inv = 1 / len;
  out[0] = cx * inv;
  out[1] = cy * inv;
  out[2] = cz * inv;
  out[3] = sw * inv;
  return out;
}

/**
 * out = a * b (Hamilton product). Returns out.
 *
 * Aliasing-safe: reads all 8 source elements into locals first.
 */
export function multiply(out: Quat, a: QuatLike, b: QuatLike): Quat {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * out = the orientation `q` after rotating a further `angleRadians` about world-space `axis`,
 * re-normalized. Returns out.
 *
 * This is the ergonomic *incremental rotate* helper — the per-frame spin/animation move. It folds
 * the three steps every rotating demo otherwise hand-wires: build the delta quaternion
 * (`fromAxisAngle`), **pre**-multiply it onto the current orientation (world-space axis, matching
 * **Bevy `Transform::rotate(r)` = `r * self.rotation`** / `rotate_y(θ)`), and — the step that is
 * silently omitted and makes the naive loop wrong — **normalize** to shed the floating-point error
 * that accumulates over thousands of frames into a non-unit quaternion (skew / scale artefacts).
 *
 * Prefer this over hand-writing `quat.multiply(q, delta, q)` in an update system: that loop drifts,
 * so demos work around it with an absolute-angle accumulator + `fromAxisAngle` (can't compose onto an
 * existing orientation) or raw `sin/cos` quaternion literals. `rotateAxis` composes safely.
 *
 * Convenience composition (like `fromLookAt`), not a primitive: same result as
 * `normalize(out, multiply(out, fromAxisAngle(tmp, axis, angleRadians), q))`, fused + aliasing-safe.
 *
 * @degrade `axis` zero-length → the delta is identity (degenerate registry #8), so out = normalize(q)
 *          (no rotation applied; no throw, consistent with the sibling helpers).
 *
 * @example
 * ```ts
 * // in an Update system: spin a cube about +Y at `speed` rad/s using the frame delta
 * const dt = world.getResource(Time).delta;
 * const t = world.get(entity, Transform).unwrap();
 * quat.rotateAxis(t.quat, t.quat, [0, 1, 0], speed * dt); // in-place accumulate, no drift
 * world.set(entity, Transform, t);
 * ```
 */
export function rotateAxis(out: Quat, q: QuatLike, axis: Vec3Like, angleRadians: number): Quat {
  // Read q into locals first (aliasing-safe: rotateAxis(q, q, ...) is the common per-frame call).
  const qx = q[0] as number;
  const qy = q[1] as number;
  const qz = q[2] as number;
  const qw = q[3] as number;

  // Delta quaternion for `angleRadians` about `axis` (fromAxisAngle inline; 0-axis → identity, #8).
  const ax = axis[0] as number;
  const ay = axis[1] as number;
  const az = axis[2] as number;
  const axisLen = Math.sqrt(ax * ax + ay * ay + az * az);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let dw = 1;
  if (axisLen >= EPS_NORMALIZE) {
    const half = angleRadians * 0.5;
    const s = Math.sin(half) / axisLen;
    dx = ax * s;
    dy = ay * s;
    dz = az * s;
    dw = Math.cos(half);
  }

  // Pre-multiply: out = delta * q (world-space axis; matches Bevy Transform::rotate order).
  let rx = dw * qx + dx * qw + dy * qz - dz * qy;
  let ry = dw * qy - dx * qz + dy * qw + dz * qx;
  let rz = dw * qz + dx * qy - dy * qx + dz * qw;
  let rw = dw * qw - dx * qx - dy * qy - dz * qz;

  // Normalize to kill accumulation drift (the whole point of this helper).
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
  if (len >= EPS_NORMALIZE) {
    const inv = 1 / len;
    rx *= inv;
    ry *= inv;
    rz *= inv;
    rw *= inv;
  }
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  out[3] = rw;
  return out;
}

/**
 * out = spherical linear interpolation(a, b, t). Returns out.
 *
 * t is not clamped (extrapolation semantics matches vec.lerp).
 *
 * @degrade dot(a, b) < -EPS_SLERP_DOT_LIMIT (anti-parallel) → **negate b' = -b then slerp**
 *          (D-P6; q and -q represent the same rotation; registry #10).
 * @degrade |dot(a, b)| > 1 - EPS_SLERP_DOT_LIMIT (endpoint coincidence or near-coincidence) →
 *          falls back to nlerp (avoids acos blow-up; registry #11).
 *
 * @example
 * ```ts
 * quat.slerp(out, a, b, 0.5);
 * // Anti-parallel (dot ≈ -1): caller does not need to pre-process; the negation fall-back
 * // happens internally.
 * ```
 */
export function slerp(out: Quat, a: QuatLike, b: QuatLike, t: number): Quat {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  let bx = b[0] as number;
  let by = b[1] as number;
  let bz = b[2] as number;
  let bw = b[3] as number;

  let cosTheta = ax * bx + ay * by + az * bz + aw * bw;

  // D-P6: anti-parallel → negate b then slerp (q and -q are the same rotation; shortest arc)
  if (cosTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosTheta = -cosTheta;
  }

  // Endpoint coincidence (|dot| → 1): nlerp fall-back avoids sin(0) division by zero
  if (cosTheta > 1 - EPS_SLERP_DOT_LIMIT) {
    return nlerp(out, a, b, t);
  }

  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  out[0] = wa * ax + wb * bx;
  out[1] = wa * ay + wb * by;
  out[2] = wa * az + wb * bz;
  out[3] = wa * aw + wb * bw;
  return out;
}

/**
 * out = normalized lerp(a, b, t). Returns out.
 *
 * Faster than slerp but the angular velocity is non-uniform; use it as a slerp substitute near endpoints.
 * Like slerp, automatically handles dot < 0 by negating b to keep the shortest arc.
 *
 * @degrade lerp result is near zero (very rare) → out = identity.
 *
 * @example
 * ```ts
 * quat.nlerp(out, qA, qB, 0.5);
 * // Very rare: lerp result lengthSq < EPS_NORMALIZE → out = (0, 0, 0, 1)
 * ```
 */
export function nlerp(out: Quat, a: QuatLike, b: QuatLike, t: number): Quat {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  let bx = b[0] as number;
  let by = b[1] as number;
  let bz = b[2] as number;
  let bw = b[3] as number;

  // anti-parallel → negate b for the shortest arc (same convention as slerp)
  const cosTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (cosTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  out[0] = ax + t * (bx - ax);
  out[1] = ay + t * (by - ay);
  out[2] = az + t * (bz - az);
  out[3] = aw + t * (bw - aw);

  const lenSq =
    (out[0] as number) * (out[0] as number) +
    (out[1] as number) * (out[1] as number) +
    (out[2] as number) * (out[2] as number) +
    (out[3] as number) * (out[3] as number);
  if (lenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const inv = 1 / Math.sqrt(lenSq);
  out[0] = (out[0] as number) * inv;
  out[1] = (out[1] as number) * inv;
  out[2] = (out[2] as number) * inv;
  out[3] = (out[3] as number) * inv;
  return out;
}

/**
 * out = inverse of a (conjugate / lengthSq). Returns out.
 *
 * For unit quaternions, invert is equivalent to conjugate (and faster); this implementation uses
 * the general a/|a|² form to support non-unit inputs.
 *
 * @degrade lengthSq(a) < EPS_NORMALIZE (zero quaternion) → out = identity (does not return NaN;
 *          same convention as mat invert).
 *
 * @example
 * ```ts
 * quat.invert(out, q);
 * quat.invert(out, quat.create(0, 0, 0, 0)); // → out = identity (0, 0, 0, 1), AC-06 no throw
 * ```
 */
export function invert(out: Quat, a: QuatLike): Quat {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const lenSq = ax * ax + ay * ay + az * az + aw * aw;
  if (lenSq < EPS_NORMALIZE) {
    return identity(out);
  }
  const inv = 1 / lenSq;
  out[0] = -ax * inv;
  out[1] = -ay * inv;
  out[2] = -az * inv;
  out[3] = aw * inv;
  return out;
}

/** out = conjugate quaternion [-x, -y, -z, w] (aliasing-safe). Returns out. */
export function conjugate(out: Quat, a: QuatLike): Quat {
  out[0] = -(a[0] as number);
  out[1] = -(a[1] as number);
  out[2] = -(a[2] as number);
  out[3] = a[3] as number;
  return out;
}

/** dot(a, b) = ax*bx + ay*by + az*bz + aw*bw (returns scalar). */
export function dot(a: QuatLike, b: QuatLike): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number) +
    (a[3] as number) * (b[3] as number)
  );
}

/** sqrt(x² + y² + z² + w²). Delegates to lengthSq + Math.sqrt (canonical pattern; see clone-5-quat-audit.md). */
export function length(a: QuatLike): number {
  return Math.sqrt(lengthSq(a));
}

/** x² + y² + z² + w² (no sqrt). */
export function lengthSq(a: QuatLike): number {
  return lengthSq4(a);
}

/**
 * out = q · v · q⁻¹ (rotate vec3 v by the unit quaternion q). Returns out.
 *
 * Rodrigues optimized form (research Finding 3, 18 mul + 12 add):
 *   t = 2 · cross(q.xyz, v)
 *   out = v + q.w · t + cross(q.xyz, t)
 *
 * 3-5× faster than going through mat4 (fromQuat → transformVec3); same shape as gl-matrix
 * `vec3.transformQuat` / Three.js `Vector3.applyQuaternion` (industry consensus).
 *
 * Aliasing-safe: reads v.xyz / q.xyzw into locals before writing out.
 *
 * @degrade q must be a unit-length quaternion. A non-unit q introduces implicit scaling
 *          (D-4 silent convention; no throw; AI users always get unit-length q from
 *          quat.fromAxisAngle / fromEuler / normalize / slerp, so this branch is not hit).
 *          When q = (0,0,0,0), t = 0 → out = v (the natural result of the formula; matches
 *          gl-matrix / Three.js; non-NaN, no throw).
 *
 * @example
 * ```ts
 * const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
 * const out = vec3.create();
 * quat.transformVec3(out, q, [1, 0, 0]); // → out ≈ (0, 0, -1)
 * // Guard: q derived from the quat surface is always unit-length; callers do not need to normalize.
 * ```
 */
export function transformVec3(out: Vec3, q: QuatLike, v: Vec3Like): Vec3 {
  const qx = q[0] as number;
  const qy = q[1] as number;
  const qz = q[2] as number;
  const qw = q[3] as number;
  const vx = v[0] as number;
  const vy = v[1] as number;
  const vz = v[2] as number;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // out = v + q.w * t + cross(q.xyz, t)
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * out = a / length(a). Returns out.
 *
 * @degrade lengthSq(a) < EPS_NORMALIZE → out = [0, 0, 0, 0] (same convention as vec.normalize;
 *          does not write identity, preserving the "zero quaternion" semantics; if the caller
 *          needs identity it should use fromAxisAngle with 0-axis).
 *
 * @example
 * ```ts
 * quat.normalize(out, q);
 * quat.normalize(out, quat.create(0, 0, 0, 0)); // → out = (0, 0, 0, 0); zero-quaternion semantics preserved
 * ```
 */
export function normalize(out: Quat, a: QuatLike): Quat {
  normalize4(out, a, EPS_NORMALIZE);
  return out;
}

/**
 * Convenience: quaternion representing rotation `theta` radians around the
 * Y axis. Equivalent to `quat.fromEuler(out, 0, theta, 0, 'YXZ')` but
 * allocates its own output `Quat`.
 *
 * Formula: `(0, sin(theta/2), 0, cos(theta/2))`.
 *
 * @degrade eulerY(0) → identity, eulerY(2pi) → identity within epsilon.
 *
 * @example
 * ```ts
 * const yaw45 = quat.eulerY(Math.PI / 4);
 * // yaw45 ≈ [0, 0.3826834, 0, 0.9238795]
 * ```
 *
 * @example Equivalent to the verbose form:
 * ```ts
 * const q1 = quat.eulerY(theta);
 * const q2 = quat.fromEuler(quat.create(), 0, theta, 0, 'YXZ');
 * // q1 === q2 (within epsilon)
 * ```
 */
export function eulerY(theta: number): Quat {
  const out = create();
  return fromEuler(out, 0, theta, 0, 'YXZ');
}

// ── Local basis accessors ─────────────────────────────────────────────────
//
// A rotation's three local basis vectors — the world-space directions its own
// +X / +Y / −Z axes point after the rotation. They are exactly `q` applied to
// the canonical axes: right = q·(1,0,0), up = q·(0,1,0), forward = q·(0,0,−1).
//
// The −Z forward convention matches `mat4.getForward` (RL-4) and the look
// convention `fromLookAt` / `computeViewProj` use, so a camera/listener built
// with `fromLookAt(eye, target)` has `forward(q)` ≈ normalize(target − eye).
// These fold the transformVec3-with-a-magic-axis idiom (and the handedness a
// caller would otherwise have to know) into a named accessor, mirroring the
// mat4 getters so learning one basis form applies to both. Because `q` from the
// quat surface is always unit-length, `transformVec3` returns a unit vector — no
// separate normalize step (unlike the mat4 getters, which read possibly-scaled
// basis columns and must normalize).

/**
 * Local right axis: the world-space direction the rotation's own +X axis points.
 * `right(out, q) = quat.transformVec3(out, q, [1, 0, 0])`. Mirrors
 * `mat4.getRight`; matches Bevy `Transform::local_x` / `Transform::right`.
 *
 * @degrade q must be unit-length (guaranteed by the quat surface); a unit q
 *          yields a unit result. q = (0,0,0,0) → out = (1,0,0) (the natural
 *          transformVec3 result; non-NaN, no throw).
 *
 * @example
 * ```ts
 * const q = quat.eulerY(Math.PI / 2); // 90° about +Y
 * quat.right(vec3.create(), q); // → (0, 0, -1): +X yawed a quarter-turn
 * ```
 */
export function right(out: Vec3, q: QuatLike): Vec3 {
  return transformVec3(out, q, UNIT_X);
}

/**
 * Local up axis: the world-space direction the rotation's own +Y axis points.
 * `up(out, q) = quat.transformVec3(out, q, [0, 1, 0])`. Mirrors `mat4.getUp`;
 * matches Bevy `Transform::local_y` / `Transform::up`.
 *
 * @degrade q must be unit-length (guaranteed by the quat surface); a unit q
 *          yields a unit result. q = (0,0,0,0) → out = (0,1,0).
 *
 * @example
 * ```ts
 * const q = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2); // pitch 90°
 * quat.up(vec3.create(), q); // → (0, 0, 1): +Y pitched onto +Z
 * ```
 */
export function up(out: Vec3, q: QuatLike): Vec3 {
  return transformVec3(out, q, UNIT_Y);
}

/**
 * Local forward axis: the world-space direction the rotation's own −Z axis
 * points (−Z look convention, RL-4). `forward(out, q) =
 * quat.transformVec3(out, q, [0, 0, -1])`. Mirrors `mat4.getForward`; matches
 * Bevy `Transform::forward` (Bevy also uses −Z). A quat from `fromLookAt(eye,
 * target, up)` has `forward(q)` ≈ normalize(target − eye).
 *
 * @degrade q must be unit-length (guaranteed by the quat surface); a unit q
 *          yields a unit result. q = (0,0,0,0) → out = (0,0,-1).
 *
 * @example
 * ```ts
 * const q = quat.eulerY(Math.PI / 2); // 90° about +Y
 * quat.forward(vec3.create(), q); // → (-1, 0, 0): -Z yawed a quarter-turn
 * ```
 */
export function forward(out: Vec3, q: QuatLike): Vec3 {
  return transformVec3(out, q, UNIT_NEG_Z);
}
