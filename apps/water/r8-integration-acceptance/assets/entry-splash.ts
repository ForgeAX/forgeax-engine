export const waterEntrySplashDefaults = {
  jetSpeed: 2.6,
  radialSpeed: 1.8,
  dropletSize: 0.012,
  lifetime: 1.1,
  opacity: 0.72,
} as const;

export interface WaterEntryCollision {
  readonly entryPosition: readonly number[];
  readonly entryVelocity: readonly number[];
  readonly surfaceNormal: readonly number[];
  readonly entryRadiusM: number;
}

/** Energy-bounded impulse into the existing native gravity-wave field, independent of spray tuning. */
export function waterEntryWaveImpulse(collision: WaterEntryCollision) {
  const radius = Math.max(collision.entryRadiusM, 0.01);
  const normalLength = Math.hypot(...collision.surfaceNormal);
  const normalSpeed = Math.max(
    0,
    -collision.entryVelocity.reduce(
      (sum, value, axis) => sum + value * (collision.surfaceNormal[axis] ?? 0),
      0,
    ) / Math.max(normalLength, 1e-6),
  );
  // A compact pressure impulse redistributes water; it adds no displaced volume.
  // Bound transferred speed by both incident speed and the radius/gravity scale.
  const radiusM = radius * 1.2;
  // The spectral producer projects this physical footprint onto its available modes.
  const velocityImpulseMps = Math.min(normalSpeed * 0.55, Math.sqrt(9.81 * radius) * 2.6);
  return {
    positionXZ: [collision.entryPosition[0] ?? 0, collision.entryPosition[2] ?? 0] as const,
    radiusM,
    velocityImpulseMps,
  };
}

/** The native collision is the sole input to the shared airborne response. */
export function waterEntrySplashParameters(
  collision: WaterEntryCollision,
  settings: {
    readonly [Key in keyof typeof waterEntrySplashDefaults]: number;
  } = waterEntrySplashDefaults,
) {
  const radius = Math.max(collision.entryRadiusM, 0.01);
  const normalLength = Math.hypot(...collision.surfaceNormal);
  const normalSpeed = Math.max(
    0,
    -collision.entryVelocity.reduce(
      (sum, velocity, axis) => sum + velocity * (collision.surfaceNormal[axis] ?? 0),
      0,
    ) / Math.max(normalLength, 1e-6),
  );
  const gravitySpeed = Math.sqrt(9.81 * radius);
  // A bounded Froude response: normal entry supplies energy; radius supplies the gravity scale.
  // The legacy named controls remain response tunings, calibrated at their shared defaults.
  const response = normalSpeed / (normalSpeed + gravitySpeed);
  const jetSpeed = Math.min(
    normalSpeed * 0.5,
    ((Math.sqrt(2 * 9.81 * radius * (0.55 + 1.35 * response)) * normalSpeed) /
      (normalSpeed + gravitySpeed * 0.25)) *
      Math.min(settings.jetSpeed / waterEntrySplashDefaults.jetSpeed, 1.25),
  );
  const radialSpeed =
    Math.min(normalSpeed * 0.18, gravitySpeed * 0.55) *
    Math.min(settings.radialSpeed / waterEntrySplashDefaults.radialSpeed, 1.25);
  const collapseDelay =
    (2 * radius) / Math.max(normalSpeed, gravitySpeed) + 0.65 * Math.sqrt(radius / 9.81);
  return {
    ...collision,
    jetSpeed,
    radialSpeed,
    dropletSize: (settings.dropletSize * radius) / 0.6,
    lifetime: Math.max(settings.lifetime, collapseDelay + (2 * jetSpeed * 0.72) / 9.81 + 0.25),
    opacity: settings.opacity * response,
  };
}
