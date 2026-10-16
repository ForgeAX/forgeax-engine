// vec2.test-d.ts — branded return type + dimension mutual-exclusion compile-time assertions (T-012)
//
// Locks add / sub / scale / normalize / lerp / perp etc. to return Vec2;
// vec2.add(out=Vec3, ...) is a ts-error verifying dimension mutual exclusion
// (an AC-02 brand-mutex contribution).
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion;
//          wiki/typescript-branded-types §3.1 expectTypeOf template + §7.3 ts-expect-error.

import { describe, expectTypeOf, it } from 'vitest';
import { vec2 } from '../index';
import type { Vec2, Vec3 } from '../types';

describe('vec2 — branded return-type locks', () => {
  it('vec2.create returns Vec2', () => {
    expectTypeOf(vec2.create()).toEqualTypeOf<Vec2>();
  });

  it('vec2.add returns Vec2', () => {
    expectTypeOf(vec2.add(vec2.create(), vec2.create(), vec2.create())).toEqualTypeOf<Vec2>();
  });

  it('vec2.sub returns Vec2', () => {
    expectTypeOf(vec2.sub(vec2.create(), vec2.create(), vec2.create())).toEqualTypeOf<Vec2>();
  });

  it('vec2.scale returns Vec2', () => {
    expectTypeOf(vec2.scale(vec2.create(), vec2.create(), 1)).toEqualTypeOf<Vec2>();
  });

  it('vec2.normalize returns Vec2', () => {
    expectTypeOf(vec2.normalize(vec2.create(), vec2.create())).toEqualTypeOf<Vec2>();
  });

  it('vec2.lerp returns Vec2', () => {
    expectTypeOf(vec2.lerp(vec2.create(), vec2.create(), vec2.create(), 0.5)).toEqualTypeOf<Vec2>();
  });

  it('vec2.perp returns Vec2', () => {
    expectTypeOf(vec2.perp(vec2.create(), vec2.create())).toEqualTypeOf<Vec2>();
  });

  it('vec2.dot returns number', () => {
    expectTypeOf(vec2.dot(vec2.create(), vec2.create())).toEqualTypeOf<number>();
  });

  it('vec2.length returns number', () => {
    expectTypeOf(vec2.length(vec2.create())).toEqualTypeOf<number>();
  });
});

describe('vec2 — cross-namespace misuse blocked at compile time', () => {
  it('vec2.add must reject Vec3 as out', () => {
    const v3: Vec3 = null as unknown as Vec3;
    const v2: Vec2 = vec2.create();
    // @ts-expect-error — out must be Vec2, not Vec3
    vec2.add(v3, v2, v2);
  });
});
