import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readCloudFields } from '../game.ts';

const fields = {
  bottomMeters: 5000, thicknessMeters: 10000, extinctionPerMeter: 0.002,
  coverageBias: -0.2, layoutWeight: 1, maskWeight: 1, profileWeight: 1, bodyWeight: 1, erosionWeight: 1,
  windX: 5, windY: 0, windZ: 0, referenceTimeSeconds: 10, viewSampleCountScale: 1, stopTransmittance: 0.005,
  phaseG: 0.15, phaseG2: -0.2, phaseBlend: 0,
  exposure: 0.00022,
  msContribution: 0.5, msOcclusion: 0.5, msEccentricity: 0.5, multiScatteringOctaves: 2,
  shadowSamples: 10, shadowDistanceMeters: 15000, shadowExtentMeters: 40000,
  shadowLightDistanceMeters: 80000, shadowFarDepthMeters: 160000,
  shadowStrength: 1, surfaceShadowStrength: 1, shadowDepthBiasMeters: 0, shadowMode: 1,
  atmosphereShadowStrength: 1,
  atmosphereTransmittanceMode: 0, enableDistantSkyLightSampling: true,
  skipEmpty: true, useDetail: false, selfShadow: true, groundShadowEnabled: false, atmosphereShadowEnabled: false,
};

it('accepts internal BSM with external casting disabled and validates the complete initialization request', () => {
  assert.deepEqual(readCloudFields(fields), fields);
  assert.deepEqual(readCloudFields({ ...fields, sunElevation: 8, sunAzimuth: 270 }), fields);
  for (const change of [
    { phaseG: 1 }, { shadowSamples: 2.5 },
    { shadowMode: 0.5 }, { multiScatteringOctaves: 3 }, { selfShadow: 'true' },
    { referenceTimeSeconds: -1 }, { shadowExtentMeters: 0 },
    { groundShadowEnabled: 'true' }, { atmosphereShadowEnabled: undefined },
  ]) assert.equal(readCloudFields({ ...fields, ...change }), undefined);
  assert.equal(fields.groundShadowEnabled, false);
  assert.equal(fields.atmosphereShadowEnabled, false);
  assert.equal(fields.shadowMode, 1);
});
