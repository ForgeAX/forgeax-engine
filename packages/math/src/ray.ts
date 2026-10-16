// ray.ts — ray primitive namespace (feat-20260529-picking-raycasting-screen-to-entity M1 / w3 + M2 / w7).
//
// Storage layout: Float32Array length 6 [ox, oy, oz, dx, dy, dz], direction normalized.
// default: origin=(0,0,0), direction=(0,0,-1).
//
// Surface: create / getOrigin / getDirection / setOrigin / setDirection /
//          rayAabbIntersects (slab method, 6 degenerate cases) /
//          screenToRay (M2 w7, two-point unproject with WebGPU [0,1] NDC z).
//
// Design locks:
//   - branded `Ray` Float32Array local to this module; cast funneled through `create`
//   - pure-function / out-param style consistent with box3 / vec3 / mat4;
//   - `rayAabbIntersects` uses the slab method with inv precomputation,
//     `inv[i] < 0` sign test (not direction test — avoids -0 pitfall),
//     NaN-safe edge/corner handling (Research Finding 2 #5).
//
// Related: requirements AC-01 / AC-02 / AC-03;
//          research Finding 2 (slab algorithm + 6 degenerate table);
//          research Finding 6 (WebGPU [0,1] NDC z);
//          plan-tasks.json w3 + w7 acceptanceChecks.

import type { Box3Like } from './box3';
import * as mat4 from './mat4';
import type { Mat4Like, Vec2, Vec3, Vec3Like } from './types';

/**
 * Result of a ray-triangle intersection test (Moller-Trumbore).
 * `t` = ray parameter, `u`/`v` = barycentric coordinates.
 */
export interface RayTriResult {
  hit: boolean;
  t: number;
  u: number;
  v: number;
}

/**
 * Ray storage: Float32Array length 6 [ox, oy, oz, dx, dy, dz], direction normalized.
 * Local brand (not part of the seven-piece SSOT; same rationale as Box3).
 */
export type Ray = Float32Array & { readonly __ray: void };

/**
 * Ray readable input: ArrayLike<number> of length 6 (ordering identical to Ray).
 */
export type RayLike = ArrayLike<number>;

/**
 * Create a Ray. Defaults to origin=(0,0,0), direction=(0,0,-1) normalized.
 *
 * When `out` is not provided, a new Float32Array is allocated.
 * When `origin` / `direction` are provided, direction is normalized
 * (zero-length direction falls back to (0,0,0) per gl-matrix style).
 */
export function create(out?: Float32Array, origin?: Vec3Like, direction?: Vec3Like): Ray {
  const r = out ?? new Float32Array(6);
  if (origin) {
    r[0] = origin[0] as number;
    r[1] = origin[1] as number;
    r[2] = origin[2] as number;
  } else {
    r[0] = 0;
    r[1] = 0;
    r[2] = 0;
  }
  if (direction) {
    const dx = direction[0] as number;
    const dy = direction[1] as number;
    const dz = direction[2] as number;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 1e-12) {
      r[3] = 0;
      r[4] = 0;
      r[5] = 0;
    } else {
      const inv = 1 / Math.sqrt(lenSq);
      r[3] = dx * inv;
      r[4] = dy * inv;
      r[5] = dz * inv;
    }
  } else {
    r[3] = 0;
    r[4] = 0;
    r[5] = -1;
  }
  return r as Ray;
}

/**
 * Copy the origin of `r` into `out`. Returns `out`.
 */
export function getOrigin(out: Vec3, r: RayLike): Vec3 {
  out[0] = r[0] as number;
  out[1] = r[1] as number;
  out[2] = r[2] as number;
  return out;
}

/**
 * Copy the direction of `r` into `out`. Returns `out`.
 */
export function getDirection(out: Vec3, r: RayLike): Vec3 {
  out[0] = r[3] as number;
  out[1] = r[4] as number;
  out[2] = r[5] as number;
  return out;
}

/**
 * Overwrite the origin of `r` with `o`. Returns `r`.
 */
export function setOrigin(r: Ray, o: Vec3Like): Ray {
  r[0] = o[0] as number;
  r[1] = o[1] as number;
  r[2] = o[2] as number;
  return r;
}

/**
 * Overwrite the direction of `r` with `d` and normalize it.
 * Zero-length direction falls back to (0,0,0) (gl-matrix style).
 * Returns `r`.
 */
