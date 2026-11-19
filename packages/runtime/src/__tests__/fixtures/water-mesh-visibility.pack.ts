import { definePack } from '@forgeax/engine-pack/source';
import { ok, type WaterBodySource, type WaterZoneAsset } from '@forgeax/engine-types';
import { buildWaterMaterialFamily, buildWaterPackOutputs } from '@forgeax/engine-water';
import { waterVisibilityGuid, waterVisibilityPackage } from '../water-mesh-visibility.fixture';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: waterVisibilityPackage,
  name: 'WaterMesh visibility fixture',
  async build({ packageId }) {
    const family = buildWaterMaterialFamily(packageId, 'material/water', {
      absorptionPerM: [1.25, 0.08, 0.035],
      scatteringPerM: [0.05, 0.2, 0.3],
      maximumOpticalDistanceM: 30,
    });
    const source: Record<string, WaterBodySource | WaterZoneAsset> = {};
    for (const mode of ['cpu', 'gpu'] as const) {
      source[`zone/${mode}`] = {
        kind: 'water-zone',
        extentM: { spanXM: 16, spanZM: 16 },
        tileSizeM: 2,
        tessellationFactor: 2,
        lodScale: 1,
        waterInfo: {
          resolution: { widthPx: 32, heightPx: 32 },
          format: 'rgba16f',
          blurRadius: 0,
          localTessellation: false,
        },
        ...(mode === 'gpu'
          ? { gpuMesh: { supersampling: 1, msaaSamples: 1, occlusion: 'disabled' } as const }
          : {}),
      };
      source[`body/${mode}`] = {
        kind: 'water-body',
        type: 'lake',
        zoneGuid: waterVisibilityGuid(`zone/${mode}`),
        surfaceMaterialGuid: family.guids.root,
        baseHeightM: 0,
        overlapPriority: 0,
        maxWaveHeightM: 0,
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
        queryFootprint: [
          [-6, -6],
          [6, -6],
          [6, 6],
          [-6, 6],
        ],
        spline: {
          closed: true,
          points: [
            [-6, -6],
            [6, -6],
            [6, 6],
            [-6, 6],
          ].map(([x = 0, z = 0], inputKey) => ({
            inputKey,
            positionM: [x, 0, z] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
            up: [0, 1, 0] as const,
            rollAngle: 0,
            angleUnit: 'degrees' as const,
            widthM: 1,
            depthM: 4,
            velocityMPerSec: 0,
            audioIntensity: 0,
          })),
        },
      };
    }
    const cooked = await buildWaterPackOutputs(source, { packageId });
    if (!cooked.ok) return cooked;
    const material = family.outputs['material/water/root'];
    if (material === undefined) throw new Error('Water visibility material missing');
    return ok({ ...cooked.value, 'material/water/root': material });
  },
});
