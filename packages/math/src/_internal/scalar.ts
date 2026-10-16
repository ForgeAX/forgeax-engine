// _internal/scalar.ts — scalar helper SSOT (D-P13 not exported from package)
//
// Provides the scalar-layer building blocks reused across the vec/mat/quat namespaces;
// avoids duplicate implementations.
// Not exported through src/index.ts; indirectly covered by the public API tests of the dim files
// (plan-strategy §4.1 exemption).
//
// Related: plan-strategy §1.1 file layering (_internal/scalar.ts) + D-P13 _internal not exported;
//          requirements §duplicate-code elimination strategy D mixed.

/**
 * Scalar linear interpolation. t is not clamped (extrapolation semantics preserved,
 * matches glam Vec3.lerp / wgpu-matrix).
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Squared length of a four-component numeric value. */
export function lengthSq4(a: ArrayLike<number>): number {
  const x = a[0] as number;
  const y = a[1] as number;
  const z = a[2] as number;
  const w = a[3] as number;
  return x * x + y * y + z * z + w * w;
}

/** Normalize a four-component numeric value into a typed-array output. */
export function normalize4(out: Float32Array, a: ArrayLike<number>, epsilon: number): void {
  const lenSq = lengthSq4(a);
  if (lenSq < epsilon) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  const inv = 1 / Math.sqrt(lenSq);
  out[0] = (a[0] as number) * inv;
  out[1] = (a[1] as number) * inv;
  out[2] = (a[2] as number) * inv;
  out[3] = (a[3] as number) * inv;
}

/**
 * Exponential-decay smoothing factor for frame-rate-INDEPENDENT damping:
 * `1 − exp(−decayRate · dt)`. The single value the vec `smoothDamp` helpers interpolate by.
 *
 * SSOT for the smooth-nudge semantics (Bevy `StableInterpolate::smooth_nudge`,
 * three.js `MathUtils.damp`): the returned factor composes multiplicatively over dt —
 * `exp(−k·(a+b)) = exp(−k·a)·exp(−k·b)` — so one step of dt equals two steps of dt/2, the
 * property a naive `rate·dt` factor violates. `dt=0` → 0 (no move); `decayRate·dt → ∞` → 1
 * (snap to target); `decayRate=0` → 0 (no effect). NaN propagates via Math.exp.
 */
export function smoothDecayFactor(decayRate: number, dt: number): number {
  return 1 - Math.exp(-decayRate * dt);
}

/**
 * Scalar Catmull-Rom spline value on the segment between `b` and `c`, with `a` / `d` the
 * neighbor control points that set the endpoint tangents. Tension 0.5 (the Catmull-Rom
 * special case of a Cardinal spline, and the Bevy default). SSOT for the vec `catmullRom`
 * helpers — the coefficient matrix lives here once (Bevy `CubicCardinalSpline::char_matrix`
 * with s=0.5):
 *   c0 = b
 *   c1 = 0.5 (c − a)
 *   c2 = a − 2.5 b + 2 c − 0.5 d
 *   c3 = −0.5 a + 1.5 b − 1.5 c + 0.5 d
 *   value = c0 + c1 t + c2 t² + c3 t³
 * Interpolates the control points: t=0 → b, t=1 → c. `t` is not clamped (extrapolation
 * beyond the segment follows the same cubic, matching `lerp`'s unclamped semantics).
 */
export function catmullRomScalar(a: number, b: number, c: number, d: number, t: number): number {
  const c0 = b;
  const c1 = 0.5 * (c - a);
  const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
  const c3 = -0.5 * a + 1.5 * b - 1.5 * c + 0.5 * d;
  const t2 = t * t;
  const t3 = t2 * t;
  return c0 + c1 * t + c2 * t2 + c3 * t3;
}

/**
 * Numeric clamp into the closed interval [min, max]. Returns NaN when v is NaN (NaN propagation).
 */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