export function setDirection(r: Ray, d: Vec3Like): Ray {
  const dx = d[0] as number;
  const dy = d[1] as number;
  const dz = d[2] as number;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-12) {
    r[3] = 0;
    r[4] = 0;
    r[5] = 0;
  } else {
    const inv = 1 / Math.sqrt(lenSq);
    r[3] = dx * inv;
    r[4] = dy * inv;
    r[5] = dz * inv;
  }
  return r;
}

/**
 * Result of a ray-AABB intersection test.
 */
export interface RayAabbResult {
  hit: boolean;
  /** Entry distance along the ray (clamped to 0 when origin is inside the box). */
  tmin: number;
}

/**
 * Test whether a ray intersects an axis-aligned bounding box using the
 * slab (Kay-Kajiya) method.
 *
 * Six degenerate cases per research Finding 2:
 *   1. hit from outside → `tmin > 0`
 *   2. hit from inside → `tmin = 0`
 *   3. miss (ray away) → `hit = false`
 *   4. parallel-axis miss → natural via ±Inf propagation
 *   5. edge/corner NaN-safe → guard `t1 > t2` NaN scenarios with `Number.isNaN`
 *   6. thin box (1D/2D) → correct via interval shrink
 *
 * Algorithm: precompute `inv = 1/D`, use `inv[i] < 0` (not direction[i] < 0)
 * to handle `-0` direction correctly. On each axis compute `(min - O)*inv` and
 * `(max - O)*inv`, swap when `inv < 0`, then accumulate `t_near = max(t_near, t1)`,
 * `t_far = min(t_far, t2)`. Hit when `t_far >= max(t_near, 0)`.
 *
 * Input: `r` (Ray with normalized direction) + `aabb` (Box3Like, 6 floats).
 * Output: `{ hit: boolean, tmin: number }`.
 */
export function rayAabbIntersects(r: RayLike, aabb: Box3Like): RayAabbResult {
  const ox = r[0] as number;
  const oy = r[1] as number;
  const oz = r[2] as number;
  const dx = r[3] as number;
  const dy = r[4] as number;
  const dz = r[5] as number;

  const minX = aabb[0] as number;
  const minY = aabb[1] as number;
  const minZ = aabb[2] as number;
  const maxX = aabb[3] as number;
  const maxY = aabb[4] as number;
  const maxZ = aabb[5] as number;

  // precomputed inverse (Research Finding 2 #2: IEEE 754 ±Inf for D_i = 0)
  const invX = 1 / dx;
  const invY = 1 / dy;
  const invZ = 1 / dz;

  // X axis
  let t1x = (minX - ox) * invX;
  let t2x = (maxX - ox) * invX;
  // sign test on inv, not direction — avoids -0 pitfall (Finding 2 #3)
  if (invX < 0) {
    const tmp = t1x;
    t1x = t2x;
    t2x = tmp;
  }
  // NaN-safe: when t1x or t2x is NaN (0*∞ from origin on face), skip this axis
  // for tnear accumulation (interval unbounded on this axis)
  let tnear = Number.isNaN(t1x) ? -Infinity : t1x;
  let tfar = Number.isNaN(t2x) ? Infinity : t2x;

  // Y axis
  let t1y = (minY - oy) * invY;
  let t2y = (maxY - oy) * invY;
  if (invY < 0) {
    const tmp = t1y;
    t1y = t2y;
    t2y = tmp;
  }
  if (!Number.isNaN(t1y) && t1y > tnear) tnear = t1y;
  if (!Number.isNaN(t2y) && t2y < tfar) tfar = t2y;

  // early out: interval already invalid
  if (tnear > tfar) return { hit: false, tmin: 0 };

  // Z axis
  let t1z = (minZ - oz) * invZ;
  let t2z = (maxZ - oz) * invZ;
  if (invZ < 0) {
    const tmp = t1z;
    t1z = t2z;
    t2z = tmp;
  }
  if (!Number.isNaN(t1z) && t1z > tnear) tnear = t1z;
  if (!Number.isNaN(t2z) && t2z < tfar) tfar = t2z;

  // Kay-Kajiya hit criterion: tfar >= max(tnear, 0) and tfar >= 0
  if (tfar >= 0 && tfar >= tnear) {
    return { hit: true, tmin: tnear > 0 ? tnear : 0 };
  }
  return { hit: false, tmin: 0 };
}

