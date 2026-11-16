import { EngineContent } from '@forgeax/engine/content';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { err, ok } from '@forgeax/engine/types';
import {
  buildWaterPackOutputs,
  cookWaterAsset,
  waterMaterialFamilySlots,
} from '@forgeax/engine/water';
import { demoWaveSetSource } from '../../demo-wave-set';
import { requireDemoValue } from '../../runtime-input';
import { WAVES_PACKAGE_NAMESPACE } from '../src/identity';

const assetGuid = (packageId: Parameters<typeof AssetGuid.derive>[0], key: string) =>
  AssetGuid.format(AssetGuid.derive(packageId, key));
const waveOrigin = [31453.28, 10484.76] as const;
const waveOriginMatrix = [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  waveOrigin[0],
  0,
  waveOrigin[1],
  1,
] as const;
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WAVES_PACKAGE_NAMESPACE,
  name: 'Gerstner Waves',
  build: async ({ packageId }) => {
    const family = { guids: EngineContent.water.materials };
    const zoneGuid = assetGuid(packageId, 'zone/ocean');
    const waveSetGuid = assetGuid(packageId, 'waves/seed-731-v1');
    const materialGuid = assetGuid(packageId, 'material/ocean');
    const body = {
      kind: 'water-body' as const,
      type: 'lake' as const,
      ...waterMaterialFamilySlots(family, 'lake'),
      zoneGuid,
      waveSetGuid,
      spline: {
        closed: true,
        points: [
          [-48, -48],
          [48, -48],
          [48, 48],
          [-48, 48],
        ].map(([x, z], inputKey) => ({
          inputKey,
          positionM: [x, 0, z] as const,
          arriveTangentM: [0, 0, 0] as const,
          leaveTangentM: [0, 0, 0] as const,
          up: [0, 1, 0] as const,
          rollAngle: 0,
          angleUnit: 'degrees' as const,
          widthM: 1,
          depthM: requireDemoValue([1, 4, 8, 12][inputKey], 'wave corner depth'),
          velocityMPerSec: 0,
          audioIntensity: 0,
          interpolationMode: 'linear' as const,
          rotationQuat: [0, 0, 0, 1] as const,
        })),
      },
      baseHeightM: 0,
      overlapPriority: 0,
      maxWaveHeightM: 3,
      surfaceMaterialGuid: materialGuid,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
      queryFootprint: [
        [-48, -48],
        [48, -48],
        [48, 48],
        [-48, 48],
      ],
    };
    const cookedWaves = cookWaterAsset(demoWaveSetSource());
    if (!cookedWaves.ok) return cookedWaves;
    const water = await buildWaterPackOutputs(
      { 'body/ocean': body },
      {
        packageId,
        bodyWorldTransformsM: { 'body/ocean': waveOriginMatrix },
        readByGuid: async (requested) =>
          AssetGuid.format(requested).toLowerCase() === waveSetGuid.toLowerCase()
            ? ok(cookedWaves.value)
            : err(new Error(`Unexpected Pack dependency ${requested}`)),
      },
    );
    if (!water.ok) return water;
    return ok({
      ...water.value,
      'zone/ocean': {
        kind: 'water-zone' as const,
        extentM: { spanXM: 96, spanZM: 96 },
        tileSizeM: 16,
        tessellationFactor: 4,
        lodScale: 1,
        waterInfo: {
          resolution: { widthPx: 256, heightPx: 256 },
          format: 'rgba16f' as const,
          blurRadius: 0,
          localTessellation: false,
        },
      },
      'waves/seed-731-v1': cookedWaves.value,
      'material/ocean': {
        kind: 'material',
        parent: family.guids.lake,
        values: { roughness: 0.12 },
      },
    });
  },
});
