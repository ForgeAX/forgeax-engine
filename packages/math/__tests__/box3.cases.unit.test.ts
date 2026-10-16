// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/math/src/__tests__/box3.test.ts
//   - packages/math/src/__tests__/color.test.ts
//   - packages/math/src/__tests__/euler.test.ts
//   - packages/math/src/__tests__/f32-to-f16-bytes.test.ts
//   - packages/math/src/__tests__/frustum.test.ts
//   - packages/math/src/__tests__/mat3.test.ts
//   - packages/math/src/__tests__/mat4.test.ts
//   - packages/math/src/__tests__/quat.test.ts
//   - packages/math/src/__tests__/ray.test.ts
//   - packages/math/src/__tests__/sphere.test.ts
//   - packages/math/src/__tests__/vec2.test.ts
//   - packages/math/src/__tests__/vec3.test.ts
//   - packages/math/src/__tests__/vec4.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// import paths adjusted: ../X -> ../src/X (output is __tests__/, sources were src/__tests__/).

import { describe, expect, it } from 'vitest';
import * as box3 from '../src/box3';
import * as color from '../src/color';
import * as euler from '../src/euler';
import * as frustum from '../src/frustum';
import * as mat3 from '../src/mat3';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as ray from '../src/ray';
import * as sphere from '../src/sphere';
import * as vec2 from '../src/vec2';
import * as vec3 from '../src/vec3';
import * as vec4 from '../src/vec4';
import { halfFloat } from '../src/index.js';
import type { EulerOrder, Mat3 as Mat3T, Mat4 as Mat4T, Vec3 as Vec3T } from '../src/types';
import {
  PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED,
  PERSPECTIVE_REVERSE_Z_FINITE_INPUT,
  PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED,
  REVERSE_Z_FIXTURE_TOLERANCE,
  REVERSE_Z_PROJECTION_PROBES_FINITE,
  REVERSE_Z_PROJECTION_PROBES_INFINITE,
} from '../src/__tests__/_fixtures';

void [PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED, PERSPECTIVE_REVERSE_Z_FINITE_INPUT, PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED, REVERSE_Z_FIXTURE_TOLERANCE, REVERSE_Z_PROJECTION_PROBES_FINITE, REVERSE_Z_PROJECTION_PROBES_INFINITE, box3, color, describe, euler, expect, frustum, halfFloat, it, mat3, mat4, quat, ray, sphere, vec2, vec3, vec4];
type __MergedKeep = EulerOrder | Mat3T | Mat4T | Vec3T;



