// vec4.test-d.ts — branded return type + dimension mutual-exclusion compile-time assertions (T-012)
//
// Locks add / sub / scale / normalize / lerp to return Vec4; vec4.add(out=Vec3, ...) is a ts-error.
// Vec4 ≠ Quat: contributes to the same-length=4 brand mutual-exclusion check.
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion;
//          wiki/typescript-branded-types §3.1 expectTypeOf template + §7.3 ts-expect-error.

import { describe, expectTypeOf, it } from 'vitest';
import { vec4 } from '../index';
import type { Quat, Vec3, Vec4 } from '../types';

describe('vec4 — branded return-type locks', () => {
  it('vec4.create returns Vec4', () => {
    expectTypeOf(vec4.create()).toEqualTypeOf<Vec4>();
  });

  it('vec4.add returns Vec4', () => {
    expectTypeOf(vec4.add(vec4.create(), vec4.create(), vec4.create())).toEqualTypeOf<Vec4>();
  });

  it('vec4.sub returns Vec4', () => {
    expectTypeOf(vec4.sub(vec4.create(), vec4.create(), vec4.create())).toEqualTypeOf<Vec4>();
  });

  it('vec4.scale returns Vec4', () => {
    expectTypeOf(vec4.scale(vec4.create(), vec4.create(), 1)).toEqualTypeOf<Vec4>();
  });

  it('vec4.normalize returns Vec4', () => {
    expectTypeOf(vec4.normalize(vec4.create(), vec4.create())).toEqualTypeOf<Vec4>();
  });

  it('vec4.lerp returns Vec4', () => {
    expectTypeOf(vec4.lerp(vec4.create(), vec4.create(), vec4.create(), 0.5)).toEqualTypeOf<Vec4>();
  });

  it('vec4.dot returns number', () => {
    expectTypeOf(vec4.dot(vec4.create(), vec4.create())).toEqualTypeOf<number>();
  });

  it('vec4.length returns number', () => {
    expectTypeOf(vec4.length(vec4.create())).toEqualTypeOf<number>();
  });
});

describe('vec4 — cross-namespace misuse blocked at compile time', () => {
  it('vec4.add must reject Vec3 as out', () => {
    const v3: Vec3 = null as unknown as Vec3;
    const v4: Vec4 = vec4.create();
    // @ts-expect-error — out must be Vec4, not Vec3
    vec4.add(v3, v4, v4);
  });

  it('Vec4 ≠ Quat (same length=4 brand mutual exclusion) — out must be Vec4', () => {
    const q: Quat = null as unknown as Quat;
    // @ts-expect-error — out must be Vec4; Quat is rejected (Vec4Like inputs allow ArrayLike,
    // but the out type is strictly brand-locked, so Quat as out triggers a ts-error).
    vec4.add(q, vec4.create(), vec4.create());
  });
});
