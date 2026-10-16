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
  // --- from mat4.test.ts ---
// mat4.test.ts — M3 red: 4x4 matrix namespace unit tests (T-017)
//
// Covers the three tiers normal + degenerate + boundary:
//   create / clone / identity / equals / multiply / transpose / invert / scale /
//   translate / rotate / lookAt / compose / decompose / fromQuat /
//   perspective (WebGPU [0,1]) / perspectiveNO (WebGL [-1,1]) / perspectiveReverseZ /
//   orthographic / orthographicNO / orthographicReverseZ
//
// Degenerate convention: invert(singular) → identity (D-P1); lookAt(eye=target) → identity (D-P17).
// Boundary: near >= far is numerically undefined but does not throw (plan §appendix A degenerate registry #7).
// reversed-Z fixture values come from _fixtures.ts (error ≤ 1e-5, AC-05).
//
// Related: requirements §AC-04 three projection tiers complete + AC-05 reversed-Z + AC-06 throw 0;
//          plan-strategy §6 M3 + §appendix A degenerate registry mat section (5 entries);
//          wiki/reversed-z-projection.md §7.2 / 7.3 fixture;
//          wiki/wgpu-matrix-overview.md / gl-matrix-overview.md naming conventions.


describe('mat4.create / clone', () => {
  it('create() returns Float32Array length 16 zero (normal)', () => {
    const m = mat4.create();
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(m[i]).toBe(0);
  });

  it('clone(a) returns a new Float32Array with same content (normal)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.clone(a);
    expect(b).not.toBe(a);
    for (let i = 0; i < 16; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat4.identity', () => {
  it('returns 4x4 identity in a Float32Array of length 16 (normal)', () => {
    const m = mat4.identity(mat4.create());
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBe(expected);
    }
  });

  it('idempotent: identity(identity(m)) equals identity(m) (boundary)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(a);
    for (let i = 0; i < 16; i++) expect(b[i]).toBe(a[i]);
  });

  it('returns same Float32Array instance (degenerate: in-place semantics)', () => {
    const m = mat4.create();
    const out = mat4.identity(m);
    expect(out).toBe(m);
  });
});

describe('mat4.equals', () => {
  it('I == I (normal)', () => {
    expect(mat4.equals(mat4.identity(mat4.create()), mat4.identity(mat4.create()))).toBe(true);
  });

  it('NaN never equals (degenerate)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[0] = Number.NaN;
    expect(mat4.equals(a, b)).toBe(false);
  });
});

describe('mat4.multiply', () => {
  it('I * I = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    const out = mat4.multiply(mat4.create(), a, b);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(out[i]).toBe(expected);
    }
  });

  it('M * I = M (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const i = mat4.identity(mat4.create());
    const out = mat4.multiply(mat4.create(), m, i);
    for (let k = 0; k < 16; k++) expect(out[k]).toBeCloseTo(m[k] as number);
  });

  it('two translations compose additively (degenerate aliasing input)', () => {
    const t1 = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const t2 = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [4, 5, 6]);
    const out = mat4.multiply(mat4.create(), t1, t2);
    expect(out[12]).toBeCloseTo(5);
    expect(out[13]).toBeCloseTo(7);
    expect(out[14]).toBeCloseTo(9);
    expect(out[15]).toBeCloseTo(1);
  });

  it('aliasing-safe: multiply(m, m, m) (degenerate)', () => {
    const m = mat4.identity(mat4.create());
    m[0] = 2;
    m[5] = 2;
    m[10] = 2;
    mat4.multiply(m, m, m);
    expect(m[0]).toBeCloseTo(4);
    expect(m[5]).toBeCloseTo(4);
    expect(m[10]).toBeCloseTo(4);
  });
});

describe('mat4.transpose', () => {
  it('transpose(I) = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.transpose(mat4.create(), a);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(a[i]);
  });

  it('transpose(transpose(m)) = m (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const t1 = mat4.transpose(mat4.create(), m);
    const t2 = mat4.transpose(mat4.create(), t1);
    for (let k = 0; k < 16; k++) expect(t2[k]).toBeCloseTo(m[k] as number);
  });
});

describe('mat4.invert (D-P1: singular → identity)', () => {
  it('invert(I) = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.invert(mat4.create(), a);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(a[i] as number);
  });

  it('invert(translation) flips sign (boundary)', () => {
    const t = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [3, 4, 5]);
    const inv = mat4.invert(mat4.create(), t);
    expect(inv[12]).toBeCloseTo(-3);
    expect(inv[13]).toBeCloseTo(-4);
    expect(inv[14]).toBeCloseTo(-5);
  });

  it('invert(invert(m)) ≈ m for non-singular m (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [2, -1, 7]);
    const inv = mat4.invert(mat4.create(), m);
    const back = mat4.invert(mat4.create(), inv);
    for (let k = 0; k < 16; k++) expect(back[k]).toBeCloseTo(m[k] as number, 4);
  });

  it('singular matrix → out = identity (degenerate, D-P1)', () => {
    // all zero → singular (det = 0)
    const singular = mat4.create();
    const out = mat4.invert(mat4.create(), singular);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(out[i]).toBeCloseTo(expected);
    }
  });

  it('singular returns out (not null), AC-08 cross-vendor rewrite', () => {
    const singular = mat4.create();
    const out = mat4.create();
    const ret = mat4.invert(out, singular);
    expect(ret).toBe(out);
    // not null
    expect(ret).not.toBeNull();
  });

  it('aliasing-safe: invert(m, m) where m is singular (R-P1)', () => {
    const m = mat4.create();
    const ret = mat4.invert(m, m);
    expect(ret).toBe(m);
    // should be identity (aliasing-safe + singular fallback)
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBeCloseTo(expected);
    }
  });
});

