import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  type PhysicsColliderPrimitives,
  PhysicsFixedError,
  PhysicsWorldResource,
  RigidBody,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform, WaterShallowCollider } from '@forgeax/engine-scene';
import { type Asset, type AssetHandle, err, ok, type TextureAsset } from '@forgeax/engine-types';
import { waterOceanPatchOutputNames } from '@forgeax/engine-water';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { Camera, perspective } from '../components/camera';
import { viewSharedFeatureGraphPassName } from '../features/frame-plan';
import type { RenderFeatureSubmission } from '../features/types';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../publication/record';
import type { FrameReceipt } from '../render-contract';
import { createWaterAdvancedFeature } from '../water/advanced-feature';
import {
  ADVANCED_RECIPE,
  advancedPhysicsFixture,
  advancedWaterFixture,
} from './advanced-water-fixture';

async function publishedOceanFixture() {
  const fixture = await advancedWaterFixture({ kind: 'disabled' });
  fixture.water.removeAdvancedSimulation(fixture.simulation);
  const noiseGuid = '019ffa97-7000-7000-8000-000000000013';
  const noise: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(16).fill(127),
  };
  publishRuntimeAssets(fixture.assets, [{ guid: noiseGuid, asset: noise }]);
  (await fixture.assets.load(noiseGuid, 'texture')).unwrap();
  const recipe = {
    guid: ADVANCED_RECIPE,
    contentVersion: 'ocean-v1',
    asset: {
      kind: 'water-simulation-recipe' as const,
      system: 'water-advanced' as const,
      configurationVersion: 1 as const,
      enabledFeatures: ['oceanPatch'] as const,
      materialGuids: [],
      textureGuids: [noiseGuid],
      oceanPatchConfig: {
        algorithm: 'ue-5.8.1-niagara-fft' as const,
        windAngleDegrees: 180,
        windSpeedMPerSec: 0.55,
        noiseTextureGuid: noiseGuid,
        fftResolution: 128,
        domainLengthM: 2.5,
        normalDomainSizeM: 1.5,
        gravityMPerSec2: 9.8,
        phillipsAmplitude: 0.0003,
        windAlignment: 0,
        timeScale: 2.5,
        slosh: 1,
        chopHack: 5,
        twiddle: 'positive' as const,
        normalization: 'none' as const,
        normalRtFormat: 'rgba16float' as const,
        gridMesh: null,
      },
    },
  };
  return { ...fixture, ocean: fixture.water.requestOceanPatch(recipe).unwrap() };
}

