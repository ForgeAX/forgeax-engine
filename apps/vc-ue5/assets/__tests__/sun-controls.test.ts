import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readSunFields, sunDirection, sunFieldsFromDirection } from '../sun-controls.ts';

it('accepts only finite solar angles inside the slider ranges', () => {
  const fields = { sunElevation: 36.6266784611, sunAzimuth: 46.2638397159 };
  assert.deepEqual(readSunFields(fields), fields);
  for (const invalid of [null, {}, { ...fields, sunElevation: NaN }, { ...fields, sunElevation: 181 },
    { ...fields, sunElevation: -91 }, { ...fields, sunAzimuth: Infinity }, { ...fields, sunAzimuth: 361 }])
    assert.equal(readSunFields(invalid), undefined);
});

it('round-trips authored solar angles above the zenith without flipping azimuth', () => {
  for (const sunElevation of [90, 90.001, 120, 179.25, 179.999, 180]) {
    for (const sunAzimuth of [-360, -270, -180, -46.26384, 0, 46.26384, 180, 270, 360]) {
      const fields = { sunElevation, sunAzimuth };
      assert.deepEqual(readSunFields(fields), fields);
      const actual = sunFieldsFromDirection(new Float32Array(sunDirection(fields)), sunAzimuth, sunElevation);
      assert.ok(readSunFields(actual));
      assert.ok(Math.abs(actual.sunElevation - sunElevation) < 0.00001, `${sunElevation} became ${actual.sunElevation}`);
      assert.ok(Math.abs(actual.sunAzimuth - sunAzimuth) < 0.00001, `${sunAzimuth} became ${actual.sunAzimuth}`);
    }
  }
  assert.deepEqual(sunFieldsFromDirection([0, -1, 0], 270, 90), { sunElevation: 90, sunAzimuth: 270 });
});

it('preserves fractional elevation and the selected azimuth branch without slider-step quantization', () => {
  for (const sunAzimuth of [-360, -270, -180, 0, 180, 270, 360]) {
    const fields = { sunElevation: 36.6266784611, sunAzimuth };
    const direction = new Float32Array(sunDirection(fields));
    const actual = sunFieldsFromDirection(direction, sunAzimuth);
    assert.ok(Math.abs(actual.sunElevation - fields.sunElevation) < 0.00001);
    assert.ok(Math.abs(actual.sunAzimuth - fields.sunAzimuth) < 0.00001);
  }
  for (const sunElevation of [-90, -44.1, -10, 90]) {
    const actual = sunFieldsFromDirection(new Float32Array(sunDirection({ sunElevation, sunAzimuth: 90 })), 90);
    assert.ok(readSunFields(actual));
    assert.ok(Math.abs(actual.sunElevation - sunElevation) < 0.00001);
  }
});
