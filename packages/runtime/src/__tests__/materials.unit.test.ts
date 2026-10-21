// feat-20260612-hdrp-deferred-shading-learn-render-5-8 M3 / w14
// Materials.standard multi-pass literal grep — TDD red-phase.
//
// Tests that Materials.standard() produces a MaterialAsset whose passes[]
// array includes three ShaderPass entries:
//   1. passKind='deferred' — opaque g-buffer write (fs_gbuffer entry)
//   2. passKind='forward' — transparent cluster-forward (fs_main entry)
//   3. passKind='shadow-caster' — depth-only shadow map write
//
// Also validates:
//   - Materials.unlit() stays forward-only (no deferred pass)
//   - castShadow=false suppresses the shadow-caster pass
//   - Default material has correct shader references for each pass
//
// AcceptanceCheck: pnpm test:unit -t 'material.*pass.*deferred|material.*multi.*pass'
// Grep gate: passKind:'deferred' / passKind:'forward' / passKind:'shadow-caster'
//   each hit >=1 in packages/runtime/src/materials.ts

import { Materials } from '@forgeax/engine-render';
import type { PassKind } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('Materials.standard multi-pass (w14)', () => {
  describe('deferred pass', () => {
    it('includes a passKind=deferred pass', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.name === ('deferred' as PassKind));
      expect(deferredPass).toBeDefined();
    });

    it('deferred pass uses forgeax_material::standard shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.name === ('deferred' as PassKind));
      expect(deferredPass?.program.module).toBe('forgeax_material::standard');
    });

    it('deferred pass fragment entry is fs_gbuffer', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.name === ('deferred' as PassKind));
      expect(deferredPass?.program.fragmentEntry).toBe('fs_gbuffer');
    });

    it('routes only through the HDRP deferred selector', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.name === ('deferred' as PassKind));
      expect(deferredPass?.renderState?.tags).toEqual({ LightMode: 'Deferred' });
    });
  });

  describe('forward pass', () => {
    it('includes a passKind=forward pass', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.name === ('forward' as PassKind));
      expect(forwardPass).toBeDefined();
    });

    it('forward pass uses forgeax_material::standard shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.name === ('forward' as PassKind));
      expect(forwardPass?.program.module).toBe('forgeax_material::standard');
    });

    it('forward pass fragment entry is fs_main', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.name === ('forward' as PassKind));
      expect(forwardPass?.program.fragmentEntry).toBe('fs_main');
    });

    it('routes only through the forward selector', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.name === ('forward' as PassKind));
      expect(forwardPass?.renderState?.tags).toEqual({ LightMode: 'Forward' });
    });
  });

  describe('shadow-caster pass', () => {
    it('includes a passKind=shadow-caster pass by default', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const shadowPass = mat.passes?.find((p) => p.name === ('shadow-caster' as PassKind));
      expect(shadowPass).toBeDefined();
    });

    it('shadow-caster pass uses the canonical depth-only shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const shadowPass = mat.passes?.find((p) => p.name === ('shadow-caster' as PassKind));
      expect(shadowPass?.program.module).toBe('forgeax::default-shadow-caster');
    });

    it('always publishes the shadow-caster pass; ShadowParticipation owns per-entity casting', () => {
      // @ts-expect-error castShadow is not a material option; use ShadowParticipation { cast }.
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], castShadow: false });
      const shadowPass = mat.passes?.find((p) => p.name === ('shadow-caster' as PassKind));
      expect(shadowPass).toBeDefined();
      const unlit = Materials.unlit([0.5, 0.5, 0.5, 1]);
      expect(unlit.passes?.map((p) => p.name)).toEqual(['forward', 'shadow-caster']);
    });
  });

  describe('pass count', () => {
    it('standard material has 3 passes (deferred + forward + shadow-caster)', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      expect(mat.passes).toHaveLength(3);
    });
  });

  describe('PBR properties preserved', () => {
    it('stores numeric tuples as linear values and marks generated metadata linear', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.25, 0.75, 0.4] });
      expect(mat.values?.baseColor).toEqual([0.5, 0.25, 0.75, 0.4]);
      expect(mat.colorSpace).toBe('linear');
      expect(mat.parameters?.find((parameter) => parameter.name === 'baseColor')).toEqual({
        name: 'baseColor',
        type: 'color',
        colorSpace: 'linear',
        default: [1, 1, 1, 1],
      });
      expect(mat.parameters?.find((parameter) => parameter.name === 'emissive')).toMatchObject({
        name: 'emissive',
        colorSpace: 'linear',
      });
    });

    it('decodes explicit sRGB helper and Hex input once at the authoring boundary', () => {
      const helper = Materials.standard({
        baseColor: Materials.srgb([0.5, 0.25, 0.75, 0.4]),
      });
      const hex = Materials.standard({ baseColor: '#808080' });
      expect(helper.values?.baseColor).toEqual(Materials.srgb([0.5, 0.25, 0.75, 0.4]));
      expect((hex.values?.baseColor as readonly number[] | undefined)?.[0]).toBeCloseTo(
        0.2158605,
        6,
      );
      expect(helper.colorSpace).toBe('linear');
      expect(hex.colorSpace).toBe('linear');
    });

    it('treats a numeric 0xRRGGBB input like the equivalent sRGB Hex', () => {
      const numeric = Materials.standard({ baseColor: 0x808080 });
      const hex = Materials.standard({ baseColor: '#808080' });
      expect(numeric.values?.baseColor).toEqual(hex.values?.baseColor);
    });

    it('rejects color tuples with the wrong channel count', () => {
      const mat = Materials.standard({
        baseColor: [0.5, 0.25, 0.75, 0.4],
      });
      expect(() => Materials.standard({ baseColor: [0.5, 0.25, 0.75] as never })).toThrow(
        'must contain 4 channels',
      );
      expect(mat.values?.baseColor).toEqual([0.5, 0.25, 0.75, 0.4]);
    });

    it('values includes metallic and roughness defaults', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      expect(mat.values?.metallic).toBe(0);
      expect(mat.values?.roughness).toBe(1);
    });

    it('preserves texture-channel selectors and validates their closed range', () => {
      const mat = Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        metallicChannel: 0,
        roughnessChannel: 2,
      });
      expect(mat.values?.metallicChannel).toBe(0);
      expect(mat.values?.roughnessChannel).toBe(2);
      for (const field of ['metallicChannel', 'roughnessChannel'] as const) {
        for (const value of [-1, 4, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(() =>
            Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], [field]: value }),
          ).toThrow(`${field} must be an integer in [0, 3]`);
        }
      }
    });

    it('values includes the optional clearcoat layer', () => {
      const mat = Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [0.5, 0.5, 0.5, 1],
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      });
      expect(mat.values?.clearcoat).toBe(1);
      expect(mat.values?.clearcoatRoughness).toBe(0.1);
    });

    it('preserves clearcoat values for cooked validation', () => {
      const mat = Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [1, 1, 1, 1],
        clearcoat: 1.1,
        clearcoatRoughness: -0.1,
      });
      expect(mat.values?.clearcoat).toBe(1.1);
      expect(mat.values?.clearcoatRoughness).toBe(-0.1);
    });

    it('values includes optional emissive/occlusion', () => {
      const mat = Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        emissive: [0.1, 0.2, 0.3],
        emissiveIntensity: 2,
        baseColorTexture: 42,
        occlusionTexture: 84,
        occlusionStrength: 0.75,
      });
      expect(mat.values?.emissive).toEqual([0.1, 0.2, 0.3]);
      expect(mat.values?.emissiveIntensity).toBe(2);
      expect(mat.values?.baseColorTexture).toBe(42);
      expect(mat.values?.occlusionTexture).toBe(84);
      expect(mat.values?.occlusionStrength).toBe(0.75);
    });

    it('declares supplied PBR textures in bind-group slot order', () => {
      const mat = Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        baseColorTexture: 42,
        metallicRoughnessTexture: 43,
        normalTexture: 44,
        emissiveTexture: 45,
        occlusionTexture: 46,
      });
      expect(mat.parameters?.filter((parameter) => parameter.type === 'texture')).toEqual([
        { name: 'baseColorTexture', type: 'texture', optional: true },
        { name: 'metallicRoughnessTexture', type: 'texture', optional: true },
        { name: 'normalTexture', type: 'texture', optional: true },
        { name: 'emissiveTexture', type: 'texture', optional: true },
        { name: 'occlusionTexture', type: 'texture', optional: true },
      ]);
    });

    it('stores alphaCutoff and renderState on both standard passes', () => {
      const renderState = { alphaToCoverageEnabled: true, depthWriteEnabled: false } as const;
      const mat = Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        alphaCutoff: 0.5,
        renderState,
      });
      expect(mat.values?.alphaCutoff).toBe(0.5);
      expect(
        mat.passes?.filter((p) => p.name !== 'shadow-caster').map((p) => p.renderState),
      ).toEqual([
        { ...renderState, tags: { LightMode: 'Forward' } },
        { ...renderState, tags: { LightMode: 'Deferred' } },
      ]);
    });
  });
});