async function publishedDispersiveFixture() {
  const fixture = await advancedWaterFixture({ kind: 'disabled' });
  fixture.water.removeAdvancedSimulation(fixture.simulation);
  const nativeClock = {
    simulationTimeSeconds: 0,
    completedStep: 0,
    externalTimeSeconds: 0,
    resultsTimeSeconds: 0,
    interpolationDelaySteps: 0,
  };
  fixture.world.insertResource(
    PhysicsWorldResource,
    advancedPhysicsFixture({
      getSolverClock: () => nativeClock,
      getCommittedColliderPrimitives: () => {
        throw new Error('The empty source roster must not query a body');
      },
    }),
  );
  const ocean = fixture.water
    .requestOceanPatch({
      guid: ADVANCED_RECIPE,
      contentVersion: 'dispersive-v1',
      asset: {
        kind: 'water-simulation-recipe',
        system: 'water-advanced',
        configurationVersion: 1,
        enabledFeatures: ['oceanPatch'],
        materialGuids: [],
        textureGuids: [],
        oceanPatchConfig: {
          algorithm: 'mode-projected-gravity/1',
          fftResolution: 8,
          domainLengthM: 16,
          centerXZ: [0, 0],
          baseHeightM: 0,
          referenceDepthM: 4,
          gravityMPerSec2: 9.81,
          sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
          collisions: {
            kind: 'simple',
            collisionGroups: 0xffffffff,
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
    })
    .unwrap();
  return { ...fixture, nativeClock, ocean };
}

async function publishedVisualDispersiveFixture() {
  const fixture = await advancedWaterFixture({ kind: 'disabled' });
  fixture.water.removeAdvancedSimulation(fixture.simulation);
  const noiseGuid = '019ffa97-7000-7000-8000-000000000014';
  const noise: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(16).fill(127),
  };
  publishRuntimeAssets(fixture.assets, [{ guid: noiseGuid, asset: noise }]);
  (await fixture.assets.load(noiseGuid, 'texture')).unwrap();
  const nativeClock = {
    simulationTimeSeconds: 0,
    completedStep: 0,
    externalTimeSeconds: 0,
    resultsTimeSeconds: 0,
    interpolationDelaySteps: 0,
  };
  let collisionPending = false;
  fixture.world.insertResource(
    PhysicsWorldResource,
    advancedPhysicsFixture({
      getSolverClock: () => nativeClock,
      getCommittedColliderPrimitives: (entity: number) => {
        if (collisionPending)
          return err(
            new PhysicsFixedError('fixed-body-missing', {
              entity,
              reason: 'new authored body has not synchronized',
              recovery: 'await-native-sync',
            }),
          );
        throw new Error('The empty source roster must not query a body');
      },
    }),
  );
  const ocean = fixture.water
    .requestOceanPatch({
      guid: ADVANCED_RECIPE,
      contentVersion: 'visual-dispersive-v2',
      asset: {
        kind: 'water-simulation-recipe',
        system: 'water-advanced',
        configurationVersion: 2,
        enabledFeatures: ['oceanPatch'],
        materialGuids: [],
        textureGuids: [noiseGuid],
        oceanPatchConfig: {
          algorithm: 'mode-projected-gravity/1',
          fftResolution: 8,
          domainLengthM: 16,
          centerXZ: [0, 0],
          baseHeightM: 0,
          referenceDepthM: 4,
          gravityMPerSec2: 9.81,
          sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
          collisions: {
            kind: 'simple',
            collisionGroups: 0xffffffff,
            maxElements: 10,
            fieldStepM: 0.1,
            maximumFieldSamplesPerColumn: 128,
          },
          maximumIntervalSeconds: 0.2,
          boundary: { kind: 'periodic' },
          foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
          normalRtFormat: 'rgba32float',
          gridMesh: null,
          visualNormalDetailFft: {
            noiseTextureGuid: noiseGuid,
            fftResolution: 16,
            domainLengthM: 64,
            normalDomainSizeM: 32,
            gravityMPerSec2: 9.81,
            phillipsAmplitude: 1,
            windAngleDegrees: 45,
            windSpeedMPerSec: 12,
            windAlignment: 4.5,
            timeScale: 1,
            slosh: 0.5,
            normalRtFormat: 'rgba32float',
          },
        },
      },
    })
    .unwrap();
  return {
    ...fixture,
    nativeClock,
    ocean,
    noiseGuid,
    setCollisionPending: (pending: boolean) => {
      collisionPending = pending;
    },
  };
}

it('plans a separate signed-Y visual FFT output and requires every child transform pass', async () => {
  const fixture = await publishedVisualDispersiveFixture();
  const sourceFeature = createWaterAdvancedFeature({});
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const planContext = {
    caps: {
      ...device.caps,
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatStorage: true,
      rgba32floatStorage: true,
    },
    limits: { maxTextureDimension2D: 8192 },
    frame: { frameNumber: 1 },
    generation: 1,
    deviceGeneration: 3,
    views: [],
  };
  let originalNoiseRevision: number | undefined;
  let noiseHandle: AssetHandle<string, Asset> | undefined;
  const extractContext = {
    ...fixture.context,
    referenceAssetVersion: ({ handle, revision }: { handle: number; revision: number }) => {
      originalNoiseRevision ??= revision;
      noiseHandle ??= handle as AssetHandle<string, Asset>;
      expect(revision).toBe(fixture.assets.revision(handle as AssetHandle).unwrap());
    },
  };
  try {
    fixture.nativeClock.simulationTimeSeconds = 0.05;
    fixture.nativeClock.completedStep = 3;
    fixture.ocean.update(1 / 60).unwrap();
    const data = sourceFeature.extract(extractContext).unwrap();
    if (originalNoiseRevision === undefined) throw new Error('noise revision was not captured');
    const plan = sourceFeature.plan(data, planContext).unwrap();
    const resources = plan.work.flatMap((work) => work.resources);
    const passes = plan.work.flatMap((work) => work.passes);
    const names = waterOceanPatchOutputNames(ADVANCED_RECIPE, fixture.world.identity);
    const output = resources.find(
      (resource) => resource.kind === 'graph-texture' && resource.name === names.visualNormal,
    );
    expect(output).toMatchObject({
      kind: 'graph-texture',
      materialSource: true,
      descriptor: {
        format: 'rgba32float',
        size: { width: 16, height: 16 },
      },
    });
    if (output?.kind !== 'graph-texture') throw new Error('visual normal target missing');
    const visualPasses = passes
      .map((pass) => pass.name)
      .filter((name) => name.includes('-visual-fft-'));
    expect(visualPasses).toContain(`${names.prefix}-visual-fft-g1-r2-s16-spectrum`);
    for (const axis of ['x', 'z'])
      for (const span of [1, 2, 4, 8])
        expect(visualPasses).toContain(
          `${names.prefix}-visual-fft-g1-r2-s16-${axis}-radix-${span}`,
        );
    expect(visualPasses).toContain(`${names.prefix}-visual-fft-g1-r2-s16-publish`);

    const submission: RenderFeatureSubmission = {
      works: plan.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
        })),
      })),
    };
    const missingYLayer: RenderFeatureSubmission = {
      works: submission.works.map((work) => ({
        ...work,
        passes: work.passes.filter(
          (pass) => pass.name !== `${names.prefix}-visual-fft-g1-r2-s16-z-radix-8`,
        ),
      })),
    };
    sourceFeature.onSourceFrameSubmitted?.(data, plan.sourceFeedback, missingYLayer);
    expect(fixture.ocean.inspect().submittedSequence).toBe(0);
    sourceFeature.onFrameSubmitted?.(data, submission);
    sourceFeature.onSourceFrameSubmitted?.(data, plan.sourceFeedback, submission);
    expect(fixture.ocean.inspect().visualNormalDetailFft?.valid).toBe(false);
    sourceFeature.onFrameReceipt?.(
      {
        frameId: 9,
        deviceGeneration: 3,
        graphGeneration: 17,
        presentation: 'ready',
        completed: Promise.resolve(ok(undefined)),
      },
      Promise.resolve(ok([])),
    );
    await expect.poll(() => fixture.ocean.inspect().visualNormalDetailFft?.valid).toBe(true);
    expect(fixture.ocean.inspect().visualNormalDetailFft).toMatchObject({
      valid: true,
      output: {
        generation: 1,
        size: 16,
        completion: { frameId: 9, deviceGeneration: 3, graphGeneration: 17 },
      },
    });

    const completeNextFrame = async (
      frameNumber: number,
      timeSeconds: number,
      completedStep: number,
      frameId: number,
    ) => {
      fixture.nativeClock.simulationTimeSeconds = timeSeconds;
      fixture.nativeClock.completedStep = completedStep;
      fixture.ocean.update(1 / 60).unwrap();
      const nextData = sourceFeature.extract({ ...extractContext, frameNumber }).unwrap();
      const nextPlan = sourceFeature
        .plan(nextData, { ...planContext, frame: { frameNumber } })
        .unwrap();
      const nextSubmission: RenderFeatureSubmission = {
        works: nextPlan.work.map((work) => ({
          scope: work.scope,
          passes: work.passes.map((pass) => ({
            name: pass.name,
            ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
          })),
        })),
      };
      sourceFeature.onFrameSubmitted?.(nextData, nextSubmission);
      sourceFeature.onSourceFrameSubmitted?.(nextData, nextPlan.sourceFeedback, nextSubmission);
      sourceFeature.onFrameReceipt?.(
        {
          frameId,
          deviceGeneration: 3,
          graphGeneration: 17,
          presentation: 'ready',
          completed: Promise.resolve(ok(undefined)),
        },
        Promise.resolve(ok([])),
      );
      await expect
        .poll(() => fixture.ocean.inspect().completedSequence)
        .toBe(nextData.oceans[0]?.frame?.sequence);
    };
    await completeNextFrame(2, 0.06, 4, 10);
    await completeNextFrame(3, 0.07, 5, 11);
    expect(fixture.ocean.inspect().state).toMatchObject({ status: 'ready', size: 8 });
    expect(fixture.ocean.inspect().visualNormalDetailFft?.valid).toBe(true);

    registerPhysicsComponents(fixture.world);
    const pendingBody = fixture.world
      .spawn(
        { component: RigidBody, data: {} },
        { component: WaterShallowCollider, data: { enabled: true } },
      )
      .unwrap();
    fixture.setCollisionPending(true);
    fixture.nativeClock.simulationTimeSeconds = 0.08;
    fixture.nativeClock.completedStep = 6;
    fixture.ocean.update(1 / 60).unwrap();
    const pendingData = sourceFeature.extract({ ...extractContext, frameNumber: 4 }).unwrap();
    const pendingPlan = sourceFeature
      .plan(pendingData, { ...planContext, frame: { frameNumber: 4 } })
      .unwrap();
    const pendingResources = pendingPlan.work.flatMap((work) => work.resources);
    const pendingPasses = pendingPlan.work.flatMap((work) => work.passes);
    expect(
      pendingResources.find(
        (resource) => resource.kind === 'graph-texture' && resource.name === names.visualNormal,
      ),
    ).toMatchObject({ allocationKey: output.allocationKey, materialSource: true });
    expect(pendingPasses.some((pass) => pass.name.includes('-visual-fft-'))).toBe(false);
    expect(pendingPlan.sourceFeedback).toMatchObject({ oceans: [] });
    sourceFeature.onFrameAborted?.(pendingData);

    fixture.world.despawn(pendingBody).unwrap();
    fixture.setCollisionPending(false);
    fixture.ocean.setPaused(true);
    fixture.ocean.update(1 / 60).unwrap();
    const pausedData = sourceFeature.extract({ ...extractContext, frameNumber: 5 }).unwrap();
    expect(pausedData.oceans[0]?.frame).toMatchObject({
      paused: true,
      reset: false,
      visualNormalDetailFft: { reset: false },
    });
    const pausedPlan = sourceFeature
      .plan(pausedData, { ...planContext, frame: { frameNumber: 5 } })
      .unwrap();
    expect(pausedPlan.sourceFeedback).toMatchObject({ oceans: [] });
    const pausedResources = pausedPlan.work.flatMap((work) => work.resources);
    const pausedPasses = pausedPlan.work.flatMap((work) => work.passes);
    expect(
      pausedResources.find(
        (resource) => resource.kind === 'graph-texture' && resource.name === names.visualNormal,
      ),
    ).toMatchObject({ allocationKey: output.allocationKey, materialSource: true });
    expect(
      pausedPasses.filter((pass) => pass.name.includes('-visual-fft-')).map((pass) => pass.name),
    ).toEqual([]);
    sourceFeature.onFrameAborted?.(pausedData);

    if (noiseHandle === undefined) throw new Error('noise handle was not captured');
    const currentNoise = fixture.assets.read(noiseHandle).unwrap();
    if (currentNoise.kind !== 'texture') throw new Error('noise texture required');
    fixture.assets.update(noiseHandle, { data: new Uint8Array(currentNoise.data) }).unwrap();
    fixture.ocean.update(1 / 60).unwrap();
    const changedData = sourceFeature.extract({ ...extractContext, frameNumber: 6 }).unwrap();
    expect(fixture.ocean.inspect().visualNormalDetailFft).toMatchObject({
      revision: 3,
      valid: false,
      output: { revision: 2, noiseRevision: originalNoiseRevision },
    });
    const changedPlan = sourceFeature
      .plan(changedData, { ...planContext, frame: { frameNumber: 6 } })
      .unwrap();
    const changedResources = changedPlan.work.flatMap((work) => work.resources);
    const changedPasses = changedPlan.work.flatMap((work) => work.passes);
    const changedOutput = changedResources.find(
      (resource) => resource.kind === 'graph-texture' && resource.name === names.visualNormal,
    );
    if (changedOutput?.kind !== 'graph-texture') throw new Error('new visual target missing');
    expect(changedOutput.allocationKey).not.toBe(output.allocationKey);
    expect(
      changedPasses.some((pass) => pass.name === `${names.prefix}-visual-fft-g1-r3-s16-publish`),
    ).toBe(true);
    expect(
      changedResources.some(
        (resource) =>
          resource.kind === 'graph-texture' &&
          resource.name === names.visualNormal &&
          resource.allocationKey === output.allocationKey,
      ),
    ).toBe(false);
    sourceFeature.onFrameAborted?.(changedData);
  } finally {
    fixture.assets.dispose();
  }
});

