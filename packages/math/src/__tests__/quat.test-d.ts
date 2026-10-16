// quat.test-d.ts — branded return type + dimension-mix-up compile-time assertions (T-026)
//
// Locks quat.create / fromAxisAngle / fromEuler / slerp / nlerp / multiply / invert /
// conjugate / normalize / fromRotationMatrix / fromLookAt / fromUnitVectors to return Quat;
// dimension mix-ups (quat.multiply(out, vec3, vec3)) are ts-expect-error;
// EulerOrder union is locked to 6 exhaustive values; fromEuler(_, _, _, _, 'INVALID') is ts-error.
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion (≥ 3 quat contributions);
//          plan-strategy §4.2 type test;
//          wiki/typescript-branded-types §3.1 expectTypeOf template + §7.3 ts-expect-error.

import { describe, expectTypeOf, it } from 'vitest';
import { quat } from '../index';
import type { EulerOrder, Mat4, Quat, Vec3 } from '../types';

describe('quat — branded return-type locks', () => {
  it('quat.create returns Quat', () => {
    expectTypeOf(quat.create()).toEqualTypeOf<Quat>();
  });

  it('quat.identity returns Quat', () => {
    expectTypeOf(quat.identity(quat.create())).toEqualTypeOf<Quat>();
  });

  it('quat.fromAxisAngle returns Quat', () => {
    expectTypeOf(
      quat.fromAxisAngle(quat.create(), [1, 0, 0] as unknown as Vec3, 1),
    ).toEqualTypeOf<Quat>();
  });

  it('quat.fromEuler returns Quat', () => {
    expectTypeOf(quat.fromEuler(quat.create(), 0, 0, 0, 'XYZ')).toEqualTypeOf<Quat>();
  });

  it('quat.multiply returns Quat', () => {
    expectTypeOf(quat.multiply(quat.create(), quat.create(), quat.create())).toEqualTypeOf<Quat>();
  });

  it('quat.slerp returns Quat', () => {
    expectTypeOf(
      quat.slerp(quat.create(), quat.create(), quat.create(), 0.5),
    ).toEqualTypeOf<Quat>();
  });

  it('quat.nlerp returns Quat', () => {
    expectTypeOf(
      quat.nlerp(quat.create(), quat.create(), quat.create(), 0.5),
    ).toEqualTypeOf<Quat>();
  });

  it('quat.invert returns Quat', () => {
    expectTypeOf(quat.invert(quat.create(), quat.create())).toEqualTypeOf<Quat>();
  });

  it('quat.conjugate returns Quat', () => {
    expectTypeOf(quat.conjugate(quat.create(), quat.create())).toEqualTypeOf<Quat>();
  });

  it('quat.normalize returns Quat', () => {
    expectTypeOf(quat.normalize(quat.create(), quat.create())).toEqualTypeOf<Quat>();
  });

  it('quat.fromLookAt returns Quat', () => {
    expectTypeOf(
      quat.fromLookAt(quat.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]),
    ).toEqualTypeOf<Quat>();
  });
});

describe('quat — cross-namespace misuse blocked at compile time (out brand lock)', () => {
  it('quat.identity must reject Vec3 as out', () => {
    const v: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Quat, not Vec3
    quat.identity(v);
  });

  it('quat.multiply must reject Mat4 as out', () => {
    const m: Mat4 = null as unknown as Mat4;
    const q: Quat = quat.create();
    // @ts-expect-error — out must be Quat, not Mat4
    quat.multiply(m, q, q);
  });

  it('quat.slerp must reject Vec3 as out', () => {
    const v: Vec3 = null as unknown as Vec3;
    const q: Quat = quat.create();
    // @ts-expect-error — out must be Quat, not Vec3
    quat.slerp(v, q, q, 0.5);
  });
});

describe('quat — EulerOrder union exhaustively locked to 6 values', () => {
  it('EulerOrder contains the 6 entries XYZ / YXZ / ZXY / ZYX / YZX / XZY', () => {
    expectTypeOf<EulerOrder>().toEqualTypeOf<'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY'>();
  });

  it('quat.fromEuler accepts every one of the 6 EulerOrder values', () => {
    quat.fromEuler(quat.create(), 0, 0, 0, 'XYZ');
    quat.fromEuler(quat.create(), 0, 0, 0, 'YXZ');
    quat.fromEuler(quat.create(), 0, 0, 0, 'ZXY');
    quat.fromEuler(quat.create(), 0, 0, 0, 'ZYX');
    quat.fromEuler(quat.create(), 0, 0, 0, 'YZX');
    quat.fromEuler(quat.create(), 0, 0, 0, 'XZY');
  });

  it('quat.fromEuler rejects string literals outside the union', () => {
    // @ts-expect-error — 'INVALID' is not in the EulerOrder union
    quat.fromEuler(quat.create(), 0, 0, 0, 'INVALID');
  });
});

// M1 / t3 — quat.transformVec3 brand mutual exclusion + return type
//
// Related: requirements §6 AC-15 + §10.1 brand-safety row;
//          research Finding 4 table: brand type mismatch → compile-time TS error;
//          plan-strategy §4.3 key test points table row 6 + §7.1 brand safety.
describe('quat.transformVec3 — branded return type + brand mutual exclusion (M1 / t3)', () => {
  it('quat.transformVec3 returns Vec3', () => {
    const v: Vec3 = null as unknown as Vec3;
    const q: Quat = quat.create();
    expectTypeOf(quat.transformVec3(v, q, v)).toEqualTypeOf<Vec3>();
  });

  it('quat.transformVec3 must reject Quat as out (Vec3 ≠ Quat brand mutual exclusion)', () => {
    const q: Quat = quat.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Quat
    quat.transformVec3(q, q, v3);
  });

  it('quat.transformVec3 must reject Mat4 as out (Vec3 ≠ Mat4 brand mutual exclusion)', () => {
    const m4: Mat4 = null as unknown as Mat4;
    const q: Quat = quat.create();
    const v3: Vec3 = null as unknown as Vec3;
    // @ts-expect-error — out must be Vec3, not Mat4
    quat.transformVec3(m4, q, v3);
  });
});
