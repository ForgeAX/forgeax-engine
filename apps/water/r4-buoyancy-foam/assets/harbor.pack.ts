import { EngineContent } from '@forgeax/engine/content';
import {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createMeshBuilder,
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
import { requireDemoValue } from '../../runtime-input';
import { terrainPresentation } from '../../terrain-presentation';
import {
  FOAM_MATERIAL_MODES,
  type FoamMaterialMode,
  foamMaterialKey,
  type PontoonCount,
  pontoonLayout,
  pontoonRadius,
  WATER_R4_PACKAGE,
} from '../src/identity';

const splinePoint = (inputKey: number, x: number, z: number, y = 0, widthM = 12) => ({
  inputKey,
  interpolationMode: 'linear' as const,
  positionM: [x, y, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  rotationQuat: [0, 0, 0, 1] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM,
  depthM: 4,
  velocityMPerSec: 1.4,
  audioIntensity: 1,
});
function material(
  color: readonly [number, number, number, number],
  roughness = 0.55,
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
function collider(offsetX = 0, offsetZ = 0) {
  const box = createBoxGeometry(3.6, 0.58, 1.5).unwrap();
  const sourcePositions = box.attributes.position;
  if (!(sourcePositions instanceof Float32Array) || box.indices === undefined)
    throw new Error('Box collider geometry requires positions and indices');
  const positions = sourcePositions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = requireDemoValue(positions[i], 'accepted authored scene member') + offsetX;
    positions[i + 2] =
      requireDemoValue(positions[i + 2], 'accepted authored scene member') + offsetZ;
  }
  return createMeshBuilder({ attributes: { position: positions }, indices: box.indices })
    .build()
    .unwrap();
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R4_PACKAGE,
  name: 'Water R4 Buoyancy Harbor',
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
    const waveSet = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [0.8, 0.6], wavelengthM: 8, amplitudeM: 0.16, steepness: 0.1 },
          { directionXZ: [-0.3, 0.953939], wavelengthM: 3.5, amplitudeM: 0.055, steepness: 0.07 },
        ],
      },
      depthMaskM: 2,
      maxWaveHeightM: 0.24,
      timeSource: 'scene-clock',
    }).unwrap();
    const noWaves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0, steepness: 0 }],
      },
      depthMaskM: 2,
      maxWaveHeightM: 0,
      timeSource: 'scene-clock',
    }).unwrap();
    const family = { guids: EngineContent.water.materials },
      zoneGuid = guid('zone/harbor');
    const common = {
      kind: 'water-body' as const,
      zoneGuid,
      baseHeightM: 0,
      overlapPriority: 1,
      maxWaveHeightM: 0.24,
      waveSetGuid: guid('waves/off'),
      shapeDilationM: 1,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      queryFootprint: [
        [-110, -110],
        [110, -110],
        [110, 110],
        [-110, 110],
      ] as const,
      underwaterSettings: {
        enabled: true,
        priority: 0,
        blendRadiusM: 1,
        blendWeight: 1,
        maxDepthM: 10,
      },
    };
    const river: WaterBodySource = {
      ...common,
      type: 'river',
      overlapPriority: 3,
      ...waterMaterialFamilySlots(family, 'river'),
      spline: {
        closed: false,
        interpolationVersion: 'ue-water-spline/1',
        points: [
          splinePoint(0, -42, -1, 0.09, 10),
          splinePoint(1, -27, -1, 0.07, 11),
          splinePoint(2, -10, 0, 0.05, 14),
          splinePoint(3, 0, 0, 0.04, 18),
        ].map((point, index) => ({ ...point, depthM: 2 + index * 2 })),
      },
      collision: { type: 'river-prism', enabled: true, collisionGroups: 0x0002ffff },
    };
    const lake: WaterBodySource = {
      ...common,
      type: 'lake',
      baseHeightM: 0.04,
      overlapPriority: 2,
      ...waterMaterialFamilySlots(family, 'lake'),
      spline: {
        closed: true,
        interpolationVersion: 'ue-water-spline/1',
        points: [
          splinePoint(0, -11, -11),
          splinePoint(1, 15, -13),
          splinePoint(2, 20, -5),
          splinePoint(3, 17, 11),
          splinePoint(4, -8, 12),
        ],
      },
      collision: {
        type: 'polygon',
        enabled: true,
        channelDepthM: 8,
        collisionHeightOffsetM: 2,
        collisionGroups: 0x0002ffff,
      },
    };
    const ocean: WaterBodySource = {
      ...common,
      type: 'ocean',
      overlapPriority: 0,
      ...waterMaterialFamilySlots(family, 'ocean'),
      surfaceMaterialGuid: guid('material/ocean-foam'),
      lodMaterialGuid: guid('material/ocean-foam-lod'),
      oceanExtentM: [220, 220],
      centerOnWaterZone: false,
      spline: {
        closed: true,
        interpolationVersion: 'ue-water-spline/1',
        points: [
          splinePoint(0, -90, -90),
          splinePoint(1, 18, -90),
          splinePoint(2, 18, -17),
          splinePoint(3, 13, -12),
          splinePoint(4, 14, 12),
          splinePoint(5, 20, 19),
          splinePoint(6, 20, 90),
          splinePoint(7, -90, 90),
        ],
      },
      collision: {
        type: 'polygon',
        enabled: true,
        collisionHalfHeightM: 10,
        collisionHeightOffsetM: 2,
        collisionHalfExtentsM: [110, 110],
        collisionGroups: 0x0002ffff,
      },
    };
    const water = await buildWaterPackOutputs(
      {
        'zone/harbor': {
          kind: 'water-zone',
          extentM: { spanXM: 104, spanZM: 80 },
          tileSizeM: 4,
          tessellationFactor: 4,
          lodScale: 1.8,
          farExtentM: { spanXM: 220, spanZM: 220 },
          farMaterialGuid: family.guids.far,
          waterInfo: {
            resolution: { widthPx: 256, heightPx: 256 },
            format: 'rgba16f',
            blurRadius: 1,
            localTessellation: false,
          },
        },
        'body/river': river,
        'body/lake': lake,
        'body/ocean': ocean,
      },
      {
        packageId,
        readByGuid: async (requested) =>
          AssetGuid.format(requested).toLowerCase() === guid('waves/harbor').toLowerCase()
            ? ok(waveSet)
            : AssetGuid.format(requested).toLowerCase() === guid('waves/off').toLowerCase()
              ? ok(noWaves)
              : readByGuid(requested),
      },
    );
    if (!water.ok) return water;
    const detail = terrainPresentation(guid);
    const terrainMaterials = {
      'material/shore': detail.shore,
      'material/grass': detail.grass,
    };
    const columns = 76,
      rows = 61,
      spacing = 100 / 75,
      heights = new Float32Array(columns * rows),
      weights = new Float32Array(columns * rows * 2);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const wx = -50 + x * spacing,
          wz = -40 + z * spacing;
        const riverDistance = Math.abs(wz + Math.max(0, Math.min(1, (-wx - 10) / 32))),
          riverBank = (riverDistance - 5.2) / 3;
        const lakeDistance = Math.sqrt(((wx - 3) / 18) ** 2 + (wz / 14) ** 2),
          lakeBank = (lakeDistance - 1) * 5;
        const coast = (18 + 1.7 * Math.sin(wz * 0.13) - wx) / 6;
        const edge = Math.max(0, Math.min(1, Math.min(wx < 0 ? riverBank : 10, lakeBank, coast)));
        const blend = edge * edge * (3 - 2 * edge),
          height =
            -3.6 +
            blend *
              (4.8 +
                0.55 * Math.sin(wx * 0.25) * Math.cos(wz * 0.2) +
                0.22 * Math.sin(wx * 0.9 + wz * 0.45));
        const i = z * columns + x;
        heights[i] = height;
        const grass = Math.max(0, Math.min(1, (height - 0.1) / 1.5));
        weights[i * 2] = 1 - grass;
        weights[i * 2 + 1] = grass;
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
      (key) => guid(`terrain/harbor/${key}`),
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
      visible = true,
    ) => {
      entities[key] = {
        components: {
          Transform: { pos, scale },
          MeshFilter: { assetHandle: guid(`mesh/${shape}`) },
          MeshRenderer: { materials: [guid(`material/${color}`)] },
          ...(parent ? { ChildOf: { parent } } : {}),
          ...(visible ? {} : { Visibility: { state: VisibilityStateValue.hidden } }),
        },
      };
    };
    const craft = (
      key: string,
      color: string,
      pos: readonly number[],
      count: PontoonCount,
      socket = false,
    ) => {
      const anchors = pontoonLayout(count),
        radius = pontoonRadius(count);
      entities[key] = {
        components: {
          Name: { value: key },
          Transform: { pos },
          RigidBody: {
            type: 1,
            mass: 125,
            linearDamping: 0.02,
            angularDamping: 0.02,
            ccdEnabled: true,
          },
          Collider: {
            shape: 5,
            mesh: guid('mesh/collider-centered'),
            density: 1,
            collisionGroups: 0x0001ffff,
          },
          WaterPontoonSet: {
            configurationVersion: 1,
            anchorMode: socket ? 1 : 0,
            anchorsM: socket ? anchors.flatMap(() => [0, 0, 0]) : anchors.flatMap((p) => [...p]),
            radiiM: anchors.map(() => radius),
            socketEntities: socket ? anchors.map((_, i) => `${key}-socket-${i}`) : [],
            buoyancyCoefficientNPerM3: 1200,
            applyDrag: true,
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
      mesh(`${key}-hull`, 'hull', color, [0, 0.25, 0], [1, 1, 1], key);
      for (const side of [-1, 1])
        mesh(
          `${key}-rub-rail-${side}`,
          'box',
          'metal',
          [-0.3, 0.43, side * 0.76],
          [3, 0.065, 0.08],
          key,
        );
      mesh(`${key}-deck`, 'box', 'wood', [-0.3, 0.65, 0], [2.8, 0.16, 1.38], key);
      mesh(`${key}-cabin`, 'box', color, [-0.55, 1.04, 0], [1.05, 0.65, 0.92], key);
      mesh(`${key}-window`, 'box', 'glass', [-0.55, 1.12, -0.48], [0.72, 0.3, 0.025], key);
      mesh(`${key}-roof`, 'box', 'wood', [-0.55, 1.4, 0], [1.22, 0.1, 1.05], key);
      for (const x of [-0.87, -0.49, -0.11])
        for (const side of [-1, 1])
          mesh(
            `${key}-window-frame-${x}-${side}`,
            'box',
            'metal',
            [x, 1.1, side * 0.49],
            [0.035, 0.34, 0.03],
            key,
          );
      for (let plank = 0; plank < 13; plank++)
        mesh(
          `${key}-deck-plank-${plank}`,
          'box',
          'wood',
          [-1.6 + plank * 0.24, 0.75, 0],
          [0.215, 0.045, 1.32],
          key,
        );
      for (const side of [-1, 1]) {
        mesh(
          `${key}-gunwale-${side}`,
          'box',
          'wood',
          [-0.25, 0.59, side * 0.77],
          [3.1, 0.09, 0.065],
          key,
        );
        mesh(
          `${key}-side-window-${side}`,
          'box',
          'glass',
          [-0.55, 1.1, side * 0.475],
          [0.75, 0.32, 0.025],
          key,
        );
        mesh(
          `${key}-rail-${side}`,
          'box',
          'metal',
          [0.9, 1.1, side * 0.66],
          [1.25, 0.035, 0.035],
          key,
        );
        for (const x of [0.4, 1.4])
          mesh(
            `${key}-stanchion-${side}-${x}`,
            'box',
            'metal',
            [x, 0.94, side * 0.66],
            [0.035, 0.35, 0.035],
            key,
          );
        mesh(
          `${key}-fender-${side}`,
          'sphere',
          'metal',
          [-1.3, 0.55, side * 0.83],
          [0.12, 0.24, 0.12],
          key,
        );
      }
      mesh(`${key}-engine`, 'box', 'metal', [-1.72, 0.64, 0], [0.32, 0.52, 0.42], key);
      mesh(`${key}-front-window`, 'box', 'glass', [0, 1.11, 0], [0.03, 0.33, 0.68], key);
      mesh(`${key}-mast`, 'box', 'metal', [-1.1, 1.85, 0], [0.045, 1.15, 0.045], key);
      mesh(`${key}-flag`, 'box', color, [-0.86, 2.28, 0], [0.5, 0.28, 0.035], key);
      anchors.forEach((p, i) => {
        if (socket)
          entities[`${key}-socket-${i}`] = {
            components: { Transform: { pos: p }, ChildOf: { parent: key } },
          };
        mesh(`${key}-pontoon-${i}`, 'sphere', color, p, [radius, radius, radius], key, false);
      });
    };
    craft('river-craft', 'red', [-24, 0, -1], 4);
    craft('lake-craft', 'yellow', [4, 0, 1], 4);
    craft('ocean-craft', 'teal', [27, 0, -2], 16, true);
    entities.zone = { components: { Transform: {}, WaterZoneInstance: { zone: zoneGuid } } };
    for (const type of ['river', 'lake', 'ocean'])
      entities[type] = {
        components: {
          Name: { value: type },
          Transform: {},
          WaterBodyInstance: { body: guid(`body/${type}`) },
        },
      };
    entities.terrain = {
      components: {
        Transform: { pos: [-50, 0, -40] },
        Terrain: { asset: guid('terrain/harbor/terrain') },
        RigidBody: { type: 0 },
        WaterTerrainProvider: { terrain: guid('terrain/harbor/terrain') },
      },
    };
    mesh('dock', 'box', 'wood', [-0.3, 0.55, 11], [32, 0.35, 2]);
    for (let i = 0; i < 15; i++)
      mesh(`dock-plank-${i}`, 'box', 'white', [-14.2 + i * 2, 0.74, 11], [0.035, 0.015, 1.95]);
    for (const x of [-13, -5, 4, 13])
      for (const z of [10.4, 11.6])
        mesh(`pier-${x}-${z}`, 'box', 'metal', [x, -1, z], [0.2, 3, 0.2]);
    for (const [i, x, z] of [
      [0, -28, 9],
      [1, 10, -16],
      [2, 20, 18],
    ] as const) {
      mesh(`beacon-base-${i}`, 'box', 'dock', [x, 0.4, z], [2.3, 0.8, 2.3]);
      mesh(`beacon-${i}`, 'cylinder', 'dock', [x, 2.3, z], [1.15, 3, 1.15]);
      mesh(`beacon-band-${i}`, 'cylinder', 'red', [x, 2.8, z], [1.19, 0.38, 1.19]);
      mesh(`beacon-gallery-${i}`, 'cylinder', 'metal', [x, 3.9, z], [1.45, 0.12, 1.45]);
      mesh(`beacon-lantern-${i}`, 'cylinder', 'glass', [x, 4.3, z], [0.76, 0.68, 0.76]);
      mesh(`beacon-top-${i}`, 'cone', 'metal', [x, 4.78, z], [1.3, 0.42, 1.3]);
    }
    return ok({
      ...water.value,
      ...terrainMaterials,
      ...detail.textures,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, value]) => [`terrain/harbor/${key}`, value]),
      ),
      'scene/harbor': { kind: 'scene', entities } satisfies SceneAsset,
      'waves/harbor': waveSet,
      'waves/off': noWaves,
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': createSphereGeometry(1, 24, 16).unwrap(),
      'mesh/hull': harborHull(4.1, 1.64),
      'mesh/cylinder': createCylinderGeometry(0.5, 0.5, 1, 32).unwrap(),
      'mesh/cone': createConeGeometry(0.5, 1, 32).unwrap(),
      'mesh/collider-centered': collider(),
      'mesh/collider-eccentric': collider(0.3, 0.12),
      'material/white': material([0.83, 0.91, 0.88, 1], 0.35),
      'material/red': material([0.21, 0.029, 0.023, 1], 0.42),
      'material/yellow': material([0.34, 0.21, 0.043, 1], 0.4),
      'material/teal': material([0.014, 0.1, 0.11, 1], 0.38),
      'material/glass': material([0.025, 0.065, 0.09, 1], 0.1, 0.6),
      'material/metal': material([0.12, 0.18, 0.19, 1], 0.3, 0.7),
      'material/wood': { kind: 'material', parent: presentationGuid('material/wood'), values: {} },
      'material/dock': { kind: 'material', parent: presentationGuid('material/rock'), values: {} },
      ...Object.fromEntries(
        Object.entries(FOAM_MATERIAL_MODES).flatMap(([mode, values]) =>
          [false, true].flatMap((lod) =>
            [false, true].map((enabled) => [
              foamMaterialKey(mode as FoamMaterialMode, enabled, lod),
              {
                kind: 'material',
                parent: family.guids[lod ? 'ocean-lod' : 'ocean'],
                staticSwitches: { waterOceanFoam: enabled },
                values: {
                  absorptionPerM: [0.38, 0.1, 0.06],
                  scatteringPerM: [0.035, 0.045, 0.04],
                  ...values,
                },
              } satisfies MaterialAsset,
            ]),
          ),
        ),
      ),
    });
  },
});
