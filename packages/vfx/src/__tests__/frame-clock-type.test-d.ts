import type { World } from '@forgeax/engine-ecs';
import { describe, expectTypeOf, it } from 'vitest';
import type { VfxGpuRuntime, VfxGpuTickIntent } from '../index.js';

describe('VFX frame clock public type shape', () => {
  it('records each dispatch delta and cycle time without a fixed-step field', () => {
    expectTypeOf<VfxGpuTickIntent['delta']>().toEqualTypeOf<number>();
    expectTypeOf<VfxGpuTickIntent['initialDelta']>().toEqualTypeOf<number>();
    expectTypeOf<VfxGpuTickIntent['elapsed']>().toEqualTypeOf<number>();
    expectTypeOf<
      'fixedDelta' extends keyof VfxGpuTickIntent ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      'initialFixedDelta' extends keyof VfxGpuTickIntent ? true : false
    >().toEqualTypeOf<false>();
  });

  it('advances from the World frame delta only', () => {
    expectTypeOf<VfxGpuRuntime['advance']>().toEqualTypeOf<(world: World, delta: number) => void>();
  });
});
