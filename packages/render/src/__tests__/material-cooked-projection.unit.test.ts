import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import type { MaterialParameter, MaterialPass } from '@forgeax/engine-types';
import { derive, deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('cooked material render projection', () => {
  it('uses one schema for reflection, uniform layout, and resource bindings', () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const names = derived.numericMembers.map((member) => member.name);
    expect(names).toEqual(expect.arrayContaining(['transmission', 'ior', 'thickness']));
    expect(derived.coordinateRecords.map((record) => record.parameter)).toEqual(
      expect.arrayContaining(['transmissionTexture', 'thicknessTexture']),
    );
    expect(derived.resourceBindings.map((binding) => binding.name)).toEqual(
      expect.arrayContaining([
        'transmissionTexture_sampler',
        'transmissionTexture',
        'thicknessTexture_sampler',
        'thicknessTexture',
      ]),
    );
  });

  it('projects the prepared contract without reading authored values', () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
    ];
    const passes: readonly MaterialPass[] = [
      { name: 'forward', program: { module: 'forgeax_material::standard' } },
      { name: 'deferred', program: { module: 'forgeax_material::standard' } },
      { name: 'shadow-caster', program: { module: 'forgeax_material::standard' } },
    ];
    const plan = deriveStandardLayerPlan(parameters, passes);
    expect(plan.mode).toBe('base-only');
    expect(plan.passFamily).toEqual(['forward', 'deferred', 'shadow']);
  });
});
