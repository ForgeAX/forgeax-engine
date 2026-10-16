// mat4.test.ts — mat4 unit tests (feat-20260617-host-engine-contract-and-video-cutscene M2 w4)
//
// Coverage: computeViewProj elementwise equals hand-computed mat4.perspective * mat4.lookAt
// (EPS_MAT4_MUL3 = 1e-3), >= 3 param combos. Multiple fov/aspect/near/far and eye/target poses.
// Test must NOT import any runtime type (zero-dep guard, plan-strategy §5.6).
//
// TDD: this file is committed RED (computeViewProj not yet implemented in mat4.ts);
// w6 implementation greens these tests.
//
// Related: requirements AC-03; plan-strategy D-1; research Finding 4/5.

import { describe, expect, it } from 'vitest';
import * as mat4 from '../mat4';
import type { Mat4 } from '../types';

// ============================================================
// Helpers
// ============================================================

/** element-wise approximate equality with relative scaling */
function mat4ApproxEq(a: Float32Array, b: Float32Array, eps: number): boolean {
  for (let i = 0; i < 16; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    const scale = Math.max(1, Math.abs(ai), Math.abs(bi));
    if (Math.abs(ai - bi) >= eps * scale) return false;
  }
  return true;
}

const EPS_MAT4_MUL3 = 1e-3;

/** Build VP via hand-composed lookAt + perspective + multiply (the reference). */
function refVP(
  out: Mat4,
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
  fov: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const view = mat4.lookAt(mat4.create(), eye, target, up);
  const proj = mat4.perspective(mat4.create(), fov, aspect, near, far);
  return mat4.multiply(out, proj, view);
}

// ============================================================
// Param combo 1: default forward-looking camera
// ============================================================

describe('mat4.computeViewProj', () => {
  it('combo 1: camera at origin, looking at -z → equals proj * lookAt', () => {
    const eye: [number, number, number] = [0, 0, 0];
    const target: [number, number, number] = [0, 0, -1];
    const up: [number, number, number] = [0, 1, 0];
    const fov = Math.PI / 3;
    const aspect = 800 / 600;
    const near = 0.1;
    const far = 100;

    const result = mat4.create();
    mat4.computeViewProj(result, eye, target, up, fov, aspect, near, far);

    const expected = mat4.create();
    refVP(expected, eye, target, up, fov, aspect, near, far);

    expect(mat4ApproxEq(result, expected, EPS_MAT4_MUL3)).toBe(true);
  });

  // ============================================================
  // Param combo 2: elevated camera looking at world origin
  // ============================================================

  it('combo 2: elevated camera looking at origin → equals proj * lookAt', () => {
    const eye: [number, number, number] = [0, 5, 10];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const fov = Math.PI / 4;
    const aspect = 16 / 9;
    const near = 0.1;
    const far = 100;

    const result = mat4.create();
    mat4.computeViewProj(result, eye, target, up, fov, aspect, near, far);

    const expected = mat4.create();
    refVP(expected, eye, target, up, fov, aspect, near, far);

    expect(mat4ApproxEq(result, expected, EPS_MAT4_MUL3)).toBe(true);
  });

  // ============================================================
  // Param combo 3: off-axis camera with narrow FOV and large near/far
  // ============================================================

  it('combo 3: off-axis camera, narrow fov, large range → equals proj * lookAt', () => {
    const eye: [number, number, number] = [10, 3, -20];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0.5];
    const fov = Math.PI / 6; // 30 deg — narrow
    const aspect = 4 / 3;
    const near = 1;
    const far = 500;

    const result = mat4.create();
    mat4.computeViewProj(result, eye, target, up, fov, aspect, near, far);

    const expected = mat4.create();
    refVP(expected, eye, target, up, fov, aspect, near, far);

    expect(mat4ApproxEq(result, expected, EPS_MAT4_MUL3)).toBe(true);
  });

  // ============================================================
  // Param combo 4: infinite far plane
  // ============================================================

  it('combo 4: infinite far plane → equals proj * lookAt', () => {
    const eye: [number, number, number] = [0, 0, 0];
    const target: [number, number, number] = [0, 0, -1];
    const up: [number, number, number] = [0, 1, 0];
    const fov = Math.PI / 3;
    const aspect = 800 / 600;
    const near = 0.1;
    const far = Number.POSITIVE_INFINITY;

    const result = mat4.create();
    mat4.computeViewProj(result, eye, target, up, fov, aspect, near, far);

    const expected = mat4.create();
    refVP(expected, eye, target, up, fov, aspect, near, far);

    expect(mat4ApproxEq(result, expected, EPS_MAT4_MUL3)).toBe(true);
  });

  // ============================================================
  // Param combo 5: close-to-identity view (eye almost on target → identity)
  // ============================================================

  it('combo 5: degenerate eye=target → lookAt returns identity, VP = proj * I = proj', () => {
    const eye: [number, number, number] = [0, 0, 0];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const fov = Math.PI / 3;
    const aspect = 800 / 600;
    const near = 0.1;
    const far = 100;

    const result = mat4.create();
    mat4.computeViewProj(result, eye, target, up, fov, aspect, near, far);

    // When eye=target, lookAt returns identity → VP = proj * I = proj
    const expected = mat4.create();
    mat4.perspective(expected, fov, aspect, near, far);

    expect(mat4ApproxEq(result, expected, EPS_MAT4_MUL3)).toBe(true);
  });
});

void expect;
