import { EngineContent } from '@forgeax/engine/content';
import type { WaterFluidSimulationSource } from '@forgeax/engine/types';
import { COAST_FOAM_CAPTURE } from '../src/identity';

export function oceanFoamRecipe(): WaterFluidSimulationSource & { kind: 'water-simulation-recipe' } {
  const color = (channels: 'ripple-height-m' | 'normal-xz-height-m' | 'height-foam-mask' | 'wave-foam' | 'foam') => ({
    format: 'rgba16float' as const,
    filter: 'linear' as const,
    address: 'clamp-to-edge' as const,
    origin: 'top-left' as const,
    channels,
    clear: [0, 0, 0, 1] as const,
  });
  return {
    kind: 'water-simulation-recipe', system: 'fluid-simulation', configurationVersion: 1,
    solverMode: 'ripple', terrainMode: 'constant-depth', resolution: [64, 64],
    virtualFps: 60, maxStepsPerFrame: 4, gridExtentM: [24, 24],
    waveFoam: { resolution: 256, gridExtentM: COAST_FOAM_CAPTURE.extentM }, maxImpulses: 256,
    impulseNoiseGuid: EngineContent.water.textures['impulse-noise'],
    targets: {
      height: color('ripple-height-m'),
      velocity: { ...color('ripple-height-m'), format: 'rg32float', channels: 'velocity-xz-m/s' },
      normalHeight: color('normal-xz-height-m'), forces: color('height-foam-mask'),
      velocityForces: { ...color('ripple-height-m'), format: 'rg16float', channels: 'velocity-xz-m/s' },
      wave: color('wave-foam'), foam: color('foam'),
    },
    injectionLimits: {
      heightDeltaM: { encodedRange: [-2, 2], unit: 'm' },
      foamStrength: { encodedRange: [0, 4], unit: 'unitless' },
    },
    parameters: {
      travelSpeed: 0.95, rippleDamping: 0.012, rippleFoamDamping: 0.998, rippleFoamErasure: 0.1,
      fluidDampingPerSecond: 0.12, gravityMPerSecSquared: 9.8, shallowEdgeLengthM: 0.001,
      shallowFadingBackPerSecond: 0.25, terrainUseWaterDepthOnly: 0, shallowFoamFadePerSecond: 2,
      shallowFoamInjection: 0.5, shallowVelocityForFoamMPerSecond: 1.28,
      shallowFoamSlopeMinimum: 0.5, shallowFoamSlopeRange: 0.05, shallowNormalHeightScale: 5,
      constantWaterDepthM: 2, evaporationMPerSecond: 0, maskThreshold: 0.5, normalHeightScale: 1,
      normalDefaultDepthM: 0, normalFoamAmount: 0.01, normalFoamHeightScale: 16, normalEdgeFalloff: 0.1,
      waveNormalAmount: 10, waveNormalBias: 0, waveMinimumHeightM: 0.18,
      waveHeightDivisorM: 0.12, waveEdgeFalloff: 0.08, waveTimeBiasSeconds: 0,
      foamFadePerFrame: 0.75, foamDiffusion: 0.25, foamEdgeFalloff: 0.08,
      foamWetPerMeter: 2, foamWetFadePerFrame: 0.001, foamToneMapDensity: 1,
    },
    shallowFoamEnabled: false, foamEnabled: true, materialGuids: [], textureGuids: [],
  };
}
