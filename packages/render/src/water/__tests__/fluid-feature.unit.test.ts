import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  buildWaterPackOutputs,
  prepareWaterFluidFrame,
  WATER_BUOYANCY_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  WATER_VISUAL_CONTACTS_RESOURCE,
  type WaterDependencySnapshot,
  type WaterFluidRecipe,
  WaterSystem,
} from '@forgeax/engine-water';
import { assert, expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../__tests__/feature-frame-driver';
import { createRenderFeatureHost } from '../../features/host';
import { createRenderPublisher } from '../../publication/publisher';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import {
  createWaterFluidFeature,
  type WaterFluidFeatureFrame,
  waterFluidRenderFrame,
} from '../fluid-feature';
import { prepareWaterFluidFoamFrame, type WaterFluidFoamMaterial } from '../fluid-foam';
import { addWaterFluidSharedGraph, type WaterFluidGraphFrame } from '../fluid-graph';

it('allocates one bounded contact-event buffer regardless of the current event count', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const material: WaterFluidFoamMaterial = {
    worldIdentity: 'world',
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    materialHandle: 1,
    mapping: { kind: 'mapped', centerXZ: [0, 0], extentM: 16 },
  };
  for (const count of [0, 1, 5]) {
    const foam = prepareWaterFluidFoamFrame(
      {
        timeSeconds: 0,
        materials: [material],
        roots: [{ worldIdentity: 'world', rootEntity: 1, rootGeneration: 1 }],
        events: Array.from({ length: count }, (_, index) => ({
          worldIdentity: 'world',
          event: {
            sourcePhysicsStep: 1,
            queryTimeSeconds: 0,
            fixedDeltaSeconds: 1 / 60,
            rootEntity: 1,
            rootGeneration: 1,
            pontoonId: String(index),
            bodyGuid: 'ocean',
            bodyGeneration: 1,
            phase: 'wake' as const,
            positionM: [0, 0, 0] as const,
            forceN: [0, 1, 0] as const,
            contact: {
              kind: 'water-plane-intersection' as const,
              positionM: [0, 0, 0] as const,
              radiusM: 1,
              relativeVelocityMps: [1, 0, 0] as const,
            },
          },
        })),
      },
      { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
      0,
      1,
    ).unwrap();
    assert(foam);
    const graph = new RenderGraphBuilder<WaterFluidGraphFrame>();
    addWaterFluidSharedGraph({
      graph,
      waterInfoPublication: undefined,
      waterFluid: {
        token: 'frame',
        simulations: [],
        waterInfoViewIdentity: undefined,
        frameNumber: 1,
        deviceGeneration: 0,
        contactFoam: foam,
        required: new Set(),
        encoded: new Set(),
      },
    }).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    expect(
      compiled
        .inspect()
        .resources.find((resource) => resource.label === 'water-fluid-contact-events')?.byteSize,
    ).toBe(4096 * 32);
    (await compiled.retire()).unwrap();
  }
});

it('starts contact history again after a submitted frame has no visible material', async () => {
  const feature = createWaterFluidFeature({
    contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
  });
  const material: WaterFluidFoamMaterial = {
    worldIdentity: 'world',
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    materialHandle: 1,
    mapping: { kind: 'mapped', centerXZ: [0, 0], extentM: 16 },
  };
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const plan = (sourceFrame: number, visible: boolean) => {
    const data: WaterFluidFeatureFrame = {
      kind: 'forgeax-water-fluid-frame',
      sourceFrame,
      simulations: [],
      sourceBlockers: [],
      inspection: [],
      contactFoamBodies: [material],
      contactFoam: {
        worldTimes: [{ worldIdentity: 'world', timeSeconds: sourceFrame / 60 }],
        materials: [material],
        roots: [],
        events: [],
      },
    };
    const result = feature.plan(data, {
      frame: { frameNumber: sourceFrame },
      generation: 0,
      caps: device.caps,
      views: [
        {
          identity: 'main',
          render: true,
          frame: { frameNumber: sourceFrame, waterFoamMaterials: visible ? [material] : [] },
          targets: [],
          sceneData: createSceneDataCatalog({
            featureIdentity: feature.identity,
            viewIdentity: 'main',
            generation: 0,
            planIdentity: 'contact-foam',
            rgba16floatRenderable: true,
          }),
        },
      ],
    });
    expect(result.ok).toBe(true);
    const render = waterFluidRenderFrame([feature]);
    assert(render);
    return { data, render };
  };
  const first = plan(1, true);
  expect(first.render.contactFoam?.initialize).toBe(true);
  first.render.required.add('contact-foam/stamp');
  first.render.encoded.add('contact-foam/stamp');
  feature.onFrameSubmitted?.(first.data);
  const continued = plan(2, true);
  expect(continued.render.contactFoam?.initialize).toBe(false);
  feature.onFrameAborted?.(continued.data);
  const hidden = plan(3, false);
  expect(hidden.render.contactFoam).toBeUndefined();
  feature.onFrameSubmitted?.(hidden.data);
  const returned = plan(4, true);
  expect(returned.render.contactFoam?.initialize).toBe(true);
  feature.onFrameAborted?.(returned.data);
});

function recipe(): WaterFluidRecipe {
  const target = (channels: WaterFluidRecipe['targets']['height']['channels']) => ({
    format: 'rgba16float' as const,
    filter: 'linear' as const,
    address: 'repeat' as const,
    origin: 'top-left' as const,
    channels,
    clear: [0, 0, 0, 1] as const,
  });
  return {
    kind: 'water-simulation-recipe',
    system: 'fluid-simulation',
    configurationVersion: 1,
    solverMode: 'ripple',
    terrainMode: 'constant-depth',
    resolution: [16, 16],
    virtualFps: 60,
    maxStepsPerFrame: 5,
    gridExtentM: [24, 24],
    waveFoam: { resolution: 16, gridExtentM: 24 },
    maxImpulses: 8,
    impulseNoiseGuid: '00000000-0000-7000-8000-000000000001',
    targets: {
      height: target('ripple-height-m'),
      velocity: target('velocity-xz-m/s'),
      normalHeight: target('normal-xz-height-m'),
      forces: target('height-foam-mask'),
      velocityForces: target('velocity-xz-m/s'),
      wave: target('wave-foam'),
      foam: target('foam'),
    },
    injectionLimits: {
      heightDeltaM: { encodedRange: [-2, 2], unit: 'm' },
      foamStrength: { encodedRange: [0, 4], unit: 'unitless' },
    },
    parameters: {
      travelSpeed: 0.95,
      rippleDamping: 0.01,
      rippleFoamDamping: 0.998,
      rippleFoamErasure: 0.1,
      fluidDampingPerSecond: 0.1,
      gravityMPerSecSquared: 9.8,
      shallowEdgeLengthM: 0.001,
      shallowFadingBackPerSecond: 0.25,
      terrainUseWaterDepthOnly: 0,
      shallowFoamFadePerSecond: 2,
      shallowFoamInjection: 0.5,
      shallowVelocityForFoamMPerSecond: 1.28,
      shallowFoamSlopeMinimum: 0.5,
      shallowFoamSlopeRange: 0.05,
      shallowNormalHeightScale: 5,
      constantWaterDepthM: 2,
      evaporationMPerSecond: 0,
      maskThreshold: 0.5,
      normalHeightScale: 1,
      waveNormalAmount: 10,
      waveNormalBias: 0,
      waveMinimumHeightM: 0.48,
      normalDefaultDepthM: 0,
      normalFoamAmount: 0.01,
      normalFoamHeightScale: 16,
      normalEdgeFalloff: 0.2,
      waveHeightDivisorM: 0.48,
      waveEdgeFalloff: 0.2,
      waveTimeBiasSeconds: 0,
      foamFadePerFrame: 0.006,
      foamDiffusion: 0.5,
      foamEdgeFalloff: 0.2,
      foamWetPerMeter: 2,
      foamWetFadePerFrame: 0.001,
      foamToneMapDensity: 0.1,
    },
    shallowFoamEnabled: true,
    foamEnabled: true,
    materialGuids: [],
    textureGuids: [],
  };
}

async function fixture(configuration = recipe(), instanceId = 'fluid', ocean = false) {
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000491');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const point = (inputKey: number, x: number, z: number) => ({
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
  });
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'lake',
          ...(ocean
            ? {
                type: 'ocean' as const,
                oceanExtentM: [100, 100] as const,
                centerOnWaterZone: false,
              }
            : {}),
          spline: {
            closed: true,
            points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
          },
          baseHeightM: 0,
          overlapPriority: 0,
          maxWaveHeightM: 0.2,
          surfaceMaterialGuid: guid('material'),
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'none', enabled: false },
          queryFootprint: [
            [-2, -2],
            [2, -2],
            [2, 2],
            [-2, 2],
          ],
        },
      },
      { packageId },
    )
  ).unwrap();
  let dependency: WaterDependencySnapshot = {
    guid: guid('waves'),
    kind: 'water-wave-set',
    field: 'waveSetGuid',
    status: 'pending',
  };
  const system = new WaterSystem(
    () => undefined,
    () => [dependency],
  );
  const body = system
    .mountBody('body', '1', { ...packed.body, waveSetGuid: guid('waves') })
    .unwrap();
  vi.spyOn(system, 'snapshot').mockImplementation(() => ({ ...body, dependencies: [dependency] }));
  system.fluid
    .reconcile([
      {
        instanceId,
        recipeGuid: 'recipe',
        recipeVersion: '1',
        recipe: configuration,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        centerM: [0, 0, 0],
        waveFoamCenterM: [0, 0, 0],
        enabled: true,
        resetRevision: 0,
        impulseNoiseDependency: {
          guid: configuration.impulseNoiseGuid,
          kind: 'texture',
          status: 'valid',
        },
      },
    ])
    .unwrap();
  system.fluid
    .enqueueImpulse(instanceId, {
      kind: 'direct',
      positionM: [0, 0, 0],
      radiusM: 1,
      heightDeltaM: 0.2,
      lifetimeSeconds: 0,
      foamStrength: 0.5,
    })
    .unwrap();
  const assets = new AssetRegistry();
  publishRuntimeAssets(assets, [
    {
      guid: configuration.impulseNoiseGuid,
      asset: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        data: new Uint8Array([127, 127, 127, 255]),
        mips: { kind: 'none' },
      },
    },
  ]);
  (await assets.load(configuration.impulseNoiseGuid, 'texture')).unwrap();
  const world = new World({ assets });
  world.insertResource(WATER_SYSTEM_RESOURCE, system);
  world.update(1 / 60).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const feature = createWaterFluidFeature();
  const host = createRenderFeatureHost([feature]).unwrap();
  const run = () =>
    prepareFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        world: world,
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
      },
    ]);
  const change = (status: WaterDependencySnapshot['status']) => {
    dependency =
      status === 'failed'
        ? {
            ...dependency,
            status,
            failure: { code: 'load-failed', expected: 'wave bytes', hint: 'repair catalog' },
          }
        : { guid: guid('waves'), kind: 'water-wave-set', field: 'waveSetGuid', status };
  };
  const dispose = () => {
    abortFeatureFrame(host);
    host.dispose().unwrap();
    system.fluid.clear();
    assets.dispose();
  };
  return { system, host, run, change, dispose, world, device, assets };
}

