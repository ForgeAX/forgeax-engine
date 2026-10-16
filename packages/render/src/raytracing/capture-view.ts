import type { FieldVec3 } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { ok } from '@forgeax/engine-types';
import { packSettings, type RayPathCamera } from './path-input';
import { rayReferenceFailure } from './scene';
import type { SurfaceCardProjection } from './surface-cards';

/** Cards remain orthographic; the primary view can use the exact PT camera. */
export type SurfaceViewProjection =
  | SurfaceCardProjection
  | {
      readonly camera: RayPathCamera;
      readonly near: number;
      readonly far: number;
    };

export function captureViewProjection(p: SurfaceViewProjection) {
  const matrix = mat4.identity(mat4.create());
  let eye: readonly [number, number, number, number];
  let depth: number;
  if ('camera' in p) {
    const validation = packSettings({
      camera: p.camera,
      width: 1,
      height: 1,
      maxBounces: 1,
      seed: 0,
      environment: [0, 0, 0],
      maxDistance: p.far,
    });
    if (!validation.ok) return validation;
    if (!Number.isFinite(Math.fround(p.near)) || p.near <= 0 || p.near >= p.far)
      return rayReferenceFailure('perspective capture requires 0 < near < finite far');
    const view = mat4.lookAt(mat4.create(), p.camera.origin, p.camera.target, p.camera.up);
    mat4.perspective(matrix, p.camera.verticalFov, 1, p.near, p.far);
    mat4.multiply(matrix, matrix, view);
    eye = [...p.camera.origin, 1];
    depth = p.far;
  } else {
    const dot = (a: FieldVec3, b: FieldVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross: FieldVec3 = [
      p.u[1] * p.n[2] - p.u[2] * p.n[1],
      p.u[2] * p.n[0] - p.u[0] * p.n[2],
      p.u[0] * p.n[1] - p.u[1] * p.n[0],
    ];
    if (
      ![...p.origin, ...p.u, ...p.v, ...p.n, p.width, p.height, p.depth].every((v) =>
        Number.isFinite(Math.fround(v)),
      ) ||
      Math.min(p.width, p.height, p.depth) <= 0 ||
      ![p.u, p.v, p.n].every((a) => Math.abs(dot(a, a) - 1) < 1e-5) ||
      Math.abs(dot(p.u, p.v)) + Math.abs(dot(p.u, p.n)) + Math.abs(dot(p.v, p.n)) >= 1e-5 ||
      dot(cross, p.v) <= 0.99999
    )
      return rayReferenceFailure('view requires finite orthonormal axes and positive extents');
    for (const a of [0, 1, 2] as const) {
      matrix[a * 4] = (2 * p.u[a]) / p.width;
      matrix[a * 4 + 1] = (-2 * p.v[a]) / p.height;
      matrix[a * 4 + 2] = -p.n[a] / p.depth;
    }
    matrix[12] = (-2 * dot(p.origin, p.u)) / p.width - 1;
    matrix[13] = (2 * dot(p.origin, p.v)) / p.height + 1;
    matrix[14] = dot(p.origin, p.n) / p.depth;
    eye = [...p.n, 0];
    depth = p.depth;
  }
  const inverse = mat4.invert(mat4.create(), matrix);
  const roundTrip = mat4.multiply(mat4.create(), matrix, inverse);
  if (
    ![...matrix, ...inverse].every(Number.isFinite) ||
    roundTrip.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-3)
  )
    return rayReferenceFailure('capture projection is not invertible');
  return ok({ matrix, inverse, eye, depth });
}

/** Transform an offline local card, retaining the raster frame under mirrored scale. */
export function transformCardProjection(p: SurfaceCardProjection, transform: ArrayLike<number>) {
  const m = Array.from(transform);
  if (
    m.length !== 16 ||
    !m.every(Number.isFinite) ||
    m[3] !== 0 ||
    m[7] !== 0 ||
    m[11] !== 0 ||
    m[15] !== 1
  )
    return rayReferenceFailure('card transform requires a finite affine matrix');
  const direction = (a: FieldVec3): [number, number, number] =>
    [0, 1, 2].map(
      (i) => (m[i] ?? NaN) * a[0] + (m[i + 4] ?? NaN) * a[1] + (m[i + 8] ?? NaN) * a[2],
    ) as [number, number, number];
  const origin = direction(p.origin);
  for (const i of [0, 1, 2] as const) origin[i] += m[12 + i] ?? NaN;
  const u = direction(p.u),
    v = direction(p.v),
    n = direction(p.n);
  const lu = Math.hypot(...u),
    lv = Math.hypot(...v),
    ln = Math.hypot(...n);
  const width = p.width * lu,
    height = p.height * lv,
    depth = p.depth * ln;
  for (const [axis, length] of [
    [u, lu],
    [v, lv],
    [n, ln],
  ] as const)
    for (const i of [0, 1, 2] as const) axis[i] /= length;
  const handedness =
    (u[1] * n[2] - u[2] * n[1]) * v[0] +
    (u[2] * n[0] - u[0] * n[2]) * v[1] +
    (u[0] * n[1] - u[1] * n[0]) * v[2];
  if (handedness < 0)
    for (const i of [0, 1, 2] as const) {
      origin[i] += v[i] * height;
      v[i] = -v[i];
    }
  const projection = { origin, u, v, n, width, height, depth };
  const valid = captureViewProjection(projection);
  return valid.ok ? ok(projection) : valid;
}
