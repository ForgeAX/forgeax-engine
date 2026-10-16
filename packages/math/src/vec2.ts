// vec2.ts — 2D vector namespace (M2 / T-013)
//
// 19-function surface (≥ 14 lower bound; includes perp 2D 90° rotation, excludes cross):
//   create / clone / copy / set / equals / add / sub / scale / negate /
//   dot / lengthSq / length / distance / normalize / lerp / smoothDamp / catmullRom / min / max / perp
//
// Design locks:
//   - branded Float32Array storage (types.ts SSOT); `as Vec2` casts are funneled through factory
//     functions (D-P15 / lint-brand-cast.mjs guard).
//   - Out-param first + aliasing-safe (gl-matrix four ironclad rules): every function reads
//     a/b components into locals before writing out, so vec2.add(v, v, v) / vec2.lerp(out, out, b, t)
//     are legal.
//   - degenerate silent fall-back (D-P12 / AC-06): normalize(0-vec) → 0-vec, no NaN, no throw.
//   - mandatory `export function` (D-P10) so grep + count-math-exports.mjs AST can count exports.
//
// Related: requirements §Surface vec2 lower bound 14; plan-strategy §6 M2 + §1.1 vec2.ts LOC 220;
//          wiki/typescript-branded-types §7.2 factory template;
//          wiki/gl-matrix-overview Out-param four ironclad rules + degenerate-semantics anchor.

import { EPS_NORMALIZE } from './_internal/epsilon';
import { catmullRomScalar, lerp as scalarLerp, smoothDecayFactor } from './_internal/scalar';
import type { Vec2, Vec2Like } from './types';

/** Create a Vec2 (zero vector by default). */
export function create(x = 0, y = 0): Vec2 {
  return Float32Array.of(x, y) as Vec2;
}

/** Allocate a new Vec2 copy. Difference from copy: clone allocates, copy writes into an existing out. */
export function clone(a: Vec2Like): Vec2 {
  return Float32Array.of(a[0] as number, a[1] as number) as Vec2;
}

/** out = a. Returns out. aliasing-safe (copy(v, v) is a no-op). */
export function copy(out: Vec2, a: Vec2Like): Vec2 {
  out[0] = a[0] as number;
  out[1] = a[1] as number;
  return out;
}

/** Write the components and return out. */
export function set(out: Vec2, x: number, y: number): Vec2 {
  out[0] = x;
  out[1] = y;
  return out;
}

/**
 * Approximate equality: every component differs by ≤ epsilon. NaN inputs always return false (matches IEEE 754).
 */
export function equals(a: Vec2Like, b: Vec2Like, epsilon = 1e-6): boolean {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  if (Number.isNaN(ax) || Number.isNaN(ay) || Number.isNaN(bx) || Number.isNaN(by)) return false;
  return Math.abs(ax - bx) <= epsilon && Math.abs(ay - by) <= epsilon;
}

/** out = a + b. aliasing-safe. */
export function add(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  out[0] = ax + bx;
  out[1] = ay + by;
  return out;
}

/** out = a - b. aliasing-safe. */
export function sub(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  out[0] = ax - bx;
  out[1] = ay - by;
  return out;
}

/** out = a * s. */
export function scale(out: Vec2, a: Vec2Like, s: number): Vec2 {
  out[0] = (a[0] as number) * s;
  out[1] = (a[1] as number) * s;
  return out;
}

/** out = -a. The `0 - x` form avoids -0 (test toBe(0) uses Object.is and distinguishes ±0). */
export function negate(out: Vec2, a: Vec2Like): Vec2 {
  out[0] = 0 - (a[0] as number);
  out[1] = 0 - (a[1] as number);
  return out;
}

/** Dot product a · b. */
export function dot(a: Vec2Like, b: Vec2Like): number {
  return (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number);
}

/** Squared length |a|² (avoids sqrt overhead; useful on hot paths comparing distances). */
export function lengthSq(a: Vec2Like): number {
  const x = a[0] as number;
  const y = a[1] as number;
  return x * x + y * y;
}