it('bounds continuous visual contact state during cold GPU preparation and keeps newer contacts after an older acknowledgement', async () => {
  const f = await fixture(recipe(), 'cold-contact', true);
  f.system.fluid.clear();
  const feature = createWaterFluidFeature({
    contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
  });
  const reportError = vi.fn();
  const body = f.system.snapshot('body');
  assert(body);
  const root = { rootEntity: 2, rootGeneration: 3, sourceIdentity: 'hull-waterline' };
  const extract = (step: number) => {
    f.world.update(1 / 60).unwrap();
    f.world.insertResource(WATER_VISUAL_CONTACTS_RESOURCE, {
      roots: [root],
      failures: [],
      contacts: Array.from({ length: 128 }, (_, i) => ({
        ...root,
        kind: 'visual-probe' as const,
        sourcePhysicsStep: step,
        queryTimeSeconds: f.world.getResource(Time).elapsed,
        probeId: `probe-${i}`,
        bodyGuid: 'body',
        bodyGeneration: body.sceneGeneration,
        phase: 'contact' as const,
        coverage: 0.4,
        contact: {
          kind: 'water-plane-intersection' as const,
          positionM: [step / 60, 0, i / 128] as const,
          radiusM: 0.2,
          relativeVelocityMps: [1, 0, 0] as const,
        },
      })),
    });
    return feature.extract({ world: f.world, frameNumber: step, views: [], reportError }).unwrap();
  };
  try {
    const first = extract(1);
    const held = first.contactFoam?.events;
    let current = first;
    for (let step = 2; step <= 100; step++) current = extract(step);
    expect(reportError).not.toHaveBeenCalled();
    expect(current.contactFoam?.events).toHaveLength(128);
    expect(current.contactFoam?.events.every((row) => row.event.sourcePhysicsStep === 100)).toBe(
      true,
    );
    expect(held?.every((row) => row.event.sourcePhysicsStep === 1)).toBe(true);
    // The first candidate's acknowledgement must not remove the newer pending state.
    const material: WaterFluidFoamMaterial = {
      worldIdentity: f.world.identity,
      bodyGuid: 'body',
      bodyGeneration: body.sceneGeneration,
      materialHandle: 1,
      mapping: { kind: 'mapped', centerXZ: [0, 0], extentM: 16 },
    };
    const accepted = prepareWaterFluidFoamFrame(
      {
        timeSeconds: 2,
        materials: [material],
        roots: [{ ...root, worldIdentity: f.world.identity }],
        events: first.contactFoam?.events ?? [],
      },
      { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
      0,
      1,
    ).unwrap();
    assert(accepted);
    feature.onSourceFrameSubmitted?.(first, {
      kind: 'water-fluid-submitted',
      sourceFrame: 1,
      submitted: [],
      contactFoam: accepted,
    });
    expect(extract(101).contactFoam?.events).toHaveLength(128);
  } finally {
    f.dispose();
  }
});

it('uses explicit hull contact probes ahead of pontoon foam proxies and retains the fallback without probes', async () => {
  const f = await fixture(recipe(), 'contact-authority', true);
  f.system.fluid.clear();
  const body = f.system.snapshot('body');
  assert(body);
  const root = { rootEntity: 2, rootGeneration: 3 };
  const wake = {
    ...root,
    sourcePhysicsStep: 5,
    queryTimeSeconds: f.world.getResource(Time).elapsed,
    fixedDeltaSeconds: 1 / 60,
    pontoonId: 'aft-force-point',
    bodyGuid: 'body',
    bodyGeneration: body.sceneGeneration,
    phase: 'wake' as const,
    positionM: [0, 0, 0] as const,
    forceN: [0, 30, 0] as const,
    contact: {
      kind: 'water-plane-intersection' as const,
      positionM: [0, 0, 0] as const,
      radiusM: 1,
      relativeVelocityMps: [2, 0, 0] as const,
    },
  };
  f.world.insertResource(PhysicsWorldResource, {
    getCommittedBodyDynamics: () => ({ ok: true, value: { generation: 3, completedStep: 5 } }),
  });
  f.world.insertResource(WATER_BUOYANCY_RESOURCE, {
    steps: [{ result: { ok: true, value: root } }],
    splashWakeEvents: [wake],
  });
  const probe = { ...root, sourceIdentity: 'native-hull-contact' };
  const extract = (explicit: boolean) => {
    f.world.insertResource(WATER_VISUAL_CONTACTS_RESOURCE, {
      roots: explicit ? [probe] : [],
      failures: [],
      contacts: [],
    });
    const feature = createWaterFluidFeature({
      contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
    });
    return feature.extract({ world: f.world, frameNumber: 1, views: [] }).unwrap().contactFoam
      ?.events;
  };
  try {
    expect(extract(true)).toEqual([]);
    expect(extract(false)?.map((row) => row.event)).toEqual([wake]);
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('skips clocks in worlds without water with contact foam %s', (contactFoam) => {
  const world = new World();
  const read = vi.spyOn(world, 'getResource').mockImplementation(() => {
    throw new Error('A world without water has no fluid clock dependency');
  });
  const feature = createWaterFluidFeature(
    contactFoam
      ? {
          contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
        }
      : {},
  );
  for (const source of [new World(), world]) {
    const result = feature.extract({ world: source, frameNumber: 1, views: [] });
    expect(result.unwrap().simulations).toEqual([]);
  }
  expect(read).not.toHaveBeenCalled();
});

it('uses the admitted source World clock independently of another World', async () => {
  const a = await fixture({ ...recipe(), foamEnabled: false }, 'a', true);
  const b = await fixture({ ...recipe(), foamEnabled: false }, 'b', true);
  a.system.fluid.clear();
  b.system.fluid.clear();
  const feature = createWaterFluidFeature({
    contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
  });
  a.world.update(0.02).unwrap();
  b.world.update(0.07).unwrap();
  expect(a.world.getResource(Time).elapsed).not.toBe(b.world.getResource(Time).elapsed);
  const body = b.system.snapshot('body');
  assert(body);
  const material: WaterFluidFoamMaterial = {
    worldIdentity: b.world.identity,
    bodyGuid: 'body',
    bodyGeneration: body.sceneGeneration,
    materialHandle: 1,
    mapping: { kind: 'mapped', centerXZ: [0, 0], extentM: 16 },
  };
  try {
    for (const source of [b.world, b.world]) {
      const data = feature.extract({ world: source, frameNumber: 1, views: [] }).unwrap();
      const planned = feature.plan(data, {
        frame: { frameNumber: 1 },
        generation: 0,
        caps: a.device.caps,
        views: [
          {
            identity: 'main',
            render: true,
            frame: { frameNumber: 1, waterFoamMaterials: [material] },
            targets: [],
            sceneData: createSceneDataCatalog({
              featureIdentity: feature.identity,
              viewIdentity: 'main',
              generation: 0,
              planIdentity: 'world-clock',
              rgba16floatRenderable: true,
            }),
          },
        ],
      });
      planned.unwrap();
      expect(waterFluidRenderFrame([feature])?.contactFoam?.timeSeconds).toBe(
        b.world.getResource(Time).elapsed,
      );
      feature.onFrameAborted?.(data);
    }
  } finally {
    a.dispose();
    b.dispose();
  }
});

it('keeps newer Water source history when publication acknowledges equal-time flights in reverse', async () => {
  const f = await fixture({ ...recipe(), foamEnabled: false });
  const feature = createWaterFluidFeature();
  const extract = feature.extract;
  let captured: WaterFluidFeatureFrame | undefined;
  feature.extract = (context) => {
    const result = extract(context);
    if (result.ok) captured = result.value;
    return result;
  };
  const publisher = createRenderPublisher(
    f.world,
    f.assets,
    { source: 'fluid-ack-order', epoch: 1 },
    undefined,
    [feature],
  );
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const data = captured;
    if (data === undefined) throw new Error('Missing extracted Water source frame');
    const feedback = {
      kind: 'water-fluid-submitted',
      sourceFrame: data.sourceFrame,
      submitted: data.simulations,
    };
    const revision = candidate.packet.revision;
    candidate.accept();
    return { revision, feedback };
  };
  try {
    const older = seal();
    f.system.fluid
      .enqueueImpulse('fluid', {
        kind: 'direct',
        positionM: [0, 0, 0],
        radiusM: 1,
        heightDeltaM: -0.4,
        lifetimeSeconds: 10,
        foamStrength: 0.5,
      })
      .unwrap();
    const newer = seal();
    publisher
      .acknowledgeFeatures(newer.revision, [
        { identity: feature.identity, feedback: newer.feedback },
      ])
      .unwrap();
    publisher
      .acknowledgeFeatures(older.revision, [
        { identity: feature.identity, feedback: older.feedback },
      ])
      .unwrap();
    expect(f.system.fluid.inspect().fluid).toMatchObject({
      queuedImpulses: 0,
      activeImpulses: [{ sequence: 2, heightDeltaM: -0.4 }],
    });
  } finally {
    publisher.dispose();
    f.dispose();
  }
});

it.each([
  'reorder',
  'remove',
] as const)('keeps same-local-ID fluid histories with their World after %s', async (transition) => {
  const instanceId = 'scene-entity:0';
  const configuration = { ...recipe(), foamEnabled: false };
  const a = await fixture(configuration, instanceId);
  const b = await fixture(configuration, instanceId);
  const hosts = new Map([
    [a.world, a.host],
    [b.world, b.host],
  ]);
  const device = a.device;
  const noise = device
    .createTexture({
      format: 'rgba8unorm-srgb',
      size: { width: 1, height: 1 },
      usage: 0x04,
    })
    .unwrap();
  const graphs: CompiledRenderGraph<WaterFluidGraphFrame>[] = [];
  const previousGraphs = new Map<World, CompiledRenderGraph<WaterFluidGraphFrame>>();
  let frameNumber = 0;
  const run = (order: readonly World[]) => {
    const histories = new Map<
      World,
      NonNullable<ReturnType<CompiledRenderGraph<WaterFluidGraphFrame>['getColorTargetTexture']>>
    >();
    const frames = new Map<
      World,
      NonNullable<ReturnType<typeof waterFluidRenderFrame>>['simulations'][number]['frame']
    >();
    ++frameNumber;
    for (const world of order) {
      const host = hosts.get(world);
      if (host === undefined) throw new Error('Missing source World host');
      const batch = prepareFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          world,
          frameNumber,
          generation: 0,
          caps: device.caps,
        },
      ]);
      expect(batch.frame.errors).toEqual([]);
      const render = waterFluidRenderFrame(host.features);
      if (render === undefined) throw new Error('Missing source World fluid frame');
      const builder = new RenderGraphBuilder<WaterFluidGraphFrame>();
      addWaterFluidSharedGraph({
        graph: builder,
        waterFluid: render,
        waterInfoPublication: undefined,
        resolveImpulseNoise(entry) {
          if (entry.impulseNoise === undefined) throw new Error('Missing fluid noise snapshot');
          return { texture: noise, asset: entry.impulseNoise.asset };
        },
      }).unwrap();
      const previous = previousGraphs.get(world);
      const graph = builder
        .compile({
          device,
          surfaceSize: { width: 16, height: 16 },
          ...(previous === undefined ? {} : { reuseResourcesFrom: previous }),
        })
        .unwrap();
      graphs.push(graph);
      previousGraphs.set(world, graph);
      const heights = graph
        .inspect()
        .resources.filter(
          (resource) => resource.kind === 'texture' && resource.label.endsWith('-height0'),
        );
      const resource = heights[0];
      if (resource === undefined) throw new Error('Missing World fluid history texture');
      const texture = graph.getColorTargetTexture(resource.label);
      if (texture === undefined) throw new Error('Missing physical fluid history texture');
      histories.set(world, texture);
      const simulation = render.simulations[0];
      if (simulation === undefined) throw new Error('Missing source World fluid frame');
      frames.set(world, simulation.frame);
      const encoder = device.createCommandEncoder().unwrap();
      const runtime = {
        device,
        immediateShaderModuleFactory: {
          createShaderModule: (desc: Parameters<typeof rhi.createShaderModuleImmediate>[1]) =>
            rhi.createShaderModuleImmediate(device, desc),
        },
      };
      graph.execute({ encoder, runtime }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      graph.commitExecution();
      submitFeatureFrame(host);
    }
    return { frames, histories };
  };
  const impulse = {
    kind: 'direct' as const,
    positionM: [0, 0, 0] as const,
    radiusM: 1,
    heightDeltaM: 0.2,
    lifetimeSeconds: 0,
    foamStrength: 0.5,
  };
  try {
    run([a.world, b.world]);
    expect(a.system.fluid.enqueueImpulse(instanceId, impulse).unwrap()).toBe(2);
    a.world.update(4.5 / 60).unwrap();
    b.world.update(1.5 / 60).unwrap();
    const before = run([a.world, b.world]);
    const previousA = before.frames.get(a.world);
    const previousB = before.frames.get(b.world);
    if (previousA === undefined || previousB === undefined)
      throw new Error('Missing submitted frames');
    const lastStep = (frame: typeof previousA) => frame.steps.at(-1)?.fixedStep ?? frame.baseStep;
    expect(previousA.simulationGeneration).toBe(previousB.simulationGeneration);
    expect(lastStep(previousA)).toBeGreaterThan(lastStep(previousB));
    expect(b.system.fluid.enqueueImpulse(instanceId, impulse).unwrap()).toBe(2);
    a.world.update(1.5 / 60).unwrap();
    b.world.update(1.5 / 60).unwrap();
    const after = run(transition === 'reorder' ? [b.world, a.world] : [b.world]);
    const currentB = after.frames.get(b.world);
    if (currentB === undefined) throw new Error('Missing remaining World fluid frame');
    expect.soft(currentB.baseStep).toBe(lastStep(previousB));
    expect.soft(currentB.pendingImpulses.map((force) => force.sequence)).toEqual([2]);
    expect.soft(after.histories.get(b.world)).toBe(before.histories.get(b.world));
    expect.soft(after.histories.get(b.world)).not.toBe(before.histories.get(a.world));
    if (transition === 'reorder') {
      const currentA = after.frames.get(a.world);
      if (currentA === undefined) throw new Error('Missing reordered World fluid frame');
      expect.soft(currentA.baseStep).toBe(lastStep(previousA));
      expect.soft(after.histories.get(a.world)).toBe(before.histories.get(a.world));
    }
  } finally {
    for (const host of hosts.values()) abortFeatureFrame(host);
    for (const graph of graphs) await graph.retire();
    device.destroyTexture(noise).unwrap();
    a.dispose();
    b.dispose();
  }
});

it.each([
  0.001, 0.02,
])('projects forces before grid movement and publishes the actual solver center at time %s', async (time) => {
  const configuration = { ...recipe(), foamEnabled: false };
  const input = {
    instanceId: 'moving-fluid',
    recipeGuid: 'recipe',
    recipeVersion: '1',
    recipe: configuration,
    bodyGuid: 'body',
    bodyGeneration: 1,
    centerM: [0, 0, 0] as const,
    waveFoamCenterM: [0, 0, 0] as const,
    enabled: true,
    resetRevision: 0,
    impulseNoiseDependency: {
      guid: configuration.impulseNoiseGuid,
      kind: 'texture',
      status: 'valid' as const,
    },
  };
  const worldIdentity = new World().identity;
  const initial = prepareWaterFluidFrame(input, 1, 0, 0, 0, []);
  const requested = { ...input, centerM: [1.375, 0, -0.25] as const };
  const frame = prepareWaterFluidFrame(requested, 1, time, 0, 1, [], initial);
  const render = {
    token: 'moving-grid',
    frameNumber: 1,
    deviceGeneration: 0,
    simulations: [{ worldIndex: 0, worldIdentity, frame }],
    encoded: new Set<string>(),
    required: new Set<string>(),
    waterInfoViewIdentity: undefined,
  };
  const builder = new RenderGraphBuilder<WaterFluidGraphFrame>();
  addWaterFluidSharedGraph({
    graph: builder,
    waterFluid: render,
    waterInfoPublication: undefined,
  }).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const labels = new Map<object, string>();
  const createBuffer = device.createBuffer.bind(device);
  vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
    const buffer = createBuffer(desc);
    if (buffer.ok) labels.set(buffer.value, desc.label ?? '');
    return buffer;
  });
  const uploads = new Map<string, Float32Array>();
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, offset, data, ...rest) => {
    const values = ArrayBuffer.isView(data)
      ? new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4).slice()
      : new Float32Array(data).slice();
    uploads.set(labels.get(buffer) ?? '', values);
    return writeBuffer(buffer, offset, data, ...rest);
  });
  const initialBuilder = new RenderGraphBuilder<WaterFluidGraphFrame>();
  addWaterFluidSharedGraph({
    graph: initialBuilder,
    waterFluid: { ...render, simulations: [{ worldIndex: 0, worldIdentity, frame: initial }] },
    waterInfoPublication: undefined,
  }).unwrap();
  const previous = initialBuilder
    .compile({ device, surfaceSize: { width: 16, height: 16 } })
    .unwrap();
  const runtime = {
    device,
    immediateShaderModuleFactory: {
      createShaderModule: (desc: Parameters<typeof rhi.createShaderModuleImmediate>[1]) =>
        rhi.createShaderModuleImmediate(device, desc),
    },
  };
  const initialEncoder = device.createCommandEncoder().unwrap();
  previous.execute({ encoder: initialEncoder, runtime }).unwrap();
  device.queue.submit([initialEncoder.finish().unwrap()]).unwrap();
  previous.commitExecution();
  uploads.clear();
  const graph = builder
    .compile({ device, surfaceSize: { width: 16, height: 16 }, reuseResourcesFrom: previous })
    .unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder, runtime }).unwrap();
    const uploaded = (suffix: string) => {
      const values = [...uploads].find(([label]) => label.endsWith(suffix))?.[1];
      if (values === undefined) throw new Error(`Missing ${suffix} upload`);
      return Array.from(values.slice(4, 6));
    };
    expect(uploaded('-force-parameters')).toEqual([0, 0]);
    expect(uploaded('-tick-parameters')).toEqual(
      time < 1 / configuration.virtualFps ? [0, 0] : [1.375, -0.25],
    );
    expect(frame.initialize).toBe(false);
    expect(graph.inspect().passes.some((pass) => pass.name.includes('-initialize-'))).toBe(false);
  } finally {
    await graph.retire();
    await previous.retire();
  }
});

