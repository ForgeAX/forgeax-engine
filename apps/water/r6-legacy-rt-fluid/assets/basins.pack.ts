import { EngineContent } from '@forgeax/engine/content';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import {
  Name,
  Transform,
  WaterBodyInstance,
  WaterFluidSimulation,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import {
  type MaterialAsset,
  type MaterialRootAsset,
  ok,
  type SceneAsset,
  type SceneEntity,
  standardSurfaceParameters,
  type WaterBodySource,
} from '@forgeax/engine/types';
import {
  buildWaterPackOutputs,
  cookWaterAsset,
  waterMaterialFamilySlots,
} from '@forgeax/engine/water';
import { presentationGuid } from '../../presentation-identity';
import { terrainPresentation } from '../../terrain-presentation';
import { BASIN_CENTERS, BASINS, fluidRecipe, WATER_R6_PACKAGE } from '../src/identity';

function material(
  color: readonly [number, number, number, number],
  roughness = 0.8,
): MaterialRootAsset {
  return {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: color, roughness },
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
  };
}
const point = (inputKey: number, x: number, z: number) => ({
  inputKey,
  interpolationMode: 'linear' as const,
  positionM: [x, 0, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 1,
  depthM: 3,
  velocityMPerSec: 0,
  audioIntensity: 0,
});

export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R6_PACKAGE,
  name: 'Water R6 Fluid Basins',
  sceneComponents: [
    Name,
    Transform,
    MeshFilter,
    MeshRenderer,
    Terrain,
    WaterTerrainProvider,
    WaterBodyInstance,
    WaterZoneInstance,
    WaterFluidSimulation,
  ],
  async build({ packageId, readByGuid }) {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const waves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.025, steepness: 0.08 },
          { directionXZ: [0.4, 0.9], wavelengthM: 5, amplitudeM: 0.01, steepness: 0.04 },
        ],
      },
      depthMaskM: 1,
      maxWaveHeightM: 0.05,
      timeSource: 'scene-clock',
    }).unwrap();
    const sources: Record<string, WaterBodySource | object> = {
      'zone/basins': {
        kind: 'water-zone',
        extentM: { spanXM: 64, spanZM: 40 },
        tileSizeM: 2,
        tessellationFactor: 7,
        lodScale: 1.8,
        waterInfo: {
          resolution: { widthPx: 256, heightPx: 256 },
          format: 'rgba16f',
          blurRadius: 0,
          localTessellation: false,
        },
      },
    };
    for (const basin of BASINS) {
      const x = BASIN_CENTERS[basin];
      sources[`body/${basin}`] = {
        kind: 'water-body',
        type: 'lake',
        zoneGuid: guid('zone/basins'),
        baseHeightM: 0,
        overlapPriority: 1,
        ...waterMaterialFamilySlots({ guids: EngineContent.water.materials }, 'lake'),
        surfaceMaterialGuid: guid('material/water'),
        lodMaterialGuid: guid('material/water-lod'),
        waveSetGuid: guid('waves/calm'),
        maxWaveHeightM: 2,
        shapeDilationM: 0,
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        queryFootprint: [
          [x - 12, -9],
          [x + 12, -9],
          [x + 12, 9],
          [x - 12, 9],
        ],
        spline: {
          closed: true,
          interpolationVersion: 'water-spline/2',
          points: [
            point(0, x - 12, -9),
            point(1, x + 12, -9),
            point(2, x + 12, 9),
            point(3, x - 12, 9),
          ],
        },
        collision: { type: 'polygon', enabled: true, channelDepthM: 4, collisionHeightOffsetM: 1 },
      } satisfies WaterBodySource;
    }
    const water = await buildWaterPackOutputs(
      sources as Parameters<typeof buildWaterPackOutputs>[0],
      {
        packageId,
        readByGuid: async (requested) =>
          AssetGuid.format(requested).toLowerCase() === guid('waves/calm').toLowerCase()
            ? ok(waves)
            : readByGuid(requested),
      },
    );
    if (!water.ok) return water;
    const columns = 71,
      rows = 43,
      heights = new Float32Array(columns * rows);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const wx = x - 35,
          wz = z - 21,
          center = wx < 0 ? -14 : 14,
          localX = wx - center;
        const boundary = Math.min(12 - Math.abs(localX), 9 - Math.abs(wz));
        const depth = 2.8 - ((localX + 12) / 24) * 2.25;
        const island = 0.75 - Math.hypot(localX - 2.5, wz + 1) * 0.9;
        heights[z * columns + x] = boundary < 0 ? 0.5 : Math.max(-depth, island);
      }
    const terrainSurface = terrainPresentation(guid);
    const floor = {
      ...terrainSurface.rock,
      values: { ...terrainSurface.rock.values, baseColor: [0.48, 0.55, 0.53, 1], roughness: 0.78 },
    };
    const terrain = buildTerrainAssets(
      {
        columns,
        rows,
        spacing: 1,
        subsectionVertices: 8,
        heights,
        weights: new Float32Array(columns * rows).fill(1),
        layers: [{ material: guid('material/floor'), blend: 'weight' }],
      },
      (key) => guid(`terrain/basins/${key}`),
      {
        [guid('material/floor')]: floor,
        ...Object.fromEntries(Object.entries(terrainSurface.textures).map(([key, texture]) => [guid(key), texture])),
      },
    );
    if (!terrain.ok) return terrain;
    const entities: Record<string, SceneEntity> = {
      zone: { components: { Transform: {}, WaterZoneInstance: { zone: guid('zone/basins') } } },
      terrain: {
        components: {
          Transform: { pos: [-35, 0, -21] },
          Terrain: { asset: guid('terrain/basins/terrain') },
          WaterTerrainProvider: { terrain: guid('terrain/basins/terrain') },
        },
      },
    };
    const box = (key: string, color: string, pos: readonly number[], scale: readonly number[]) => {
      entities[key] = {
        components: {
          Transform: { pos, scale },
          MeshFilter: { assetHandle: guid('mesh/box') },
          MeshRenderer: { materials: [guid(`material/${color}`)] },
        },
      };
    };
    for (const basin of BASINS) {
      const x = BASIN_CENTERS[basin];
      entities[basin] = {
        components: {
          Name: { value: basin },
          Transform: {},
          WaterBodyInstance: { body: guid(`body/${basin}`) },
        },
      };
      entities[`fluid-${basin}`] = {
        components: {
          Transform: { pos: [x, 0, 0] },
          WaterFluidSimulation: {
            recipe: guid(`fluid/${basin}`),
            body: basin,
            waveFoamCenterM: [x, 0, 0],
          },
        },
      };
      for (const side of [-1, 1]) {
        box(`${basin}-wall-x${side}`, 'concrete', [x + side * 12.5, 0.45, 0], [1, 1, 20]);
        box(`${basin}-wall-z${side}`, 'concrete', [x, 0.45, side * 9.5], [24, 1, 1]);
        box(`${basin}-coping-x${side}`, 'brass', [x + side * 12.5, 0.97, 0], [1.05, 0.05, 20]);
        box(`${basin}-coping-z${side}`, 'brass', [x, 0.97, side * 9.5], [24, 0.05, 1.05]);
      }
      for (let j = 0; j < 40; j++)
        box(`${basin}-walkway-${j}`, 'wood', [x - 11.7 + j * 0.6, 1.03, -10.3], [0.54, 0.16, 2.2]);
      for (let j = 0; j < 7; j++) {
        box(`${basin}-gauge-${j}`, 'brass', [x - 12, 0.7 + j * 0.18, 0], [0.08, 0.04, 0.65]);
        box(`${basin}-rail-${j}`, 'wood', [x - 11 + j * 3.7, 1.55, -11.2], [0.12, 1.1, 0.12]);
      }
      box(`${basin}-rail`, 'brass', [x, 2.08, -11.2], [24, 0.065, 0.065]);
      box(`${basin}-injector-plinth`, 'brass', [x - 5, 0.4, 0], [0.7, 0.2, 0.7]);
      for (let i = 0; i < 6; i++)
        box(`${basin}-marker${i}`, 'white', [x - 10 + i * 4, 0.99, 9.5], [0.15, 0.03, 0.65]);
      for (const z of [-3, 3])
        box(`${basin}-obstacle${z}`, 'concrete', [x + 2.5, -0.2, z], [1.2, 1.8, 1.2]);
      entities[`injector-${basin}`] = {
        components: {
          Transform: { pos: [x - 5, 0.65, 0], scale: [0.35, 0.35, 0.35] },
          MeshFilter: { assetHandle: guid('mesh/sphere') },
          MeshRenderer: { materials: [guid('material/red')] },
        },
      };
    }
    const waterMaterial = (lod: boolean): MaterialAsset => ({
      kind: 'material',
      parent: EngineContent.water.materials[lod ? 'lake-lod' : 'lake'],
      staticSwitches: {
        waterFluidSimulation: true,
        waterOceanFoam: true,
        waterFoam: true,
        waterWaves: true,
        waterNormalTexture: false,
      },
      values: {
        absorptionPerM: [0.32, 0.09, 0.055],
        scatteringPerM: [0.045, 0.075, 0.065],
        roughness: 0.12,
        fresnelRoughness: 0.28,
        foamRoughness: 0.8,
        foamMaskNearFluid: 0,
        foamScatteringPerM: [1.2, 1.3, 1.25],
        waterAlbedo: [0.65, 0.8, 0.74],
      },
    });
    return ok({
      ...water.value,
      ...terrainSurface.textures,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, value]) => [`terrain/basins/${key}`, value]),
      ),
      'scene/basins': { kind: 'scene', entities } satisfies SceneAsset,
      'waves/calm': waves,
      'fluid/ripple': fluidRecipe('ripple'),
      'fluid/shallow': fluidRecipe('shallow'),
      'material/water': waterMaterial(false),
      'material/water-lod': waterMaterial(true),
      'material/floor': floor,
      'material/concrete': {
        kind: 'material',
        parent: presentationGuid('material/limestone'),
        values: { baseColor: [0.71, 0.7, 0.62, 1] },
      },
      'material/wood': { kind: 'material', parent: presentationGuid('material/wood'), values: {} },
      'material/brass': {
        kind: 'material',
        parent: presentationGuid('material/brass'),
        values: {},
      },
      'material/white': material([0.87, 0.91, 0.86, 1]),
      'material/red': material([0.78, 0.035, 0.05, 1], 0.26),
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': createSphereGeometry(1, 20, 12).unwrap(),
    });
  },
});
