import { describe, expect, it } from 'vitest';
import {
  CLOUD_ISOTROPIC_PHASE,
  cloudDoubleHenyeyGreenstein,
  cloudHenyeyGreenstein,
  cloudOpticalOctaves,
} from '../optics';

describe('cloud Henyey-Greenstein', () => {
  it('integrates to one over the sphere even for near-end anisotropy', () => {
    const samples = 20_000;
    for (const g of [-0.999, -0.7, 0, 0.7, 0.999]) {
      let integral = 0;
      for (let index = 0; index < samples; index++) {
        const t = (index + 0.5) / samples;
        const cosine = (g < 0 ? -1 : 1) * (1 - 2 * t ** 4);
        // Polar-area dmu = 8 t^3 dt under the substitution above.
        integral += cloudHenyeyGreenstein(g, cosine) * 8 * t ** 3;
      }
      expect(Math.abs((integral * 2 * Math.PI) / samples - 1)).toBeLessThan(0.01);
    }
  });

  it('uses the camera-to-sample, sample-to-light convention and keeps both lobes', () => {
    const forward = cloudHenyeyGreenstein(0.8, 1);
    const backward = cloudHenyeyGreenstein(0.8, -1);
    expect(forward).toBeGreaterThan(backward);
    expect(cloudHenyeyGreenstein(-0.8, -1)).toBe(forward);
    expect(cloudHenyeyGreenstein(0, 0.5)).toBe(CLOUD_ISOTROPIC_PHASE);
    expect(cloudDoubleHenyeyGreenstein(0.8, -0.8, 0.25, 1)).toBeCloseTo(
      0.75 * forward + 0.25 * backward,
      12,
    );
  });
});

describe('cloud multi-scattering coefficient kernel', () => {
  const sample = {
    extinctionPerMeter: 0.25,
    albedo: [0.8, 0.4, 0.2] as const,
    emissivePerMeter: [0, 0, 0] as const,
    materialAO: 1,
  };
  const settings = {
    extraOctaves: 2 as const,
    contribution: 0.5,
    occlusion: 0.4,
    eccentricity: 0.3,
    grayScale: false,
    clampContribution: true,
  };
  it('matches UE cumulative medium exponents and independent phase weights', () => {
    const basePhase = 0.3;
    const octaves = cloudOpticalOctaves(sample, basePhase, settings);
    expect(octaves.map((octave) => octave.scatteringPerMeter[0])).toEqual([0.2, 0.1, 0.025]);
    expect(octaves[2]?.extinctionPerMeter).toBeCloseTo(0.25 * 0.4 ** 3, 12);
    expect(octaves[2]?.phase).toBeCloseTo(CLOUD_ISOTROPIC_PHASE * 0.91 + basePhase * 0.09, 12);
    for (const extraOctaves of [0, 1, 2] as const) {
      expect(cloudOpticalOctaves(sample, basePhase, { ...settings, extraOctaves })).toHaveLength(
        1 + extraOctaves,
      );
    }
  });

  it('separates red-channel grayscale and clamp policy', () => {
    const gray = { ...settings, grayScale: true, contribution: 2 };
    expect(cloudOpticalOctaves(sample, 0.3, gray)[1]?.scatteringPerMeter).toEqual([0.2, 0.2, 0.2]);
    expect(
      cloudOpticalOctaves(sample, 0.3, { ...gray, clampContribution: false })[1]
        ?.scatteringPerMeter,
    ).toEqual([0.4, 0.4, 0.4]);
  });
});
