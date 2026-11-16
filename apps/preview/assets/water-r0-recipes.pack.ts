import { definePack } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { surfaceEvidenceGuid, WATER_R0_RECIPE_PACKAGE_NAMESPACE, waterR0TerrainGuid } from '../src/surface-standard-evidence-identity';

const packageId = WATER_R0_RECIPE_PACKAGE_NAMESPACE;
const riverGuid = surfaceEvidenceGuid('river/main');
const calm = {
  kind: 'water-wave-set' as const,
  waveSource: { kind: 'predefined' as const, waves: [
    { directionXZ: [1, 0] as const, wavelengthM: 8, amplitudeM: 0.25, steepness: 0.2 },
    { directionXZ: [0.8, 0.6] as const, wavelengthM: 4, amplitudeM: 0.1, steepness: 0.1 },
  ] },
  depthMaskM: 3,
  maxWaveHeightM: 0.35,
  timeSource: 'scene-clock' as const,
};
const windy = {
  kind: 'water-wave-set' as const,
  waveSource: { kind: 'predefined' as const, waves: [
    { directionXZ: [0, 1] as const, wavelengthM: 14, amplitudeM: 0.8, steepness: 0.55 },
    { directionXZ: [-0.6, 0.8] as const, wavelengthM: 7, amplitudeM: 0.3, steepness: 0.3 },
  ] },
  depthMaskM: 5,
  maxWaveHeightM: 1.1,
  timeSource: 'fixed-step' as const,
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Water R0 wave and terrain brush recipes',
  build: () => ok({
    'water/wave-set/calm': calm,
    'water/wave-set/windy': windy,
    'water/brush/river': {
      kind: 'water-brush-recipe' as const,
      baseTerrainGuid: waterR0TerrainGuid('terrain/base'),
      sourceBodyGuids: [riverGuid],
      orderedActors: ['river/main'],
      terrainCapture: {
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        boundsXZ: { minM: [-0.5, -0.5], maxM: [7.5, 7.5] },
        resolutionPx: [8, 8],
        layerNameToIndex: { water: 0 },
      },
      curves: [],
      textures: [],
      outputTerrainSourceKey: 'water/terrain/river-derived',
      rules: {
        falloff: { type: 'smooth', widthM: 2, strength: 1 },
        blend: { type: 'alpha', alpha: 0.8 },
        heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
        weightRules: { layer: 'water', value: 1, blend: 'replace' },
      },
    },
  }),
});
