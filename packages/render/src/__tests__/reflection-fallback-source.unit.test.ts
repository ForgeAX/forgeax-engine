import { describe, expect, it } from 'vitest';
import {
  type ReflectionProbeSelectionResult,
  resolveReflectionFallbackSource,
} from '../reflection/projection';

const probe: Extract<ReflectionProbeSelectionResult, { kind: 'probe' }> = {
  kind: 'probe',
  worldId: 2,
  entityKey: 7,
  normalizedDistance: 0.25,
};

describe('Reflection fallback source resolution', () => {
  it('selects exactly one producer source for probe, skylight, and neutral paths', () => {
    expect(resolveReflectionFallbackSource(probe, true)).toBe('probe');
    expect(resolveReflectionFallbackSource({ kind: 'skylight' }, true)).toBe('skylight');
    expect(resolveReflectionFallbackSource({ kind: 'skylight' }, true, false)).toBe('neutral');
    expect(resolveReflectionFallbackSource(probe, false)).toBe('skylight');
    expect(resolveReflectionFallbackSource(probe, false, false)).toBe('neutral');
  });

  it('uses Skylight while a selected probe is not ready', () => {
    expect(resolveReflectionFallbackSource(probe, false, true)).toBe('skylight');
  });

  it('does not expose probe handles while resolving the source', () => {
    const source = resolveReflectionFallbackSource(probe, true);
    expect(source).toEqual('probe');
    expect(typeof source).toBe('string');
  });
});
