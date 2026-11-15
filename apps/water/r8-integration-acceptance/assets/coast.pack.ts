import { EngineContent } from '@forgeax/engine/content';
import {
  buildMeshCollision,
  buildMeshDistanceField,
  createBoxGeometry,
  createCylinderGeometry,
  createSphereGeometry,
} from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { defineParticleEffectSourceV3 } from '@forgeax/engine/vfx';
import { Collider, ColliderShapeValue, RigidBody } from '@forgeax/engine/physics';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import {
  ChildOf,
  Name,
  Transform,
  WaterBodyInstance,
  WaterContactProbeSet,
  WaterDispersiveMotion,
  WaterFluidSimulation,
  WaterPontoonSet,
  WaterShallowCollider,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import {
  type MaterialAsset,
  ok,
  type SceneAsset,
  type SceneEntity,
  type WaterBodySource,
} from '@forgeax/engine/types';
import {
  buildWaterPackOutputs,
  cookWaterAsset,
  SIMPLE_GERSTNER_WAVE_GENERATOR_ID,
  SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION,
  waterMaterialFamilySlots,
} from '@forgeax/engine/water';
import {
  COAST_FOAM_CAPTURE,
  COAST_MESH_PROFILES,
  IRON_BALL_RADIUS_M,
  WATER_R8_PACKAGE,
} from '../src/identity';
import { COAST_FOAM_TILING_M, coastFoamTextures } from './foam-textures';
import {
  coastLocalWaterEditedRecipe,
  coastLocalWaterRecipe,
  coastR7ShallowRecipe,
} from './local-water';
import { oceanFoamRecipe } from './ocean-foam';
import {
  coastHeight,
  environment,
  hullMesh,
  hullSheer,
  hullWaterlinePoint,
  hullWidth,
  palmFrondMesh,
  sailMesh,
  seagrassMesh,
  surfaceTexture,
} from './procedural';
import { COAST_SHIP_MASS_RIG, COAST_SHIP_MASTS, COAST_SHIP_PONTOONS } from './ship-rig';
import { WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS } from './vfx/water-entry-splash-material-inputs';

const point = (
  inputKey: number,
  x: number,
  z: number,
  y = 0,
  widthM = 12,
  depthM = 4,
  velocityMPerSec = 1,
) => ({
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
  depthM,
  velocityMPerSec,
  audioIntensity: 1,
});

const ironBallEntry = defineParticleEffectSourceV3({
  schemaVersion: 3,
  emitters: [
    {
      id: 'iron-ball-entry',
      capacity: 512,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'aabb', min: [-180, -24, -200], max: [180, 70, 180] },
      schedule: { rate: 0, bursts: [{ time: 0, count: 384 }] },
      program: { module: 'iron-ball-entry.vfx.wgsl' },
      renderers: [
        {
          kind: 'billboard',
          material: AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, 'material/water-entry-splash')),
          blend: 'alpha',
          sorting: 'view-depth',
          shading: { kind: 'translucent-water-sphere' },
          softParticle: { fadeDistance: 0.45 },
          materialInputs: [
            'subsurfaceGainOpacity',
            'waterSphereShading',
            'waterSphereFlattenSphere',
            'waterSphereProjection',
          ],
        },
      ],
      simulationWhenCulled: 'continue',
    },
  ],
});
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R8_PACKAGE,
  name: 'R8 / Coast and brigantine',
  sceneComponents: [
    Name,
    Transform,
    ChildOf,
    MeshFilter,
    MeshRenderer,
    RigidBody,
    Collider,
    WaterPontoonSet,
    WaterShallowCollider,
    WaterContactProbeSet,
    WaterFluidSimulation,
    WaterBodyInstance,
    WaterZoneInstance,
    Terrain,
    WaterTerrainProvider,
  ],
  build: async ({ packageId, readByGuid }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key)),
      family = { guids: EngineContent.water.materials };
    const hullSource = hullMesh();
    const hullPositions = hullSource.attributes.position;
    if (!(hullPositions instanceof Float32Array) || hullSource.indices === undefined)
      throw new Error('Hull distance-field source requires Float32 positions and triangle indices');
    const hullField = (
      await buildMeshDistanceField(hullPositions, hullSource.indices, { resolution: 48 })
    ).unwrap();
    const hull = {
      ...hullSource,
      collision: buildMeshCollision(hullSource).unwrap(),
      distanceField: { ...hullField, sectionSidedness: hullSource.submeshes.map(() => 0 as const) },
    };
    const reference = (key: string) => guid(key);
    const waves = (count: number, strength: number) =>
      cookWaterAsset({
        kind: 'water-wave-set',
        waveSource: {
          kind: 'generated',
          seed: 1337,
          generatorId: SIMPLE_GERSTNER_WAVE_GENERATOR_ID,
          generatorVersion: SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION,
          generatorConfig: {
            count,
            randomness: 0.8,
            wavelengthMinM: 1.3,
            wavelengthMaxM: 19,
            wavelengthFalloff: 2,
            amplitudeMinM: 0.006 * strength,
            amplitudeMaxM: 0.16 * strength,
            amplitudeFalloff: 2.5,
            windAngleDegrees: 35,
            directionAngularSpreadDegrees: 65,
            largeWaveSteepness: 0.0625,
            smallWaveSteepness: 0.03,
            steepnessFalloff: 1,
          },
        },
        depthMaskM: 0,
        maxWaveHeightM: 2.2,
        timeSource: 'scene-clock',
      }).unwrap();
    const waveSets = {
      'waves/calm': waves(16, 0.45),
      'waves/breeze': waves(16, 1),
      'waves/storm': waves(16, 2.4),
      'waves/q1': waves(3, 1),
    };
    const common = {
      kind: 'water-body' as const,
      zoneGuid: guid('zone/coast'),
      waveSetGuid: guid('waves/breeze'),
      baseHeightM: 0,
      overlapPriority: 1,
      maxWaveHeightM: 2.2,
      shapeDilationM: 1,
      queryFootprint: [
        [-8192, -8192],
        [8192, -8192],
        [8192, 8192],
        [-8192, 8192],
      ] as const,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      underwaterSettings: {
        enabled: true,
        priority: 0,
        blendRadiusM: 1,
        blendWeight: 1,
        maxDepthM: 30,
      },
    };
    const ocean: WaterBodySource = {
      ...common,
      type: 'ocean',
      ...waterMaterialFamilySlots(family, 'ocean'),
      surfaceMaterialGuid: guid('material/water/ocean'),
      lodMaterialGuid: guid('material/water/ocean-lod'),
      overlapPriority: 0,
      oceanExtentM: [16384, 16384],
      centerOnWaterZone: false,
      spline: {
        closed: true,
        interpolationVersion: 'ue-water-spline/1',
        points: Array.from({ length: 32 }, (_, i) => {
          const a = (i * Math.PI) / 16;
          return point(i, -16 + 15 * Math.cos(a), -62 + 8 * Math.sin(a), 0, 12, 4, 0);
        }),
      },
      collision: {
        type: 'polygon',
        enabled: true,
        collisionHalfHeightM: 30,
        collisionHalfExtentsM: [8192, 8192],
        collisionHeightOffsetM: 2,
        collisionGroups: 0x0002ffff,
      },
    };
    const sourceRead = async (requested: Parameters<typeof readByGuid>[0]) => {
      const key = AssetGuid.format(requested).toLowerCase();
      for (const [name, value] of Object.entries(waveSets))
        if (key === guid(name).toLowerCase()) return ok(value);
      return readByGuid(requested);
    };
    const built = await buildWaterPackOutputs(
      {
        'zone/coast': {
          kind: 'water-zone',
          extentM: { spanXM: 8192, spanZM: 8192 },
          tileSizeM: 8,
          tessellationFactor: COAST_MESH_PROFILES.coast64.tessellationFactor,
          lodScale: 1.7,
          farMeshBoundary: 'view-window',
          farExtentM: { spanXM: 4096, spanZM: 4096 },
          farMaterialGuid: guid('material/water/far'),
          waterInfo: {
            resolution: { widthPx: 2048, heightPx: 2048 },
            format: 'rgba16f',
            blurRadius: 1,
            localTessellation: true,
            localExtentM: [2048, 100, 2048],
          },
        },
        'body/ocean': ocean,
        'body/ocean-edited': { ...ocean, baseHeightM: 0.08 },
      },
      { packageId, readByGuid: sourceRead },
    );
    if (!built.ok) return built;
    const textured = (
      color: readonly [number, number, number, number],
      texture: string,
      roughness = 0.75,
    ) =>
      Materials.standard({
        baseColor: color,
        roughness,
        baseColorTexture: reference(`texture/${texture}`),
      });
    const foamTextures = coastFoamTextures();
    const textures = {
      'texture/sand': surfaceTexture('sand'),
      'texture/wood': surfaceTexture('wood'),
      'texture/rock': surfaceTexture('rock'),
      'texture/foam-height': foamTextures.height,
      'texture/foam-normal': foamTextures.normal,
    };
    const terrainMaterials = {
      'material/sand': textured([0.86, 0.81, 0.68, 1], 'sand', 0.95),
      'material/wet-sand': textured([0.48, 0.52, 0.46, 1], 'sand', 0.32),
      'material/grass': textured([0.18, 0.27, 0.075, 1], 'sand', 0.96),
    };
    const q4AppearanceMaterial = (parent: string, ocean: boolean): MaterialAsset => ({
      kind: 'material',
      parent,
      staticSwitches: {
        waterWaves: false,
        waterFlowmap: false,
        waterNormalTexture: false,
        waterFoam: false,
        waterOceanFoam: false,
        waterShallowSimulation: false,
        waterShallowAdditive: false,
        waterBakedSimulation: false,
      },
      values: {
        waterAlbedo: ocean ? [0.16, 0.34, 0.4] : [0.13, 0.29, 0.34],
        absorptionPerM: [0.13, 0.055, 0.035],
        scatteringPerM: [0.012, 0.028, 0.035],
        roughness: 0.32,
        specular: 0.18,
        refractionPixelNormalStrength: 0,
      },
    });
    const qualityWaterMaterials = {
      'material/water/ocean-q4-flat': q4AppearanceMaterial(family.guids.ocean, true),
      'material/water/far-q4-flat': q4AppearanceMaterial(family.guids.far, true),
    };
