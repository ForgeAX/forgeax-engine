import { describe, expect, it } from 'vitest';
import {
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  standardLeanInputDefines,
  standardLeanInputMaskCompatible,
  standardTextureMask,
} from '../material-schemas.js';
import {
  isSupportedVariantDefines,
  isSupportedVariantKey,
  VARIANT_PERMUTATION_RULES,
  violatedVariantPermutationRules,
  withSupportedLeanInputs,
} from '../variant-permutation-rules.js';

describe('variant permutation rules', () => {
  it('requires storage for Water frames and omits their format axis from ordinary rows', () => {
    expect(
      isSupportedVariantDefines({ STORAGE_BUFFER_AVAILABLE: false, WATER_WAVES_AVAILABLE: true }),
    ).toBe(false);
    expect(
      isSupportedVariantDefines({ STORAGE_BUFFER_AVAILABLE: true, WATER_WAVES_AVAILABLE: true }),
    ).toBe(true);
    expect(
      isSupportedVariantDefines({
        WATER_INFO_RGBA16: true,
        WATER_WAVES_AVAILABLE: false,
        STANDARD_LEAN_INPUTS: false,
      }),
    ).toBe(false);
    expect(
      isSupportedVariantDefines({
        WATER_INFO_RGBA16: true,
        WATER_WAVES_AVAILABLE: false,
        STANDARD_LEAN_INPUTS: true,
        STORAGE_BUFFER_AVAILABLE: true,
      }),
    ).toBe(true);
    expect(
      isSupportedVariantDefines({ WATER_INFO_RGBA16: false, WATER_WAVES_AVAILABLE: false }),
    ).toBe(true);
    expect(
      isSupportedVariantDefines({ WATER_INFO_RGBA16: true, WATER_WAVES_AVAILABLE: true }),
    ).toBe(true);
    expect(isSupportedVariantDefines({ WATER_INFO_RGBA16: true })).toBe(true);
  });
  it('keeps one rule per implication with a stated reason', () => {
    for (const rule of VARIANT_PERMUTATION_RULES) {
      expect(rule.reason.length).toBeGreaterThan(0);
      expect(rule.axis in rule.when).toBe(false);
    }
    const keys = VARIANT_PERMUTATION_RULES.map((rule) => JSON.stringify([rule.axis, rule.when]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies a rule only when the row declares its axis and every condition', () => {
    expect(isSupportedVariantDefines(undefined)).toBe(true);
    expect(isSupportedVariantDefines({ STORAGE_BUFFER_AVAILABLE: false })).toBe(true);
    expect(
      violatedVariantPermutationRules({
        STORAGE_BUFFER_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
      }).map((rule) => rule.axis),
    ).toEqual(['PROBE_BLEND_AVAILABLE', 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE']);
  });

  it('publishes no directional PCSS axis (it is always on at compile time)', () => {
    expect(
      VARIANT_PERMUTATION_RULES.some((rule) => rule.axis === 'DIRECTIONAL_PCSS_AVAILABLE'),
    ).toBe(false);
  });

  it('publishes CPU-direct visible surfaces without inventing a LOD source', () => {
    const direct = (over: Record<string, boolean>) =>
      isSupportedVariantDefines({
        STORAGE_BUFFER_AVAILABLE: true,
        CLUSTER_FORWARD_AVAILABLE: true,
        VERTEX_COLOR_AVAILABLE: false,
        TRANSMISSION_AVAILABLE: false,
        REFLECTION_FALLBACK_AVAILABLE: false,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
        COVERAGE_ONLY: false,
        VISIBLE_SURFACE_AVAILABLE: true,
        CLIPPING_PLANES: true,
        LOD_DITHER: false,
        ...over,
      });
    // No scene-index row means no LOD source; clipping remains independent.
    expect(direct({})).toBe(true);
    expect(direct({ LOD_DITHER: true })).toBe(false);
    expect(direct({ CLIPPING_PLANES: false })).toBe(true);
    // Only the deferred G-buffer slice, not the whole axis product.
    expect(direct({ STORAGE_BUFFER_AVAILABLE: false })).toBe(false);
    expect(direct({ CLUSTER_FORWARD_AVAILABLE: false })).toBe(false);
    expect(direct({ VERTEX_COLOR_AVAILABLE: true })).toBe(false);
    expect(direct({ TRANSMISSION_AVAILABLE: true })).toBe(false);
    expect(direct({ REFLECTION_FALLBACK_AVAILABLE: true })).toBe(false);
    // Scene-index visible surfaces select LOD and clipping from actual demand.
    expect(direct({ GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true })).toBe(true);
    expect(direct({ GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true, LOD_DITHER: true })).toBe(true);
  });

  it('keeps the storage, projector and coverage exclusions', () => {
    expect(
      isSupportedVariantDefines({ STORAGE_BUFFER_AVAILABLE: false, ATMOSPHERE_AVAILABLE: true }),
    ).toBe(false);
    expect(
      isSupportedVariantDefines({ EXTENDED_LIGHTING_AVAILABLE: false, ATMOSPHERE_AVAILABLE: true }),
    ).toBe(false);
    expect(
      isSupportedVariantDefines({ PROJECTOR_AVAILABLE: false, EXTENDED_LIGHTING_AVAILABLE: true }),
    ).toBe(false);
    expect(isSupportedVariantDefines({ COVERAGE_ONLY: true, ALPHA_MASK: true })).toBe(false);
    expect(isSupportedVariantDefines({ COVERAGE_ONLY: true, ALPHA_MASK: false })).toBe(true);
  });

  it('publishes the simple directional receiver only for the plain storage forward profile', () => {
    const simple = (over: Record<string, boolean>) =>
      isSupportedVariantDefines({
        STORAGE_BUFFER_AVAILABLE: true,
        TRANSMISSION_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: false,
        CLUSTER_FORWARD_AVAILABLE: true,
        DIRECTIONAL_SHADOW_SIMPLE: true,
        ...over,
      });
    expect(simple({})).toBe(true);
    expect(simple({ TRANSMISSION_AVAILABLE: true })).toBe(false);
    expect(simple({ PROBE_BLEND_AVAILABLE: true, LEAN_LIGHTING: false })).toBe(true);
    expect(simple({ PROBE_BLEND_AVAILABLE: true, LEAN_LIGHTING: true })).toBe(false);
    expect(simple({ STORAGE_BUFFER_AVAILABLE: false })).toBe(false);
    // Discarding draws (view clipping, LOD cross-fade + clipping) stay general.
    expect(simple({ CLIPPING_PLANES: false, LOD_DITHER: false })).toBe(true);
    expect(simple({ CLIPPING_PLANES: true, LOD_DITHER: false })).toBe(false);
    expect(simple({ CLIPPING_PLANES: true, LOD_DITHER: true })).toBe(false);
    expect(simple({ CLIPPING_PLANES: false, LOD_DITHER: true })).toBe(false);
    // The general receiver row stays published for every profile.
    expect(
      simple({
        DIRECTIONAL_SHADOW_SIMPLE: false,
        TRANSMISSION_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: true,
      }),
    ).toBe(true);
  });

  it('publishes the simple receiver independently from full lighting', () => {
    const row = (simple: boolean, lean: boolean) =>
      isSupportedVariantDefines({
        STORAGE_BUFFER_AVAILABLE: true,
        CLUSTER_FORWARD_AVAILABLE: true,
        DIRECTIONAL_SHADOW_SIMPLE: simple,
        LEAN_LIGHTING: lean,
      });
    expect(row(false, false)).toBe(true);
    expect(row(true, true)).toBe(true);
    expect(row(false, true)).toBe(true);
    expect(row(true, false)).toBe(true);
    expect(
      isSupportedVariantKey(
        'DIRECTIONAL_SHADOW_SIMPLE=true+LEAN_LIGHTING=true+TRANSMISSION_AVAILABLE=true',
      ),
    ).toBe(false);
  });

  it.each([
    { COVERAGE_ONLY: true },
    { ALPHA_MASK: true },
    { VISIBLE_SURFACE_AVAILABLE: true },
    { TRANSMISSION_AVAILABLE: true },
    { PROBE_BLEND_AVAILABLE: true },
    { STORAGE_BUFFER_AVAILABLE: false },
    { CLIPPING_PLANES: true },
  ])('keeps the lean publication boundary with either receiver: %o', (boundary) => {
    for (const simple of [false, true])
      expect(
        isSupportedVariantDefines({
          DIRECTIONAL_SHADOW_SIMPLE: simple,
          LEAN_LIGHTING: true,
          ...boundary,
        }),
      ).toBe(false);
  });

  it('checks a definesKey with the same rules', () => {
    expect(isSupportedVariantKey(undefined)).toBe(true);
    expect(isSupportedVariantKey('')).toBe(true);
    expect(
      isSupportedVariantKey('DIRECTIONAL_SHADOW_SIMPLE=true+STORAGE_BUFFER_AVAILABLE=true'),
    ).toBe(true);
    expect(
      isSupportedVariantKey('DIRECTIONAL_SHADOW_SIMPLE=true+TRANSMISSION_AVAILABLE=true'),
    ).toBe(false);
    expect(isSupportedVariantKey('ALPHA_MASK=true+COVERAGE_ONLY=true')).toBe(false);
  });

  it('publishes lean inputs only on GPU-driven storage rows without coverage, transmission or LOD fade', () => {
    const lean = {
      STANDARD_LEAN_INPUTS: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: false,
      COVERAGE_ONLY: false,
      LOD_DITHER: false,
      ALPHA_MASK: true,
    };
    expect(isSupportedVariantDefines(lean)).toBe(true);
    for (const flip of [
      { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false },
      { STORAGE_BUFFER_AVAILABLE: false },
      { TRANSMISSION_AVAILABLE: true },
      { COVERAGE_ONLY: true },
      { LOD_DITHER: true },
    ])
      expect(isSupportedVariantDefines({ ...lean, ...flip })).toBe(false);
    expect(
      withSupportedLeanInputs(
        'COVERAGE_ONLY=true+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+STANDARD_LEAN_INPUTS=true',
      ),
    ).toBe('COVERAGE_ONLY=true+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+STANDARD_LEAN_INPUTS=false');
    expect(
      withSupportedLeanInputs('GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+STANDARD_LEAN_INPUTS=true'),
    ).toBe('GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+STANDARD_LEAN_INPUTS=true');
  });

  it('maps the lean row to the unused-input macros and rejects projection masks', () => {
    expect(standardLeanInputDefines({ STANDARD_LEAN_INPUTS: false })).toEqual({});
    expect(standardLeanInputDefines({ STANDARD_LEAN_INPUTS: true })).toEqual({
      STANDARD_SINGLE_UV_SET: true,
      STANDARD_OBJECT_BASIS_UNUSED: true,
      STANDARD_OBJECT_POSITION_UNUSED: true,
    });
    expect(standardLeanInputDefines({ STANDARD_LEAN_INPUTS: true }, 'shadow-caster')).toEqual({
      STANDARD_SINGLE_UV_SET: true,
      STANDARD_TANGENT_INPUT_UNUSED: true,
      STANDARD_OBJECT_BASIS_UNUSED: true,
      STANDARD_OBJECT_POSITION_UNUSED: true,
    });
    const mask = (name: string) => standardTextureMask([{ name, type: 'texture2d' } as never]);
    expect(standardLeanInputMaskCompatible(mask('baseColorTexture'))).toBe(true);
    expect(standardLeanInputMaskCompatible(mask('bumpTexture'))).toBe(true);
    expect(standardLeanInputMaskCompatible(mask('normalTexture'))).toBe(true);
    expect(standardLeanInputMaskCompatible(mask('clearcoatNormalTexture'))).toBe(true);
    expect(standardLeanInputMaskCompatible(mask('anisotropyTexture'))).toBe(true);
    expect(standardLeanInputMaskCompatible(STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(false);
  });
});

it('publishes the four independent coverage states for scene-index writers', () => {
  for (const LOD_DITHER of [false, true])
    for (const CLIPPING_PLANES of [false, true])
      for (const output of [
        {},
        { VISIBLE_SURFACE_AVAILABLE: true },
        { COVERAGE_ONLY: true },
        { ALPHA_MASK: true },
      ])
        expect(
          isSupportedVariantDefines({
            GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
            LOD_DITHER,
            CLIPPING_PLANES,
            ...output,
          }),
        ).toBe(true);
});
