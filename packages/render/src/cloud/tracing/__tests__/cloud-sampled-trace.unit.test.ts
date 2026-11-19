import { describe, expect, it, vi } from 'vitest';
import type { MediumSample } from '../../contracts';
import { CLOUD_UNTRACED_DEPTH_METERS, type CloudRay, type CloudTraceClip } from '../geometry';
import { CLOUD_SAMPLED_MAX_STEPS } from '../policy';
import { type CloudSampledEvaluator, traceSampledCloud } from '../transport';

const planetRadiusMeters = 6_360_000;
const shell = { planetRadiusMeters, bottomMeters: 5000, thicknessMeters: 10000 };
const ray: CloudRay = {
  cameraRelativeToPlanetMeters: [0, planetRadiusMeters + 0.5, 0],
  direction: [0, 1, 0],
};
const clip: CloudTraceClip = {
  tracingStartMaxDistanceMeters: 350000,
  tracingMaxDistanceMeters: 50000,
  tracingMaxDistanceMode: 'from-layer-entry',
  tracingStartDistanceFromCameraMeters: 0,
  sceneDistanceMeters: CLOUD_UNTRACED_DEPTH_METERS,
};
const entry = 4999.5;
const segmentMeters = 1250;
const incoming = [4, 2, 1] as const;
const base: Omit<MediumSample, 'extinctionPerMeter'> = {
  albedo: [0.8, 0.5, 0.2],
  emissivePerMeter: [0, 0, 0],
  materialAO: 1,
};
const settings = {
  minSamples: 8,
  maxSamples: 8,
  distanceToMaxSamplesMeters: 10000,
  loopCap: 8,
  skipEmpty: false,
};

