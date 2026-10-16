// vec-catmull-rom.test.ts — value tests for vec2/vec3.catmullRom (solo round 20260713-203432)
//
// Regression guard for the friction that motivated the sampler: a smooth curve through
// control points (Bevy CubicCardinalSpline::new_catmull_rom, three.js CatmullRomCurve3)
// forced hand-rolling the cubic coefficient matrix (tension, basis, control-point
// windowing — all easy to get wrong). catmullRom folds the Catmull-Rom (tension 0.5)
// position basis. These tests pin:
//   1. endpoint interpolation: t=0 → p1, t=1 → p2 (the defining Catmull-Rom property),
//   2. matches the explicit coefficient formula per component,
//   3. collinear equally-spaced control points → linear interpolation (straight stays straight),
//   4. midpoint value for a known symmetric control set,
//   5. aliasing-safe (out === an input point),
//   6. vec2 + vec3 symmetric.

import { describe, expect, it } from 'vitest';
import type { Vec2Like, Vec3Like } from '../types';
import * as vec2 from '../vec2';
import * as vec3 from '../vec3';

// Reference scalar Catmull-Rom (tension 0.5) for cross-checking.
function crScalar(a: number, b: number, c: number, d: number, t: number): number {
  const c0 = b;
  const c1 = 0.5 * (c - a);
  const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
  const c3 = -0.5 * a + 1.5 * b - 1.5 * c + 0.5 * d;
  return c0 + c1 * t + c2 * t * t + c3 * t * t * t;
}

describe('vec3.catmullRom — endpoint interpolation', () => {
  it('t=0 → p1, t=1 → p2 (passes through the control points)', () => {
    const p0: Vec3Like = [0, 0, 0];
    const p1: Vec3Like = [1, 2, 3];
    const p2: Vec3Like = [4, 0, -1];
    const p3: Vec3Like = [5, 5, 5];
    const out = vec3.create();

    vec3.catmullRom(out, p0, p1, p2, p3, 0);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(2, 6);
    expect(out[2]).toBeCloseTo(3, 6);

    vec3.catmullRom(out, p0, p1, p2, p3, 1);
    expect(out[0]).toBeCloseTo(4, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(-1, 6);
  });

  it('matches the explicit coefficient formula per component at several t', () => {
    const p0: Vec3Like = [-1, 2, 0.5];
    const p1: Vec3Like = [3, -2, 1];
    const p2: Vec3Like = [5, 3, -4];
    const p3: Vec3Like = [9, 8, 2];
    const out = vec3.create();
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      vec3.catmullRom(out, p0, p1, p2, p3, t);
      expect(out[0]).toBeCloseTo(crScalar(-1, 3, 5, 9, t), 5);
      expect(out[1]).toBeCloseTo(crScalar(2, -2, 3, 8, t), 5);
      expect(out[2]).toBeCloseTo(crScalar(0.5, 1, -4, 2, t), 5);
    }
  });
});

describe('vec3.catmullRom — geometric properties', () => {
  it('collinear equally-spaced control points reduce to linear interpolation', () => {
    // Points on a straight line, equally spaced → the Catmull-Rom segment between p1,p2
    // is exactly the straight segment (a well-known Catmull-Rom property).
    const p0: Vec3Like = [0, 0, 0];
    const p1: Vec3Like = [1, 1, 1];
    const p2: Vec3Like = [2, 2, 2];
    const p3: Vec3Like = [3, 3, 3];
    const out = vec3.create();
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      vec3.catmullRom(out, p0, p1, p2, p3, t);
      const expected = 1 + t; // linear from p1=(1,1,1) to p2=(2,2,2)
      expect(out[0]).toBeCloseTo(expected, 5);
      expect(out[1]).toBeCloseTo(expected, 5);
      expect(out[2]).toBeCloseTo(expected, 5);
    }
  });

  it('midpoint of a symmetric control set is the known Catmull-Rom value', () => {
    // Symmetric 1D control points 0,0,1,1 → midpoint t=0.5 value is 0.5 by symmetry.
    const out = vec3.create();
    vec3.catmullRom(out, [0, 0, 0], [0, 0, 0], [1, 1, 1], [1, 1, 1], 0.5);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });
});

describe('vec3.catmullRom — aliasing-safe', () => {
  it('out === p1 gives the correct result', () => {
    const p1 = vec3.create();
    vec3.set(p1, 1, 2, 3);
    vec3.catmullRom(p1, [0, 0, 0], p1, [4, 0, -1], [5, 5, 5], 0.5);
    const ex0 = crScalar(0, 1, 4, 5, 0.5);
    const ex1 = crScalar(0, 2, 0, 5, 0.5);
    const ex2 = crScalar(0, 3, -1, 5, 0.5);
    expect(p1[0]).toBeCloseTo(ex0, 6);
    expect(p1[1]).toBeCloseTo(ex1, 6);
    expect(p1[2]).toBeCloseTo(ex2, 6);
  });
});

describe('vec2.catmullRom — symmetric surface', () => {
  it('endpoint interpolation + formula match', () => {
    const p0: Vec2Like = [-1, 2];
    const p1: Vec2Like = [3, -2];
    const p2: Vec2Like = [5, 3];
    const p3: Vec2Like = [9, 8];
    const out = vec2.create();

    vec2.catmullRom(out, p0, p1, p2, p3, 0);
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[1]).toBeCloseTo(-2, 6);

    vec2.catmullRom(out, p0, p1, p2, p3, 1);
    expect(out[0]).toBeCloseTo(5, 6);
    expect(out[1]).toBeCloseTo(3, 6);

    vec2.catmullRom(out, p0, p1, p2, p3, 0.35);
    expect(out[0]).toBeCloseTo(crScalar(-1, 3, 5, 9, 0.35), 5);
    expect(out[1]).toBeCloseTo(crScalar(2, -2, 3, 8, 0.35), 5);
  });
});
