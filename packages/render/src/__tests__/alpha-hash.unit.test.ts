import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials.js';

describe('alpha hash authoring', () => {
  for (const kind of ['standard', 'unlit'] as const) {
    it(`${kind} carries hash coverage without enabling transparency`, () => {
      const material =
        kind === 'standard'
          ? Materials.standard({ baseColor: [1, 1, 1, 0.4], alphaHash: true })
          : Materials.unlit([1, 1, 1, 0.4], { alphaHash: true });
      expect(material.values).toMatchObject({ alphaHash: 1, baseColor: [1, 1, 1, 0.4] });
      expect(material.parameters).toContainEqual({
        name: 'alphaHash',
        type: 'f32',
        optional: true,
        ...(kind === 'standard' ? { default: 0 } : {}),
      });
      expect(material.passes?.some((pass) => pass.name === 'shadow-caster')).toBe(true);
      for (const pass of material.passes ?? []) {
        expect(pass.renderState?.blend).toBeUndefined();
        expect(pass.renderState?.depthWriteEnabled).not.toBe(false);
      }
    });
  }
  it('retains the Unlit shadow parameter layout', () => {
    expect(
      Materials.unlit([1, 1, 1, 0.5], { alphaHash: true }).passes?.find(
        (pass) => pass.name === 'shadow-caster',
      )?.program.vertexEntry,
    ).toBe('vs_shadow');
    expect(runtimeMaterialShaderId('forgeax_material::unlit', 'shadow-caster')).toBe(
      'forgeax::default-unlit',
    );
    expect(runtimeMaterialShaderId('forgeax::default-unlit', 'shadow-caster')).toBe(
      'forgeax::default-unlit',
    );
  });
  it('keeps default coverage disabled in both shader contracts', () => {
    for (const schema of [DEFAULT_STANDARD_PBR_PARAM_SCHEMA, DEFAULT_UNLIT_PARAM_SCHEMA]) {
      expect(schema.find((entry) => entry.name === 'alphaHash')).toEqual({
        name: 'alphaHash',
        type: 'f32',
        default: 0,
      });
    }
    expect(Materials.standard({ baseColor: [1, 1, 1, 0.4] }).values?.alphaHash).toBeUndefined();
    expect(Materials.unlit([1, 1, 1, 0.4], { alphaHash: false }).values?.alphaHash).toBe(0);
  });
});