{
  // --- from box3.test.ts ---
// Box3 unit tests — TDD red phase (feat-20260511-asset-system-v1 M3 / w7).
//
// Box3 is an axis-aligned bounding box stored as 6 f32 [minX, minY, minZ, maxX, maxY, maxZ];
// pure-function surface aligned with packages/math branded ABI + SoA style.
// Surface (5 ops per plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Three tiers per test group: normal / boundary / degenerate.
// Related: requirements §AC-16 (Box3 / Sphere pure functions); plan-strategy M3 range;
//          plan-tasks.json w7 acceptanceCheck.


describe('box3.create', () => {
  it('returns Float32Array length 6 with inverted-infinity (empty) box by default (normal)', () => {
    const b = box3.create();
    expect(b).toBeInstanceOf(Float32Array);
    expect(b.length).toBe(6);
    // min = +Infinity, max = -Infinity so expandByPoint on any finite point collapses to that point
    expect(b[0]).toBe(Number.POSITIVE_INFINITY);
    expect(b[1]).toBe(Number.POSITIVE_INFINITY);
    expect(b[2]).toBe(Number.POSITIVE_INFINITY);
    expect(b[3]).toBe(Number.NEGATIVE_INFINITY);
    expect(b[4]).toBe(Number.NEGATIVE_INFINITY);
    expect(b[5]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('accepts explicit min / max components (boundary)', () => {
    const b = box3.create(-1, -2, -3, 4, 5, 6);
    expect(Array.from(b)).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it('zero-volume box (min == max) is allowed (degenerate)', () => {
    const b = box3.create(1, 2, 3, 1, 2, 3);
    expect(Array.from(b)).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe('box3.expandByPoint', () => {
  it('grows an empty box to a zero-volume box containing the point (normal)', () => {
    const b = box3.create();
    const ret = box3.expandByPoint(b, [1, 2, 3]);
    expect(ret).toBe(b);
    expect(Array.from(b)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('expands min and max independently per axis (boundary)', () => {
    const b = box3.create(0, 0, 0, 1, 1, 1);
    box3.expandByPoint(b, [-2, 0.5, 5]);
    expect(Array.from(b)).toEqual([-2, 0, 0, 1, 1, 5]);
  });

  it('point inside box leaves box unchanged (degenerate)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    box3.expandByPoint(b, [0, 0, 0]);
    expect(Array.from(b)).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});

describe('box3.containsPoint', () => {
  it('returns true for point strictly inside (normal)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [0, 0, 0])).toBe(true);
  });

  it('point on the boundary is considered inside (boundary)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [1, 1, 1])).toBe(true);
    expect(box3.containsPoint(b, [-1, -1, -1])).toBe(true);
  });

  it('point outside any axis is rejected (degenerate)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [2, 0, 0])).toBe(false);
    expect(box3.containsPoint(b, [0, -2, 0])).toBe(false);
    expect(box3.containsPoint(b, [0, 0, 2])).toBe(false);
  });

  it('empty (inverted-infinity) box contains nothing (degenerate)', () => {
    const b = box3.create();
    expect(box3.containsPoint(b, [0, 0, 0])).toBe(false);
  });
});

describe('box3.intersectsBox', () => {
  it('overlapping boxes intersect (normal)', () => {
    const a = box3.create(0, 0, 0, 2, 2, 2);
    const b = box3.create(1, 1, 1, 3, 3, 3);
    expect(box3.intersectsBox(a, b)).toBe(true);
  });

  it('touching boxes (shared face) intersect (boundary)', () => {
    const a = box3.create(0, 0, 0, 1, 1, 1);
    const b = box3.create(1, 0, 0, 2, 1, 1);
    expect(box3.intersectsBox(a, b)).toBe(true);
  });

  it('disjoint boxes do not intersect (degenerate)', () => {
    const a = box3.create(0, 0, 0, 1, 1, 1);
    const b = box3.create(2, 0, 0, 3, 1, 1);
    expect(box3.intersectsBox(a, b)).toBe(false);
  });
});

describe('box3.fromPoints', () => {
  it('builds tightest AABB from 3 points (normal)', () => {
    const out = box3.create();
    const ret = box3.fromPoints(out, [
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 3],
    ]);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it('single point produces zero-volume box (boundary)', () => {
    const out = box3.create();
    box3.fromPoints(out, [[5, -5, 5]]);
    expect(Array.from(out)).toEqual([5, -5, 5, 5, -5, 5]);
  });

  it('empty points array leaves the inverted-infinity empty box (degenerate)', () => {
    const out = box3.create();
    box3.fromPoints(out, []);
    expect(out[0]).toBe(Number.POSITIVE_INFINITY);
    expect(out[3]).toBe(Number.NEGATIVE_INFINITY);
  });
});

// === transformBox3 (M1 / w1) ===
//
// Conservative 8-corner method: transform all 8 corners of the AABB by the 4x4 matrix,
// then compute a new AABB that encloses all transformed corners.
// Signature: transformBox3(out: Box3, box: Box3Like, m: Mat4Like): Box3
// Out-param first, aliasing-safe, returns out.

describe('box3.transformBox3', () => {
  it('identity matrix leaves box unchanged (normal)', () => {
    const box = box3.create(-1, -2, -3, 4, 5, 6);
    const m = mat4.identity(mat4.create());
    const out = box3.create();
    const ret = box3.transformBox3(out, box, m);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it('translation shifts box by offset (normal)', () => {
    const box = box3.create(0, 0, 0, 2, 2, 2);
    const m = mat4.fromTranslation(mat4.create(), [3, -1, 5]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([3, -1, 5, 5, 1, 7]);
  });

  it('uniform scale expands box proportionally (normal)', () => {
    const box = box3.create(1, 2, 3, 4, 5, 6);
    const m = mat4.fromScaling(mat4.create(), [2, 2, 2]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('non-uniform scale expands axes independently (normal)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    const m = mat4.fromScaling(mat4.create(), [2, 0.5, 3]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([-2, -0.5, -3, 2, 0.5, 3]);
  });

  it('rotation by 45 degrees around Y axis expands box conservatively (boundary)', () => {
    // box = [1,0,0] to [2,1,1], rotated 45 deg around Y
    // 8-corner transform: x' = c*x + s*z, z' = -s*x + c*z (c=s~0.7071)
    // All corners have z' <= 0 (rotated box is entirely at or below z=0)
    const box = box3.create(1, 0, 0, 2, 1, 1);
    const m = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 4);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    // min ~ (0.707, 0, -1.414), max ~ (2.121, 1, 0)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(-Math.SQRT2, 3);
    expect(out[3]).toBeCloseTo(Math.SQRT2 + Math.SQRT1_2, 3);
    expect(out[4]).toBe(1);
    expect(out[5]).toBeCloseTo(0, 4);
  });

  it('rotation by 90 degrees around Z swaps min/max extents (boundary)', () => {
    // box from (1,0,0) to (3,2,1), rotated 90 deg around Z:
    // (x,y) -> (-y,x), so x-range [-2, 0], y-range [1, 3]
    const box = box3.create(1, 0, 0, 3, 2, 1);
    const m = mat4.fromRotation(mat4.create(), [0, 0, 1], Math.PI / 2);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(out[0]).toBeCloseTo(-2, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[3]).toBeCloseTo(0, 5);
    expect(out[4]).toBeCloseTo(3, 5);
  });

  it('scale + translate composite transform (normal)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    // T * S: scale first then translate
    // x: [-1,1]*2+5 = [3,7]; y: [-1,1]*3+0 = [-3,3]; z: [-1,1]*1 = [-1,1]
    const t = mat4.fromTranslation(mat4.create(), [5, 0, 0]);
    const s = mat4.fromScaling(mat4.create(), [2, 3, 1]);
    const m = mat4.create();
    mat4.multiply(m, t, s);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([3, -3, -1, 7, 3, 1]);
  });

  it('zero-volume box (min == max) transforms to correct position (degenerate)', () => {
    const box = box3.create(1, 2, 3, 1, 2, 3);
    const m = mat4.fromTranslation(mat4.create(), [10, -5, 0]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([11, -3, 3, 11, -3, 3]);
  });

  it('zero scale collapses box to a point at origin (degenerate)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    const m = mat4.fromScaling(mat4.create(), [0, 0, 0]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    // All 8 corners map to (0,0,0), so AABB is a zero-volume box at origin
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('negative scales reorder every axis without losing extrema', () => {
    const box = box3.create(-1, -2, -3, 4, 5, 6);
    const matrix = mat4.fromScaling(mat4.create(), [-2, 3, -0.5]);
    expect(Array.from(box3.transformBox3(box, box, matrix))).toEqual([-8, -6, -3, 2, 15, 1.5]);
  });

  it('divides homogeneous corners before enclosing a projective transform', () => {
    const box = box3.create(0, 0, 0, 1, 2, 3);
    const matrix = mat4.identity(mat4.create());
    matrix[3] = 1;
    expect(Array.from(box3.transformBox3(box, box, matrix))).toEqual([0, 0, 0, 0.5, 2, 3]);
  });

  it('preserves undivided coordinates at a zero homogeneous weight', () => {
    const box = box3.create(0, 0, 0, 1, 2, 3);
    const matrix = mat4.identity(mat4.create());
    matrix[3] = 1;
    matrix[15] = 0;
    expect(Array.from(box3.transformBox3(box, box, matrix))).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it('out may alias box (aliasing-safe)', () => {
    const box = box3.create(0, 0, 0, 1, 1, 1);
    const m = mat4.fromTranslation(mat4.create(), [2, 0, 0]);
    // box is both input and output — must be read before overwritten
    box3.transformBox3(box, box, m);
    expect(Array.from(box)).toEqual([2, 0, 0, 3, 1, 1]);
  });
});

}