import type { AtmosphereParameters } from '../extract/environment';

export const earthAtmosphere: AtmosphereParameters = {
  planetRadius: 6_360_000,
  atmosphereHeight: 60_000,
  groundOrigin: [0, 0, 0],
  capturePosition: [0, 1, 0],
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScaleHeight: 8_000,
  mieScattering: 3.996e-6,
  mieAbsorption: 0.444e-6,
  mieScaleHeight: 1_200,
  mieAnisotropy: 0.8,
  absorption: [0.65e-6, 1.881e-6, 0.085e-6],
  absorptionPeakHeight: 25_000,
  absorptionHalfWidth: 15_000,
  groundAlbedo: [0.4, 0.4, 0.4],
  multipleScattering: 1,
  sunAngularRadius: 0.004675,
  aerialPerspectiveStart: 0,
  aerialPerspectiveDistanceScale: 1,
};
