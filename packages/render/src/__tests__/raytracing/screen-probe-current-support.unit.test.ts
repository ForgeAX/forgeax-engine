import { expect, it } from 'vitest';
import {
  angularAllocation,
  compositeCurrentSupport,
  currentSupportAgreement,
  hardwareSourceEligibility,
  resolveFallbackCell,
  sameNormalQuadrature,
  supportNormal,
} from './screen-probe-support-domain.fixture';

const actualFallbacks = [
  {
    texel: 23,
    normal: [0.015878772363066673, 0.9998739361763, -0.00024828934692777693],
    direction: [0.8966923356056213, -0.2791147828102112, -0.34356608986854553],
  },
  {
    texel: 13,
    normal: [-0.18974681198596954, -0.07662852108478546, -0.9788382053375244],
    direction: [0.4866916537284851, -0.8713226318359375, -0.06267507374286652],
  },
] as const;

for (const [index, actual] of actualFallbacks.entries()) {
  it(`retains the actual Sponza ${index === 0 ? 'backward' : 'forward'} unresolved sample plan instead of its cell center`, () => {
    // Source3a/frame2805, Probe20100/cell23 and Probe10149/cell13. Both actual
    // rays are STATUS_FALLBACK; the second sample changes cosine sign at center.
    const resolved = resolveFallbackCell(actual.texel, actual.direction);
    expect(resolved.direction).toEqual(actual.direction);
    expect(resolved.age).toBe(0);
    expect(resolved.weighted.slice(0, 3)).toEqual([0, 0, 0]);
    expect(resolved.weighted[3]).toBeGreaterThan(0);
    const missing = angularAllocation(actual.normal).centerCosines.findIndex((v) => v > 0.5);
    const sample = sameNormalQuadrature(
      actual.normal,
      actual.normal,
      missing,
      true,
      undefined,
      undefined,
      new Map([[actual.texel, resolved]]),
    );
    expect(sample.value.x).toBeCloseTo(1, 6);
    expect(sample.value.w).toBeGreaterThan(2);
    expect(sample.value.w).toBeLessThan(3);
    const strict = sameNormalQuadrature(
      actual.normal,
      actual.normal,
      missing,
      false,
      undefined,
      undefined,
      new Map([[actual.texel, resolved]]),
    );
    expect(strict.value.w).not.toBe(1);
  });
}

it('keeps qualified Field fallback radiance while unresolved samples and absent plans remain distinct', () => {
  const actual = actualFallbacks[1];
  const qualified = resolveFallbackCell(actual.texel, actual.direction, true, [2, 4, 6, 1]);
  expect(qualified.age).toBe(1);
  expect(qualified.weighted[0] / qualified.weighted[3]).toBe(2);
  expect(qualified.direction).toEqual(actual.direction);
  const absent = resolveFallbackCell(actual.texel, actual.direction, true, [0, 0, 0, 0], false);
  expect(absent.weighted).toEqual([0, 0, 0, 0]);
  expect(absent.age).toBe(0);
  const historical = resolveFallbackCell(actual.texel, actual.direction, false);
  expect(historical.direction).not.toEqual(actual.direction);
  expect(historical.age).toBe(0);
  expect(historical.weighted[3]).toBeGreaterThan(0);
});

it('rejects missing, negative or nonfinite planned mass rather than claiming full coverage', () => {
  const actual = actualFallbacks[1];
  for (const mass of [0, -1, NaN, Infinity]) {
    const bad = { direction: actual.direction, weighted: [0, 0, 0, mass] as const, age: 0 };
    const value = sameNormalQuadrature(
      actual.normal,
      actual.normal,
      undefined,
      true,
      undefined,
      undefined,
      new Map([[actual.texel, bad]]),
    ).value;
    expect(value.w).toBe(0);
  }
});

it('retains every unresolved refined beam without promoting its set into known-only history or filtering', () => {
  const actual = actualFallbacks[1];
  for (const count of [2, 3, 4]) {
    const value = resolveFallbackCell(
      actual.texel,
      actual.direction,
      true,
      [0, 0, 0, 0],
      true,
      count,
    );
    expect(value.age).toBe(0);
    expect(value.weighted.slice(0, 3)).toEqual([0, 0, 0]);
    expect(value.weighted[3]).toBeGreaterThan(0);
  }
});

it('keeps measured support strict while an explicit current-support query retains known lighting and missing confidence', () => {
  const normal = supportNormal([0, 0, 1]);
  const missing = angularAllocation(normal).centerCosines.findIndex((cosine) => cosine > 0.5);
  expect(missing).toBeGreaterThanOrEqual(0);
  const strict = sameNormalQuadrature(normal, normal, missing);
  expect(strict.value.w).toBe(-1);
  expect(strict.value.x).toBe(0);

  // The same production query sees a constant field with one unresolved direction.
  // A display estimate is not a new measured ray, and must report partial coverage.
  const reconstructed = sameNormalQuadrature(normal, normal, missing, true);
  expect(reconstructed.value.x).toBeCloseTo(1, 6);
  expect(reconstructed.value.w).toBeGreaterThan(2);
  expect(reconstructed.value.w).toBeLessThan(3);
});

