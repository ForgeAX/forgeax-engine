import { expect, it } from 'vitest';
import { earthAtmosphere } from '../../../__tests__/atmosphere-fixture';
import { groundSolarTransmittance } from '../../../environment/ground-solar';

it('retains sunset colour while extinguishing deep negative elevations without a horizon clamp', () => {
  const at = (angle: number) =>
    groundSolarTransmittance(earthAtmosphere, [
      Math.cos((angle * Math.PI) / 180),
      Math.sin((angle * Math.PI) / 180),
      0,
    ]);
  expect(at(-5)).toEqual([0, 0, 0]);
  expect(at(-90)).toEqual([0, 0, 0]);
  const horizon = at(0);
  expect(horizon[0]).toBeGreaterThan(horizon[1]);
  expect(horizon[1]).toBeGreaterThan(horizon[2]);
  const noon = at(90);
  expect(noon.every((value) => value > 0.5 && value < 1)).toBe(true);
  expect(at(-1)[0]).toBeLessThan(horizon[0]);
});

it('uses the UE 500 m / 15-sample ground reference independently of camera XZ and azimuth', () => {
  const angle = (5 * Math.PI) / 180;
  const reference = groundSolarTransmittance(earthAtmosphere, [
    Math.cos(angle),
    Math.sin(angle),
    0,
  ]);
  const rotated = groundSolarTransmittance(
    {
      ...earthAtmosphere,
      capturePosition: [80000, 15000, -60000],
      groundOrigin: [1000, 250, -2000],
    },
    [0, Math.sin(angle) * 3, Math.cos(angle) * 3],
  );
  rotated.forEach((value, c) => {
    expect(value).toBeCloseTo(reference[c] ?? 0, 14);
  });
  // Independent left-endpoint optical-depth sum in km, matching local UE source.
  const r = 6360.5,
    top = 6420;
  const distance = -r * Math.sin(angle) + Math.sqrt(top * top - r * r * Math.cos(angle) ** 2);
  const tau = [0, 0, 0];
  for (let n = 0; n < 15; n++) {
    const d = (distance * n) / 15;
    const h = Math.sqrt(r * r + d * d + 2 * r * d * Math.sin(angle)) - 6360;
    for (let c = 0; c < 3; c++)
      tau[c] =
        (tau[c] ?? 0) +
        (distance / 15) *
          (Math.exp(-h / 8) * ([0.005802, 0.013558, 0.0331][c] ?? 0) +
            Math.exp(-h / 1.2) * 0.00444 +
            Math.max(0, 1 - Math.abs(h - 25) / 15) * ([0.00065, 0.001881, 0.000085][c] ?? 0));
  }
  reference.forEach((value, c) => {
    expect(value).toBeCloseTo(Math.exp(-(tau[c] ?? 0)), 10);
  });
});

it('retains finite zero-density identities for planet-crossing night rays', () => {
  const noMie = { ...earthAtmosphere, mieScattering: 0, mieAbsorption: 0 };
  expect(groundSolarTransmittance(noMie, [0, -1, 0])).toEqual([0, 0, 0]);
  expect(
    groundSolarTransmittance(
      { ...noMie, rayleighScattering: [0, 0, 0], absorption: [0, 0, 0] },
      [0, -1, 0],
    ),
  ).toEqual([1, 1, 1]);
});

it('keeps a ground reference outside a very thin authored atmosphere finite', () => {
  const thin = { ...earthAtmosphere, atmosphereHeight: 100 };
  expect(groundSolarTransmittance(thin, [0, 1, 0])).toEqual([1, 1, 1]);
  expect(groundSolarTransmittance(thin, [1, 0, 0])).toEqual([1, 1, 1]);
  expect(groundSolarTransmittance(thin, [0, -1, 0]).every(Number.isFinite)).toBe(true);
});

it('uses the configured minimum elevation for the shared CPU solar reference', () => {
  const angle = (6 * Math.PI) / 180;
  const medium = { ...earthAtmosphere, transmittanceMinLightElevationDegrees: 6 };
  const floor = groundSolarTransmittance(medium, [0, -0.5, 1]);
  expect(groundSolarTransmittance(medium, [0, 0.5, -1], true)).toBe(floor);
  const atAngle = groundSolarTransmittance(earthAtmosphere, [0, Math.sin(angle), Math.cos(angle)]);
  for (const [channel, value] of floor.entries())
    expect(value).toBeCloseTo(atAngle[channel] ?? 0, 12);
  expect(groundSolarTransmittance({ ...medium, mieScattering: 0 }, [0, -0.5, 1])).not.toEqual(
    floor,
  );
});
