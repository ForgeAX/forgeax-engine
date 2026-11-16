import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { buildWaterPackOutputs, cookWaterAsset } from '@forgeax/engine/water';
import { err, ok, standardSurfaceParameters, type Asset, type TerrainSource } from '@forgeax/engine/types';
import { BODY_QUERY_PACKAGE_NAMESPACE } from '../src/identity';
import { demoWaveSetSource } from '../../demo-wave-set';
import { standardWaterMaterial } from '../../standard-water-material';

const guid = (packageId: Parameters<typeof AssetGuid.derive>[0], key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const point = (key: number, x: number, z: number) => ({ inputKey: key, positionM: [x, 0, z] as const, arriveTangentM: [0, 0, 0] as const, leaveTangentM: [0, 0, 0] as const, up: [0, 1, 0] as const, rollAngle: 0, angleUnit: 'degrees' as const, widthM: 1, depthM: 3, velocityMPerSec: 0, audioIntensity: 0, interpolationMode: 'linear' as const, rotationQuat: [0, 0, 0, 1] as const });

export default definePack({
  schemaVersion: '2.0.0', packageId: BODY_QUERY_PACKAGE_NAMESPACE, name: 'Water Body Query',
  build: async ({ packageId }) => {
    const zoneGuids = { lower: guid(packageId, 'zone/lower'), upper: guid(packageId, 'zone/upper') };
    const materialGuids = { lower: guid(packageId, 'material/lake'), upper: guid(packageId, 'material/ocean'), grass: guid(packageId, 'material/grass') };
    const waveSetGuid = guid(packageId, 'waves/seed-731-v1');
    const cookedWaves = cookWaterAsset(demoWaveSetSource());
    if (!cookedWaves.ok) return cookedWaves;
    const bodies = {
      'body/lower-lake': { kind: 'water-body' as const, type: 'lake' as const, zoneGuid: zoneGuids.lower, waveSetGuid, spline: { closed: true, points: [point(0, -18, -18), point(1, 18, -18), point(2, 18, 18), point(3, -18, 18)] }, baseHeightM: 0, overlapPriority: 1, maxWaveHeightM: 3, surfaceMaterialGuid: materialGuids.lower, flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false }, collision: { type: 'none' as const, enabled: false }, queryFootprint: [[-18, -18], [18, -18], [18, 18], [-18, 18]] },
      'body/upper-ocean': { kind: 'water-body' as const, type: 'ocean' as const, zoneGuid: zoneGuids.upper, waveSetGuid, spline: { closed: true, points: [point(0, -1, -1), point(1, 1, -1), point(2, 1, 1), point(3, -1, 1)] }, baseHeightM: 0, overlapPriority: 2, maxWaveHeightM: 3, surfaceMaterialGuid: materialGuids.upper, flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false }, collision: { type: 'none' as const, enabled: false }, queryFootprint: [[-18, -18], [18, -18], [18, 18], [-18, 18]], oceanExtentM: [36, 36] as const, centerOnWaterZone: false },
    };
    const water = await buildWaterPackOutputs(bodies, {
      packageId,
      readByGuid: async (requested) => AssetGuid.format(requested).toLowerCase() === waveSetGuid.toLowerCase()
        ? ok(cookedWaves.value)
        : err(new Error(`Unexpected Pack dependency ${requested}`)),
    });
    if (!water.ok) return water;
    const grass: Asset = { kind: 'material', colorSpace: 'linear', parameters: standardSurfaceParameters([]), values: { baseColor: [0.23, 0.34, 0.19, 1], roughness: 0.95 }, passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }] };
    const authors: Record<string, Asset> = { [materialGuids.grass]: grass };
    const terrainGuid = (key: string) => guid(packageId, `terrain/${key}`);
    const layers = [materialGuids.grass];
    const columns = 31, rows = 31, spacing = 48 / (31 - 1);
    const heights = new Float32Array(columns * rows), weights = new Float32Array(columns * rows);
    for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) {
      heights[z * columns + x] = -2.1 + 0.18 * Math.sin(x * 0.42) * Math.cos(z * 0.38);
      weights[z * columns + x] = 1;
    }
    const terrainSource: TerrainSource = { columns, rows, spacing, subsectionVertices: 16, heights, weights, layers: layers.map((material) => ({ material, blend: 'weight' as const })) };
    const terrainAssets = buildTerrainAssets(terrainSource, (key) => terrainGuid(key), authors);
    if (!terrainAssets.ok) return terrainAssets;
    return ok({
      ...water.value,
      'waves/seed-731-v1': cookedWaves.value,
      'zone/lower': { kind: 'water-zone' as const, extentM: { spanXM: 48, spanZM: 48 }, tileSizeM: 8, tessellationFactor: 4, lodScale: 1, waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f' as const, blurRadius: 0, localTessellation: false } },
      'zone/upper': { kind: 'water-zone' as const, extentM: { spanXM: 48, spanZM: 48 }, tileSizeM: 8, tessellationFactor: 4, lodScale: 1, waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f' as const, blurRadius: 0, localTessellation: false } },
      'material/lake': standardWaterMaterial([0.04, 0.3, 0.19, 1], 0.18), 'material/ocean': standardWaterMaterial([0.025, 0.18, 0.32, 1], 0.12), 'material/grass': grass,
      ...Object.fromEntries(Object.entries(terrainAssets.value).map(([key, asset]) => [`terrain/${key}`, asset])),
    });
  },
});
