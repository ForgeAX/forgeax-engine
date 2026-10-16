// box3.ts — axis-aligned bounding box namespace (M3 / w7).
//
// 5-function surface (plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Storage layout: Float32Array length 6 [minX, minY, minZ, maxX, maxY, maxZ].
// Default state is "empty box" using the standard inverted-infinity convention
// (min = +Infinity, max = -Infinity) so `expandByPoint` on any finite point
// collapses to a zero-volume box containing exactly that point; this mirrors
// three.js Box3.makeEmpty + glam/wgpu-matrix conventions (research knowledge-base
// gl-matrix-overview §degenerate-anchor equivalent for AABB).
//
// Design locks:
//   - branded `Box3` Float32Array local to this module; cast funneled through `create`
//   - pure-function / out-param style consistent with vec3 / mat4;
//   - `expandByPoint` / `fromPoints` write to `out` in place and return it (aliasing-safe);
//   - `containsPoint` / `intersectsBox` are boundary-inclusive (standard AABB semantics).
//
// Related: requirements §AC-16 (Box3 / Sphere pure functions);
//          plan-strategy M3 range + D-P5 procedural geometry (Box3 backs future frustum culling);
//          plan-tasks.json w7 acceptanceCheck.

import type { Mat4Like, Vec3Like } from './types';

/**
 * Box3 storage: Float32Array length 6 [minX, minY, minZ, maxX, maxY, maxZ].
 * Local brand (not part of the seven-piece SSOT because bounding volumes are
 * neither linear-algebra primitives nor ECS POD carriers; types.ts SSOT is
 * reserved for vec/mat/quat/color).
 */
export type Box3 = Float32Array & { readonly __box3: void };

/**
 * Box3 readable input: ArrayLike<number> of length 6 (ordering identical to Box3).
 */
export type Box3Like = ArrayLike<number>;

/**
 * Create a Box3. Defaults to the "empty" box (min=+Inf, max=-Inf) so the first
 * `expandByPoint` call collapses to a zero-volume box at the input point.
 */
export function create(
  minX: number = Number.POSITIVE_INFINITY,
  minY: number = Number.POSITIVE_INFINITY,
  minZ: number = Number.POSITIVE_INFINITY,
  maxX: number = Number.NEGATIVE_INFINITY,
  maxY: number = Number.NEGATIVE_INFINITY,
  maxZ: number = Number.NEGATIVE_INFINITY,
): Box3 {
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ) as Box3;
}

/**
 * out ∪= point: grow min / max so `point` lies inside (boundary inclusive). Returns out.
 * Works correctly from the default empty box (inverted-infinity) — the first call
 * collapses both min and max to `point`.
 */
export function expandByPoint(out: Box3, point: Vec3Like): Box3 {
  const px = point[0] as number;
  const py = point[1] as number;
  const pz = point[2] as number;
  if (px < (out[0] as number)) out[0] = px;
  if (py < (out[1] as number)) out[1] = py;
  if (pz < (out[2] as number)) out[2] = pz;
  if (px > (out[3] as number)) out[3] = px;
  if (py > (out[4] as number)) out[4] = py;
  if (pz > (out[5] as number)) out[5] = pz;
  return out;
}

/**
 * True when `point` is inside `box` (boundary inclusive). An empty box
 * (min > max on any axis) contains no points.
 */
export function containsPoint(box: Box3Like, point: Vec3Like): boolean {
  const px = point[0] as number;
  const py = point[1] as number;
  const pz = point[2] as number;
  return (
    px >= (box[0] as number) &&
    px <= (box[3] as number) &&
    py >= (box[1] as number) &&
    py <= (box[4] as number) &&
    pz >= (box[2] as number) &&
    pz <= (box[5] as number)
  );
}

/**
 * True when `a` and `b` overlap on every axis (boundary inclusive — touching
 * faces intersect). Two empty boxes do not intersect.
 */
export function intersectsBox(a: Box3Like, b: Box3Like): boolean {
  return (
    (a[3] as number) >= (b[0] as number) &&
    (a[0] as number) <= (b[3] as number) &&
    (a[4] as number) >= (b[1] as number) &&
    (a[1] as number) <= (b[4] as number) &&
    (a[5] as number) >= (b[2] as number) &&
    (a[2] as number) <= (b[5] as number)
  );
}

/**
 * Build the tightest AABB enclosing `points`. Writes to `out` in place and
 * returns it. Empty `points` leaves `out` as the inverted-infinity empty box.
 */
