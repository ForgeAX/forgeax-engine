import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BSM_REFERENCE_PRESET } from '../bsm-reference-preset.ts';
import { validateCloudEdit } from '../cloud-controls.ts';
import { QUALITY_PRESETS, QUALITY_PRESET_IDS, QUALITY_PARAMETER_KEYS, readQualityPreset, matchQualityPreset } from '../quality-presets.ts';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, WEATHER_PARAMETER_KEYS, weatherAtmosphereParameters } from '../weather-presets.ts';
import { cloudParameterLabels } from '../parameter-labels.ts';

test('quality tiers contain only valid rendering settings without changing the source weather', () => {
  for (const id of QUALITY_PRESET_IDS) {
    const candidate = QUALITY_PRESETS[id];
    assert.equal(readQualityPreset(id), candidate);
    assert.deepEqual(validateCloudEdit(candidate.parameters), { edit: candidate.parameters });
    assert.deepEqual(JSON.parse(JSON.stringify(candidate)), candidate);
    assert.ok(Object.isFrozen(candidate.parameters));
    assert.deepEqual(Object.keys(candidate.parameters), [...QUALITY_PARAMETER_KEYS]);
    assert.equal(candidate.parameters.skipEmpty, true);
    assert.equal(candidate.parameters.useDetail, false);
    assert.equal(candidate.parameters.selfShadow, true);
    assert.equal(candidate.parameters.groundShadowEnabled, true);
  }
  assert.equal(readQualityPreset('__proto__'), undefined);
  assert.equal(readQualityPreset('clear'), undefined);
  assert.equal(readQualityPreset({ id: 'quality-low' }), undefined);
  assert.equal(WEATHER_PRESETS.clear.forgeax.parameters.skipEmpty, false);
});

test('quality budgets match the low, medium and high configurations agreed with the user', () => {
  const fields = ['viewSampleCountScale', 'stopTransmittance', 'shadowMode', 'shadowResolution',
    'shadowMapSamples', 'multiScatteringOctaves', 'atmosphereShadowEnabled', 'atmosphereTransmittanceMode',
    'shadowSamples', 'shadowMapSpatialPasses', 'entryLimitMeters', 'traceLimitMeters'] as const;
  const budgets = QUALITY_PRESET_IDS.map(id => fields.map(key => QUALITY_PRESETS[id].parameters[key]));
  assert.deepEqual(budgets, [
    [1, 0.02, 1, 64, 16, 1, false, 0, 8, 1, 50_000, 50_000],
    [1, 0.01, 1, 128, 32, 2, true, 0, 8, 1, 50_000, 50_000],
    [1, 0.005, 0, 256, 64, 2, true, 1, 8, 2, 50_000, 50_000],
  ]);
  assert.equal(QUALITY_PRESETS['quality-high'].parameters.shadowDistanceMeters, 15000);
});

test('all nine quality/weather combinations commute and never overwrite the other axis', () => {
  assert.deepEqual(QUALITY_PARAMETER_KEYS.filter(key => (WEATHER_PARAMETER_KEYS as readonly string[]).includes(key)), []);
  assert.deepEqual([...QUALITY_PARAMETER_KEYS, ...WEATHER_PARAMETER_KEYS, 'referenceTimeSeconds', 'viewBlueNoise'].sort(), Object.keys(cloudParameterLabels).sort());
  for (const qualityId of QUALITY_PRESET_IDS) {
    const quality = QUALITY_PRESETS[qualityId].parameters;
    for (const weatherId of WEATHER_PRESET_IDS) {
      const atmosphere = weatherAtmosphereParameters(WEATHER_PRESETS[weatherId].forgeax.parameters);
      const weatherThenQuality = { ...atmosphere, ...quality };
      const qualityThenWeather = { ...quality, ...atmosphere };
      assert.deepEqual(weatherThenQuality, qualityThenWeather);
      assert.equal(matchQualityPreset(qualityThenWeather), qualityId);
      const rounded = Object.fromEntries(Object.entries(qualityThenWeather).map(([key, value]) =>
        [key, typeof value === 'number' ? Math.fround(value) : value]));
      assert.equal(matchQualityPreset(rounded), qualityId);
      assert.equal(matchQualityPreset({ ...rounded, viewSampleCountScale: 0.75 }), null);
    }
  }
  assert.equal(matchQualityPreset({}), null);
});


test('the UE BSM comparison locks material, sun, clock and raw map settings', () => {
  const { materialMode, clock, parameters } = BSM_REFERENCE_PRESET;
  assert.equal(materialMode, 'sample-ue');
  assert.equal(clock.paused, true);
  assert.deepEqual([parameters.windX, parameters.windY, parameters.windZ], [0, 0, 0]);
  assert.deepEqual(validateCloudEdit(parameters), { edit: parameters });
  assert.deepEqual([parameters.shadowResolution, parameters.shadowMapSamples], [512, 16]);
  assert.equal(parameters.shadowMode, 1);
  assert.equal(parameters.shadowMapUe5Reference, true);
  assert.equal(parameters.shadowExtentMeters, 160_000);
  assert.deepEqual(
    [parameters.bottomMeters, parameters.thicknessMeters, parameters.entryLimitMeters, parameters.traceLimitMeters],
    [5_000, 10_000, 350_000, 50_000],
  );
});
