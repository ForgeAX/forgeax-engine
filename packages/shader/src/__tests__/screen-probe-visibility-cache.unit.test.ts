import { expect, it } from 'vitest';
import {
  type CacheCase,
  runVisibilityAnchorCache,
  runVisibilityCache,
  visibilityCacheSource,
} from './screen-probe-visibility-cache.fixture';

const base: CacheCase = {
  enabled: 1,
  level: 0,
  corner: 0,
  normalClearance: false,
  secondary: false,
  origin: [0, 1, 2],
  endpoint: [3, 4, 5],
  primary: [0, 1, 2],
  proof: [0, 1, 2],
  cachedEndpoint: [3, 4, 5],
  cached: [1, 0],
  actual: -1,
};

it('reuses only identical receiver-to-corner ternary results over every level and stencil', () => {
  const source = visibilityCacheSource();
  for (let level = 0; level < 4; level++)
    for (let corner = 0; corner < 8; corner++)
      for (const normalClearance of [false, true])
        for (const secondary of [false, true])
          for (const value of [-1, 0, 1]) {
            const input = {
              ...base,
              level,
              corner,
              normalClearance,
              secondary,
              cached: [value, value] as const,
            };
            expect(runVisibilityCache(source, input)).toEqual({ value, calls: 0 });
          }
});

it('falls back on disabled, out-of-level, unprepared and nonidentical-bit keys', () => {
  const source = visibilityCacheSource();
  for (const change of [
    { enabled: 0 },
    { level: 4 },
    { cached: [2, 2] as const },
    { origin: [0x80000000, 1, 2] },
    { endpoint: [3, 4, 6] },
    { secondary: true, proof: [0, 1, 7] },
  ])
    expect(runVisibilityCache(source, { ...base, ...change })).toEqual({ value: -1, calls: 1 });
});

it('rejects an endpoint-key mutant instead of silently reusing a neighboring segment', () => {
  const source = visibilityCacheSource();
  const mutant = source.replace(
    ' || any(bitcast<vec3u>(endpoint) != fieldProbeCacheEndpoint[index])',
    '',
  );
  expect(mutant).not.toBe(source);
  const input = { ...base, endpoint: [3, 4, 6] };
  expect(runVisibilityCache(source, input)).toEqual({ value: -1, calls: 1 });
  expect(runVisibilityCache(mutant, input)).toEqual({ value: 1, calls: 0 });
});

it('retains pending biased-to-anchor unknown, occluded and clear proofs with exact keys', () => {
  const source = visibilityCacheSource();
  for (const level of [0, 1, 2, 3])
    for (const value of [-1, 0, 1])
      expect(runVisibilityAnchorCache(source, { ...base, level, cached: [value, 2] })).toEqual({
        value,
        calls: 0,
      });
  for (const change of [
    { enabled: 0 },
    { level: 4 },
    { cached: [2, 2] as const },
    { endpoint: [3, 4, 6] },
    { origin: [0, 1, 3] },
  ])
    expect(runVisibilityAnchorCache(source, { ...base, ...change })).toEqual({
      value: -1,
      calls: 1,
    });
});
