import { describe, expect, it } from 'vitest';
import {
  isSupportedVariantDefines,
  isSupportedVariantKey,
  VARIANT_PERMUTATION_RULES,
  violatedVariantPermutationRules,
} from '../variant-permutation-rules.js';

describe('variant permutation rules', () => {
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

  it('publishes the clip-only CPU-direct visible-surface slice the deferred lane requests', () => {
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
    // No scene-index row means no LOD coverage source: the clip-only state is published.
    expect(direct({})).toBe(true);
    expect(direct({ LOD_DITHER: true })).toBe(false);
    expect(direct({ CLIPPING_PLANES: false })).toBe(false);
    // Only the deferred G-buffer slice, not the whole axis product.
    expect(direct({ STORAGE_BUFFER_AVAILABLE: false })).toBe(false);
    expect(direct({ CLUSTER_FORWARD_AVAILABLE: false })).toBe(false);
    expect(direct({ VERTEX_COLOR_AVAILABLE: true })).toBe(false);
    expect(direct({ TRANSMISSION_AVAILABLE: true })).toBe(false);
    expect(direct({ REFLECTION_FALLBACK_AVAILABLE: true })).toBe(false);
    // Scene-index visible surfaces still carry LOD coverage and clipping.
    expect(direct({ GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true })).toBe(false);
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
    expect(simple({ PROBE_BLEND_AVAILABLE: true })).toBe(false);
    expect(simple({ STORAGE_BUFFER_AVAILABLE: false })).toBe(false);
    // Discarding draws (view clipping, LOD cross-fade + clipping) stay general.
    expect(simple({ CLIPPING_PLANES: false, LOD_DITHER: false })).toBe(true);
    expect(simple({ CLIPPING_PLANES: true, LOD_DITHER: false })).toBe(false);
    expect(simple({ CLIPPING_PLANES: true, LOD_DITHER: true })).toBe(false);
    // The general receiver row stays published for every profile.
    expect(
      simple({
        DIRECTIONAL_SHADOW_SIMPLE: false,
        TRANSMISSION_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: true,
      }),
    ).toBe(true);
  });

  it('binds LEAN_LIGHTING to the simple-receiver row without adding rows', () => {
    const row = (simple: boolean, lean: boolean) =>
      isSupportedVariantDefines({
        STORAGE_BUFFER_AVAILABLE: true,
        CLUSTER_FORWARD_AVAILABLE: true,
        DIRECTIONAL_SHADOW_SIMPLE: simple,
        LEAN_LIGHTING: lean,
      });
    expect(row(false, false)).toBe(true);
    expect(row(true, true)).toBe(true);
    expect(row(false, true)).toBe(false);
    expect(row(true, false)).toBe(false);
    expect(
      isSupportedVariantKey(
        'DIRECTIONAL_SHADOW_SIMPLE=true+LEAN_LIGHTING=true+TRANSMISSION_AVAILABLE=true',
      ),
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
});
