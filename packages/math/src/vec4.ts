// vec4.ts — 4D vector / homogeneous coordinate namespace (M2 / T-015)
//
// 18-function surface (≥ 14 lower bound; same shape as vec2/vec3, no cross / perp):
//   create / clone / copy / set / equals / add / sub / scale / negate /
//   dot / lengthSq / length / distance / normalize / lerp / smoothDamp / min / max
//
// Design locks:
//   - branded Float32Array (types.ts SSOT); factory `as Vec4` casts are funneled (D-P15).
//   - Out-param first + aliasing-safe (gl-matrix four ironclad rules).
//   - normalize(0-vec) → 0-vec silent fall-back (D-P12 / AC-06).
//   - mandatory `export function` (D-P10).
//   - reuses lerp from _internal/scalar.ts (strategy D mixed; duplicate-code elimination).
//   - Vec4 ≠ Quat (same length=4 brand mutual exclusion; types.ts SSOT keeps each brand independent).
//
// Related: requirements §Surface vec4 lower bound 14; plan-strategy §6 M2 + §1.1 vec4.ts LOC 240;
//          wiki/typescript-branded-types §7.2 factory template;
//          wiki/gl-matrix-overview Out-param four ironclad rules.

import { EPS_NORMALIZE } from './_internal/epsilon';
import { lengthSq4, normalize4, lerp as scalarLerp, smoothDecayFactor } from './_internal/scalar';
import type { Vec4, Vec4Like } from './types';

/** Create a Vec4 (zero vector by default). */
export function create(x = 0, y = 0, z = 0, w = 0): Vec4 {
  return Float32Array.of(x, y, z, w) as Vec4;
}

/** Allocate a new Vec4 copy. */
export function clone(a: Vec4Like): Vec4 {
  return Float32Array.of(a[0] as number, a[1] as number, a[2] as number, a[3] as number) as Vec4;
}

/** out = a. aliasing-safe (copy(v, v) is a no-op). */
export function copy(out: Vec4, a: Vec4Like): Vec4 {
  out[0] = a[0] as number;
  out[1] = a[1] as number;
  out[2] = a[2] as number;
  out[3] = a[3] as number;
  return out;
}

/** Write the components and return out. */
export function set(out: Vec4, x: number, y: number, z: number, w: number): Vec4 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

/**
 * Approximate equality: every component differs by ≤ epsilon. NaN inputs always return false (IEEE 754).
 */
export function equals(a: Vec4Like, b: Vec4Like, epsilon = 1e-6): boolean {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  if (
    Number.isNaN(ax) ||
    Number.isNaN(ay) ||
    Number.isNaN(az) ||
    Number.isNaN(aw) ||
    Number.isNaN(bx) ||
    Number.isNaN(by) ||
    Number.isNaN(bz) ||
    Number.isNaN(bw)
  ) {
    return false;
  }
  return (
    Math.abs(ax - bx) <= epsilon &&
    Math.abs(ay - by) <= epsilon &&
    Math.abs(az - bz) <= epsilon &&
    Math.abs(aw - bw) <= epsilon
  );
}

/** out = a + b. aliasing-safe. */
export function add(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = ax + bx;
  out[1] = ay + by;
  out[2] = az + bz;
  out[3] = aw + bw;
  return out;
}

/** out = a - b. aliasing-safe. */
export function sub(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = ax - bx;
  out[1] = ay - by;
  out[2] = az - bz;
  out[3] = aw - bw;
  return out;
}

/** out = a * s. */
export function scale(out: Vec4, a: Vec4Like, s: number): Vec4 {
  out[0] = (a[0] as number) * s;
  out[1] = (a[1] as number) * s;
  out[2] = (a[2] as number) * s;
  out[3] = (a[3] as number) * s;
  return out;
}

/** out = -a. The `0 - x` form avoids -0. */
export function negate(out: Vec4, a: Vec4Like): Vec4 {
  out[0] = 0 - (a[0] as number);
  out[1] = 0 - (a[1] as number);
  out[2] = 0 - (a[2] as number);
  out[3] = 0 - (a[3] as number);
  return out;
}

/** Dot product a · b (4 components). */
export function dot(a: Vec4Like, b: Vec4Like): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number) +
    (a[3] as number) * (b[3] as number)
  );
}

/** Squared length |a|² (avoids sqrt overhead). */
export function lengthSq(a: Vec4Like): number {
  return lengthSq4(a);
}

/** Euclidean length |a|. */
export function length(a: Vec4Like): number {
  return Math.sqrt(lengthSq4(a));
}

/** Distance between two points |a - b|. */
export function distance(a: Vec4Like, b: Vec4Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const dz = (a[2] as number) - (b[2] as number);
  const dw = (a[3] as number) - (b[3] as number);
  return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
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
 * vec4.normalize(out, [1, 2, 2, 0]);    // → (1/3, 2/3, 2/3, 0)
 * vec4.normalize(out, [0, 0, 0, 0]);    // → (0, 0, 0, 0) zero vector falls back (AC-06 no throw)
 * vec4.normalize(out, [NaN, 1, 0, 0]);  // → all NaN, IEEE-754 propagation
 * ```
 */
export function normalize(out: Vec4, a: Vec4Like): Vec4 {
  normalize4(out, a, EPS_NORMALIZE);
  return out;
}

/** out = lerp(a, b, t). t is not clamped (extrapolation semantics). aliasing-safe. */
export function lerp(out: Vec4, a: Vec4Like, b: Vec4Like, t: number): Vec4 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = scalarLerp(ax, bx, t);
  out[1] = scalarLerp(ay, by, t);
  out[2] = scalarLerp(az, bz, t);
  out[3] = scalarLerp(aw, bw, t);
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
  out: Vec4,
  current: Vec4Like,
  target: Vec4Like,
  decayRate: number,
  dt: number,
): Vec4 {
  return lerp(out, current, target, smoothDecayFactor(decayRate, dt));
}

/** Component-wise min. */
export function min(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
  out[0] = Math.min(a[0] as number, b[0] as number);
  out[1] = Math.min(a[1] as number, b[1] as number);
  out[2] = Math.min(a[2] as number, b[2] as number);
  out[3] = Math.min(a[3] as number, b[3] as number);
  return out;
}

/** Component-wise max. */
export function max(out: Vec4, a: Vec4Like, b: Vec4Like): Vec4 {
  out[0] = Math.max(a[0] as number, b[0] as number);
  out[1] = Math.max(a[1] as number, b[1] as number);
  out[2] = Math.max(a[2] as number, b[2] as number);
  out[3] = Math.max(a[3] as number, b[3] as number);
  return out;
}
