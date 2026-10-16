import { Materials } from '@forgeax/engine-render';
import { assertMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const customOptions = {
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [{ name: 'ironColor', type: 'color' as const }],
  values: { ironColor: [0.4, 0.45, 0.47, 1] },
};

describe('custom Surface MaterialAsset wire projection', () => {
  it('uses Standard modules plus the default shadow caster and the existing Surface slot wire', () => {
    const material = Materials.standard(customOptions as never);
    expect(material.passes?.map((pass) => pass.program.module)).toEqual([
      'forgeax_material::standard',
      'forgeax_material::standard',
      'forgeax::default-shadow-caster',
    ]);
    expect(
      material.passes?.every(
        (pass) => pass.program.moduleSlots?.surface === customOptions.surfaceModule,
      ),
    ).toBe(true);
    const wire = JSON.parse(JSON.stringify(material)) as Record<string, unknown>;
    assertMaterialAsset(wire);
    expect(wire).not.toHaveProperty('surfaceModule');
    expect(wire).not.toHaveProperty('shadingModel');
    expect(wire).not.toHaveProperty('surface');
  });
});
