import { halfFloat } from '@forgeax/engine-math';
import { definePackageId } from '@forgeax/engine-pack/source';
import type { WaterAdvancedSimulationSource } from '@forgeax/engine-types';
import { assert, describe, expect, it } from 'vitest';
import {
  type WaterAdvancedFrame,
  WaterAdvancedSimulation,
  type WaterAdvancedTextureReadback,
  waterAdvancedOutputNames,
} from '../advanced-simulation';
import { WaterOceanPatch } from '../ocean-patch';
import { buildWaterPackOutputs } from '../pack-cook';
import {
  decodeWaterRiverBake,
  prepareWaterRiverBake,
  type WaterRiverBakeCandidate,
} from '../river-bake';
import { WaterSystem } from '../system';
import { validateWaterAsset, waterRiverBakeGeometryProjectionHash } from '../validate';

const RECIPE = '019ffa97-7000-7000-8000-000000000001';
const BODY = '019ffa97-7000-7000-8000-000000000002';
const NOISE = '019ffa97-7000-7000-8000-000000000003';
type Recipe = WaterAdvancedSimulationSource & {
  readonly kind: 'water-simulation-recipe';
} & Required<Pick<WaterAdvancedSimulationSource, 'shallowStageConfig' | 'oceanPatchConfig'>>;

function recipe(river = false): Recipe {
  return {
    kind: 'water-simulation-recipe',
    system: 'water-advanced',
    configurationVersion: 1,
    enabledFeatures: river ? ['shallow', 'riverBake', 'oceanPatch'] : ['shallow', 'oceanPatch'],
    materialGuids: [],
    textureGuids: [NOISE],
    shallowStageConfig: {
      stageProfile: river ? 'ue-5.8.1-river' : 'ue-5.8.1-water-body',
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
      rigidMeshCollisions: { kind: 'disabled' },
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
      followPawn: false,
      waterInfoRequired: false,
      debug: { enabled: false, writers: [], foamEmission: false },
      beautyEnabled: !river,
      materialGuids: [],
      normalRtFormat: 'rgba16float',
    },
    substepConfig: {
      numSteps: 2,
      simSpeed: 1,
      timeStepSource: 'frame-delta',
      deltaLimit: { kind: 'application-cap', maximumDeltaSeconds: 1 / 60 },
    },
    ...(river
      ? {
          riverBakeConfig: {
            sourceBodyGuid: BODY,
            outputSourceKey: 'river/baked',
            bakeExtentM: [8, 12],
            queryFootprint: [
              [-4, -6],
              [4, -6],
              [4, 6],
              [-4, 6],
            ],
          },
        }
      : {}),
    oceanPatchConfig: {
      algorithm: 'ue-5.8.1-niagara-fft',
      windAngleDegrees: 180,
      windSpeedMPerSec: 0.55,
      noiseTextureGuid: NOISE,
      fftResolution: 128,
      domainLengthM: 2.5,
      normalDomainSizeM: 1.5,
      gravityMPerSec2: 9.8,
      phillipsAmplitude: 0.0003,
      windAlignment: 0,
      timeScale: 2.5,
      slosh: 1,
      chopHack: 5,
      twiddle: 'positive',
      normalization: 'none',
      normalRtFormat: 'rgba16float',
      gridMesh: null,
    },
  };
}

