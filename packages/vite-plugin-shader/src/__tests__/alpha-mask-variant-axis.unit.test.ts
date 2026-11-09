import { describe, expect, it } from 'vitest';
import { isSupportedVariantDefines, OPT_IN_VARIANT_AXES } from '../index.js';

describe('ALPHA_MASK variant axis', () => {
  it('is an opt-in axis so the published default variant is discard-free', () => {
    expect(OPT_IN_VARIANT_AXES.has('ALPHA_MASK')).toBe(true);
  });

  it('prunes the alpha-tested temporal coverage combination only', () => {
    expect(isSupportedVariantDefines({ ALPHA_MASK: true, COVERAGE_ONLY: true })).toBe(false);
    expect(isSupportedVariantDefines({ ALPHA_MASK: false, COVERAGE_ONLY: true })).toBe(true);
    expect(isSupportedVariantDefines({ ALPHA_MASK: true, COVERAGE_ONLY: false })).toBe(true);
  });
});
