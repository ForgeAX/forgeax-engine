// sphere.ts — bounding sphere namespace (M3 / w7).
//
// 5-function surface (plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Storage layout: Float32Array length 4 [cx, cy, cz, radius].
// Negative radius is the "empty sphere" sentinel — expandByPoint on an empty
// sphere seeds center + zero radius at the input point; containsPoint always
// returns false on an empty sphere.
//
// `fromPoints` uses the tight axis-aligned-bounding-box center + max distance
// bound as a fast approximation (Ritter is one option; we pick the simpler
// AABB-center variant because it is the common three.js/babylon default and
// is sufficient for v1 frustum-culling / broadphase needs — Welzl and Ritter
// are future spinoffs if tighter bounds become necessary).
//
// Related: requirements §AC-16 (Box3 / Sphere pure functions);
//          plan-strategy M3 range; plan-tasks.json w7 acceptanceCheck.

import * as box3 from './box3';
import type { Vec3Like } from './types';

/**
 * Sphere storage: Float32Array length 4 [cx, cy, cz, radius].
 * Local brand (not part of the seven-piece SSOT); see box3.ts rationale.
 */
export type Sphere = Float32Array & { readonly __sphere: void };

/**
 * Sphere readable input: ArrayLike<number> of length 4 (ordering identical to Sphere).
 */
export type SphereLike = ArrayLike<number>;

/**
 * Create a Sphere. Defaults to a zero-radius sphere at the origin.
 */
export function create(cx = 0, cy = 0, cz = 0, radius = 0): Sphere {
  return Float32Array.of(cx, cy, cz, radius) as Sphere;
}

/**
 * Grow the sphere so `point` lies inside (boundary inclusive). Returns `out`.
 *
 * If the sphere was empty (radius < 0) the call re-seeds the center to `point`
 * with radius 0. Otherwise the radius is set to max(current, distance(center, point)).
 */
export function expandByPoint(out: Sphere, point: Vec3Like): Sphere {
  const r = out[3] as number;
  const px = point[0] as number;
  const py = point[1] as number;
  const pz = point[2] as number;
  if (r < 0) {
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    out[3] = 0;
    return out;
  }
  const dx = px - (out[0] as number);
  const dy = py - (out[1] as number);
  const dz = pz - (out[2] as number);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > r) out[3] = d;
  return out;
}

/**
 * True when `point` is inside `sphere` (boundary inclusive). Empty sphere
 * (radius < 0) contains nothing.
 */
export function containsPoint(s: SphereLike, point: Vec3Like): boolean {
  const r = s[3] as number;
  if (r < 0) return false;
  const dx = (point[0] as number) - (s[0] as number);
  const dy = (point[1] as number) - (s[1] as number);
  const dz = (point[2] as number) - (s[2] as number);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * True when `sphere` overlaps `box` (boundary inclusive). Uses the standard
 * closest-point-on-AABB distance test.
 */
export function intersectsBox(s: SphereLike, b: box3.Box3Like): boolean {
  const r = s[3] as number;
  if (r < 0) return false;
  const cx = s[0] as number;
  const cy = s[1] as number;
  const cz = s[2] as number;
  const minX = b[0] as number;
  const minY = b[1] as number;
  const minZ = b[2] as number;
  const maxX = b[3] as number;
  const maxY = b[4] as number;
  const maxZ = b[5] as number;
  const qx = cx < minX ? minX : cx > maxX ? maxX : cx;
  const qy = cy < minY ? minY : cy > maxY ? maxY : cy;
  const qz = cz < minZ ? minZ : cz > maxZ ? maxZ : cz;
  const dx = cx - qx;
  const dy = cy - qy;
  const dz = cz - qz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * Build an enclosing sphere from `points` via AABB-center + max-distance
 * approximation. Empty `points` leaves the negative-radius empty sphere at
 * the origin.
 */
export function fromPoints(out: Sphere, points: readonly Vec3Like[]): Sphere {
  if (points.length === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = -1;
    return out;
  }
  const aabb = box3.create();
  for (let i = 0; i < points.length; i++) {
    box3.expandByPoint(aabb, points[i] as Vec3Like);
  }
  const cx = ((aabb[0] as number) + (aabb[3] as number)) * 0.5;
  const cy = ((aabb[1] as number) + (aabb[4] as number)) * 0.5;
  const cz = ((aabb[2] as number) + (aabb[5] as number)) * 0.5;
  let rSq = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec3Like;
    const dx = (p[0] as number) - cx;
    const dy = (p[1] as number) - cy;
    const dz = (p[2] as number) - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > rSq) rSq = d2;
  }
  out[0] = cx;
  out[1] = cy;
  out[2] = cz;
  out[3] = Math.sqrt(rSq);
  return out;
}
