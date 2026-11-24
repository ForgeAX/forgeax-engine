import { EngineContent } from '@forgeax/engine/content';
import { PackageId } from '@forgeax/engine/pack/guid';
import type { WaterFluidSimulationSource } from '@forgeax/engine/types';

const packageId = PackageId.parse('f04e8f4a-16b4-4a61-a611-114016aaf006');
if (!packageId.ok) throw new Error('Water R6 packageId is invalid');
export const WATER_R6_PACKAGE = packageId.value;
export const BASINS = ['ripple', 'shallow'] as const;
export type Basin = (typeof BASINS)[number];
export const BASIN_CENTERS = { ripple: -14, shallow: 14 } as const;

/** Explicit texture sampling policy. */
export function fluidRecipe(
  mode: Basin,
  resolution = 128,
  foamEnabled = true,
  terrainMode: WaterFluidSimulationSource['terrainMode'] = mode === 'shallow'
    ? 'water-info'
    : 'constant-depth',
  waveFoam = { resolution: 128, gridExtentM: 24 },
  wavePreset: 'calm' | 'crests' = 'calm',
): WaterFluidSimulationSource & { kind: 'water-simulation-recipe' } {
  const color = (
    channels:
      | 'ripple-height-m'
      | 'shallow-depth-bed-m'
      | 'normal-xz-height-m'
      | 'height-foam-mask'
      | 'wave-foam'
      | 'foam',
    clear: readonly [number, number, number, number],
    address: 'repeat' | 'clamp-to-edge' = 'clamp-to-edge',
  ) => ({
    format: 'rgba16float' as const,
    filter: 'linear' as const,
    address,
    origin: 'top-left' as const,
    channels,
    clear,
  });
  return {
    kind: 'water-simulation-recipe',
    system: 'fluid-simulation',
    configurationVersion: 2,
    solverMode: mode,
    terrainMode,
    resolution: [resolution, resolution],
    virtualFps: 90,
    maxStepsPerFrame: 5,
    gridExtentM: [24, 24],
    waveFoam,
    maxImpulses: 256,
    impulseNoiseGuid: EngineContent.water.textures['impulse-noise'],
    targets: {
      height:
        mode === 'ripple'
          ? color('ripple-height-m', [0, 0, 0, 1])
          : color('shallow-depth-bed-m', [2, -2, 0, 1]),
      velocity: {
        format: 'rg32float',
        filter: 'linear',
        address: 'clamp-to-edge',
        origin: 'top-left',
        channels: 'velocity-xz-m/s',
        clear: [0, 0, 0, 1],
      },
      normalHeight: color('normal-xz-height-m', [0, 0, 0, 1]),
      forces: color('height-foam-mask', [0, 0, 0, 1], 'clamp-to-edge'),
      velocityForces: {
        format: 'rg16float',
        filter: 'linear',
        address: 'clamp-to-edge',
        origin: 'top-left',
        channels: 'velocity-xz-m/s',
        clear: [0, 0, 0, 1],
      },
      wave: color('wave-foam', [0, 0, 0, 1]),
      foam: color('foam', [0, 0, 0, 1]),
    },
    injectionLimits: {
      heightDeltaM: { encodedRange: [-2, 2], unit: 'm' },
      foamStrength: { encodedRange: [0, 4], unit: 'unitless' },
    },
    parameters: {
      travelSpeed: 0.95,
      rippleDamping: 0.012,
      rippleFoamDamping: 0.998,
      rippleFoamErasure: 0.1,
      fluidDampingPerSecond: 0.12,
      gravityMPerSecSquared: 9.8,
      shallowEdgeLengthM: 0.001,
      shallowFadingBackPerSecond: 0.25,
      terrainUseWaterDepthOnly: 0,
      shallowFoamFadePerSecond: 2,
      shallowFoamInjection: 0.5,
      shallowVelocityForFoamMPerSecond: 1.28,
      shallowFoamSlopeMinimum: 0.5,
      shallowFoamSlopeRange: 0.05,
      shallowNormalHeightScale: 1,
      constantWaterDepthM: 2,
      evaporationMPerSecond: 0,
      maskThreshold: 0.5,
      normalHeightScale: 1,
      normalDefaultDepthM: mode === 'ripple' ? 0 : 2,
      normalFoamAmount: 0,
      normalFoamHeightScale: 0,
      normalEdgeFalloff: 0.2,
      waveNormalAmount: 10,
      waveNormalBias: 0,
      waveMinimumHeightM: wavePreset === 'crests' ? 0 : 0.48,
      waveHeightDivisorM: wavePreset === 'crests' ? 0.025 : 0.48,
      waveEdgeFalloff: 0.2,
      waveTimeBiasSeconds: 0,
      foamFadePerFrame: 0,
      foamDiffusion: 0.5,
      foamEdgeFalloff: 0.2,
      foamWetPerMeter: 2,
      foamWetFadePerFrame: 0.001,
      foamToneMapDensity: wavePreset === 'crests' ? 1 : 0.1,
    },
    shallowFoamEnabled: true,
    foamEnabled,
    materialGuids: [],
    textureGuids: [],
  };
}
