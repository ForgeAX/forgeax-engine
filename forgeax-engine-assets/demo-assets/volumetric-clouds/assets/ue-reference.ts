export const UE_CLOUD_REFERENCE = {
  layoutScaleMeters: 256_000,
  coverageBias: -0.20000000298023224,
  extinctionPerMeter: 0.00800000037997961,
  bottomMeters: 5000,
  thicknessMeters: 10000,
  entryLimitMeters: 350000,
  traceLimitMeters: 50000,
  viewSampleCountScale: 1,
  stopTransmittance: 0.005,
} as const;

/** Local UE OrthoMatrix uses 1/Width over NDC [-1,1]; ExtentKm is a sphere radius. */
export function ueCloudShadowProjection(extentKm: number, lightDistanceKm = extentKm * 2) {
  return {
    shadowExtentMeters: extentKm * 4000,
    shadowLightDistanceMeters: lightDistanceKm * 1000,
    shadowFarDepthMeters: lightDistanceKm * 2000,
  };
}

/** Original Divide_1/Multiply_28: Time / (1000 * PatternWidth / LayoutScaleKm). */
export function ueCloudWindOffset(seconds: number): readonly [number, number, number] {
  const normalizedTime = Math.fround(Math.fround(seconds) / (1000 * 1024 / 256));
  const wind = Math.fround(normalizedTime * 0.33333298563957214);
  const meters = Math.fround(wind * UE_CLOUD_REFERENCE.layoutScaleMeters);
  return [meters, meters * 0.5, -meters];
}

export const UE_CLOUD_SCENE_PRESET = {
  ...ueCloudShadowProjection(40),
  bottomMeters: UE_CLOUD_REFERENCE.bottomMeters,
  thicknessMeters: UE_CLOUD_REFERENCE.thicknessMeters,
  entryLimitMeters: UE_CLOUD_REFERENCE.entryLimitMeters,
  traceLimitMeters: UE_CLOUD_REFERENCE.traceLimitMeters,
  coverageBias: -2,
  extinctionOverridePerMeter: -1,
  windOffsetMeters: ueCloudWindOffset(0),
  viewSampleCountScale: UE_CLOUD_REFERENCE.viewSampleCountScale,
  stopTransmittance: UE_CLOUD_REFERENCE.stopTransmittance,
  skipEmpty: false,
} as const;
