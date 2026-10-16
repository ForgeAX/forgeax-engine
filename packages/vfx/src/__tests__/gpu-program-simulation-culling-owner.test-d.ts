import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ParticleEmitterSourceV3 } from '../code-source-v3.js';
import type { VfxGpuEmitterProgram } from '../gpu-program.js';
import type {
  VfxGpuEmitterProgram as PublicVfxGpuEmitterProgram,
  VfxGpuEffectAsset,
  VfxGpuProgram,
} from '../index.js';

type SourceSimulationWhenCulled = ParticleEmitterSourceV3['simulationWhenCulled'];
type CookedSimulationWhenCulled = VfxGpuEmitterProgram['simulationWhenCulled'];
type RequiredSimulationWhenCulled = Pick<VfxGpuEmitterProgram, 'simulationWhenCulled'>;
type PublicProgramEmitter = VfxGpuProgram['emitters'][number];
type PublicAssetEmitter = VfxGpuEffectAsset['program']['emitters'][number];

const gpuProgramSource = readFileSync(new URL('../gpu-program.ts', import.meta.url), 'utf8');

describe('VFX GPU program simulation culling owner', () => {
  it('derives the cooked policy from the authored source while keeping it required', () => {
    expectTypeOf<CookedSimulationWhenCulled>().toEqualTypeOf<
      NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']>
    >();
    expectTypeOf<SourceSimulationWhenCulled>().toEqualTypeOf<
      NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']> | undefined
    >();
    expectTypeOf<RequiredSimulationWhenCulled>().toEqualTypeOf<{
      readonly simulationWhenCulled: NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']>;
    }>();
  });

  it('keeps exact policy membership across public projections', () => {
    expectTypeOf<CookedSimulationWhenCulled>().toEqualTypeOf<
      'continue' | 'pause' | 'restart-on-visible'
    >();
    expectTypeOf<PublicProgramEmitter>().toEqualTypeOf<VfxGpuEmitterProgram>();
    expectTypeOf<PublicAssetEmitter>().toEqualTypeOf<VfxGpuEmitterProgram>();
    expectTypeOf<PublicVfxGpuEmitterProgram>().toEqualTypeOf<VfxGpuEmitterProgram>();

    const acceptsSimulationWhenCulled = (
      value: CookedSimulationWhenCulled,
    ): CookedSimulationWhenCulled => value;
    expect(acceptsSimulationWhenCulled('continue')).toBe('continue');
    expect(acceptsSimulationWhenCulled('pause')).toBe('pause');
    expect(acceptsSimulationWhenCulled('restart-on-visible')).toBe('restart-on-visible');
    // @ts-expect-error VfxGpuEmitterProgram excludes additional culling policies.
    acceptsSimulationWhenCulled('reset');
  });

  it('keeps the source-derived owner explicit in the declaration', () => {
    expect(gpuProgramSource).toContain(
      "readonly simulationWhenCulled: NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']>;",
    );
    expect(gpuProgramSource).not.toContain(
      "readonly simulationWhenCulled: 'continue' | 'pause' | 'restart-on-visible';",
    );
  });
});