/** Euclidean length |a|. */
export function length(a: Vec2Like): number {
  const x = a[0] as number;
  const y = a[1] as number;
  return Math.sqrt(x * x + y * y);
}

/** Distance between two points |a - b|. */
export function distance(a: Vec2Like, b: Vec2Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  return Math.sqrt(dx * dx + dy * dy);
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
 * vec2.normalize(out, [3, 4]);     // → (0.6, 0.8)
 * vec2.normalize(out, [0, 0]);     // → (0, 0) zero vector falls back (no NaN; AC-06 no throw)
 * vec2.normalize(out, [NaN, 1]);   // → (NaN, NaN) IEEE-754 propagation
 * ```
 */
export function normalize(out: Vec2, a: Vec2Like): Vec2 {
  const x = a[0] as number;
  const y = a[1] as number;
  const lenSq = x * x + y * y;
  if (lenSq < EPS_NORMALIZE) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const inv = 1 / Math.sqrt(lenSq);
  out[0] = x * inv;
  out[1] = y * inv;
  return out;
}

/** out = lerp(a, b, t). t is not clamped (extrapolation semantics matches glam / wgpu-matrix). aliasing-safe. */
export function lerp(out: Vec2, a: Vec2Like, b: Vec2Like, t: number): Vec2 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  out[0] = scalarLerp(ax, bx, t);
  out[1] = scalarLerp(ay, by, t);
  return out;
}

/**
 * out = frame-rate-INDEPENDENT exponential smoothing of `current` toward `target`:
 * `lerp(current, target, 1 − exp(−decayRate · dt))`. Semantics match Bevy
 * `StableInterpolate::smooth_nudge` / three.js `MathUtils.damp` (1st-order decay, NOT Unity
 * `SmoothDamp`'s 2nd-order spring). `dt=0` → out=current; large `decayRate·dt` → out≈target.
 * Frame-rate independent by construction (one `dt` step = two composed `dt/2` steps). aliasing-safe.
 * See vec3.smoothDamp for the full contract. */
export function smoothDamp(
  out: Vec2,
  current: Vec2Like,
  target: Vec2Like,
  decayRate: number,
  dt: number,
): Vec2 {
  return lerp(out, current, target, smoothDecayFactor(decayRate, dt));
}

/**
 * out = Catmull-Rom spline point on the segment between `p1` and `p2`, with `p0` / `p3` the
 * neighbor control points setting the endpoint tangents (tension 0.5 — the Bevy
 * `CubicCardinalSpline::new_catmull_rom` / three.js default). Interpolates the control points
 * (`t=0` → `p1`, `t=1` → `p2`). See vec3.catmullRom for the full contract + whole-polyline
 * sampling. aliasing-safe. */
export function catmullRom(
  out: Vec2,
  p0: Vec2Like,
  p1: Vec2Like,
  p2: Vec2Like,
  p3: Vec2Like,
  t: number,
): Vec2 {
  const x = catmullRomScalar(p0[0] as number, p1[0] as number, p2[0] as number, p3[0] as number, t);
  const y = catmullRomScalar(p0[1] as number, p1[1] as number, p2[1] as number, p3[1] as number, t);
  out[0] = x;
  out[1] = y;
  return out;
}

/** Component-wise min. */
export function min(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
  out[0] = Math.min(a[0] as number, b[0] as number);
  out[1] = Math.min(a[1] as number, b[1] as number);
  return out;
}

/** Component-wise max. */
export function max(out: Vec2, a: Vec2Like, b: Vec2Like): Vec2 {
  out[0] = Math.max(a[0] as number, b[0] as number);
  out[1] = Math.max(a[1] as number, b[1] as number);
  return out;
}

/**
 * out = perp(a) — 2D counter-clockwise 90° rotation: (x, y) → (-y, x).
 *
 * Derives from cross(a, b) reducing to a scalar determinant in 2D; this API serves hot paths
 * (collision / normals).
 * aliasing-safe: reads a's components into locals before writing out.
 */
export function perp(out: Vec2, a: Vec2Like): Vec2 {
  const x = a[0] as number;
  const y = a[1] as number;
  out[0] = 0 - y;
  out[1] = x;
  return out;
}
