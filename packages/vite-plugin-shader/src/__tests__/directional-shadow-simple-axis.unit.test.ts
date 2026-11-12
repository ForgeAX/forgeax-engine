import { describe, expect, it } from 'vitest';
import { isSupportedVariantDefines, OPT_IN_VARIANT_AXES } from '../index.js';

describe('DIRECTIONAL_SHADOW_SIMPLE variant axis', () => {
  it('is opt-in so the published default variant is the general receiver', () => {
    expect(OPT_IN_VARIANT_AXES.has('DIRECTIONAL_SHADOW_SIMPLE')).toBe(true);
  });

  it('admits a simple receiver with full extended lighting', () => {
    expect(
      isSupportedVariantDefines({
        DIRECTIONAL_SHADOW_SIMPLE: true,
        LEAN_LIGHTING: false,
        EXTENDED_LIGHTING_AVAILABLE: true,
        PROJECTOR_AVAILABLE: true,
      }),
    ).toBe(true);
    expect(
      isSupportedVariantDefines({ DIRECTIONAL_SHADOW_SIMPLE: false, LEAN_LIGHTING: true }),
    ).toBe(false);
  });

  it('keeps ProbeBlend on the full-lighting receiver only', () => {
    const row = {
      DIRECTIONAL_SHADOW_SIMPLE: true,
      PROBE_BLEND_AVAILABLE: true,
      LEAN_LIGHTING: false,
    };
    expect(isSupportedVariantDefines(row)).toBe(true);
    expect(isSupportedVariantDefines({ ...row, LEAN_LIGHTING: true })).toBe(false);
    expect(isSupportedVariantDefines({ ...row, TRANSMISSION_AVAILABLE: true })).toBe(false);
    expect(isSupportedVariantDefines({ ...row, CLIPPING_PLANES: true })).toBe(false);
    expect(isSupportedVariantDefines({ ...row, VISIBLE_SURFACE_AVAILABLE: true })).toBe(false);
  });

  it('prunes the coverage-only combination and ALPHA_MASK and visible-surface', () => {
    expect(
      isSupportedVariantDefines({ DIRECTIONAL_SHADOW_SIMPLE: true, COVERAGE_ONLY: true }),
    ).toBe(false);
    expect(isSupportedVariantDefines({ DIRECTIONAL_SHADOW_SIMPLE: true, ALPHA_MASK: true })).toBe(
      false,
    );
    expect(
      isSupportedVariantDefines({
        DIRECTIONAL_SHADOW_SIMPLE: true,
        VISIBLE_SURFACE_AVAILABLE: true,
      }),
    ).toBe(false);
    expect(
      isSupportedVariantDefines({
        DIRECTIONAL_SHADOW_SIMPLE: true,
        CLUSTER_FORWARD_AVAILABLE: true,
      }),
    ).toBe(true);
    expect(
      isSupportedVariantDefines({ DIRECTIONAL_SHADOW_SIMPLE: false, COVERAGE_ONLY: true }),
    ).toBe(true);
  });
});
