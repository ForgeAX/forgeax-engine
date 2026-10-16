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
  // --- from frustum.test.ts ---
// Frustum unit tests — TDD red phase (feat-20260528-frustum-culling M1 / w3).
//
// From plan-strategy D-6: plane normalization is built into fromViewProjection internally.
// Frustum storage: Float32Array(24) — 6 planes × 4 floats (nx, ny, nz, d), normalized.
// Plane equation: nx*x + ny*y + nz*z + d = 0. Positive side = in front (inside frustum).
//
// Surface: fromViewProjection / intersectsBox / intersectsSphere.
//
// Related: requirements §AC-01 (frustum function signatures + test coverage);
//          plan-strategy §D-6 (internal normalization).


describe('frustum.fromViewProjection', () => {
  it('extracts 6 planes from a perspective VP matrix (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 10);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(24);
  });

  it('near plane faces the camera (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 10);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Near plane normal points toward camera: ~(0, 0, -1) (into screen)
    // A point at (0,0,2) should be inside the frustum (between near=1 and far=10, looking at origin)
    const d = f[11]; // near plane d
    expect(d).toBeGreaterThan(0);
  });

  it('origin should be inside a perspective frustum looking at origin (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // origin (0,0,0) should be inside
    const box = box3.create(-0.01, -0.01, -0.01, 0.01, 0.01, 0.01);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('extracts planes from orthographic VP (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.orthographic(mat4.create(), -5, 5, 5, -5, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Near plane should reject a point behind the camera
    const nearBox = box3.create(-1, -1, -100, 1, 1, -99);
    expect(frustum.intersectsBox(f, nearBox)).toBe(false);
  });

  it('degenerate zero matrix produces valid (but nonsensical) planes (degenerate)', () => {
    const vp = mat4.create(); // all zeros
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Should not throw; produces planes (may be degenerate but function must not crash)
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(24);
  });

  it('returns out parameter', () => {
    const out = frustum.create();
    const vp = mat4.identity(mat4.create());
    const ret = frustum.fromViewProjection(out, vp);
    expect(ret).toBe(out);
  });
});

describe('frustum.intersectsBox', () => {
  it('box completely inside frustum returns true (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Small box at origin is well inside frustum
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('box outside the right plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box far to the right, outside the frustum's right plane
    const box = box3.create(100, -1, 1, 101, 1, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the left plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-101, -1, 1, -100, 1, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the top plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-1, 100, 1, 1, 101, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the bottom plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-1, -101, 1, 1, -100, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box behind the near plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box at z = 6 (behind the camera at z=5 looking toward origin)
    const box = box3.create(-1, -1, 5.1, 1, 1, 6);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box beyond the far plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box far from camera: camera at z=5, far=100, so z < -95 is beyond far
    const box = box3.create(-1, -1, -101, 1, 1, -96);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box straddling the frustum boundary returns true (conservative)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box straddling right plane: half inside, half outside
    // At z=3 (between near=0.1 and far=100), the frustum right boundary is at x = z*tan(fov/2) = 3
    // Box from x=2 to x=4 straddles the boundary
    const box = box3.create(2, -1, 2.5, 4, 1, 3.5);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('intersection test is plane-order independent (boundary)', () => {
    // Camera at (0,0,5) looking at origin; near=5, so z > 5 is behind the camera
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 5, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box at z > 5 is behind the camera's near plane
    const box = box3.create(-1, -1, 5.5, 1, 1, 6);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });
});

describe('frustum.intersectsSphere', () => {
  it('sphere inside frustum returns true (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(frustum.intersectsSphere(f, [0, 0, 0], 1)).toBe(true);
  });

  it('sphere outside right plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(frustum.intersectsSphere(f, [100, 0, 5], 1)).toBe(false);
  });

  it('sphere partially inside is considered intersecting (conservative)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Large sphere centered outside right plane but intersecting it
    expect(frustum.intersectsSphere(f, [50, 0, 5], 100)).toBe(true);
  });
});

}