describe('mat4.scale', () => {
  it('scale(I, [2,3,4]) yields diag(2,3,4,1) (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.scale(mat4.create(), a, [2, 3, 4]);
    expect(out[0]).toBeCloseTo(2);
    expect(out[5]).toBeCloseTo(3);
    expect(out[10]).toBeCloseTo(4);
    expect(out[15]).toBeCloseTo(1);
  });
});

describe('mat4.translate', () => {
  it('translates an identity matrix (normal)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    expect(m[12]).toBeCloseTo(1);
    expect(m[13]).toBeCloseTo(2);
    expect(m[14]).toBeCloseTo(3);
    expect(m[15]).toBeCloseTo(1);
  });

  it('translate by zero is a no-op (boundary)', () => {
    const id = mat4.identity(mat4.create());
    const out = mat4.translate(mat4.create(), id, [0, 0, 0]);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(id[i] as number);
  });

  it('accepts Float32Array as translation vector (degenerate: typed-array friendly)', () => {
    const v = new Float32Array([4, 5, 6]);
    const out = mat4.translate(mat4.create(), mat4.identity(mat4.create()), v);
    expect(out[12]).toBeCloseTo(4);
    expect(out[13]).toBeCloseTo(5);
    expect(out[14]).toBeCloseTo(6);
  });
});

describe('mat4.rotate', () => {
  it('rotate(I, axis, 0) ≈ I (boundary)', () => {
    const out = mat4.rotate(mat4.create(), mat4.identity(mat4.create()), [0, 1, 0], 0);
    const id = mat4.identity(mat4.create());
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(id[i] as number);
  });

  it('rotate around Y by π/2 maps X → -Z (normal)', () => {
    const r = mat4.rotate(mat4.create(), mat4.identity(mat4.create()), [0, 1, 0], Math.PI / 2);
    // column-major: m[0..2] = first column = R * [1,0,0]^T
    expect(r[0]).toBeCloseTo(0, 5);
    expect(r[1]).toBeCloseTo(0, 5);
    expect(r[2]).toBeCloseTo(-1, 5);
  });
});

describe('mat4.lookAt (D-P17: eye=target → identity)', () => {
  it('lookAt(eye=[0,0,5], target=origin, up=Y) yields finite matrix (normal)', () => {
    const m = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
  });

  it('eye === target → out = identity (degenerate, D-P17)', () => {
    const m = mat4.lookAt(mat4.create(), [1, 2, 3], [1, 2, 3], [0, 1, 0]);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBeCloseTo(expected);
    }
  });

  it('returns out (not null) for eye=target degenerate input', () => {
    const out = mat4.create();
    const ret = mat4.lookAt(out, [1, 1, 1], [1, 1, 1], [0, 1, 0]);
    expect(ret).toBe(out);
  });
});

describe('mat4.compose / decompose', () => {
  it('compose(t, r=identity-quat, s=[1,1,1]) ≈ translate(I, t) (normal)', () => {
    const q = quat.identity(quat.create());
    const m = mat4.compose(mat4.create(), vec3.create(1, 2, 3), q, vec3.create(1, 1, 1));
    expect(m[12]).toBeCloseTo(1);
    expect(m[13]).toBeCloseTo(2);
    expect(m[14]).toBeCloseTo(3);
  });

  it('decompose(compose(t, r, s)) ≈ (t, r, s) (boundary, no shear)', () => {
    const t = vec3.create(1, 2, 3);
    const r = quat.identity(quat.create());
    const s = vec3.create(2, 3, 4);
    const m = mat4.compose(mat4.create(), t, r, s);
    const t2 = vec3.create();
    const r2 = quat.identity(quat.create());
    const s2 = vec3.create();
    mat4.decompose(t2, r2, s2, m);
    expect(t2[0]).toBeCloseTo(1);
    expect(t2[1]).toBeCloseTo(2);
    expect(t2[2]).toBeCloseTo(3);
    expect(s2[0]).toBeCloseTo(2);
    expect(s2[1]).toBeCloseTo(3);
    expect(s2[2]).toBeCloseTo(4);
  });
});

describe('mat4.fromQuat', () => {
  it('fromQuat(identity) = I (normal)', () => {
    const q = quat.identity(quat.create());
    const m = mat4.fromQuat(mat4.create(), q);
    const id = mat4.identity(mat4.create());
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(id[i] as number);
  });
});

