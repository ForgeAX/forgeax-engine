// easing.ts — easing-function namespace (solo round 20260713-233409)
//
// 4-function surface: cubicInOut / smoothstep / smootherstep / elasticInOut
// (GLSL `smoothstep`, Perlin's smootherstep; Bevy `EaseFunction::SmoothStep`/`SmootherStep`).
// Scalar time-remaps t → number: take a normalized parameter and return an eased value. The
// growable home for Bevy's `EaseFunction` family — further variants (sine / quad / bounce /
// steps) land here add-only.
//
// Every function clamps the input to [0, 1] first (GLSL / Bevy semantics), so out-of-range t
// saturates to the endpoints rather than extrapolating the curve.

import { clamp } from './_internal/scalar';

/** Cubic ease-in-out: Bevy `EaseFunction::CubicInOut`, clamped to [0, 1]. */
export function cubicInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Smoothstep S-curve: `3t² − 2t³` on the clamped input. GLSL `smoothstep` (with edges 0/1),
 * Bevy `EaseFunction::SmoothStep`. f(0)=0, f(1)=1, f′(0)=f′(1)=0 (slow-in / slow-out).
 * Input clamped to [0, 1]. Use to ease a normalized time / lerp factor instead of a linear ramp.
 */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Smootherstep (Perlin) S-curve: `6t⁵ − 15t⁴ + 10t³` on the clamped input. Bevy
 * `EaseFunction::SmootherStep`. Like {@link smoothstep} but ALSO has zero 2nd derivatives at
 * the endpoints (f″(0)=f″(1)=0), so acceleration is continuous — a gentler, more natural ease.
 * Input clamped to [0, 1].
 */
export function smootherstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Elastic ease-in-out: Bevy `EaseFunction::ElasticInOut`, clamped to [0, 1]. */
export function elasticInOut(t: number): number {
  const x = clamp(t, 0, 1);
  if (x === 0 || x === 1) return x;
  const c5 = (2 * Math.PI) / 4.5;
  return x < 0.5
    ? -(2 ** (20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
    : (2 ** (-20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1;
}
