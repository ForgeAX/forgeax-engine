// types.test-d.ts — branded-types mutual-exclusion compile-time assertions (AC-02 / TDD red phase, T-003)
//
// Mutual-exclusion check on the seven-piece brand SSOT: every pair of brands is non-substitutable,
// yet all remain a Float32Array supertype.
// When src/types.ts is missing or a brand field is duplicated, this file's typecheck must turn red.
//
// Related: requirements §AC-02 brand mutual exclusion blocks ≥ 6 cases at compile time;
//          research §Finding 7.3 minimal six-case template;
//          wiki/typescript-branded-types §3.1 expectTypeOf template.

import { describe, expectTypeOf, it } from 'vitest';
import type { Color, Mat3, Mat4, Quat, Vec2, Vec3, Vec4 } from '../types';

describe('types — brand mutual exclusion (AC-02 ≥ 6 cases)', () => {
  it('Vec3 ≠ Vec4', () => {
    expectTypeOf<Vec3>().not.toEqualTypeOf<Vec4>();
  });

  it('Vec3 ≠ Vec2', () => {
    expectTypeOf<Vec3>().not.toEqualTypeOf<Vec2>();
  });

  it('Vec3 ≠ Quat', () => {
    expectTypeOf<Vec3>().not.toEqualTypeOf<Quat>();
  });

  it('Vec3 ≠ Mat3', () => {
    expectTypeOf<Vec3>().not.toEqualTypeOf<Mat3>();
  });

  it('Mat3 ≠ Mat4', () => {
    expectTypeOf<Mat3>().not.toEqualTypeOf<Mat4>();
  });

  it('Vec4 ≠ Quat (same length 4, distinguished by brand)', () => {
    expectTypeOf<Vec4>().not.toEqualTypeOf<Quat>();
  });

  it('Quat ≠ Mat4', () => {
    expectTypeOf<Quat>().not.toEqualTypeOf<Mat4>();
  });

  it('Color ≠ Vec4 (same length 4, semantically distinct)', () => {
    expectTypeOf<Color>().not.toEqualTypeOf<Vec4>();
  });
});

describe('types — Float32Array supertype relations', () => {
  it('Vec3 ⊂ Float32Array', () => {
    expectTypeOf<Vec3>().toMatchTypeOf<Float32Array>();
  });

  it('Mat4 ⊂ Float32Array', () => {
    expectTypeOf<Mat4>().toMatchTypeOf<Float32Array>();
  });

  it('Float32Array ⊄ Vec3 (a branded type cannot be auto-widened from its base)', () => {
    expectTypeOf<Float32Array>().not.toMatchTypeOf<Vec3>();
  });

  it('Float32Array ⊄ Mat4 (a branded type cannot be auto-widened from its base)', () => {
    expectTypeOf<Float32Array>().not.toMatchTypeOf<Mat4>();
  });
});
