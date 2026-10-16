import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { ParticleEffectInstance } from '../instance.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

const reflection = {
  version: 3,
  parameters: {
    name: 'VfxParameters',
    fields: [{ name: 'intensity', type: 'f32', offset: 0, size: 4, alignment: 4 }],
    size: 16,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:public-runtime',
} as const;

describe('public VFX instance API', () => {
  it('keeps legal public patches typed and reports illegal runtime payloads', () => {
    const contract = createVfxEffectContract<{ readonly intensity: number }>(reflection);
    const instance = new ParticleEffectInstance(contract, { initialValues: { intensity: 1 } });

    expect(instance.patch({ intensity: 2 }).ok).toBe(true);
    expect(instance.patch(JSON.parse('{"intensity":"bright"}')).ok).toBe(false);
    expect(instance.values).toEqual({ intensity: 1 });
    expect(instance.pendingPatchCount).toBe(1);
  });
});
