import { definePack } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { buildWaterPackOutputs } from '@forgeax/engine/water';
import { standardWaterMaterial } from '../../standard-water-material';
import { r0Guid, WATER_R0_PACKAGE } from '../src/identity';

const point = (inputKey: number, x: number, z: number) => ({
  inputKey,
  positionM: [x, 0, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 3,
  depthM: 2,
  velocityMPerSec: 1,
  audioIntensity: 0,
  interpolationMode: 'linear' as const,
});
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R0_PACKAGE,
  name: 'R0 Scene foundation',
  build: async ({ packageId }) => {
    const material = r0Guid('material/support');
    const common = {
      kind: 'water-body' as const,
      zoneGuid: r0Guid('zone/main'),
      baseHeightM: 0,
      overlapPriority: 0,
      maxWaveHeightM: 0,
      surfaceMaterialGuid: material,
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
      queryFootprint: [
        [-4, -3],
        [4, -3],
        [4, 3],
        [-4, 3],
      ],
    };
    const built = await buildWaterPackOutputs(
      {
        'body/river': {
          ...common,
          type: 'river',
          spline: { closed: false, points: [point(0, -4, -1), point(1, 0, 1), point(2, 4, 0)] },
        },
        'body/lake': {
          ...common,
          type: 'lake',
          spline: {
            closed: true,
            points: [point(0, -3.8, -1.5), point(1, -1, -3), point(2, 2.4, -2.6), point(3, 3.9, 0.2), point(4, 2, 2.8), point(5, -2.4, 2.4)],
          },
          queryFootprint: [[-3.8, -1.5], [-1, -3], [2.4, -2.6], [3.9, 0.2], [2, 2.8], [-2.4, 2.4]],
        },
        'body/ocean': {
          ...common,
          type: 'ocean',
          spline: {
            closed: true,
            points: [point(0, -1, -1), point(1, 1, -1), point(2, 1, 1), point(3, -1, 1)],
          },
          oceanExtentM: [8, 6],
          centerOnWaterZone: false,
        },
        'body/custom': {
          ...common,
          type: 'custom',
          spline: { closed: false, points: [point(0, -4, 0), point(1, 4, 0)] },
          queryFootprint: [[-3.8, -2.7], [0.5, -2.7], [0.5, -0.4], [3.8, -0.4], [3.8, 2.7], [-3.8, 2.7]],
        },
      },
      { packageId },
    );
    if (!built.ok) return built;
    return ok({
      ...built.value,
      'material/support': standardWaterMaterial([0.08, 0.3, 0.28, 1], 0.6),
      'zone/main': {
        kind: 'water-zone' as const,
        extentM: { spanXM: 96, spanZM: 64 },
        tileSizeM: 8,
        tessellationFactor: 4,
        lodScale: 1,
        waterInfo: {
          resolution: { widthPx: 128, heightPx: 128 },
          format: 'rgba16f' as const,
          blurRadius: 0,
          localTessellation: false,
        },
      },
    });
  },
});