describe('mat4.perspective (WebGPU [0,1] short name, D-3)', () => {
  it('produces a finite 4x4 matrix for typical fov/aspect/near/far (normal)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 1000);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    expect(m[11]).toBeCloseTo(-1);
    expect(m[15]).toBe(0);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
  });

  it('square aspect ratio yields equal x and y scaling (boundary)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    expect(m[0]).toBeCloseTo(m[5] as number);
  });

  it('near→0, far→1 mapping for [0,1] NDC (normal)', () => {
    // perspective WebGPU [0,1]: near plane → ndc_z=0, far plane → ndc_z=1
    const near = 0.1;
    const far = 100;
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 1, near, far);
    // feed the point (0, 0, -near, 1) to the matrix and expect ndc_z = 0
    // p_clip = M * [0, 0, -near, 1]^T; p_clip[2] = m[8]*0 + m[9]*0 + m[10]*(-near) + m[14]*1
    // p_clip[3] = m[11]*(-near) = near
    const clipZ_near = (m[10] as number) * -near + (m[14] as number);
    const clipW_near = (m[11] as number) * -near;
    const ndc_near = clipZ_near / clipW_near;
    expect(ndc_near).toBeCloseTo(0, 4);
    const clipZ_far = (m[10] as number) * -far + (m[14] as number);
    const clipW_far = (m[11] as number) * -far;
    const ndc_far = clipZ_far / clipW_far;
    expect(ndc_far).toBeCloseTo(1, 4);
  });

  it('near >= far does not throw, values undefined-but-finite-or-non (degenerate)', () => {
    expect(() => mat4.perspective(mat4.create(), Math.PI / 4, 1, 100, 0.1)).not.toThrow();
    expect(() => mat4.perspective(mat4.create(), Math.PI / 4, 1, 1, 1)).not.toThrow();
  });
});

describe('mat4.perspectiveNO (WebGL [-1,1] NDC)', () => {
  it('z = -1 at near, z = +1 at far (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 1, near, far);
    const ndc_near = ((m[10] as number) * -near + (m[14] as number)) / ((m[11] as number) * -near);
    const ndc_far = ((m[10] as number) * -far + (m[14] as number)) / ((m[11] as number) * -far);
    expect(ndc_near).toBeCloseTo(-1, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.perspectiveReverseZ (AC-05 fixture, finite far)', () => {
  it('matches double-precision fixture within 1e-5 (normal)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(
        PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED[i] as number,
        REVERSE_Z_FIXTURE_TOLERANCE,
      );
    }
  });

  it('near → ndc_z = 1, far → ndc_z = 0 (boundary)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    const ndcAtNear = ((m[10] as number) * -near + (m[14] as number)) / ((m[11] as number) * -near);
    const ndcAtFar = ((m[10] as number) * -far + (m[14] as number)) / ((m[11] as number) * -far);
    expect(ndcAtNear).toBeCloseTo(1, REVERSE_Z_FIXTURE_TOLERANCE);
    expect(ndcAtFar).toBeCloseTo(0, REVERSE_Z_FIXTURE_TOLERANCE);
  });

  it('projection probes (z_eye → ndc_z) match table (degenerate intermediate)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    for (const probe of REVERSE_Z_PROJECTION_PROBES_FINITE) {
      const clipZ = (m[10] as number) * probe.z_eye + (m[14] as number);
      const clipW = (m[11] as number) * probe.z_eye;
      const ndcZ = clipZ / clipW;
      expect(ndcZ).toBeCloseTo(probe.ndc_z, REVERSE_Z_FIXTURE_TOLERANCE);
    }
  });
});

describe('mat4.perspectiveReverseZ (AC-05 fixture, infinite far)', () => {
  it('matches double-precision fixture within 1e-5 when far=Infinity (normal)', () => {
    const { fovy, aspect, near } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(
        PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED[i] as number,
        REVERSE_Z_FIXTURE_TOLERANCE,
      );
    }
  });

  it('infinite-far probes match table', () => {
    const { fovy, aspect, near } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, Number.POSITIVE_INFINITY);
    for (const probe of REVERSE_Z_PROJECTION_PROBES_INFINITE) {
      const clipZ = (m[10] as number) * probe.z_eye + (m[14] as number);
      const clipW = (m[11] as number) * probe.z_eye;
      const ndcZ = clipZ / clipW;
      expect(ndcZ).toBeCloseTo(probe.ndc_z, REVERSE_Z_FIXTURE_TOLERANCE);
    }
  });
});

