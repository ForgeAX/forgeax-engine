import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

const reflection = {
  version: 3,
  parameters: {
    name: 'VfxParameters',
    fields: [
      { name: 'direction', type: 'vec3<f32>', offset: 0, size: 12, alignment: 16 },
      { name: 'speed', type: 'f32', offset: 16, size: 4, alignment: 4 },
    ],
    size: 32,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
} as const;

describe('VfxEffectContract', () => {
  it('models the executable program on the ordinary particle asset', () => {
    const asset: ParticleEffectAsset = {
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: 'sha256:program',
      emitters: [{ id: 'sparks', capacity: 8 }],
      program: {
        format: 'forgeax-vfx-program-4',
        fingerprint: 'sha256:program',
        emitters: [],
      },
    };
    expect(asset.program.fingerprint).toBe(asset.programFingerprint);
  });

  it('derives defaults and packed values from the same reflection result', () => {
    const contract = createVfxEffectContract(reflection);
    const values = contract.createValues({ speed: 2.5, direction: [0, 1, 0] });
    expect(values.ok).toBe(true);
    if (!values.ok) return;
    expect(values.value.speed).toBe(2.5);
    expect(values.value.direction).toEqual([0, 1, 0]);
    expect(contract.pack(values.value).ok).toBe(true);
    expect(contract.fingerprint).toBe(reflection.fingerprint);
  });

  it('rejects unknown names, wrong dimensions, and wrong scalar kinds without assertions', () => {
    const contract = createVfxEffectContract(reflection);

    const unknown = contract.createValues({ missing: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('vfx-value-unknown-field');

    const wrongDimension = contract.createValues({ direction: [0, 1] });
    expect(wrongDimension.ok).toBe(false);
    if (!wrongDimension.ok) expect(wrongDimension.error.code).toBe('vfx-value-type-mismatch');

    const wrongScalar = contract.validateValues(JSON.parse('{"speed":"fast"}'));
    expect(wrongScalar.ok).toBe(false);
    if (!wrongScalar.ok) expect(wrongScalar.error.code).toBe('vfx-value-type-mismatch');
  });
});
