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
  // --- from ray.test.ts ---
// Ray unit tests — TDD red phase (feat-20260529-picking-raycasting-screen-to-entity M1 w1 + w2).
//
// Ray storage: Float32Array length 6 [ox, oy, oz, dx, dy, dz], direction normalized.
// Branded type Ray = Float32Array & { readonly __ray: void }.
//
// w1 surface: create / getOrigin / getDirection / setOrigin / setDirection.
// w2 surface: rayAabbIntersects — 6 slab degenerate cases.
//
// Related: requirements AC-01 (Ray construction + read/write test coverage);
//          requirements AC-02 (ray-AABB 6 degenerate cases);
//          requirements AC-03 (screenToRay + y-flip + clamp + sanitize);
//          research Finding 2 #1-#6 (slab degenerate table);
//          plan-tasks.json w1 + w2 + w6 acceptanceChecks.


describe('ray.create', () => {
  it('returns Float32Array length 6 with zero origin + forward direction by default (normal)', () => {
    const r = ray.create();
    expect(r).toBeInstanceOf(Float32Array);
    expect(r.length).toBe(6);
    // default origin = (0,0,0), default direction = (0,0,-1) normalized
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(0);
    expect(r[2]).toBe(0);
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(-1);
  });

  it('normalizes the supplied direction (normal)', () => {
    // (3,4,0) length 5 -> normalize to (0.6, 0.8, 0)
    const r = ray.create(ray.create(), [1, 2, 3], [3, 4, 0]);
    expect(r[3]).toBeCloseTo(0.6, 5);
    expect(r[4]).toBeCloseTo(0.8, 5);
    expect(r[5]).toBe(0);
  });

  it('accepts explicit origin (normal)', () => {
    const r = ray.create(ray.create(), [10, 20, 30], [0, 0, -1]);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe(20);
    expect(r[2]).toBe(30);
  });

  it('handles degenerate zero-length direction gracefully (degenerate)', () => {
    // Zero vector direction — should not throw; normalized to (0,0,0) per gl-matrix style
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, 0]);
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(0);
  });

  it('returns the out parameter', () => {
    const out = ray.create();
    const ret = ray.create(out, [1, 2, 3], [0, 1, 0]);
    expect(ret).toBe(out);
  });
});

describe('ray.getOrigin', () => {
  it('copies origin into out Vec3 (normal)', () => {
    const r = ray.create(ray.create(), [5, 6, 7], [0, 0, -1]);
    const out = vec3.create();
    ray.getOrigin(out, r);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(6);
    expect(out[2]).toBe(7);
  });

  it('returns the out parameter', () => {
    const r = ray.create(ray.create(), [1, 2, 3], [0, 0, -1]);
    const out = vec3.create();
    const ret = ray.getOrigin(out, r);
    expect(ret).toBe(out);
  });
});

describe('ray.getDirection', () => {
  it('copies direction into out Vec3 (normal)', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 1, 0]);
    const out = vec3.create();
    ray.getDirection(out, r);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
  });

  it('returns the out parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const out = vec3.create();
    const ret = ray.getDirection(out, r);
    expect(ret).toBe(out);
  });
});

describe('ray.setOrigin', () => {
  it('writes origin components into the ray (normal)', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    ray.setOrigin(r, [10, 20, 30]);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe(20);
    expect(r[2]).toBe(30);
    // direction must be unchanged
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(-1);
  });

  it('returns the ray parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const ret = ray.setOrigin(r, [1, 2, 3]);
    expect(ret).toBe(r);
  });
});

describe('ray.setDirection', () => {
  it('writes direction and normalizes it (normal)', () => {
    const r = ray.create(ray.create(), [1, 2, 3], [0, 0, -1]);
    ray.setDirection(r, [3, 4, 0]);
    expect(r[3]).toBeCloseTo(0.6, 5);
    expect(r[4]).toBeCloseTo(0.8, 5);
    expect(r[5]).toBe(0);
    // origin must be unchanged
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(2);
    expect(r[2]).toBe(3);
  });

  it('returns the ray parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const ret = ray.setDirection(r, [1, 0, 0]);
    expect(ret).toBe(r);
  });
});

// --- w2: rayAabbIntersects slab 6 degenerate cases ---
//
// Box: AABB from (-1,-1,-1) to (1,1,1) = 2x2x2 cube centred at origin.
// Research Finding 2 #1-#6: slab method degenerate behaviour.
// Related: requirements AC-02; plan-tasks.json w2 acceptanceCheck.