// ============================================================
// screenToRay (feat-20260529-picking-raycasting-screen-to-entity M2 w7)
// ============================================================
//
// Two-point unproject method: unproject near (z=0) and far (z=1) NDC points
// through invVP, then ray.origin = nearWorld, ray.direction = normalize(farWorld - nearWorld).
//
// WebGPU [0,1] NDC z convention (D-NDC / research Finding 6):
//   near plane → ndc_z = 0, far plane → ndc_z = 1.
//
// y-flip: ndc_y = 1 - 2*screenY/viewportH (screen y-down → NDC y-up).
//
// Input sanitization: clamp screen coords to [0, vpW/vpH]; NaN/Inf inputs
// fall back to centre (0,0,0,0,0,-1) to guarantee a defined Ray.
//
// Related: plan-tasks.json w7; requirements in-scope #3 + edge cases;
//          research Finding 6 (WebGPU z) + Finding 3 (y-flip formula).

const _nearNdC = new Float32Array(3);
const _farNdC = new Float32Array(3);
const _nearWorld = new Float32Array(3);
const _farWorld = new Float32Array(3);
const _tmpInvVP = new Float32Array(16);

/**
 * Project a screen-space coordinate into a world-space Ray.
 *
 * `screenX` / `screenY` are in pixels relative to the top-left corner of the viewport
 * (DOM convention: y-down). They are clamped to `[0, vpWidth]` / `[0, vpHeight]` and
 * sanitized against NaN/Inf.
 *
 * `kind` discriminates the projection type so callers can branch on the result if needed;
 * both paths use the same two-point unproject algorithm.
 *
 * @param out The Ray to write into.
 * @param screenX Horizontal pixel coordinate (y-down origin, top-left).
 * @param screenY Vertical pixel coordinate.
 * @param vpWidth Viewport width in pixels.
 * @param vpHeight Viewport height in pixels.
 * @param view Camera view matrix (world→eye).
 * @param proj Camera projection matrix (eye→clip).
 * @param kind `'perspective'` or `'orthographic'`.
 * @returns `out` (same Ray instance).
 */
export function screenToRay(
  out: Ray,
  screenX: number,
  screenY: number,
  vpWidth: number,
  vpHeight: number,
  view: Mat4Like,
  proj: Mat4Like,
  _kind: 'perspective' | 'orthographic',
): Ray {
  // --- input sanitization ---
  if (
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(vpWidth) ||
    !Number.isFinite(vpHeight) ||
    vpWidth <= 0 ||
    vpHeight <= 0
  ) {
    // Degenerate viewport or non-finite input: return a safe centre ray
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = -1;
    return out;
  }

  // Clamp to viewport bounds
  const sx = screenX < 0 ? 0 : screenX > vpWidth ? vpWidth : screenX;
  const sy = screenY < 0 ? 0 : screenY > vpHeight ? vpHeight : screenY;

  // --- screen → NDC (y-flip) ---
  const ndcX = (2 * sx) / vpWidth - 1;
  const ndcY = 1 - (2 * sy) / vpHeight;

  // --- build invVP = invert(proj * view) ---
  mat4.multiply(_tmpInvVP as unknown as import('./types').Mat4, proj, view);
  mat4.invert(_tmpInvVP as unknown as import('./types').Mat4, _tmpInvVP);

  // Projection coefficients determine the Z direction for both perspective
  // and orthographic matrices. Use an interior point for the direction so an
  // infinite far plane never divides by zero.
  const reversed = (proj[10] as number) >= 0;
  _nearNdC[0] = ndcX;
  _nearNdC[1] = ndcY;
  _nearNdC[2] = reversed ? 1 : 0;

  _farNdC[0] = ndcX;
  _farNdC[1] = ndcY;
  _farNdC[2] = 0.5;

  mat4.unproject(_nearWorld as unknown as Vec3, _nearNdC, _tmpInvVP as unknown as Mat4Like);
  mat4.unproject(_farWorld as unknown as Vec3, _farNdC, _tmpInvVP as unknown as Mat4Like);

  // --- write origin = nearWorld ---
  out[0] = _nearWorld[0] as number;
  out[1] = _nearWorld[1] as number;
  out[2] = _nearWorld[2] as number;

  // --- compute direction = normalize(far - near) ---
  const dx = (_farWorld[0] as number) - (_nearWorld[0] as number);
  const dy = (_farWorld[1] as number) - (_nearWorld[1] as number);
  const dz = (_farWorld[2] as number) - (_nearWorld[2] as number);
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-12) {
    // Degenerate: far == near (e.g. infinite-far projection, zero-depth frustum)
    // Fall back to camera forward direction
    out[3] = 0;
    out[4] = 0;
    out[5] = -1;
  } else {
    const inv = 1 / Math.sqrt(lenSq);
    out[3] = dx * inv;
    out[4] = dy * inv;
    out[5] = dz * inv;
  }

  return out;
}

