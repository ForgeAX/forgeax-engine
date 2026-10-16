// vec-smooth-damp.test.ts — value tests for vec2/vec3/vec4.smoothDamp (solo round 20260713-183918)
//
// Regression guard for the friction that motivated the helpers: smoothly moving one entity toward
// another (Bevy `Vec3::smooth_nudge`, three.js `MathUtils.damp`) required either a missing primitive
// or the frame-rate-DEPENDENT hand-write `vec3.lerp(out, p, target, rate * dt)` — smooth at 60 fps,
// snappy at 30 fps, overshooting when `rate * dt > 1`. smoothDamp folds the exponential decay
// `lerp(current, target, 1 − exp(−decayRate · dt))`. These tests pin:
//   1. dt = 0 → out = current (no move),
//   2. large decayRate·dt → out ≈ target (converges),
//   3. FRAME-RATE INDEPENDENCE WITNESS: one step of dt ≈ two composed steps of dt/2 (the property
//      the naive lerp(rate·dt) violates — proven side-by-side that the naive form drifts),
//   4. monotone convergence: distance to target strictly shrinks each step (decay>0, dt>0),
//   5. aliasing-safe: out === current and out === target both give the right answer,
//   6. exact per-component formula current + (target−current)·(1−exp(−decay·dt)),
//   7. all three of vec2 / vec3 / vec4 present + symmetric.

import { describe, expect, it } from 'vitest';
import type { Vec2Like, Vec3Like, Vec4Like } from '../types';
import * as vec2 from '../vec2';
import * as vec3 from '../vec3';
import * as vec4 from '../vec4';

