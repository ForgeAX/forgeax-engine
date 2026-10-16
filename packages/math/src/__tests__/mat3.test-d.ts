// mat3.test-d.ts — branded return type + dimension-mix-up compile-time assertions (T-018)
//
// Locks multiply / invert / transpose to return Mat3; dimension mix-ups are ts-error.
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion;
//          wiki/typescript-branded-types §3.1 expectTypeOf template + §7.3 ts-expect-error.

import { describe, expectTypeOf, it } from 'vitest';
import { mat3 } from '../index';
import type { Mat3, Mat4, Vec3 } from '../types';

describe('mat3 — branded return-type locks', () => {
  it('mat3.create returns Mat3', () => {
    expectTypeOf(mat3.create()).toEqualTypeOf<Mat3>();
  });

  it('mat3.identity returns Mat3', () => {
    expectTypeOf(mat3.identity(mat3.create())).toEqualTypeOf<Mat3>();
  });

  it('mat3.multiply returns Mat3', () => {
    expectTypeOf(mat3.multiply(mat3.create(), mat3.create(), mat3.create())).toEqualTypeOf<Mat3>();
  });

  it('mat3.transpose returns Mat3', () => {
    expectTypeOf(mat3.transpose(mat3.create(), mat3.create())).toEqualTypeOf<Mat3>();
  });

  it('mat3.invert returns Mat3 (does not return null, D-P1)', () => {
    expectTypeOf(mat3.invert(mat3.create(), mat3.create())).toEqualTypeOf<Mat3>();
  });
});

describe('mat3 — cross-namespace misuse blocked at compile time', () => {
  it('mat3.multiply must reject Mat4 as out', () => {
    const m4: Mat4 = null as unknown as Mat4;
    const m3: Mat3 = mat3.create();
    // @ts-expect-error — out must be Mat3, not Mat4
    mat3.multiply(m4, m3, m3);
  });

  it('mat3.identity must reject Vec3 as out', () => {
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Mat3, not Vec3
    mat3.identity(v3);
  });
});
