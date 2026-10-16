import { describe, expect, it } from 'vitest';
import fixture from '../../../../apps/parity/color-lighting/cases/extended-lighting/probe-oracle.json' with {
  type: 'json',
};
import {
  admitProbeContributors,
  blendLightProbes,
  neumaierSum,
  roundProbeToF32,
  scaledProbeWeight,
} from '../scene/probe-blend';

const sky = [0.2, 0.4, 0.6] as const;
const normal = [0, 0, 1] as const;

function sh9(rgb: readonly [number, number, number]): number[] {
  return [rgb[0], rgb[1], rgb[2], ...new Array<number>(24).fill(0)];
}

describe('LightProbe analytic oracle', () => {
  it('applies the strict active set and confirmed blend formula', () => {
    const admission = admitProbeContributors([
      { identity: 'probe-a', admitted: true, distance: 0.5, radius: 1, irradiance: sh9([1, 0, 0]) },
      { identity: 'probe-b', admitted: true, distance: 1, radius: 2, irradiance: sh9([0, 1, 0]) },
      { identity: 'boundary', admitted: true, distance: 2, radius: 2, irradiance: sh9([9, 9, 9]) },
      {
        identity: 'not-admitted',
        admitted: false,
        distance: 0,
        radius: 1,
        irradiance: sh9([9, 9, 9]),
      },
    ]);
    expect(admission.receipt.activeIdentities).toEqual(['probe-a', 'probe-b']);
    const result = blendLightProbes({
      normal,
      skyIrradiance: sky,
      contributors: admission.admitted,
    });

    expect(result.terms.map((term) => term.identity)).toEqual(['probe-a', 'probe-b']);
    expect(result.terms.map((term) => term.distance)).toEqual([0.5, 1]);
    expect(result.terms.map((term) => term.coverage)).toEqual([0.75, 0.75]);
    expect(result.rStar).toBe(1);
    expect(result.terms.map((term) => term.q)).toEqual([0.75, 0.1875]);
    expect(result.terms.map((term) => term.scaledQ)).toEqual([0.75, 0.1875]);
    expect(result.Q).toBe(0.9375);
    expect(result.terms.map((term) => term.alpha)).toEqual([0.8, 0.2]);
    expect(result.C).toBe(0.9375);
    expect(result.S).toBe(0.0625);
    expect(result.SHPreblend.slice(0, 3)).toEqual([0.75, 0.1875, 0]);
    expect(result.skyIrradiance).toEqual(sky);
    expect(result.diffuse[0]).toBeCloseTo(0.224069, 5);
    expect(result.diffuse[1]).toBeCloseTo(0.077893, 5);
    expect(result.diffuse[2]).toBeCloseTo(0.0375, 5);
  });

  it('keeps Sky outside contributors and distinguishes C0 from unit irradiance', () => {
    const result = blendLightProbes({ normal, skyIrradiance: sky, contributors: [] });

    expect(result.terms).toEqual([]);
    expect(result.C).toBe(0);
    expect(result.S).toBe(1);
    expect(result.diffuse).toEqual(sky);
    expect(result.diffuse).not.toEqual([1, 1, 1]);
  });

  it('locks the radius weighting and strict boundary properties', () => {
    const fixedRatioAdmission = admitProbeContributors([
      { identity: 'near', admitted: true, distance: 1, radius: 2, irradiance: sh9([1, 0, 0]) },
      { identity: 'far', admitted: true, distance: 2, radius: 4, irradiance: sh9([0, 1, 0]) },
    ]);
    const fixedRatio = blendLightProbes({
      normal,
      skyIrradiance: sky,
      contributors: fixedRatioAdmission.admitted,
    });
    expect(fixedRatio.terms.map((term) => term.coverage)).toEqual([0.75, 0.75]);
    expect(fixedRatio.terms[1]?.q).toBe(4 * (fixedRatio.terms[0]?.q ?? 0));
    expect(fixedRatio.terms[1]?.scaledQ).toBe(4 * (fixedRatio.terms[0]?.scaledQ ?? 0));

    const peak = scaledProbeWeight(1, Math.sqrt(2));
    expect(peak.coverage).toBeCloseTo(0.5, 12);
    expect(peak.q).toBeCloseTo(0.25, 12);
    expect(scaledProbeWeight(2, 2).coverage).toBe(0);
  });

  it('keeps stable identity order and uses compensated f64 accumulation', () => {
    const admission = admitProbeContributors([
      { identity: 'z', admitted: true, distance: 0.1, radius: 1, irradiance: sh9([0, 0, 1]) },
      { identity: 'a', admitted: true, distance: 0.1, radius: 1, irradiance: sh9([1, 0, 0]) },
    ]);
    const result = blendLightProbes({
      normal,
      skyIrradiance: sky,
      contributors: admission.admitted,
    });
    expect(result.terms.map((term) => term.identity)).toEqual(['a', 'z']);
    expect(neumaierSum([1e16, 1, -1e16])).toBe(1);
    expect(roundProbeToF32(1 / 3)).toBe(new Float32Array([1 / 3])[0]);
    expect(fixture.formula.activeSet).toBe('admitted && distance < radius');
    expect(fixture.formula.skyContribution).toBe('S * E_sky(N)');
  });

  it('keeps the scaled kernel finite when diagnostic reciprocal-square overflows', () => {
    const admission = admitProbeContributors(
      [
        {
          identity: 'tiny-radius',
          admitted: true,
          distance: 5e-201,
          radius: 1e-200,
          irradiance: sh9([1, 0, 0]),
        },
        {
          identity: 'large-radius',
          admitted: true,
          distance: 5e199,
          radius: 1e200,
          irradiance: sh9([0, 1, 0]),
        },
      ],
      1e-300,
    );
    const result = blendLightProbes({
      normal,
      skyIrradiance: sky,
      contributors: admission.admitted,
      radiusMinimum: 1e-300,
    });

    expect(result.terms.every((term) => Number.isFinite(term.scaledQ))).toBe(true);
    expect(result.finite).toBe(true);
    expect(result.Q).toBeGreaterThan(0);
  });
});
