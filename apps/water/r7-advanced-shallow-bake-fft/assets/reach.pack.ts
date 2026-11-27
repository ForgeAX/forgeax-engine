import { EngineContent } from '@forgeax/engine/content';
import {
  createBoxGeometry,
  createCapsuleGeometry,
  createSphereGeometry,
  createTorusGeometry,
  decodeMeshDistanceFieldAttachment,
} from '@forgeax/engine/geometry';
import { cookMeshDistanceFieldProduct } from '@forgeax/engine/import';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import {
  type MaterialAsset,
  type MaterialRootAsset,
  ok,
  standardSurfaceParameters,
  type TextureAsset,
  type WaterAdvancedSimulationSource,
  type WaterBodySource,
} from '@forgeax/engine/types';
import { buildWaterPackOutputs, waterMaterialFamilySlots } from '@forgeax/engine/water';
import { resolveDemoMaterialSource } from '../../material-source';
import { presentationGuid } from '../../presentation-identity';
import { terrainPresentation } from '../../terrain-presentation';
import { WATER_R7_PACKAGE } from '../src/identity';

const point = (inputKey: number, x: number, z: number, widthM = 24) => ({
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
  depthM: 2.5,
  velocityMPerSec: 0.6,
  audioIntensity: 1,
});
const standard = (
  color: readonly [number, number, number, number],
  roughness = 0.6,
  metallic = 0,
): MaterialRootAsset => ({
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
});
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_R7_PACKAGE,
  name: 'Water R7 Reach',
  build: async ({ packageId, readByGuid }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const zoneGuid = guid('zone/reach'),
      family = { guids: EngineContent.water.materials };
    const square = [point(0, -13, -15), point(1, 13, -15), point(2, 13, 15), point(3, -13, 15)];
    const body = (type: 'lake' | 'river' | 'ocean', name: string): WaterBodySource => ({
      kind: 'water-body',
      type,
      zoneGuid,
      baseHeightM: 0,
      overlapPriority: 1,
      maxWaveHeightM: 1.5,
      shapeDilationM: 0.5,
      ...waterMaterialFamilySlots(family, type),
      surfaceMaterialGuid: guid(`material/water/${name}`),
      lodMaterialGuid: guid(`material/water/${name}`),
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      spline: {
        closed: type !== 'river',
        interpolationVersion: 'water-spline/2',
        points:
          type === 'river'
            ? [point(0, 0, -15, 26), point(1, 0, 15, 26)]
            : type === 'ocean'
              ? [point(0, 10, 12), point(1, 12, 12), point(2, 12, 14), point(3, 10, 14)]
              : square,
      },
      ...(type === 'ocean' ? { oceanExtentM: [26, 30] as const, centerOnWaterZone: false } : {}),
      collision:
        type === 'river'
          ? { type: 'river-prism', enabled: false }
          : { type: 'polygon', enabled: false },
      queryFootprint: [
        [-13, -15],
        [13, -15],
        [13, 15],
        [-13, 15],
      ],
      renderOptions: { visible: true, castShadow: false, receiveShadow: true },
    });
    const built = await buildWaterPackOutputs(
      {
        'zone/reach': {
          kind: 'water-zone',
          extentM: { spanXM: 128, spanZM: 64 },
          tileSizeM: 2,
          tessellationFactor: 6,
          lodScale: 1.2,
          waterInfo: {
            resolution: { widthPx: 512, heightPx: 256 },
            format: 'rgba16f',
            blurRadius: 0,
            localTessellation: false,
          },
        },
        'body/shallow': body('lake', 'shallow'),
        'body/river': body('river', 'river'),
        'body/ocean': body('ocean', 'ocean'),
      },
      { packageId, readByGuid },
    );
    if (!built.ok) return built;
    const rigid = (
      kind: 'simple' | 'distance-field',
      accurate = false,
      useWaterHeightForCollision = false,
    ) => ({
      kind,
      accurate,
      useWaterHeightForCollision,
      collisionGroups: 0xffffffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 100,
    });
    const shallowConfig = (
      river: boolean,
      collisions: NonNullable<
        WaterAdvancedSimulationSource['shallowStageConfig']
      >['rigidMeshCollisions'] = river ? { kind: 'disabled' } : rigid('simple'),
    ): NonNullable<WaterAdvancedSimulationSource['shallowStageConfig']> => ({
      stageProfile: river ? 'river-shallow/2' : 'water-body-shallow/2',
      gridResolution: [64, 64],
      extentM: river ? [24, 28] : [20, 20],
      baseHeightM: 0,
      initialDepthM: 2.5,
      gravityMPerSec2: 9.8,
      frictionPerSecond: 0.012,
      maximumVelocityMPerSec: 5,
      dryDepthM: 0.000001,
      maximumDepthM: 8,
      keepWaterDepthInsideColliders: false,
      distributeOverlapVolume: true,
      advection: 'bilinear',
      advectionVelocityMultiplier: 1,
      velocityDissipationPerSecond: 0.02,
      complexUpwind: true,
      upwind: true,
      depthLimiter: true,
      integrationDepthMax: 1,
      thinFilmDepthM: 0.02,
      thinFilmDampingPerSecond: 0.005,
      edgeDissipationEnabled: false,
      overlapRadiusCells: 2,
      overlapVolumeMultiplier: 1,
      collisionFalloff: 0.3,
      rigidMeshCollisions: collisions,
      postSimVelocityBlurRadiusCells: 0,
      normalSmoothingRadiusCells: river ? 1 : 0,
      normalFoamRange: [0, 1],
      startFadeSeconds: 2,
      runLiveSimulation: true,
      foam: {
        advectionVelocityMultiplier: 0,
        dissipationRatePerSecond: 0.25,
        dissipationSubtractionPerSecond: 0,
        minimum: 0,
        maximum: 1,
        emission: {
          vorticity: { range: [0.2, 1], multiplier: 0.8 },
          curvature: { range: [0.01, 0.2], multiplier: 0.8 },
          speed: { range: [0.5, 3], multiplier: 0.2 },
          depthDifference: { range: [0.02, 0.2], multiplier: 0.5 },
          multiplier: 0.08,
          maximum: 1,
          depthRestrictionRangeM: [0, 0.1],
          speedRestrictionRangeMPerSec: [0, 0.2],
        },
      },
      followPawn: !river,
      waterInfoRequired: true,
      debug: { enabled: false, writers: [], foamEmission: false },
      beautyEnabled: !river,
      materialGuids: [],
      normalRtFormat: 'rgba16float',
    });
    const noiseData = new Uint8Array(64 * 64 * 4);
    let seed = 0x73fa1821;
    for (let i = 0; i < 64 * 64; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const value = seed >>> 24;
      noiseData.set([value, value, value, 255], i * 4);
    }
    const noise: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 64, height: 64 } },
      format: 'rgba8unorm',
      data: noiseData,
      colorSpace: 'linear',
      mips: { kind: 'none' },
    };
    const common = {
      kind: 'water-simulation-recipe' as const,
      system: 'water-advanced' as const,
      configurationVersion: 1 as const,
      materialGuids: [],
      textureGuids: [],
    };
    const oceanPatchConfig: NonNullable<WaterAdvancedSimulationSource['oceanPatchConfig']> = {
      algorithm: 'ocean-spectrum-fft/2',
      windAngleDegrees: 180,
      windSpeedMPerSec: 4,
      noiseTextureGuid: guid('texture/ocean-phase'),
      fftResolution: 128,
      domainLengthM: 16,
      normalDomainSizeM: 16,
      gravityMPerSec2: 9.8,
      phillipsAmplitude: 0.0064,
      windAlignment: 0,
      // Compensate the legacy FFT phase factor for gravity-wave propagation in this 16 m domain.
      timeScale: 1 / (0.1 * Math.sqrt((2 * Math.PI) / 16)),
      slosh: 1,
      chopHack: 0,
      twiddle: 'positive',
      normalization: 'none',
      normalRtFormat: 'rgba16float',
      gridMesh: null,
    };
    const materialEntries = await Promise.all(
      (
        [
          'shallow',
          'shallow-off',
          'river',
          'river-off',
          'river-fft',
          'ocean',
          'ocean-active',
        ] as const
      ).map(async (name) => {
        const material = await resolveDemoMaterialSource(
          {
            kind: 'material',
            parent:
              family.guids[
                name.startsWith('river') ? 'river' : name.startsWith('ocean') ? 'ocean' : 'lake'
              ],
            staticSwitches: {
              waterWaves: false,
              waterFlowmap: false,
              waterNormalTexture: false,
              waterFoam: false,
              waterOceanFoam: false,
              waterShallowSimulation:
                name === 'shallow' || name === 'river' || name === 'river-fft',
              waterOceanPatch: name === 'ocean-active' || name === 'river-fft',
              waterOceanDisplacement: name === 'ocean-active',
              waterDynamicBoundsClip: false,
            },
            values: {
              absorptionPerM: [0.22, 0.075, 0.045],
              scatteringPerM: [0.025, 0.055, 0.065],
              roughness: 0.065,
              fresnelRoughness: 0.12,
              waterAlbedo: [0.55, 0.85, 0.82],
              specular: 0.35,
              refractionPixelNormalStrength: 1.005,
              distantRefractionPixelNormalStrength: 1.001,
              foamRoughness: 0.45,
              oceanPatchDomainM: 16,
              oceanPatchNormalStrength: 1,
            },
          } satisfies MaterialAsset,
          readByGuid,
        );
        return [`material/water/${name}`, material] as const;
      }),
    );
    const materials: Record<string, MaterialAsset> = {};
    for (const [key, material] of materialEntries) {
      if (!material.ok) return material;
      materials[key] = material.value;
    }
    const terrainSurface = terrainPresentation(guid);
    const terrainMaterial = {
      ...terrainSurface.rock,
      values: { ...terrainSurface.rock.values, baseColor: [0.47, 0.54, 0.52, 1], roughness: 0.8 },
    };
    const terrain = buildTerrainAssets(
      {
        columns: 57,
        rows: 29,
        spacing: 2,
        subsectionVertices: 8,
        heights: new Float32Array(57 * 29).fill(-2.5),
        weights: new Float32Array(57 * 29).fill(1),
        layers: [{ material: guid('material/bed'), blend: 'weight' }],
      },
      (key) => guid(`terrain/reach/${key}`),
      {
        [guid('material/bed')]: terrainMaterial,
        ...Object.fromEntries(
          Object.entries(terrainSurface.textures).map(([key, texture]) => [guid(key), texture]),
        ),
      },
    );
    if (!terrain.ok) return terrain;
    const sphere = createSphereGeometry(1, 32, 20).unwrap();
    const fieldSphere = createSphereGeometry(1, 24, 16).unwrap();
    const field = await cookMeshDistanceFieldProduct(
      fieldSphere,
      guid('mesh/df-sphere'),
      { resolution: 32 },
      [0],
    );
    const attached = await decodeMeshDistanceFieldAttachment(
      fieldSphere,
      field.payload,
      field.artifacts['distance-field.bin'].bytes,
    );
    if (!attached.ok) return attached;
    const shallowRecipe = (
      collisions: NonNullable<
        WaterAdvancedSimulationSource['shallowStageConfig']
      >['rigidMeshCollisions'],
    ) => ({
      ...common,
      enabledFeatures: ['shallow'] as const,
      shallowStageConfig: shallowConfig(false, collisions),
      substepConfig: {
        numSteps: 2,
        simSpeed: 1,
        timeStepSource: 'frame-delta' as const,
        deltaLimit: { kind: 'application-cap' as const, maximumDeltaSeconds: 1 / 60 },
      },
    });
    return ok({
      ...built.value,
      ...terrainSurface.textures,
      ...materials,
      ...Object.fromEntries(
        Object.entries(terrain.value).map(([key, asset]) => [`terrain/reach/${key}`, asset]),
      ),
      'material/bed': terrainMaterial,
      'material/stone': {
        kind: 'material',
        parent: presentationGuid('material/limestone'),
        values: {},
      },
      'material/wood': { kind: 'material', parent: presentationGuid('material/wood'), values: {} },
      'material/brass': {
        kind: 'material',
        parent: presentationGuid('material/brass'),
        values: {},
      },
      'material/edge': {
        kind: 'material',
        parent: presentationGuid('material/rock'),
        values: { baseColor: [0.2, 0.25, 0.24, 1], roughness: 0.82 },
      },
      'material/red': standard([0.8, 0.065, 0.035, 1], 0.28),
      'material/yellow': standard([0.95, 0.7, 0.06, 1], 0.3),
      'material/teal': standard([0.025, 0.48, 0.36, 1], 0.3),
      'material/white': standard([0.9, 0.93, 0.91, 1], 0.22),
      'material/metal': standard([0.65, 0.7, 0.72, 1], 0.09, 0.95),
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/sphere': sphere,
      'mesh/capsule': createCapsuleGeometry(0.5, 2, 12, 24).unwrap(),
      'mesh/df-sphere': { ...fieldSphere, distanceField: attached.value },
      'mesh/ring': createTorusGeometry(1, 0.12, 16, 48).unwrap(),
      'texture/ocean-phase': noise,
      'recipe/shallow': shallowRecipe(rigid('simple')),
      'recipe/shallow-accurate': shallowRecipe(rigid('simple', true)),
      'recipe/shallow-distance-field': shallowRecipe(rigid('distance-field', true)),
      'recipe/shallow-water-height': shallowRecipe(rigid('distance-field', true, true)),
      'recipe/shallow-disabled': shallowRecipe({ kind: 'disabled' }),
      'recipe/river': {
        ...common,
        enabledFeatures: ['shallow', 'riverBake'],
        shallowStageConfig: shallowConfig(true),
        substepConfig: {
          numSteps: 10,
          simSpeed: 1,
          timeStepSource: 'frame-delta',
          deltaLimit: { kind: 'application-cap', maximumDeltaSeconds: 1 / 60 },
        },
        riverBakeConfig: {
          sourceBodyGuid: guid('body/river'),
          outputSourceKey: 'river/baked',
          bakeExtentM: [24, 28],
          queryFootprint: [
            [-12, -14],
            [12, -14],
            [12, 14],
            [-12, 14],
          ],
        },
      },
      'recipe/ocean': {
        ...common,
        enabledFeatures: ['oceanPatch'],
        textureGuids: [guid('texture/ocean-phase')],
        oceanPatchConfig,
      },
      'recipe/ocean-grid': {
        ...common,
        enabledFeatures: ['oceanPatch'],
        textureGuids: [guid('texture/ocean-phase')],
        oceanPatchConfig: { ...oceanPatchConfig, gridMesh: { extentM: [16, 16] } },
      },
    });
  },
});