it('reports equal coverage but different error for random constant-field gaps and a missing directional emitter', () => {
  const normal = supportNormal([0, 0, 1]);
  const allocation = angularAllocation(normal);
  const missing = allocation.centerCosines.flatMap((cosine, t) =>
    cosine > 0 && (Math.imul(t + 3, 1664525) >>> 0) % 3 === 0 ? [t] : [],
  );
  expect(missing.length).toBeGreaterThan(0);
  const constant = sameNormalQuadrature(normal, normal, missing, true);
  const light = (texel: number): readonly [number, number, number] =>
    missing.includes(texel) ? [12, 4, 2] : [0, 0, 0];
  const unavailableLight = sameNormalQuadrature(normal, normal, missing, true, light);
  const fullReference = sameNormalQuadrature(normal, normal, undefined, false, light);
  expect(constant.value.x).toBeCloseTo(1, 6);
  expect(unavailableLight.value.w).toBeCloseTo(constant.value.w, 6);
  expect(unavailableLight.value.x).toBe(0);
  expect(fullReference.value.x).toBeGreaterThan(1);
  // Coverage is observable supported mass, not an error bound or a known-black claim.
  expect(unavailableLight.value.w).toBeGreaterThan(2);
  expect(unavailableLight.value.w).toBeLessThan(3);
});

it('distinguishes fully supported physical black from all-unknown and zero-direction inputs', () => {
  const normal = supportNormal([0, 0, 1]);
  const black = sameNormalQuadrature(normal, normal, undefined, true, () => [0, 0, 0]);
  expect(black.value.x).toBe(0);
  expect(black.value.w).toBe(3);
  const unknown = sameNormalQuadrature(
    normal,
    normal,
    Array.from({ length: 64 }, (_, i) => i),
    true,
  );
  expect(unknown.value.w).toBe(0);
  expect(unknown.value.x).toBe(0);
  expect(sameNormalQuadrature(normal, [0, 0, 0], undefined, true).value.w).toBe(0);
});

it('admits current-frame hardware reconstruction without borrowing a software receiver certificate', () => {
  const normal = supportNormal([0, 0, 1]);
  const query = (
    hardware: Parameters<typeof sameNormalQuadrature>[7],
    unknown?: readonly number[],
    black = false,
  ) =>
    sameNormalQuadrature(
      normal,
      normal,
      unknown,
      true,
      () => (black ? [0, 0, 0] : [0.5, 0.5, 0.5]),
      undefined,
      new Map(),
      hardware,
    ).value;
  for (const flags of [0, 8, 16, 32, 40, 56]) expect(hardwareSourceEligibility(flags)).toBe(false);
  for (let history = 0; history < 8; history++)
    expect(hardwareSourceEligibility(24 | history)).toBe(true);
  expect(query({ flags: 24 }).x).toBeCloseTo(0.5, 6);
  expect(query({ flags: 24 }).w).toBe(3);
  expect(query({ flags: 24 }, undefined, true).x).toBe(0);
  expect(query({ flags: 24 }, undefined, true).w).toBe(3);
  const partial = query({ flags: 24 }, [0, 36]);
  expect(partial.x).toBeCloseTo(0.5, 6);
  expect(partial.w).toBeGreaterThan(2);
  expect(partial.w).toBeLessThan(3);
  expect(
    query(
      { flags: 24 },
      Array.from({ length: 64 }, (_, i) => i),
    ).w,
  ).toBe(0);
  for (const rejected of [
    { flags: 8 },
    { flags: 56 },
    { flags: 24, source: [36, 32, 1, 9] as const },
    { flags: 24, live: false },
    { flags: 24, pixelValid: false },
    { flags: 24, extentMatches: false },
    { flags: 24, depth: 0 },
    { flags: 24, depth: 1 },
    { flags: 24, depth: NaN },
    { flags: 24, distance: 0 },
  ])
    expect(query(rejected).w).toBe(0);
});

it('rejects foreign-source and previous-pose-frame receivers instead of borrowing current bright directions', () => {
  const normal = supportNormal([0, 0, 1]);
  for (const stale of ['source', 'pose-frame'] as const) {
    const result = sameNormalQuadrature(normal, normal, undefined, true, () => [10, 4, 2], stale);
    expect(result.value.x).toBe(0);
    expect(result.value.w).toBe(0);
  }
});

it('decodes only the explicit finite estimator tag and preserves legacy strict and missing meanings', () => {
  for (const tag of [0, -1, -2, 2, 3.01, NaN, Infinity])
    expect(compositeCurrentSupport([1, 2, 3, tag]).w).toBe(0);
  expect(compositeCurrentSupport([1, 2, 3, 1]).xyz).toEqual([1, 2, 3]);
  expect(compositeCurrentSupport([1, 2, 3, 2.5]).xyz).toEqual([1, 2, 3]);
  for (const invalid of [-1, NaN, Infinity])
    expect(compositeCurrentSupport([invalid, 2, 3, 2.5]).w).toBe(0);
});

it('retains the actual same-depth normal gate instead of admitting an incompatible bright neighbor', () => {
  const normal = supportNormal([0, 0, 1]);
  expect(currentSupportAgreement(normal, normal)).toBe(1);
  expect(currentSupportAgreement(normal, supportNormal([1, 0, 0]))).toBe(0);
  expect(currentSupportAgreement(normal, supportNormal([0, 0, -1]))).toBe(0);
});
