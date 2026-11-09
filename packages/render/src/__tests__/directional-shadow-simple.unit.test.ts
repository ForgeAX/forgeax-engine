import { describe, expect, it } from 'vitest';
import { directionalShadowSimple, leanLightingFrame } from '../record/directional-shadow-simple';

const cascades = (over: Record<string, unknown> = {}) =>
  ({
    cascadeCount: 1,
    cascadeBlend: 0,
    directionalShadowQuality: { kind: 'pcf-vogel' },
    ...over,
  }) as never;

describe('directionalShadowSimple', () => {
  it('is true without a directional shadow receiver', () => {
    expect(directionalShadowSimple({ cascades: undefined })).toBe(true);
  });
  it('is true for one cascade, no blend, pcf-vogel', () => {
    expect(directionalShadowSimple({ cascades: cascades() })).toBe(true);
  });
  it('keeps the general receiver for 2 cascades, blend, PCSS or other filters', () => {
    expect(directionalShadowSimple({ cascades: cascades({ cascadeCount: 2 }) })).toBe(false);
    expect(directionalShadowSimple({ cascades: cascades({ cascadeBlend: 0.2 }) })).toBe(false);
    expect(
      directionalShadowSimple({
        cascades: cascades({ directionalShadowQuality: { kind: 'pcss' } }),
      }),
    ).toBe(false);
  });
  it('keeps the general receiver for constant-bias cameras', () => {
    expect(
      directionalShadowSimple({
        cascades: cascades(),
        directionalCsmConfig: { shadowBiasMode: 1 },
      }),
    ).toBe(false);
  });
});

describe('leanLightingFrame', () => {
  const empty = { point: [], spot: [], rect: [] } as unknown as Parameters<
    typeof leanLightingFrame
  >[0];
  const withSpot = (spot: Record<string, unknown>) =>
    ({ ...empty, spot: [spot] }) as unknown as Parameters<typeof leanLightingFrame>[0];
  it('is lean for plain point and spot lights', () => {
    expect(leanLightingFrame(empty, undefined, undefined)).toBe(true);
    expect(leanLightingFrame(withSpot({ kind: 'spot' }), 'skylight', undefined)).toBe(true);
  });
  it('is not lean with any modifier lane, slot kind or solar factor', () => {
    expect(leanLightingFrame(withSpot({ cookieSlice: 0 }), undefined, undefined)).toBe(false);
    expect(leanLightingFrame(withSpot({ iesProfileSlice: 0 }), undefined, undefined)).toBe(false);
    expect(leanLightingFrame(withSpot({ projectorHandle: 1 }), undefined, undefined)).toBe(false);
    expect(leanLightingFrame({ ...empty, rect: [{}] } as never, undefined, undefined)).toBe(false);
    expect(
      leanLightingFrame({ ...empty, additionalDirectional: [{}] } as never, undefined, undefined),
    ).toBe(false);
    expect(
      leanLightingFrame(
        { ...empty, point: [{ iesProfileSlice: 2 }] } as never,
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(leanLightingFrame(empty, 'atmosphere', undefined)).toBe(false);
    expect(leanLightingFrame(empty, undefined, { lowSun: false, range: 512 })).toBe(false);
    expect(leanLightingFrame(empty, undefined, { lowSun: true, range: 512 })).toBe(true);
  });
});
