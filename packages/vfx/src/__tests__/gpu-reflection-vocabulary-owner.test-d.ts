import { describe, expectTypeOf, it } from 'vitest';
import type {
  ParticleRendererOverflowPolicy,
  ParticleStageDomain,
  ParticleStageResourceAccess,
} from '../code-source.js';
import type { ParticleRendererSortingV3 } from '../code-source-v3.js';
import type { VfxGpuRendererReflection, VfxGpuStageReflection } from '../gpu-program.js';

describe('VFX GPU reflection vocabulary owner', () => {
  it('derives reflection vocabularies from the authored source vocabulary', () => {
    expectTypeOf<
      VfxGpuRendererReflection['overflow']
    >().toEqualTypeOf<ParticleRendererOverflowPolicy>();
    expectTypeOf<
      NonNullable<VfxGpuRendererReflection['sorting']>
    >().toEqualTypeOf<ParticleRendererSortingV3>();
    expectTypeOf<VfxGpuStageReflection['domain']>().toEqualTypeOf<ParticleStageDomain>();
    expectTypeOf<
      VfxGpuStageReflection['resources'][number]['access']
    >().toEqualTypeOf<ParticleStageResourceAccess>();
  });
});
