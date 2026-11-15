import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createWorldContext, World } from '@forgeax/engine-ecs';

import { meshAssetOutputProducer } from '@forgeax/engine-import';

import { halfFloat } from '@forgeax/engine-math';

import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';

import { definePackageId } from '@forgeax/engine-pack/source';

import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';

import type { Plugin } from '@forgeax/engine-plugin';

import {
  scenePlugin,
  Transform,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine-scene';

import {
  type Asset,
  type AssetHandle,
  type MeshAsset,
  sha256Bytes,
  standardSurfaceParameters,
  type WaterAdvancedSimulationSource,
  type WaterBodyAsset,
  type WaterZoneAsset,
} from '@forgeax/engine-types';

import {
  buildRiverPhysicsCandidateInput,
  buildWaterBodyGeometry,
  buildWaterPackOutputs,
  type WaterAdvancedRecipe,
  type WaterSystem,
  type WaterZoneTerrainProviderInput,
} from '@forgeax/engine-water';

import { describe, expect, it, vi } from 'vitest';

import { runtimeAssets } from '../../../../assets-runtime/src/internal/runtime-assets.js';

import { buildTerrainAssets } from '../../../../terrain/src/closure.js';

import {
  acceptWaterSceneZoneGround,
  intersectWaterTerrainProvidersWithZones,
  reconcileWaterScene,
  WATER_SCENE_STATUS_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  type WaterSceneAssetAccess,
  type WaterSceneStatus,
  waterScenePlugin,
  waterSceneZoneGround,
  waterSceneZoneSnapshot,
} from '../../water-scene-plugin';

import { publishTestAssets } from './publish-runtime-assets';

import { testAssets } from './runtime-assets';

export function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

export const bodyGuid = '019a0000-0000-7000-8000-000000000401';

export const zoneGuid = '019a0000-0000-7000-8000-000000000402';

export const materialGuid = '019a0000-0000-7000-8000-000000000403';

export const childMaterialGuid = '019a0000-0000-7000-8000-000000000404';

export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

export const waterTestPackage = definePackageId('019a0000-0000-7000-8000-000000000499');

export const oceanPatchRecipe: WaterAdvancedRecipe = {
  guid: '019a0000-0000-7000-8000-000000000498',
  contentVersion: 'sha256:ocean-patch-disposal-test',
  asset: {
    kind: 'water-simulation-recipe',
    system: 'water-advanced',
    configurationVersion: 1,
    enabledFeatures: ['oceanPatch'],
    materialGuids: [],
    textureGuids: [],
    oceanPatchConfig: {
      algorithm: 'mode-projected-gravity/1',
      fftResolution: 32,
      domainLengthM: 16,
      centerXZ: [0, 0],
      baseHeightM: 0,
      referenceDepthM: 4,
      gravityMPerSec2: 9.81,
      sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
      collisions: {
        kind: 'simple',
        collisionGroups: 0xffff_ffff,
        maxElements: 10,
        fieldStepM: 0.1,
        maximumFieldSamplesPerColumn: 128,
      },
      maximumIntervalSeconds: 0.2,
      boundary: { kind: 'periodic' },
      foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
      normalRtFormat: 'rgba32float',
      gridMesh: null,
    },
  },
};

export async function publishWaterMeshTestAssets(
  assets: AssetRegistry,
  entries: readonly RuntimePackAssetInput[],
): Promise<void> {
  const producedEntries: RuntimePackAssetInput[] = [];
  const artifactResponses = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.kind !== 'mesh') {
      producedEntries.push(entry);
      continue;
    }
    const product = (
      await meshAssetOutputProducer.produce({
        guid: entry.guid,
        sourceKey: entry.guid,
        asset: entry.payload as MeshAsset,
      })
    ).unwrap();
    const artifacts = Object.fromEntries(
      Object.entries(product.artifacts).map(([key, artifact]) => {
        const { bytes, ...descriptor } = artifact;
        const path = `${entry.guid}/${key}`;
        artifactResponses.set(path, bytes);
        return [
          key,
          {
            ...descriptor,
            path,
            contentEncoding: 'identity',
            byteLength: bytes.byteLength,
            integrity: { algorithm: 'sha256', digest: `sha256:${sha256Bytes(bytes)}` },
          },
        ];
      }),
    );
    producedEntries.push({
      ...entry,
      payload: product.payload,
      refs: [
        ...new Set([...(entry.refs ?? []), ...product.refs.map((reference) => reference.guid)]),
      ],
      artifacts,
    });
  }
  publishTestAssets(assets, producedEntries, artifactResponses);
}

