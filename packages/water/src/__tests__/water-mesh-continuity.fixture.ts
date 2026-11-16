import type { WaterMeshBuildInput } from '../water-mesh.js';
export function continuityInput(enabled = true): WaterMeshBuildInput {
  return {
    zoneGuid: 'zone',
    zoneGeneration: 3,
    originXZ: [0, 0],
    extentM: [16, 16],
    tileSizeM: 16,
    tessellationFactor: 3,
    lodScale: 1,
    bodies: [
      {
        guid: 'ocean',
        generation: 5,
        type: 'ocean',
        visible: true,
        affectsWaterMesh: true,
        priority: 0,
        materialKey: 'ocean',
        waveOriginXZ: [123, -35],
        baseHeightM: 0,
        maxWaveHeightM: 1,
        polygon: {
          outer: [
            [0, 0],
            [16, 0],
            [16, 16],
            [0, 16],
          ],
        },
      },
      {
        guid: 'river',
        generation: 7,
        type: 'river',
        visible: true,
        affectsWaterMesh: true,
        priority: 1,
        materialKey: 'river',
        transitionMaterials: { ocean: 'river-ocean' },
        waveOriginXZ: [0, 0],
        baseHeightM: 30,
        maxWaveHeightM: 1,
        ...(enabled
          ? { transitionContinuity: { centerXZ: [8, 8] as const, reachM: 7, blendWidthM: 2 } }
          : {}),
        polygon: {
          outer: [
            [0, 4],
            [12, 4],
            [12, 12],
            [0, 12],
          ],
        },
      },
    ],
  };
}
