import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Spherical atmosphere: public lengths are meters, coefficients are inverse meters.
 *
 * The sky is lit by the sun (the first shadow-casting DirectionalLight, else
 * the first) and also feeds a Skylight without `equirect`, so both the direct
 * light and the sky-lit ambient change with the sun's elevation.
 *
 * The sky, aerial perspective and sky-lit Skylight scatter only the sun's
 * luminance; the medium reddens a low sun by itself. `DirectionalLight.color`
 * still tints the direct light and the visible sun disc.
 */
export const Atmosphere = defineComponent('Atmosphere', {
  /** Raster physical sky and optional Skylight IBL; no aerial perspective or surface solar attenuation. */
  backgroundOnly: { type: 'bool', default: false },
  planetRadius: { type: 'f32', default: 6_360_000 },
  atmosphereHeight: { type: 'f32', default: 60_000 },
  rayleighScattering: {
    type: 'array<f32, 3>',
    default: new Float32Array([5.802e-6, 13.558e-6, 33.1e-6]),
  },
  rayleighScaleHeight: { type: 'f32', default: 8_000 },
  mieScattering: { type: 'f32', default: 3.996e-6 },
  mieAbsorption: { type: 'f32', default: 0.444e-6 },
  mieScaleHeight: { type: 'f32', default: 1_200 },
  mieAnisotropy: { type: 'f32', default: 0.8 },
  absorption: {
    type: 'array<f32, 3>',
    default: new Float32Array([0.65e-6, 1.881e-6, 0.085e-6]),
  },
  absorptionPeakHeight: { type: 'f32', default: 25_000 },
  absorptionHalfWidth: { type: 'f32', default: 15_000 },
  groundAlbedo: { type: 'array<f32, 3>', default: new Float32Array([0.4, 0.4, 0.4]) },
  multipleScattering: { type: 'f32', default: 1 },
  sunAngularRadius: { type: 'f32', default: 0.004675 },
  aerialPerspectiveStart: { type: 'f32', default: 0 },
  aerialPerspectiveDistanceScale: { type: 'f32', default: 1 },
});
