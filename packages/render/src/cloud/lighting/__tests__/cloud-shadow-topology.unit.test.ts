import { expect, it } from 'vitest';
import { cloudShadowProjectionFor } from '../../../record/view-topology';
import type { ExtractedCloudLayer } from '../../extract';

it.each([
  16, 33, 64, 128,
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
