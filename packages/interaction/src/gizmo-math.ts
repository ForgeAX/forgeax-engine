import type { ray } from '@forgeax/engine-math';
import { mat4, vec3 } from '@forgeax/engine-math';
export type V3 = readonly [number, number, number];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1));
export const tuple = (a: ArrayLike<number>): V3 => [a[0] as number, a[1] as number, a[2] as number];
export function transform(m: mat4.Mat4Like, p: V3): V3 {
  return tuple(mat4.transformVec3(vec3.create(), m, p));
}
export function plane(r: ray.Ray, center: V3, normal: V3): V3 | undefined {
  const direction: V3 = [r[3] as number, r[4] as number, r[5] as number];
  const denominator = dot(direction, normal);
  if (Math.abs(denominator) < 1e-6) return undefined;
  const t = dot(sub(center, tuple(r)), normal) / denominator;
  return t >= 0 ? add(tuple(r), mul(direction, t)) : undefined;
}
export function segmentDistance(x: number, y: number, a: V3, b: V3): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
