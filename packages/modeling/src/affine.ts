import { cos, sin } from './dmath';
import type { Axis, Tuple3 } from './geom';

/** Row-major 3x4 rigid transform: `[r00 r01 r02 tx  r10 r11 r12 ty  r20 r21 r22 tz]`. */
export type Affine = readonly number[];

/** Degrees about the parent-space axes, applied x first, then y, then z (`Rz * Ry * Rx`). */
export type Angles = Readonly<Partial<Record<Axis, number>>>;

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function translation(t: readonly number[]): Affine {
  return [1, 0, 0, t[0] as number, 0, 1, 0, t[1] as number, 0, 0, 1, t[2] as number];
}

export function multiply(a: Affine, b: Affine): Affine {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4] as number;
    const a1 = a[r * 4 + 1] as number;
    const a2 = a[r * 4 + 2] as number;
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a0 * (b[c] as number) + a1 * (b[4 + c] as number) + a2 * (b[8 + c] as number);
    }
    out[r * 4 + 3] = (out[r * 4 + 3] as number) + (a[r * 4 + 3] as number);
  }
  return out;
}

/** Inverse of a rigid transform (orthonormal rotation). */
export function invertRigid(m: Affine): Affine {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 4 + c] = m[c * 4 + r] as number;
  }
  for (let r = 0; r < 3; r++) {
    out[r * 4 + 3] = -(
      (out[r * 4] as number) * (m[3] as number) +
      (out[r * 4 + 1] as number) * (m[7] as number) +
      (out[r * 4 + 2] as number) * (m[11] as number)
    );
  }
  return out;
}

export function applyPoint(m: Affine, p: readonly number[]): Tuple3 {
  const [x, y, z] = p as [number, number, number];
  return [
    (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z + (m[3] as number),
    (m[4] as number) * x + (m[5] as number) * y + (m[6] as number) * z + (m[7] as number),
    (m[8] as number) * x + (m[9] as number) * y + (m[10] as number) * z + (m[11] as number),
  ];
}

const RADIANS = Math.PI / 180;

/** Rotation about a unit axis by `degrees` (right-handed). */
export function axisAngle(axis: readonly number[], degrees: number): Affine {
  const a = degrees * RADIANS;
  const c = cos(a);
  const s = sin(a);
  const t = 1 - c;
  const [x, y, z] = axis as [number, number, number];
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    0,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    0,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
    0,
  ];
}

export function fromAngles(angles: Angles = {}): Affine {
  return multiply(
    multiply(axisAngle([0, 0, 1], angles.z ?? 0), axisAngle([0, 1, 0], angles.y ?? 0)),
    axisAngle([1, 0, 0], angles.x ?? 0),
  );
}

/** Unit quaternion `[x, y, z, w]` of the rotation part (w >= 0). */
export function toQuaternion(m: Affine): [number, number, number, number] {
  const m00 = m[0] as number;
  const m11 = m[5] as number;
  const m22 = m[10] as number;
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [
      ((m[9] as number) - (m[6] as number)) / s,
      ((m[2] as number) - (m[8] as number)) / s,
      ((m[4] as number) - (m[1] as number)) / s,
      0.25 * s,
    ];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [
      0.25 * s,
      ((m[1] as number) + (m[4] as number)) / s,
      ((m[2] as number) + (m[8] as number)) / s,
      ((m[9] as number) - (m[6] as number)) / s,
    ];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [
      ((m[1] as number) + (m[4] as number)) / s,
      0.25 * s,
      ((m[6] as number) + (m[9] as number)) / s,
      ((m[2] as number) - (m[8] as number)) / s,
    ];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [
      ((m[2] as number) + (m[8] as number)) / s,
      ((m[6] as number) + (m[9] as number)) / s,
      0.25 * s,
      ((m[4] as number) - (m[1] as number)) / s,
    ];
  }
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** Column-major 4x4 (the Engine's matrix layout) of an affine transform. */
export function toColumnMajor(m: Affine): number[] {
  return [
    m[0] as number,
    m[4] as number,
    m[8] as number,
    0,
    m[1] as number,
    m[5] as number,
    m[9] as number,
    0,
    m[2] as number,
    m[6] as number,
    m[10] as number,
    0,
    m[3] as number,
    m[7] as number,
    m[11] as number,
    1,
  ];
}