// ============================================================
// worldToScreen (feat-20260617-host-engine-contract-and-video-cutscene M2 w5)
// ============================================================
//
// Self-contained mat4 * vec4 to get pre-divide w (do NOT wrap projectPoint — it discards w,
// research Finding 3). behind = w<0; onScreen = NDC xyz all in [-1,1] for xy and [0,1] for z.
// Pixel map y-down top-left: px=(ndc.x*0.5+0.5)*w, py=(1-(ndc.y*0.5+0.5))*h.
// out-param writes Vec2; returns plain {onScreen, behind} flags (no allocation).
//
// Related: requirements AC-01; plan-strategy D-2; research Finding 3/5/6.

/** Result of projecting a world-space point to screen-space pixel coordinates. */
export interface WorldToScreenResult {
  /** True if the NDC coordinates are within clip-space bounds. */
  onScreen: boolean;
  /** True if the original world-space point is behind the camera (w < 0).
   *  When true, `out` is meaningless (requirements §7). */
  behind: boolean;
}

/**
 * Project a world-space point to screen-space pixel coordinates.
 *
 * Performs a full mat4 * vec4 internally to capture the pre-divide `w` component
 * (projectPoint discards `w`, so it cannot report `behind`).
 *
 * Pixel mapping: top-left origin, y-down (DOM convention).
 *   px = (ndc.x * 0.5 + 0.5) * canvasW
 *   py = (1 - (ndc.y * 0.5 + 0.5)) * canvasH
 *
 * Degenerate viewport (canvasW <= 0 || canvasH <= 0): returns { onScreen: false, behind: false },
 * leaves `out` untouched.
 *
 * @param out Vec2 to write pixel coordinates into (y-down, top-left origin).
 * @param worldPos World-space point (3 floats).
 * @param viewProj Combined view-projection matrix (proj * view, 16 floats).
 * @param canvasW Canvas width in pixels.
 * @param canvasH Canvas height in pixels.
 * @returns { onScreen: boolean, behind: boolean } — pure data flags, no allocation.
 */
export function worldToScreen(
  out: Vec2,
  worldPos: Vec3Like,
  viewProj: Mat4Like,
  canvasW: number,
  canvasH: number,
): WorldToScreenResult {
  // Degenerate viewport: leave `out` untouched, report off-screen.
  if (!(canvasW > 0) || !(canvasH > 0)) {
    return { onScreen: false, behind: false };
  }

  const x = worldPos[0] as number;
  const y = worldPos[1] as number;
  const z = worldPos[2] as number;

  // clip = viewProj * [x, y, z, 1]  (column-major: m[col*4 + row])
  const clipX =
    (viewProj[0] as number) * x +
    (viewProj[4] as number) * y +
    (viewProj[8] as number) * z +
    (viewProj[12] as number);
  const clipY =
    (viewProj[1] as number) * x +
    (viewProj[5] as number) * y +
    (viewProj[9] as number) * z +
    (viewProj[13] as number);
  const clipZ =
    (viewProj[2] as number) * x +
    (viewProj[6] as number) * y +
    (viewProj[10] as number) * z +
    (viewProj[14] as number);
  const clipW =
    (viewProj[3] as number) * x +
    (viewProj[7] as number) * y +
    (viewProj[11] as number) * z +
    (viewProj[15] as number);

  // behind = camera-space point is behind the eye (w < 0); `out` is then meaningless.
  if (clipW < 0) {
    return { onScreen: false, behind: true };
  }

  const invW = 1 / clipW;
  const ndcX = clipX * invW;
  const ndcY = clipY * invW;
  const ndcZ = clipZ * invW;

  // y-down pixel map, top-left origin (DOM convention).
  out[0] = (ndcX * 0.5 + 0.5) * canvasW;
  out[1] = (1 - (ndcY * 0.5 + 0.5)) * canvasH;

  // onScreen: NDC xy in [-1, 1], NDC z in [0, 1] (WebGPU clip-space z convention).
  const onScreen = ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= 0 && ndcZ <= 1;

  return { onScreen, behind: false };
}

