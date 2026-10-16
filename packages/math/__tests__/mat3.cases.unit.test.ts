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
  // --- from mat3.test.ts ---
// mat3.test.ts — M3 red: 3x3 matrix namespace unit tests (T-017)
//
// Covers the three tiers normal + degenerate (singular invert) + boundary:
//   create / clone / identity / equals / multiply / transpose / invert /
//   scale / fromMat4 / normalMatrix
//
// Memory layout lock: 9 floats packed (D-P4), column-major.
// Degenerate convention: invert(singular) → identity (same as D-P1).
//
// Related: requirements §AC-04 (normalMatrix) + AC-06 (throw 0) + AC-08;
//          plan-strategy §6 M3 + §appendix A degenerate registry #3 mat section.


describe('mat3.create / clone', () => {
  it('create() returns Float32Array length 9 zero (normal)', () => {
    const m = mat3.create();
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(9);
    for (let i = 0; i < 9; i++) expect(m[i]).toBe(0);
  });

  it('clone(a) returns a new Float32Array with same content (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.clone(a);
    expect(b).not.toBe(a);
    for (let i = 0; i < 9; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat3.identity', () => {
  it('writes 3x3 identity column-major (normal)', () => {
    const m = mat3.identity(mat3.create());
    // identity column-major: [1,0,0, 0,1,0, 0,0,1]
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('idempotent: identity(identity(m)) == identity(m) (boundary)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(a);
    expect(b).toBe(a);
    for (let i = 0; i < 9; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat3.equals', () => {
  it('I == I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    expect(mat3.equals(a, b)).toBe(true);
  });

  it('detects 1e-3 component diff (boundary)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    b[0] = 1.001;
    expect(mat3.equals(a, b)).toBe(false);
  });

  it('NaN never equals (degenerate)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    b[0] = Number.NaN;
    expect(mat3.equals(a, b)).toBe(false);
  });
});

describe('mat3.multiply', () => {
  it('I * I = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    const out = mat3.multiply(mat3.create(), a, b);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('M * I = M (boundary)', () => {
    // any multipliable mat3: column-major [1,2,3, 4,5,6, 7,8,9]
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const i = mat3.identity(mat3.create());
    const out = mat3.multiply(mat3.create(), m as unknown as Mat3, i);
    for (let k = 0; k < 9; k++) expect(out[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('aliasing-safe: multiply(m, m, m) reads before writes (degenerate)', () => {
    // m = identity * 2 (diagonal 2); m*m diagonal should be 4
    const m = mat3.identity(mat3.create());
    m[0] = 2;
    m[4] = 2;
    m[8] = 2;
    mat3.multiply(m, m, m);
    expect(m[0]).toBeCloseTo(4, 5);
    expect(m[4]).toBeCloseTo(4, 5);
    expect(m[8]).toBeCloseTo(4, 5);
  });
});

describe('mat3.transpose', () => {
  it('transpose(I) = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const out = mat3.transpose(mat3.create(), a);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('transpose(transpose(m)) = m (boundary)', () => {
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const t1 = mat3.transpose(mat3.create(), m as unknown as Mat3);
    const t2 = mat3.transpose(mat3.create(), t1);
    for (let k = 0; k < 9; k++) expect(t2[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('aliasing-safe: transpose(m, m) (degenerate)', () => {
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9) as unknown as Mat3;
    mat3.transpose(m, m);
    // column-major [1,2,3, 4,5,6, 7,8,9] transposed = [1,4,7, 2,5,8, 3,6,9]
    expect(Array.from(m)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });
});

describe('mat3.invert (D-P1: singular → identity)', () => {
  it('invert(I) = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const out = mat3.invert(mat3.create(), a);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('invert(invert(m)) ≈ m for non-singular m (boundary)', () => {
    // non-singular mat3: diag(2, 3, 4) column-major
    const m = Float32Array.of(2, 0, 0, 0, 3, 0, 0, 0, 4) as unknown as Mat3;
    const inv = mat3.invert(mat3.create(), m);
    const back = mat3.invert(mat3.create(), inv);
    for (let k = 0; k < 9; k++) expect(back[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('singular matrix → out = identity (degenerate, D-P1)', () => {
    // all zero → singular (det = 0)
    const singular = mat3.create();
    const out = mat3.invert(mat3.create(), singular);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('invert returns out (not null) for singular matrix', () => {
    const singular = mat3.create();
    const out = mat3.create();
    const ret = mat3.invert(out, singular);
    expect(ret).toBe(out);
  });
});

describe('mat3.scale', () => {
  it('scale(I, [2,3,1]) yields diag(2,3,1) (normal)', () => {
    // mat3 scale by Vec2 / Vec3? We design it to take Vec3 (aligned with mat4).
    // mat3 is typically used for 2D affine + normal matrix; for simplicity we take Vec3 and use the first 3 components.
    const a = mat3.identity(mat3.create());
    const v = Float32Array.of(2, 3, 1) as unknown as Vec3;
    const out = mat3.scale(mat3.create(), a, v);
    expect(out[0]).toBeCloseTo(2);
    expect(out[4]).toBeCloseTo(3);
    expect(out[8]).toBeCloseTo(1);
  });
});

describe('mat3.fromMat4 (drop 3rd row & column)', () => {
  it('extracts upper-left 3x3 from mat4 column-major (normal)', () => {
    // mat4 column-major:
    // col0: [1, 2, 3, 0]   col1: [4, 5, 6, 0]   col2: [7, 8, 9, 0]   col3: [0,0,0,1]
    const m4 = Float32Array.of(1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 0, 0, 0, 1) as unknown as Mat4;
    const m3 = mat3.fromMat4(mat3.create(), m4);
    expect(Array.from(m3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('mat3.normalMatrix (transpose-inverse upper-left of mat4)', () => {
  it('normalMatrix(I_4) = I_3 (normal)', () => {
    const m4 = mat4.identity(mat4.create());
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(Array.from(n)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('normalMatrix preserves uniform scale → diag inverse (boundary)', () => {
    // mat4 = diag(2, 2, 2, 1) upper-left 3x3 = 2I → invert = 0.5I → transpose = 0.5I
    const m4 = mat4.identity(mat4.create());
    m4[0] = 2;
    m4[5] = 2;
    m4[10] = 2;
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(n[0]).toBeCloseTo(0.5);
    expect(n[4]).toBeCloseTo(0.5);
    expect(n[8]).toBeCloseTo(0.5);
  });

  it('singular upper-left → identity (degenerate, same convention as D-P1)', () => {
    // mat4 with zero upper-left 3x3 → singular → fallback identity
    const m4 = mat4.identity(mat4.create());
    m4[0] = 0;
    m4[5] = 0;
    m4[10] = 0;
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(Array.from(n)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe('mat3 — V8 elements-kinds performance guard', () => {
  it('all return values are Float32Array (no number[] coercion)', () => {
    const out1 = mat3.identity(mat3.create());
    const out2 = mat3.multiply(mat3.create(), out1, out1);
    const out3 = mat3.transpose(mat3.create(), out1);
    const out4 = mat3.invert(mat3.create(), out1);
    expect(out1).toBeInstanceOf(Float32Array);
    expect(out2).toBeInstanceOf(Float32Array);
    expect(out3).toBeInstanceOf(Float32Array);
    expect(out4).toBeInstanceOf(Float32Array);
  });
});

}