function simulation(source = recipe()) {
  return WaterAdvancedSimulation.create(
    { guid: RECIPE, contentVersion: 'sha256:source-version', asset: source },
    { guid: BODY, sourceAssetGuid: BODY, generation: 7 },
  ).unwrap();
}
function rigidRecipe(): Recipe {
  const source = recipe();
  return {
    ...source,
    shallowStageConfig: {
      ...source.shallowStageConfig,
      rigidMeshCollisions: {
        kind: 'simple',
        accurate: false,
        useWaterHeightForCollision: false,
        collisionGroups: 0xffff_ffff,
        collisionOffsetCells: 0,
        overlapThicknessCells: 1,
        softCollisionFalloffM: 0.3,
        maxElements: 100,
      },
    },
  };
}
async function mountedRigidSimulation() {
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'lake',
          surfaceMaterialGuid: NOISE,
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
      { packageId: definePackageId(RECIPE) },
    )
  ).unwrap();
  const system = new WaterSystem(() => undefined);
  const body = system
    .mountBody(
      BODY,
      'body-v1',
      packed.body,
      NOISE,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 4, 20, 1],
      {
        sourceRevision: 'published-body-v1',
        generation: 11,
        digest: 'body-digest',
        outputSetDigest: 'body-set',
      },
    )
    .unwrap();
  const sim = system
    .createAdvancedSimulation(
      { guid: RECIPE, contentVersion: 'rigid-v1', asset: rigidRecipe() },
      BODY,
    )
    .unwrap();
  return { system, body, sim, asset: packed.body };
}
function pending(
  sim: WaterAdvancedSimulation,
  time = 1,
  centerXZ: readonly [number, number] = [10, 20],
): WaterAdvancedFrame {
  sim.update({ deltaSeconds: 1 / 60, timeSeconds: time, centerXZ, yawRadians: 0 }).unwrap();
  const frame = sim.frame();
  if (!frame) throw new Error('expected pending simulation work');
  return frame;
}
function finish(
  sim: WaterAdvancedSimulation,
  time = 1,
  centerXZ: readonly [number, number] = [10, 20],
) {
  const frame = pending(sim, time, centerXZ);
  sim.submitted(frame, frame.stages.length).unwrap();
  const completion = { frameId: frame.sequence, deviceGeneration: 2, graphGeneration: 3 };
  sim.completed(frame, completion).unwrap();
  return { frame, completion };
}
function readback(
  _frame: WaterAdvancedFrame,
  completion: WaterAdvancedTextureReadback['completion'],
  bake = false,
): WaterAdvancedTextureReadback {
  const values = new Float32Array(8 * 4);
  for (let i = 0; i < values.length; i += 4) values.set([0.25013, 2.5008, 1.5008, -0.5001], i);
  const row = halfFloat.f32ToF16Bytes(new Uint8Array(values.buffer));
  const bytes = new Uint8Array(128 * 8).fill(255);
  for (let y = 0; y < 8; y++) bytes.set(row, y * 128);
  return {
    name: waterAdvancedOutputNames(RECIPE, BODY, 'test-world')[bake ? 'bake' : 'grid'],
    width: 8,
    height: 8,
    format: 'rgba16float',
    bytesPerRow: 128,
    bytes,
    completion,
  };
}
function bakeReadbacks(
  frame: WaterAdvancedFrame,
  completion: WaterAdvancedTextureReadback['completion'],
): WaterAdvancedTextureReadback[] {
  const outputNames = waterAdvancedOutputNames(RECIPE, BODY, 'test-world');
  const normalData = new Uint8Array(128 * 8);
  const normalPixel = halfFloat.f32ToF16Bytes(
    new Uint8Array(new Float32Array([0, 0, 1, 0]).buffer),
  );
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 8; column++) normalData.set(normalPixel, row * 128 + column * 8);
  return [
    readback(frame, completion, true),
    {
      name: `${outputNames.prefix}-river-bake-normal`,
      width: 8,
      height: 8,
      format: frame.recipe.asset.shallowStageConfig.normalRtFormat,
      bytesPerRow: 128,
      bytes: normalData,
      completion,
    },
  ];
}
function loadedBakePair(
  candidate: WaterRiverBakeCandidate,
  revisions: Readonly<{ grid: number; normal: number }> = { grid: 17, normal: 18 },
): {
  version: 'water-river-bake/2';
  grid: {
    kind: 'loaded-texture-asset';
    handle: number;
    guid: string;
    revision: number;
    asset: typeof candidate.gridTexture;
  };
  normal: {
    kind: 'loaded-texture-asset';
    handle: number;
    guid: string;
    revision: number;
    asset: typeof candidate.normalTexture;
  };
} {
  const metadata = candidate.recipe.riverBakeConfig?.bakedGrid;
  assert(metadata?.version === 'water-river-bake/2');
  return {
    version: 'water-river-bake/2',
    grid: {
      kind: 'loaded-texture-asset',
      handle: 21,
      guid: metadata.textureGuid,
      revision: revisions.grid,
      asset: candidate.gridTexture,
    },
    normal: {
      kind: 'loaded-texture-asset',
      handle: 22,
      guid: metadata.normalTextureGuid,
      revision: revisions.normal,
      asset: candidate.normalTexture,
    },
  };
}