describe('mat4.orthographic (WebGPU [0,1] short name, D-3)', () => {
  it('finite for typical inputs (normal)', () => {
    const m = mat4.orthographic(mat4.create(), -1, 1, 1, -1, 0.1, 100);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
    // last element (affine) = 1
    expect(m[15]).toBeCloseTo(1);
  });

  it('uses the Three-compatible top-before-bottom order for asymmetric bounds', () => {
    const m = mat4.orthographic(mat4.create(), -2, 5, 7, -3, 0.1, 100);
    const projectY = (y: number) => (m[5] as number) * y + (m[13] as number);
    expect(projectY(7)).toBeCloseTo(1, 5);
    expect(projectY(-3)).toBeCloseTo(-1, 5);
  });

  it('near → ndc_z = 0, far → ndc_z = 1 (boundary)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographic(mat4.create(), -1, 1, 1, -1, near, far);
    // ortho: clipZ = m[10] * z_eye + m[14], w = 1
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(0, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.orthographicNO (WebGL [-1,1] NDC)', () => {
  it('near → -1, far → +1 (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographicNO(mat4.create(), -1, 1, 1, -1, near, far);
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(-1, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.orthographicReverseZ (D-P3 self-extension, near→1 far→0)', () => {
  it('near → ndc_z = 1, far → ndc_z = 0 (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographicReverseZ(mat4.create(), -1, 1, 1, -1, near, far);
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(1, 4);
    expect(ndc_far).toBeCloseTo(0, 4);
  });
});

// T-035: three-tier coverage tightening for from{Translation/Scaling/Rotation}
// (plan-strategy AC-10 line / branch ≥ 80% hard constraint — this group lifts mat4.ts branch from 48% to 80%+)
describe('mat4.fromTranslation', () => {
  it('builds identity-with-translation (normal)', () => {
    const m = mat4.fromTranslation(mat4.create(), [1.5, -2.0, 3.5]);
    // column-major storage: translation lands at indices 12/13/14
    expect(m[0]).toBe(1);
    expect(m[5]).toBe(1);
    expect(m[10]).toBe(1);
    expect(m[15]).toBe(1);
    expect(m[12]).toBeCloseTo(1.5, 5);
    expect(m[13]).toBeCloseTo(-2.0, 5);
    expect(m[14]).toBeCloseTo(3.5, 5);
  });

  it('zero translation = identity (boundary)', () => {
    const m = mat4.fromTranslation(mat4.create(), [0, 0, 0]);
    const I = mat4.identity(mat4.create());
    expect(mat4.equals(m, I)).toBe(true);
  });
});

describe('mat4.fromScaling', () => {
  it('builds diag(sx, sy, sz, 1) (normal)', () => {
    const m = mat4.fromScaling(mat4.create(), [2, 3, 4]);
    expect(m[0]).toBe(2);
    expect(m[5]).toBe(3);
    expect(m[10]).toBe(4);
    expect(m[15]).toBe(1);
    expect(m[1]).toBe(0);
    expect(m[6]).toBe(0);
    expect(m[11]).toBe(0);
  });

  it('unit scaling = identity (boundary)', () => {
    const m = mat4.fromScaling(mat4.create(), [1, 1, 1]);
    expect(mat4.equals(m, mat4.identity(mat4.create()))).toBe(true);
  });
});

describe('mat4.fromRotation', () => {
  it('rotation around Y by π/2 maps +X → -Z (normal)', () => {
    const m = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    // column-major: m[0..3] is the first column, corresponding to R·[1,0,0,0] → x'=m[0], y'=m[1], z'=m[2]
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[2]).toBeCloseTo(-1, 5);
  });

  it('zero axis silently degrades to identity (degenerate, AC-06)', () => {
    const m = mat4.fromRotation(mat4.create(), [0, 0, 0], Math.PI / 4);
    expect(mat4.equals(m, mat4.identity(mat4.create()))).toBe(true);
  });

  it('non-unit axis is normalized internally (boundary)', () => {
    const a = mat4.fromRotation(mat4.create(), [0, 1, 0], 0.7);
    const b = mat4.fromRotation(mat4.create(), [0, 5, 0], 0.7);
    expect(mat4.equals(a, b)).toBe(true);
  });
});

// T-035: perspective/perspectiveNO infinite-far + decompose trace-branch coverage
describe('mat4.perspective infinite far', () => {
  it('perspective(far=Infinity) sets m[10]=-1 and m[14]=-near (boundary)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 1, 0.1, Number.POSITIVE_INFINITY);
    expect(m[10]).toBe(-1);
    expect(m[14]).toBeCloseTo(-0.1, 5);
  });

  it('perspectiveNO(far=Infinity) sets m[10]=-1 and m[14]=-2*near (boundary)', () => {
    const m = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 1, 0.1, Number.POSITIVE_INFINITY);
    expect(m[10]).toBe(-1);
    expect(m[14]).toBeCloseTo(-0.2, 5);
  });
});

describe('mat4.decompose trace branches', () => {
  // decompose internally splits into 4 Shoemake branches: trace>0 / r00 max / r11 max / r22 max.
  // identity falls into trace>0; here we rotate by π around each principal axis to hit the r00/r11/r22 max branches.
  it('rotation around X by π hits r00 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [1, 0, 0], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[0]).toBeCloseTo(1, 5);
    expect(sOut[1]).toBeCloseTo(1, 5);
    expect(sOut[2]).toBeCloseTo(1, 5);
  });

  it('rotation around Y by π hits r11 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [0, 1, 0], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[1]).toBeCloseTo(1, 5);
  });

  it('rotation around Z by π hits r22 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [0, 0, 1], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[2]).toBeCloseTo(1, 5);
  });

  it('negative determinant flips sx (degenerate)', () => {
    // negative scale (mirror x) → det < 0 → sxFinal = -sx
    const r = quat.create();
    quat.identity(r);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [-2, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[0]).toBeLessThan(0);
  });
});

// M1 / t1 — mat4.transformVec3 / transformPoint / transformDirection
//
// 3 functions × 3 case tiers (normal + degrade + in-place) + alias equivalence:
//   - transformVec3: affine m transforms (x,y,z,1) + w'=0 guard → out=(0,0,0)
//   - transformPoint: ES alias of transformVec3 (OQ-1, S-1)
//   - transformDirection: takes m's upper-left 3×3 (no translation column) + final vec3.normalize
//   - degenerate |out|=0 → out=(0,0,0) (D-4 silent convention)
//   - in-place safety: out === v at the same address still produces the correct result
//
// Related: requirements §3.1 mat4 rows 1/2/3 + §9 boundary-case table rows 1/3/6;
//          research Finding 1 (alias evidence) + Finding 2 (take 3×3 + normalize) + Finding 4 (w'=0 guard);
//          plan-strategy §2 S-1 / S-2 + §4.3 key test points table top 3 rows.

