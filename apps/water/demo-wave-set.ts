import type { WaterWaveSetSource } from '@forgeax/engine/types';

export function demoWaveSetSource(seed = 731): WaterWaveSetSource {
  return {
    kind: 'water-wave-set',
    waveSource: {
      kind: 'generated',
      seed,
      generatorId: 'forgeax.gerstner.simple',
      generatorVersion: '1',
      generatorConfig: {
        count: 5,
        randomness: 0.45,
        wavelengthMinM: 7,
        wavelengthMaxM: 24,
        wavelengthFalloff: 1,
        amplitudeMinM: 0.12,
        amplitudeMaxM: 0.42,
        amplitudeFalloff: 1,
        windAngleDegrees: 28,
        directionAngularSpreadDegrees: 35,
        largeWaveSteepness: 0.12,
        smallWaveSteepness: 0.04,
        steepnessFalloff: 1,
      },
    },
    depthMaskM: 8,
    maxWaveHeightM: 3,
    timeSource: 'scene-clock',
  };
}
