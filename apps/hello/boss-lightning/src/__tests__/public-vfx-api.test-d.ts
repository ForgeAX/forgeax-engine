import { describe, expectTypeOf, it } from 'vitest';
import {
  createVfxEffectContract,
  ParticleEffectInstance,
  type VfxEffectReflection,
} from '@forgeax/engine-vfx';
import { createBossLightningInstance } from '../main.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '@forgeax/engine-vfx';

type BossLightningValues = {
  readonly intensity: number;
  readonly tint: readonly [number, number, number, number];
};

const reflection: VfxEffectReflection = {
  version: 3,
  parameters: {
    name: 'VfxParameters',
    fields: [
      { name: 'intensity', type: 'f32', offset: 0, size: 4, alignment: 4 },
      { name: 'tint', type: 'vec4<f32>', offset: 16, size: 16, alignment: 16 },
    ],
    size: 32,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:boss-lightning-public',
};

describe('Boss Lightning public typed VFX API', () => {
  it('accepts typed initial values and live patches without assertions', () => {
    const contract = createVfxEffectContract<BossLightningValues>(reflection);
    const instance = new ParticleEffectInstance(contract, {
      initialValues: { intensity: 1, tint: [0.2, 0.5, 1, 1] },
    });
    instance.patch({ intensity: 1.5, tint: [0.4, 0.7, 1, 1] });
    // @ts-expect-error field names come from the generated contract
    instance.patch({ glow: 2 });
    // @ts-expect-error vector dimensions come from the generated contract
    instance.patch({ tint: [1, 1, 1] });
    expectTypeOf(createBossLightningInstance(reflection)).toEqualTypeOf<
      ParticleEffectInstance<BossLightningValues>
    >();
  });
});