function dist3(a: Vec3Like, b: Vec3Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const dz = (a[2] as number) - (b[2] as number);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

describe('vec3.smoothDamp — core contract', () => {
  it('dt = 0 → out = current (no move)', () => {
    const out = vec3.create();
    vec3.smoothDamp(out, [1, 2, 3], [10, 20, 30], 5, 0);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('decayRate = 0 → out = current (no effect, matches Bevy)', () => {
    const out = vec3.create();
    vec3.smoothDamp(out, [1, 2, 3], [10, 20, 30], 0, 1 / 60);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('large decayRate·dt → out ≈ target (snaps)', () => {
    const out = vec3.create();
    vec3.smoothDamp(out, [0, 0, 0], [7, -4, 2], 1000, 1);
    expect(out[0]).toBeCloseTo(7, 5);
    expect(out[1]).toBeCloseTo(-4, 5);
    expect(out[2]).toBeCloseTo(2, 5);
  });

  it('exact per-component formula current + (target−current)·(1−exp(−decay·dt))', () => {
    const current: Vec3Like = [1, 2, 3];
    const target: Vec3Like = [5, 5, 5];
    const decay = 3;
    const dt = 1 / 60;
    const f = 1 - Math.exp(-decay * dt);
    const out = vec3.create();
    vec3.smoothDamp(out, current, target, decay, dt);
    expect(out[0]).toBeCloseTo(1 + (5 - 1) * f, 6);
    expect(out[1]).toBeCloseTo(2 + (5 - 2) * f, 6);
    expect(out[2]).toBeCloseTo(3 + (5 - 3) * f, 6);
  });

  it('monotone convergence: distance to target strictly shrinks each step', () => {
    const target: Vec3Like = [10, 10, 10];
    const p = vec3.create();
    vec3.set(p, 0, 0, 0);
    let prev = dist3(p, target);
    for (let i = 0; i < 120; i++) {
      vec3.smoothDamp(p, p, target, 4, 1 / 60);
      const d = dist3(p, target);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
    // after 2 s of decay=4 the remaining distance is tiny (exp(−8) ≈ 3.4e-4 of the original)
    expect(prev).toBeLessThan(0.01);
  });
});

describe('vec3.smoothDamp — frame-rate independence WITNESS', () => {
  it('one step of dt ≈ two composed steps of dt/2 (smoothDamp holds; naive lerp drifts)', () => {
    const current: Vec3Like = [0, 0, 0];
    const target: Vec3Like = [10, 0, 0];
    const decay = 6;
    const dt = 1 / 30;

    // Frame-rate-INDEPENDENT: smoothDamp with one full dt.
    const big = vec3.create();
    vec3.smoothDamp(big, current, target, decay, dt);

    // ...vs two half-dt smoothDamp steps composed. Exponential decay composes exactly:
    // exp(−k·(dt/2))·exp(−k·(dt/2)) = exp(−k·dt).
    const small = vec3.create();
    vec3.copy(small, current);
    vec3.smoothDamp(small, small, target, decay, dt / 2);
    vec3.smoothDamp(small, small, target, decay, dt / 2);

    expect(small[0]).toBeCloseTo(big[0] as number, 5);
    expect(small[1]).toBeCloseTo(big[1] as number, 5);
    expect(small[2]).toBeCloseTo(big[2] as number, 5);

    // Contrast: the naive frame-rate-DEPENDENT lerp(current, target, rate·dt) does NOT compose —
    // this is exactly the footgun smoothDamp folds. Prove the drift is real, not negligible.
    const naiveBig = vec3.create();
    vec3.lerp(naiveBig, current, target, decay * dt);
    const naiveSmall = vec3.create();
    vec3.copy(naiveSmall, current);
    vec3.lerp(naiveSmall, naiveSmall, target, decay * (dt / 2));
    vec3.lerp(naiveSmall, naiveSmall, target, decay * (dt / 2));
    const naiveDrift = Math.abs((naiveBig[0] as number) - (naiveSmall[0] as number));
    expect(naiveDrift).toBeGreaterThan(0.1); // meaningfully different — the bug smoothDamp removes
  });
});

describe('vec3.smoothDamp — aliasing-safe', () => {
  it('out === current gives the correct result', () => {
    const p = vec3.create();
    vec3.set(p, 1, 2, 3);
    vec3.smoothDamp(p, p, [5, 5, 5], 3, 1 / 60);
    const f = 1 - Math.exp(-3 / 60);
    expect(p[0]).toBeCloseTo(1 + (5 - 1) * f, 6);
    expect(p[1]).toBeCloseTo(2 + (5 - 2) * f, 6);
    expect(p[2]).toBeCloseTo(3 + (5 - 3) * f, 6);
  });

  it('out === target gives the correct result', () => {
    const t = vec3.create();
    vec3.set(t, 5, 5, 5);
    vec3.smoothDamp(t, [1, 2, 3], t, 3, 1 / 60);
    const f = 1 - Math.exp(-3 / 60);
    expect(t[0]).toBeCloseTo(1 + (5 - 1) * f, 6);
    expect(t[1]).toBeCloseTo(2 + (5 - 2) * f, 6);
    expect(t[2]).toBeCloseTo(3 + (5 - 3) * f, 6);
  });
});

describe('vec2 / vec4 smoothDamp — symmetric surface', () => {
  it('vec2.smoothDamp matches the per-component formula', () => {
    const out = vec2.create();
    const current: Vec2Like = [1, 2];
    const target: Vec2Like = [9, -3];
    const decay = 2.5;
    const dt = 1 / 60;
    const f = 1 - Math.exp(-decay * dt);
    vec2.smoothDamp(out, current, target, decay, dt);
    expect(out[0]).toBeCloseTo(1 + (9 - 1) * f, 6);
    expect(out[1]).toBeCloseTo(2 + (-3 - 2) * f, 6);
  });

  it('vec4.smoothDamp matches the per-component formula', () => {
    const out = vec4.create();
    const current: Vec4Like = [1, 2, 3, 4];
    const target: Vec4Like = [9, -3, 0, 8];
    const decay = 2.5;
    const dt = 1 / 60;
    const f = 1 - Math.exp(-decay * dt);
    vec4.smoothDamp(out, current, target, decay, dt);
    expect(out[0]).toBeCloseTo(1 + (9 - 1) * f, 6);
    expect(out[1]).toBeCloseTo(2 + (-3 - 2) * f, 6);
    expect(out[2]).toBeCloseTo(3 + (0 - 3) * f, 6);
    expect(out[3]).toBeCloseTo(4 + (8 - 4) * f, 6);
  });
});
