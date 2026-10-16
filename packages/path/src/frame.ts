import { mat3, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import { invalidPath } from './errors';

export function projectNormal(out: Vec3, normal: ArrayLike<number>, tangent: Vec3): void {
  const dot =
    (normal[0] as number) * (tangent[0] as number) +
    (normal[1] as number) * (tangent[1] as number) +
    (normal[2] as number) * (tangent[2] as number);
  for (let i = 0; i < 3; i++) out[i] = (normal[i] as number) - dot * (tangent[i] as number);
  if (vec3.length(out) < 1e-6) {
    // Deterministic least-aligned axis, including a vertical initial tangent.
    let axis = 0;
    for (let i = 1; i < 3; i++)
      if (Math.abs(tangent[i] as number) < Math.abs(tangent[axis] as number)) axis = i;
    for (let i = 0; i < 3; i++)
      out[i] = (i === axis ? 1 : 0) - (tangent[axis] as number) * (tangent[i] as number);
  }
  vec3.normalize(out, out);
}

export function createPathSample() {
  return {
    position: vec3.create(),
    rotation: quat.create(),
    tangent: vec3.create(),
    normal: vec3.create(),
    right: vec3.create(),
    local: vec3.create(),
    matrix: mat3.create(),
    model: quat.create(),
    roll: quat.create(),
  };
}
export type PathSample = ReturnType<typeof createPathSample>;

/** Canonical frame is +Z forward, +Y up; authored axes map into that frame. */
export function orientSample(
  out: PathSample,
  direction: number,
  forward: number,
  up: number,
  roll: number,
): void {
  if (!Number.isFinite(direction)) throw invalidPath('direction', 'Finite travel direction');
  if (
    !Number.isInteger(forward) ||
    forward < 0 ||
    forward > 5 ||
    !Number.isInteger(up) ||
    up < 0 ||
    up > 5 ||
    forward >> 1 === up >> 1
  )
    throw invalidPath('model axes', 'Distinct signed X/Y/Z forward and up axes');
  if (!Number.isFinite(roll)) throw invalidPath('roll', 'Finite radians');
  if (direction < 0) vec3.scale(out.tangent, out.tangent, -1);
  projectNormal(out.normal, out.normal, out.tangent);
  vec3.cross(out.right, out.normal, out.tangent);
  for (let i = 0; i < 3; i++) {
    out.matrix[i] = out.right[i] as number;
    out.matrix[3 + i] = out.normal[i] as number;
    out.matrix[6 + i] = out.tangent[i] as number;
  }
  quat.fromRotationMatrix(out.rotation, out.matrix);
  // The model-to-canonical rotation derives solely from the two authored axes.
  out.local.fill(0);
  out.local[forward >> 1] = forward % 2 === 0 ? 1 : -1;
  out.normal.fill(0);
  out.normal[up >> 1] = up % 2 === 0 ? 1 : -1;
  vec3.cross(out.right, out.normal, out.local);
  for (let i = 0; i < 3; i++) {
    out.matrix[i] = out.right[i] as number;
    out.matrix[3 + i] = out.normal[i] as number;
    out.matrix[6 + i] = out.local[i] as number;
  }
  quat.fromRotationMatrix(out.model, out.matrix);
  quat.invert(out.model, out.model);
  // Roll around canonical forward before applying the model-axis conversion.
  out.local[0] = 0;
  out.local[1] = 0;
  out.local[2] = 1;
  quat.fromAxisAngle(out.roll, out.local, roll);
  quat.multiply(out.rotation, out.rotation, out.roll);
  quat.multiply(out.rotation, out.rotation, out.model);
  quat.normalize(out.rotation, out.rotation);
}
