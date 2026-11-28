import { expect, it } from 'vitest';
import { cloudShadowProjectionFor } from '../../../record/view-topology';
import type { ExtractedCloudLayer } from '../../extract';
import { viewCloudShadowProjection } from '../shadow';
import { cloudShadowSpatialLayout } from '../shadow-spatial-layout';

it.each([
  16, 33, 64, 128, 512,
])('preserves authored raw %i while snapping to final filtered texels', (resolution) => {
  const layer: ExtractedCloudLayer = {
    status: 'analytic',
    bottomMeters: 5000,
    thicknessMeters: 10000,
    entryLimitMeters: 350000,
    traceLimitMeters: 50000,
    sample: {
      extinctionPerMeter: 0.001,
      albedo: [1, 1, 1],
      emissivePerMeter: [0, 0, 0],
      materialAO: 1,
    },
    shadowMap: {
      directionToLight: [0, 1, 0],
      origin: [0, 80000, 0],
      right: [1, 0, 0],
      up: [0, 0, 1],
      extentMeters: 160000,
      depthMeters: 160000,
      resolution,
      mapSamples: 16,
      mode: 1,
      cast: true,
      biasMeters: 0,
      strength: 1,
      surfaceStrength: 1,
    },
  };
  const projection = cloudShadowProjectionFor(layer);
  expect(projection).toMatchObject({
    rawResolution: resolution,
    resolution: Math.ceil(resolution / 2),
    texelSize: 160000 / Math.ceil(resolution / 2),
  });
});

it('models UE truncation, ordered passes and the direct raw route', () => {
  expect(cloudShadowSpatialLayout(33, 0, true)).toEqual({
    rawResolution: 33,
    filteredResolution: 33,
    traceTarget: 'cloud-shadow',
    passes: [],
  });
  expect(cloudShadowSpatialLayout(33, 4, true)).toEqual({
    rawResolution: 33,
    filteredResolution: 2,
    traceTarget: 'cloud-shadow-raw',
    passes: [
      {
        name: 'cloud-layer-shadow-filter',
        input: 'cloud-shadow-raw',
        output: 'cloud-shadow-filter-1',
        resolution: 16,
      },
      {
        name: 'cloud-layer-shadow-filter-2',
        input: 'cloud-shadow-filter-1',
        output: 'cloud-shadow-filter-2',
        resolution: 8,
      },
      {
        name: 'cloud-layer-shadow-filter-3',
        input: 'cloud-shadow-filter-2',
        output: 'cloud-shadow-filter-3',
        resolution: 4,
      },
      {
        name: 'cloud-layer-shadow-filter-4',
        input: 'cloud-shadow-filter-3',
        output: 'cloud-shadow',
        resolution: 2,
      },
    ],
  });
  expect(cloudShadowSpatialLayout(33, 1, false).filteredResolution).toBe(17);
});

it('keeps the UE origin on the two-raw-texel grid at every spatial pass count', () => {
  const position = [28400, 6000, 48400];
  const settings = {
    directionToLight: [0.2, 0.35, 0.7] as const,
    extentMeters: 160_000,
    depthMeters: 160_000,
    resolution: 33,
    mapSamples: 16,
    mode: 1,
    cast: true,
    biasMeters: 0,
    strength: 1,
    surfaceStrength: 1,
    ue5Reference: true,
  };
  const origin = viewCloudShadowProjection(settings, position).origin;
  for (const spatialPasses of [0, 1, 2, 3, 4]) {
    const map = viewCloudShadowProjection({ ...settings, spatialPasses }, position);
    expect(map.origin).toEqual(origin);
    for (const axis of [map.right, map.up]) {
      const gridCoordinate =
        axis.reduce((sum, value, i) => sum + value * (map.origin[i] ?? 0), 0) /
        ((2 * map.extentMeters) / map.resolution);
      expect(gridCoordinate).toBeCloseTo(Math.round(gridCoordinate), 8);
    }
  }
});
