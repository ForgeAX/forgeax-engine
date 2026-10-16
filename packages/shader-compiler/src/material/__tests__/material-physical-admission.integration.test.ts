import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { lowerStandardContract } from '../lower-standard-contract.js';

describe('Standard physical admission', () => {
  it.each([
    { module: 'forgeax::default-shadow-caster' },
    { module: 'custom::surface', moduleSlots: { surface: 'custom::implementation' } },
  ])('keeps custom parameters independent of auxiliary program $module', (program) => {
    const lowered = lowerStandardContract(
      [{ name: 'clearcoat', type: 'f32' }],
      [
        { name: 'Forward', program: { module: 'custom::toon' } },
        { name: 'auxiliary', program },
      ],
    );
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.value.paramSchema).toEqual([{ name: 'clearcoat', type: 'f32' }]);
    expect(lowered.value.defines).toEqual({ MATERIAL_CLIPPING_AVAILABLE: false });
  });

  it('rejects a physical plan paired with Deferred before publication', () => {
    let thrown: unknown;
    try {
      deriveStandardLayerPlan(
        [
          { name: 'clearcoat', type: 'f32' },
          { name: 'clearcoatRoughness', type: 'f32' },
        ],
        [
          {
            name: 'deferred',
            program: { module: 'forgeax_material::standard' },
          },
        ],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'material-physical-contract-invalid',
      detail: { pass: 'deferred', reason: 'deferred-pass' },
    });
  });

  it('accepts a physical Forward and shadow-caster pair', () => {
    const plan = deriveStandardLayerPlan([
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);
    expect(plan.mode).toBe('physical');
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });

  it('rejects bool before the producer projects the material ABI', () => {
    const lowered = lowerStandardContract(
      [{ name: 'useClearcoat', type: 'bool', default: false }],
      [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      'material/bool',
    );
    expect(lowered).toMatchObject({
      ok: false,
      error: {
        code: 'material-parameter-type-unsupported',
        detail: { stage: 'cook', material: 'material/bool', parameter: 'useClearcoat' },
      },
    });
  });
});