export function yRotationTransformMatrix(
  position: readonly [number, number, number],
  angleRad: number,
  scale: readonly [number, number, number],
) {
  const cosine = Math.cos(angleRad),
    sine = Math.sin(angleRad);
  return [
    cosine * scale[0],
    0,
    -sine * scale[0],
    0,
    0,
    scale[1],
    0,
    0,
    sine * scale[2],
    0,
    cosine * scale[2],
    0,
    ...position,
    1,
  ] as const;
}

export const staticBody = {
  type: 0,
  mass: 0,
  linearDamping: 0,
  angularDamping: 0,
  gravityScale: 0,
  ccdEnabled: 0,
} as const;

export function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

export async function createWaterPhysics() {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  return createRapier3DPhysicsWorld(module);
}

export function admitRiverCollider(
  physics: ReturnType<typeof createRapier3DPhysicsWorld>,
  entity: number,
  source: WaterBodyAsset,
  revision: number,
) {
  const geometry = buildWaterBodyGeometry(source).unwrap();
  const input = buildRiverPhysicsCandidateInput({
    entity,
    sourceKey: `water:scene-entity:${entity}`,
    revision,
    segments: geometry.riverSegments,
  }).unwrap();
  const candidate = physics.prepareDerivedShapeCandidate(input).unwrap();
  physics.admitDerivedShapeCandidate(candidate).unwrap();
  physics.step(1 / 60);
}