it('holds a cold wave dependency and queued force until a ready frame can plan', async () => {
  const f = await fixture();
  try {
    const pending = f.run();
    expect(pending.frame.preparationPendingReason).toMatchObject({
      featureIdentity: 'water-fluid-simulation',
      preparationStage: 'source-plan',
      reason: 'asset-dependency-pending',
    });
    expect(pending.frame.errors).toEqual([]);
    expect(waterFluidRenderFrame(f.host.features)).toBeUndefined();
    submitFeatureFrame(f.host);
    expect(f.system.fluid.inspect().fluid).toMatchObject({
      kind: 'initializing',
      queuedImpulses: 1,
    });
    f.change('valid');
    f.world.update(1 / 60).unwrap();
    const ready = f.run();
    expect(
      ready.frame.preparationPending,
      JSON.stringify(ready.frame.preparationPendingReason),
    ).not.toBe(true);
    const render = waterFluidRenderFrame(f.host.features);
    expect(render?.simulations[0]?.frame.impulses).toHaveLength(1);
    expect(render?.simulations[0]?.frame.initialize).toBe(true);
    expect(render?.simulations[0]?.frame.timeSeconds).toBe(f.world.getResource(Time).elapsed);
  } finally {
    f.dispose();
  }
});

it.each([
  'unavailable',
  'failed',
  'invalid-kind',
] as const)('keeps %s wave dependencies as structured faults after pending', async (status) => {
  const f = await fixture();
  try {
    expect(f.run().frame.errors).toEqual([]);
    abortFeatureFrame(f.host);
    f.change(status);
    const failed = f.run();
    expect(failed.frame.errors).toEqual([
      expect.objectContaining({
        code: 'render-feature-stage-failed',
        detail: expect.objectContaining({ cause: expect.objectContaining({ status }) }),
      }),
    ]);
    expect(waterFluidRenderFrame(f.host.features)).toBeUndefined();
    submitFeatureFrame(f.host);
    expect(f.system.fluid.inspect().fluid).toMatchObject({
      kind: 'initializing',
      queuedImpulses: 1,
    });
  } finally {
    f.dispose();
  }
});
