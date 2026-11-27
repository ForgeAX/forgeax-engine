import { EngineContent } from '@forgeax/engine/content';
import {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createSphereGeometry,
} from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { Collider, RigidBody } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import {
  ChildOf,
  Name,
  Transform,
  WaterBodyInstance,
  WaterPontoonSet,
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
import { harborHull } from '../../harbor-assets';
import { presentationGuid } from '../../presentation-identity';
import {
  COAST_FOAM_TILING_M,
  coastFoamTextures,
} from '../../r8-integration-acceptance/assets/foam-textures';
import { terrainPresentation } from '../../terrain-presentation';
import { CRAFTS, pontoonLayout, START_POSITIONS, WATER_R5_PACKAGE } from '../src/identity';

function material(
  color: readonly [number, number, number, number],
  roughness = 0.6,
  metallic = 0,
): MaterialRootAsset {
  return {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: color, roughness, metallic },
    passes: [
      {
        name: 'deferred',
        program: { module: 'forgeax_material::standard', fragmentEntry: 'fs_gbuffer' },
        renderState: { tags: { LightMode: 'Deferred' }, queue: 2000 },
      },
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
  };
}
const point = (key: number, x: number, z: number, y = 0, width = 13) => ({
  inputKey: key,
  interpolationMode: 'linear' as const,
  positionM: [x, y, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: width,
  depthM: 5,
  velocityMPerSec: 1.3,
  audioIntensity: 1,
});
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R5_PACKAGE,
  name: 'Water R5 Estuary',
  sceneComponents: [
    Name,
    Transform,
    ChildOf,
    MeshFilter,
    MeshRenderer,
    Visibility,
    RigidBody,
    Collider,
    WaterPontoonSet,
    WaterBodyInstance,
    WaterZoneInstance,
    Terrain,
    WaterTerrainProvider,
  ],
  build: async ({ packageId, readByGuid }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const waves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [0.8, 0.6], wavelengthM: 18, amplitudeM: 0.09, steepness: 0.035 },
          { directionXZ: [0.6, 0.8], wavelengthM: 13, amplitudeM: 0.055, steepness: 0.025 },
          { directionXZ: [0.95, 0.31225], wavelengthM: 9, amplitudeM: 0.032, steepness: 0.018 },
          { directionXZ: [0.35, 0.93675], wavelengthM: 6.5, amplitudeM: 0.018, steepness: 0.012 },
          { directionXZ: [-0.2, 0.9798], wavelengthM: 4.8, amplitudeM: 0.008, steepness: 0.008 },
        ],
      },
      depthMaskM: 0.12,
      maxWaveHeightM: 0.23,
      timeSource: 'scene-clock',
    }).unwrap();
    const off = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM: 10, amplitudeM: 0, steepness: 0 }],
      },
      depthMaskM: 3,
      maxWaveHeightM: 0,
      timeSource: 'scene-clock',
    }).unwrap();
    const family = { guids: EngineContent.water.materials },
      zoneGuid = guid('zone/estuary');
    const common = {
      kind: 'water-body' as const,
      zoneGuid,
      baseHeightM: 0,
      overlapPriority: 1,
      maxWaveHeightM: 0.32,
      waveSetGuid: guid('waves/off'),
      shapeDilationM: 1,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      queryFootprint: [
        [-120, -100],
        [120, -100],
        [120, 100],
        [-120, 100],
      ] as const,
      underwaterSettings: {
        enabled: true,
        priority: 0,
        blendRadiusM: 1,
        blendWeight: 1,
        maxDepthM: 12,
      },
    };
    const river: WaterBodySource = {
      ...common,
      type: 'river',
      overlapPriority: 3,
      ...waterMaterialFamilySlots(family, 'river'),
      surfaceMaterialGuid: guid('material/water/river'),
      lodMaterialGuid: guid('material/water/river-lod'),
      riverToLakeTransitionMaterialGuid: guid('material/water/river'),
      riverToOceanTransitionMaterialGuid: guid('material/water/river'),
      spline: {
        closed: false,
        interpolationVersion: 'water-spline/2',
        points: [
          // This tidal reach shares the harbor's mean level. Terrain owns its visible width.
          point(0, -91, -22, common.baseHeightM, 24),
          point(1, -63, -15, common.baseHeightM, 24),
          point(2, -37, -4, common.baseHeightM, 26),
          point(3, -15, 0, common.baseHeightM, 26),
        ],
      },
      collision: { type: 'river-prism', enabled: true, collisionGroups: 0x0002ffff },
    };
    const lake: WaterBodySource = {
      ...common,
      type: 'lake',
      // This open harbor shares the Ocean's mean level; no dam separates them.
      overlapPriority: 2,
      ...waterMaterialFamilySlots(family, 'lake'),
      surfaceMaterialGuid: guid('material/water/lake'),
      lodMaterialGuid: guid('material/water/lake-lod'),
      spline: {
        closed: true,
        interpolationVersion: 'water-spline/2',
        // The whole tidal reach intersects the harbor, retaining River flow
        // while transition tiles use one incident wave field. Dry land hides the bounds.
        points: [point(0, -110, -45), point(1, 36, -45), point(2, 36, 45), point(3, -110, 45)],
      },
      collision: {
        type: 'polygon',
        enabled: true,
        channelDepthM: 10,
        collisionHeightOffsetM: 2,
        collisionGroups: 0x0002ffff,
      },
    };
    const ocean: WaterBodySource = {
      ...common,
      type: 'ocean',
      overlapPriority: 0,
      ...waterMaterialFamilySlots(family, 'ocean'),
      surfaceMaterialGuid: guid('material/water/ocean'),
      lodMaterialGuid: guid('material/water/ocean-lod'),
      oceanExtentM: [240, 200],
      centerOnWaterZone: false,
      spline: {
        closed: true,
        interpolationVersion: 'water-spline/2',
        points: [
          // Keep the exclusion edge below dry land, behind the actual coast.
          point(0, -115, -95),
          point(1, 15, -95),
          point(2, 15, 95),
          point(3, -115, 95),
        ],
      },
      collision: {
        type: 'polygon',
        enabled: true,
        collisionHalfHeightM: 12,
        collisionHeightOffsetM: 2,
        collisionHalfExtentsM: [120, 100],
        collisionGroups: 0x0002ffff,
      },
    };
    const custom: WaterBodySource = {
      ...common,
      type: 'custom',
      ...waterMaterialFamilySlots(family, 'custom'),
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      renderOptions: { visible: false, castShadow: false, receiveShadow: false },
      spline: {
        closed: false,
        interpolationVersion: 'water-spline/2',
        points: [point(0, 0, 0, 0.7, 5), point(1, 8, 0, 1.8, 5)],
      },
      collision: {
        type: 'polygon',
        enabled: true,
        points: [
          [-3, -4],
          [12, -4],
          [12, 4],
          [-3, 4],
        ],
        collisionGroups: 0x0002ffff,
      },
    };
    const probes = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `body/probe-${index}`,
        {
          ...lake,
          overlapPriority: index,
          flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
          collision: { ...lake.collision, enabled: false },
        },
      ]),
    );
    const water = await buildWaterPackOutputs(
      {
        'zone/estuary': {
          kind: 'water-zone',
          extentM: { spanXM: 192, spanZM: 160 },
          tileSizeM: 3,
          tessellationFactor: 5,
          lodScale: 2.4,
          gpuMesh: { supersampling: 2, msaaSamples: 4, occlusion: 'disabled' },
          waterInfo: {
            resolution: { widthPx: 256, heightPx: 256 },
            // Keep the mapped River mean plane coincident with the flat harbor.
            format: 'rgba32f',
            blurRadius: 1,
            localTessellation: false,
          },
        },
        'body/river': river,
        'body/lake': lake,
        'body/ocean': ocean,
        'body/custom': custom,
        ...probes,
      },
      {
        packageId,
        readByGuid: async (requested) =>
          AssetGuid.format(requested).toLowerCase() === guid('waves/estuary').toLowerCase()
            ? ok(waves)
            : AssetGuid.format(requested).toLowerCase() === guid('waves/off').toLowerCase()
              ? ok(off)
              : readByGuid(requested),
      },
    );
    if (!water.ok) return water;
    const detail = terrainPresentation(guid);
    const terrainMaterials = {
      'material/silt': detail.shore,
      'material/grass': detail.grass,
    };
    const sampleEstuaryTerrain = () => {
      const columns = 106,
        rows = 91,
        spacing = 2,
        heights = new Float32Array(columns * rows),
        weights = new Float32Array(columns * rows * 2);
      for (let z = 0; z < rows; z++)
        for (let x = 0; x < columns; x++) {
          const wx = -96 + x * spacing,
            wz = -80 + z * spacing;
          const riverZ =
            wx < -63
              ? -15 + (wx + 63) * 0.25
              : wx < -37
                ? -4 + ((wx + 37) * 11) / 26
                : ((wx + 15) * 4) / 22;
          const riverBank = (Math.abs(wz - riverZ) - 6.5) / 4;
          const lakeBank = (Math.sqrt(((wx + 2) / 27) ** 2 + (wz / 24) ** 2) - 1) * 5;
          const coast = (25 + 2 * Math.sin(wz * 0.1) - wx) / 7;
          const shore = Math.max(
            0,
            Math.min(1, Math.min(wx < -15 ? riverBank : 10, lakeBank, coast)),
          );
          const hill =
            1.3 +
            1.6 * Math.sin(wx * 0.05) ** 2 * Math.cos(wz * 0.045) ** 2 +
            0.25 * Math.sin(wx * 0.6 + wz * 0.35);
          const y = -4.5 + shore * shore * (3 - 2 * shore) * (4.5 + hill),
            i = z * columns + x;
          heights[i] = y;
          const grass = Math.max(0, Math.min(1, (y - 0.2) / 1.6));
          weights[i * 2] = 1 - grass;
          weights[i * 2 + 1] = grass;
        }
      return { columns, rows, spacing, heights, weights };
    };
    const { columns, rows, spacing, heights, weights } = sampleEstuaryTerrain();
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
      (key) => guid(`terrain/estuary/${key}`),
      Object.fromEntries(
        Object.entries({ ...terrainMaterials, ...detail.textures }).map(([key, value]) => [
          guid(key),
          value,
        ]),
      ),
    );
    if (!terrain.ok) return terrain;
    const entities: Record<string, SceneEntity> = {};
    const mesh = (
      key: string,
      shape: string,
      color: string,
      pos: readonly number[],
      scale: readonly number[],
      parent?: string,
    ) => {
      entities[key] = {
        components: {
          Transform: { pos, scale },
          MeshFilter: { assetHandle: guid(`mesh/${shape}`) },
          MeshRenderer: { materials: [guid(`material/${color}`)] },
          ...(parent ? { ChildOf: { parent } } : {}),
        },
      };
    };
    const authorCrafts = () => {
      for (const type of CRAFTS) {
        const anchors = pontoonLayout(type === 'river' ? 4 : 16),
          key = `${type}-craft`,
          color = type === 'river' ? 'red' : type === 'lake' ? 'white' : 'ochre';
        entities[key] = {
          components: {
            Name: { value: key },
            Transform: { pos: START_POSITIONS[type] },
            RigidBody: {
              type: 1,
              mass: 125,
              linearDamping: 0.025,
              angularDamping: 0.04,
              ccdEnabled: true,
            },
            Collider: {
              shape: 5,
              mesh: guid('mesh/collider'),
              density: 1,
              collisionGroups: 0x0001ffff,
            },
            WaterPontoonSet: {
              configurationVersion: 1,
              useAsyncPath: true,
              anchorMode: type === 'ocean' ? 1 : 0,
              anchorsM:
                type === 'ocean'
                  ? anchors.flatMap(() => [0, 0, 0])
                  : anchors.flatMap((p) => [...p]),
              radiiM: anchors.map(() => 0.8),
              socketEntities: type === 'ocean' ? anchors.map((_, i) => `${key}-socket-${i}`) : [],
              buoyancyCoefficientNPerM3: 1200,
              riverShoreFactor: 0,
              riverTraversalPathWidthM: 2,
              alwaysAllowLateralPush: true,
              overlapFilterMask: 0xffff0002,
            },
          },
        };
        entities[`${key}-cargo`] = {
          components: {
            Transform: { pos: [-0.9, 0.95, 0], scale: [0.5, 0.36, 0.5] },
            ChildOf: { parent: key },
            MeshFilter: { assetHandle: guid('mesh/box') },
            MeshRenderer: { materials: [guid('material/wood')] },
            Visibility: { state: VisibilityStateValue.hidden },
          },
        };
        mesh(`${key}-hull`, 'hull', color, [0, 0.35, 0], [1, 1, 1], key);
        mesh(`${key}-deck`, 'box', 'wood', [-0.2, 0.7, 0], [3.4, 0.14, 1.6], key);
        mesh(`${key}-cabin`, 'box', color, [-0.65, 1.12, 0], [1.3, 0.72, 1.08], key);
        mesh(`${key}-window`, 'box', 'glass', [-0.65, 1.18, -0.55], [0.95, 0.32, 0.03], key);
        mesh(`${key}-roof`, 'box', 'wood', [-0.65, 1.52, 0], [1.48, 0.12, 1.2], key);
        for (const x of [-1.07, -0.61, -0.15])
          for (const side of [-1, 1])
            mesh(
              `${key}-window-frame-${x}-${side}`,
              'box',
              'metal',
              [x, 1.2, side * 0.57],
              [0.035, 0.35, 0.03],
              key,
            );
        for (let plank = 0; plank < 15; plank++)
          mesh(
            `${key}-deck-plank-${plank}`,
            'box',
            'wood',
            [-1.75 + plank * 0.235, 0.8, 0],
            [0.215, 0.04, 1.53],
            key,
          );
        for (const side of [-1, 1]) {
          mesh(
            `${key}-gunwale-${side}`,
            'box',
            'wood',
            [-0.2, 0.64, side * 0.86],
            [3.75, 0.1, 0.075],
            key,
          );
          mesh(
            `${key}-side-window-${side}`,
            'box',
            'glass',
            [-0.65, 1.2, side * 0.55],
            [0.95, 0.34, 0.025],
            key,
          );
          mesh(
            `${key}-rail-${side}`,
            'box',
            'metal',
            [1.1, 1.18, side * 0.75],
            [1.5, 0.04, 0.04],
            key,
          );
          for (const x of [0.5, 1.65])
            mesh(
              `${key}-stanchion-${side}-${x}`,
              'box',
              'metal',
              [x, 1, side * 0.75],
              [0.04, 0.38, 0.04],
              key,
            );
          mesh(
            `${key}-fender-${side}`,
            'sphere',
            'metal',
            [-1.55, 0.61, side * 0.91],
            [0.14, 0.28, 0.14],
            key,
          );
        }
        mesh(`${key}-engine`, 'box', 'metal', [-1.98, 0.7, 0], [0.38, 0.58, 0.48], key);
        mesh(`${key}-front-window`, 'box', 'glass', [0.03, 1.2, 0], [0.025, 0.36, 0.85], key);
        mesh(`${key}-mast`, 'box', 'metal', [-1.4, 1.9, 0], [0.045, 1.3, 0.045], key);
        mesh(`${key}-flag`, 'box', color, [-1.1, 2.4, 0], [0.6, 0.25, 0.04], key);
        for (let i = 0; i < anchors.length; i++) {
          if (type === 'ocean')
            entities[`${key}-socket-${i}`] = {
              components: { Transform: { pos: anchors[i] }, ChildOf: { parent: key } },
            };
        }
        entities[type] = {
          components: {
            Name: { value: type },
            Transform: {},
            WaterBodyInstance: { body: guid(`body/${type}`) },
          },
        };
      }
      entities.zone = { components: { Transform: {}, WaterZoneInstance: { zone: zoneGuid } } };
      entities.custom = {
        components: {
          Transform: { pos: [70, 0, -50] },
          WaterBodyInstance: { body: guid('body/custom') },
        },
      };
      entities.terrain = {
        components: {
          Transform: { pos: [-96, 0, -80] },
          Terrain: { asset: guid('terrain/estuary/terrain') },
          RigidBody: { type: 0 },
          WaterTerrainProvider: { terrain: guid('terrain/estuary/terrain') },
        },
      };
      mesh('pier', 'box', 'wood', [-4, 0.65, 19], [31, 0.35, 2.5]);
    };
    authorCrafts();
    for (let i = 0; i < 17; i++)
      mesh(`pier-joint-${i}`, 'box', 'metal', [-18 + i * 1.8, 0.84, 19], [0.035, 0.025, 2.45]);
    for (const x of [-17, -9, 0, 9])
      for (const z of [18.1, 19.9])
        mesh(`pier-leg-${x}-${z}`, 'box', 'concrete', [x, -1, z], [0.3, 3.5, 0.3]);
    mesh('breakwater', 'box', 'concrete', [49, 1.5, 22], [36, 3, 2.8]);
    for (let i = 0; i < 5; i++)
      mesh(`breakwater-mark-${i}`, 'box', 'ochre', [34 + i * 7.5, 3.1, 22], [0.35, 0.2, 2.7]);
    for (const [i, x, z] of [
      [0, -63, -5],
      [1, -22, 25],
      [2, 33, 25],
    ] as const) {
      mesh(`beacon-base-${i}`, 'box', 'concrete', [x, 0.4, z], [2.5, 0.8, 2.5]);
      mesh(`beacon-${i}`, 'cylinder', 'concrete', [x, 3, z], [1.3, 5, 1.3]);
      mesh(
        `beacon-band-${i}`,
        'cylinder',
        i === 2 ? 'ochre' : 'red',
        [x, 4.2, z],
        [1.34, 0.5, 1.34],
      );
      mesh(`beacon-gallery-${i}`, 'cylinder', 'metal', [x, 5.55, z], [1.7, 0.16, 1.7]);
      mesh(`beacon-light-${i}`, 'cylinder', 'glass', [x, 6.05, z], [0.9, 0.8, 0.9]);
      mesh(`beacon-roof-${i}`, 'cone', 'metal', [x, 6.65, z], [1.5, 0.5, 1.5]);
    }
    const foamTextures = coastFoamTextures();
    const waterMaterials = Object.fromEntries(
      (['river', 'river-lod', 'lake', 'lake-lod', 'ocean', 'ocean-lod'] as const).map((type) => [
        `material/water/${type}`,
        {
          kind: 'material',
          parent: family.guids[type],
          // This open estuary shares one incident wave field across its current.
          staticSwitches: { waterWaves: true, waterFoam: true, waterOceanFoam: true },
          values: {
            waterFoamTexture: guid('texture/foam-height'),
            waterFoamNormalTexture: guid('texture/foam-normal'),
            foamTilingM: COAST_FOAM_TILING_M,
            foamVelocityMPerSec: [0.18, -0.12],
            foamAmount: 1,
            contactFoamAmount: 1,
            foamPower: 0.45,
            foamBoost: 0.6,
            foamContrast: 0.5,
            foamHeightBias: -0.18,
            foamScatterBias: -0.2,
            foamRoughness: 0.72,
            foamEmissiveColor: [0.16, 0.17, 0.18],
            foamScatteringPerM: [0.32, 0.35, 0.38],
            foamDepthMinimumM: 0.08,
            foamTextureBlendMinimum: 2,
            foamTextureBlendWidth: 1,
            surfaceCrestFoamAmount: 0.45,
            surfaceCrestFoamCompressionMinimum: 0.04,
            surfaceCrestFoamCompressionRange: 0.1,
            sceneDepthFoamAmount: 1,
            sceneDepthFoamWidthM: 0.35,
          },
        } satisfies MaterialAsset,
      ]),
    );
    return ok({
      ...water.value,
      ...waterMaterials,
      'texture/foam-height': foamTextures.height,
      'texture/foam-normal': foamTextures.normal,
      ...terrainMaterials,
      ...detail.textures,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, value]) => [`terrain/estuary/${key}`, value]),
      ),
      'scene/estuary': { kind: 'scene', entities } satisfies SceneAsset,
      'waves/estuary': waves,
      'waves/off': off,
      'mesh/hull': harborHull(4.6, 1.84),
      'mesh/cylinder': createCylinderGeometry(0.5, 0.5, 1, 32).unwrap(),
      'mesh/cone': createConeGeometry(0.5, 1, 32).unwrap(),
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': createSphereGeometry(1, 20, 12).unwrap(),
      'mesh/collider': createBoxGeometry(4, 0.65, 1.7).unwrap(),
      'material/white': material([0.84, 0.91, 0.9, 1], 0.35),
      'material/red': material([0.2, 0.032, 0.025, 1], 0.42),
      'material/ochre': material([0.3, 0.18, 0.04, 1], 0.4),
      'material/glass': material([0.025, 0.07, 0.08, 1], 0.12, 0.6),
      'material/metal': material([0.12, 0.18, 0.19, 1], 0.3, 0.65),
      'material/wood': { kind: 'material', parent: presentationGuid('material/wood'), values: {} },
      'material/concrete': {
        kind: 'material',
        parent: presentationGuid('material/rock'),
        values: {},
      },
    });
  },
});
