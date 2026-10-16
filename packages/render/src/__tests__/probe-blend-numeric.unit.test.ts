import { describe, expect, it } from 'vitest';
import { admitProbeContributors, blendLightProbes, roundProbeToF32 } from '../scene/probe-blend';

const zeroSh = new Array<number>(27).fill(0);
const sky = [0.31, 0.17, 0.09] as const;

describe('LightProbe numeric boundaries', () => {
  it('rejects non-finite and sub-R_MIN contributors without poisoning the result', () => {
    const admission = admitProbeContributors([
      { identity: 'nan', admitted: true, distance: Number.NaN, radius: 1, irradiance: zeroSh },
      { identity: 'tiny', admitted: true, distance: 0, radius: 1e-8, irradiance: zeroSh },
    ]);
    const result = blendLightProbes({
      normal: [0, 1, 0],
      skyIrradiance: sky,
      contributors: admission.admitted,
    });
    expect(result.terms).toEqual([]);
    expect(result.diffuse).toEqual(sky);
    expect(result.finite).toBe(true);
  });

  it('is invariant under a common distance/radius scale and rounds only at the boundary', () => {
    const first = blendLightProbes({
      normal: [1, 0, 0],
      skyIrradiance: sky,
      contributors: [
        { identity: 'a', admitted: true, distance: 0.25, radius: 1, irradiance: zeroSh },
        { identity: 'b', admitted: true, distance: 0.5, radius: 2, irradiance: zeroSh },
      ],
    });
    const scaled = blendLightProbes({
      normal: [1, 0, 0],
      skyIrradiance: sky,
      contributors: [
        { identity: 'a', admitted: true, distance: 25, radius: 100, irradiance: zeroSh },
        { identity: 'b', admitted: true, distance: 50, radius: 200, irradiance: zeroSh },
      ],
    });
    expect(scaled.terms.map((term) => term.coverage)).toEqual(
      first.terms.map((term) => term.coverage),
    );
    expect(scaled.terms.map((term) => term.alpha)).toEqual(first.terms.map((term) => term.alpha));
    expect(scaled.S).toBe(first.S);
    expect(roundProbeToF32(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('keeps scaled-q finite when the diagnostic reciprocal-square overflows', () => {
    const result = blendLightProbes({
      normal: [0, 0, 1],
      skyIrradiance: sky,
      contributors: admitProbeContributors([
        { identity: 'minimum', admitted: true, distance: 0, radius: 1e-4, irradiance: zeroSh },
        {
          identity: 'maximum',
          admitted: true,
          distance: 1e300,
          radius: Number.MAX_VALUE,
          irradiance: zeroSh,
        },
      ]).admitted,
    });
    expect(result.finite).toBe(true);
    expect(result.terms.every((term) => Number.isFinite(term.scaledQ))).toBe(true);
    expect(result.scaledQLogOffset).toBe(0);
  });
});