export function fromPoints(out: Box3, points: readonly Vec3Like[]): Box3 {
  out[0] = Number.POSITIVE_INFINITY;
  out[1] = Number.POSITIVE_INFINITY;
  out[2] = Number.POSITIVE_INFINITY;
  out[3] = Number.NEGATIVE_INFINITY;
  out[4] = Number.NEGATIVE_INFINITY;
  out[5] = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec3Like;
    const px = p[0] as number;
    const py = p[1] as number;
    const pz = p[2] as number;
    if (px < (out[0] as number)) out[0] = px;
    if (py < (out[1] as number)) out[1] = py;
    if (pz < (out[2] as number)) out[2] = pz;
    if (px > (out[3] as number)) out[3] = px;
    if (py > (out[4] as number)) out[4] = py;
    if (pz > (out[5] as number)) out[5] = pz;
  }
  return out;
}

/**
 * Build the tightest AABB enclosing flattened xyz `positions` (tight-packed,
 * 3 floats per vertex). Writes to `out` in place and returns it.
 *
 * `positions` must have at least 3 elements to produce a non-empty box.
 * Fewer than 3 elements leaves `out` as the inverted-infinity empty box
 * (identical to `create()` default).
 *
 * Trailing elements beyond the last complete triplet are read verbatim
 * (undefined → NaN), matching the legacy `aabbFromPositions` behaviour
 * this function replaces.
 *
 * Related: `fromPoints` for `Vec3Like[]` input.
 */
export function fromPositions(out: Box3, positions: ArrayLike<number>): Box3 {
  out[0] = Number.POSITIVE_INFINITY;
  out[1] = Number.POSITIVE_INFINITY;
  out[2] = Number.POSITIVE_INFINITY;
  out[3] = Number.NEGATIVE_INFINITY;
  out[4] = Number.NEGATIVE_INFINITY;
  out[5] = Number.NEGATIVE_INFINITY;
  if (positions.length < 3) return out;
  let minX = positions[0] as number;
  let minY = positions[1] as number;
  let minZ = positions[2] as number;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  out[0] = minX;
  out[1] = minY;
  out[2] = minZ;
  out[3] = maxX;
  out[4] = maxY;
  out[5] = maxZ;
  return out;
}

/**
 * Transform an AABB by a 4x4 matrix using the conservative 8-corner method.
 *
 * Each of the 8 corners (all min/max combinations) is transformed by `m` as a
 * homogeneous point (w=1), then a new AABB is computed that tightly encloses
 * all 8 transformed points. This is always conservative — the output AABB is
 * guaranteed to contain the true transformed volume (no false culling).
 *
 * Returns `out`. Aliasing-safe: `box` and `out` may be the same reference.
 *
 * @example
 * ```ts
 * import { box3, mat4 } from '@forgeax/engine-math';
 * const box = box3.create(-1, -1, -1, 1, 1, 1);
 * const xform = mat4.create();
 * mat4.fromTranslation(xform, [5, 0, 0]);
 * box3.transformBox3(box, box, xform);
 * ```
 */
export function transformBox3(out: Box3, box: Box3Like, m: Mat4Like): Box3 {
  const bx = box[0] as number;
  const by = box[1] as number;
  const bz = box[2] as number;
  const bX = box[3] as number;
  const bY = box[4] as number;
  const bZ = box[5] as number;

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

  let minX = 0,
    maxX = 0,
    minY = 0,
    maxY = 0,
    minZ = 0,
    maxZ = 0;
  for (let corner = 0; corner < 8; corner++) {
    const cx = corner & 1 ? bX : bx;
    const cy = corner & 2 ? bY : by;
    const cz = corner & 4 ? bZ : bz;
    let x = m00 * cx + m10 * cy + m20 * cz + m30;
    let y = m01 * cx + m11 * cy + m21 * cz + m31;
    let z = m02 * cx + m12 * cy + m22 * cz + m32;
    const w = m03 * cx + m13 * cy + m23 * cz + m33;
    if (w !== 0) {
      const iw = 1 / w;
      x *= iw;
      y *= iw;
      z *= iw;
    }
    if (corner === 0) {
      minX = maxX = x;
      minY = maxY = y;
      minZ = maxZ = z;
    } else {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  out[0] = minX;
  out[1] = minY;
  out[2] = minZ;
  out[3] = maxX;
  out[4] = maxY;
  out[5] = maxZ;
  return out;
}
