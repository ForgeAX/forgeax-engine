import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { deriveLtcResourcePlan } from '../prepare/extended-lighting/ltc-resources';

describe('LTC extended-lighting resource admission', () => {
  it('omits Rect when LTC or required device facts are unavailable', () => {
    const scope = DeviceScope.create(7, 'renderer');

    expect(deriveLtcResourcePlan({ scope, ltcAvailable: false })).toEqual({
      topology: 'extendedLighting',
      generation: 7,
      rectAdmission: 'omitted',
      tableCount: 0,
      uploadCount: 0,
    });
  });

  it('plans exactly one pair of resident tables per DeviceScope', () => {
    const scope = DeviceScope.create(8, 'renderer');

    expect(deriveLtcResourcePlan({ scope, ltcAvailable: true })).toMatchObject({
      topology: 'extendedLighting',
      generation: 8,
      rectAdmission: 'admitted',
      tableCount: 2,
      uploadCount: 2,
    });
    expect(
      deriveLtcResourcePlan({ scope, ltcAvailable: true, residentGeneration: scope.generation }),
    ).toMatchObject({ tableCount: 2, uploadCount: 0 });
  });
});
