import type { Quat } from '../types';

/** Extract rotation from column-major basis scalars without temporary storage. */
export function rotationToQuat(
  out: Quat,
  m00: number,
  m01: number,
  m02: number,
  m10: number,
  m11: number,
  m12: number,
  m20: number,
  m21: number,
  m22: number,
): Quat {
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
