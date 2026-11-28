import { UE_CLOUD_REFERENCE } from '@forgeax-assets/volumetric-clouds/reference';
import type { CloudPreset } from './cloud-controls.ts';
import { WEATHER_PRESETS } from './weather-presets.ts';

export const BSM_REFERENCE_PRESET_ID = 'bsm-reference';
const clear = WEATHER_PRESETS.clear.forgeax;

/** Start all BSM comparisons from the same material, pose and frozen cloud clock. */
export const BSM_REFERENCE_PRESET = {
  ...clear,
  materialMode: 'sample-ue',
  parameters: {
    ...clear.parameters,
    bottomMeters: UE_CLOUD_REFERENCE.bottomMeters,
    thicknessMeters: UE_CLOUD_REFERENCE.thicknessMeters,
    entryLimitMeters: UE_CLOUD_REFERENCE.entryLimitMeters,
    traceLimitMeters: UE_CLOUD_REFERENCE.traceLimitMeters,
    windX: 0,
    windY: 0,
    windZ: 0,
    sunElevation: 30,
    selfShadow: true,
    shadowMode: 1,
    shadowMapUe5Reference: true,
    shadowMapSpatialPasses: 1,
    shadowMapSamples: 16,
    shadowResolution: 512,
    shadowExtentMeters: 160_000,
    shadowLightDistanceMeters: 80_000,
    shadowFarDepthMeters: 160_000,
  },
  clock: { ...clear.clock, paused: true },
} as const satisfies CloudPreset;