// ============================================================
// rayTriangleIntersects (feat-20260630-vertex-snapping-picking M1)
// ============================================================
//
// Moller-Trumbore algorithm. Returns RayTriResult { hit, t, u, v }.
// Double-sided: uses abs(det) < epsilon (no backface culling).
// Degenerate (collinear/zero-area/parallel) triangles return hit=false to avoid NaN propagation.
// t <= 0 rejected (behind ray origin).
// Barycentric boundary: u >= 0, v >= 0, u + v <= 1.
// NaN guard on all inputs.
//
// Related: requirements AC-06; plan-strategy D-1;
//          KB 2026-06-30-scratchapixel-moller-trumbore.md;
//          plan-tasks.json w2 acceptanceCheck.

const RAY_TRI_EPSILON = 1e-8;

/**
 * Test whether a ray intersects a triangle using the Moller-Trumbore algorithm.
 *
 * Double-sided: both front and back faces are checked (abs(det) < epsilon).
 * Degenerate triangles (collinear / zero-area) return hit=false.
 * Ray origin behind the triangle (t <= 0) is rejected.
 * NaN inputs are guarded against — any NaN input returns hit=false.
 *
 * @param r Ray (RayLike, 6 floats: ox,oy,oz,dx,dy,dz with normalized direction).
 * @param a Triangle vertex A (Vec3Like, 3 floats).
 * @param b Triangle vertex B (Vec3Like, 3 floats).
 * @param c Triangle vertex C (Vec3Like, 3 floats).
 * @returns RayTriResult with hit flag, t (ray parameter), and u/v (barycentric coordinates).
 */
export function rayTriangleIntersects(
  r: RayLike,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
): RayTriResult {
  // NaN guard: any NaN input → miss (prevents NaN propagation through the algorithm)
  if (
    Number.isNaN(r[0] as number) ||
    Number.isNaN(r[1] as number) ||
    Number.isNaN(r[2] as number) ||
    Number.isNaN(r[3] as number) ||
    Number.isNaN(r[4] as number) ||
    Number.isNaN(r[5] as number) ||
    Number.isNaN(a[0] as number) ||
    Number.isNaN(a[1] as number) ||
    Number.isNaN(a[2] as number) ||
    Number.isNaN(b[0] as number) ||
    Number.isNaN(b[1] as number) ||
    Number.isNaN(b[2] as number) ||
    Number.isNaN(c[0] as number) ||
    Number.isNaN(c[1] as number) ||
    Number.isNaN(c[2] as number)
  ) {
    return { hit: false, t: 0, u: 0, v: 0 };
  }

  const ox = r[0] as number;
  const oy = r[1] as number;
  const oz = r[2] as number;
  const dx = r[3] as number;
  const dy = r[4] as number;
  const dz = r[5] as number;

  // E1 = B - A, E2 = C - A
  const e1x = (b[0] as number) - (a[0] as number);
  const e1y = (b[1] as number) - (a[1] as number);
  const e1z = (b[2] as number) - (a[2] as number);
  const e2x = (c[0] as number) - (a[0] as number);
  const e2y = (c[1] as number) - (a[1] as number);
  const e2z = (c[2] as number) - (a[2] as number);

  // P = D x E2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  // det = E1 . P
  const det = e1x * px + e1y * py + e1z * pz;

  // Double-sided: abs(det) < epsilon → parallel / degenerate → miss
  if (Math.abs(det) < RAY_TRI_EPSILON) {
    return { hit: false, t: 0, u: 0, v: 0 };
  }

  const invDet = 1 / det;

  // T = O - A
  const tx = ox - (a[0] as number);
  const ty = oy - (a[1] as number);
  const tz = oz - (a[2] as number);

  // u = (T . P) * invDet
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) {
    return { hit: false, t: 0, u, v: 0 };
  }

  // Q = T x E1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  // v = (D . Q) * invDet
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) {
    return { hit: false, t: 0, u, v };
  }

  // t = (E2 . Q) * invDet
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t <= 0) {
    return { hit: false, t, u, v };
  }

  return { hit: true, t, u, v };
}
