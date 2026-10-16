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
  // --- from sphere.test.ts ---
// Sphere unit tests — TDD red phase (feat-20260511-asset-system-v1 M3 / w7).
//
// Sphere is a bounding sphere stored as 4 f32 [cx, cy, cz, radius];
// pure-function surface aligned with packages/math branded ABI + SoA style.
// Surface (5 ops per plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Three tiers per test group: normal / boundary / degenerate.
// Related: requirements §AC-16 (Box3 / Sphere pure functions); plan-strategy M3 range;
//          plan-tasks.json w7 acceptanceCheck.


describe('sphere.create', () => {
  it('returns Float32Array length 4 with zero-radius origin by default (normal)', () => {
    const s = sphere.create();
    expect(s).toBeInstanceOf(Float32Array);
    expect(s.length).toBe(4);
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(0);
    expect(s[2]).toBe(0);
    expect(s[3]).toBe(0);
  });

  it('accepts explicit center + radius (boundary)', () => {
    const s = sphere.create(1, 2, 3, 4);
    expect(Array.from(s)).toEqual([1, 2, 3, 4]);
  });

  it('negative radius stored verbatim and treated as empty sphere (degenerate)', () => {
    const s = sphere.create(0, 0, 0, -1);
    expect(s[3]).toBe(-1);
    expect(sphere.containsPoint(s, [0, 0, 0])).toBe(false);
  });
});

describe('sphere.expandByPoint', () => {
  it('grows radius so the point sits on the new surface (normal)', () => {
    const s = sphere.create(0, 0, 0, 0);
    const ret = sphere.expandByPoint(s, [3, 4, 0]);
    expect(ret).toBe(s);
    // distance from origin to (3,4,0) = 5
    expect(s[3]).toBe(5);
    expect(s[0]).toBe(0);
  });

  it('point inside existing sphere leaves radius unchanged (boundary)', () => {
    const s = sphere.create(0, 0, 0, 10);
    sphere.expandByPoint(s, [1, 1, 1]);
    expect(s[3]).toBe(10);
  });

  it('negative-radius sphere treated as empty and collapses to zero radius at the point (degenerate)', () => {
    const s = sphere.create(1, 2, 3, -1);
    sphere.expandByPoint(s, [1, 2, 3]);
    expect(s[0]).toBe(1);
    expect(s[1]).toBe(2);
    expect(s[2]).toBe(3);
    expect(s[3]).toBe(0);
  });
});

describe('sphere.containsPoint', () => {
  it('returns true for point strictly inside (normal)', () => {
    const s = sphere.create(0, 0, 0, 2);
    expect(sphere.containsPoint(s, [1, 0, 0])).toBe(true);
  });

  it('point on the surface is considered inside (boundary)', () => {
    const s = sphere.create(0, 0, 0, 3);
    expect(sphere.containsPoint(s, [3, 0, 0])).toBe(true);
    expect(sphere.containsPoint(s, [0, -3, 0])).toBe(true);
  });

  it('point outside is rejected and zero-radius sphere contains only its center (degenerate)', () => {
    const s = sphere.create(0, 0, 0, 1);
    expect(sphere.containsPoint(s, [2, 0, 0])).toBe(false);
    const z = sphere.create(5, 5, 5, 0);
    expect(sphere.containsPoint(z, [5, 5, 5])).toBe(true);
    expect(sphere.containsPoint(z, [5, 5, 6])).toBe(false);
  });
});

describe('sphere.intersectsBox', () => {
  it('sphere overlapping box intersects (normal)', () => {
    const s = sphere.create(0, 0, 0, 2);
    const b = box3.create(1, 1, 1, 3, 3, 3);
    expect(sphere.intersectsBox(s, b)).toBe(true);
  });

  it('sphere touching box face intersects (boundary)', () => {
    const s = sphere.create(2, 0, 0, 1);
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(sphere.intersectsBox(s, b)).toBe(true);
  });

  it('sphere far from box does not intersect (degenerate)', () => {
    const s = sphere.create(10, 10, 10, 1);
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(sphere.intersectsBox(s, b)).toBe(false);
  });
});

describe('sphere.fromPoints', () => {
  it('builds an enclosing sphere for 3 coplanar points (normal)', () => {
    const out = sphere.create();
    const ret = sphere.fromPoints(out, [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
    ]);
    expect(ret).toBe(out);
    // every input point must lie inside (boundary inclusive)
    expect(sphere.containsPoint(out, [1, 0, 0])).toBe(true);
    expect(sphere.containsPoint(out, [-1, 0, 0])).toBe(true);
    expect(sphere.containsPoint(out, [0, 1, 0])).toBe(true);
  });

  it('single point produces zero-radius sphere centered on that point (boundary)', () => {
    const out = sphere.create();
    sphere.fromPoints(out, [[7, -2, 5]]);
    expect(Array.from(out)).toEqual([7, -2, 5, 0]);
  });

  it('empty points array leaves an empty sphere (origin + negative-sentinel radius) (degenerate)', () => {
    const out = sphere.create();
    sphere.fromPoints(out, []);
    expect(out[3]).toBeLessThanOrEqual(0);
    expect(sphere.containsPoint(out, [0, 0, 0])).toBe(false);
  });
});

}