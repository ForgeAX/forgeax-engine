import { describe, expect, it } from 'vitest';
import {
  deriveReflectionFallbackProjection,
  type ReflectionFallbackProjectionInput,
  reflectionFallbackProjectionSignature,
} from '../reflection/projection';

const sample = (
  overrides: Partial<ReflectionFallbackProjectionInput> = {},
): ReflectionFallbackProjectionInput => ({
  source: 'probe',
  coverage: 0.75,
  extent: [4, 3, 2],
  linearHdr: [1.2, 0.8, 0.4, 1],
  brdfSignature: 'standard-pbr-ibl-v1',
  ...overrides,
});

describe('Reflection fallback projection', () => {
  it('preserves the source, coverage, extent, linear HDR, and BRDF signature', () => {
    const result = deriveReflectionFallbackProjection(sample());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      source: 'probe',
      coverage: 0.75,
      extent: [4, 3, 2],
      linearHdr: [1.2, 0.8, 0.4, 1],
      brdfSignature: 'standard-pbr-ibl-v1',
    });
  });

  it('uses an exact zero contribution for the producer-owned neutral source', () => {
    const result = deriveReflectionFallbackProjection(
      sample({ source: 'neutral', linearHdr: [9, 8, 7, 1] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('neutral');
    expect(result.value.linearHdr).toEqual([0, 0, 0, 0]);
  });

  it('keeps equivalent semantic inputs stable and changes signature on source switch', () => {
    const first = sample();
    expect(reflectionFallbackProjectionSignature(first)).toBe(
      reflectionFallbackProjectionSignature({ ...first }),
    );
    expect(reflectionFallbackProjectionSignature(first)).not.toBe(
      reflectionFallbackProjectionSignature({ ...first, source: 'skylight' }),
    );
  });

  it('keeps renderable and source identities in the projection signature', () => {
    const projection = deriveReflectionFallbackProjection({
      ...sample(),
      renderableKey: 'world-2/renderable-7',
      sourceKey: 'probe:2:11',
    });

    expect(projection).toMatchObject({
      ok: true,
      value: {
        renderableKey: 'world-2/renderable-7',
        sourceKey: 'probe:2:11',
      },
    });
    if (!projection.ok) return;
    expect(reflectionFallbackProjectionSignature(projection.value)).toContain(
      'world-2/renderable-7',
    );
    expect(reflectionFallbackProjectionSignature(projection.value)).toContain('probe:2:11');
  });
});