describe('R3 sampled cloud trace', () => {
  it('stops after adopting the configured transmittance threshold without changing step length', () => {
    const evaluate: CloudSampledEvaluator = {
      conservative: () => [1, 0, 0, 0],
      medium: () => ({ ...base, extinctionPerMeter: 0.001 }),
    };
    const actual = traceSampledCloud(
      ray,
      shell,
      clip,
      {
        ...settings,
        minSamples: 96,
        maxSamples: 96,
        loopCap: 96,
        stopTransmittance: 0.005,
      },
      evaluate,
      incoming,
    );
    const traversed = Math.ceil(-Math.log(0.005) / ((0.001 * 10000) / 96));
    expect(actual.counts).toEqual([96, traversed, traversed, traversed]);
    expect(actual.trace.transmittance).toBe(0);
    expect(actual.opticalDepth).toBeCloseTo((0.001 * traversed * 10000) / 96, 12);
  });

  it('matches a piecewise Beer solution and produces identical transport with skip on and off', () => {
    const evaluate: CloudSampledEvaluator = {
      conservative(t) {
        const sigma =
          t < entry + 2500 || t >= entry + 8750 ? 0 : t < entry + 5000 ? 0.0002 : 0.00005;
        return [sigma > 0 ? 1 : 0, sigma, 0, 0];
      },
      medium: vi.fn((_t, c4) => ({ ...base, extinctionPerMeter: c4[1] })),
    };
    const plain = traceSampledCloud(ray, shell, clip, settings, evaluate, incoming);
    const skipped = traceSampledCloud(
      ray,
      shell,
      clip,
      { ...settings, skipEmpty: true },
      evaluate,
      incoming,
    );
    const expectedTau = 0.0002 * 2500 + 0.00005 * 3750;
    const expectedT = Math.exp(-expectedTau);
    expect(plain.trace.transmittance).toBeCloseTo(expectedT, 12);
    expect(plain.opticalDepth).toBeCloseTo(expectedTau, 12);
    expect(plain.trace.radiance[0]).toBeCloseTo(3.2 * (1 - expectedT), 12);
    expect(plain.trace.radiance[1]).toBeCloseTo(1 - expectedT, 12);
    expect(plain.trace.radiance[2]).toBeCloseTo(0.2 * (1 - expectedT), 12);
    const weights = [1, Math.exp(-0.25), Math.exp(-0.5), Math.exp(-0.5625), Math.exp(-0.625)];
    const weighted = weights.reduce(
      (sum, weight, index) => sum + weight * (entry + (index + 2.5) * segmentMeters),
      0,
    );
    expect(plain.trace.representativeDepthMeters).toBeCloseTo(
      weighted / weights.reduce((sum, value) => sum + value, 0),
      10,
    );
    expect(plain.trace).toEqual(skipped.trace);
    expect(plain.opticalDepth).toBe(skipped.opticalDepth);
    expect(plain.counts).toEqual([8, 8, 8, 5]);
    expect(skipped.counts).toEqual([8, 8, 5, 5]);
    expect(evaluate.medium).toHaveBeenCalledTimes(13);
    expect(skipped.c4).toEqual(plain.c4);
    expect(skipped.extinctionPerMeter).toBe(0.0002);
    expect(skipped.witnessDistanceMeters).toBe(entry + 2.5 * segmentMeters);
  });

  it('does not stretch the path after applying an actual shader loop cap', () => {
    const evaluate: CloudSampledEvaluator = {
      conservative: () => [1, 0, 0, 0],
      medium: () => ({ ...base, extinctionPerMeter: 0.0001 }),
    };
    const sceneDistanceMeters = 8499.5;
    const actual = traceSampledCloud(
      ray,
      shell,
      { ...clip, sceneDistanceMeters },
      {
        ...settings,
        maxSamples: CLOUD_SAMPLED_MAX_STEPS * 2,
        loopCap: CLOUD_SAMPLED_MAX_STEPS * 2,
        distanceToMaxSamplesMeters: 1,
      },
      evaluate,
      incoming,
    );
    const integratedMeters = 3500 / 2;
    expect(actual.counts).toEqual([
      CLOUD_SAMPLED_MAX_STEPS * 2,
      CLOUD_SAMPLED_MAX_STEPS,
      CLOUD_SAMPLED_MAX_STEPS,
      CLOUD_SAMPLED_MAX_STEPS,
    ]);
    expect(actual.trace.exitMeters).toBe(sceneDistanceMeters);
    expect(actual.trace.transmittance).toBeCloseTo(Math.exp(-0.0001 * integratedMeters), 12);
    const low = traceSampledCloud(
      ray,
      shell,
      { ...clip, sceneDistanceMeters },
      { ...settings, minSamples: 2, maxSamples: 32, loopCap: 32, distanceToMaxSamplesMeters: 3500 },
      evaluate,
      incoming,
    );
    expect(low.counts).toEqual([32, 32, 32, 32]);
    expect(low.trace.transmittance).toBeCloseTo(Math.exp(-0.35), 12);
  });

  it('keeps a fully occluded ray free of evaluator calls and a vacuum witness on the first midpoint', () => {
    const evaluate: CloudSampledEvaluator = {
      conservative: vi.fn(() => [0, 0.4, 0.3, 0.2] as const),
      medium: vi.fn(() => ({ ...base, extinctionPerMeter: 0 })),
    };
    const blocked = traceSampledCloud(
      ray,
      shell,
      { ...clip, sceneDistanceMeters: 30 },
      settings,
      evaluate,
      incoming,
    );
    expect(blocked.trace).toEqual({
      radiance: [0, 0, 0],
      transmittance: 1,
      entryMeters: CLOUD_UNTRACED_DEPTH_METERS,
      exitMeters: CLOUD_UNTRACED_DEPTH_METERS,
      sceneDepthMeters: 30,
      representativeDepthMeters: CLOUD_UNTRACED_DEPTH_METERS,
    });
    expect(evaluate.conservative).not.toHaveBeenCalled();
    const empty = traceSampledCloud(
      ray,
      shell,
      clip,
      { ...settings, skipEmpty: true },
      evaluate,
      incoming,
    );
    expect(empty.c4).toEqual([0, 0.4, 0.3, 0.2]);
    expect(empty.witnessDistanceMeters).toBe(entry + 0.5 * segmentMeters);
    expect(empty.counts).toEqual([8, 8, 0, 0]);
    expect(evaluate.medium).not.toHaveBeenCalled();
    expect(empty.trace.transmittance).toBe(1);
    expect(empty.trace.representativeDepthMeters).toBe(empty.trace.exitMeters);
  });
});
