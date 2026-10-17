import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../assembly/renderer-facade';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { RenderProfile } from '../render-contract';

describe('read-only depth batch production profile', () => {
  it('defaults on without a diagnostic override', () => {
    expect(DEFAULT_STANDARD_PROFILE.featureReadOnlyDepthBatching).toBe(true);
    expect(DEFAULT_STANDARD_PROFILE.featureReadOnlyDepthBatchDiagnostic).toBeUndefined();
    expect(
      freezeRenderProfile(DEFAULT_STANDARD_PROFILE).featureReadOnlyDepthBatchDiagnostic,
    ).toBeUndefined();
  });
  it.each([false, true])('preserves explicit production policy %s', (enabled) => {
    const profile = { ...DEFAULT_STANDARD_PROFILE, featureReadOnlyDepthBatching: enabled };
    expect(validateRenderProfile(profile)).toBeUndefined();
    expect(freezeRenderProfile(profile).featureReadOnlyDepthBatching).toBe(enabled);
  });
  it.each([0, 1, '0', null, {}, []])('rejects invalid production policy %j', (value) => {
    expect(
      validateRenderProfile({
        ...DEFAULT_STANDARD_PROFILE,
        featureReadOnlyDepthBatching: value,
      } as unknown as RenderProfile),
    ).toContain('featureReadOnlyDepthBatching');
  });
  it.each([
    false,
    true,
  ])('validates and preserves explicit %s through the public profile snapshot', (enabled) => {
    const profile = { ...DEFAULT_STANDARD_PROFILE, featureReadOnlyDepthBatchDiagnostic: enabled };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile);
    expect(frozen.featureReadOnlyDepthBatchDiagnostic).toBe(enabled);
    expect(Object.isFrozen(frozen)).toBe(true);
    profile.featureReadOnlyDepthBatchDiagnostic = !enabled;
    expect(frozen.featureReadOnlyDepthBatchDiagnostic).toBe(enabled);
  });
  it.each([0, 1, '0', '1', null, {}, []])('rejects non-boolean %j', (value) => {
    expect(
      validateRenderProfile({
        ...DEFAULT_STANDARD_PROFILE,
        featureReadOnlyDepthBatchDiagnostic: value,
      } as unknown as RenderProfile),
    ).toContain('featureReadOnlyDepthBatchDiagnostic');
  });
});
