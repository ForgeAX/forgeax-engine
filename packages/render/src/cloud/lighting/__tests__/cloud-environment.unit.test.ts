import { expect, it } from 'vitest';
import { selectCloudLightingEnvironment } from '../environment';

it('uses atmosphere distant sky when selected and leaves absent sky at zero', () => {
  expect(selectCloudLightingEnvironment(true, undefined)).toEqual({
    atmosphereAvailable: true,
    skyLuminance: [0, 0, 0],
    skySource: 'atmosphere',
  });
  expect(selectCloudLightingEnvironment(false, undefined)).toEqual({
    atmosphereAvailable: false,
    skyLuminance: [0, 0, 0],
    skySource: 'none',
  });
});

it('keeps additive irradiance independent of solid sky intensity and averages a hemisphere', () => {
  const sky = {
    equirectHandle: 0,
    color: [2, 4, 6] as const,
    groundColor: [0, 0, 0] as const,
    ambientIrradiance: [Math.PI, 2 * Math.PI, 3 * Math.PI] as const,
    intensity: 2,
  };
  expect(selectCloudLightingEnvironment(false, sky).skyLuminance).toEqual([5, 10, 15]);
  expect(selectCloudLightingEnvironment(false, { ...sky, intensity: 0 }).skyLuminance).toEqual([
    1, 2, 3,
  ]);
  expect(
    selectCloudLightingEnvironment(false, { ...sky, groundColor: [4, 6, 8] }).skyLuminance,
  ).toEqual([7, 12, 17]);
  expect(selectCloudLightingEnvironment(false, { ...sky, equirectHandle: 2 }).skySource).toBe(
    'unavailable-image',
  );
});
