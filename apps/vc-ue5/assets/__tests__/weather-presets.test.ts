import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, readWeatherPreset, uePose, weatherCutPose, weatherRoutePose } from '../weather-presets.ts';
import { validateCloudEdit } from '../cloud-controls.ts';
import { sunDirection } from '../sun-controls.ts';

test('D weather descriptors round trip with valid R6 parameters and one fixed shot', () => {
  for (const id of WEATHER_PRESET_IDS) {
    const candidate = WEATHER_PRESETS[id];
    assert.equal(readWeatherPreset(id), candidate);
    assert.deepEqual(JSON.parse(JSON.stringify(candidate)), candidate);
    assert.deepEqual(validateCloudEdit(candidate.forgeax.parameters), { edit: candidate.forgeax.parameters });
    assert.equal(candidate.forgeax.clock.paused, true);
    assert.equal(candidate.forgeax.materialMode, 'shape');
    assert.equal(candidate.forgeax.parameters.useDetail, false);
    assert.deepEqual(candidate.shot, WEATHER_PRESETS.clear.shot);
    assert.equal(candidate.unreal.cvars['r.VolumetricRenderTarget.Mode'], 0);
    assert.ok(Object.isFrozen(candidate.forgeax.parameters));
  }
  assert.equal(readWeatherPreset('__proto__'), undefined);
  assert.equal(readWeatherPreset({ id: 'clear' }), undefined);
  assert.deepEqual(WEATHER_PRESETS.clear.shot.uePose.positionCm.map(v => Math.round(v)), [-3618, 15717, 35]);
});

test('same ground and sun transforms serve the locked shot and dynamic cut', () => {
  const { clear, backlit, overcast } = WEATHER_PRESETS;
  for (const { unreal, forgeax } of [clear, backlit, overcast]) {
    const [x, y, z] = sunDirection(forgeax.parameters);
    assert.deepEqual(unreal.outgoingLightDirection, [-z, x, y]);
    const pitch = unreal.lightRotationDegrees[0] * Math.PI / 180;
    const yaw = unreal.lightRotationDegrees[1] * Math.PI / 180;
    assert.ok([Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
      .every((value, i) => Math.abs(value - unreal.outgoingLightDirection[i]) < 1e-10));
  }
  assert.ok(backlit.forgeax.parameters.sunElevation < clear.forgeax.parameters.sunElevation);
  assert.ok(overcast.forgeax.parameters.coverageBias > clear.forgeax.parameters.coverageBias);
  const { dynamic, routeDurationSeconds } = clear.timeline;
  const cut = dynamic.find(frame => frame.cut);
  assert.deepEqual(dynamic[0].uePose, clear.shot.uePose);
  assert.equal(dynamic.filter(frame => frame.cut).length, 1);
  assert.equal(cut?.seconds, routeDurationSeconds);
  assert.deepEqual(cut.uePose, uePose(weatherCutPose(weatherRoutePose(routeDurationSeconds))));
});
