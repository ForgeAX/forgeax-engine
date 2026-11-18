import { EngineContent } from '@forgeax/engine/content';
import {
  createBoxGeometry,
  createSphereGeometry,
  createTorusGeometry,
  meshFromInterleaved,
} from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import {
  type MaterialAsset,
  type MaterialRootAsset,
  ok,
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
import { WATER_R3_PACKAGE } from '../src/identity';
import { CLEAR_WATER_MATERIAL_KEYS, CLEAR_WATER_VALUES } from '../src/material-presets';

const point = (inputKey: number, x: number, z: number, widthM = 10) => ({
  inputKey,
  interpolationMode: 'linear' as const,
  positionM: [x, 0, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM,
  depthM: 5,
  velocityMPerSec: 1.6,
  audioIntensity: 1,
});

function standard(
  color: readonly [number, number, number, number],
  roughness = 0.7,
  metallic = 0,
): MaterialRootAsset {
  return {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: color, roughness, metallic },
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R3_PACKAGE,
  name: 'Water R3 Reflection Basin',
  build: async ({ packageId, readByGuid }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const family = { guids: EngineContent.water.materials };
    const waves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [0.8, 0.6], wavelengthM: 8, amplitudeM: 0.12, steepness: 0.08 },
          { directionXZ: [-0.3, 0.953939], wavelengthM: 3.5, amplitudeM: 0.045, steepness: 0.06 },
        ],
      },
      depthMaskM: 2,
      maxWaveHeightM: 0.2,
      timeSource: 'scene-clock',
    });
    if (!waves.ok) return waves;
    const waveSetGuid = guid('waves/basin');
    const zoneGuid = guid('zone/main');
    const customMeshGuid = guid('mesh/custom-surface');
    const customCollisionGuid = guid('mesh/custom-collision');
    const customMesh = meshFromInterleaved(
      new Float32Array([
        -22, 0, -22, 0, 1, 0, 0, 0, 22, 0, -22, 0, 1, 0, 1, 0, 22, 0, 22, 0, 1, 0, 1, 1, -22, 0, 22,
        0, 1, 0, 0, 1,
      ]),
      new Uint16Array([0, 2, 1, 0, 3, 2]),
    ).unwrap();
    const customCollision = createBoxGeometry(44, 10, 44).unwrap();
    const common = {
      kind: 'water-body' as const,
      zoneGuid,
      baseHeightM: 0,
      overlapPriority: 1,
      maxWaveHeightM: 0.2,
      waveSetGuid,
      shapeDilationM: 1,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      queryFootprint: [
        [-22, -22],
        [22, -22],
        [22, 22],
        [-22, 22],
      ] as const,
      underwaterSettings: {
        enabled: true,
        priority: 0,
        blendRadiusM: 1,
        blendWeight: 1,
        maxDepthM: 10,
      },
    };
    const lake: WaterBodySource = {
      ...common,
      type: 'lake',
      ...waterMaterialFamilySlots(family, 'lake'),
      surfaceMaterialGuid: guid('material/clear/lake'),
      lodMaterialGuid: guid('material/clear/lake-lod'),
      spline: {
        closed: true,
        interpolationVersion: 'water-spline/2',
        points: [point(0, -22, -22), point(1, 22, -22), point(2, 22, 22), point(3, -22, 22)],
      },
      collision: { type: 'polygon', enabled: true, channelDepthM: 10 },
    };
    const river: WaterBodySource = {
      ...common,
      type: 'river',
      overlapPriority: 2,
      ...waterMaterialFamilySlots(family, 'river'),
      spline: {
        closed: false,
        interpolationVersion: 'water-spline/2',
        points: [point(0, -22, -9, 28), point(1, 0, 0, 34), point(2, 22, 9, 28)],
      },
      collision: { type: 'river-prism', enabled: true },
    };
    const ocean: WaterBodySource = {
      ...common,
      type: 'ocean',
      overlapPriority: 0,
      ...waterMaterialFamilySlots(family, 'ocean'),
      spline: {
        closed: true,
        interpolationVersion: 'water-spline/2',
        points: [point(0, 60, 60), point(1, 64, 60), point(2, 64, 64), point(3, 60, 64)],
      },
      oceanExtentM: [160, 160],
      centerOnWaterZone: false,
      collision: {
        type: 'polygon',
        enabled: true,
        collisionHalfHeightM: 10,
        collisionHalfExtentsM: [80, 80],
      },
    };
    const custom: WaterBodySource = {
      ...common,
      type: 'custom',
      ...waterMaterialFamilySlots(family, 'custom'),
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      spline: {
        closed: false,
        interpolationVersion: 'water-spline/2',
        points: [point(0, -22, 0), point(1, 22, 0)],
      },
      customMeshOverrideGuid: customMeshGuid,
      collision: { type: 'custom-mesh', enabled: true, meshGuid: customCollisionGuid },
    };
    const terrainSurface = terrainPresentation(guid);
    const terrainMaterials = {
      'material/terrain/stone': terrainSurface.rock,
      'material/terrain/grass': terrainSurface.grass,
    };
    const columns = 61;
    const rows = 61;
    const spacing = 80 / (columns - 1);
    const heights = new Float32Array(columns * rows);
    const weights = new Float32Array(columns * rows * 2);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const worldX = -40 + x * spacing;
        const worldZ = -40 + z * spacing;
        const shore = -16 + 2 * Math.sin(worldZ * 0.14);
        const westBank = Math.max(0, Math.min(1, (shore - worldX) / 7));
        const bank = westBank * westBank * (3 - 2 * westBank);
        const island = 5.2 * Math.exp(-((worldX - 25) ** 2 / 34 + (worldZ + 16) ** 2 / 70));
        const height =
          -4.5 +
          bank *
            (8 +
              0.4 * Math.sin(worldZ * 0.22) +
              0.22 * Math.sin(worldX * 0.71) * Math.cos(worldZ * 0.42)) +
          island;
        const sample = z * columns + x;
        heights[sample] = height;
        const grass = Math.max(0, Math.min(1, (height - 0.15) / 1.6));
        weights[sample * 2] = 1 - grass;
        weights[sample * 2 + 1] = grass;
      }
    const terrain = buildTerrainAssets(
      {
        columns,
        rows,
        spacing,
        subsectionVertices: 16,
        heights,
        weights,
        layers: Object.keys(terrainMaterials).map((key) => ({
          material: guid(key),
          blend: 'weight' as const,
        })),
      },
      (key) => guid(`terrain/coast/${key}`),
      Object.fromEntries(
        Object.entries({ ...terrainMaterials, ...terrainSurface.textures }).map(([key, asset]) => [
          guid(key),
          asset,
        ]),
      ),
    );
    if (!terrain.ok) return terrain;
    const bodies = await buildWaterPackOutputs(
      {
        'zone/main': {
          kind: 'water-zone',
          extentM: { spanXM: 80, spanZM: 80 },
          tileSizeM: 4,
          tessellationFactor: 7,
          lodScale: 1.6,
          waterInfo: {
            resolution: { widthPx: 256, heightPx: 256 },
            format: 'rgba16f',
            blurRadius: 1,
            localTessellation: false,
          },
        },
        'body/lake': lake,
        'body/lake-peer': lake,
        'body/river': river,
        'body/ocean': ocean,
        'body/custom': custom,
      },
      {
        packageId,
        readByGuid: async (requested) => {
          const key = AssetGuid.format(requested).toLowerCase();
          if (key === waveSetGuid.toLowerCase()) return ok(waves.value);
          if (key === customMeshGuid.toLowerCase()) return ok(customMesh);
          if (key === customCollisionGuid.toLowerCase()) return ok(customCollision);
          return readByGuid(requested);
        },
      },
    );
    if (!bodies.ok) return bodies;
    const independent = Object.fromEntries(
      (['lake', 'river', 'ocean', 'custom'] as const).map((type) => [
        `material/independent/${type}`,
        { kind: 'material', parent: family.guids[type], values: {} } satisfies MaterialAsset,
      ]),
    );
    const clear = Object.fromEntries(
      CLEAR_WATER_MATERIAL_KEYS.map((key) => [
        `material/clear/${key}`,
        {
          kind: 'material',
          parent: family.guids[key],
          values: CLEAR_WATER_VALUES,
        } satisfies MaterialAsset,
      ]),
    );
    return ok({
      ...bodies.value,
      ...terrainMaterials,
      ...terrainSurface.textures,
      ...independent,
      ...clear,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, asset]) => [`terrain/coast/${key}`, asset]),
      ),
      'waves/basin': waves.value,
      'mesh/custom-surface': customMesh,
      'mesh/custom-collision': customCollision,
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': createSphereGeometry(1, 36, 24).unwrap(),
      'mesh/ring': createTorusGeometry(1, 0.16, 16, 64).unwrap(),
      'material/ground': standard([0.58, 0.66, 0.62, 1], 0.92),
      'material/stone': {
        kind: 'material',
        parent: presentationGuid('material/rock'),
        values: { baseColor: [0.3, 0.38, 0.36, 1] },
      },
      'material/pier': { kind: 'material', parent: presentationGuid('material/wood'), values: {} },
      'material/red': standard([0.8, 0.045, 0.035, 1], 0.28),
      'material/yellow': standard([0.95, 0.62, 0.035, 1], 0.3),
      'material/teal': standard([0.025, 0.55, 0.48, 1], 0.25),
      'material/white': standard([0.9, 0.93, 0.92, 1], 0.25),
      'material/mirror': standard([0.7, 0.75, 0.78, 1], 0.08, 0.95),
      'material/standard-surface': {
        ...standard([0.12, 0.42, 0.31, 1], 0.22),
        surface: { model: 'standard', module: 'forgeax_material::default_standard_surface' },
      },
      'material/medium-surface': {
        kind: 'material',
        colorSpace: 'linear',
        surface: {
          model: 'single-layer-medium',
          module: 'forgeax_material::default_single_layer_medium_surface',
        },
        passes: [
          {
            name: 'forward',
            program: { module: 'forgeax::single-layer-medium' },
            renderState: {
              tags: { LightMode: 'Forward' },
              queue: 2000,
              cullMode: 'none',
              depthWriteEnabled: true,
            },
          },
        ],
      },
      'material/custom-baked': {
        kind: 'material',
        parent: family.guids.custom,
        staticSwitches: {
          waterBakedSimulation: true,
          waterFixedHeight: false,
          waterFixedDepth: false,
        },
      },
      'material/custom-baked-underwater': {
        kind: 'material',
        parent: family.guids['custom-underwater'],
        staticSwitches: {
          waterBakedSimulation: true,
          waterFixedHeight: false,
          waterFixedDepth: false,
        },
      },
    });
  },
});
