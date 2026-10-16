// vec3.test-d.ts — branded return type + dimension mutual-exclusion compile-time assertions (T-012)
//
// Locks add / sub / scale / normalize / cross / lerp to return Vec3;
// vec3.add(out=Vec2, ...) is a ts-error; vec3.cross(out, vec2, vec2) is also a ts-error.
//
// Related: requirements §AC-12 type test + AC-02 brand mutual exclusion;
//          wiki/typescript-branded-types §3.1 expectTypeOf template + §7.3 ts-expect-error.

import { describe, expectTypeOf, it } from 'vitest';
import { vec3 } from '../index';
import type { Vec2, Vec3, Vec4 } from '../types';

describe('vec3 — branded return-type locks', () => {
  it('vec3.create returns Vec3', () => {
    expectTypeOf(vec3.create()).toEqualTypeOf<Vec3>();
  });

  it('vec3.add returns Vec3', () => {
    expectTypeOf(vec3.add(vec3.create(), vec3.create(), vec3.create())).toEqualTypeOf<Vec3>();
  });

  it('vec3.sub returns Vec3', () => {
    expectTypeOf(vec3.sub(vec3.create(), vec3.create(), vec3.create())).toEqualTypeOf<Vec3>();
  });

  it('vec3.scale returns Vec3', () => {
    expectTypeOf(vec3.scale(vec3.create(), vec3.create(), 1)).toEqualTypeOf<Vec3>();
  });

  it('vec3.normalize returns Vec3', () => {
    expectTypeOf(vec3.normalize(vec3.create(), vec3.create())).toEqualTypeOf<Vec3>();
  });

  it('vec3.cross returns Vec3', () => {
    expectTypeOf(vec3.cross(vec3.create(), vec3.create(), vec3.create())).toEqualTypeOf<Vec3>();
  });

  it('vec3.lerp returns Vec3', () => {
    expectTypeOf(vec3.lerp(vec3.create(), vec3.create(), vec3.create(), 0.5)).toEqualTypeOf<Vec3>();
  });

  it('vec3.dot returns number', () => {
    expectTypeOf(vec3.dot(vec3.create(), vec3.create())).toEqualTypeOf<number>();
  });

  it('vec3.length returns number', () => {
    expectTypeOf(vec3.length(vec3.create())).toEqualTypeOf<number>();
  });
});

describe('vec3 — cross-namespace misuse blocked at compile time', () => {
  it('vec3.add must reject Vec2 as out', () => {
    const v2: Vec2 = null as unknown as Vec2;
    const v3: Vec3 = vec3.create();
    // @ts-expect-error — out must be Vec3, not Vec2
    vec3.add(v2, v3, v3);
  });

  it('vec3.cross must reject Vec4 as out', () => {
    const v4: Vec4 = null as unknown as Vec4;
    const v3: Vec3 = vec3.create();
    // @ts-expect-error — out must be Vec3, not Vec4
    vec3.cross(v4, v3, v3);
  });
});
