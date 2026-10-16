// vec3.ts — 3D vector namespace (M2 / T-014, rewritten from the M1 baseline of 8 functions)
//
// 21-function surface (≥ 18 lower bound): vec2 base (without perp) + cross + distanceSq.
//   create / clone / copy / set / equals / add / sub / scale / negate /
//   dot / cross / lengthSq / length / distance / distanceSq /
//   normalize / lerp / smoothDamp / catmullRom / min / max
//
// Cross-type transforms are provided via the reverse surfaces of mat4 / quat (K-1/K-2 tore down
// the Three.js-style promise; see plan-decisions §D-12): the three mat4 ns transform* functions
// + quat.transformVec3 supersede the historical promise to "hang cross-type methods on vec3 instances".
//
// Design locks:
//   - branded Float32Array (types.ts SSOT); factory `as Vec3` casts are funneled.
//   - The legacy local Vec3 / Vec3Like type aliases are removed; mat4 / quat now `import './types'` Vec3Like.
//   - Out-param first + aliasing-safe (gl-matrix four ironclad rules, wiki/gl-matrix-overview).
//   - normalize(0-vec) → 0-vec silent fall-back (D-P12 / AC-06).
//   - mandatory `export function` (D-P10).
//
// Related: requirements §Surface vec3 lower bound 18 + AC-19 legacy 8-function removal (vec3 portion);
//          plan-strategy §6 M2 + §1.1 vec3.ts;
//          wiki/typescript-branded-types §7.2 factory template;
//          wiki/gl-matrix-overview Out-param four ironclad rules + degenerate anchor.
//
// Compatibility: this file still re-exports `Vec3Like` from ./types so mat4 / quat's existing imports
// keep working (M2 does not force-update mat4 / quat import paths; that lands in M3).

import { EPS_NORMALIZE } from './_internal/epsilon';
import { catmullRomScalar, lerp as scalarLerp, smoothDecayFactor } from './_internal/scalar';
import type { Vec3, Vec3Like } from './types';

export type { Vec3, Vec3Like };

/** Create a Vec3 (zero vector by default). */
export function create(x = 0, y = 0, z = 0): Vec3 {
  return Float32Array.of(x, y, z) as Vec3;
}

/** Allocate a new Vec3 copy. */
export function clone(a: Vec3Like): Vec3 {
  return Float32Array.of(a[0] as number, a[1] as number, a[2] as number) as Vec3;
}

/** out = a. aliasing-safe (copy(v, v) is a no-op). */
export function copy(out: Vec3, a: Vec3Like): Vec3 {
  out[0] = a[0] as number;
  out[1] = a[1] as number;
  out[2] = a[2] as number;
  return out;
}

/** Write the components and return out. */
export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/**
 * Approximate equality: every component differs by ≤ epsilon. NaN inputs always return false (IEEE 754).
 */
export function equals(a: Vec3Like, b: Vec3Like, epsilon = 1e-6): boolean {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  if (
    Number.isNaN(ax) ||
    Number.isNaN(ay) ||
    Number.isNaN(az) ||
    Number.isNaN(bx) ||
    Number.isNaN(by) ||
    Number.isNaN(bz)
  ) {
    return false;
  }
  return (
    Math.abs(ax - bx) <= epsilon && Math.abs(ay - by) <= epsilon && Math.abs(az - bz) <= epsilon
  );
}

/** out = a + b. aliasing-safe. */
export function add(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  out[0] = ax + bx;
  out[1] = ay + by;
  out[2] = az + bz;
  return out;
}

/** out = a - b. aliasing-safe. */
export function sub(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  out[0] = ax - bx;
  out[1] = ay - by;
  out[2] = az - bz;
  return out;
}

/** out = a * s. */
export function scale(out: Vec3, a: Vec3Like, s: number): Vec3 {
  out[0] = (a[0] as number) * s;
  out[1] = (a[1] as number) * s;
  out[2] = (a[2] as number) * s;
  return out;
}

/** out = -a. */
export function negate(out: Vec3, a: Vec3Like): Vec3 {
  out[0] = 0 - (a[0] as number);
  out[1] = 0 - (a[1] as number);
  out[2] = 0 - (a[2] as number);
  return out;
}

/** Dot product a · b. */
export function dot(a: Vec3Like, b: Vec3Like): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

