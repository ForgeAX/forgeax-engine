// mat4.test-d.ts — branded return type + dimension-mix-up compile-time assertions (T-018)
//
// Locks multiply / invert / transpose to return Mat4; dimension mix-ups
// (mat4.multiply(out, vec3, vec3)) are ts-expect-error; lookAt's Vec3 inputs are also type-locked.
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion;
//          research §Finding 7.3 dimension-mix-up call → ts-error template.

import { describe, expectTypeOf, it } from 'vitest';
import { mat4 } from '../index';
import type { Mat3, Mat4, Quat, Vec3, Vec4 } from '../types';

describe('mat4 — branded return-type locks', () => {
  it('mat4.create returns Mat4', () => {
    expectTypeOf(mat4.create()).toEqualTypeOf<Mat4>();
  });

  it('mat4.view returns Mat4 from packed f32 storage', () => {
    expectTypeOf(mat4.view(new Float32Array(32), 1)).toEqualTypeOf<Mat4>();
  });

  it('mat4.identity returns Mat4', () => {
    expectTypeOf(mat4.identity(mat4.create())).toEqualTypeOf<Mat4>();
  });

  it('mat4.multiply returns Mat4', () => {
    expectTypeOf(mat4.multiply(mat4.create(), mat4.create(), mat4.create())).toEqualTypeOf<Mat4>();
  });

  it('mat4.transpose returns Mat4', () => {
    expectTypeOf(mat4.transpose(mat4.create(), mat4.create())).toEqualTypeOf<Mat4>();
  });

  it('mat4.invert returns Mat4 (does not return null, AC-08 cross-vendor rewrite)', () => {
    expectTypeOf(mat4.invert(mat4.create(), mat4.create())).toEqualTypeOf<Mat4>();
  });

  it('mat4.perspective returns Mat4', () => {
    expectTypeOf(mat4.perspective(mat4.create(), 1, 1, 0.1, 100)).toEqualTypeOf<Mat4>();
  });

  it('mat4.perspectiveReverseZ returns Mat4', () => {
    expectTypeOf(mat4.perspectiveReverseZ(mat4.create(), 1, 1, 0.1, 100)).toEqualTypeOf<Mat4>();
  });
});

describe('mat4 — cross-namespace misuse blocked at compile time (out brand lock)', () => {
  it('mat4.identity must reject Mat3 as out', () => {
    const m3: Mat3 = null as unknown as Mat3;
    // @ts-expect-error — out must be Mat4, not Mat3
    mat4.identity(m3);
  });

  it('mat4.multiply must reject Vec3 as out', () => {
    const v3: Vec3 = null as unknown as Vec3;
    const m4: Mat4 = mat4.create();
    // @ts-expect-error — out must be Mat4, not Vec3
    mat4.multiply(v3, m4, m4);
  });

  it('mat4.invert must reject Mat3 as out', () => {
    const m3: Mat3 = null as unknown as Mat3;
    const m4: Mat4 = mat4.create();
    // @ts-expect-error — out must be Mat4, not Mat3
    mat4.invert(m3, m4);
  });
});

// M1 / t3 — mat4 transform 3-function brand mutual exclusion + return type + alias type consistency
//
// Related: requirements §6 AC-15 + §10.1 brand-safety row;
//          research Finding 4 table: brand type mismatch → compile-time TS error;
//          plan-strategy §4.3 key test points table row 6 + §7.1 brand safety.
describe('mat4 transform 3 functions — branded return type + brand mutual exclusion (M1 / t3)', () => {
  it('mat4.transformVec3 returns Vec3', () => {
    const v: Vec3 = null as unknown as Vec3;
    const m: Mat4 = mat4.create();
    expectTypeOf(mat4.transformVec3(v, m, v)).toEqualTypeOf<Vec3>();
  });

  it('mat4.transformPoint returns Vec3', () => {
    const v: Vec3 = null as unknown as Vec3;
    const m: Mat4 = mat4.create();
    expectTypeOf(mat4.transformPoint(v, m, v)).toEqualTypeOf<Vec3>();
  });

  it('mat4.transformDirection returns Vec3', () => {
    const v: Vec3 = null as unknown as Vec3;
    const m: Mat4 = mat4.create();
    expectTypeOf(mat4.transformDirection(v, m, v)).toEqualTypeOf<Vec3>();
  });

  it('transformPoint shares the same type signature as transformVec3 (alias form, S-1)', () => {
    expectTypeOf(mat4.transformPoint).toEqualTypeOf<typeof mat4.transformVec3>();
  });

  it('mat4.transformVec3 must reject Vec4 as out (Vec3 ≠ Vec4 brand mutual exclusion)', () => {
    const v4: Vec4 = null as unknown as Vec4;
    const m: Mat4 = mat4.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Vec4
    mat4.transformVec3(v4, m, v3);
  });

  it('mat4.transformPoint must reject Quat as out (Vec3 ≠ Quat brand mutual exclusion)', () => {
    const q: Quat = null as unknown as Quat;
    const m: Mat4 = mat4.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Quat
    mat4.transformPoint(q, m, v3);
  });

  it('mat4.transformDirection must reject Mat4 as out (Vec3 ≠ Mat4 brand mutual exclusion)', () => {
    const m4: Mat4 = mat4.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Mat4
    mat4.transformDirection(m4, m4, v3);
  });

  // G-4 (roadmap 2026-06-15 game-demo-engine-gaps) — projectPoint dual of unproject
  it('mat4.projectPoint returns Vec3', () => {
    const v: Vec3 = null as unknown as Vec3;
    const m: Mat4 = mat4.create();
    expectTypeOf(mat4.projectPoint(v, v, m)).toEqualTypeOf<Vec3>();
  });

  it('mat4.projectPoint must reject Quat as out (Vec3 ≠ Quat brand mutual exclusion)', () => {
    const q: Quat = null as unknown as Quat;
    const m: Mat4 = mat4.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Quat
    mat4.projectPoint(q, v3, m);
  });
});
