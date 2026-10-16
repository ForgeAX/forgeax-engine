import type { ParticleStageResourceAccess, VfxGpuStageReflection } from '@forgeax/engine-vfx';
import type { ParticleManagedStagePlan } from '@forgeax/engine-vfx-compiler';
import { describe, expectTypeOf, it } from 'vitest';
import type { VfxValidatedStagePlan } from '../index.js';

type ReflectedAccess = VfxGpuStageReflection['resources'][number]['access'];

describe('VFX stage owner', () => {
  it('keeps reflected access equal to the authored owner', () => {
    expectTypeOf<ReflectedAccess>().toEqualTypeOf<ParticleStageResourceAccess>();
    expectTypeOf<'unknown-access'>().not.toExtend<ReflectedAccess>();
  });

  it('compiler plan and validated plan carry the runtime reflection type', () => {
    expectTypeOf<
      ParticleManagedStagePlan['stages'][number]
    >().toEqualTypeOf<VfxGpuStageReflection>();
    expectTypeOf<VfxValidatedStagePlan['stages'][number]>().toEqualTypeOf<VfxGpuStageReflection>();
  });
});
