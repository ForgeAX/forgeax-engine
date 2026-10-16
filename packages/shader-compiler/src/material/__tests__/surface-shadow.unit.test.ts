import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { deriveSurfaceShadowPasses } from '../surface-shadow';

const forward = {
  name: 'Forward',
  program: { module: 'forgeax_material::standard', moduleSlots: { surface: 'game::cutout' } },
  renderState: { cullMode: 'none' as const },
};
const surface: MaterialAsset = {
  kind: 'material',
  parameters: [],
  passes: [forward],
};
describe('Surface default ShadowCaster ownership', () => {
  it('specializes only the known Standard shadow with all three explicit commitments', () => {
    const asset: MaterialAsset = {
      kind: 'material',
      staticSwitches: { alphaClipping: false, alphaHash: false, displacement: false },
      passes: [
        { name: 'Forward', program: { module: 'forgeax_material::standard' } },
        {
          name: 'ShadowCaster',
          program: {
            module: 'forgeax::default-shadow-caster',
            moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
          },
        },
      ],
    };
    const selected = deriveSurfaceShadowPasses(asset);
    expect(selected.passes?.[1]?.program.moduleSlots?.surface).toBe(
      'forgeax_material::opaque_surface',
    );
    expect(asset.passes?.[1]?.program.moduleSlots?.surface).toBe(
      'forgeax_material::default_standard_surface',
    );
    expect(deriveSurfaceShadowPasses(selected)).toEqual(selected);
    for (const key of ['alphaClipping', 'alphaHash', 'displacement'] as const) {
      const switches = { ...asset.staticSwitches };
      delete switches[key];
      expect(
        deriveSurfaceShadowPasses({ ...asset, staticSwitches: switches }).passes?.[1]?.program
          .moduleSlots?.surface,
      ).toBe('forgeax_material::default_standard_surface');
    }
  });

  it('inherits the default Standard opacity when visible passes omit an explicit Surface slot', () => {
    const result = deriveSurfaceShadowPasses({
      ...surface,
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } },
        { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
      ],
    });
    expect(result.passes?.[1]?.program.moduleSlots?.surface).toBe(
      'forgeax_material::default_standard_surface',
    );
  });
  it('preserves an explicit shadow Surface override under static opaque choices', () => {
    const shadow = {
      name: 'ShadowCaster',
      program: {
        module: 'forgeax::default-shadow-caster',
        moduleSlots: { surface: 'game::shadow-cutout' },
      },
    };
    const result = deriveSurfaceShadowPasses({
      kind: 'material',
      staticSwitches: { alphaClipping: false, alphaHash: false, displacement: false },
      passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }, shadow],
    });
    expect(result.passes?.[1]).toBe(shadow);
  });
  it('preserves an explicitly authored program without a shadow pass', () => {
    expect(deriveSurfaceShadowPasses(surface).passes).toEqual(surface.passes);
  });
  it('shares the opacity of Forward and Deferred with their default shadow wrapper', () => {
    const result = deriveSurfaceShadowPasses({
      ...surface,
      passes: [
        forward,
        { ...forward, name: 'Deferred' },
        { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
      ],
    });
    expect(result.passes).toHaveLength(3);
    expect(result.passes?.[2]?.program.moduleSlots?.surface).toBe('game::cutout');
    expect(deriveSurfaceShadowPasses(result)).toEqual(result);
  });
  it('fills an explicit default wrapper but preserves an authored shadow implementation', () => {
    const defaultShadow = {
      name: 'ShadowCaster',
      program: { module: 'forgeax::default-shadow-caster' },
    };
    expect(
      deriveSurfaceShadowPasses({ ...surface, passes: [forward, defaultShadow] }).passes?.[1]
        ?.program.moduleSlots,
    ).toEqual({ surface: 'game::cutout' });
    const customShadow = {
      name: 'ShadowCaster',
      program: { module: 'game::shadow', vertexEntry: 'deformed_vertex' },
    };
    expect(
      deriveSurfaceShadowPasses({ ...surface, passes: [forward, customShadow] }).passes?.[1],
    ).toBe(customShadow);
  });
  it('requires explicit geometry and shadow contracts for full-custom programs', () => {
    const custom: MaterialAsset = {
      kind: 'material',
      parameters: [],
      passes: [{ name: 'Forward', program: { module: 'game::deformed' } }],
    };
    expect(deriveSurfaceShadowPasses(custom)).toBe(custom);
  });
});
