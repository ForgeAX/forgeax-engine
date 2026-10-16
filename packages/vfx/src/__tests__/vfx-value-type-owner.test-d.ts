import { describe, expectTypeOf, it } from 'vitest';
import type { VfxReflectedField, VfxValueType } from '../index.js';

describe('VfxValueType owner contract', () => {
  it('preserves the exact public six-member vocabulary', () => {
    expectTypeOf<VfxValueType>().toEqualTypeOf<
      'f32' | 'i32' | 'u32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>'
    >();
    expectTypeOf<VfxReflectedField['type']>().toEqualTypeOf<VfxValueType>();
  });

  it('keeps scalar and vector members precisely narrowed', () => {
    type ScalarTypes = Extract<VfxValueType, 'f32' | 'i32' | 'u32'>;
    type VectorTypes = Exclude<VfxValueType, ScalarTypes>;

    expectTypeOf<ScalarTypes>().toEqualTypeOf<'f32' | 'i32' | 'u32'>();
    expectTypeOf<VectorTypes>().toEqualTypeOf<'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>'>();
  });

  it('rejects values outside the reflected public type declaration', () => {
    const valid: VfxReflectedField = {
      name: 'value',
      type: 'vec4<f32>',
      offset: 0,
      size: 16,
      alignment: 16,
    };
    // @ts-expect-error unknown WGSL value types are outside the public declaration.
    const invalid: VfxReflectedField = { ...valid, type: 'mat4x4<f32>' };
    void invalid;
  });
});
