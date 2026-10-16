import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { ParticleEffectInstance } from '../instance.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

type Values = {
  readonly zeta: number;
  readonly alpha: readonly [number, number, number];
};

const reflection = {
  version: 3,
  parameters: {
    name: 'VfxParameters',
    fields: [
      { name: 'zeta', type: 'f32', offset: 0, size: 4, alignment: 4 },
      { name: 'alpha', type: 'vec3<f32>', offset: 16, size: 12, alignment: 16 },
    ],
    size: 32,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:canonical-test',
} as const;

function makeInstance(values: Partial<Values> = {}) {
  return new ParticleEffectInstance(createVfxEffectContract<Values>(reflection), {
    initialValues: { zeta: 0.1, alpha: [0.2, 0.3, 0.4], ...values },
  });
}

describe('VFX canonical replay payload', () => {
  it('uses stable field order and f32-normalized scalar/vector values', () => {
    const first = makeInstance({ zeta: 0.1 });
    const second = makeInstance({ zeta: Math.fround(0.1) });

    const left = first.commit({ seed: 5, tick: 8 });
    const right = second.commit({ seed: 5, tick: 8 });

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect([...left.value.canonicalPayload]).toEqual([...right.value.canonicalPayload]);
    expect(new TextDecoder().decode(left.value.canonicalPayload)).toContain('alpha');
    expect(new TextDecoder().decode(left.value.canonicalPayload).indexOf('alpha')).toBeLessThan(
      new TextDecoder().decode(left.value.canonicalPayload).indexOf('zeta'),
    );
  });

  it('encodes empty patches and multiple patches as one deterministic generation', () => {
    const first = makeInstance();
    const second = makeInstance();
    expect(first.patch({}).ok).toBe(true);
    expect(first.patch({ zeta: 2 }).ok).toBe(true);
    expect(second.patch({ zeta: 2 }).ok).toBe(true);
    expect(second.patch({}).ok).toBe(true);

    const left = first.commit({ seed: 11, tick: 13 });
    const right = second.commit({ seed: 11, tick: 13 });

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.generation).toBe(1);
    expect(left.value.patchCount).toBe(2);
    expect(left.value.replayInput).toEqual(right.value.replayInput);
    expect([...left.value.parameterBlock]).toEqual([...right.value.parameterBlock]);
  });
});
