// quat.rotateaxis.test.ts — value tests for quat.rotateAxis (solo round 20260713-164916)
//
// Regression guard for the friction that motivated the helper: incrementally rotating an entity
// each frame required hand-wiring `multiply(q, fromAxisAngle(axis, θ), q)`, and because that loop
// never re-normalizes, floating-point error accumulates over thousands of frames into a non-unit
// quaternion (skew / scale artefacts). Demos worked around it (raw sin/cos literals, or an
// absolute-angle accumulator that can't compose onto an existing orientation). These tests pin:
//   1. rotateAxis matches the correct hand-wired normalize(multiply(delta, q)) chain,
//   2. the delta is PRE-multiplied (world-space axis, matching Bevy Transform::rotate order),
//   3. a full 2π rotation returns to the start orientation,
//   4. aliasing rotateAxis(q, q, ...) is correct (the common in-place per-frame call),
//   5. WITNESS: the naive un-normalized multiply loop drifts off unit length; rotateAxis does not,
//   6. the documented degrade case (zero-length axis → normalize(q), no rotation).

import { describe, expect, it } from 'vitest';
import * as quat from '../quat';
import type { QuatLike, Vec3Like } from '../types';

const EPS = 1e-5;

/** quat double-cover: q and -q are the same rotation. Compare via |dot| ≈ 1. */
function sameRotation(a: QuatLike, b: QuatLike): boolean {
  const d =
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number) +
    (a[3] as number) * (b[3] as number);
  return Math.abs(Math.abs(d) - 1) < EPS;
}

/** The correct hand-wired chain the helper replaces: normalize(delta * q). */
function handWired(q: QuatLike, axis: Vec3Like, angle: number): Float32Array {
  const delta = quat.fromAxisAngle(quat.create(), axis, angle);
  return quat.normalize(quat.create(), quat.multiply(quat.create(), delta, q));
}

const Y: Vec3Like = [0, 1, 0];

describe('quat.rotateAxis', () => {
  const cases: Array<{ name: string; start: () => Float32Array; axis: Vec3Like; angle: number }> = [
    {
      name: 'identity + Y π/2',
      start: () => quat.identity(quat.create()),
      axis: Y,
      angle: Math.PI / 2,
    },
    {
      name: 'identity + X π/3',
      start: () => quat.identity(quat.create()),
      axis: [1, 0, 0],
      angle: Math.PI / 3,
    },
    {
      name: 'non-identity start + Z π/4',
      start: () => quat.fromAxisAngle(quat.create(), Y, 0.7),
      axis: [0, 0, 1],
      angle: Math.PI / 4,
    },
    {
      name: 'unnormalized axis (2Y) π/2',
      start: () => quat.identity(quat.create()),
      axis: [0, 2, 0],
      angle: Math.PI / 2,
    },
  ];

  for (const c of cases) {
    it(`matches the hand-wired normalize(delta * q) chain (${c.name})`, () => {
      const helper = quat.rotateAxis(quat.create(), c.start(), c.axis, c.angle);
      const chain = handWired(c.start(), c.axis, c.angle);
      expect(sameRotation(helper, chain)).toBe(true);
    });

    it(`stays unit length (${c.name})`, () => {
      const q = quat.rotateAxis(quat.create(), c.start(), c.axis, c.angle);
      expect(quat.length(q)).toBeCloseTo(1, 5);
    });
  }

  it('PRE-multiplies the delta (world-space axis, Bevy Transform::rotate order): delta*q ≠ q*delta', () => {
    // Start with a rotation about X, then rotate about Y. Order matters for non-commuting axes.
    const start = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);
    const helper = quat.rotateAxis(quat.create(), start, Y, Math.PI / 2);
    const pre = quat.normalize(
      quat.create(),
      quat.multiply(quat.create(), quat.fromAxisAngle(quat.create(), Y, Math.PI / 2), start),
    );
    const post = quat.normalize(
      quat.create(),
      quat.multiply(quat.create(), start, quat.fromAxisAngle(quat.create(), Y, Math.PI / 2)),
    );
    expect(sameRotation(helper, pre)).toBe(true);
    // The two orders genuinely differ for these axes — pins that we chose pre, not post.
    expect(sameRotation(pre, post)).toBe(false);
  });

  it('a full 2π rotation returns to the starting orientation', () => {
    const start = quat.fromAxisAngle(quat.create(), [1, 0, 0], 0.9);
    const out = quat.rotateAxis(quat.create(), start, Y, Math.PI * 2);
    expect(sameRotation(out, start)).toBe(true);
  });

  it('is aliasing-safe: rotateAxis(q, q, ...) matches the non-aliased result', () => {
    const a = quat.fromAxisAngle(quat.create(), Y, 0.3);
    const b = quat.clone(a);
    const aliased = quat.rotateAxis(a, a, [1, 0, 0], 0.5);
    const separate = quat.rotateAxis(quat.create(), b, [1, 0, 0], 0.5);
    expect(sameRotation(aliased, separate)).toBe(true);
    expect(quat.length(aliased)).toBeCloseTo(1, 5);
  });

  it('WITNESS: naive un-normalized multiply loop drifts off unit length; rotateAxis does not', () => {
    const N = 10000;
    const step = 0.017; // small per-"frame" angle
    // Control: the buggy hand-rolled loop demos worked around — multiply only, never normalize.
    const naive = quat.identity(quat.create());
    for (let i = 0; i < N; i++) {
      const delta = quat.fromAxisAngle(quat.create(), Y, step);
      quat.multiply(naive, delta, naive);
    }
    const naiveErr = Math.abs(quat.length(naive) - 1);

    // rotateAxis: identical math + the normalize the naive loop omits.
    const safe = quat.identity(quat.create());
    for (let i = 0; i < N; i++) {
      quat.rotateAxis(safe, safe, Y, step);
    }
    const safeErr = Math.abs(quat.length(safe) - 1);

    // The naive loop's unit-length error accumulates; rotateAxis re-normalizes every step so its
    // error stays at machine epsilon. The friction is real (naive drifts) and the helper removes it:
    // rotateAxis is strictly tighter to unit length, by orders of magnitude.
    expect(naiveErr).toBeGreaterThan(1e-6); // measurable drift in the un-normalized loop
    expect(safeErr).toBeLessThan(1e-6); // rotateAxis holds unit length
    expect(safeErr).toBeLessThan(naiveErr); // the helper is strictly better
  });

  it('degrade: zero-length axis → out = normalize(q), no rotation applied (registry #8)', () => {
    const start = quat.fromAxisAngle(quat.create(), Y, 0.6);
    const out = quat.rotateAxis(quat.create(), start, [0, 0, 0], 1.23);
    expect(sameRotation(out, start)).toBe(true);
    expect(quat.length(out)).toBeCloseTo(1, 5);
  });

  it('produces no NaN components', () => {
    const out = quat.rotateAxis(quat.create(), quat.identity(quat.create()), Y, 0.5);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(out[i] as number)).toBe(false);
  });
});
