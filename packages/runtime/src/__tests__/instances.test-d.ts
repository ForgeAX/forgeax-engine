// Public Instances authoring is matrix data, never a renderer-local handle.

import type { InstancesData } from '@forgeax/engine-render';
import { describe, expectTypeOf, it } from 'vitest';

describe('InstancesData shape (AC-06 ECS-managed array<f32> form)', () => {
  it('InstancesData carries a readonly transforms: Float32Array field', () => {
    expectTypeOf<InstancesData>().toEqualTypeOf<{
      readonly transforms: Float32Array;
    }>();
  });

  it('InstancesData.transforms narrows to Float32Array (no number / no Handle brand)', () => {
    expectTypeOf<InstancesData['transforms']>().toEqualTypeOf<Float32Array>();
  });
});

describe('@ts-expect-error negative assertions (AC-06 minimum 2)', () => {
  it('1. omitting `transforms` from InstancesData is a TS error (required field)', () => {
    // @ts-expect-error `transforms` is required; partial shape must not type-check.
    const wrong: InstancesData = {};
    void wrong;
  });

  it('2. plain `number[]` is not assignable to InstancesData.transforms (must be Float32Array)', () => {
    // @ts-expect-error `number[]` lacks the Float32Array brand.
    const wrong: InstancesData = { transforms: [0, 0, 0, 0] };
    void wrong;
  });

  it('3. `Uint32Array` is not assignable to InstancesData.transforms (Float32Array nominal)', () => {
    // @ts-expect-error TypedArray nominal types do not cross-assign in TS.
    const wrong: InstancesData = { transforms: new Uint32Array(16) };
    void wrong;
  });
});
