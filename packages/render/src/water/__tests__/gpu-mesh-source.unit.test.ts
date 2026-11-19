import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  createWaterZoneViewWindow,
  WATER_SYSTEM_RESOURCE,
  type WaterBodySnapshot,
  type WaterBodySourceAsset,
  type WaterDependencySnapshot,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { buildWaterZoneMeshViewForRenderer } from '@forgeax/engine-water/internal';
import { assert, expect, it } from 'vitest';
import { runSingleViewFeatureFrame } from '../../__tests__/single-view-feature-fixture';
import { createRenderFeatureHost } from '../../features/host';
import { createWaterGpuMeshFeature } from '../gpu-mesh-feature';
import { buildWaterGpuMeshZone } from '../gpu-mesh-source';
import {
  createWaterInfoFeature,
  createWaterInfoSourceFeature,
  waterGpuMeshPublicationReadiness,
  waterInfoFramePublicationForRenderer,
} from '../water-info-feature';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const zoneGuid = '00000000-0000-7000-8000-000000000006';
const waveGuid = '00000000-0000-7000-8000-000000000007';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const asset: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 3,
  lodScale: 1,
  gpuMesh: { supersampling: 1, msaaSamples: 1, occlusion: 'disabled' },
  waterInfo: {
    resolution: { widthPx: 16, heightPx: 16 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: true,
    localExtentM: [16, 100, 16],
  },
};

