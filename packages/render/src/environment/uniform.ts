import type { AtmosphereParameters } from '../extract/environment';

/** The common View tail owns the atmosphere ABI; SI conversion occurs here only. */
export function writeAtmosphereUniform(
  out: Float32Array,
  offset: number,
  p: AtmosphereParameters,
  referenceSamples = 0,
): void {
  out.set(
    [
      ...p.groundOrigin.map((v) => v * 0.001),
      p.planetRadius * 0.001,
      ...p.rayleighScattering.map((v) => v * 1000),
      p.rayleighScaleHeight * 0.001,
      p.mieScattering * 1000,
      p.mieAbsorption * 1000,
      p.mieScaleHeight * 0.001,
      p.mieAnisotropy,
      ...p.absorption.map((v) => v * 1000),
      p.absorptionPeakHeight * 0.001,
      ...p.groundAlbedo,
      p.absorptionHalfWidth * 0.001,
      p.atmosphereHeight * 0.001,
      p.multipleScattering,
      p.aerialPerspectiveStart * 0.001,
      p.aerialPerspectiveDistanceScale,
      referenceSamples,
      p.sunAngularRadius,
      // UE's AP volume depth is independent of opaque geometry clipping.
      96,
      p.backgroundOnly ? 0 : 1,
    ],
    offset,
  );
}
