// euler.test-d.ts — branded return type + EulerOrder union compile-time assertions (T-026)
//
// Locks the return types of euler.create / set / clone / toQuat / fromQuat / fromRotationMatrix;
// EulerOrder union has 6 exhaustive members; euler.fromQuat(q, 'INVALID') is ts-error.
//
// Related: requirements §AC-12 type test; plan-strategy §4.2 type test;
//          wiki/typescript-branded-types §3.1 expectTypeOf template.

import { describe, expectTypeOf, it } from 'vitest';
import { euler, quat } from '../index';
import type { Euler, EulerOrder, Mat3, Quat } from '../types';

describe('euler — return-type locks', () => {
  it('euler.create returns Euler', () => {
    expectTypeOf(euler.create()).toEqualTypeOf<Euler>();
  });

  it('euler.clone returns Euler', () => {
    expectTypeOf(euler.clone(euler.create())).toEqualTypeOf<Euler>();
  });

  it('euler.set returns Euler', () => {
    expectTypeOf(euler.set(euler.create(), 0, 0, 0, 'XYZ')).toEqualTypeOf<Euler>();
  });

  it('euler.toQuat returns Quat', () => {
    expectTypeOf(euler.toQuat(quat.create(), euler.create())).toEqualTypeOf<Quat>();
  });

  it('euler.fromQuat returns Euler', () => {
    expectTypeOf(euler.fromQuat(euler.create(), quat.create(), 'XYZ')).toEqualTypeOf<Euler>();
  });

  it('euler.fromRotationMatrix returns Euler', () => {
    const m: Mat3 = null as unknown as Mat3;
    expectTypeOf(euler.fromRotationMatrix(euler.create(), m, 'XYZ')).toEqualTypeOf<Euler>();
  });
});

describe('euler — EulerOrder union lock + invalid-order rejection', () => {
  it('EulerOrder union exhaustive over 6 members', () => {
    expectTypeOf<EulerOrder>().toEqualTypeOf<'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY'>();
  });

  it('euler.set accepts every one of the 6 EulerOrder values', () => {
    euler.set(euler.create(), 0, 0, 0, 'XYZ');
    euler.set(euler.create(), 0, 0, 0, 'YXZ');
    euler.set(euler.create(), 0, 0, 0, 'ZXY');
    euler.set(euler.create(), 0, 0, 0, 'ZYX');
    euler.set(euler.create(), 0, 0, 0, 'YZX');
    euler.set(euler.create(), 0, 0, 0, 'XZY');
  });

  it('euler.fromQuat rejects the INVALID literal', () => {
    // @ts-expect-error — 'INVALID' is not in the EulerOrder union
    euler.fromQuat(euler.create(), quat.create(), 'INVALID');
  });

  it('euler.set rejects the INVALID literal', () => {
    // @ts-expect-error — 'INVALID' is not in the EulerOrder union
    euler.set(euler.create(), 0, 0, 0, 'INVALID');
  });
});
