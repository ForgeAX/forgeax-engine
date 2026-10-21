import { expect, it } from 'vitest';
import { projectAdapterCapabilities } from '../adapter-capabilities';

it('snapshots feature membership and own or inherited numeric limits', () => {
  const features = new Set<GPUFeatureName>(['timestamp-query']);
  const prototype = { maxBufferSize: 1024, description: 'native' };
  const limits = Object.assign(Object.create(prototype), { maxTextureDimension2D: 512 });
  const projected = projectAdapterCapabilities(features, limits);
  features.clear();
  limits.maxTextureDimension2D = 32;
  prototype.maxBufferSize = 64;
  expect([...projected.features]).toEqual(['timestamp-query']);
  expect(projected.limits).toEqual({ maxTextureDimension2D: 512, maxBufferSize: 1024 });
});

it('preserves absent facts and numeric values without adding admission policy', () => {
  expect(projectAdapterCapabilities(undefined, null)).toEqual({ features: new Set(), limits: {} });
  expect(
    projectAdapterCapabilities(null, { unknown: NaN, infinite: Infinity, text: '12' }).limits,
  ).toEqual({ unknown: NaN, infinite: Infinity });
});