async function fixture(
  origin = 0,
  zoneAsset = asset,
  wave?: { dependency?: WaterDependencySnapshot },
) {
  const source: WaterBodySourceAsset = {
    kind: 'water-body',
    type: 'lake',
    zoneGuid,
    surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
    baseHeightM: 0,
    overlapPriority: 0,
    maxWaveHeightM: 0.25,
    ...(wave === undefined ? {} : { waveSetGuid: waveGuid }),
    flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
    collision: { type: 'none', enabled: false },
    queryFootprint: [
      [-6, -6],
      [6, -6],
      [6, 6],
      [-6, 6],
    ],
    spline: {
      closed: true,
      points: [
        [-6, -6],
        [6, -6],
        [6, 6],
        [-6, 6],
      ].map(([x, z], inputKey) => ({
        inputKey,
        positionM: [requiredFixtureValue(x), 0, requiredFixtureValue(z)],
        arriveTangentM: [0, 0, 0],
        leaveTangentM: [0, 0, 0],
        up: [0, 1, 0],
        rollAngle: 0,
        angleUnit: 'degrees',
        widthM: 1,
        depthM: 2,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
  };
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000699');
  const outputs = (await buildWaterPackOutputs({ lake: source }, { packageId })).unwrap();
  const payloads = new Map(
    Object.entries(outputs).map(([key, value]) => [
      AssetGuid.format(AssetGuid.derive(packageId, key)),
      value,
    ]),
  );
  const matrix = [...identity];
  matrix[12] = origin;
  matrix[14] = origin;
  const zone = { guid: zoneGuid, generation: 1, asset: zoneAsset, worldMatrixM: matrix };
  const water = new WaterSystem(
    () => zone,
    (body) => [
      ...[body.visibleMeshGuid, body.waterInfoMeshGuid].flatMap((guid) => {
        const payload = guid === undefined ? undefined : payloads.get(guid);
        return guid === undefined || payload === undefined
          ? []
          : [{ guid, kind: 'mesh', status: 'valid' as const, payload }];
      }),
      ...(wave?.dependency === undefined ? [] : [wave.dependency]),
    ],
    () => [zone],
  );
  const mount = (guid: string, accepted = true, sourceAssetGuid = 'lake-source') => {
    const body = water.mountBody(guid, '1', outputs.lake, sourceAssetGuid, matrix).unwrap();
    if (accepted)
      water
        .acceptOutput(guid, 'geometry', body.outputGenerations.geometry, {
          generation: 1,
          digest: `accepted-${guid}`,
        })
        .unwrap();
    return requiredFixtureValue(water.snapshot(guid));
  };
  return { water, zone: requiredFixtureValue(water.zoneSnapshots()[0]), mount };
}

it.each([
  'direct',
  'receiver',
] as const)('retains GPU intent and waits only for a proven WaveSet dependency through %s', async (route) => {
  const wave: { dependency?: WaterDependencySnapshot } = {
    dependency: { guid: waveGuid, field: 'waveSetGuid', kind: 'water-wave-set', status: 'pending' },
  };
  const { water, mount } = await fixture(0, asset, wave);
  mount('body');
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  const view = {
    identity: 'main',
    render: true,
    selectedView: {
      position: new Float32Array([0, 4, 0]),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(identity),
    },
    frame: { view: { identity: 'main', deviceGeneration: 4, cameraPosition: [0, 4, 0] } },
  };
  const source = route === 'receiver' ? createWaterInfoSourceFeature() : createWaterInfoFeature();
  const receiver = route === 'receiver' ? createWaterInfoFeature() : source;
  const gpu = createWaterGpuMeshFeature(receiver);
  const context = {
    generation: 1,
    frame: { frameNumber: 1 },
    caps: {
      ...(await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps,
      compute: true,
      storageBuffer: true,
      rgba16floatRenderable: true,
      rgba16floatStorage: true,
    },
    views: [{ identity: 'main', render: true, targets: [], sceneData: { deviceGeneration: 4 } }],
  };
  const extract = (frameNumber: number) =>
    source
      .extract({
        world: world,
        frameNumber,
        views: [view],
        caps: context.caps,
      } as never)
      .unwrap();
  const input = extract(1);
  const received = route === 'receiver' ? structuredClone(input) : input;
  const pending = receiver.plan(received as never, context as never).unwrap();
  expect(pending).toEqual({
    pendingSource: { resource: waveGuid, reason: 'asset-dependency-pending' },
    work: [],
  });
  const publication = requiredFixtureValue(
    waterInfoFramePublicationForRenderer(receiver, 'main', 1, 4),
  );
  expect(publication.gpuMeshes).toHaveLength(1);
  expect(
    requiredFixtureValue(requiredFixtureValue(publication.gpuMeshes)[0]).bodies[0],
  ).toMatchObject({
    waveDependency: { kind: 'pending', guid: waveGuid },
  });
  expect(publication.waveUploadPlan.bodyData).toHaveLength(0);
  const gpuFrame = gpu
    .extract({ world: new World(), frameNumber: 1, views: [view] } as never)
    .unwrap();
  expect(gpuFrame.zones).toHaveLength(1);
  expect(gpu.plan(gpuFrame, context as never).unwrap()).toEqual({
    pendingSource: { resource: waveGuid, reason: 'asset-dependency-pending' },
    work: [],
  });
  receiver.onFrameAborted?.(received as never);
  receiver.onFrameSubmitted?.(received as never, { works: [] });
  expect(waterInfoFramePublicationForRenderer(receiver, 'main', 1, 4)).toBeUndefined();
  wave.dependency = {
    guid: waveGuid,
    field: 'waveSetGuid',
    kind: 'water-wave-set',
    status: 'valid',
    payload: {
      kind: 'water-wave-set',
      sourceMode: 'predefined',
      inputDigest: '0'.repeat(64),
      waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0, steepness: 0 }],
      depthMaskM: 0,
      maxWaveHeightM: 0,
      timeSource: 'scene-clock',
    },
  };
  water.refreshDependencies('body', []).unwrap();
  const readyInput = extract(2);
  const readyReceived = route === 'receiver' ? structuredClone(readyInput) : readyInput;
  const ready = receiver
    .plan(readyReceived as never, { ...context, frame: { frameNumber: 2 } } as never)
    .unwrap();
  expect(ready.pendingSource).toBeUndefined();
  const readyPublication = requiredFixtureValue(
    waterInfoFramePublicationForRenderer(receiver, 'main', 2, 4),
  );
  expect(readyPublication.gpuMeshes).toHaveLength(1);
  expect(readyPublication.waveUploadPlan.bodyData).toHaveLength(1);
  expect(
    waterGpuMeshPublicationReadiness(
      requiredFixtureValue(requiredFixtureValue(readyPublication.gpuMeshes)[0]),
      {
        ...readyPublication,
        waveUploadPlan: { ...readyPublication.waveUploadPlan, bodyIndices: new Map() },
      },
    ),
  ).toMatchObject({ ok: false, error: { code: 'render-feature-stage-failed' } });
  expect(
    waterGpuMeshPublicationReadiness(
      {
        ...requiredFixtureValue(requiredFixtureValue(readyPublication.gpuMeshes)[0]),
        bodies: requiredFixtureValue(
          requiredFixtureValue(readyPublication.gpuMeshes)[0],
        ).bodies.map((body) => ({
          ...body,
          waveDependency: { kind: 'pending', guid: waveGuid },
        })),
      },
      readyPublication,
    ),
  ).toMatchObject({ ok: false, error: { code: 'render-feature-stage-failed' } });
  const readyFrame = gpu
    .extract({ world: new World(), frameNumber: 2, views: [view] } as never)
    .unwrap();
  const readyGpuPlan = gpu
    .plan(readyFrame, { ...context, frame: { frameNumber: 2 } } as never)
    .unwrap();
  expect(
    readyGpuPlan.work.flatMap((work) => work.passes).some((pass) => pass.name.endsWith('-scatter')),
  ).toBe(true);
  expect(gpu.plan(readyFrame, context as never)).toMatchObject({
    ok: false,
    error: { code: 'render-feature-stage-failed' },
  });
  const receipt = (plan: typeof ready) => ({
    works: plan.work.map((work) => ({
      scope: work.scope,
      passes: work.passes.map((pass) => ({
        name: pass.name,
        ...(pass.kind === 'raster'
          ? { graphics: { draws: [{ kind: 'draw' as const }] } }
          : { resolvedGpuComputeDispatchCount: 1 }),
      })),
    })),
  });
  gpu.onFrameAborted?.(readyFrame);
  gpu.onFrameSubmitted?.(readyFrame, receipt(readyGpuPlan));
  const retried = gpu
    .extract({ world: new World(), frameNumber: 2, views: [view] } as never)
    .unwrap();
  expect(
    gpu
      .plan(retried, { ...context, frame: { frameNumber: 2 } } as never)
      .unwrap()
      .work.flatMap((work) => work.passes)
      .some((pass) => pass.name.endsWith('-raster')),
  ).toBe(true);
  receiver.onFrameAborted?.(readyReceived as never);
  receiver.onFrameSubmitted?.(readyReceived as never, receipt(ready));
  expect(waterInfoFramePublicationForRenderer(receiver, 'main', 2, 4)).toBeUndefined();
  world.removeResource(WATER_SYSTEM_RESOURCE);
});

it.each([
  'unavailable',
  'invalid-kind',
  'failed',
  'missing',
] as const)('refuses %s wave dependencies instead of inventing pending', async (status) => {
  const dependency =
    status === 'missing'
      ? undefined
      : status === 'failed'
        ? {
            guid: waveGuid,
            field: 'waveSetGuid',
            kind: 'water-wave-set',
            status,
            failure: {
              code: 'load-failed',
              expected: 'WaveSet bytes',
              hint: 'retry the source loader',
            },
          }
        : { guid: waveGuid, field: 'waveSetGuid', kind: 'water-wave-set', status };
  const { water, zone, mount } = await fixture(
    0,
    asset,
    dependency === undefined ? {} : { dependency },
  );
  mount('body');
  expect(
    buildWaterGpuMeshZone('world', zone, water.snapshots(), {
      identity: 'main',
      position: [0, 4, 0],
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-source' } });
});

it('keeps empty and pending GPU sources quiet, and refuses a 128th intersecting Body', async () => {
  const { water, zone, mount } = await fixture();
  const view = { identity: 'main', position: [0, 4, 0] };
  expect(buildWaterGpuMeshZone('world', zone, [], view).unwrap()).toBeUndefined();
  mount('pending', false);
  expect(buildWaterGpuMeshZone('world', zone, water.snapshots(), view).unwrap()).toBeUndefined();
  water.unmountBody('pending');
  for (let index = 0; index < 127; index++) mount(`body-${index}`);
  expect(
    buildWaterGpuMeshZone('world', zone, water.snapshots(), view).unwrap()?.bodies,
  ).toHaveLength(127);
  mount('overflow');
  expect(buildWaterGpuMeshZone('world', zone, water.snapshots(), view)).toMatchObject({
    ok: false,
    error: { code: 'invalid-source', detail: { count: 128 } },
  });
});

it('subtracts the precise view origin before float storage and moves only at tile snap boundaries', async () => {
  const near = await fixture(0.125);
  near.mount('body');
  const far = await fixture(1_000_000_000.125);
  far.mount('body');
  const build = (source: typeof near, eye: number) =>
    requiredFixtureValue(
      buildWaterGpuMeshZone('world', source.zone, source.water.snapshots(), {
        identity: 'main',
        position: [eye, 4, eye],
      }).unwrap(),
    );
  const a = build(near, 0),
    b = build(far, 1_000_000_000.125);
  expect(
    Math.max(
      ...requiredFixtureValue(b.bodies[0]).vertices.map((value, index) =>
        Math.abs(value - requiredFixtureValue(requiredFixtureValue(a.bodies[0]).vertices[index])),
      ),
    ),
  ).toBeLessThan(0.000001);
  expect(requiredFixtureValue(b.bodies[0]).vertices.some((value) => value % 1 !== 0)).toBe(true);
  expect(build(near, 1.99).originXZ).toEqual(a.originXZ);
  expect(build(near, 2.01).originXZ).toEqual([-4, -4]);
  expect(
    buildWaterGpuMeshZone('world', near.zone, near.water.snapshots(), {
      identity: 'other',
      position: [0, 4, 0],
    }).unwrap()?.key,
  ).not.toBe(a.key);
});

it('rejects nonfinite and overflowing GPU counts before deriving mip descriptors or allocating arrays', async () => {
  const { water, zone, mount } = await fixture();
  mount('body');
  const view = { identity: 'main', position: [0, 4, 0] };
  const window = createWaterZoneViewWindow(zone, view.identity, view.position, 0);
  for (const resolution of [
    [Infinity, 2],
    [2 ** 32, 2],
    [1.5, 2],
    [65536, 65536],
  ] as const) {
    expect(
      buildWaterGpuMeshZone('world', zone, water.snapshots(), {
        ...view,
        window: { ...window, resolution },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-source' } });
  }
});

it('transfers boundary masks derived from the selected far receipt with the GPU source', async () => {
  const bodyGuid = '00000000-0000-7000-8000-000000000008';
  const { water, zone, mount } = await fixture(0, {
    ...asset,
    farExtentM: { spanXM: 32, spanZM: 32 },
    farMaterialGuid: '00000000-0000-7000-8000-000000000009',
    farOwnerBodyGuid: bodyGuid,
    farWaterLevelM: 0,
  });
  const body = mount(bodyGuid, true, bodyGuid);
  const selected = buildWaterZoneMeshViewForRenderer(
    water,
    zone.guid,
    zone.generation,
    zone.asset,
    { viewId: 'main', observerM: [0, 4, 0] },
  ).unwrap();
  expect(selected.receipt.instances).toHaveLength(8);
  expect(selected.receipt.instances.every((tile) => tile.far && tile.ownerGuid === bodyGuid)).toBe(
    true,
  );
  const direct = buildWaterGpuMeshZone('world', zone, [body], {
    identity: 'main',
    position: [0, 4, 0],
    farTiles: selected.receipt.instances,
  }).unwrap();
  assert(direct?.bodies[0]);
  expect(direct.bodies[0].flatFarBoundaryMask).toBe(15);
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  const view = {
    identity: 'main',
    render: true,
    frame: {
      view: {
        identity: 'main',
        deviceGeneration: 4,
        cameraPosition: [0, 4, 0],
      },
    },
  };
  const source = createWaterInfoSourceFeature();
  const input = structuredClone(
    source
      .extract({
        world: world,
        frameNumber: 1,
        views: [view],
      } as never)
      .unwrap(),
  );
  const inputBody = input.views[0]?.gpuMeshes[0]?.bodies[0];
  assert(inputBody);
  expect(inputBody.flatFarBoundaryMask).toBe(15);
  const receiver = createWaterInfoFeature();
  receiver
    .plan(
      input as never,
      {
        generation: 1,
        frame: { frameNumber: 10 },
        caps: (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps,
        views: [
          { identity: 'main', render: true, targets: [], sceneData: { deviceGeneration: 4 } },
        ],
      } as never,
    )
    .unwrap();
  const publishedBody = waterInfoFramePublicationForRenderer(receiver, 'main', 10, 4)
    ?.gpuMeshes?.[0]?.bodies[0];
  assert(publishedBody);
  expect(publishedBody.flatFarBoundaryMask).toBe(15);
  Object.assign(inputBody, { flatFarBoundaryMask: 0 });
  expect(publishedBody.flatFarBoundaryMask).toBe(15);
  world.removeResource(WATER_SYSTEM_RESOURCE);
});

it.each([
  { receiptForm: 'local', span: 16 },
  { receiptForm: 'published', span: 16 },
  { receiptForm: 'local', span: 2048 },
] as const)('prepares GPU mesh work from a detached publication with $receiptForm receipts and $span m extent', async ({
  receiptForm,
  span,
}) => {
  const { water, mount } = await fixture(0, {
    ...asset,
    waterInfo: { ...asset.waterInfo, localExtentM: [span, 100, span] },
  });
  mount('body');
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  const selectedView = {
    position: new Float32Array([0, 4, 0]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(identity),
  };
  const view = {
    identity: 'main',
    render: true,
    selectedView,
    frameSize: { width: 64, height: 64 },
    frame: { view: { identity: 'main', deviceGeneration: 4, cameraPosition: [0, 4, 0] } },
  };
  const source = createWaterInfoSourceFeature();
  const input = structuredClone(
    source.extract({ world: world, frameNumber: 1, views: [view] } as never).unwrap(),
  );
  expect(input.version).toBe(6);
  expect(requiredFixtureValue(input.views[0]).gpuMeshes).toHaveLength(1);
  const receiver = createWaterInfoFeature();
  const gpu = createWaterGpuMeshFeature(receiver);
  const capturedBeforePublication = gpu
    .extract({
      world: new World(),
      frameNumber: 10,
      views: [view],
    } as never)
    .unwrap();
  expect(capturedBeforePublication.zones).toHaveLength(0);
  const planContext = {
    generation: 1,
    frame: { frameNumber: 10 },
    caps: (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps,
    views: [
      {
        identity: 'main',
        render: true,
        selectedView,
        frame: { width: 64, height: 64 },
        targets: [],
        sceneData: { deviceGeneration: 4 },
      },
    ],
  };
  const planned = receiver.plan(input as never, planContext as never);
  expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
  const publication = requiredFixtureValue(
    waterInfoFramePublicationForRenderer(receiver, 'main', 10, 4),
  );
  const original = requiredFixtureValue(
    requiredFixtureValue(requiredFixtureValue(publication.gpuMeshes)[0]).bodies[0],
  ).vertices[0];
  requiredFixtureValue(
    requiredFixtureValue(requiredFixtureValue(input.views[0]).gpuMeshes[0]).bodies[0],
  ).vertices[0] = 99;
  expect(
    requiredFixtureValue(
      requiredFixtureValue(requiredFixtureValue(publication.gpuMeshes)[0]).bodies[0],
    ).vertices[0],
  ).toBe(original);
  const restoredBeforePublication = structuredClone(capturedBeforePublication);
  const deferredPlan = gpu.plan(restoredBeforePublication, planContext as never).unwrap();
  expect(deferredPlan.work.flatMap((work) => work.passes.map((pass) => pass.name))).toEqual(
    expect.arrayContaining([expect.stringMatching(/-raster$/), expect.stringMatching(/-scatter$/)]),
  );
  let frame = gpu.extract({ world: new World(), frameNumber: 10, views: [view] } as never).unwrap();
  const plan = gpu.plan(frame, planContext as never).unwrap();
  expect(plan.work.flatMap((work) => work.passes.map((pass) => pass.name))).toEqual(
    expect.arrayContaining([expect.stringMatching(/-raster$/), expect.stringMatching(/-scatter$/)]),
  );
  if (span === 2048) {
    const mesh = requiredFixtureValue(requiredFixtureValue(publication.gpuMeshes)[0]);
    expect([mesh.width, mesh.height, mesh.nodeCount, mesh.mipOffsets.length]).toEqual([
      512, 512, 349525, 10,
    ]);
    const params = requiredFixtureValue(
      plan.work
        .flatMap((work) => work.resources)
        .find((resource) => resource.kind === 'buffer' && resource.name.endsWith('-params')),
    );
    expect(params.kind).toBe('buffer');
    if (params.kind === 'buffer') {
      const words = params.data as Uint32Array;
      expect(words.length).toBe((7 + 10) * 4);
      expect(Array.from(words.subarray(20, 24))).toEqual([8, 3, 0, 0]);
      expect(Array.from(words.subarray((7 + 9) * 4))).toEqual([349524, 1, 1, 0]);
    }
  }
  const host = createRenderFeatureHost([{ ...gpu, extract: () => ok(frame) }]).unwrap();
  const unsupported = runSingleViewFeatureFrame(host, {
    world: new World(),
    frameNumber: 10,
    caps: { ...planContext.caps, compute: true, storageBuffer: true, indirectDrawing: false },
  });
  expect(unsupported.errors).toMatchObject([
    { code: 'render-feature-capability-missing', detail: { capability: 'indirectDrawing' } },
  ]);
  expect(host.diagnostics()[0]?.status).toBe('disabled');
  expect(unsupported.plans).toHaveLength(0);
  host.dispose();
  frame = gpu.extract({ world: new World(), frameNumber: 10, views: [view] } as never).unwrap();
  expect(
    gpu.plan(frame, { ...planContext, limits: { maxStorageBufferBindingSize: 1024 } } as never),
  ).toMatchObject({ ok: false, error: { code: 'render-feature-stage-failed' } });
  const submit = (mode: 'complete' | 'missing' | 'zero' | 'partial' | 'incomplete') =>
    gpu.onFrameSubmitted?.(frame, {
      works: plan.work
        .filter((work) => mode !== 'partial' || work.scope !== 'frame')
        .map((work) => ({
          scope: work.scope,
          passes: work.passes
            .filter((pass) => mode !== 'incomplete' || !pass.name.endsWith('-merge'))
            .map((pass) => ({
              name: pass.name,
              ...(pass.kind === 'raster'
                ? { graphics: { draws: [{ kind: 'draw' }] } }
                : mode === 'missing'
                  ? {}
                  : receiptForm === 'local'
                    ? { resolvedGpuCompute: { dispatches: mode === 'zero' ? [] : [{}] } }
                    : { resolvedGpuComputeDispatchCount: mode === 'zero' ? 0 : 1 }),
            })),
        })),
    });
  for (const mode of ['missing', 'zero', 'partial', 'incomplete'] as const) {
    submit(mode);
    expect(
      gpu
        .plan(
          gpu.extract({ world: new World(), frameNumber: 10, views: [view] } as never).unwrap(),
          planContext as never,
        )
        .unwrap()
        .work.flatMap((work) => work.passes)
        .some((pass) => pass.name.endsWith('-raster')),
      mode,
    ).toBe(true);
  }
  submit('complete');
  const warm = gpu
    .extract({
      world: new World(),
      frameNumber: 10,
      views: [{ ...view, frame: { view: { ...view.frame.view, cameraPosition: [0, 6, 0] } } }],
    } as never)
    .unwrap();
  const warmPlan = gpu.plan(warm, planContext as never).unwrap();
  expect(
    warmPlan.work.flatMap((work) => work.passes).some((pass) => pass.name.endsWith('-raster')),
  ).toBe(false);
  expect(
    warmPlan.work.flatMap((work) => work.passes).some((pass) => pass.name.endsWith('-traverse')),
  ).toBe(true);
  const changedInput = structuredClone(input);
  requiredFixtureValue(
    requiredFixtureValue(requiredFixtureValue(changedInput.views[0]).gpuMeshes[0]).bodies[0],
  ).vertices[0] = requiredFixtureValue(original) + 0.5;
  receiver
    .plan(changedInput as never, { ...planContext, frame: { frameNumber: 11 } } as never)
    .unwrap();
  const changed = gpu
    .extract({ world: new World(), frameNumber: 11, views: [view] } as never)
    .unwrap();
  expect(
    gpu
      .plan(changed, { ...planContext, frame: { frameNumber: 11 } } as never)
      .unwrap()
      .work.flatMap((work) => work.passes)
      .some((pass) => pass.name.endsWith('-raster')),
  ).toBe(true);
  // An unsubmitted replacement leaves the accepted digest, so it is retried.
  expect(
    gpu
      .plan(gpu.extract({ world: new World(), frameNumber: 11, views: [view] } as never).unwrap(), {
        ...planContext,
        frame: { frameNumber: 11 },
      } as never)
      .unwrap()
      .work.flatMap((work) => work.passes)
      .some((pass) => pass.name.endsWith('-raster')),
  ).toBe(true);
  const recoveredView = { ...view, frame: { view: { ...view.frame.view, deviceGeneration: 5 } } };
  receiver
    .plan(
      input as never,
      {
        ...planContext,
        frame: { frameNumber: 12 },
        views: [{ ...planContext.views[0], sceneData: { deviceGeneration: 5 } }],
      } as never,
    )
    .unwrap();
  expect(
    gpu
      .plan(
        gpu
          .extract({ world: new World(), frameNumber: 12, views: [recoveredView] } as never)
          .unwrap(),
        { ...planContext, frame: { frameNumber: 12 } } as never,
      )
      .unwrap()
      .work.flatMap((work) => work.passes)
      .some((pass) => pass.name.endsWith('-raster')),
  ).toBe(true);
  expect(receiver.plan({ ...input, version: 3 } as never, planContext as never).ok).toBe(false);
  expect(receiver.plan({ ...input, version: 4 } as never, planContext as never).ok).toBe(false);
  expect(receiver.plan({ ...input, version: 5 } as never, planContext as never).ok).toBe(false);
  for (const flatFarBoundaryMask of [undefined, -1, 16, 1.5, Number.NaN]) {
    const invalid = structuredClone(input);
    const invalidBody = invalid.views[0]?.gpuMeshes[0]?.bodies[0];
    assert(invalidBody);
    Object.assign(invalidBody, { flatFarBoundaryMask });
    expect(receiver.plan(invalid as never, planContext as never).ok).toBe(false);
  }
  const missingReadiness = structuredClone(input);
  delete (
    requiredFixtureValue(requiredFixtureValue(missingReadiness.views[0]).gpuMeshes[0])
      .bodies[0] as { waveDependency?: unknown }
  ).waveDependency;
  expect(receiver.plan(missingReadiness as never, planContext as never).ok).toBe(false);
  world.removeResource(WATER_SYSTEM_RESOURCE);
});

it.each([
  'other-zone',
  'unbound',
  'stale-generation',
  'hidden',
  'mesh-disabled',
] as const)('does not reject the current GPU Zone because of an inactive continuity body: %s', async (kind) => {
  const { zone, mount } = await fixture();
  const current = mount('current');
  if (current.binding.kind !== 'bound') throw new Error('Expected bound fixture body');
  const policy = {
    ...current,
    guid: 'policy',
    asset: {
      ...current.asset,
      type: 'river',
      transitionContinuity: { target: 'ocean', endpoint: 'end', reachM: 8, blendWidthM: 2 },
    },
  } as WaterBodySnapshot;
  const ignored: WaterBodySnapshot =
    kind === 'other-zone'
      ? {
          ...policy,
          binding: {
            ...current.binding,
            kind: 'bound',
            zoneGuid: 'other-zone',
            zoneGeneration: zone.generation,
          },
        }
      : kind === 'unbound'
        ? ({
            ...policy,
            binding: { kind: 'zone-unbound', retryOnCatalogChange: true },
          } as WaterBodySnapshot)
        : kind === 'stale-generation'
          ? {
              ...policy,
              binding: {
                ...current.binding,
                kind: 'bound',
                zoneGuid: zone.guid,
                zoneGeneration: zone.generation + 1,
              },
            }
          : kind === 'hidden'
            ? {
                ...policy,
                asset: {
                  ...policy.asset,
                  renderOptions: {
                    castShadow: false,
                    receiveShadow: true,
                    ...policy.asset.renderOptions,
                    visible: false,
                  },
                },
              }
            : {
                ...policy,
                asset: {
                  ...policy.asset,
                  flags: { ...policy.asset.flags, affectsWaterMesh: false },
                },
              };
  const result = buildWaterGpuMeshZone('world', zone, [ignored, current], {
    identity: 'main',
    position: [0, 4, 0],
  }).unwrap();
  expect(result?.bodies.map((body) => body.guid)).toEqual(['current']);
});

it('rejects continuity only for an active current-generation body bound to this GPU Zone', async () => {
  const { zone, mount } = await fixture();
  const current = mount('current');
  const policy = {
    ...current,
    asset: {
      ...current.asset,
      type: 'river',
      transitionContinuity: { target: 'ocean', endpoint: 'end', reachM: 8, blendWidthM: 2 },
    },
  } as WaterBodySnapshot;
  expect(
    buildWaterGpuMeshZone('world', zone, [policy], { identity: 'main', position: [0, 4, 0] }),
  ).toMatchObject({
    ok: false,
    error: { code: 'invalid-source', expected: expect.stringContaining('terminal continuity') },
  });
});
