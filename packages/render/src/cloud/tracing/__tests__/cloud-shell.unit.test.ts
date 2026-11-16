import { describe, expect, it } from 'vitest';
import type { CloudRgb } from '../../contracts';
import {
  CLOUD_UNTRACED_DEPTH_METERS,
  type CloudRay,
  type CloudTraceClip,
  cloudShellInterval,
} from '../geometry';
import {
  cloudSampleBudget,
  cloudShadowMapSize,
  cloudShouldStop,
  cloudViewSampling,
} from '../policy';
import { cloudSegmentTransfer, traceUniformCloud } from '../transport';

const planetRadiusMeters = 6_360_000;
const shell = { planetRadiusMeters, bottomMeters: 5_000, thicknessMeters: 10_000 };
const eyeHeightMeters = 0.5;
const ray = (direction: CloudRgb, heightMeters = eyeHeightMeters): CloudRay => ({
  cameraRelativeToPlanetMeters: [0, planetRadiusMeters + heightMeters, 0],
  direction,
});
const clip: CloudTraceClip = {
  tracingStartMaxDistanceMeters: 350_000,
  tracingMaxDistanceMeters: 50_000,
  tracingMaxDistanceMode: 'from-layer-entry',
  tracingStartDistanceFromCameraMeters: 0,
  sceneDistanceMeters: CLOUD_UNTRACED_DEPTH_METERS,
};

describe('meter-scale spherical shell', () => {
  it('finds radial and horizon distances without confusing thickness and altitude', () => {
    expect(cloudShellInterval(ray([0, 1, 0]), shell, clip)).toEqual({
      entryMeters: 4999.5,
      exitMeters: 14999.5,
    });
    const horizon = cloudShellInterval(ray([1, 0, 0]), shell, clip);
    const expected = Math.sqrt((planetRadiusMeters + 5000) ** 2 - (planetRadiusMeters + 0.5) ** 2);
    expect(horizon?.entryMeters).toBeCloseTo(expected, 8);
    expect(horizon?.exitMeters).toBeCloseTo(expected + 50_000, 8);
    expect(cloudShellInterval(ray([1, 0, 0], 15000), shell, clip)).toBeUndefined();
    expect(cloudShellInterval(ray([1, 0, 0], 16000), shell, clip)).toBeUndefined();
  });

  it('rejects through-planet and fully occluded rays but keeps a clipped segment', () => {
    expect(cloudShellInterval(ray([0, -1, 0]), shell, clip)).toBeUndefined();
    expect(cloudShellInterval(ray([0, -1, 0], 0), shell, clip)).toBeUndefined();
    expect(
      cloudShellInterval(ray([0, 1, 0]), shell, { ...clip, sceneDistanceMeters: 4000 }),
    ).toBeUndefined();
    expect(
      cloudShellInterval(ray([0, 1, 0]), shell, { ...clip, sceneDistanceMeters: 6000 }),
    ).toEqual({ entryMeters: 4999.5, exitMeters: 6000 });
    expect(cloudShellInterval(ray([0, -1, 0], 20000), shell, clip)).toEqual({
      entryMeters: 5000,
      exitMeters: 15000,
    });
  });

  it('distinguishes near exclusion, entry rejection, and both trace origins', () => {
    const up = ray([0, 1, 0]);
    expect(
      cloudShellInterval(up, shell, { ...clip, tracingStartMaxDistanceMeters: 4999 }),
    ).toBeUndefined();
    const limited = {
      ...clip,
      tracingMaxDistanceMeters: 7000,
      tracingStartDistanceFromCameraMeters: 6000,
    };
    expect(cloudShellInterval(up, shell, limited)).toEqual({
      entryMeters: 6000,
      exitMeters: 11999.5,
    });
    expect(
      cloudShellInterval(up, shell, { ...limited, tracingMaxDistanceMode: 'from-camera' }),
    ).toEqual({ entryMeters: 6000, exitMeters: 7000 });
  });
});

describe('analytic uniform cloud transfer', () => {
  const material = {
    extinctionPerMeter: 0.0002,
    albedo: [0.8, 0.5, 0.2] as const,
    emissivePerMeter: [0, 0, 0] as const,
    materialAO: 1,
  };
  const source = [4, 2, 1] as const;

  it('matches Beer transmission and independent depth quadrature after scene clipping', () => {
    const actual = traceUniformCloud(
      ray([0, 1, 0]),
      shell,
      { ...clip, sceneDistanceMeters: 7999.5 },
      material,
      source,
    );
    const expectedT = Math.exp(-0.6);
    expect(actual.transmittance).toBeCloseTo(expectedT, 12);
    expect(actual.radiance[0]).toBeCloseTo((1 - expectedT) * 3.2, 12);
    expect(actual.sceneDepthMeters).toBe(7999.5);
    let sum = 0;
    let weightedDepth = 0;
    for (let i = 0; i < 30_000; i++) {
      const meters = (i + 0.5) * 0.1;
      const weight = Math.exp(-meters / 5000);
      sum += weight;
      weightedDepth += weight * (4999.5 + meters);
    }
    expect(actual.representativeDepthMeters).toBeCloseTo(weightedDepth / sum, 5);
  });

  it('preserves no-hit and vacuum identities, including the zero-attenuation emission limit', () => {
    const vacuum = { ...material, extinctionPerMeter: 0 };
    const noHit = traceUniformCloud(ray([0, -1, 0]), shell, clip, vacuum, source);
    expect(noHit.entryMeters).toBe(CLOUD_UNTRACED_DEPTH_METERS);
    expect(noHit.representativeDepthMeters).toBe(CLOUD_UNTRACED_DEPTH_METERS);
    expect(noHit.radiance).toEqual([0, 0, 0]);
    expect(noHit.transmittance).toBe(1);
    const through = traceUniformCloud(ray([0, 1, 0]), shell, clip, vacuum, source);
    expect(through.representativeDepthMeters).toBe(through.exitMeters);
    expect(cloudSegmentTransfer({ ...vacuum, emissivePerMeter: [0, 2, 0] }, source, 12)).toEqual({
      radiance: [0, 24, 0],
      transmittance: 1,
    });
    const faint = cloudSegmentTransfer({ ...material, extinctionPerMeter: 1e-12 }, source, 1);
    expect(faint.radiance[0] / 3.2e-12).toBeCloseTo(1, 10);
  });
});

describe('cloud ray sampling policy', () => {
  it('preserves distinct budgets, device caps, and pre-clamp step lengths', () => {
    const budget = { scale: 1, rendererCap: 128, deviceCap: 128 };
    expect(cloudSampleBudget('view', budget)).toBe(96);
    expect(cloudSampleBudget('sun', budget)).toBe(10);
    expect(cloudSampleBudget('shadowMap', budget)).toBe(16);
    expect(cloudSampleBudget('shadowMap', { ...budget, scale: 0 })).toBe(4);
    expect(cloudSampleBudget('view', { ...budget, rendererCap: 40, deviceCap: 24 })).toBe(24);
    expect(cloudShadowMapSize(10000, 4, 1024, 512)).toBe(512);
    expect(cloudShadowMapSize(0, 1, 1024, 512)).toBe(0);
    expect(cloudViewSampling(25000, 2, 96, 50000, 8)).toEqual({
      evaluatedCount: 48,
      count: 8,
      stepMeters: 25000 / 48,
    });
    expect(cloudShouldStop(0.01, 0.001, 0.02, 0.03)).toBe(true);
    expect(cloudShouldStop(0.01, 0.001, 0.02, 0.02)).toBe(false);
    expect(cloudShouldStop(0, 0, 0, 0)).toBe(false);
  });
});