export function body(): WaterBodyAsset {
  return {
    kind: 'water-body',
    type: 'river',
    surfaceMaterialGuid: materialGuid,
    zoneGuid,
    spline: {
      closed: false,
      points: [0, 1].map((inputKey) => ({
        inputKey,
        positionM: [inputKey, 0, 0] as const,
        arriveTangentM: [1, 0, 0] as const,
        leaveTangentM: [1, 0, 0] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 2,
        depthM: 1,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
    baseHeightM: 0,
    overlapPriority: 0,
    maxWaveHeightM: 0,
    flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
    collision: { type: 'river-prism', enabled: true },
    queryFootprint: [
      [0, 0],
      [2, 0],
      [2, 2],
    ],
  };
}

export async function cookedBody(asset: WaterBodyAsset): Promise<WaterBodyAsset> {
  const packed = await buildWaterPackOutputs({ body: asset }, { packageId: waterTestPackage });
  if (!packed.ok || packed.value.body?.kind !== 'water-body')
    throw new Error(`Water test body must cook successfully: ${JSON.stringify(packed)}`);
  return packed.value.body;
}

export function riverBakeRecipeAsset(
  recipeGuid: string,
  textureGuid: string,
  normalTextureGuid: string,
  sourceBodyGuid: string,
  sourceBodyGeneration: number,
  sourceRecipeVersion: string,
  sourceWorldMatrixM: readonly number[],
  sourceGeometryProjectionHash: string,
): WaterAdvancedSimulationSource & { readonly kind: 'water-simulation-recipe' } {
  const resolution = 9;
  const extentM = 4;
  return {
    kind: 'water-simulation-recipe',
    system: 'water-advanced',
    configurationVersion: 1,
    enabledFeatures: ['shallow', 'riverBake', 'oceanPatch'],
    materialGuids: [],
    textureGuids: [textureGuid, normalTextureGuid],
    shallowStageConfig: {
      stageProfile: 'ue-5.8.1-river',
      gridResolution: [resolution, resolution],
      extentM: [extentM, extentM],
      baseHeightM: 0,
      initialDepthM: 4,
      gravityMPerSec2: 9.81,
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
      rigidMeshCollisions: { kind: 'disabled' },
      postSimVelocityBlurRadiusCells: 0,
      normalSmoothingRadiusCells: 1,
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
      followPawn: false,
      waterInfoRequired: false,
      debug: { enabled: false, writers: [], foamEmission: false },
      beautyEnabled: false,
      materialGuids: [],
      normalRtFormat: 'rgba16float',
    },
    substepConfig: {
      numSteps: 2,
      simSpeed: 1,
      timeStepSource: 'frame-delta',
      deltaLimit: { kind: 'application-cap', maximumDeltaSeconds: 1 / 60 },
    },
    riverBakeConfig: {
      sourceBodyGuid,
      outputSourceKey: `river/bake/${recipeGuid}`,
      bakeExtentM: [extentM, extentM],
      queryFootprint: [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ],
      bakedGrid: {
        version: 'water-river-bake/2',
        textureGuid,
        normalTextureGuid,
        normalBasis: 'lattice-axis0-axis1-up/1',
        sourceRecipeGuid: recipeGuid,
        sourceRecipeVersion,
        sourceBodyGuid,
        sourceBodyGeneration,
        simulationGeneration: 1,
        sequence: 1,
        frameId: 1,
        deviceGeneration: 0,
        graphGeneration: 1,
        width: resolution,
        height: resolution,
        originXZ: [-2 + extentM / resolution / 2, -2 + extentM / resolution / 2],
        originYM: 0,
        spacingXZ: [extentM / resolution, extentM / resolution],
        sourceWorldMatrixM,
        sourceGeometryProjectionHash,
        sourceFrame: { generation: 1, sequence: 1, step: 1, timeSeconds: 1 / 60 },
      },
    },
    oceanPatchConfig: {
      algorithm: 'mode-projected-gravity/1',
      fftResolution: 32,
      domainLengthM: 16,
      centerXZ: [0, 0],
      baseHeightM: 0,
      referenceDepthM: 4,
      gravityMPerSec2: 9.81,
      sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
      collisions: {
        kind: 'simple',
        collisionGroups: 0xffff_ffff,
        maxElements: 10,
        fieldStepM: 0.1,
        maximumFieldSamplesPerColumn: 128,
      },
      maximumIntervalSeconds: 0.2,
      boundary: { kind: 'periodic' },
      foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
      normalRtFormat: 'rgba32float',
      gridMesh: null,
    },
  };
}

export function riverBakeTexture(heightM: number): TextureAsset {
  const samples = new Float32Array(9 * 9 * 4);
  for (let index = 0; index < 9 * 9; index++) samples.set([heightM, 4, 0, 0], index * 4);
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 9, height: 9 } },
    format: 'rgba16float',
    data: halfFloat.f32ToF16Bytes(new Uint8Array(samples.buffer)),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

export function riverBakeNormalTexture(
  normal: readonly [number, number, number] = [0, 0, 1],
): TextureAsset {
  const samples = new Float32Array(9 * 9 * 4);
  for (let index = 0; index < 9 * 9; index++)
    samples.set([normal[0], normal[1], normal[2], 0], index * 4);
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 9, height: 9 } },
    format: 'rgba16float',
    data: halfFloat.f32ToF16Bytes(new Uint8Array(samples.buffer)),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

export function lLake(): WaterBodyAsset {
  const coordinates = [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 6],
    [0, 6],
  ] as const;
  const points = coordinates.map(([x, z], inputKey) => ({
    inputKey,
    positionM: [x, 0, z] as const,
    arriveTangentM: [0, 0, 0] as const,
    leaveTangentM: [0, 0, 0] as const,
    up: [0, 1, 0] as const,
    rollAngle: 0,
    angleUnit: 'degrees' as const,
    widthM: 1,
    depthM: 2,
    velocityMPerSec: 0,
    audioIntensity: 0,
  }));
  return {
    ...body(),
    type: 'lake',
    spline: { closed: true, points },
    collision: { type: 'polygon', enabled: true, channelDepthM: 4 },
    queryFootprint: coordinates,
  };
}

export function lRiver(): WaterBodyAsset {
  const points = [
    { positionM: [0, 0, 0], arriveTangentM: [6, 0, 0], leaveTangentM: [6, 0, 0] },
    { positionM: [6, 0, 0], arriveTangentM: [6, 0, 0], leaveTangentM: [0, 0, 6] },
    { positionM: [6, 0, 6], arriveTangentM: [0, 0, 6], leaveTangentM: [0, 0, 6] },
  ] as const;
  return {
    ...body(),
    spline: {
      closed: false,
      points: points.map((point, inputKey) => ({
        ...point,
        inputKey,
        positionM: point.positionM as readonly [number, number, number],
        arriveTangentM: point.arriveTangentM as readonly [number, number, number],
        leaveTangentM: point.leaveTangentM as readonly [number, number, number],
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 2,
        depthM: 1,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
  };
}

export const zone: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 8, spanZM: 8 },
  tileSizeM: 2,
  tessellationFactor: 2,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 16, heightPx: 16 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};

export function registerWaterZoneTerrainProviderTests(): void {
  describe('WaterZone Terrain provider intersection', () => {
    it('associates independent Landscape providers to every overlapping Zone in stable entity order', () => {
      const input = (
        entity: number,
        minX: number,
        maxX: number,
      ): WaterZoneTerrainProviderInput => ({
        entity,
        terrainGuid: `terrain/${entity}`,
        terrainVersion: entity,
        worldMatrixM: identity,
        boundsXZ: { minM: [minX, 0], maxM: [maxX, 8] },
      });
      const mapped = intersectWaterTerrainProvidersWithZones(
        [
          { guid: 'zone/b', boundsXZ: { minM: [8, 0], maxM: [16, 8] } },
          { guid: 'zone/a', boundsXZ: { minM: [0, 0], maxM: [8, 8] } },
        ],
        [input(9, 12, 20), input(5, 2, 10), input(2, 40, 48)],
      );
      expect([...mapped.keys()]).toEqual(['zone/a', 'zone/b']);
      expect(mapped.get('zone/a')?.map(({ entity }) => entity)).toEqual([5]);
      expect(mapped.get('zone/b')?.map(({ entity }) => entity)).toEqual([5, 9]);
    });

    it('defers Zones when an unreadable Terrain revision may expand or move into them', async () => {
      const world = new World();
      const assets = testAssets(world);
      const zoneAGuid = '019a0000-0000-7000-8000-000000000510';
      const zoneBGuid = '019a0000-0000-7000-8000-000000000511';
      const terrainAGuid = '019a0000-0000-7000-8000-000000000512';
      const terrainBGuid = '019a0000-0000-7000-8000-000000000513';
      const terrainMaterialGuid = '019a0000-0000-7000-8000-000000000514';
      const terrainMaterial = {
        kind: 'material' as const,
        colorSpace: 'linear' as const,
        parameters: standardSurfaceParameters([]),
        values: { baseColor: [0.25, 0.5, 0.75, 1] },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
      };
      const derivedGuids = new Map<string, string>();
      const derivedGuid = (key: string) => {
        let guid = derivedGuids.get(key);
        if (!guid) {
          guid = `019a0000-0000-7000-8000-${(0x515 + derivedGuids.size).toString(16).padStart(12, '0')}`;
          derivedGuids.set(key, guid);
        }
        return guid;
      };
      const terrainSource = (columns: number) => ({
        columns,
        rows: 2,
        spacing: 2,
        subsectionVertices: 2,
        heights: new Float32Array(columns * 2),
        weights: new Float32Array(columns * 2).fill(1),
        layers: [{ material: terrainMaterialGuid, blend: 'weight' as const }],
      });
      const baseOutputs = buildTerrainAssets(terrainSource(4), derivedGuid, {
        [terrainMaterialGuid]: terrainMaterial,
      }).unwrap();
      const baseTerrain = baseOutputs.terrain as Extract<Asset, { kind: 'terrain' }>;
      const terrainRefs = [
        ...new Set([
          ...baseTerrain.grids,
          ...baseTerrain.layers.map((layer) => layer.material),
          ...baseTerrain.sections.flatMap((section) => [
            section.heightTexture,
            section.weightTexture,
            section.material,
          ]),
        ]),
      ];
      const terrainClosureEntries = Object.entries(baseOutputs)
        .filter(([key]) => key !== 'terrain')
        .map(([key, payload]) => ({
          guid: derivedGuid(key),
          kind: payload.kind,
          refs:
            payload.kind === 'material'
              ? [
                  derivedGuid('height'),
                  derivedGuid('section/0/weights'),
                  derivedGuid('control-sampler'),
                ]
              : [],
          artifacts: {},
          payload,
        }));
      terrainClosureEntries.push({
        guid: terrainMaterialGuid,
        kind: 'material',
        refs: [],
        artifacts: {},
        payload: terrainMaterial,
      });
      const expandedTerrain = buildTerrainAssets(
        terrainSource(10),
        (key) =>
          `019a0000-0000-7000-8000-${(0x600 + [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0)).toString(16).padStart(12, '0')}`,
        { [terrainMaterialGuid]: terrainMaterial },
      ).unwrap().terrain as Extract<Asset, { kind: 'terrain' }>;
      publishTestAssets(assets, [
        { guid: zoneAGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
        { guid: zoneBGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
        ...terrainClosureEntries,
        {
          guid: terrainAGuid,
          kind: 'terrain',
          payload: baseTerrain,
          refs: terrainRefs,
          artifacts: {},
        },
        {
          guid: terrainBGuid,
          kind: 'terrain',
          payload: baseTerrain,
          refs: terrainRefs,
          artifacts: {},
        },
      ]);
      const zoneAHandle = (await assets.load(zoneAGuid, 'water-zone')).unwrap();
      const zoneBHandle = (await assets.load(zoneBGuid, 'water-zone')).unwrap();
      const terrainAHandle = (await assets.load(terrainAGuid, 'terrain')).unwrap();
      const terrainBHandle = (await assets.load(terrainBGuid, 'terrain')).unwrap();
      const provideAssets: Plugin = {
        name: 'test-assets',
        provide: 'assets',
        apply(ctx) {
          ctx.provide('assets', assets);
        },
      };
      const ctx = await createWorldContext(world, [
        provideAssets,
        scenePlugin(),
        waterScenePlugin(),
      ]);
      try {
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: WaterZoneInstance, data: { zone: zoneAHandle } },
          )
          .unwrap();
        const zoneBEntity = world
          .spawn(
            { component: Transform, data: { pos: [12, 0, 0] } },
            { component: WaterZoneInstance, data: { zone: zoneBHandle } },
          )
          .unwrap();
        const providerB = world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: WaterTerrainProvider, data: { terrain: terrainBHandle } },
          )
          .unwrap();
        const atX = (x: number) => [...identity.slice(0, 12), x, 0, 0, 1] as const;
        const metadata = new Map<number, { guid: string; payload: Asset }>([
          [Number(zoneAHandle), { guid: zoneAGuid, payload: zone }],
          [Number(zoneBHandle), { guid: zoneBGuid, payload: zone }],
          [Number(terrainAHandle), { guid: terrainAGuid, payload: baseTerrain }],
          [Number(terrainBHandle), { guid: terrainBGuid, payload: baseTerrain }],
        ]);
        const baseTerrainVersion = runtimeAssets(assets).version(terrainBHandle).unwrap();
        let unreadableTerrainB = false;
        let terrainBVersion = baseTerrainVersion;
        let providerBX = 0;
        let liveZoneA = zone;
        let zoneAReadCount = 0;
        const access: WaterSceneAssetAccess = {
          sourceGuid: (handle) => metadata.get(handle)?.guid,
          version: (handle) =>
            metadata.get(handle)?.guid === terrainBGuid
              ? terrainBVersion
              : runtimeAssets(assets)
                  .version(handle as AssetHandle)
                  .unwrap(),
          read: (handle) => {
            const asset = metadata.get(handle);
            if (!asset) return undefined;
            if (asset.guid === zoneAGuid) {
              zoneAReadCount += 1;
              return liveZoneA;
            }
            if (asset.guid === terrainBGuid && unreadableTerrainB) return undefined;
            if (asset.guid === terrainBGuid && terrainBVersion > baseTerrainVersion)
              return expandedTerrain;
            return asset.payload;
          },
        };
        const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
        const status = world.getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE);
        const reconcile = () =>
          reconcileWaterScene(world, access, water, status, (entity) =>
            entity === zoneBEntity ? atX(12) : entity === providerB ? atX(providerBX) : identity,
          );
        world.update(1 / 60).unwrap();
        reconcile();

        const initialA = requiredValue(
          water.zoneGroundQuerySnapshot(zoneAGuid),
          'zone A ground snapshot',
        );
        const initialB = requiredValue(
          water.zoneGroundQuerySnapshot(zoneBGuid),
          'zone B ground snapshot',
        );
        expect(initialA.providers.map(({ entity }) => entity)).toEqual([providerB]);
        expect(initialB.providers).toEqual([]);
        expect(water.acceptZoneGround(zoneAGuid, initialA.generation)).toMatchObject({ ok: true });
        expect(water.acceptZoneGround(zoneBGuid, initialB.generation)).toMatchObject({ ok: true });

        liveZoneA = {
          ...zone,
          waterInfo: { ...zone.waterInfo, resolution: { widthPx: 32, heightPx: 16 } },
        };
        reconcile();
        expect(zoneAReadCount).toBe(2);
        expect(waterSceneZoneSnapshot(world, zoneAGuid)?.asset).toBe(liveZoneA);
        expect(waterSceneZoneSnapshot(world, zoneAGuid)?.asset.waterInfo.resolution.widthPx).toBe(
          32,
        );
        expect(Object.isFrozen(liveZoneA)).toBe(false);

        unreadableTerrainB = true;
        terrainBVersion = baseTerrainVersion + 1;
        reconcile();

        expect(water.zoneGroundQuerySnapshot(zoneAGuid)).toMatchObject({ pending: true });
        expect(water.zoneGroundQuerySnapshot(zoneBGuid)).toMatchObject({
          generation: initialB.generation,
          pending: true,
          providers: [],
        });

        unreadableTerrainB = false;
        reconcile();
        expect(
          water.zoneGroundQuerySnapshot(zoneAGuid)?.providers.map(({ entity }) => entity),
        ).toEqual([providerB]);
        expect(water.zoneGroundQuerySnapshot(zoneBGuid)).toMatchObject({
          generation: expect.any(Number),
          pending: false,
          providers: [
            {
              entity: providerB,
              terrainGuid: terrainBGuid,
              terrainVersion: baseTerrainVersion + 1,
            },
          ],
        });
        expect(
          requiredValue(water.zoneGroundQuerySnapshot(zoneBGuid), 'zone B ground snapshot')
            .generation,
        ).toBeGreaterThan(initialB.generation);

        providerBX = 12;
        world.set(providerB, Transform, { pos: [12, 0, 0] }).unwrap();
        unreadableTerrainB = true;
        terrainBVersion = baseTerrainVersion + 2;
        reconcile();
        expect(water.zoneGroundQuerySnapshot(zoneAGuid)).toMatchObject({ pending: true });
        expect(water.zoneGroundQuerySnapshot(zoneBGuid)).toMatchObject({ pending: true });

        unreadableTerrainB = false;
        reconcile();
        expect(water.zoneGroundQuerySnapshot(zoneAGuid)).toMatchObject({
          pending: false,
          providers: [],
        });
        expect(water.zoneGroundQuerySnapshot(zoneBGuid)).toMatchObject({
          pending: false,
          providers: [
            {
              entity: providerB,
              terrainGuid: terrainBGuid,
              terrainVersion: baseTerrainVersion + 2,
            },
          ],
        });
      } finally {
        await ctx.fiber.dispose();
        assets.dispose();
      }
    });

    it('reconciles independent Scene Zone and Terrain entities through world transforms and Registry revisions', async () => {
      const world = new World();
      const assets = testAssets(world);
      const groundZoneGuid = '019a0000-0000-7000-8000-000000000405';
      const groundTerrainGuid = '019a0000-0000-7000-8000-000000000406';
      const layerMaterialGuid = '019a0000-0000-7000-8000-000000000407';
      const terrainDerivedGuids = new Map<string, string>();
      const terrainDerivedGuid = (key: string) => {
        let guid = terrainDerivedGuids.get(key);
        if (!guid) {
          guid = `019a0000-0000-7000-8000-${(0x408 + terrainDerivedGuids.size).toString(16).padStart(12, '0')}`;
          terrainDerivedGuids.set(key, guid);
        }
        return guid;
      };
      const layerMaterial = {
        kind: 'material' as const,
        colorSpace: 'linear' as const,
        parameters: standardSurfaceParameters([]),
        values: { baseColor: [0.25, 0.5, 0.75, 1] },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
      };
      const terrainOutputs = buildTerrainAssets(
        {
          columns: 4,
          rows: 2,
          spacing: 2,
          subsectionVertices: 2,
          heights: new Float32Array(8),
          weights: new Float32Array(8).fill(1),
          layers: [{ material: layerMaterialGuid, blend: 'weight' }],
        },
        terrainDerivedGuid,
        { [layerMaterialGuid]: layerMaterial },
      ).unwrap();
      const terrainAsset = terrainOutputs.terrain as Extract<Asset, { kind: 'terrain' }>;
      const terrainEntries = Object.entries(terrainOutputs)
        .filter(([key]) => key !== 'terrain')
        .map(([key, payload]) => ({
          guid: terrainDerivedGuid(key),
          kind: payload.kind,
          refs:
            payload.kind === 'material'
              ? [
                  terrainDerivedGuid('height'),
                  terrainDerivedGuid('section/0/weights'),
                  terrainDerivedGuid('control-sampler'),
                ]
              : [],
          artifacts: {},
          payload,
        }));
      terrainEntries.push({
        guid: layerMaterialGuid,
        kind: 'material',
        refs: [],
        artifacts: {},
        payload: layerMaterial,
      });
      terrainEntries.push({
        guid: groundTerrainGuid,
        kind: 'terrain',
        refs: [
          ...new Set([
            ...terrainAsset.grids,
            ...terrainAsset.layers.map((layer) => layer.material),
            ...terrainAsset.sections.flatMap((section) => [
              section.heightTexture,
              section.weightTexture,
              section.material,
            ]),
          ]),
        ],
        artifacts: {},
        payload: terrainAsset,
      });
      publishTestAssets(assets, [
        { guid: groundZoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
        ...terrainEntries,
      ]);
      const zoneHandle = (await assets.load(groundZoneGuid, 'water-zone')).unwrap();
      const terrainHandle = (await assets.load(groundTerrainGuid, 'terrain')).unwrap();
      const provideAssets: Plugin = {
        name: 'test-assets',
        provide: 'assets',
        apply(ctx) {
          ctx.provide('assets', assets);
        },
      };
      const ctx = await createWorldContext(world, [
        provideAssets,
        scenePlugin(),
        waterScenePlugin(),
      ]);
      const registryRead = vi.spyOn(assets, 'read');
      const readsFor = (handle: number) =>
        registryRead.mock.calls.filter(([readHandle]) => Number(readHandle) === handle).length;
      try {
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: WaterZoneInstance, data: { zone: zoneHandle } },
          )
          .unwrap();
        world.update(1 / 60).unwrap();

        const zoneReads = readsFor(Number(zoneHandle));
        expect(zoneReads).toBe(1);
        const exposedZone = requiredFixtureValue(waterSceneZoneSnapshot(world, groundZoneGuid));
        expect(exposedZone.asset).not.toBe(zone);
        expect(Object.isFrozen(exposedZone.asset)).toBe(true);
        expect(Object.isFrozen(exposedZone.asset.extentM)).toBe(true);
        expect(Object.isFrozen(exposedZone.asset.waterInfo.resolution)).toBe(true);
        world.update(1 / 60).unwrap();
        expect(readsFor(Number(zoneHandle))).toBe(zoneReads);

        const guid = groundZoneGuid;
        const read = () => requiredFixtureValue(waterSceneZoneGround(world, guid).unwrap());
        const empty = read();
        expect(empty.providers).toEqual([]);
        expect(empty.dirty).toBe(true);
        const emptyGeneration = empty.generation;
        const providerEntity = world
          .spawn(
            { component: Transform, data: { pos: [4, 0, 0] } },
            { component: WaterTerrainProvider, data: { terrain: terrainHandle } },
          )
          .unwrap();
        world.update(1 / 60).unwrap();
        const terrainReads = readsFor(Number(terrainHandle));
        expect(terrainReads).toBe(1);
        const initial = read();
        expect(initial.generation).toBeGreaterThan(emptyGeneration);
        expect(initial.dirty).toBe(true);
        expect(initial.providers).toHaveLength(1);
        expect(initial.providers[0]).toMatchObject({
          entity: providerEntity,
          terrainGuid: groundTerrainGuid,
          terrainVersion: runtimeAssets(assets).version(terrainHandle).unwrap(),
          worldMatrixM: expect.arrayContaining([4]),
        });
        expect(acceptWaterSceneZoneGround(world, guid, initial.generation)).toMatchObject({
          ok: true,
          value: true,
        });
        expect(read().dirty).toBe(false);

        world.update(1 / 60).unwrap();
        expect(readsFor(Number(terrainHandle))).toBe(terrainReads);

        const initialGeneration = initial.generation;
        world.set(providerEntity, Transform, { quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }).unwrap();
        world.update(1 / 60).unwrap();
        const rotated = read();
        expect(rotated.generation).toBe(initialGeneration);
        expect(rotated.providers).toEqual(initial.providers);
        expect(
          world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).zoneGroundQuerySnapshot(guid)
            ?.pending,
        ).toBe(true);

        const rotatedGeneration = rotated.generation;
        world
          .set(providerEntity, Transform, { pos: [4, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] })
          .unwrap();
        world.update(1 / 60).unwrap();
        const restored = read();
        expect(restored.generation).toBe(rotatedGeneration);
        expect(restored.providers[0]?.worldMatrixM).toEqual(initial.providers[0]?.worldMatrixM);
        expect(
          world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).zoneGroundQuerySnapshot(guid)
            ?.pending,
        ).toBe(false);

        const restoredGeneration = restored.generation;
        assets.replace(terrainHandle, { ...terrainAsset, heightRange: [-1, 1] }).unwrap();
        world.update(1 / 60).unwrap();
        const revised = read();
        expect(revised.generation).toBeGreaterThan(restoredGeneration);
        expect(revised.providers[0]?.terrainVersion).toBeGreaterThan(
          requiredFixtureValue(restored.providers[0]).terrainVersion,
        );
        expect(revised.dirty).toBe(true);

        world.set(providerEntity, Transform, { pos: [30, 0, 0] }).unwrap();
        world.update(1 / 60).unwrap();
        const movedOut = read();
        expect(movedOut.providers).toEqual([]);
        const movedOutGeneration = movedOut.generation;

        world.set(providerEntity, Transform, { pos: [0, 0, 0] }).unwrap();
        world.update(1 / 60).unwrap();
        const movedBack = read();
        expect(movedBack.generation).toBeGreaterThan(movedOutGeneration);
        expect(movedBack.providers.map(({ entity }) => entity)).toEqual([providerEntity]);

        world.despawn(providerEntity).unwrap();
        world.update(1 / 60).unwrap();
        const deleted = read();
        expect(deleted.providers).toEqual([]);
        expect(deleted.generation).toBeGreaterThan(movedBack.generation);
        expect(deleted.dirty).toBe(true);
      } finally {
        registryRead.mockRestore();
        await ctx.fiber.dispose();
        assets.dispose();
      }
    });
  });
}