describe('Water Advanced generation and stage ownership', () => {
  it('freezes the mounted WaterSystem surface and provenance at nonzero world height', async () => {
    const { sim, body } = await mountedRigidSimulation();
    const frame = pending(sim, 3);
    expect(frame.collisionSurface).toEqual({
      status: 'ready',
      bodyGuid: BODY,
      sourceAssetGuid: NOISE,
      sourceVersion: 'body-v1',
      bodyGeneration: body.sceneGeneration,
      sourcePublicationGeneration: 11,
      positionM: [10, 6, 20],
      timeSeconds: 3,
    });
    expect(frame.transform.heightOriginM).toBe(2);
    expect(Object.isFrozen(frame.collisionSurface)).toBe(true);
    if (frame.collisionSurface.status !== 'ready') throw new Error('expected actual surface query');
    expect(Object.isFrozen(frame.collisionSurface.positionM)).toBe(true);
    sim
      .update({
        deltaSeconds: 1 / 60,
        timeSeconds: 4,
        centerXZ: [10, 20],
        yawRadians: 0,
        pawn: { positionM: [11, 99, 21], velocityMPerSec: [0, 0, 0], touchingWater: true },
      })
      .unwrap();
    expect(sim.inspect().collisionSurface).toMatchObject({
      positionM: [11, 6, 21],
      timeSeconds: 4,
    });
    expect(frame.collisionSurface.positionM).toEqual([10, 6, 20]);
  });

  it('retains accepted completion while a changed Body generation waits for its current owner', async () => {
    const { system, sim, asset } = await mountedRigidSimulation();
    const accepted = finish(sim);
    system.hotReloadBody(BODY, 'body-v2', asset, NOISE).unwrap();
    sim
      .update({ deltaSeconds: 1 / 60, timeSeconds: 2, centerXZ: [10, 20], yawRadians: 0 })
      .unwrap();
    expect(sim.inspect()).toMatchObject({
      status: 'waiting-water-surface',
      collisionSurface: {
        status: 'pending',
        reason: 'body-unavailable',
      },
      completion: accepted.completion,
    });
    expect(sim.frame()).toBeUndefined();
    sim.reset();
    expect(sim.frame()).toBeUndefined();
  });

  it('keeps enabled rigid simulation unready without a WaterSystem surface authority', () => {
    const sim = simulation(rigidRecipe());
    sim
      .update({ deltaSeconds: 1 / 60, timeSeconds: 1, centerXZ: [10, 20], yawRadians: 0 })
      .unwrap();
    expect(sim.inspect()).toMatchObject({
      status: 'waiting-water-surface',
      collisionSurface: {
        status: 'pending',
        reason: 'owner-unavailable',
      },
    });
    expect(sim.frame()).toBeUndefined();
    sim.reset();
    expect(sim.frame()).toBeUndefined();
  });

  it('validates the versioned recipe and rejects a caller-authored solver order', () => {
    const source = recipe(true);
    expect(validateWaterAsset(source).ok).toBe(true);
    expect(validateWaterAsset({ ...source, configurationVersion: 2 }).ok).toBe(false);
    expect(
      validateWaterAsset({
        ...source,
        shallowStageConfig: { ...source.shallowStageConfig, stageOrder: ['Update Depth'] },
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...source,
        oceanPatchConfig: { ...source.oceanPatchConfig, fftResolution: 127 },
      }).ok,
    ).toBe(false);
    const rigid = rigidRecipe();
    const settings = rigid.shallowStageConfig.rigidMeshCollisions;
    expect(validateWaterAsset(rigid).ok).toBe(true);
    for (const overlapThicknessCells of [undefined, -1, NaN, Infinity])
      expect(
        validateWaterAsset({
          ...rigid,
          shallowStageConfig: {
            ...rigid.shallowStageConfig,
            rigidMeshCollisions: { ...settings, overlapThicknessCells },
          },
        }).ok,
      ).toBe(false);
    expect(
      validateWaterAsset({
        ...rigid,
        shallowStageConfig: {
          ...rigid.shallowStageConfig,
          rigidMeshCollisions: { ...settings, overlapThicknessCells: 0 },
        },
      }).ok,
    ).toBe(true);
  });

  it('uses one predecessor chain across the River substep loop', () => {
    const sim = simulation(recipe(true));
    finish(sim);
    const tasks = pending(sim, 2).stages;
    expect(tasks.filter((row) => row.stage === 'Pre Sim')).toHaveLength(1);
    expect(tasks.filter((row) => row.stage === 'Update Depth').map((row) => row.substep)).toEqual([
      0, 1,
    ]);
    expect(tasks.at(-1)?.stage).toBe('Live Sim - Blur Normals');
    expect(
      tasks.every(
        (row, ordinal) =>
          row.ordinal === ordinal &&
          row.previousStageOrdinal === (ordinal === 0 ? null : ordinal - 1) &&
          row.step === 2,
      ),
    ).toBe(true);
  });

  it('requires an explicit WaterBody extension for persistent shallow foam', () => {
    const source = recipe();
    const extension = {
      ...source,
      enabledFeatures: [...source.enabledFeatures, 'shallowFoam'] as const,
    };
    expect(validateWaterAsset(extension).ok).toBe(true);
    expect(validateWaterAsset({ ...extension, enabledFeatures: ['shallowFoam'] }).ok).toBe(false);
    const sim = simulation(extension);
    finish(sim);
    const frame = pending(sim, 2);
    expect(frame.stages.filter((row) => row.stage === 'Foam')).toHaveLength(1);
    const ordinary = simulation(source);
    finish(ordinary);
    expect(pending(ordinary, 2).stages.some((row) => row.stage === 'Foam')).toBe(false);
  });

  it('retains queued impacts until a complete non-reset step is submitted', () => {
    const sim = simulation();
    sim
      .enqueueImpact({
        id: 1,
        positionM: [10, 2, 20],
        velocityMPerSec: [1, -2, 0],
        radiusM: 1,
        timeSeconds: 1,
      })
      .unwrap();
    finish(sim);
    expect(sim.inspect().queuedImpacts).toBe(1);
    const frame = pending(sim, 2);
    expect(sim.submitted(frame, frame.stages.length - 1).ok).toBe(false);
    expect(sim.inspect().queuedImpacts).toBe(1);
    sim.submitted(frame, frame.stages.length).unwrap();
    expect(sim.inspect().queuedImpacts).toBe(0);
  });

  it('rejects callbacks from the previous simulation or device generation', () => {
    const sim = simulation();
    sim.requestStageCapture();
    const old = finish(sim);
    sim.deviceLost();
    expect(sim.completed(old.frame, old.completion).ok).toBe(false);
    expect(sim.acceptReadbacks(old.frame, [readback(old.frame, old.completion)]).ok).toBe(false);
    expect(sim.inspect().completion).toBeUndefined();
  });

  it('accepts a completed capture when a later ordinary frame completes first', () => {
    const sim = simulation();
    finish(sim);
    sim.requestStageCapture();
    const captured = pending(sim, 2);
    sim.submitted(captured, captured.stages.length).unwrap();
    finish(sim, 3);
    const completion = { frameId: captured.sequence, deviceGeneration: 2, graphGeneration: 3 };
    sim.completed(captured, completion).unwrap();
    expect(sim.acceptReadbacks(captured, [readback(captured, completion)]).ok).toBe(true);
    expect(sim.textureReadbacks()[0]?.completion).toEqual(completion);
    expect(sim.inspect().completion?.frameId).toBeGreaterThan(completion.frameId);
  });

  it('retires the intent queue and rejects new Bake requests', () => {
    const sim = simulation(recipe(true));
    finish(sim);
    sim.retire();
    expect(
      sim.enqueueImpact({
        id: 1,
        positionM: [0, 0, 0],
        velocityMPerSec: [0, 0, 0],
        radiusM: 1,
        timeSeconds: 1,
      }).ok,
    ).toBe(false);
    expect(sim.requestBake().ok).toBe(false);
    expect(sim.frame()).toBeUndefined();
  });

  it('invalidates FFT captures after the noise owner changes revision', () => {
    const sim = WaterOceanPatch.create({
      guid: RECIPE,
      contentVersion: 'sha256:source-version',
      asset: recipe(),
    }).unwrap();
    sim.bindNoiseRevision(1);
    sim.requestStageCapture();
    sim.update(1 / 60).unwrap();
    const frame = sim.frame();
    assert(frame);
    sim.submitted(frame).unwrap();
    const completion = { frameId: 1, deviceGeneration: 2, graphGeneration: 3 };
    sim.completed(frame, completion, 1, true).unwrap();
    sim.bindNoiseRevision(2);
    expect(sim.acceptReadbacks(frame, [])).toMatchObject({
      ok: false,
      error: { code: 'water-advanced-stale-generation' },
    });
    expect(sim.inspect().noiseRevision).toBe(2);
  });

  it('keeps a static River alive after fifteen seconds', () => {
    const sim = simulation(recipe(true));
    finish(sim, 100);
    expect(sim.inspect().status).not.toBe('retired');
    expect(sim.inspect().secondsUntilDestroyed).toBe(15);
  });
});