describe('Materials.unlit forward-only (w14)', () => {
  it('unlit material has no deferred pass', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const deferredPass = mat.passes?.find((p) => p.name === ('deferred' as PassKind));
    expect(deferredPass).toBeUndefined();
  });

  it('unlit material has a forward pass', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const forwardPass = mat.passes?.find((p) => p.name === ('forward' as PassKind));
    expect(forwardPass).toBeDefined();
    expect(forwardPass?.program.module).toBe('forgeax_material::unlit');
  });

  it('unlit material includes shadow-caster by default', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const shadowPass = mat.passes?.find((p) => p.name === ('shadow-caster' as PassKind));
    expect(shadowPass).toBeDefined();
  });

  it('stores alphaCutoff on the unlit material', () => {
    const mat = Materials.unlit([1, 1, 1, 1], { alphaCutoff: 0.1 });
    expect(mat.values?.alphaCutoff).toBe(0.1);
  });

  it('keeps unlit numeric fields before texture coordinates in shader ABI order', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    expect(mat.parameters).toEqual([
      { name: 'baseColor', type: 'color', colorSpace: 'linear' },
      { name: 'alphaCutoff', type: 'f32', optional: true },
      { name: 'alphaHash', type: 'f32', optional: true },
      { name: 'shadowAlphaMode', type: 'f32', optional: true },
      { name: 'alphaMode', type: 'f32', optional: true },
      { name: 'alphaToCoverage', type: 'f32', optional: true },
      { name: 'shading', type: 'f32', optional: true },
      { name: 'alphaChannel', type: 'f32', optional: true, default: 1 },
      { name: 'baseColorTexture', type: 'texture', optional: true },
      { name: 'alphaTexture', type: 'texture', optional: true },
    ]);
  });
});