it.each([
  'invalid-noise',
  'unsupported-size',
] as const)('keeps residual work live when the visual child has %s', async (caseName) => {
  const fixture = await publishedVisualDispersiveFixture();
  const feature = createWaterAdvancedFeature({});
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const planContext = {
    caps: {
      ...device.caps,
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatStorage: true,
      rgba32floatStorage: true,
    },
    limits: { maxTextureDimension2D: caseName === 'unsupported-size' ? 8 : 8192 },
    frame: { frameNumber: 1 },
    generation: 1,
    deviceGeneration: 3,
    views: [],
  };
  if (caseName === 'invalid-noise') {
    const noise = (await fixture.assets.load(fixture.noiseGuid, 'texture')).unwrap();
    fixture.assets.update(noise, { format: 'rgba16float', data: new Uint8Array(32) }).unwrap();
  }
  try {
    fixture.ocean.configureQueryFeedback({
      worldIdentity: fixture.world.identity,
      bodyGuid: '019ffa97-7000-7000-8000-000000000031',
      bodyGeneration: 1,
      maximumAgeSeconds: 0.2,
    });
    fixture.ocean.requestQueryRegion('019ffa97-7000-7000-8000-000000000031', 1, [[0, 0, 0]]);
    fixture.nativeClock.simulationTimeSeconds = 0.05;
    fixture.nativeClock.completedStep = 3;
    fixture.ocean.update(1 / 60).unwrap();
    const data = feature.extract(fixture.context).unwrap();
    const plan = feature.plan(data, planContext).unwrap();
    const resources = plan.work.flatMap((work) => work.resources);
    const passes = plan.work.flatMap((work) => work.passes);
    const names = waterOceanPatchOutputNames(ADVANCED_RECIPE, fixture.world.identity);
    expect(plan.sourceFeedback).toMatchObject({
      oceans: [
        {
          visualError: {
            code:
              caseName === 'invalid-noise'
                ? 'water-advanced-invalid-input'
                : 'water-advanced-unsupported',
          },
        },
      ],
    });
    expect(resources.some((resource) => resource.name === names.visualNormal)).toBe(false);
    expect(passes.some((pass) => pass.name.includes('-visual-fft-'))).toBe(false);
    expect(passes.some((pass) => pass.name.endsWith('-advance-wave'))).toBe(true);
    const submission: RenderFeatureSubmission = {
      works: plan.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
        })),
      })),
    };
    feature.onSourceFrameSubmitted?.(data, plan.sourceFeedback, submission);
    expect(fixture.ocean.inspect()).toMatchObject({
      generation: 1,
      state: { status: 'initializing' },
      queryFeedback: { inFlight: 1 },
      visualNormalDetailFft: {
        valid: false,
        error: {
          code:
            caseName === 'invalid-noise'
              ? 'water-advanced-invalid-input'
              : 'water-advanced-unsupported',
        },
      },
    });
  } finally {
    fixture.assets.dispose();
  }
});

