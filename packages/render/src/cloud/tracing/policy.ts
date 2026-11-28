/** Hard per-ray safety cap mirrored by the sampled WGSL trace. */
export const CLOUD_SAMPLED_MAX_STEPS = 768;

export const CLOUD_BASE_SAMPLE_COUNTS = { view: 96, sun: 10, shadowMap: 16 } as const;
export type CloudRayClass = keyof typeof CLOUD_BASE_SAMPLE_COUNTS;

export interface CloudRayBudget {
  readonly scale: number;
  readonly rendererCap: number;
  readonly deviceCap: number;
}

export function cloudSampleBudget(rayClass: CloudRayClass, budget: CloudRayBudget): number {
  const { scale, rendererCap, deviceCap } = budget;
  if (
    !Number.isFinite(scale) ||
    !Number.isFinite(rendererCap) ||
    !Number.isFinite(deviceCap) ||
    scale < 0 ||
    rendererCap < 1 ||
    deviceCap < 1
  ) {
    return 0;
  }
  // UE floors configured view/sun budgets at two and the map budget at four.
  const minimum = rayClass === 'shadowMap' ? 4 : 2;
  return Math.floor(
    Math.min(
      deviceCap,
      Math.max(minimum, Math.min(rendererCap, CLOUD_BASE_SAMPLE_COUNTS[rayClass] * scale)),
    ),
  );
}

/** UE's default shadow-map horizon multiplier, applied after the base cap. */
export function ue5CloudShadowTraceSamples(baseSamples: number, sunUpDot: number): number {
  const base = Math.min(128, Math.max(4, baseSamples));
  const horizon = 0.2 / Math.max(0.2, Math.abs(sunUpDot));
  return base * (1 + horizon);
}

/** Upper view budget packed into both cooked cloud transport shaders. */
export function cookedCloudViewSampleBudget(scale: number): number {
  return cloudSampleBudget('view', {
    scale,
    rendererCap: CLOUD_SAMPLED_MAX_STEPS,
    deviceCap: CLOUD_SAMPLED_MAX_STEPS,
  });
}

export interface CloudViewSampling {
  readonly evaluatedCount: number;
  readonly count: number;
  readonly stepMeters: number;
}

/** Evaluate the step before the loop clamp; a clamp may leave the tail unintegrated. */
export function cloudViewSampling(
  distanceMeters: number,
  minSamples: number,
  maxSamples: number,
  distanceToMaxSamplesMeters: number,
  loopCap: number,
): CloudViewSampling {
  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(minSamples) ||
    !Number.isFinite(maxSamples) ||
    !Number.isFinite(distanceToMaxSamplesMeters) ||
    !Number.isFinite(loopCap) ||
    distanceMeters <= 0 ||
    minSamples < 1 ||
    maxSamples < minSamples ||
    distanceToMaxSamplesMeters <= 0 ||
    loopCap < 0
  ) {
    return { evaluatedCount: 0, count: 0, stepMeters: 0 };
  }
  const evaluatedCount = Math.floor(
    Math.max(minSamples, maxSamples * Math.min(1, distanceMeters / distanceToMaxSamplesMeters)),
  );
  return {
    evaluatedCount,
    count: Math.min(evaluatedCount, Math.floor(loopCap)),
    stepMeters: distanceMeters / evaluatedCount,
  };
}

export function cloudShouldStop(
  red: number,
  green: number,
  blue: number,
  threshold: number,
): boolean {
  return threshold > 0 && red < threshold && green < threshold && blue < threshold;
}

/** UE's 512 texel baseline, bounded by the renderer profile and the device limit. */
export function cloudShadowMapSize(
  extentMeters: number,
  resolutionScale: number,
  rendererCap: number,
  deviceCap: number,
): number {
  if (
    !(Number.isFinite(extentMeters) && extentMeters > 0) ||
    !(Number.isFinite(resolutionScale) && resolutionScale > 0) ||
    !(Number.isFinite(rendererCap) && rendererCap >= 1) ||
    !(Number.isFinite(deviceCap) && deviceCap >= 1)
  ) {
    return 0;
  }
  return Math.floor(Math.min(512 * resolutionScale, rendererCap, deviceCap));
}