/** out = a × b (cross product). aliasing-safe (reads all 6 components into locals first). */
export function cross(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

/** Squared length |a|² (avoids sqrt overhead). */
export function lengthSq(a: Vec3Like): number {
  const x = a[0] as number;
  const y = a[1] as number;
  const z = a[2] as number;
  return x * x + y * y + z * z;
}

/** Euclidean length |a|. */
export function length(a: Vec3Like): number {
  const x = a[0] as number;
  const y = a[1] as number;
  const z = a[2] as number;
  return Math.sqrt(x * x + y * y + z * z);
}

/** Distance between two points |a - b|. */
export function distance(a: Vec3Like, b: Vec3Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const dz = (a[2] as number) - (b[2] as number);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Squared distance between two points |a - b|² (avoids sqrt overhead). */
export function distanceSq(a: Vec3Like, b: Vec3Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const dz = (a[2] as number) - (b[2] as number);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * out = a / |a| (unit-length).
 *
 * @degrade Zero vector (|a|² < EPS_NORMALIZE) silently falls back to the zero vector;
 * no NaN, no throw (gl-matrix style, AC-06 / D-P12).
 * @degrade NaN inputs → NaN outputs: when a component is NaN, lenSq=NaN; the `lenSq < EPS`
 * branch is false → goes through 1/sqrt(NaN)=NaN → output is all NaN (IEEE-754 NaN propagation;
 * still does not throw).
 *
 * @example
 * ```ts
 * vec3.normalize(out, [3, 0, 4]);     // → (0.6, 0, 0.8)
 * vec3.normalize(out, [0, 0, 0]);     // → (0, 0, 0) zero vector falls back (AC-06 no throw)
 * vec3.normalize(out, [NaN, 1, 0]);   // → (NaN, NaN, NaN) IEEE-754 propagation
 * ```
 */
export function normalize(out: Vec3, a: Vec3Like): Vec3 {
  const x = a[0] as number;
  const y = a[1] as number;
  const z = a[2] as number;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < EPS_NORMALIZE) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const inv = 1 / Math.sqrt(lenSq);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

/** out = lerp(a, b, t). t is not clamped (extrapolation semantics). aliasing-safe. */
export function lerp(out: Vec3, a: Vec3Like, b: Vec3Like, t: number): Vec3 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  out[0] = scalarLerp(ax, bx, t);
  out[1] = scalarLerp(ay, by, t);
  out[2] = scalarLerp(az, bz, t);
  return out;
}

/**
 * out = frame-rate-INDEPENDENT exponential smoothing of `current` toward `target`:
 * `lerp(current, target, 1 − exp(−decayRate · dt))`. Semantics match Bevy
 * `StableInterpolate::smooth_nudge` / three.js `MathUtils.damp` — NOT Unity `Vector3.SmoothDamp`
 * (which is a 2nd-order critically-damped spring needing a velocity ref; this is 1st-order decay).
 *
 * `decayRate` is the exponential decay constant (1/s), meant to stay fixed while `dt` is per-frame;
 * a good anchor is `decayRate = ln(2)/halfLife`. `dt=0` → out=current (no move); large `decayRate·dt`
 * → out≈target; `decayRate=0` → out=current. Frame-rate independent by construction: one step of `dt`
 * equals two composed steps of `dt/2` — unlike the naive `lerp(current, target, rate·dt)`, which
 * behaves differently per frame rate and overshoots when `rate·dt > 1`. aliasing-safe.
 */
export function smoothDamp(
  out: Vec3,
  current: Vec3Like,
  target: Vec3Like,
  decayRate: number,
  dt: number,
): Vec3 {
  return lerp(out, current, target, smoothDecayFactor(decayRate, dt));
}

/**
 * out = Catmull-Rom spline point on the segment between `p1` and `p2`, with `p0` / `p3` the
 * neighbor control points setting the endpoint tangents (tension 0.5 — the Bevy
 * `CubicCardinalSpline::new_catmull_rom` / Three.js explicit `catmullrom` mode).
 * This is uniform; Three.js defaults to centripetal. Interpolates
 * the control points: `t=0` → `p1`, `t=1` → `p2`. Unlike `lerp` (a straight segment), this is
 * the smooth cubic through the points — use it for camera paths, animation ease paths, or
 * procedural curve geometry. To sample a whole polyline, loop the segments with a sliding
 * 4-point window `[pts[i-1], pts[i], pts[i+1], pts[i+2]]` (clamp/duplicate ends). `t` is not
 * clamped (extrapolation follows the same cubic). aliasing-safe.
 */
export function catmullRom(
  out: Vec3,
  p0: Vec3Like,
  p1: Vec3Like,
  p2: Vec3Like,
  p3: Vec3Like,
  t: number,
): Vec3 {
  const x = catmullRomScalar(p0[0] as number, p1[0] as number, p2[0] as number, p3[0] as number, t);
  const y = catmullRomScalar(p0[1] as number, p1[1] as number, p2[1] as number, p3[1] as number, t);
  const z = catmullRomScalar(p0[2] as number, p1[2] as number, p2[2] as number, p3[2] as number, t);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Component-wise min. */
export function min(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
  out[0] = Math.min(a[0] as number, b[0] as number);
  out[1] = Math.min(a[1] as number, b[1] as number);
  out[2] = Math.min(a[2] as number, b[2] as number);
  return out;
}

/** Component-wise max. */
export function max(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3 {
  out[0] = Math.max(a[0] as number, b[0] as number);
  out[1] = Math.max(a[1] as number, b[1] as number);
  out[2] = Math.max(a[2] as number, b[2] as number);
  return out;
}
