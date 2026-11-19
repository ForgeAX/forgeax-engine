import type { CloudRgb, MediumSample } from '../contracts';

export type ConservativeDensity = readonly [number, number, number, number];

const EMPTY_DENSITY: ConservativeDensity = [0, 0, 0, 0];
const POSSIBLE_DENSITY: ConservativeDensity = [1, 0, 0, 0];
const VACUUM: MediumSample = {
  extinctionPerMeter: 0,
  albedo: [0, 0, 0],
  emissivePerMeter: [0, 0, 0],
  materialAO: 1,
};

function inLayer(heightFraction: number): boolean {
  return heightFraction >= 0 && heightFraction <= 1;
}

/** Occupancy only: zero extinction alone cannot rule out a purely emissive medium. */
export function evaluateUniformConservative(
  sample: MediumSample,
  heightFraction: number,
): ConservativeDensity {
  if (!inLayer(heightFraction)) return EMPTY_DENSITY;
  return sample.extinctionPerMeter > 0 || sample.emissivePerMeter.some((channel) => channel > 0)
    ? POSSIBLE_DENSITY
    : EMPTY_DENSITY;
}

/** Consumes an authoring-validated uniform sample and an unclamped layer fraction. */
export function evaluateUniformMedium(sample: MediumSample, heightFraction: number): MediumSample {
  return inLayer(heightFraction) ? sample : VACUUM;
}

type Position = CloudRgb;

/** Return the displacement from the camera in ForgeaX axes, without converting units. */
export function cloudRelativePosition(positionMeters: Position, cameraMeters: Position): Position {
  return [
    positionMeters[0] - cameraMeters[0],
    positionMeters[1] - cameraMeters[1],
    positionMeters[2] - cameraMeters[2],
  ];
}

/** Convert a ForgeaX position or direction to the frozen cloud graph's axis basis. */
export function cloudModelPosition(positionMeters: Position): Position {
  return [-positionMeters[2], positionMeters[0], positionMeters[1]];
}

/** Keep the out-of-layer value for occupancy checks; only material sampling clamps height. */
export function cloudHeightFraction(
  altitudeMeters: number,
  bottomMeters: number,
  thicknessMeters: number,
): number {
  return (altitudeMeters - bottomMeters) / thicknessMeters;
}

/** Source rate is 0.00002 / cm; at the meter boundary it becomes 0.002 / m. */
export function cloudDistanceFade(relativeMeters: Position): number {
  return Math.min(1, Math.hypot(...relativeMeters) * 0.002);
}

/** Move the pattern with the wind by sampling its inverse displacement. */
export function cloudAdvectedModelPosition(
  positionMeters: Position,
  windMetersPerSecond: Position,
  seconds: number,
): Position {
  return cloudModelPosition([
    positionMeters[0] - windMetersPerSecond[0] * seconds,
    positionMeters[1] - windMetersPerSecond[1] * seconds,
    positionMeters[2] - windMetersPerSecond[2] * seconds,
  ]);
}