const fillCoastTerrainSamples = () => {
    const columns = 121,
      rows = 121,
      spacing = 8 / 3,
      heights = new Float32Array(columns * rows),
      weights = new Float32Array(columns * rows * 3);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const height = coastHeight(-160 + x * spacing, -160 + z * spacing),
          i = z * columns + x;
        heights[i] = height;
        const grass = Math.max(0, Math.min(1, (height - 2.7) / 2));
        const wet = 1 - Math.max(0, Math.min(1, (height - 0.1) / 0.8));
        weights[i * 3] = (1 - grass) * (1 - wet);
        weights[i * 3 + 1] = (1 - grass) * wet;
        weights[i * 3 + 2] = grass;
      }
return { columns, rows, spacing, heights, weights };
};
const { columns, rows, spacing, heights, weights } = fillCoastTerrainSamples();
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
        Object.entries({ ...terrainMaterials, ...textures }).map(([key, value]) => [
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
      material: string,
      pos: readonly number[],
      scale: readonly number[] = [1, 1, 1],
      parent?: string,
      quat?: readonly number[],
    ) => {
      entities[key] = {
        components: {
          Transform: { pos, scale, ...(quat ? { quat } : {}) },
          MeshFilter: { assetHandle: guid(`mesh/${shape}`) },
          MeshRenderer: { materials: [guid(`material/${material}`)] },
          ...(parent ? { ChildOf: { parent } } : {}),
        },
      };
    };
    const beam = (
      key: string,
      a: readonly number[],
      b: readonly number[],
      radius: number,
      material: string,
      parent?: string,
    ) => {
      const d = b.map((v, i) => v - a[i]!),
        length = Math.hypot(...d),
        q = [d[2]! / length, 0, -d[0]! / length, 1 + d[1]! / length],
        ql = Math.hypot(...q);
      mesh(
        key,
        'cylinder',
        material,
        a.map((v, i) => (v + b[i]!) * 0.5),
        [radius, length, radius],
        parent,
        q.map((v) => v / ql),
      );
    };
    entities.zone = {
      components: { Transform: {}, WaterZoneInstance: { zone: guid('zone/coast') } },
    };
    entities.ocean = {
      components: {
        Name: { value: 'Ocean' },
        Transform: {},
        WaterBodyInstance: { body: guid('body/ocean') },
      },
    };
    entities['ocean-foam'] = {
      components: {
        Transform: {},
        WaterFluidSimulation: {
          recipe: guid('fluid/ocean-foam'),
          body: 'ocean',
          waveFoamCenterM: COAST_FOAM_CAPTURE.centerM,
          enabled: false,
        },
      },
    };
    entities.terrain = {
      components: {
        Transform: { pos: [-160, 0, -160] },
        Terrain: { asset: guid('terrain/coast/terrain') },
        WaterTerrainProvider: { terrain: guid('terrain/coast/terrain') },
        RigidBody: { type: 0 },
      },
    };
    const hullContacts = [-1, 1].flatMap((side) =>
      Array.from({ length: 44 }, (_, index) => {
        const point = hullWaterlinePoint(
          -8.4 + index * (16.64 / 43),
          -COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM - 0.05,
        );
        return point === undefined ? [] : [[point[0], point[1], side * point[2]]];
      }).flat(),
    );
    entities.ship = {
      components: {
        Name: { value: 'Brigantine / four pontoons' },
        Transform: { pos: [0, COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM, 0] },
        RigidBody: {
          type: 1,
          mass: 0,
          linearDamping: 0.06,
          angularDamping: 0.3,
          ccdEnabled: true,
        },
        Collider: {
          shape: ColliderShapeValue.convexHull,
          mesh: guid('mesh/hull'),
          collisionGroups: 0x0001ffff,
        },
        MeshFilter: { assetHandle: guid('mesh/hull') },
        WaterPontoonSet: {
          configurationVersion: 1,
          centerPontoonsOnCOM: false,
          enabled: false,
          anchorsM: [...COAST_SHIP_PONTOONS.anchorsM],
          radiiM: [...COAST_SHIP_PONTOONS.radiiM],
          buoyancyCoefficientNPerM3: COAST_SHIP_MASS_RIG.buoyancy.buoyancyCoefficientNPerM3,
          maxBuoyantForceN: COAST_SHIP_MASS_RIG.buoyancy.maxBuoyantForceN,
          dampingNPerMps: 24000,
          applyDrag: true,
          linearDragCoefficient: 3,
          quadraticDragCoefficient: 0.04,
          maxDragSpeedMps: 12,
          angularDragPerSecond: 2,
          overlapFilterMask: 0xffff0002,
        },
        WaterContactProbeSet: {
          body: 'ocean',
          centersM: hullContacts.flat(),
          radiiM: hullContacts.map(() => 0.22),
          contactCoverage: 0.34,
        },
        WaterShallowCollider: {
          enabled: true,
          dispersiveMotion: WaterDispersiveMotion.surfaceTransport,
        },
      },
    };
const assembleCoastSceneMeshDetails = () => {
    mesh('hull', 'hull', 'wood', [0, 0, 0], [1, 1, 1], 'ship');
    mesh('deck', 'box', 'deck', [-0.7, 1.55, 0], [14.5, 0.13, 3.65], 'ship');
    for (let i = 0; i < 33; i++)
      mesh(
        `deck-seam-${i}`,
        'box',
        'dark',
        [-7.5 + i * 0.43, 1.62, 0],
        [0.018, 0.009, 3.65],
        'ship',
      );
    for (const side of [-1, 1]) {
      for (let level = 0; level < 5; level++)
        for (let i = 0; i < 7; i++) {
          const x = -7 + i * 2.2,
            width = hullWidth(x),
            y = -0.7 + level * 0.48 + (hullSheer(x) * level) / 4;
          mesh(
            `strake-${side}-${level}-${i}`,
            'box',
            level === 3 ? 'trim' : 'wood-dark',
            [x, y, side * width * (0.85 + level * 0.03)],
            [2.2, 0.045, 0.06],
            'ship',
          );
        }
      for (let i = 0; i < 23; i++) {
        const x = -8.6 + i * 0.7,
          z = side * hullWidth(x) * 0.98,
          sheer = hullSheer(x);
        mesh(
          `rail-post-${side}-${i}`,
          'cylinder',
          'wood',
          [x, 2.05 + sheer, z],
          [0.055, 0.9, 0.055],
          'ship',
        );
        if (i < 22)
          beam(
            `rail-${side}-${i}`,
            [x, 2.5 + sheer, z],
            [x + 0.7, 2.5 + hullSheer(x + 0.7), side * hullWidth(x + 0.7) * 0.98],
            0.055,
            'trim',
            'ship',
          );
      }
      for (let i = 0; i < 9; i++)
        mesh(
          `port-${side}-${i}`,
          'box',
          'dark',
          [-6 + i * 1.5, 0.65, side * 2.5],
          [0.58, 0.5, 0.07],
          'ship',
        );
    }
    mesh('stern-cabin', 'box', 'wood', [-7.75, 2.6, 0], [2.2, 0.95, 3.45], 'ship');
    mesh('stern-roof', 'box', 'trim', [-7.75, 3.16, 0], [2.5, 0.16, 3.65], 'ship');
    for (let i = 0; i < 5; i++)
      mesh(
        `stern-window-${i}`,
        'box',
        'glass',
        [-8.87, 2.6, -1.25 + i * 0.62],
        [0.035, 0.55, 0.42],
        'ship',
      );
const assembleCoastMastDetails = () => {
    for (const [
      i,
      { xM: x, heightM: height, rakeM: rake, crowHeightM: crowHeight },
    ] of COAST_SHIP_MASTS.entries()) {
      beam(`mast-${i}`, [x, 1.5, 0], [x + rake, height, 0], 0.13, 'wood', 'ship');
      mesh(
        `crow-${i}`,
        'cylinder',
        'wood-dark',
        [x + rake * 0.5, crowHeight, 0],
        [0.65, 0.22, 0.65],
        'ship',
      );
      for (const side of [-1, 1])
        beam(
          `crow-rail-${i}-${side}`,
          [x - 0.45, crowHeight + 0.16, side * 0.48],
          [x - 0.45, crowHeight + 0.9, side * 0.48],
          0.025,
          'wood-dark',
          'ship',
        );
      for (const [j, y, width] of [
        [0, 8.1, 2.8],
        [1, 13.7, 2.2],
      ] as const) {
        beam(`yard-${i}-${j}`, [x, y, -width * 0.5], [x, y, width * 0.5], 0.055, 'wood', 'ship');
      }
      for (const side of [-1, 1])
        for (const offset of [-2, -1, 0, 1, 2])
          beam(
            `rig-${i}-${side}-${offset}`,
            [x + offset, 2.3, side * 2.1],
            [x + rake * 0.5, crowHeight + 0.7, 0],
            0.015,
            'rope',
            'ship',
          );
      beam(`stay-${i}`, [x + rake, height, 0], [12.5, 4.2, 0], 0.017, 'rope', 'ship');
      beam(`backstay-${i}`, [x + rake, height, 0], [-8.7, 3.4, 0], 0.015, 'rope', 'ship');
      mesh(
        `staysail-${i}`,
        i === 0 ? 'jib-aft' : 'jib-forward',
        'sail',
        [x + 1, 3.5, 0],
        [1, 1, 1],
        'ship',
      );
      for (const side of [-1, 1])
        for (let step = 0; step < 12; step++) {
          const y = 3 + step * 0.5,
            weight = (y - 2.3) / (crowHeight + 0.7 - 2.3),
            z = side * 2.1 * (1 - weight),
            span = 2 * (1 - weight);
          beam(
            `ratline-${i}-${side}-${step}`,
            [x - span, y, z],
            [x + span, y, z],
            0.009,
            'rope',
            'ship',
          );
        }
    }
};
assembleCoastMastDetails();
    beam('bowsprit', [6.2, 2.1, 0], [13, 5, 0], 0.095, 'wood', 'ship');
    beam('bow-stem', [6.3, -0.4, 0], [9.2, 1.8, 0], 0.14, 'wood', 'ship');
    for (const side of [-1, 1]) {
      const points = [
        [6.1, 0.7, 1.25],
        [8.1, 1, 1.05],
        [9.7, 1.65, 0.7],
        [11.2, 2.6, 0.25],
      ];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!,
          b = points[i + 1]!;
        for (const level of [0, 0.35])
          beam(
            `beakhead-${side}-${i}-${level}`,
            [a[0]!, a[1]! + level, a[2]! * side],
            [b[0]!, b[1]! + level, b[2]! * side],
            0.055,
            'trim',
            'ship',
          );
        beam(
          `beakhead-post-${side}-${i}`,
          [a[0]!, a[1]!, a[2]! * side],
          [a[0]!, a[1]! + 0.4, a[2]! * side],
          0.04,
          'wood',
          'ship',
        );
      }
    }
    beam('aft-gaff', [-3.35, 3.2, 0], [-9.35, 10.5, 0], 0.055, 'wood', 'ship');
    beam('aft-gaff-stay', [-9.35, 10.5, 0], [-2.35, 18.7, 0], 0.013, 'rope', 'ship');
    mesh('aft-sail', 'aft-sail', 'sail', [-3.35, 3.2, 0], [1, 1, 1], 'ship');
    mesh('flag', 'flag', 'flag', [-1.65, 18.1, 0], [1, 1, 1], 'ship');
    for (let i = 0; i < 14; i++) {
      const a = i * 2.399,
        x = -16 + Math.cos(a) * (9 + i * 0.6),
        z = -62 + Math.sin(a) * (3 + i * 0.35),
        y = coastHeight(x, z);
      mesh(
        `rock-${i}`,
        'rock',
        'rock',
        [x, y + 0.35, z],
        [1.6 + (i % 3) * 0.8, 1.1 + (i % 4) * 0.6, 1.3 + (i % 3) * 0.45],
        '',
        undefined,
      );
    }
    for (const [i, x, z] of [
      [0, -20, -63],
      [1, -12, -64],
      [2, -15, -60],
    ] as const) {
      const y = coastHeight(x, z);
      beam(`palm-trunk-${i}`, [x, y, z], [x + 0.35, y + 6.5, z], 0.09, 'wood');
      for (let leaf = 0; leaf < 7; leaf++) {
        const a = (leaf * Math.PI * 2) / 7;
        mesh(
          `palm-leaf-${i}-${leaf}`,
          'frond',
          'leaf',
          [x + 0.35, y + 6.5, z],
          [1, 1, 1],
          undefined,
          [0, Math.sin(a / 2), 0, Math.cos(a / 2)],
        );
      }
    }
    for (let i = 0; i < 52; i++) {
      const angle = i * 2.399,
        radius = 6 + Math.sqrt(i / 52) * 35,
        x = -3 + Math.cos(angle) * radius,
        z = -10 + Math.sin(angle) * radius,
        groundY = coastHeight(x, z);
      if (groundY > -1.7 || groundY < -8) continue;
      mesh(
        `seagrass-${i}`,
        'seagrass',
        'seagrass',
        [x, groundY, z],
        [1.2 + (i % 3), 0.8 + (i % 4) * 0.2, 1.1 + (i % 3)],
        undefined,
        [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
      );
      if (i % 5 === 0)
        mesh(
          `submerged-rock-${i}`,
          'rock',
          'submerged-rock',
          [x + 1.4, groundY + 0.25, z - 0.7],
          [0.9 + (i % 3) * 0.5, 0.55 + (i % 2) * 0.4, 0.7 + (i % 4) * 0.3],
        );
    }
};
assembleCoastSceneMeshDetails();
    const waterMaterials = Object.fromEntries(
      ['ocean', 'ocean-lod', 'far'].map((type) => [
        'material/water/' + type,
        {
          kind: 'material',
          parent: family.guids[type as keyof typeof family.guids],
          staticSwitches: {
            waterWaves: type !== 'far',
            waterFlowmap: false,
            waterNormalTexture: true,
            waterFoam: true,
            waterOceanFoam: type.startsWith('ocean'),
            waterShallowSimulation: type.startsWith('ocean'),
            waterShallowAdditive: type.startsWith('ocean'),
          },
          values: {
            waterNormalTexture: EngineContent.water.textures.normal,
            waterFoamTexture: guid('texture/foam-height'),
            waterFoamNormalTexture: guid('texture/foam-normal'),
            normalTilingM: 3.3,
            normalStrength: 0.22,
            distantNormalStrength: 0.25,
            normalFarStartM: 180,
            normalFarRangeM: 300,
            absorptionPerM: [0.26, 0.085, 0.045],
            scatteringPerM: [0.005, 0.016, 0.028],
            waterAlbedo: [0.85, 0.9, 0.93],
            roughness: 0.12,
            fresnelRoughness: 0.2,
            specular: 0.23,
            refractionPixelNormalStrength: 1.04,
            simulationLocationM: COAST_FOAM_CAPTURE.centerM,
            waveCaptureSizeM: COAST_FOAM_CAPTURE.extentM,
            foamMaskNearFluid: 0,
            foamAmount: 1.1,
            foamRoughness: 0.72,
            foamEmissiveColor: [0.16, 0.17, 0.18],
            foamScatteringPerM: [0.32, 0.35, 0.38],
            foamPower: 0.45,
            foamBoost: 0.6,
            foamHeightBias: -0.18,
            foamContrast: 0.5,
            foamTilingM: COAST_FOAM_TILING_M,
            foamDepthMinimumM: 0.08,
            foamTextureBlendMinimum: 2,
            foamTextureBlendWidth: 1,
            foamScatterBias: -0.2,
            surfaceCrestFoamAmount: type.startsWith('ocean') ? 1 : 0,
            surfaceCrestFoamCompressionMinimum: 0.04,
            surfaceCrestFoamCompressionRange: 0.1,
            sceneDepthFoamAmount: type.startsWith('ocean') ? 1.2 : 0,
            sceneDepthFoamWidthM: 2.2,
          },
        } satisfies MaterialAsset,
      ]),
    );
    return ok({
      ...built.value,
      ...waveSets,
      'fluid/ocean-foam': oceanFoamRecipe(),
      'fluid/coast-local': coastLocalWaterRecipe,
      'fluid/coast-local-edited': coastLocalWaterEditedRecipe,
      'fluid/coast-r7-shallow': coastR7ShallowRecipe,
      'effect/iron-ball-entry': { kind: 'particle-effect', source: ironBallEntry },
      ...terrainMaterials,
      ...qualityWaterMaterials,
      ...waterMaterials,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, value]) => [`terrain/coast/${key}`, value]),
      ),
      'scene/coast': { kind: 'scene', entities } satisfies SceneAsset,
      'mesh/hull': hull,
      'mesh/sail': sailMesh(7, 4.7),
      'mesh/jib-aft': sailMesh(2.4, 4.8, true, -1.1),
      'mesh/jib-forward': sailMesh(1.7, 3.8, true, -0.65),
      'mesh/aft-sail': sailMesh(0.65, 7.3, false, -6),
      'mesh/flag': sailMesh(1.3, 0.65),
      'mesh/frond': palmFrondMesh(),
      'mesh/seagrass': seagrassMesh(),
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/cylinder': createCylinderGeometry(1, 1, 1, 12).unwrap(),
      'mesh/rock': createSphereGeometry(1, 10, 7).unwrap(),
      'mesh/iron-ball': createSphereGeometry(IRON_BALL_RADIUS_M, 24, 16).unwrap(),
      ...textures,
      'environment/day': environment('day'),
      'environment/sunset': environment('sunset'),
      'environment/overcast': environment('overcast'),
      'environment/day-clear': environment('day', false),
      'environment/sunset-clear': environment('sunset', false),
      'environment/overcast-clear': environment('overcast', false),
      'material/wood': textured([0.52, 0.48, 0.41, 1], 'wood'),
      'material/wood-dark': textured([0.28, 0.25, 0.2, 1], 'wood'),
      'material/deck': textured([0.56, 0.52, 0.42, 1], 'wood'),
      'material/trim': Materials.standard({
        baseColor: [0.4, 0.34, 0.27, 1],
        roughness: 0.72,
      }),
      'material/dark': Materials.standard({ baseColor: [0.017, 0.022, 0.019, 1], roughness: 0.6 }),
      'material/iron-ball': Materials.standard({
        baseColor: [0.065, 0.075, 0.08, 1],
        roughness: 0.38,
        metallic: 0.92,
      }),
      'material/water-entry-splash': {
        ...Materials.standard({
          baseColor: [0.608430, 0.678261, 0.644446, 1],
          normalTexture: AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, 'texture/foam-normal')),
          occlusionTexture: AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, 'texture/foam-height')),
          occlusionStrength: 0,
          renderState: { cullMode: 'none' },
        }),
        particleInputs: WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS,
      } satisfies MaterialAsset,
      'material/rope': Materials.standard({ baseColor: [0.07, 0.065, 0.055, 1], roughness: 0.9 }),
      'material/rock': textured([0.68, 0.67, 0.6, 1], 'rock', 0.92),
      'material/submerged-rock': textured([0.23, 0.28, 0.2, 1], 'rock', 0.94),
      'material/seagrass': Materials.standard({
        baseColor: [0.045, 0.105, 0.035, 1],
        roughness: 0.92,
        renderState: { cullMode: 'none' },
      }),
      'material/glass': Materials.standard({
        baseColor: [0.07, 0.13, 0.15, 1],
        roughness: 0.08,
        metallic: 0.65,
      }),
      'material/sail': Materials.standard({
        baseColor: [0.87, 0.86, 0.79, 1],
        roughness: 0.9,
        renderState: { cullMode: 'none' },
      }),
      'material/flag': Materials.standard({
        baseColor: [0.04, 0.055, 0.055, 1],
        roughness: 0.8,
        renderState: { cullMode: 'none' },
      }),
      'material/leaf': Materials.standard({
        baseColor: [0.055, 0.16, 0.045, 1],
        roughness: 0.9,
        renderState: { cullMode: 'none' },
      }),
    });

  },
});