describe('rayAabbIntersects — ① hit from outside', () => {
  it('ray from outside toward box returns true + tmin > 0', () => {
    // origin = (-2, 0, 0), direction = (1, 0, 0) → hits near face at x=-1
    const r = ray.create(ray.create(), [-2, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // tmin ≈ 1 (distance from x=-2 to x=-1 with normalised dir (1,0,0))
    expect(result.tmin).toBeCloseTo(1, 5);
    expect(result.tmin).toBeGreaterThan(0);
  });

  it('diagonal ray toward box returns true + tmin > 0', () => {
    // origin = (-2, -2, 0), direction toward origin → normalised
    const r = ray.create(ray.create(), [-2, -2, 0], [1, 1, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // tmin = real distance from (-2,-2,0) to AABB entry along (1,1,0)/sqrt(2)
    expect(result.tmin).toBeGreaterThan(0);
  });
});

describe('rayAabbIntersects — ② hit from inside', () => {
  it('ray origin inside box returns true + tmin = 0', () => {
    // origin at centre (0,0,0), any direction
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });

  it('ray origin inside box, facing rear (-z) still hit = true + tmin = 0', () => {
    const r = ray.create(ray.create(), [0.5, 0.5, 0.5], [-1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });
});

describe('rayAabbIntersects — ③ miss (ray points away)', () => {
  it('ray origin outside box, direction away → false', () => {
    const r = ray.create(ray.create(), [-2, 0, 0], [-1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });

  it('ray origin outside box on X, pointing wrong Y axis → false', () => {
    const r = ray.create(ray.create(), [3, 0, 0], [0, 1, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });
});

describe('rayAabbIntersects — ④ parallel-axis miss', () => {
  it('ray parallel to X axis, origin offset on Y outside slab → false', () => {
    // direction (1,0,0) gives inv=(1,Inf,Inf); Y slab is [-1,1]; origin y=5 → 5/-Inf or 5/Inf → no overlap
    const r = ray.create(ray.create(), [0, 5, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });

  it('ray parallel to X axis, origin within Y/Z slab → true (X is infinite span)', () => {
    // direction (1,0,0); origin (0,0,0) inside the box YZ cross-section
    const r = ray.create(ray.create(), [0, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    // origin at (0,0,0) is inside box → hit=true, tmin=0
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });
});

describe('rayAabbIntersects — ⑤ edge/corner NaN-safe', () => {
  it('ray starting exactly on box surface (-x face) → true, no false negative from NaN', () => {
    // origin at (-1,0,0) = exactly on left face. direction (1,0,0) = into box.
    // On X axis: t1 = (-1-(-1))/1 = 0, t2 = (1-(-1))/1 = 2. Safe.
    const r = ray.create(ray.create(), [-1, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // origin on surface, so tmin = 0
    expect(result.tmin).toBe(0);
  });

  it('ray from corner (-1,-1,-1) → true, no false negative', () => {
    // origin at exact min corner, direction toward centre
    const r = ray.create(ray.create(), [-1, -1, -1], [1, 1, 1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });

  it('ray origin on +x face, direction parallel to face (0,0,-1) → true, tmin=0', () => {
    // origin (1, 0, 0) on the +x face, direction (0,0,-1) parallel to face.
    // X axis: t1=( -1-1)/0 = -2/0 = -Inf, t2=(1-1)/0 = 0/0 = NaN.
    // Must be NaN-safe: NaN must not poison the interval.
    const r = ray.create(ray.create(), [1, 0, 0], [0, 0, -1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
  });
});

describe('rayAabbIntersects — ⑥ thin box (1D / 2D degenerate)', () => {
  it('thin box (minX == maxX, flat YZ plane at x=0) intersects front-on ray', () => {
    // 2D box: plane at x=0 from y=[-1,1] z=[-1,1]
    const aabb = box3.create(0, -1, -1, 0, 1, 1);
    // ray from x=-2 toward +x
    const r = ray.create(ray.create(), [-2, 0, 0], [1, 0, 0]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBeCloseTo(2, 5);
  });

  it('thin box (minY == maxY, 1D segment on X) intersects on-axis ray', () => {
    // 1D degenerate box: y=[0,0], z=[0,0], x=[-1,1] → line segment on X axis
    const aabb = box3.create(-1, 0, 0, 1, 0, 0);
    // ray from (0,-5,0) pointing toward X axis at y=0
    const r = ray.create(ray.create(), [0, -5, 0], [0, 1, 0]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
  });

  it('thin box miss: ray parallel to the plane offset outside', () => {
    const aabb = box3.create(0, -1, -1, 0, 1, 1); // YZ plane at x=0
    // ray pointing in Y direction, offset on X at x=5, origin offset on Z
    const r = ray.create(ray.create(), [5, 0, 0], [0, 0, -1]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });
});

// ============================================================
// screenToRay (feat-20260529-picking-raycasting-screen-to-entity M2 w6)
// ============================================================
//
// screenToRay(out, sx, sy, vpW, vpH, view, proj, kind) → Ray
//
// WebGPU [0,1] NDC z convention: near=0, far=1 (D-NDC / research Finding 6).
// y-flip: ndc_y = 1 - 2 * screenY / viewportH.
//
// Five test groups per requirements:
//   1. perspective direction ≈ forward
//   2. ortho direction constant = forward, origin translates with screen coords
//   3. y-flip correctness
//   4. boundary clamp (viewport-outside coords → clamped)
//   5. NaN/Inf sanitization (non-finite input → defined Ray, no NaN)
//
// Related: requirements AC-03; plan-tasks.json w6 acceptanceCheck.

describe('screenToRay', () => {
  // Reusable view/projection setups
  function perspView(): Float32Array {
    return mat4.lookAt(mat4.create(), [1, 2, 5], [1, 2, -5], [0, 1, 0]);
  }
  function perspProj(): Float32Array {
    return mat4.perspective(mat4.create(), Math.PI / 3, 800 / 600, 0.1, 100);
  }
  function orthoView(): Float32Array {
    return mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
  }
  function orthoProj(): Float32Array {
    return mat4.orthographic(mat4.create(), -4, 4, 3, -3, 0.1, 100);
  }

  // ---------- 1. perspective direction ≈ forward ----------

  it('perspective screen-center produces ray direction ≈ camera forward', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'perspective');
    // Camera forward in world space = (0, 0, -1)
    const dirDot = (r[3] as number) * 0 + (r[4] as number) * 0 + (r[5] as number) * -1;
    expect(dirDot).toBeGreaterThan(0.99999);
  });

  it('perspective off-center gives different direction', () => {
    const view = perspView();
    const proj = perspProj();
    const rCenter = ray.create();
    const rRight = ray.create();
    ray.screenToRay(rCenter, 400, 300, 800, 600, view, proj, 'perspective');
    ray.screenToRay(rRight, 700, 300, 800, 600, view, proj, 'perspective');
    expect(rRight[3]).not.toBeCloseTo(rCenter[3] as number, 3);
  });

  // ---------- 2. orthographic ----------

  it('ortho screen-center produces direction = camera forward', () => {
    const view = orthoView();
    const proj = orthoProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'orthographic');
    const dirDot = (r[3] as number) * 0 + (r[4] as number) * 0 + (r[5] as number) * -1;
    expect(dirDot).toBeGreaterThan(0.99999);
  });

  it('ortho origin translates with screen coordinates (x direction)', () => {
    const view = orthoView();
    const proj = orthoProj();
    const rLeft = ray.create();
    const rRight = ray.create();
    ray.screenToRay(rLeft, 200, 300, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(rRight, 600, 300, 800, 600, view, proj, 'orthographic');
    expect(rRight[0]).toBeGreaterThan(rLeft[0] as number);
  });

  it('ortho origin translates with screen coordinates (y direction)', () => {
    const view = orthoView();
    const proj = orthoProj();
    const rTop = ray.create();
    const rBottom = ray.create();
    ray.screenToRay(rTop, 400, 100, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(rBottom, 400, 500, 800, 600, view, proj, 'orthographic');
    expect(rTop[1]).toBeGreaterThan(rBottom[1] as number);
  });

  it('ortho direction is identical regardless of screen position', () => {
    const view = orthoView();
    const proj = orthoProj();
    const r1 = ray.create();
    const r2 = ray.create();
    ray.screenToRay(r1, 200, 100, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(r2, 600, 500, 800, 600, view, proj, 'orthographic');
    expect(r1[3]).toBeCloseTo(r2[3] as number, 10);
    expect(r1[4]).toBeCloseTo(r2[4] as number, 10);
    expect(r1[5]).toBeCloseTo(r2[5] as number, 10);
  });

  // ---------- 3. y-flip ----------

  it('y-flip: lower screen y (near top) → higher world y', () => {
    const view = perspView();
    const proj = perspProj();
    const rTop = ray.create();
    const rBottom = ray.create();
    ray.screenToRay(rTop, 400, 100, 800, 600, view, proj, 'perspective');
    ray.screenToRay(rBottom, 400, 500, 800, 600, view, proj, 'perspective');
    expect(rTop[1]).toBeGreaterThan(rBottom[1] as number);
  });

  // ---------- 4. boundary clamp ----------

  it('negative screenX clamps to 0 without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, -100, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('excessive screenX clamps to viewport width without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 900, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('negative screenY clamps to 0 without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, -50, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('excessive screenY clamps to viewport height without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 700, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  // ---------- 5. NaN/Inf sanitization ----------

  it('NaN screenX produces a defined Ray (no NaN components)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, Number.NaN, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('Infinity screenY produces a defined Ray (no Inf components)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, Number.POSITIVE_INFINITY, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('NaN viewport dimensions produce a defined Ray', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, Number.NaN, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('zero viewport dimensions produce a defined Ray (no division by zero)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 0, 0, 0, 0, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('normalized direction is approximately unit length', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'perspective');
    const dirLen = Math.sqrt(
      (r[3] as number) * (r[3] as number) +
        (r[4] as number) * (r[4] as number) +
        (r[5] as number) * (r[5] as number),
    );
    expect(dirLen).toBeCloseTo(1, 5);
  });
});

}
