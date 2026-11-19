import assert from 'node:assert/strict';
import test from 'node:test';
import { ueCloudShadowProjection } from '@forgeax-assets/volumetric-clouds/reference';

test('adapts UE sphere extent and independent light override into Engine metres', () => {
  assert.deepEqual(ueCloudShadowProjection(40), { shadowExtentMeters: 160000, shadowLightDistanceMeters: 80000, shadowFarDepthMeters: 160000 });
  assert.deepEqual(ueCloudShadowProjection(40, 100), { shadowExtentMeters: 160000, shadowLightDistanceMeters: 100000, shadowFarDepthMeters: 200000 });
});
