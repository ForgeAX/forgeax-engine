export const WATER_QUALITY_PRESETS = {
  low: {
    tessellationFactor: 4,
    waterInfoResolution: 512,
    waveCount: 4,
    pontoonCount: 4,
    contactProbeCount: 16,
    localResolution: 128,
  },
  balanced: {
    tessellationFactor: 5,
    waterInfoResolution: 1024,
    waveCount: 8,
    pontoonCount: 8,
    contactProbeCount: 32,
    localResolution: 256,
  },
  high: {
    tessellationFactor: 6,
    waterInfoResolution: 2048,
    waveCount: 16,
    pontoonCount: 16,
    contactProbeCount: 64,
    localResolution: 512,
  },
  ultra: {
    tessellationFactor: 7,
    waterInfoResolution: 2048,
    waveCount: 32,
    pontoonCount: 32,
    contactProbeCount: 88,
    localResolution: 512,
  },
} as const;
export type WaterQualityPreset = keyof typeof WATER_QUALITY_PRESETS;

/** The solver normalizes point weights; keep each sphere's calibrated support volume. */
export function shipPontoonLayout(count: number, radiusM = 1.5) {
  if (!Number.isInteger(count) || count < 4 || count > 32 || count % 2 !== 0)
    throw new Error('Pontoon count must be an even integer from 4 to 32');
  const columns = count / 2;
  return {
    anchorsM: Array.from({ length: count }, (_, index) => [
      -6 + (Math.floor(index / 2) * 12) / (columns - 1),
      -0.9,
      index % 2 === 0 ? -1.6 : 1.6,
    ]).flat(),
    radiiM: Array.from({ length: count }, () => radiusM),
    enabledPontoons: Array.from({ length: count }, () => 1),
    velocityPontoonIndex: 0,
  };
}