it('preserves Ocean requests across three real publication flights and predecessor acknowledgments', async () => {
  const fixture = await publishedDispersiveFixture();
  const { ocean, world, assets, nativeClock } = fixture;
  world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: perspective({ fov: 1, aspect: 1 }) },
    )
    .unwrap();
  const source = createWaterAdvancedFeature({}),
    gpu = createWaterAdvancedFeature({});
  const identity = { source: 'ocean-three-flight', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [source],
    undefined,
    undefined,
    3,
  );
  const receiver = new RenderPublicationReceiver(identity);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const context = {
    caps: {
      ...device.caps,
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatStorage: true,
      rgba32floatStorage: true,
    },
    limits: { maxTextureDimension2D: 8192 },
    frame: { frameNumber: 1 },
    generation: 1,
    deviceGeneration: 7,
    views: [],
  };
  const publish = (time: number) => {
    nativeClock.simulationTimeSeconds = time;
    nativeClock.completedStep = Math.round(time * 60);
    ocean.update(1 / 60).unwrap();
    const candidate = publisher.prepare(time).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.message),
        ...renderPublicationAssetTransfers(candidate.message),
      ],
    });
    candidate.accept();
    const received = receiver.accept(encodeRenderPublication(packet)).unwrap();
    const data = received.packet.features.find((row) => row.identity === source.identity)
      ?.data as Parameters<typeof gpu.plan>[0];
    expect(data.oceans).toHaveLength(1);
    return { packet, data };
  };
  const plan = (flight: ReturnType<typeof publish>) => {
    const planned = gpu.plan(flight.data, context).unwrap();
    const submission: RenderFeatureSubmission = {
      works: planned.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
        })),
      })),
    };
    return { ...flight, planned, submission };
  };
  const ack = (flight: ReturnType<typeof plan>) => {
    gpu.onFrameSubmitted?.(flight.data, flight.submission);
    publisher
      .acknowledgeFeatures(flight.packet.revision, [
        {
          identity: source.identity,
          feedback: structuredClone(flight.planned.sourceFeedback),
          submission: structuredClone(flight.submission),
        },
      ])
      .unwrap();
  };
  const passes = (flight: ReturnType<typeof plan>) =>
    flight.submission.works.flatMap((work) => work.passes.map((pass) => pass.name));
  try {
    ocean.requestStageCapture();
    const first = plan(publish(0.05));
    const second = publish(0.1);
    ocean.requestStageCapture();
    ocean.setPaused(true);
    ocean.setPaused(false);
    const third = publish(0.15);
    expect(publisher.inspect().inFlightCount).toBe(3);
    expect(publisher.prepare(0.2).ok).toBe(false);
    const partial = {
      works: first.submission.works.map((work) => ({
        ...work,
        passes: work.passes.filter((pass) => !pass.name.endsWith('-state-capture')),
      })),
    };
    gpu.onFrameSubmitted?.(first.data, partial);
    const retried = plan(first);
    expect(passes(retried).some((name) => name.endsWith('-clear-state'))).toBe(true);
    ack(retried);
    expect(ocean.inspect().submittedSequence).toBe(first.data.oceans[0]?.frame?.sequence);
    const next = plan(second);
    expect(next.planned.sourceFeedback).toMatchObject({
      oceans: [{ size: 8, reset: true, captureStages: false }],
    });
    expect(passes(next).some((name) => name.endsWith('-state-capture'))).toBe(false);
    ack(next);
    expect(ocean.inspect().submittedSequence).toBe(second.data.oceans[0]?.frame?.sequence);
    const latest = plan(third);
    expect(latest.planned.sourceFeedback).toMatchObject({
      oceans: [{ size: 8, reset: false, captureStages: true }],
    });
    expect(passes(latest).some((name) => name.endsWith('-clear-state'))).toBe(false);
    expect(passes(latest).some((name) => name.endsWith('-clear-source'))).toBe(true);
    ack(latest);
    for (const flight of [retried, next, latest]) {
      publisher
        .completeFeatures(flight.packet.revision, {
          frameId: 100 + flight.packet.revision,
          deviceGeneration: 7,
          graphGeneration: 23,
        })
        .unwrap();
      publisher
        .recycle(
          flight.packet.revision,
          renderPublicationTransfers(encodeRenderPublication(flight.packet)),
        )
        .unwrap();
    }
    expect(ocean.inspect()).toMatchObject({
      submittedSequence: third.data.oceans[0]?.frame?.sequence,
      completedSequence: third.data.oceans[0]?.frame?.sequence,
      state: { status: 'ready' },
    });
    const fourth = plan(publish(0.2));
    expect(
      passes(fourth).some(
        (name) =>
          name.endsWith('-clear-state') ||
          name.endsWith('-clear-source') ||
          name.endsWith('-state-capture'),
      ),
    ).toBe(false);
    ack(fourth);
    publisher
      .completeFeatures(fourth.packet.revision, {
        frameId: 104,
        deviceGeneration: 7,
        graphGeneration: 24,
      })
      .unwrap();
    publisher
      .recycle(
        fourth.packet.revision,
        renderPublicationTransfers(encodeRenderPublication(fourth.packet)),
      )
      .unwrap();
    nativeClock.simulationTimeSeconds = 0.25;
    ocean.requestStageCapture();
    const cancelled = publisher.prepare(0.25).unwrap();
    const cancelledFrame = (
      cancelled.packet.features.find((row) => row.identity === source.identity)?.data as Parameters<
        typeof gpu.plan
      >[0]
    ).oceans[0]?.frame;
    expect(cancelledFrame).toBeDefined();
    cancelled.discard();
    if (cancelledFrame) expect(ocean.submitted(cancelledFrame).ok).toBe(false);
    const afterDiscard = plan(publish(0.3));
    expect(passes(afterDiscard).some((name) => name.endsWith('-state-capture'))).toBe(true);
    gpu.onFrameAborted?.(afterDiscard.data);
    publisher.dispose();
    ocean.reset();
    expect(ocean.inspect().state.status).toBe('initializing');
  } finally {
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});