describe('mat4.transformVec3 (M1 / t1)', () => {
  it('identity unit: transformVec3(I, v) ≈ v (normal)', () => {
    const I = mat4.identity(mat4.create());
    const v = vec3.create(1, 2, 3);
    const out = vec3.create();
    mat4.transformVec3(out, I, v);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('chained composition baseline: transformVec3(T*S, v) ≈ T*S applied (normal)', () => {
    // T(1,2,3) * S(2,2,2) applied to v=(1,1,1): S scales to (2,2,2), then T translates to (3,4,5)
    const S = mat4.fromScaling(mat4.create(), [2, 2, 2]);
    const T = mat4.fromTranslation(mat4.create(), [1, 2, 3]);
    const M = mat4.multiply(mat4.create(), T, S);
    const v = vec3.create(1, 1, 1);
    const out = vec3.create();
    mat4.transformVec3(out, M, v);
    expect(out[0]).toBeCloseTo(3, 5);
    expect(out[1]).toBeCloseTo(4, 5);
    expect(out[2]).toBeCloseTo(5, 5);
  });

  it("w'=0 plane projection → out=(0,0,0) (degrade, D-4 silent convention)", () => {
    // Build a matrix that makes w' = 0: m[3]=1, m[7]=m[11]=m[15]=0; with input v=(1,0,0,1), w' = 1*1+0+0+0 = 1 (not degenerate)
    // Switch to: m[3]=0, m[7]=0, m[11]=0, m[15]=0 + arbitrary v → w' = 0
    const m = mat4.create(); // all zero → w' = 0*x+0*y+0*z+0*1 = 0
    const v = vec3.create(1, 2, 3);
    const out = vec3.create(9, 9, 9);
    const ret = mat4.transformVec3(out, m, v);
    expect(ret).toBe(out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe: transformVec3(v, I, v) ≈ v (boundary, out===v)', () => {
    const v = vec3.create(2, 4, 6);
    const I = mat4.identity(mat4.create());
    const ret = mat4.transformVec3(v, I, v);
    expect(ret).toBe(v);
    expect(v[0]).toBeCloseTo(2, 5);
    expect(v[1]).toBeCloseTo(4, 5);
    expect(v[2]).toBeCloseTo(6, 5);
  });
});

describe('mat4.transformPoint (M1 / t1, alias of transformVec3 — S-1)', () => {
  it('equivalent to transformVec3 (alias lock, OQ-1)', () => {
    const M = mat4.fromTranslation(mat4.create(), [10, 20, 30]);
    const v = vec3.create(1, 2, 3);
    const a = vec3.create();
    const b = vec3.create();
    mat4.transformVec3(a, M, v);
    mat4.transformPoint(b, M, v);
    expect(b[0]).toBeCloseTo(a[0] as number, 6);
    expect(b[1]).toBeCloseTo(a[1] as number, 6);
    expect(b[2]).toBeCloseTo(a[2] as number, 6);
    // same function body: reference-equal
    expect(mat4.transformPoint).toBe(mat4.transformVec3);
  });

  it('translation independently testable: transformPoint(T, origin) = t (normal)', () => {
    const T = mat4.fromTranslation(mat4.create(), [7, -8, 9]);
    const origin = vec3.create(0, 0, 0);
    const out = vec3.create();
    mat4.transformPoint(out, T, origin);
    expect(out[0]).toBeCloseTo(7, 5);
    expect(out[1]).toBeCloseTo(-8, 5);
    expect(out[2]).toBeCloseTo(9, 5);
  });

  it("w'=0 degenerate shares transformVec3 convention → out=(0,0,0) (degrade)", () => {
    const m = mat4.create();
    const out = vec3.create(1, 1, 1);
    mat4.transformPoint(out, m, vec3.create(5, 6, 7));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe (boundary)', () => {
    const v = vec3.create(3, 5, 7);
    const T = mat4.fromTranslation(mat4.create(), [1, 1, 1]);
    mat4.transformPoint(v, T, v);
    expect(v[0]).toBeCloseTo(4, 5);
    expect(v[1]).toBeCloseTo(6, 5);
    expect(v[2]).toBeCloseTo(8, 5);
  });
});

describe('mat4.transformDirection (M1 / t1)', () => {
  it('takes upper-left 3×3, ignores translation column: dir unaffected by T (normal)', () => {
    // T(100, 200, 300) applied to dir=(1,0,0): a direction vector must not be translated
    const T = mat4.fromTranslation(mat4.create(), [100, 200, 300]);
    const dir = vec3.create(1, 0, 0);
    const out = vec3.create();
    mat4.transformDirection(out, T, dir);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it('orthogonal m preserves unit length: rotateY π/2 applied to (1,0,0) → (0,0,-1) (normal)', () => {
    const R = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    const dir = vec3.create(1, 0, 0);
    const out = vec3.create();
    mat4.transformDirection(out, R, dir);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(-1, 5);
    // unit length preserved
    const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
    expect(len).toBeCloseTo(1, 5);
  });

  it('|out|=0 degenerate (singular m + dir) → out=(0,0,0) (degrade, D-4 silent convention)', () => {
    // all-zero m → 3×3 part all zero → out is (0,0,0) before normalize → vec3.normalize silent → (0,0,0)
    const m = mat4.create();
    const dir = vec3.create(1, 1, 1);
    const out = vec3.create(9, 9, 9);
    const ret = mat4.transformDirection(out, m, dir);
    expect(ret).toBe(out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe: transformDirection(v, R, v) (boundary)', () => {
    const R = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    const v = vec3.create(1, 0, 0);
    mat4.transformDirection(v, R, v);
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[2]).toBeCloseTo(-1, 5);
  });

  it('equivalent to transformVec3 on pure-rotation m (modulo normalize)', () => {
    // pure rotation matrices preserve unit length, so transformVec3 and transformDirection output the same value
    const R = mat4.fromRotation(mat4.create(), [0, 0, 1], Math.PI / 4);
    const v = vec3.create(1, 0, 0); // unit-length input
    const a = vec3.create();
    const b = vec3.create();
    mat4.transformVec3(a, R, v);
    mat4.transformDirection(b, R, v);
    expect(b[0]).toBeCloseTo(a[0] as number, 5);
    expect(b[1]).toBeCloseTo(a[1] as number, 5);
    expect(b[2]).toBeCloseTo(a[2] as number, 5);
  });
});

describe('mat4 — V8 elements-kinds performance guard', () => {
  it('all return values are Float32Array (no number[] coercion)', () => {
    const out1 = mat4.identity(mat4.create());
    const out2 = mat4.multiply(mat4.create(), out1, out1);
    const out3 = mat4.perspective(mat4.create(), 1, 1, 0.1, 100);
    const out4 = mat4.translate(mat4.create(), out1, [1, 1, 1]);
    expect(out1).toBeInstanceOf(Float32Array);
    expect(out2).toBeInstanceOf(Float32Array);
    expect(out3).toBeInstanceOf(Float32Array);
    expect(out4).toBeInstanceOf(Float32Array);
  });
});

// M3 / T-coverage — mat4 branch coverage backfill (T-035 follow-up)
//
// Targets the surviving uncovered branches identified by v8 coverage
// (76.59% → ≥80%, AC-10 hard floor). Each it lifts a specific branch:
//   - equals epsilon-fail (L85)         — finite diff > epsilon path
//   - translate aliasing (L288)         — `if (a === out)` true path
//   - rotate zero-axis × out!==a (L347, L349 if-true path)
//   - rotate zero-axis × out===a (L349 if-false path)
//   - lookAt up collinear with forward (L449) — perpendicular axis fallback
//   - decompose zero-scale (L575/576/577) — sx=0 ? 0 : 1/sx ternary true paths
describe('mat4 — M3 branch coverage backfill', () => {
  it('equals(a, b) returns false when finite diff > epsilon (L85)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[0] = 2;
    expect(mat4.equals(a, b)).toBe(false);
  });

  it('equals(a, b) honours custom epsilon argument (L85 boundary)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[5] = 1 + 1e-3;
    expect(mat4.equals(a, b)).toBe(false);
    expect(mat4.equals(a, b, 1e-2)).toBe(true);
  });

  it('translate aliasing: translate(m, m, v) writes the translation column in place (L288)', () => {
    const m = mat4.identity(mat4.create());
    const ret = mat4.translate(m, m, [1, 2, 3]);
    expect(ret).toBe(m);
    expect(m[12]).toBeCloseTo(1, 5);
    expect(m[13]).toBeCloseTo(2, 5);
    expect(m[14]).toBeCloseTo(3, 5);
    expect(m[15]).toBeCloseTo(1, 5);
  });

  it('rotate(out, a, zero-axis) copies a to out when out !== a (L347 + L349 out!==a)', () => {
    const a = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [4, 5, 6]);
    const out = mat4.create();
    const ret = mat4.rotate(out, a, [0, 0, 0], Math.PI / 4);
    expect(ret).toBe(out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(a[i] as number, 5);
  });

  it('rotate(m, m, zero-axis) is a no-op when out === a (L349 out===a)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [7, 8, 9]);
    const before = mat4.clone(m);
    const ret = mat4.rotate(m, m, [0, 0, 0], Math.PI / 3);
    expect(ret).toBe(m);
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(before[i] as number, 5);
  });

  it('lookAt picks the alternative up axis when up is collinear with forward (L449)', () => {
    // forward = normalize(eye - target) = (0, 1, 0); cross((0,1,0), (0,1,0)) = 0 → alt up = (0,0,1)
    const m = mat4.lookAt(mat4.create(), [0, 1, 0], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
    // bottom row of view matrix is (0, 0, 0, 1)
    expect(m[3]).toBe(0);
    expect(m[7]).toBe(0);
    expect(m[11]).toBe(0);
    expect(m[15]).toBe(1);
  });

  it('decompose silently handles zero-scale source matrix (L575/576/577 sxFinal===0 etc.)', () => {
    // construct an affine where the X column is the zero vector (sx == 0); Y/Z preserve identity
    const m = mat4.create();
    m[0] = 0;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 1;
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    m[9] = 0;
    m[10] = 1;
    m[11] = 0;
    m[12] = 0;
    m[13] = 0;
    m[14] = 0;
    m[15] = 1;
    const t = vec3.create();
    const r = quat.identity(quat.create());
    const s = vec3.create();
    expect(() => mat4.decompose(t, r, s, m)).not.toThrow();
    expect(s[0]).toBeCloseTo(0);
    expect(s[1]).toBeCloseTo(1);
    expect(s[2]).toBeCloseTo(1);
    for (let i = 0; i < 4; i++) expect(Number.isFinite(r[i] as number)).toBe(true);
  });
});

// ============================================================
// mat4.unproject (feat-20260529-picking-raycasting-screen-to-entity M2 w5)
// ============================================================
//
// Three scenarios per requirements AC-03 + AC-10:
//   1. perspective camera screen-center → unprojected direction ≈ camera forward
//   2. orthographic camera → direction constant = forward, origin translates with screen coords
//   3. y-flip: screen y-down coordinates → NDC y-up (via 1 - 2*screenY/viewportH)
//
// WebGPU [0,1] NDC z convention (research Finding 6 / D-NDC):
//   near plane → z_ndc = 0, far plane → z_ndc = 1
//
// Related: requirements AC-03 / AC-10; plan-tasks.json w5 acceptanceCheck.

describe('mat4.unproject', () => {
  // Helper: build a perspective view-projection pair and its inverse
  function makePerspectiveInvVP(): {
    view: Float32Array;
    proj: Float32Array;
    invVP: Float32Array;
    forward: [number, number, number];
  } {
    // Camera at (1, 2, 5) looking at (1, 2, -5) → forward = (0, 0, -1) in world space
    const eye: [number, number, number] = [1, 2, 5];
    const target: [number, number, number] = [1, 2, -5];
    const up: [number, number, number] = [0, 1, 0];
    const view = mat4.lookAt(mat4.create(), eye, target, up);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 4 / 3, 0.1, 100);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const invVP = mat4.invert(mat4.create(), vp);
    return { view, proj, invVP, forward: [0, 0, -1] };
  }

  // Helper: build an orthographic view-projection pair and its inverse
  function makeOrthoInvVP(): {
    view: Float32Array;
    proj: Float32Array;
    invVP: Float32Array;
    forward: [number, number, number];
  } {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const view = mat4.lookAt(mat4.create(), eye, target, up);
    const proj = mat4.orthographic(mat4.create(), -4, 4, 3, -3, 0.1, 100);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const invVP = mat4.invert(mat4.create(), vp);
    return { view, proj, invVP, forward: [0, 0, -1] };
  }

  // ---------- 1. perspective unproject ----------

  it('perspective screen-center near (z=0) unprojects to world point on near plane', () => {
    const { invVP } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    // Near point should be in front of the camera (z < eye.z = 5), on the near plane
    expect(Number.isFinite(nearPoint[0] as number)).toBe(true);
    expect(Number.isFinite(nearPoint[1] as number)).toBe(true);
    expect(Number.isFinite(nearPoint[2] as number)).toBe(true);
  });

  it('perspective screen-center far (z=1) unprojects to a farther world point', () => {
    const { invVP, forward } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    const dirLen = vec3.length(dir);
    expect(dirLen).toBeGreaterThan(0);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    expect(dot).toBeGreaterThan(0.99);
  });

  it('perspective screen-center direction is approximately camera forward (angle < epsilon)', () => {
    const { invVP, forward } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    // cos(0.1°) ≈ 0.999998 — very tight tolerance for screen-center
    expect(dot).toBeGreaterThan(0.99999);
  });

  it('perspective off-center NDC unprojects to different lateral world position', () => {
    const { invVP } = makePerspectiveInvVP();
    const centerNear = vec3.create();
    const rightNear = vec3.create();
    mat4.unproject(centerNear, [0, 0, 0], invVP);
    mat4.unproject(rightNear, [0.5, 0, 0], invVP);
    // right-side NDC should produce a point with larger x in world space
    expect(rightNear[0]).toBeGreaterThan(centerNear[0] as number);
  });

  // ---------- 2. orthographic unproject ----------

  it('ortho near/far center produce direction = camera forward', () => {
    const { invVP, forward } = makeOrthoInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    expect(dot).toBeGreaterThan(0.99999);
  });

  it('ortho origin translates with screen coordinates (NDC x shift → world x shift)', () => {
    const { invVP } = makeOrthoInvVP();
    // Two NDC points at the same depth, different x
    const p0 = vec3.create();
    const p1 = vec3.create();
    mat4.unproject(p0, [-0.5, 0, 0], invVP);
    mat4.unproject(p1, [0.5, 0, 0], invVP);
    // p1.x should be greater than p0.x, and the delta should be non-trivial
    const dx = (p1[0] as number) - (p0[0] as number);
    expect(dx).toBeGreaterThan(0);
    // In ortho, the world-space X extent maps linearly to NDC; check proportional
    expect(dx).toBeCloseTo(4, 0); // left=-4, right=4 → NDC width of 2 → world width of 8; NDC step of 1 = 8 → dx for (0.5 - -0.5) = 1 → ~8
  });

  it('ortho origin Y shift proportional to screen displacement', () => {
    const { invVP } = makeOrthoInvVP();
    const pBottom = vec3.create();
    const pTop = vec3.create();
    mat4.unproject(pBottom, [0, -0.5, 0], invVP);
    mat4.unproject(pTop, [0, 0.5, 0], invVP);
    // Ortho: bottom=-3, top=3 → world height=6; NDC height=2; NDC step of 1 → world step of 3
    const dyY = (pTop[1] as number) - (pBottom[1] as number);
    expect(dyY).toBeCloseTo(3, 0);
  });

  // ---------- 3. y-flip ----------

  it('y-flip: upper screen y (small screen coord) → upper NDC y (positive)', () => {
    // screen y = 0 (top of screen) → ndc y = 1 - 2*0/H = 1 (top of NDC, which is +y)
    // screen y = H (bottom) → ndc y = 1 - 2*H/H = -1 (bottom of NDC, which is -y)
    const { invVP } = makePerspectiveInvVP();
    // Use two screen-space y values: screenY=50 → low (near top), screenY=400 → high (near bottom)
    // Corresponding NDC y:
    //   ndcTop = 1 - 2*50/600 = 1 - 0.1667 = 0.8333
    //   ndcBottom = 1 - 2*400/600 = 1 - 1.3333 = -0.3333
    const ndcTopY = 1 - (2 * 50) / 600;
    const ndcBottomY = 1 - (2 * 400) / 600;
    const pTop = vec3.create();
    const pBottom = vec3.create();
    mat4.unproject(pTop, [0, ndcTopY, 0], invVP);
    mat4.unproject(pBottom, [0, ndcBottomY, 0], invVP);
    // World-space: y increases upward. pTop (from higher screen y/NDC y) should have larger world y
    expect(pTop[1]).toBeGreaterThan(pBottom[1] as number);
  });
});

// ============================================================
// getTranslation / getForward / getUp / getRight (AC-08)
// ============================================================
//
// feat-20260601-unify-transform-local-global-mat4-drop-globaltrans / M1 / w5.
//
// Three-quadrant correctness of the four world-mat4 basis/translation
// accessors, with the old single-quaternion direction path as oracle:
//   - getRight  = normalize(col0)  == quat.transformVec3(q, [1, 0, 0])
//   - getUp     = normalize(col1)  == quat.transformVec3(q, [0, 1, 0])
//   - getForward = -normalize(col2) == quat.transformVec3(q, [0, 0, -1])  (RL-4)
//   - getTranslation = (m[12], m[13], m[14])  (no normalize)
//
// Quadrants (AC-08):
//   1. pure rotation (sx=sy=sz=1)
//   2. uniform scale s=3 (normalize cancels the scale)
//   3. non-uniform scale (sx=2, sy=1, sz=1) + non-trivial rotation
//      (the falsifiable quadrant: a missing normalize or a +col2 forward
//       sign error shows up here)
// Boundary: a zero direction column normalizes to (0,0,0) (D-4 fallback).

const EPS_DIR = 1e-5;

function expectVec3Close(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual[0]).toBeCloseTo(expected[0] as number, 5);
  expect(actual[1]).toBeCloseTo(expected[1] as number, 5);
  expect(actual[2]).toBeCloseTo(expected[2] as number, 5);
}

describe('mat4.getTranslation / getForward / getUp / getRight (AC-08)', () => {
  it('quadrant 1: pure rotation -- basis aligns with quat oracle', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 3);
    const m = mat4.compose(mat4.create(), [4, 5, 6], q, [1, 1, 1]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    expectVec3Close(mat4.getRight(vec3.create(), m), right);
    expectVec3Close(mat4.getUp(vec3.create(), m), up);
    expectVec3Close(mat4.getForward(vec3.create(), m), forward);
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [4, 5, 6]);
  });

  it('quadrant 2: uniform scale s=3 -- normalize cancels the scale', () => {
    const q = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 4);
    const m = mat4.compose(mat4.create(), [0, 0, 0], q, [3, 3, 3]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    const r = mat4.getRight(vec3.create(), m);
    const u = mat4.getUp(vec3.create(), m);
    const f = mat4.getForward(vec3.create(), m);
    // normalized basis is unit-length regardless of uniform scale.
    expect(vec3.length(r)).toBeCloseTo(1, 5);
    expect(vec3.length(u)).toBeCloseTo(1, 5);
    expect(vec3.length(f)).toBeCloseTo(1, 5);
    expectVec3Close(r, right);
    expectVec3Close(u, up);
    expectVec3Close(f, forward);
  });

  it('quadrant 3: non-uniform scale (2,1,1) + non-trivial rotation -- falsifiable', () => {
    const q = quat.fromAxisAngle(quat.create(), [0.5, 1, 0.25], 0.9);
    const m = mat4.compose(mat4.create(), [1, -2, 3], q, [2, 1, 1]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    const r = mat4.getRight(vec3.create(), m);
    const u = mat4.getUp(vec3.create(), m);
    const f = mat4.getForward(vec3.create(), m);
    // Non-uniform scale stretches the columns; normalize restores the
    // rotation-only direction, matching the quat oracle within epsilon.
    expect(Math.abs((r[0] as number) - (right[0] as number))).toBeLessThanOrEqual(EPS_DIR);
    expectVec3Close(r, right);
    expectVec3Close(u, up);
    expectVec3Close(f, forward);
    // Translation is read straight from col3 (no normalize on a 2x scale).
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [1, -2, 3]);
  });

  it('getTranslation reads col3 (m[12,13,14]) without normalizing', () => {
    const m = mat4.identity(mat4.create());
    m[12] = 10;
    m[13] = 20;
    m[14] = 30;
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [10, 20, 30]);
  });

  it('zero direction column -> (0,0,0) (D-4 normalize fallback)', () => {
    // A matrix with zero col0/col1/col2 (degenerate); direction accessors
    // fall back to (0,0,0) via vec3.normalize, getTranslation stays exact.
    const m = mat4.create(); // all-zero
    m[12] = 7;
    m[13] = 8;
    m[14] = 9;
    expectVec3Close(mat4.getRight(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getUp(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getForward(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [7, 8, 9]);
  });
});

}
