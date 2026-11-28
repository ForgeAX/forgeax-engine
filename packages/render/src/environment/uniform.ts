import type { AtmosphereParameters } from '../extract/environment';

/** The common View tail owns the atmosphere ABI; SI conversion occurs here only. */
export function writeAtmosphereUniform(
  out: Float32Array,
  offset: number,
  p: AtmosphereParameters,
  referenceSamples = 0,
  ue5NearMeters?: number,
): void {
  for (let axis = 0; axis < 3; axis++) {
    out[offset + axis] = (p.groundOrigin[axis] ?? 0) * 0.001;
    out[offset + 4 + axis] = (p.rayleighScattering[axis] ?? 0) * 1000;
    out[offset + 12 + axis] = (p.absorption[axis] ?? 0) * 1000;
    out[offset + 16 + axis] = p.groundAlbedo[axis] ?? 0;
  }
  out[offset + 3] = p.planetRadius * 0.001;
  out[offset + 7] = p.rayleighScaleHeight * 0.001;
  out[offset + 8] = p.mieScattering * 1000;
  out[offset + 9] = p.mieAbsorption * 1000;
  out[offset + 10] = p.mieScaleHeight * 0.001;
  out[offset + 11] = p.mieAnisotropy;
  out[offset + 15] = p.absorptionPeakHeight * 0.001;
  out[offset + 19] = p.absorptionHalfWidth * 0.001;
  out[offset + 20] = p.atmosphereHeight * 0.001;
  out[offset + 21] = p.multipleScattering;
  out[offset + 22] = Math.max(p.aerialPerspectiveStart, ue5NearMeters ?? 0) * 0.001;
  out[offset + 23] = p.aerialPerspectiveDistanceScale;
  out[offset + 24] = referenceSamples;
  out[offset + 25] = p.sunAngularRadius;
  // UE's AP volume depth is independent of opaque geometry clipping.
  out[offset + 26] = 96;
  out[offset + 27] = Number(!p.backgroundOnly) + (ue5NearMeters === undefined ? 0 : 4);
}
