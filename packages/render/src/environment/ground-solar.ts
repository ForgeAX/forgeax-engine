import type { AtmosphereParameters } from '../extract/environment';

/** UE's ground illuminance reference: 500 m above the pole, 15 left-endpoint samples. */
export function groundSolarTransmittance(
  atmosphere: AtmosphereParameters,
  directionToLight: ArrayLike<number>,
): readonly [number, number, number] {
  const x = directionToLight[0] ?? 0;
  const y = directionToLight[1] ?? 0;
  const z = directionToLight[2] ?? 0;
  const mu = y / Math.hypot(x, y, z);
  const radius = atmosphere.planetRadius + 500;
  const top = atmosphere.planetRadius + atmosphere.atmosphereHeight;
  const b = radius * mu;
  const discriminant = b * b + (top - radius) * (top + radius);
  if (discriminant < 0) return [1, 1, 1];
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (far < 0) return [1, 1, 1];
  const distance = Math.max(0, near >= 0 ? near : far);
  const step = distance / 15;
  const tau = [0, 0, 0];
  for (let index = 0; index < 15; index++) {
    const along = index * step;
    const height =
      Math.hypot(along * Math.sqrt(Math.max(0, 1 - mu * mu)), radius + along * mu) -
      atmosphere.planetRadius;
    // Below-ground density is intentional: UE integrates toward the atmosphere top,
    // and the dense planet-crossing segment extinguishes negative-elevation light.
    const mieCoefficient = atmosphere.mieScattering + atmosphere.mieAbsorption;
    const mie =
      mieCoefficient === 0
        ? 0
        : Math.exp(Math.log(mieCoefficient) - height / atmosphere.mieScaleHeight);
    const absorption = Math.max(
      0,
      1 - Math.abs(height - atmosphere.absorptionPeakHeight) / atmosphere.absorptionHalfWidth,
    );
    for (let channel = 0; channel < 3; channel++) {
      const rayleighCoefficient = atmosphere.rayleighScattering[channel] ?? 0;
      const rayleigh =
        rayleighCoefficient === 0
          ? 0
          : Math.exp(Math.log(rayleighCoefficient) - height / atmosphere.rayleighScaleHeight);
      tau[channel] =
        (tau[channel] ?? 0) +
        step * (rayleigh + mie + absorption * (atmosphere.absorption[channel] ?? 0));
    }
  }
  return [Math.exp(-(tau[0] ?? 0)), Math.exp(-(tau[1] ?? 0)), Math.exp(-(tau[2] ?? 0))];
}
