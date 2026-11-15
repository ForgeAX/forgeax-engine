import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { buildWaterPackOutputs } from '@forgeax/engine/water';
import { Materials } from '@forgeax/engine/render';
import { err, ok, standardSurfaceParameters, type Asset, type MaterialAsset, type TerrainSource } from '@forgeax/engine/types';
import { WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE } from '../src/identity';

const guid = (packageId: Parameters<typeof AssetGuid.derive>[0], key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const terrainHeight = (x: number, z: number, revision: 'a' | 'b') => {
  const relativeX = x - 32;
  const relativeZ = z - 32;
  const riverZ = 3.8 * Math.sin(relativeX * 0.075);
  const distance = relativeZ - riverZ;
  const hills = 2.5 + 1.15 * Math.sin(relativeX * 0.085) + 0.8 * Math.cos(relativeZ * 0.11)
    + 0.3 * Math.sin(relativeX * 0.29) * Math.cos(relativeZ * 0.23);
  const channelDepth = revision === 'a' ? 2.1 : 2.65;
  const channel = channelDepth * Math.exp(-(distance * distance) / 13);
  const bend = revision === 'b' ? 0.12 * Math.exp(-((relativeX + 17) ** 2 + (relativeZ - 12) ** 2) / 55) : 0;
  return hills - channel + bend;
};
const riverZ = (x: number) => 3.8 * Math.sin(x * 0.075);
const waterPoint = (inputKey: number, x: number) => {
  const localX = x;
  const localZ = riverZ(x);
  const y = terrainHeight(x + 32, localZ + 32, 'a') + 0.32;
  const tangent = [7.5, 0, (riverZ(x + 0.1) - riverZ(x - 0.1)) * 7.5 / 0.2] as const;
  return {
    inputKey,
    positionM: [localX, y, localZ] as const,
    arriveTangentM: tangent,
    leaveTangentM: tangent,
    up: [0, 1, 0] as const,
    rollAngle: 0,
    angleUnit: 'degrees' as const,
    widthM: 3.8,
    depthM: 1.1,
    velocityMPerSec: 1.3,
    audioIntensity: 0,
  };
};
const layerMaterial = (baseColor: readonly number[], roughness: number): MaterialAsset => ({
  kind: 'material',
  colorSpace: 'linear',
  parameters: standardSurfaceParameters([]),
  values: { baseColor, roughness },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
});
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE,
  name: 'Water Terrain Provider',
  build: async ({ packageId }) => {
    const materialAuthors: Record<string, Asset> = {
      'material/grass': layerMaterial([0.16, 0.34, 0.13, 1], 0.92),
      'material/rock': layerMaterial([0.32, 0.35, 0.32, 1], 0.86),
      'material/river': Materials.unlit('#2797a5'),
    };
    const materialGuid = (key: string) => guid(packageId, key);
    const authorsByGuid = Object.fromEntries(Object.entries(materialAuthors).map(([key, asset]) => [materialGuid(key), asset]));
    const output: Record<string, Asset> = { ...materialAuthors };
    const columns = 61;
    const rows = 61;
    const spacing = 64 / (columns - 1);
    const layers = [materialGuid('material/grass'), materialGuid('material/rock')];

    for (const revision of ['a', 'b'] as const) {
      const heights = new Float32Array(columns * rows);
      const weights = new Float32Array(columns * rows * layers.length);
      for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) {
        const sample = z * columns + x;
        const height = terrainHeight(x * spacing, z * spacing, revision);
        const rock = Math.max(0, Math.min(0.9, (height - 2.25) / 2.2));
        heights[sample] = height;
        weights[sample * 2] = 1 - rock;
        weights[sample * 2 + 1] = rock;
      }
      const source: TerrainSource = {
        columns, rows, spacing, subsectionVertices: 16, heights, weights,
        layers: layers.map((material) => ({ material, blend: 'weight' as const })),
      };
      const sourcePrefix = `terrain/planned-${revision}`;
      const built = buildTerrainAssets(source, (key) => materialGuid(`${sourcePrefix}/${key}`), authorsByGuid);
      if (!built.ok) return built;
      for (const [key, asset] of Object.entries(built.value)) output[`${sourcePrefix}/${key}`] = asset;
    }

    const zoneGuid = materialGuid('zone/main');
    output['zone/main'] = {
      kind: 'water-zone',
      extentM: { spanXM: 64, spanZM: 64 },
      tileSizeM: 16,
      tessellationFactor: 4,
      lodScale: 1,
      waterInfo: { resolution: { widthPx: 256, heightPx: 256 }, format: 'rgba16f', blurRadius: 0, localTessellation: false },
    };
    const water = await buildWaterPackOutputs({
      'body/river': {
        kind: 'water-body', type: 'river', zoneGuid,
        spline: { closed: false, points: [-26, -18.5, -11, -3.5, 4, 11.5, 19, 26.5].map((x, key) => waterPoint(key, x)) },
        baseHeightM: 0, overlapPriority: 0, maxWaveHeightM: 0.08,
        surfaceMaterialGuid: materialGuid('material/river'),
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
        queryFootprint: [[-28, -5], [28, -5], [28, 5], [-28, 5]],
      },
    }, {
      packageId,
      bodyWorldTransformsM: { 'body/river': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1] },
    });
    if (!water.ok) return err(water.error);
    return ok({ ...output, ...water.value });
  },
});
