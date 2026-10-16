import { describe, expect, it } from 'vitest';
import {
  composeSingleLayerMediumColor,
  integrateSingleLayerMedium,
  resolveSingleLayerMediumBackground,
} from '../single-layer-medium.js';

const coefficients = {
  absorption: [0.2, 0.4, 0.8] as const,
  scattering: [0.1, 0.1, 0.1] as const,
  ior: 1.333,
  phaseG: 0.4,
};

describe('single-layer medium optics', () => {
  it('uses Beer-Lambert transmission and the zero-extinction limit', () => {
    const short = integrateSingleLayerMedium({ coefficients, distanceMeters: 1, cosTheta: 1 });
    const long = integrateSingleLayerMedium({ coefficients, distanceMeters: 2, cosTheta: 1 });
    expect(long.transmittance[0]).toBeLessThan(short.transmittance[0]);
    expect(long.transmittance[1]).toBeLessThan(short.transmittance[1]);
    expect(short.singleScatter[0]).toBeGreaterThan(0);
    const empty = integrateSingleLayerMedium({
      coefficients: { absorption: [0, 0, 0], scattering: [0, 0, 0], ior: 1.333 },
      distanceMeters: 4,
      cosTheta: 1,
    });
    expect(empty.transmittance).toEqual([1, 1, 1]);
    expect(empty.singleScatter).toEqual([0, 0, 0]);
    expect(empty.reflectance).toBeGreaterThan(0);
    expect(empty.reflectance).toBeLessThan(1);
    expect(
      [...empty.transmittance, ...empty.singleScatter, empty.phase].every(Number.isFinite),
    ).toBe(true);
  });

  it('keeps the zero-extinction limit and small-x RGB oracle continuous', () => {
    const zeroExtinction = integrateSingleLayerMedium({
      coefficients: {
        absorption: [0, 0, 0],
        scattering: [0, 0, 0],
        ior: 1.333,
      },
      distanceMeters: 4,
      cosTheta: 1,
    });
    expect(zeroExtinction.singleScatter).toEqual([0, 0, 0]);

    const coefficients = {
      absorption: [0, 0.000001, 0.25] as const,
      scattering: [0.000001, 0.000001, 0.5] as const,
      ior: 1.333,
    };
    const distanceMeters = 100000;
    const optics = integrateSingleLayerMedium({
      coefficients,
      distanceMeters,
      maxDistanceMeters: distanceMeters,
      cosTheta: 1,
    });
    const sigmaT = [0.000001, 0.000002, 0.75];
    const expected = sigmaT.map((extinction, index) => {
      const x = extinction * distanceMeters;
      const oneMinusExpNeg = x < 0.001 ? x * (1 - x / 2 + (x * x) / 6) : -Math.expm1(-x);
      return ((coefficients.scattering[index] ?? 0) * oneMinusExpNeg) / extinction;
    });
    expect(optics.distanceMeters).toBe(distanceMeters);
    expect(optics.singleScatter[0]).toBeCloseTo(expected[0] ?? 0, 12);
    expect(optics.singleScatter[1]).toBeCloseTo(expected[1] ?? 0, 12);
    expect(optics.singleScatter[2]).toBeCloseTo(expected[2] ?? 0, 12);
    expect(optics.singleScatter.every(Number.isFinite)).toBe(true);
  });

  it('allocates Fresnel once and keeps coverage/foam as finite mixing weights', () => {
    const optics = integrateSingleLayerMedium({ coefficients, distanceMeters: 1.5, cosTheta: 0.4 });
    const color = composeSingleLayerMediumColor({
      optics,
      background: [0.2, 0.3, 0.4],
      reflection: [1, 1, 1],
      foamColor: [0.9, 0.9, 0.9],
      coverage: 0.8,
      foam: 0.25,
    });
    expect(color.every(Number.isFinite)).toBe(true);
    expect(color.every((channel) => channel >= 0)).toBe(true);
    expect(
      composeSingleLayerMediumColor({
        optics,
        background: [0, 0, 0],
        reflection: [0, 0, 0],
        coverage: 0,
      }),
    ).toEqual([0, 0, 0]);
  });

  it('keeps refracted color and depth paired and reports conservative fallbacks', () => {
    const base = {
      original: { color: [0.1, 0.2, 0.3] as const, depthMeters: 8, uv: [0.5, 0.5] as const },
      surfaceDepthMeters: 2,
      maxDistanceMeters: 20,
    };
    expect(
      resolveSingleLayerMediumBackground({
        ...base,
        refracted: { color: [0.4, 0.5, 0.6], depthMeters: 7, uv: [0.55, 0.5] },
      }),
    ).toMatchObject({ source: 'refracted', distanceMeters: 5 });
    expect(
      resolveSingleLayerMediumBackground({
        ...base,
        refracted: { color: [0.4, 0.5, 0.6], depthMeters: 1, uv: [0.55, 0.5] },
      }),
    ).toMatchObject({ source: 'unrefracted', reason: 'front', color: base.original.color });
    expect(
      resolveSingleLayerMediumBackground({
        ...base,
        refracted: { color: [0.4, 0.5, 0.6], depthMeters: 7, uv: [1.2, 0.5] },
      }),
    ).toMatchObject({ source: 'unrefracted', reason: 'edge' });
    expect(
      resolveSingleLayerMediumBackground({
        ...base,
        original: { color: [0, 0, 0], depthMeters: Number.NaN, uv: [0.5, 0.5] },
        environment: [0.7, 0.8, 0.9],
      }),
    ).toMatchObject({ source: 'environment', reason: 'sky-miss' });
    expect(
      resolveSingleLayerMediumBackground({
        ...base,
        refracted: { color: [0.4, 0.5, 0.6], depthMeters: 7, uv: [-0.01, 0.5] },
      }),
    ).toMatchObject({ source: 'unrefracted', reason: 'edge', color: base.original.color });
  });
});
