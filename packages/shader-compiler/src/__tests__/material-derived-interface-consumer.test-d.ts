import type { DerivedMaterialInterface, MaterialParameterProjection } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { GeneratedMaterialParameterProjection } from '../material/cook.js';

describe('shader compiler derived interface consumer types', () => {
  it('accepts the producer-owned projection without a shader identity variant', () => {
    expectTypeOf<GeneratedMaterialParameterProjection>().toEqualTypeOf<MaterialParameterProjection>();
    expectTypeOf<DerivedMaterialInterface['resourceBindings']>().toMatchTypeOf<
      readonly unknown[]
    >();
  });

  it('rejects a compiler projection with a shader-family discriminator', () => {
    const invalid: GeneratedMaterialParameterProjection = {
      kind: 'numeric',
      name: 'roughness',
      type: 'f32',
      // @ts-expect-error compiler projections are not selected by shader family
      shaderFamily: 'pbr',
    };
    void invalid;
  });
});
