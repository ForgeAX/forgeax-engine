import { expect, it, vi } from 'vitest';
import { cloudDepthRangeMeters } from '../depth-minmax';
import { CLOUD_UNTRACED_DEPTH_METERS } from '../geometry';
import { traceSampledCloud } from '../transport';

it('accumulates both depth lanes in a single march with UE near-boundary semantics', () => {
  const medium = vi.fn(() => ({
    albedo: [1, 1, 1] as const,
    extinctionPerMeter: 0.001,
    emissivePerMeter: [0, 0, 0] as const,
    materialAO: 1,
  }));
  const result = traceSampledCloud(
    { cameraRelativeToPlanetMeters: [0, 6360000, 0], direction: [0, 1, 0] },
    { planetRadiusMeters: 6360000, bottomMeters: 5000, thicknessMeters: 10000 },
    {
      tracingStartMaxDistanceMeters: 350000,
      tracingMaxDistanceMeters: 50000,
      tracingMaxDistanceMode: 'from-layer-entry',
      tracingStartDistanceFromCameraMeters: 0,
      sceneDistanceMeters: 15000,
    },
    {
      minSamples: 4,
      maxSamples: 4,
      distanceToMaxSamplesMeters: 10000,
      loopCap: 4,
      skipEmpty: false,
      nearSceneDistanceMeters: 8750,
    },
    { conservative: () => [1, 0, 0, 0], medium },
    [1, 1, 1],
  );
  expect(medium).toHaveBeenCalledTimes(4);
  // Independent four midpoint weights; near includes only the first two.
  const distances = [6250, 8750, 11250, 13750];
  const weights = distances.map((_, index) => Math.exp(-2.5 * index));
  const nearMean = (6250 + 8750 * Math.exp(-2.5)) / (1 + Math.exp(-2.5));
  const farMean =
    distances.reduce((sum, distance, index) => sum + distance * (weights[index] ?? 0), 0) /
    weights.reduce((sum, weight) => sum + weight, 0);
  expect(result.nearRepresentativeDepthMeters).toBeCloseTo(nearMean, 9);
  expect(result.trace.representativeDepthMeters).toBeCloseTo(farMean, 9);
  expect(result.nearRepresentativeDepthMeters).toBeLessThan(result.trace.representativeDepthMeters);
  expect(result.near.transmittance).toBeCloseTo(Math.exp(-2.5), 12);
  expect(result.near.radiance[0]).toBeCloseTo(1 - Math.exp(-5), 12);
  expect(result.trace.transmittance).toBeCloseTo(Math.exp(-10), 12);
  expect(result.trace.radiance[0]).toBeCloseTo(1 - Math.exp(-10), 12);
});

it('preserves sky as the far member and rejects non-meter values', () => {
  expect(cloudDepthRangeMeters([7, 2, CLOUD_UNTRACED_DEPTH_METERS, 5])).toEqual([
    2,
    CLOUD_UNTRACED_DEPTH_METERS,
  ]);
  expect(cloudDepthRangeMeters([])).toEqual([
    CLOUD_UNTRACED_DEPTH_METERS,
    CLOUD_UNTRACED_DEPTH_METERS,
  ]);
  expect(() => cloudDepthRangeMeters([Number.NaN])).toThrow(RangeError);
  expect(() => cloudDepthRangeMeters([-1])).toThrow(RangeError);
});
