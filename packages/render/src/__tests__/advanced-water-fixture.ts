import { World } from '@forgeax/engine-ecs';
import { definePackageId } from '@forgeax/engine-pack/source';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { WaterShallowCollider } from '@forgeax/engine-scene';
import type { WaterAdvancedSimulationSource } from '@forgeax/engine-types';
import { buildWaterPackOutputs, WATER_SYSTEM_RESOURCE, WaterSystem } from '@forgeax/engine-water';
import { MeshFilter } from '../components/mesh-filter';
import type { RenderFeatureExtractContext } from '../features/types';
import { testAssets } from './helpers/runtime-assets';

export const ADVANCED_RECIPE = '019ffa97-7000-7000-8000-000000000011';
export const ADVANCED_BODY = '019ffa97-7000-7000-8000-000000000012';

export async function advancedWaterFixture(
  collisions: NonNullable<
    WaterAdvancedSimulationSource['shallowStageConfig']
  >['rigidMeshCollisions'] = {
    kind: 'simple',
    accurate: false,
    useWaterHeightForCollision: false,
    collisionGroups: 0xffff_ffff,
    collisionOffsetCells: 0,
    overlapThicknessCells: 1,
    softCollisionFalloffM: 0.3,
    maxElements: 100,
  },
  enabledFeatures: WaterAdvancedSimulationSource['enabledFeatures'] = ['shallow'],
  bodyType: 'lake' | 'ocean' = 'lake',
) {
  const recipe: WaterAdvancedSimulationSource & {
    readonly kind: 'water-simulation-recipe';
    readonly shallowStageConfig: NonNullable<WaterAdvancedSimulationSource['shallowStageConfig']>;
  } = {
    kind: 'water-simulation-recipe',
    system: 'water-advanced',
    configurationVersion: 1,
    enabledFeatures,
    materialGuids: [],
    textureGuids: [],
    shallowStageConfig: {
      stageProfile: 'water-body-shallow/2',
      gridResolution: [8, 8],
      extentM: [8, 12],
      baseHeightM: 2,
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
      normalSmoothingRadiusCells: 0,
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
      beautyEnabled: true,
      materialGuids: [],
      normalRtFormat: 'rgba16float',
    },
    substepConfig: {
      numSteps: 2,
      simSpeed: 1,
      timeStepSource: 'frame-delta',
      deltaLimit: { kind: 'application-cap', maximumDeltaSeconds: 1 / 60 },
    },
  };
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: bodyType,
          ...(bodyType === 'ocean'
            ? { oceanExtentM: [128, 128] as const, centerOnWaterZone: false }
            : {}),
          surfaceMaterialGuid: ADVANCED_RECIPE,
          baseHeightM: 2,
          overlapPriority: 0,
          maxWaveHeightM: 0.5,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'polygon', enabled: false },
          spline: {
            closed: true,
            points: (
              [
                [-4, -6],
                [4, -6],
                [4, 6],
                [-4, 6],
              ] as const
            ).map(([x, z], inputKey) => ({
              inputKey,
              positionM: [x, 2, z] as const,
              arriveTangentM: [0, 0, 0] as const,
              leaveTangentM: [0, 0, 0] as const,
              up: [0, 1, 0] as const,
              rollAngle: 0,
              angleUnit: 'degrees' as const,
              widthM: 8,
              depthM: 2.5,
              velocityMPerSec: 0,
              audioIntensity: 0,
            })),
          },
          queryFootprint: [
            [-4, -6],
            [4, -6],
            [4, 6],
            [-4, 6],
          ],
        },
      },
      { packageId: definePackageId(ADVANCED_RECIPE) },
    )
  ).unwrap();
  const water = new WaterSystem(() => undefined);
  water
    .mountBody(
      ADVANCED_BODY,
      'body-v1',
      packed.body,
      ADVANCED_BODY,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 4, 20, 1],
    )
    .unwrap();
  const simulation = water
    .createAdvancedSimulation(
      { guid: ADVANCED_RECIPE, contentVersion: 'recipe-v1', asset: recipe },
      ADVANCED_BODY,
    )
    .unwrap();
  const update = (timeSeconds = 1) =>
    simulation
      .update({ deltaSeconds: 1 / 60, timeSeconds, centerXZ: [10, 20], yawRadians: 0 })
      .unwrap();
  update();
  const frame = simulation.frame();
  if (!frame) throw new Error('expected the real mounted WaterSystem query to be ready');
  const world = new World();
  const assets = testAssets(world);
  world.components.register(WaterShallowCollider).unwrap();
  world.components.register(MeshFilter).unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  const context: RenderFeatureExtractContext = {
    world,
    frameNumber: 1,
    views: [{ identity: 'main', render: true }],
  };
  return { world, assets, water, simulation, recipe, frame, context, update };
}

/** Partial native adapter for the exact capabilities exercised by these Water cases. */
export function advancedPhysicsFixture(overrides: Partial<PhysicsWorld>): PhysicsWorld {
  // Preserve the original adapter shape: adding unrelated methods changes capability admission.
  return overrides as PhysicsWorld;
}