describe('River Bake completion and original lattice', () => {
  it('records the captured Scene pose and Cooked River geometry in v2 Bake metadata', async () => {
    const sourceWorldMatrixM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 4, 20, 1];
    const packed = await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'river',
          surfaceMaterialGuid: NOISE,
          baseHeightM: 2,
          overlapPriority: 0,
          maxWaveHeightM: 0.5,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'river-prism', enabled: true },
          spline: {
            closed: false,
            points: [
              {
                inputKey: 0,
                positionM: [0, 2, -6],
                arriveTangentM: [0, 0, 0],
                leaveTangentM: [1, 0, 0],
                up: [0, 1, 0],
                rollAngle: 0,
                angleUnit: 'degrees',
                widthM: 4,
                depthM: 2.5,
                velocityMPerSec: 0,
                audioIntensity: 0,
              },
              {
                inputKey: 1,
                positionM: [0, 2, 6],
                arriveTangentM: [1, 0, 0],
                leaveTangentM: [0, 0, 0],
                up: [0, 1, 0],
                rollAngle: 0,
                angleUnit: 'degrees',
                widthM: 4,
                depthM: 2.5,
                velocityMPerSec: 0,
                audioIntensity: 0,
              },
            ],
          },
          queryFootprint: [
            [-2, -6],
            [2, -6],
            [2, 6],
            [-2, 6],
          ],
        },
      },
      { packageId: definePackageId(RECIPE), bodyWorldMatrixM: sourceWorldMatrixM },
    );
    assert(packed.ok && packed.value.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    const body = system
      .mountBody(BODY, 'body-v1', packed.value.body, BODY, sourceWorldMatrixM)
      .unwrap();
    assert(body.asset.geometrySnapshot?.collisionDescriptor?.version === 2);
    expect(waterRiverBakeGeometryProjectionHash(body.asset)).toMatch(/^[0-9a-f]{64}$/);
    const sim = system
      .createAdvancedSimulation(
        { guid: RECIPE, contentVersion: 'sha256:source-version', asset: recipe(true) },
        BODY,
      )
      .unwrap();
    finish(sim);
    sim.requestBake().unwrap();
    const captured = finish(sim, 2);
    expect(captured.frame.bakeCapture).toBeDefined();
    sim
      .acceptReadbacks(captured.frame, bakeReadbacks(captured.frame, captured.completion))
      .unwrap();
    const candidate = prepareWaterRiverBake(sim, definePackageId(RECIPE)).unwrap();
    const metadata = candidate.recipe.riverBakeConfig?.bakedGrid;
    assert(metadata !== undefined);
    assert(metadata.version === 'water-river-bake/2');
    expect(metadata.version).toBe('water-river-bake/2');
  });

  it('derives durable outputs from the captured GPU rows and retains world coordinates on cold decode', async () => {
    const packed = await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'river',
          surfaceMaterialGuid: NOISE,
          baseHeightM: 2,
          overlapPriority: 0,
          maxWaveHeightM: 0.5,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'river-prism', enabled: false },
          spline: {
            closed: false,
            points: [
              {
                inputKey: 0,
                positionM: [0, 2, -6],
                arriveTangentM: [0, 0, 0],
                leaveTangentM: [1, 0, 0],
                up: [0, 1, 0],
                rollAngle: 0,
                angleUnit: 'degrees',
                widthM: 4,
                depthM: 2.5,
                velocityMPerSec: 0,
                audioIntensity: 0,
              },
              {
                inputKey: 1,
                positionM: [0, 2, 6],
                arriveTangentM: [1, 0, 0],
                leaveTangentM: [0, 0, 0],
                up: [0, 1, 0],
                rollAngle: 0,
                angleUnit: 'degrees',
                widthM: 4,
                depthM: 2.5,
                velocityMPerSec: 0,
                audioIntensity: 0,
              },
            ],
          },
          queryFootprint: [
            [-2, -6],
            [2, -6],
            [2, 6],
            [-2, 6],
          ],
        },
      },
      { packageId: definePackageId(RECIPE) },
    );
    assert(packed.ok && packed.value.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    system.mountBody(BODY, 'body-v1', packed.value.body, BODY).unwrap();
    const sim = system
      .createAdvancedSimulation(
        { guid: RECIPE, contentVersion: 'sha256:source-version', asset: recipe(true) },
        BODY,
      )
      .unwrap();
    expect(prepareWaterRiverBake(sim, definePackageId(RECIPE)).ok).toBe(false);
    finish(sim);
    sim.requestBake().unwrap();
    const captured = finish(sim, 2);
    sim
      .acceptReadbacks(captured.frame, bakeReadbacks(captured.frame, captured.completion))
      .unwrap();
    const candidate = prepareWaterRiverBake(sim, definePackageId(RECIPE)).unwrap();
    const metadata = candidate.recipe.riverBakeConfig?.bakedGrid;
    assert(metadata !== undefined);
    assert(metadata.version === 'water-river-bake/2');
    expect(metadata.normalTextureGuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(metadata.normalBasis).toBe('lattice-axis0-axis1-up/1');
    expect(metadata).toMatchObject({
      originXZ: [6.5, 14.75],
      originYM: 2,
      spacingXZ: [1, 1.5],
      width: 8,
      height: 8,
      ...captured.completion,
    });
    expect(candidate.recipe.textureGuids).toContain(metadata.textureGuid);
    expect(candidate.recipe.textureGuids).toContain(metadata.normalTextureGuid);
    expect(candidate.gridTextureSourceKey).toBe('river/baked/grid');
    expect(candidate.normalTextureSourceKey).toBe('river/baked/normal');
    const outputTextureRevision = 17;
    const decodeRecipe = structuredClone(candidate.recipe);
    const decodeTextures = structuredClone(candidate);
    const loadedPair = loadedBakePair(decodeTextures, { grid: outputTextureRevision, normal: 19 });
    const grid = decodeWaterRiverBake(decodeRecipe, loadedPair).unwrap();
    expect(grid.lineage).toMatchObject({
      version: 'water-river-bake/2',
      textureGuid: metadata?.textureGuid,
      textureRevision: outputTextureRevision,
      normalTextureGuid: metadata.normalTextureGuid,
      normalTextureRevision: 19,
      normalTextureFormat: 'rgba16float',
      normalBasis: 'lattice-axis0-axis1-up/1',
      sourceRecipeGuid: metadata?.sourceRecipeGuid,
      sourceRecipeVersion: metadata?.sourceRecipeVersion,
      sourceBodyGuid: metadata?.sourceBodyGuid,
      sourceBodyGeneration: metadata?.sourceBodyGeneration,
      simulationGeneration: metadata?.simulationGeneration,
      sequence: metadata?.sequence,
      frameId: metadata?.frameId,
      deviceGeneration: metadata?.deviceGeneration,
      graphGeneration: metadata?.graphGeneration,
      sourceWorldMatrixM: metadata.sourceWorldMatrixM,
      sourceGeometryProjectionHash: metadata.sourceGeometryProjectionHash,
      sourceFrame: metadata.sourceFrame,
    });
    expect(Object.isFrozen(grid.lineage)).toBe(true);
    if (grid.lineage?.version !== 'water-river-bake/2')
      throw new Error('cold decoded Bake must retain version-2 equivalence facts');
    expect(Object.isFrozen(grid.lineage.sourceWorldMatrixM)).toBe(true);
    expect(Object.isFrozen(grid.lineage.sourceFrame)).toBe(true);
    const capturedMatrix = [...metadata.sourceWorldMatrixM];
    const capturedFrame = { ...metadata.sourceFrame };
    const capturedOriginXZ = [...metadata.originXZ];
    const capturedSpacingXZ = [...metadata.spacingXZ];
    const capturedSamples = new Float32Array(grid.samples);
    const mutableMetadata = decodeRecipe.riverBakeConfig?.bakedGrid as
      | (typeof metadata & {
          sourceWorldMatrixM: number[];
          sourceFrame: { generation: number; sequence: number; step: number; timeSeconds: number };
          sourceGeometryProjectionHash: string;
          originXZ: [number, number];
          spacingXZ: [number, number];
        })
      | undefined;
    if (mutableMetadata?.version !== 'water-river-bake/2')
      throw new Error('fixture is missing version-2 metadata');
    mutableMetadata.sourceWorldMatrixM[12] = 999;
    mutableMetadata.sourceGeometryProjectionHash = '0'.repeat(64);
    mutableMetadata.sourceFrame.step = 999;
    mutableMetadata.originXZ[0] = 999;
    mutableMetadata.spacingXZ[0] = 999;
    decodeTextures.gridTexture.data.fill(0);
    expect(grid.lineage.sourceWorldMatrixM).toEqual(capturedMatrix);
    expect(grid.lineage.sourceGeometryProjectionHash).toBe(metadata.sourceGeometryProjectionHash);
    expect(grid.lineage.sourceFrame).toEqual(capturedFrame);
    expect(grid.originXZ).toEqual(capturedOriginXZ);
    expect(grid.spacingXZ).toEqual(capturedSpacingXZ);
    expect(grid.samples).toEqual(capturedSamples);
    const rebound = system
      .hotReloadBody(
        BODY,
        'body-v2',
        { ...packed.value.body, surfaceMaterialGuid: '019ffa97-7000-7000-8000-000000000004' },
        BODY,
      )
      .unwrap();
    expect(grid.lineage.sourceBodyGeneration).not.toBe(rebound.sceneGeneration);
    const ownerSimulationA = system
      .createAdvancedSimulation(
        { guid: RECIPE, contentVersion: 'sha256:owner-a', asset: recipe(true) },
        BODY,
      )
      .unwrap();
    finish(ownerSimulationA);
    expect(
      system.publishBakedQueryGrid(BODY, rebound.sceneGeneration, {
        kind: 'durable-pack',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid,
      }).ok,
    ).toBe(true);
    const retained = system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid;
    assert(retained?.lineage?.version === 'water-river-bake/2');
    const movedMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 4, 40, 1];
    expect(
      system.hotReloadBody(BODY, 'body-v3', packed.value.body, BODY, movedMatrix),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(system.snapshot(BODY)?.sceneGeneration).toBe(rebound.sceneGeneration);
    expect(system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid.samples).toEqual(
      retained?.samples,
    );
    const alteredMatrix = [...grid.lineage.sourceWorldMatrixM];
    alteredMatrix[12] += 1;
    for (const staleGrid of [
      {
        ...grid,
        lineage: { ...grid.lineage, sourceWorldMatrixM: alteredMatrix },
      },
      {
        ...grid,
        lineage: { ...grid.lineage, sourceGeometryProjectionHash: '0'.repeat(64) },
      },
      { ...grid, originXZ: [grid.originXZ[0] + 1, grid.originXZ[1]] as const },
    ]) {
      expect(
        system.publishBakedQueryGrid(BODY, rebound.sceneGeneration, {
          kind: 'durable-pack',
          enabled: true,
          componentValid: true,
          dataValid: true,
          grid: staleGrid,
        }),
      ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
      expect(system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid.samples).toEqual(
        retained.samples,
      );
    }
    const stagedB = system
      .stageRiverReload(
        BODY,
        'body-v3',
        packed.value.body,
        BODY,
        movedMatrix,
        [],
        rebound.dependencies,
      )
      .unwrap();
    expect(system.sceneCandidateRequiresBakedGrid(BODY, stagedB.sceneGeneration)).toBe(true);

    const producerB = new WaterSystem(() => undefined);
    const producerBodyB = producerB
      .mountBody(BODY, 'body-v3', stagedB.asset, BODY, stagedB.worldMatrixM)
      .unwrap();
    const producerSimulationB = producerB
      .createAdvancedSimulation(
        { guid: RECIPE, contentVersion: 'sha256:producer-b', asset: recipe(true) },
        BODY,
      )
      .unwrap();
    finish(producerSimulationB, 1, [30, 40]);
    producerSimulationB.requestBake().unwrap();
    const capturedB = finish(producerSimulationB, 2, [30, 40]);
    producerSimulationB
      .acceptReadbacks(capturedB.frame, bakeReadbacks(capturedB.frame, capturedB.completion))
      .unwrap();
    const candidateB = prepareWaterRiverBake(producerSimulationB, definePackageId(RECIPE)).unwrap();
    const metadataB = candidateB.recipe.riverBakeConfig?.bakedGrid;
    assert(metadataB?.version === 'water-river-bake/2');
    expect(metadataB.sourceWorldMatrixM).toEqual(stagedB.worldMatrixM);
    expect(metadataB.originXZ).toEqual([26.5, 34.75]);
    expect(metadataB.sourceGeometryProjectionHash).toBe(
      waterRiverBakeGeometryProjectionHash(producerBodyB.asset),
    );
    const gridB = decodeWaterRiverBake(
      candidateB.recipe,
      loadedBakePair(candidateB, { grid: 18, normal: 19 }),
    ).unwrap();
    expect(
      system.publishBakedQueryGrid(BODY, stagedB.sceneGeneration, {
        kind: 'durable-pack',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: gridB,
      }).ok,
    ).toBe(true);
    expect(system.snapshot(BODY)?.sceneGeneration).toBe(rebound.sceneGeneration);
    expect(system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid.samples).toEqual(
      retained.samples,
    );
    expect(system.bakedQueryGridCandidate(BODY, stagedB.sceneGeneration)?.samples).toEqual(
      gridB.samples,
    );
    expect(system.sceneCandidateRequiresBakedGrid(BODY, stagedB.sceneGeneration)).toBe(false);

    const caseNormalizedPair = loadedBakePair(candidate, {
      grid: outputTextureRevision,
      normal: 19,
    });
    caseNormalizedPair.grid.guid = metadata.textureGuid.toUpperCase();
    const caseNormalizedGrid = decodeWaterRiverBake(
      structuredClone(candidate.recipe),
      caseNormalizedPair,
    );
    expect(caseNormalizedGrid.ok).toBe(true);
    if (caseNormalizedGrid.ok)
      expect(caseNormalizedGrid.value.lineage?.textureGuid).toBe(metadata.textureGuid);
    const lastGoodPair = system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid;
    const lastGoodBakeRevision = system.bakedQueryRevision;
    const validPair = loadedBakePair(candidate);
    for (const loadedTextures of [
      { version: 'water-river-bake/2', grid: validPair.grid },
      { ...validPair, grid: { ...validPair.grid, guid: RECIPE } },
      { ...validPair, grid: { ...validPair.grid, revision: -1 } },
      { ...validPair, normal: { ...validPair.normal, guid: RECIPE } },
      { ...validPair, normal: { ...validPair.normal, revision: -1 } },
    ]) {
      expect(
        decodeWaterRiverBake(structuredClone(candidate.recipe), loadedTextures as never),
      ).toMatchObject({
        ok: false,
        error: { code: 'water-river-bake-invalid' },
      });
    }
    const invalidNormalPair = loadedBakePair(candidate);
    invalidNormalPair.normal.asset.data.fill(0);
    expect(decodeWaterRiverBake(candidate.recipe, invalidNormalPair).ok).toBe(false);
    expect(system.bakedQueryGrid(BODY, rebound.sceneGeneration)?.grid.lineage).toEqual(
      lastGoodPair?.lineage,
    );
    expect(system.bakedQueryRevision).toBe(lastGoodBakeRevision);
    expect(candidate.gridTexture.format).toBe('rgba16float');
    expect(candidate.gridTexture.data.byteLength).toBe(8 * 8 * 8);
    expect(candidate.normalTexture.format).toBe('rgba16float');
    expect(candidate.normalTexture.data.byteLength).toBe(8 * 8 * 8);
    const nonUnitNormalPair = loadedBakePair(candidate);
    const nonUnitNormal = halfFloat.f32ToF16Bytes(
      new Uint8Array(new Float32Array([0, 0, 0.5, 0]).buffer),
    );
    for (let row = 0; row < 8; row++)
      for (let column = 0; column < 8; column++)
        nonUnitNormalPair.normal.asset.data.set(nonUnitNormal, row * 64 + column * 8);
    expect(decodeWaterRiverBake(candidate.recipe, nonUnitNormalPair).ok).toBe(false);
    expect(Array.from(grid.samples.slice(0, 4))).toEqual([0.250244140625, 2.5, 1.5009765625, -0.5]);
    const depth = grid.samples[0];
    assert(depth !== undefined);
    expect(grid.originY + depth).toBe(2.250244140625);
    expect(
      decodeWaterRiverBake(candidate.recipe, {
        ...loadedBakePair(candidate),
        grid: {
          ...loadedBakePair(candidate).grid,
          asset: { ...candidate.gridTexture, format: 'rgba32float' },
        },
      }).ok,
    ).toBe(false);
    expect(
      decodeWaterRiverBake(candidate.recipe, {
        ...loadedBakePair(candidate),
        grid: {
          ...loadedBakePair(candidate).grid,
          asset: { ...candidate.gridTexture, data: new Uint8Array(16) },
        },
      }).ok,
    ).toBe(false);
    const riverBakeConfig = candidate.recipe.riverBakeConfig;
    if (!riverBakeConfig) throw new Error('Expected a River Bake recipe configuration');
    const legacyRecipe = {
      ...candidate.recipe,
      riverBakeConfig: {
        ...riverBakeConfig,
        bakedGrid: {
          version: 'water-river-bake/1' as const,
          textureGuid: metadata.textureGuid,
          sourceRecipeGuid: metadata.sourceRecipeGuid,
          sourceRecipeVersion: metadata.sourceRecipeVersion,
          sourceBodyGuid: metadata.sourceBodyGuid,
          sourceBodyGeneration: metadata.sourceBodyGeneration,
          simulationGeneration: metadata.simulationGeneration,
          sequence: metadata.sequence,
          frameId: metadata.frameId,
          deviceGeneration: metadata.deviceGeneration,
          graphGeneration: metadata.graphGeneration,
          width: metadata.width,
          height: metadata.height,
          originXZ: metadata.originXZ,
          originYM: metadata.originYM,
          spacingXZ: metadata.spacingXZ,
        },
      },
    };
    const legacyGrid = decodeWaterRiverBake(legacyRecipe, {
      version: 'water-river-bake/1',
      grid: loadedBakePair(candidate).grid,
    }).unwrap();
    expect(legacyGrid.lineage?.version).toBe('water-river-bake/1');
    sim.reset();
    expect(prepareWaterRiverBake(sim, definePackageId(RECIPE)).ok).toBe(false);
  });
});
