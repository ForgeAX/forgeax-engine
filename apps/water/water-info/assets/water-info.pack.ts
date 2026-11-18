import { EngineContent } from '@forgeax/engine/content';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { type Asset, err, ok, type TerrainSource } from '@forgeax/engine/types';
import { buildWaterPackOutputs, waterMaterialFamilySlots } from '@forgeax/engine/water';
import { terrainPresentation } from '../../terrain-presentation';
import { WATER_INFO_DEMO_PACKAGE } from '../src/identity';

const riverZ = (x: number) => 4 * Math.sin(x * 0.11);
const groundHeight = (x: number, z: number, revision: 'a' | 'b' = 'a') => {
  const relativeX = x - 32;
  const relativeZ = z - 32;
  const channelDepth = revision === 'a' ? 2.2 : 2.8;
  const bend =
    revision === 'b' ? 0.7 * Math.exp(-((relativeX + 15) ** 2 + (relativeZ - 12) ** 2) / 55) : 0;
  return (
    2 +
    1.1 * Math.sin(x * 0.16) +
    0.65 * Math.cos(z * 0.19) -
    channelDepth * Math.exp(-((relativeZ - riverZ(relativeX)) ** 2) / 17) +
    bend
  );
};
const point = (inputKey: number, x: number) => {
  const z = riverZ(x);
  return {
    inputKey,
    positionM: [x, groundHeight(x + 32, z + 32) + 0.35, z] as const,
    arriveTangentM: [6, 0, 2] as const,
    leaveTangentM: [6, 0, 2] as const,
    rotationQuat: [0, 0, 0, 1] as const,
    up: [0, 1, 0] as const,
    rollAngle: 0,
    angleUnit: 'degrees' as const,
    widthM: 4.5,
    depthM: 1.2,
    velocityMPerSec: 1.25,
    audioIntensity: 0,
  };
};
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_INFO_DEMO_PACKAGE,
  name: 'Water Info R2 Lab',
  build: async ({ packageId }) => {
    const g = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const family = { guids: EngineContent.water.materials };
    const zoneGuid = g('zone/main');
    const columns = 61,
      rows = 61,
      spacing = 64 / 60;
    const scenery = terrainPresentation(g);
    const grass = scenery.grass;
    const terrainAssets: Record<string, Asset> = { 'material/ground': grass, ...scenery.textures };
    for (const revision of ['a', 'b'] as const) {
      const heights = new Float32Array(columns * rows),
        weights = new Float32Array(columns * rows);
      for (let z = 0; z < rows; z++)
        for (let x = 0; x < columns; x++) {
          const index = z * columns + x;
          heights[index] = groundHeight(x * spacing, z * spacing, revision);
          weights[index] = 1;
        }
      const source: TerrainSource = {
        columns,
        rows,
        spacing,
        subsectionVertices: 16,
        heights,
        weights,
        layers: [{ material: g('material/ground'), blend: 'weight' }],
      };
      const prefix = `terrain/planned-${revision}`;
      const built = buildTerrainAssets(source, (key) => g(`${prefix}/${key}`), {
        [g('material/ground')]: grass,
        ...Object.fromEntries(
          Object.entries(scenery.textures).map(([key, value]) => [g(key), value]),
        ),
      });
      if (!built.ok) return err(built.error);
      for (const [key, asset] of Object.entries(built.value))
        terrainAssets[`${prefix}/${key}`] = asset;
    }
    const water = await buildWaterPackOutputs(
      {
        'zone/main': {
          kind: 'water-zone',
          extentM: { spanXM: 64, spanZM: 64 },
          tileSizeM: 8,
          tessellationFactor: 8,
          lodScale: 1.5,
          waterInfo: {
            resolution: { widthPx: 256, heightPx: 256 },
            format: 'rgba16f',
            blurRadius: 2,
            localTessellation: false,
          },
        },
        'body/river': {
          kind: 'water-body',
          type: 'river',
          ...waterMaterialFamilySlots(family, 'river'),
          zoneGuid,
          spline: {
            closed: false,
            interpolationVersion: 'water-spline/2',
            points: [-27, -19, -11, -3, 5, 13, 21, 28].map((x, i) => point(i, x)),
          },
          baseHeightM: 0,
          overlapPriority: 1,
          maxWaveHeightM: 0.08,
          surfaceMaterialGuid: g('material/river'),
          flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
          collision: { type: 'none', enabled: false },
          queryFootprint: [
            [-29, -6],
            [29, -6],
            [29, 6],
            [-29, 6],
          ],
        },
      },
      {
        packageId,
        bodyWorldTransformsM: { 'body/river': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1] },
      },
    );
    if (!water.ok) return err(water.error);
    return ok({
      ...terrainAssets,
      ...water.value,
      'material/river': {
        kind: 'material',
        parent: family.guids.river,
        values: { roughness: 0.16 },
      },
    } as Record<string, Asset>);
  },
});