describe('advanced water owner replacement', () => {
  it.each([
    'shallow',
    'dispersive',
  ] as const)('retains complete %s output and source history while an authored native roster member is pending', async (kind) => {
    const fixture =
      kind === 'shallow'
        ? { kind, ...(await advancedWaterFixture()) }
        : { kind, ...(await publishedDispersiveFixture()) };
    registerPhysicsComponents(fixture.world);
    const feature = createWaterAdvancedFeature({});
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      deviceGeneration: 0,
      views: [],
    };
    let step = 0;
    let pending: EntityHandle | undefined;
    const spawn = () =>
      fixture.world
        .spawn(
          { component: RigidBody, data: {} },
          { component: WaterShallowCollider, data: { enabled: true } },
        )
        .unwrap();
    const first = spawn();
    const primitive = (entity: number): PhysicsColliderPrimitives => ({
      entity,
      generation: entity + 1,
      completedStep: step,
      motionDiscontinuity: 0,
      positionM: [10 + step / 60, 6, 20],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      centerOfMassM: [10, 6, 20],
      linearVelocityMps: [1, 0, 0],
      angularVelocityRadps: [0, 0, 0],
      rawAggregateCount: 1,
      elements: [
        {
          colliderId: `native:${entity}`,
          generation: entity + 1,
          elementIndex: 0,
          collisionGroups: 0xffffffff,
          positionM: [10 + step / 60, 6, 20],
          rotation: [0, 0, 0, 1],
          shape: { kind: 'sphere', radiusM: 0.5 },
        },
      ],
    });
    fixture.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getSolverClock: () => ({
          simulationTimeSeconds: step / 60,
          completedStep: step,
          externalTimeSeconds: step / 60,
          resultsTimeSeconds: step / 60,
          interpolationDelaySteps: 0,
        }),
        getCommittedColliderPrimitives: (entity: number) =>
          entity === pending
            ? err(
                new PhysicsFixedError('fixed-body-missing', {
                  entity,
                  reason: 'new authored native body has not synchronized',
                  recovery: 'await-native-sync',
                }),
              )
            : ok(primitive(entity)),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    const plan = (nextStep: number) => {
      step = nextStep;
      if (fixture.kind === 'shallow') fixture.update(step / 60);
      else fixture.ocean.update(1 / 60).unwrap();
      const data = feature.extract({ ...fixture.context, frameNumber: step }).unwrap();
      return { data, value: feature.plan(data, context).unwrap() };
    };
    const submit = (planned: ReturnType<typeof plan>) => {
      const submission: RenderFeatureSubmission = {
        works: planned.value.work.map((work) => ({
          scope: work.scope,
          passes: work.passes
            .filter((pass) => pass.enabled !== false)
            .map((pass) => ({
              name: pass.name,
              ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
            })),
        })),
      };
      feature.onFrameSubmitted?.(planned.data, submission);
      feature.onSourceFrameSubmitted?.(planned.data, planned.value.sourceFeedback, submission);
    };
    const owner = fixture.kind === 'shallow' ? fixture.simulation : fixture.ocean;
    try {
      submit(plan(1));
      const accepted = plan(2);
      submit(accepted);
      const submittedSequence = owner.inspect().submittedSequence;
      const allocations = accepted.value.work
        .flatMap((work) => work.resources)
        .filter(
          (resource) =>
            resource.kind === 'graph-texture' && resource.descriptor.lifetime === 'persistent',
        );
      if (fixture.kind === 'dispersive') {
        fixture.ocean.configureQueryFeedback({
          worldIdentity: fixture.world.identity,
          bodyGuid: 'body',
          bodyGeneration: 1,
          maximumAgeSeconds: 0.2,
        });
        fixture.ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
      }
      pending = spawn();
      for (const nextStep of [3, 4]) {
        const held = plan(nextStep);
        expect(held.value.sourceFeedback).toMatchObject({ shallow: [], oceans: [] });
        expect(
          held.value.work
            .flatMap((work) => work.passes)
            .filter((pass) => pass.enabled !== false)
            .some(
              (pass) =>
                pass.name.includes('-shallow-') ||
                pass.name.endsWith('-advance-wave') ||
                pass.name.endsWith('-query-readback'),
            ),
        ).toBe(false);
        const retained = held.value.work.flatMap((work) => work.resources);
        for (const allocation of allocations) {
          expect(retained).toContainEqual(allocation);
        }
        submit(held);
        expect(owner.inspect().submittedSequence).toBe(submittedSequence);
        feature.onFrameAborted?.(held.data);
        if (fixture.kind === 'dispersive') {
          expect(fixture.ocean.inspect().queryFeedback).toMatchObject({
            inFlight: 0,
            completed: 0,
          });
        }
      }
      const admittedEntity = pending;
      pending = undefined;
      const resumed = plan(5);
      expect(resumed.value.sourceFeedback).toMatchObject({
        [kind === 'shallow' ? 'shallow' : 'oceans']: [
          expect.not.objectContaining({ error: expect.anything() }),
        ],
      });
      const assertResumedNativeRosterParameters = () => {
        const resources = resumed.value.work.flatMap((work) => work.resources);
        if (kind === 'dispersive') {
          const params = resources.find(
            (resource) =>
              resource.kind === 'buffer' && resource.name.endsWith('-dispersive-params'),
          );
          if (params?.kind !== 'buffer' || !(params.data instanceof Float32Array))
            throw new Error('Missing dispersive parameters');
          expect(params.data[2]).toBeCloseTo(3 / 60);
          // A newly admitted source must emit its entry volume, rather than reseeding the complete roster.
          expect(params.data[18]).toBe(0);
          expect(params.data[24]).toBe(2);
        } else {
          const params = resources.find(
            (resource) =>
              resource.kind === 'buffer' &&
              resource.name.includes('-shallow-') &&
              resource.name.endsWith('-params'),
          );
          if (params?.kind !== 'buffer' || !(params.data instanceof Float32Array))
            throw new Error('Missing shallow parameters');
          expect(params.data[97]).toBeCloseTo(3 / 60);
          const history = resources.find(
            (resource) => resource.kind === 'buffer' && resource.name.endsWith('-rigid-primitives'),
          );
          if (history?.kind !== 'buffer' || !(history.data instanceof Float32Array))
            throw new Error('Missing complete rigid history');
          expect(history.data.length).toBe(80);
          expect(history.data[28]).toBeCloseTo(2 / 60);
          expect(history.data[68]).toBeCloseTo(5 / 60);
        }
      };
      assertResumedNativeRosterParameters();
      submit(resumed);
      expect(owner.inspect().submittedSequence).toBeGreaterThan(submittedSequence);
      fixture.world.despawn(admittedEntity).unwrap();
      const afterRetire = plan(6);
      expect(
        afterRetire.data.rows[0]?.collisions ?? afterRetire.data.oceans[0]?.collisions,
      ).toMatchObject({ kind: 'ready', value: { roster: [{ entity: first }] } });
      feature.onFrameAborted?.(afterRetire.data);
      if (kind === 'dispersive') {
        pending = spawn();
        const longPending = plan(30);
        expect(longPending.value.sourceFeedback).toMatchObject({ shallow: [], oceans: [] });
        feature.onFrameAborted?.(longPending.data);
        pending = undefined;
        const oversized = plan(31);
        expect(oversized.value.sourceFeedback).toMatchObject({
          oceans: [
            {
              error: {
                code: 'water-advanced-invalid-input',
                expected: expect.stringContaining('full native source interval'),
              },
            },
          ],
        });
        feature.onFrameAborted?.(oversized.data);
      } else {
        let replacementTime = 0.1;
        fixture.world.insertResource(
          PhysicsWorldResource,
          advancedPhysicsFixture({
            getSolverClock: () => ({
              simulationTimeSeconds: replacementTime,
              completedStep: step,
              externalTimeSeconds: replacementTime,
              resultsTimeSeconds: replacementTime,
              interpolationDelaySteps: 0,
            }),
            getCommittedColliderPrimitives: (entity: number) => ok(primitive(entity)),
            intersectsCommittedBodyObb: () => ok(true),
          }),
        );
        const replacement = plan(7);
        const resources = replacement.value.work.flatMap((work) => work.resources);
        const params = resources.find(
          (resource) =>
            resource.kind === 'buffer' &&
            resource.name.includes('-shallow-') &&
            resource.name.endsWith('-params'),
        );
        const history = resources.find(
          (resource) => resource.kind === 'buffer' && resource.name.endsWith('-rigid-primitives'),
        );
        if (
          params?.kind !== 'buffer' ||
          !(params.data instanceof Float32Array) ||
          history?.kind !== 'buffer' ||
          !(history.data instanceof Float32Array)
        )
          throw new Error('Missing replacement-owner collision inputs');
        expect(params.data[97]).toBe(0);
        expect(history.data[28]).toBeCloseTo(7 / 60);
        submit(replacement);
        replacementTime = 0.05;
        const reversed = plan(8);
        expect(reversed.value.sourceFeedback).toMatchObject({
          shallow: [
            {
              error: {
                code: 'water-advanced-invalid-input',
                expected: expect.stringContaining('nondecreasing accepted native source interval'),
              },
            },
          ],
        });
        feature.onFrameAborted?.(reversed.data);
      }
    } finally {
      fixture.assets.dispose();
    }
  });

  it('starts a resized dispersive state at the current native time and still refuses later long gaps', async () => {
    const fixture = await publishedDispersiveFixture();
    const feature = createWaterAdvancedFeature({});
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      deviceGeneration: 0,
      views: [],
    };
    const plan = (timeSeconds: number, frameNumber: number) => {
      fixture.nativeClock.simulationTimeSeconds = timeSeconds;
      fixture.nativeClock.completedStep = Math.round(timeSeconds * 60);
      fixture.ocean.update(1 / 60).unwrap();
      const data = feature.extract({ ...fixture.context, frameNumber }).unwrap();
      return { data, value: feature.plan(data, context).unwrap() };
    };
    const submit = (planned: ReturnType<typeof plan>) => {
      const submission: RenderFeatureSubmission = {
        works: planned.value.work.map((work) => ({
          scope: work.scope,
          passes: work.passes.map((pass) => ({
            name: pass.name,
            ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
          })),
        })),
      };
      feature.onFrameSubmitted?.(planned.data, submission);
      feature.onSourceFrameSubmitted?.(planned.data, planned.value.sourceFeedback, submission);
    };
    const initial = plan(0.05, 1);
    submit(initial);
    expect(fixture.ocean.inspect().state).toMatchObject({
      status: 'initializing',
      allocation: 'resolution-requested',
    });
    const resized = plan(2, 2);
    expect(resized.value.sourceFeedback).toMatchObject({ oceans: [{ size: 8, reset: true }] });
    expect(
      (resized.value.sourceFeedback as { oceans: { error?: unknown }[] }).oceans[0]?.error,
    ).toBeUndefined();
    expect(
      resized.value.work
        .flatMap((work) => work.passes)
        .some((pass) => pass.name.endsWith('-clear-state')),
    ).toBe(true);
    submit(resized);
    fixture.ocean.configureQueryFeedback({
      worldIdentity: fixture.world.identity,
      bodyGuid: 'body',
      bodyGeneration: 1,
      maximumAgeSeconds: 0.2,
    });
    fixture.ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
    const refused = plan(2.05, 3);
    const partial: RenderFeatureSubmission = {
      works: refused.value.work.map((work) => ({
        scope: work.scope,
        passes: work.passes
          .filter(
            (pass) =>
              !pass.name.endsWith('-query-sample') && !pass.name.endsWith('-query-readback'),
          )
          .map((pass) => ({
            name: pass.name,
            ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
          })),
      })),
    };
    feature.onFrameSubmitted?.(refused.data, partial);
    feature.onSourceFrameSubmitted?.(refused.data, refused.value.sourceFeedback, partial);
    feature.onFrameAborted?.(refused.data);
    expect(fixture.ocean.inspect().queryFeedback.inFlight).toBe(0);
    const active = plan(2.05, 4);
    expect(
      (active.value.sourceFeedback as { oceans: { error?: unknown }[] }).oceans[0]?.error,
    ).toBeUndefined();
    submit(active);
    const longGap = plan(2.4, 5);
    expect(longGap.value.sourceFeedback).toMatchObject({
      oceans: [{ error: { code: 'water-advanced-invalid-input' } }],
    });
    fixture.assets.dispose();
  });

  it('declares live Ocean query pass names before the branch runs and retires replacement scopes', async () => {
    const fixture = await publishedDispersiveFixture();
    const feature = createWaterAdvancedFeature({});
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      deviceGeneration: 0,
      views: [],
    };
    const receiver = { entity: 17, generation: 3 };
    fixture.ocean.configureQueryFeedback({
      worldIdentity: fixture.world.identity,
      bodyGuid: 'body',
      bodyGeneration: 1,
      maximumAgeSeconds: 0.2,
    });
    fixture.ocean.requestQueryRegion('body', 1, [[0, 0, 0]], receiver);

    const advance = (frameNumber: number) => {
      fixture.nativeClock.simulationTimeSeconds = frameNumber / 60;
      fixture.nativeClock.completedStep = frameNumber;
      fixture.ocean.update(1 / 60).unwrap();
      const data = feature.extract({ ...fixture.context, frameNumber }).unwrap();
      const plan = feature.plan(data, context).unwrap();
      const submission: RenderFeatureSubmission = {
        works: plan.work.map((work) => ({
          scope: work.scope,
          passes: work.passes.map((pass) => ({
            name: pass.name,
            ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
          })),
        })),
      };
      feature.onFrameSubmitted?.(data, submission);
      feature.onSourceFrameSubmitted?.(data, plan.sourceFeedback, submission);
      return { data, plan };
    };

    advance(1);
    const firstQuery = advance(2);
    advance(3);
    advance(4);
    const dormant = advance(5);
    const plannedDormantPasses = dormant.plan.work.flatMap((work) => work.passes);
    expect(plannedDormantPasses.some((pass) => pass.name.includes('-query-'))).toBe(false);
    const declared = feature.profileGraphPasses?.(['main']) ?? [];
    expect(declared.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: expect.stringMatching(/-query-receiver-0$/), kind: 'compute' },
      { name: expect.stringMatching(/-query-sample$/), kind: 'compute' },
      { name: expect.stringMatching(/-query-readback$/), kind: 'copy' },
    ]);
    expect(feature.profileGraphPasses?.(['expired-view'])).toEqual([]);

    const queryFrame = firstQuery.data.oceans[0]?.frame;
    if (queryFrame === undefined) throw new Error('Expected an issued query frame');
    fixture.ocean.acceptQueryReadback(queryFrame, undefined);
    const active = advance(6);
    const activePasses = active.plan.work.flatMap((work) => work.passes);
    for (const declaration of declared)
      expect(
        activePasses.some(
          (pass) =>
            viewSharedFeatureGraphPassName('main', pass.name) === declaration.name &&
            pass.kind === declaration.kind,
        ),
      ).toBe(true);
    expect(feature.profileGraphPasses?.(['main'])).toEqual(declared);

    fixture.water.removeOceanPatch();
    expect(feature.profileGraphPasses?.(['main'])).toEqual([]);
    const replacement = fixture.water.requestOceanPatch(fixture.ocean.recipe).unwrap();
    expect(replacement).not.toBe(fixture.ocean);
    expect(feature.profileGraphPasses?.(['main'])).toEqual([]);
    fixture.assets.dispose();
  });

  it.each([
    false,
    true,
  ])('releases a normally completed partial Ocean with readback submitted=%s', async (readbackSubmitted) => {
    const fixture = await publishedDispersiveFixture(),
      feature = createWaterAdvancedFeature({});
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      deviceGeneration: 0,
      views: [],
    };
    const advance = (frameNumber: number) => {
      fixture.nativeClock.simulationTimeSeconds = frameNumber / 60;
      fixture.nativeClock.completedStep = frameNumber;
      fixture.ocean.update(1 / 60).unwrap();
      const data = feature.extract({ ...fixture.context, frameNumber }).unwrap();
      const plan = feature.plan(data, context).unwrap();
      const submission: RenderFeatureSubmission = {
        works: plan.work.map((work) => ({
          scope: work.scope,
          passes: work.passes
            .filter(
              (pass) =>
                frameNumber !== 3 ||
                (!pass.name.endsWith('-project-0') &&
                  (readbackSubmitted || !pass.name.endsWith('-query-readback'))),
            )
            .map((pass) => ({
              name: pass.name,
              ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
            })),
        })),
      };
      feature.onFrameSubmitted?.(data, submission);
      feature.onSourceFrameSubmitted?.(data, plan.sourceFeedback, submission);
      return { data, plan, submission };
    };
    const receipt = (frameId: number): FrameReceipt => ({
      frameId,
      deviceGeneration: 0,
      graphGeneration: 1,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    });
    for (const index of [1, 2]) {
      advance(index);
      feature.onFrameReceipt?.(receipt(index), Promise.resolve(ok([])));
      await Promise.resolve();
    }
    fixture.ocean.configureQueryFeedback({
      worldIdentity: fixture.world.identity,
      bodyGuid: 'body',
      bodyGeneration: 1,
      maximumAgeSeconds: 0.2,
    });
    fixture.ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
    const partial = advance(3);
    type Observations = Parameters<NonNullable<typeof feature.onFrameReceipt>>[1];
    let finish: ((value: Awaited<Observations>) => void) | undefined;
    feature.onFrameReceipt?.(
      receipt(3),
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    feature.onSourceFrameCompleted?.(
      partial.data,
      receipt(3),
      partial.plan.sourceFeedback,
      partial.submission,
    );
    feature.onSourceFrameDiscarded?.(partial.data);
    expect(fixture.ocean.inspect().queryFeedback.inFlight).toBe(readbackSubmitted ? 1 : 0);
    finish?.(ok([]));
    await expect.poll(() => fixture.ocean.inspect().queryFeedback.inFlight).toBe(0);
    expect(fixture.ocean.inspect().queryFeedback).toMatchObject({ inFlight: 0, completed: 0 });
    fixture.assets.dispose();
  });

  it.each([
    'shallow',
    'ocean',
    'dispersive',
  ] as const)('completes structured-cloned published %s frames on the source owner', async (kind) => {
    const fixture =
      kind === 'dispersive'
        ? { kind: 'dispersive' as const, ...(await publishedDispersiveFixture()) }
        : kind === 'ocean'
          ? { kind: 'ocean' as const, ...(await publishedOceanFixture()) }
          : { kind: 'shallow' as const, ...(await advancedWaterFixture({ kind: 'disabled' })) };
    const owner = fixture.kind !== 'shallow' ? fixture.ocean : fixture.simulation;
    const source = createWaterAdvancedFeature({});
    const receiver = createWaterAdvancedFeature({});
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      deviceGeneration: 7,
      views: [],
    };
    for (let frame = 1; frame <= 4; frame++) {
      if (frame === 4 && fixture.kind === 'dispersive') fixture.ocean.setPaused(false);
      if (fixture.kind === 'dispersive') {
        fixture.nativeClock.simulationTimeSeconds = frame / 60;
        fixture.nativeClock.completedStep = frame;
      }
      if (fixture.kind !== 'shallow') fixture.ocean.update(1 / 60).unwrap();
      else fixture.update(frame);
      if (frame === 3) {
        if (fixture.kind === 'dispersive') fixture.ocean.setPaused(true);
        owner.requestStageCapture();
      }
      const data = source
        .extract({
          ...fixture.context,
          frameNumber: frame,
          referenceAssetVersion: ({ handle, revision, value }) => {
            expect(revision).toBe(fixture.assets.revision(handle as AssetHandle).unwrap());
            expect(value).toEqual(
              fixture.assets.read(handle as AssetHandle<string, Asset>).unwrap(),
            );
          },
        })
        .unwrap();
      const transported = structuredClone(data);
      expect(transported).not.toBe(data);
      const plan = receiver.plan(transported, context).unwrap();
      const submission: RenderFeatureSubmission = {
        works: plan.work.map((work) => ({
          scope: work.scope,
          passes: work.passes.map((pass) => ({
            name: pass.name,
            ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
          })),
        })),
      };
      if (kind === 'dispersive' && frame === 3) {
        const partial: RenderFeatureSubmission = {
          works: submission.works.map((work) => ({
            ...work,
            passes: work.passes.filter((pass) => !pass.name.endsWith('-project-0')),
          })),
        };
        expect(partial.works.flatMap((work) => work.passes)).toHaveLength(
          submission.works.flatMap((work) => work.passes).length - 1,
        );
        source.onSourceFrameSubmitted?.(data, structuredClone(plan.sourceFeedback), partial);
        expect(owner.inspect().submittedSequence).toBe(frame - 1);
      }
      receiver.onFrameSubmitted?.(transported, submission);
      source.onSourceFrameSubmitted?.(
        data,
        structuredClone(plan.sourceFeedback),
        structuredClone(submission),
      );
      const receipt: FrameReceipt = {
        frameId: 100 + frame,
        deviceGeneration: 7,
        graphGeneration: 19,
        presentation: 'ready',
        completed: Promise.resolve(ok(undefined)),
      };
      receiver.onFrameReceipt?.(receipt, Promise.resolve(ok([])));
      await Promise.resolve();
      expect(owner.inspect().submittedSequence).toBe(frame);
      expect(owner.inspect().completedSequence).toBe(frame - 1);
      if (frame === 4) owner.reset();
      source.onSourceFrameCompleted?.(
        data,
        {
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          graphGeneration: 19,
        },
        plan.sourceFeedback,
        submission,
      );
      if (frame === 4) {
        expect(owner.inspect().completedSequence).toBe(3);
        expect(owner.inspect().completion).toBeUndefined();
        continue;
      }
      expect(owner.inspect().completedSequence).toBe(frame);
      expect(owner.inspect().completion).toEqual({
        frameId: 100 + frame,
        deviceGeneration: 7,
        graphGeneration: 19,
      });
      if (frame === 3) {
        if (fixture.kind !== 'shallow')
          expect(fixture.ocean.inspect().state.status).toBe(
            fixture.kind === 'dispersive' ? 'paused' : 'ready',
          );
        expect(owner.inspect().readbackError?.code).toBe('water-advanced-readback-unavailable');
      }
    }
  });

  it('isolates shallow output resources for matching recipe and Body identities in separate Worlds', async () => {
    const first = await advancedWaterFixture({ kind: 'disabled' });
    const second = await advancedWaterFixture({ kind: 'disabled' });
    expect(first.simulation.recipe.guid).toBe(second.simulation.recipe.guid);
    expect(first.simulation.body.guid).toBe(second.simulation.body.guid);
    expect(first.world.identity).not.toBe(second.world.identity);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const feature = createWaterAdvancedFeature({});
    const frames = [first, second].map((fixture) => feature.extract(fixture.context).unwrap());
    const plans = frames.map((data) =>
      feature
        .plan(data, {
          caps: {
            ...device.caps,
            compute: true,
            storageBuffer: true,
            storageTexture: true,
            rgba16floatStorage: true,
            rgba32floatStorage: true,
          },
          limits: { maxTextureDimension2D: 8192 },
          frame: { frameNumber: 1 },
          generation: 1,
          views: [],
        })
        .unwrap(),
    );
    expect(frames.flatMap((data) => data.rows)).toHaveLength(2);
    const resources = plans.flatMap((plan) =>
      plan.work.flatMap((work) => work.resources.map((resource) => resource.name)),
    );
    const passes = plans.flatMap((plan) =>
      plan.work.flatMap((work) => work.passes.map((pass) => pass.name)),
    );
    expect(new Set(resources).size).toBe(resources.length);
    expect(new Set(passes).size).toBe(passes.length);
  });

  it.each([
    'same-version',
    'changed-version',
  ] as const)('initializes a replacement owner with %s and rejects the previous source acknowledgment', async (version) => {
    const fixture = await advancedWaterFixture({ kind: 'disabled' });
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const feature = createWaterAdvancedFeature({});
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      views: [],
    };
    const previous = feature.extract(fixture.context).unwrap();
    const previousPlan = feature.plan(previous, context).unwrap();
    const submission = (plan: typeof previousPlan): RenderFeatureSubmission => ({
      works: plan.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
        })),
      })),
    });
    feature.onFrameSubmitted?.(previous, submission(previousPlan));
    type Observations = Parameters<NonNullable<typeof feature.onFrameReceipt>>[1];
    let finishPrevious: ((value: Awaited<Observations>) => void) | undefined;
    const previousObservations: Observations = new Promise((resolve) => {
      finishPrevious = resolve;
    });
    const receipt: FrameReceipt = {
      frameId: 10,
      deviceGeneration: 0,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    };
    feature.onFrameReceipt?.(receipt, previousObservations);

    fixture.water.removeAdvancedSimulation(fixture.simulation);
    const replacement = fixture.water
      .createAdvancedSimulation(
        {
          ...fixture.simulation.recipe,
          ...(version === 'changed-version' ? { contentVersion: 'recipe-v2' } : {}),
        },
        fixture.simulation.body.guid,
      )
      .unwrap();
    replacement
      .update({ deltaSeconds: 1 / 60, timeSeconds: 2, centerXZ: [10, 20], yawRadians: 0 })
      .unwrap();
    const next = feature.extract({ ...fixture.context, frameNumber: 2 }).unwrap();
    feature.onSourceFrameSubmitted?.(
      previous,
      previousPlan.sourceFeedback,
      submission(previousPlan),
    );
    expect(replacement.inspect().submittedSequence).toBe(0);
    expect(fixture.simulation.inspect().status).toBe('retired');
    expect(next.rows[0]?.key).not.toBe(previous.rows[0]?.key);

    const nextPlan = feature.plan(next, context).unwrap();
    expect(
      nextPlan.work
        .flatMap((work) => work.passes)
        .some((pass) => pass.name.endsWith('-initialize-state')),
    ).toBe(true);
    feature.onFrameSubmitted?.(next, submission(nextPlan));
    feature.onSourceFrameSubmitted?.(next, nextPlan.sourceFeedback, submission(nextPlan));
    expect(replacement.inspect().submittedSequence).toBe(1);
    feature.onFrameAborted?.(previous);
    feature.onFrameReceipt?.({ ...receipt, frameId: 11 }, Promise.resolve(ok([])));
    finishPrevious?.(ok([]));
    await Promise.resolve();
    expect(replacement.inspect().completedSequence).toBe(1);
    expect(replacement.inspect().completion?.frameId).toBe(11);
    feature.onSourceFrameSubmitted?.(
      previous,
      previousPlan.sourceFeedback,
      submission(previousPlan),
    );
    expect(replacement.inspect().submittedSequence).toBe(1);
  });

  it('initializes a recreated World patch and isolates old acknowledgments, completion and abort', async () => {
    const fixture = await advancedWaterFixture({ kind: 'disabled' });
    fixture.water.removeAdvancedSimulation(fixture.simulation);
    const noiseGuid = '019ffa97-7000-7000-8000-000000000013';
    const noise: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(16).fill(127),
    };
    publishRuntimeAssets(fixture.assets, [{ guid: noiseGuid, asset: noise }]);
    const noiseHandle = (await fixture.assets.load(noiseGuid, 'texture')).unwrap();
    const recipe = {
      guid: ADVANCED_RECIPE,
      contentVersion: 'ocean-v1',
      asset: {
        kind: 'water-simulation-recipe' as const,
        system: 'water-advanced' as const,
        configurationVersion: 1 as const,
        enabledFeatures: ['oceanPatch'] as const,
        materialGuids: [],
        textureGuids: [noiseGuid],
        oceanPatchConfig: {
          algorithm: 'ue-5.8.1-niagara-fft' as const,
          windAngleDegrees: 180,
          windSpeedMPerSec: 0.55,
          noiseTextureGuid: noiseGuid,
          fftResolution: 128,
          domainLengthM: 2.5,
          normalDomainSizeM: 1.5,
          gravityMPerSec2: 9.8,
          phillipsAmplitude: 0.0003,
          windAlignment: 0,
          timeScale: 2.5,
          slosh: 1,
          chopHack: 5,
          twiddle: 'positive' as const,
          normalization: 'none' as const,
          normalRtFormat: 'rgba16float' as const,
          gridMesh: null,
        },
      },
    };
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const context = {
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      frame: { frameNumber: 1 },
      generation: 1,
      views: [],
    };
    const extractContext = {
      ...fixture.context,
      referenceAssetVersion: ({
        handle,
        revision,
        value,
      }: {
        handle: number;
        revision: number;
        value: Asset;
      }) => {
        expect(revision).toBe(fixture.assets.revision(handle as AssetHandle).unwrap());
        expect(value).toEqual(fixture.assets.read(handle as AssetHandle<string, Asset>).unwrap());
      },
    };
    const feature = createWaterAdvancedFeature({});
    const previousOwner = fixture.water.requestOceanPatch(recipe).unwrap();
    previousOwner.update(1 / 60).unwrap();
    const previous = feature.extract(extractContext).unwrap();
    const previousPlan = feature.plan(previous, context).unwrap();
    const submission = (plan: typeof previousPlan): RenderFeatureSubmission => ({
      works: plan.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'compute' ? { resolvedGpuComputeDispatchCount: 1 } : {}),
        })),
      })),
    });
    feature.onFrameSubmitted?.(previous, submission(previousPlan));
    type Observations = Parameters<NonNullable<typeof feature.onFrameReceipt>>[1];
    let finishPrevious: ((value: Awaited<Observations>) => void) | undefined;
    const pending: Observations = new Promise((resolve) => {
      finishPrevious = resolve;
    });
    const receipt: FrameReceipt = {
      frameId: 20,
      deviceGeneration: 0,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    };
    feature.onFrameReceipt?.(receipt, pending);

    fixture.water.removeOceanPatch();
    const replacement = fixture.water.requestOceanPatch(recipe).unwrap();
    replacement.update(1 / 60).unwrap();
    const next = feature.extract({ ...extractContext, frameNumber: 2 }).unwrap();
    feature.onSourceFrameSubmitted?.(
      previous,
      previousPlan.sourceFeedback,
      submission(previousPlan),
    );
    expect(replacement.inspect().submittedSequence).toBe(0);
    expect(next.oceans[0]?.key).not.toBe(previous.oceans[0]?.key);
    const nextPlan = feature.plan(next, context).unwrap();
    expect(
      nextPlan.work
        .flatMap((work) => work.passes)
        .some((pass) => pass.name.endsWith('-init-grid-channels')),
    ).toBe(true);
    feature.onFrameSubmitted?.(next, submission(nextPlan));
    feature.onSourceFrameSubmitted?.(next, nextPlan.sourceFeedback, submission(nextPlan));
    feature.onFrameAborted?.(previous);
    feature.onFrameReceipt?.({ ...receipt, frameId: 21 }, Promise.resolve(ok([])));
    finishPrevious?.(ok([]));
    await Promise.resolve();
    expect(previousOwner.inspect().state.status).toBe('retired');
    expect(replacement.inspect().submittedSequence).toBe(1);
    expect(replacement.inspect().completedSequence).toBe(1);
    expect(replacement.inspect().completion?.frameId).toBe(21);
    expect(
      replacement.inspect().events.filter((event) => event.event === 'created-1x1'),
    ).toHaveLength(1);
    fixture.assets.release(noiseHandle).unwrap();
  });
});
