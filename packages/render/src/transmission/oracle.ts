/** Pure CPU expectations for transmission math; this module has no GPU ownership. */

export type Color3 = readonly [number, number, number];
export type Uv2 = readonly [number, number];

export const DEFAULT_IOR = 1.5;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * Returns unpolarized dielectric reflectance. `eta` is incident IOR divided
 * by transmitted IOR, so values above one can produce total internal
 * reflection. This is a CPU oracle only; it does not sample a GPU resource.
 */
export function fresnelReflectance(cosTheta: number, eta: number): number {
  if (!Number.isFinite(cosTheta) || !Number.isFinite(eta) || eta <= 0) return 1;

  const cosIncident = clamp01(cosTheta);
  const sinTransmittedSquared = eta * eta * (1 - cosIncident * cosIncident);
  if (sinTransmittedSquared >= 1) return 1;

  const cosTransmitted = Math.sqrt(Math.max(0, 1 - sinTransmittedSquared));
  const perpendicularDenominator = cosIncident + eta * cosTransmitted;
  const parallelDenominator = eta * cosIncident + cosTransmitted;
  if (perpendicularDenominator === 0 || parallelDenominator === 0) return 1;

  const perpendicular = (cosIncident - eta * cosTransmitted) / perpendicularDenominator;
  const parallel = (eta * cosIncident - cosTransmitted) / parallelDenominator;
  return clamp01((perpendicular * perpendicular + parallel * parallel) / 2);
}
