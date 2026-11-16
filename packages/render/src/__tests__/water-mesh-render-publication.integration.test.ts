import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { RenderBundle } from '@forgeax/engine-rhi';
import {
  RhiNullComputePassEncoder,
  RhiNullDevice,
  RhiNullQueue,
  RhiNullRenderPassEncoder,
  rhi,
} from '@forgeax/engine-rhi-null';
import {
  propagateTransforms,
  Transform,
  WaterBodyInstance,
  WaterZoneInstance,
} from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  type WaterBodyAsset,
  type WaterBodySourceAsset,
  type WaterDependencySnapshot,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { createWaterMeshLayoutReceipt } from '@forgeax/engine-water/internal';
import { assert, expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { viewSharedFeatureGraphPassName } from '../features/frame-plan';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { renderPublicationTransfers } from '../publication/record';
import type { FrameReceipt } from '../render-contract';
import { MaterialFrame } from '../scene/material-dispatch';
import { PersistentRenderScene } from '../scene/render-scene';
import { SubsurfaceSelection } from '../subsurface/selection';
import {
  finalizeWaterMaterialAdmissionDraws,
  isOwnedWaterMeshAdmissionUpload,
  offsetWaterMeshAdmissionDraw,
  projectWaterMeshAdmissionTiles,
  retainWaterMeshCandidateAdmissionDraw,
  waterMeshAdmissionUpload,
} from '../water/mesh-source-admission';
import {
  createWaterInfoFeature,
  createWaterInfoSourceFeature,
  type WaterInfoPublicationInput,
  type WaterInfoSourceFeedback,
  waterInfoFramePublicationForRenderer,
} from '../water/water-info-feature';
import { projectWaterMeshView } from '../water-mesh-source';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('reuses renderer-owned candidate uploads and rejects borrowed replacements', async () => {
  const bytes = new Uint8Array(96);
  const coverageBytes = new Uint8Array(4);
  const transitionTargets = Object.freeze([
    Object.freeze({ instanceIndex: 0, bodyGuid: 'transition-body', bodyGeneration: 7 }),
  ]);
  const tiles = {
    drawKey: 'candidate-draw',
    bodyGuid: 'candidate-body',
    bodyGeneration: 3,
    worldIdentity: 'candidate-world',
    zoneGeneration: 5,
    viewIdentity: 'candidate-view',
    bytes,
    coverageBytes,
    layout: createWaterMeshLayoutReceipt(bytes, coverageBytes),
    transitionTargets,
  };
  const sourceDraw = retainWaterMeshCandidateAdmissionDraw(
    {
      guid: tiles.bodyGuid,
      generation: tiles.bodyGeneration,
      worldIdentity: tiles.worldIdentity,
      zoneGeneration: tiles.zoneGeneration,
    },
    tiles.viewIdentity,
    {
      ...tiles,
      materialIndex: 0,
      mesh: createPrimitiveMesh('cube').unwrap(),
      localAabb: new Float32Array(6),
      instanceCount: 1,
    },
  );
  expect(sourceDraw.bytes).toBe(bytes);
  const firstProjection = projectWaterMeshAdmissionTiles({ ...tiles }, sourceDraw);
  const upload = waterMeshAdmissionUpload(firstProjection);
  expect(isOwnedWaterMeshAdmissionUpload(upload)).toBe(true);
  expect(waterMeshAdmissionUpload(projectWaterMeshAdmissionTiles({ ...tiles }, sourceDraw))).toBe(
    upload,
  );

  const offsetDraw = offsetWaterMeshAdmissionDraw(sourceDraw, 2);
  expect(waterMeshAdmissionUpload(projectWaterMeshAdmissionTiles({ ...tiles }, offsetDraw))).toBe(
    upload,
  );
  const borrowedCopy = { ...sourceDraw, bytes: sourceDraw.bytes.slice() };
  const borrowedProjection = projectWaterMeshAdmissionTiles(
    { ...tiles, bytes: borrowedCopy.bytes },
    borrowedCopy,
  );
  expect(isOwnedWaterMeshAdmissionUpload(waterMeshAdmissionUpload(borrowedProjection))).toBe(false);

  const nextBytes = bytes.slice();
  nextBytes[0] = 1;
  const nextDraw = retainWaterMeshCandidateAdmissionDraw(
    {
      guid: tiles.bodyGuid,
      generation: tiles.bodyGeneration,
      worldIdentity: tiles.worldIdentity,
      zoneGeneration: tiles.zoneGeneration,
    },
    tiles.viewIdentity,
    {
      ...sourceDraw,
      bytes: nextBytes,
      layout: createWaterMeshLayoutReceipt(nextBytes, coverageBytes),
    },
  );
  const nextUpload = waterMeshAdmissionUpload(
    projectWaterMeshAdmissionTiles(
      { ...tiles, bytes: nextBytes, layout: nextDraw.layout },
      nextDraw,
    ),
  );
  expect(isOwnedWaterMeshAdmissionUpload(nextUpload)).toBe(true);
  expect(nextUpload).not.toBe(upload);
  expect(nextUpload.bytes).toBe(nextBytes);
});

const zoneGuid = '00000000-0000-7000-8000-000000000006';
const bodySource: WaterBodySourceAsset = {
  kind: 'water-body',
  type: 'lake',
  zoneGuid,
  spline: {
    closed: true,
    points: (
      [
        [-6, -6],
        [6, -6],
        [6, 6],
        [-6, 6],
      ] as const
    ).map(([x, z], inputKey) => ({
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
    })),
  },
  baseHeightM: 0,
  overlapPriority: 0,
  maxWaveHeightM: 0.25,
  surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'none', enabled: false },
  queryFootprint: [
    [-6, -6],
    [6, -6],
    [6, 6],
    [-6, 6],
  ],
};

const zoneAsset = (resolution: number): WaterZoneAsset => ({
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 2,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: resolution, heightPx: resolution },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
});

it.each([
  'pending',
  'failed',
  'unavailable',
  'invalid-kind',
  'valid',
] as const)('transports the exact %s WaterInfo dependency state without publishing a descriptor', async (status) => {
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000619');
  const packed = (await buildWaterPackOutputs({ lake: bodySource }, { packageId })).unwrap();
  const bodyAsset = packed.lake as WaterBodyAsset;
  const waterInfoMeshGuid = bodyAsset.waterInfoMeshGuid;
  assert(waterInfoMeshGuid);
  let dependencyStatus: WaterDependencySnapshot['status'] = status;
  const liveZone = { guid: zoneGuid, generation: 1, asset: zoneAsset(64) };
  const water = new WaterSystem(
    (guid) => (guid === zoneGuid ? liveZone : undefined),
    () => [
      {
        guid: waterInfoMeshGuid,
        kind: 'mesh',
        field: 'waterInfoMeshGuid',
        ...(dependencyStatus === 'failed'
          ? {
              status: 'failed' as const,
              failure: {
                code: 'asset-load-failed',
                expected: 'mesh loads',
                hint: 'repair mesh source',
              },
            }
          : { status: dependencyStatus }),
      },
    ],
    () => [liveZone],
  );
  const bodyGuid = 'river-transition-owner';
  const body = water.mountBody(bodyGuid, '1', bodyAsset).unwrap();
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  const viewIdentity = 'river-transition-view';
  const context = {
    world: world,
    frameNumber: 1,
    views: [
      {
        identity: viewIdentity,
        render: true,
        frame: {
          view: {
            identity: viewIdentity,
            deviceGeneration: 4,
            cameraPosition: [0, 4, 0],
          },
        },
      },
    ],
  };
  const source = createWaterInfoSourceFeature();
  const input = source.extract(context as never).unwrap();
  expect(input.version).toBe(6);
  const sourceBody = input.views[0]?.bodies[0];
  assert(sourceBody);
  const expectedKind =
    status === 'unavailable' || status === 'valid'
      ? 'missing'
      : status === 'invalid-kind'
        ? 'incompatible'
        : status;
  expect(sourceBody).toMatchObject({
    kind: 'independent',
    waterInfoAvailability: { kind: expectedKind, bodyGuid, bodyGeneration: body.sceneGeneration },
  });
  const transferred = structuredClone(input);
  const receiver = createWaterInfoFeature() as RenderFeature<unknown>;
  const planContext = {
    generation: 1,
    frame: { frameNumber: 10 },
    views: [{ identity: viewIdentity, render: true, sceneData: { deviceGeneration: 4 } }],
  };
  expect(receiver.plan(transferred, planContext as never).ok).toBe(true);
  const publication = waterInfoFramePublicationForRenderer(receiver, viewIdentity, 10, 4);
  assert(publication);
  expect(publication.rows.size).toBe(0);
  expect(publication.targets).toEqual([]);
  expect(publication.waterInfoAvailability.get(sourceBody.ownerKey)).toMatchObject({
    kind: expectedKind,
  });
  const direct = createWaterInfoFeature()
    .extract(context as never)
    .unwrap();
  expect(direct.views[0]?.publication.waterInfoAvailability.get(sourceBody.ownerKey)).toEqual(
    publication.waterInfoAvailability.get(sourceBody.ownerKey),
  );
  expect(receiver.plan({ ...input, version: 2 } as never, planContext as never).ok).toBe(false);
  const malformed = structuredClone(input);
  const unavailableBody = malformed.views[0]?.bodies[0];
  if (unavailableBody?.kind !== 'independent')
    throw new Error('Pending input must remain independent');
  assert(unavailableBody.waterInfoAvailability);
  Object.assign(unavailableBody.waterInfoAvailability, {
    bodyGeneration: body.sceneGeneration + 1,
  });
  expect(receiver.plan(malformed, planContext as never).ok).toBe(false);
  if (status === 'pending') {
    dependencyStatus = 'failed';
    water.refreshDependencies(bodyGuid, ['geometry', 'waterInfo']).unwrap();
    const failed = source.extract({ ...context, frameNumber: 2 } as never).unwrap();
    expect(failed.views[0]?.bodies[0]).toMatchObject({
      waterInfoAvailability: {
        kind: 'failed',
        failure: { code: 'asset-load-failed' },
      },
    });
    expect(
      receiver.plan(structuredClone(failed), {
        ...planContext,
        frame: { frameNumber: 11 },
      } as never).ok,
    ).toBe(true);
    const failedPublication = waterInfoFramePublicationForRenderer(receiver, viewIdentity, 11, 4);
    assert(failedPublication);
    expect([...failedPublication.waterInfoAvailability.values()]).toMatchObject([
      { kind: 'failed' },
    ]);
  }
});

function cameraRotationTowardLake(eye: readonly [number, number, number]) {
  return quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]);
}

it('transports WaterInfo into the renderer before drawing generation-bound WaterMesh owners', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  publishRuntimeAssets(assets, [
    {
      guid: bodySource.surfaceMaterialGuid,
      asset: Materials.standard({
        baseColor: [0.05, 0.35, 0.55, 1],
        metallic: 0.02,
        roughness: 0.16,
      }),
    },
  ]);
  (await assets.load(bodySource.surfaceMaterialGuid, 'material')).unwrap();
  const world = new World({ assets });
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 4, -12],
          quat: cameraRotationTowardLake([0, 4, -12]),
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterZoneInstance, data: { zone: 0 as never } },
    )
    .unwrap();
  const ownerMesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const ownerMaterial = assets
    .create(Materials.standard({ baseColor: [0.1, 0.5, 0.8, 1] }))
    .unwrap();
  const bodyEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterBodyInstance, data: { body: 0 as never } },
      { component: MeshFilter, data: { assetHandle: ownerMesh } },
      { component: MeshRenderer, data: { materials: [ownerMaterial] } },
    )
    .unwrap();
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000618');
  const packed = await buildWaterPackOutputs({ lake: bodySource }, { packageId });
  if (!packed.ok || packed.value.lake?.kind !== 'water-body')
    throw new Error('WaterMesh publication fixture body must cook successfully');
  const outputByGuid = new Map(
    Object.entries(packed.value).map(
      ([key, asset]) =>
        [AssetGuid.format(AssetGuid.derive(packageId, key)).toLowerCase(), asset] as const,
    ),
  );
  const bodyAsset = packed.value.lake as WaterBodyAsset;
  const liveZone = { guid: zoneGuid, generation: 1, asset: zoneAsset(64) };
  const water = new WaterSystem(
    (guid) => (guid === zoneGuid ? liveZone : undefined),
    (asset) =>
      ['waterInfoMeshGuid', 'dilatedWaterInfoMeshGuid', 'visibleMeshGuid'].flatMap((field) => {
        const guid = asset[field as keyof typeof asset] as string | undefined;
        if (guid === undefined) return [];
        const payload = outputByGuid.get(guid.toLowerCase());
        return payload === undefined
          ? []
          : [
              {
                guid,
                field,
                kind: 'mesh' as const,
                status: 'valid' as const,
                payload: payload as never,
              },
            ];
      }),
    () => [liveZone],
  );
  const bodyGuid = `scene-entity:${Number(bodyEntity)}`;
  const body = water.mountBody(bodyGuid, '1', bodyAsset).unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();

  const identity = { source: 'water-mesh-render-publication', epoch: 1 };
  const sourceFeature = createWaterInfoSourceFeature() as RenderFeature<unknown>;
  const receiverFeature = createWaterInfoFeature() as RenderFeature<unknown>;
  const publisher = createRenderPublisher(world, assets, identity, undefined, [sourceFeature]);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, publicationSource: identity, features: [receiverFeature] },
    { shaderManifestUrl: renderLifecycleManifestUrl({ waterWaves: true }) },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const dispatch = vi.spyOn(RhiNullComputePassEncoder.prototype, 'dispatchWorkgroups');
  const indexedDraw = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  type IndexedDraw = Parameters<RhiNullRenderPassEncoder['drawIndexed']>;
  type BoundGroup = Parameters<RhiNullRenderPassEncoder['setBindGroup']>;
  const bundleDraws = new Map<RenderBundle, readonly IndexedDraw[]>();
  const bundleBindings = new Map<RenderBundle, readonly BoundGroup[]>();
  const executedBundleDraws: Array<{ pass: RhiNullRenderPassEncoder; args: IndexedDraw }> = [];
  const executedBundleBindings: Array<{ pass: RhiNullRenderPassEncoder; args: BoundGroup }> = [];
  const createBundle = RhiNullDevice.prototype.createRenderBundleEncoder;
  const createBundleSpy = vi
    .spyOn(RhiNullDevice.prototype, 'createRenderBundleEncoder')
    .mockImplementation(function (this: RhiNullDevice, descriptor) {
      const created = createBundle.call(this, descriptor);
      if (!created.ok) return created;
      const encoder = created.value;
      const draws: IndexedDraw[] = [];
      const bindings: BoundGroup[] = [];
      const draw = encoder.drawIndexed.bind(encoder);
      encoder.drawIndexed = (...args) => {
        draws.push(args);
        draw(...args);
      };
      const bind = encoder.setBindGroup.bind(encoder);
      encoder.setBindGroup = (...args) => {
        bindings.push(args);
        return bind(...args);
      };
      const finish = encoder.finish.bind(encoder);
      encoder.finish = () => {
        const finished = finish();
        if (finished.ok) {
          bundleDraws.set(finished.value, draws);
          bundleBindings.set(finished.value, bindings);
        }
        return finished;
      };
      return created;
    });
  const executeBundles = RhiNullRenderPassEncoder.prototype.executeBundles;
  const executeBundlesSpy = vi
    .spyOn(RhiNullRenderPassEncoder.prototype, 'executeBundles')
    .mockImplementation(function (this: RhiNullRenderPassEncoder, bundles) {
      const handles = [...bundles];
      const executed = executeBundles.call(this, handles);
      if (executed.ok)
        for (const handle of handles) {
          for (const args of bundleDraws.get(handle) ?? [])
            executedBundleDraws.push({ pass: this, args });
          for (const args of bundleBindings.get(handle) ?? [])
            executedBundleBindings.push({ pass: this, args });
        }
      return executed;
    });
  const setBindGroup = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setBindGroup');
  const createBindGroup = vi.spyOn(RhiNullDevice.prototype, 'createBindGroup');
  const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
  const viewIdentity = `camera:${Number(camera)}`;
  let receipt: FrameReceipt | undefined;
  let submittedFrameCount = 0;
  const rendererErrors: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });

  const publishAndDraw = async () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const transported = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(transported).unwrap();
    const viewFrame = scene.consumePublication(accepted);
    const drawStart = indexedDraw.mock.contexts.length;
    const bundleStart = executedBundleDraws.length;
    const bundleBindStart = executedBundleBindings.length;
    const bindStart = setBindGroup.mock.contexts.length;
    let feedback: WaterInfoSourceFeedback | undefined;
    const acknowledgments: Array<Parameters<typeof publisher.acknowledgeFeatures>[1][number]> = [];
    const drawn = await renderer.draw({
      publication: transported,
      onFeatureSourceSubmitted: (featureIdentity, sourceFeedback, submission) => {
        expect(
          accepted.packet.features.some((feature) => feature.identity === featureIdentity),
        ).toBe(true);
        if (featureIdentity === sourceFeature.identity) {
          expect(featureIdentity).toBe(sourceFeature.identity);
          feedback = sourceFeedback as WaterInfoSourceFeedback;
        }
        acknowledgments.push({
          identity: featureIdentity,
          feedback: sourceFeedback,
          ...(submission === undefined ? {} : { submission }),
        });
      },
    });
    if (!drawn.ok) throw new Error(`${drawn.error.message}: ${JSON.stringify(drawn.error)}`);
    if (drawn.value === undefined)
      throw new Error('WaterMesh fixture publication must submit a frame');
    publisher.acknowledgeFeatures(transported.revision, acknowledgments).unwrap();
    receipt = drawn.value;
    submittedFrameCount++;
    expect((await receipt.completed).ok).toBe(true);
    publisher
      .completeFeatures(transported.revision, {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
      })
      .unwrap();
    const returned = structuredClone(renderPublicationTransfers(transported), {
      transfer: renderPublicationTransfers(transported),
    });
    publisher.recycle(transported.revision, returned).unwrap();
    return {
      accepted,
      viewFrame,
      feedback,
      receipt,
      drawCalls: [
        ...indexedDraw.mock.calls.slice(drawStart),
        ...executedBundleDraws.slice(bundleStart).map((draw) => draw.args),
      ],
      drawContexts: [
        ...(indexedDraw.mock.contexts.slice(drawStart) as RhiNullRenderPassEncoder[]),
        ...executedBundleDraws.slice(bundleStart).map((draw) => draw.pass),
      ],
      bindCalls: [
        ...setBindGroup.mock.calls.slice(bindStart),
        ...executedBundleBindings.slice(bundleBindStart).map((binding) => binding.args),
      ],
      bindContexts: [
        ...(setBindGroup.mock.contexts.slice(bindStart) as RhiNullRenderPassEncoder[]),
        ...executedBundleBindings.slice(bundleBindStart).map((binding) => binding.pass),
      ],
    };
  };

  const publishReadyFrame = async () => {
    const maxFrames = 3;
    let pendingReason: FrameReceipt['presentationPendingReason'];
    const observed: unknown[] = [];
    for (let attempt = 0; attempt < maxFrames; attempt++) {
      const submitted = await publishAndDraw();
      if (submitted.receipt.presentation === 'ready') return submitted;
      pendingReason = submitted.receipt.presentationPendingReason;
      observed.push({
        frame: submitted.receipt.frameId,
        pendingReason,
        source: submitted.accepted.frame.renderables.map((row) => ({
          entity: row.entityKey,
          generation: row.waterMeshSource?.generation,
          views: row.waterMeshSource?.views.map((view) => ({
            identity: view.viewIdentity,
            draws: view.draws.length,
          })),
        })),
        draws: submitted.viewFrame.renderables.map((row) => ({
          entity: row.entityKey,
          owner: row.waterOwner,
        })),
        mainDraws: submitted.drawCalls.filter(
          (_call, at) => submitted.drawContexts[at]?.passName === 'main',
        ),
      });
    }
    throw new Error(
      `WaterMesh renderer view did not become ready within ${maxFrames} frames: ${JSON.stringify({ observed, passes: renderer.inspect().perFramePassNames })}`,
    );
  };

  const expectMainWaterDraw = (
    submitted: Awaited<ReturnType<typeof publishAndDraw>>,
    ownerGeneration: number,
    zoneGeneration: number,
  ) => {
    const mainDraws = submitted.drawContexts.filter((pass) => pass.passName === 'main');
    expect(mainDraws.length).toBeGreaterThan(0);
    const mainWaterGroupBound = submitted.bindCalls.some(
      (args, index) => submitted.bindContexts[index]?.passName === 'main' && args[0] === 2,
    );
    expect(
      mainWaterGroupBound,
      JSON.stringify({
        errors: rendererErrors.map((error) => (error instanceof Error ? error.stack : error)),
        presentation: submitted.receipt.presentation,
        binds: submitted.bindCalls.map((args, index) => [
          submitted.bindContexts[index]?.passName,
          args[0],
        ]),
      }),
    ).toBe(true);

    const frameDescriptor = createBindGroup.mock.calls
      .map(([descriptor]) => descriptor)
      .find(
        (descriptor) =>
          descriptor.label === `water-material-frame:${viewIdentity}:${submitted.receipt.frameId}`,
      );
    expect(frameDescriptor).toBeDefined();
    expect(
      Array.from(frameDescriptor?.entries ?? []).find((entry) => entry.binding === 2)?.resource
        .kind,
    ).toBe('textureView');
    const publication = waterInfoFramePublicationForRenderer(
      receiverFeature,
      viewIdentity,
      submitted.receipt.frameId,
      submitted.receipt.deviceGeneration,
    );
    if (publication === undefined)
      throw new Error('WaterInfo publication must cover the submitted draw');
    const row = [...publication.rows.values()].find(
      (row) => row.bodyGeneration === ownerGeneration,
    );
    expect(row).toMatchObject({ bodyGuid, zoneGeneration, targetFormat: 'rgba16float' });
    expect(row?.descriptor).toHaveLength(48);
    expect(publication?.targets.some((target) => target.targetName === row?.targetName)).toBe(true);
    expect(
      publication?.waveBodies.some(
        (body) => body.bodyGeneration === ownerGeneration && body.zoneGeneration === zoneGeneration,
      ),
    ).toBe(true);
    expect(water.snapshot(bodyGuid)?.sceneGeneration).toBe(ownerGeneration);
    expect(water.zoneSnapshots()[0]?.generation).toBe(zoneGeneration);
  };

  try {
    for (let index = 0; index < 2; index++) {
      const pending = await publishAndDraw();
      const publication = waterInfoFramePublicationForRenderer(
        receiverFeature,
        viewIdentity,
        pending.receipt.frameId,
        pending.receipt.deviceGeneration,
      );
      if (publication === undefined) throw new Error('Pending Body inputs must remain published');
      expect(publication?.rows.size).toBe(0);
      expect(publication?.targets).toEqual([]);
      expect(publication?.waveBodies).toMatchObject([
        { bodyGuid, bodyGeneration: body.sceneGeneration, heightSource: { kind: 'fixed' } },
      ]);
      expect(water.snapshot(bodyGuid)?.outputReceipts.waterInfo).toBeUndefined();
      expect(water.snapshot(bodyGuid)?.outputReceipts.waterMesh).toBeUndefined();
      const meshIndexCounts = new Set(
        water
          .waterMeshCandidateViews(viewIdentity)
          .flatMap((candidate) => candidate.receipt.buckets.map((bucket) => bucket.indexCount)),
      );
      expect(
        pending.drawCalls.some(
          (call, at) =>
            pending.drawContexts[at]?.passName === 'main' && meshIndexCounts.has(call[0]),
        ),
      ).toBe(false);
      expect(rendererErrors.map((error) => (error instanceof Error ? error.stack : error))).toEqual(
        [],
      );
    }
    water
      .acceptOutput(bodyGuid, 'geometry', body.outputGenerations.geometry, {
        generation: 1,
        digest: 'water-mesh-render-geometry-v1',
      })
      .unwrap();
    const first = await publishAndDraw();
    const firstInput = first.accepted.packet.features.find(
      (feature) => feature.identity === sourceFeature.identity,
    )?.data as WaterInfoPublicationInput | undefined;
    expect(firstInput).toMatchObject({ kind: 'forgeax-water-info-input', version: 6 });
    expect(firstInput?.views).toHaveLength(1);
    expect(firstInput?.views[0]?.captures).toHaveLength(1);
    const firstOwner = first.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(firstOwner?.waterMeshSource?.views.map((view) => view.viewIdentity)).toContain(
      viewIdentity,
    );
    expect(firstOwner?.assetHandle).toBe(ownerMesh);
    expect(
      firstOwner?.materials.some((material) => material.snapshot.materialHandle === ownerMaterial),
    ).toBe(true);
    expect(first.feedback?.views[0]?.bodies).toHaveLength(1);
    expect(first.feedback?.views[0]?.targets.some((target) => target.write)).toBe(true);
    const firstWaterInfo = waterInfoFramePublicationForRenderer(
      receiverFeature,
      viewIdentity,
      first.receipt.frameId,
      first.receipt.deviceGeneration,
    );
    expect(firstWaterInfo?.rows.size).toBe(1);
    expect(firstWaterInfo?.targets.some((target) => target.write)).toBe(true);
    expect(
      ['water-info-merge-0', 'water-info-flow-blur-0', 'water-info-finalize-0'].every((name) =>
        dispatch.mock.contexts.some(
          (pass) =>
            (pass as RhiNullComputePassEncoder).passName ===
            viewSharedFeatureGraphPassName(viewIdentity, name),
        ),
      ),
      `Recorded compute passes: ${JSON.stringify(
        dispatch.mock.contexts.map((pass) => (pass as RhiNullComputePassEncoder).passName),
      )}`,
    ).toBe(true);

    const second = await publishReadyFrame();
    const sourceOwner = second.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    if (sourceOwner?.waterMeshSource === undefined)
      throw new Error('Second WaterMesh publication must include its view-specific owner source');
    expect(sourceOwner.waterMeshSource.views.map((view) => view.viewIdentity)).toContain(
      viewIdentity,
    );
    const waterMaterial = sourceOwner.materials[sourceOwner.waterMeshSource.materialStartIndex];
    if (waterMaterial === undefined)
      throw new Error('WaterMesh source must resolve its surface material');
    const ordinaryMaterialFrame = new MaterialFrame(undefined).with(sourceOwner.material);
    const unmatchedView = projectWaterMeshView(
      second.accepted.frame,
      ordinaryMaterialFrame,
      'camera:unmatched',
    );
    const ordinaryOwner = unmatchedView.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(ordinaryOwner?.materials).toEqual(
      sourceOwner.materials.slice(0, sourceOwner.waterMeshSource.materialStartIndex),
    );
    expect(unmatchedView.materials.get(waterMaterial)).toBeUndefined();
    const ordinarySelection = new SubsurfaceSelection();
    if (ordinaryOwner === undefined)
      throw new Error('Unmatched WaterMesh view must retain its ordinary owner row');
    ordinarySelection.add(ordinaryOwner, unmatchedView.materials);
    ordinarySelection.adopt(unmatchedView.materials);
    expect(ordinarySelection.demand).not.toBe('missing-material');

    const secondOwner = second.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(secondOwner?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
    expect(secondOwner?.assetHandle).toBe(ownerMesh);
    expect(
      secondOwner?.materials.some((material) => material.snapshot.materialHandle === ownerMaterial),
    ).toBe(true);
    const secondWaterDraws = second.viewFrame.renderables.filter(
      (row) => row.waterOwner !== undefined,
    );
    expect(secondWaterDraws.length).toBeGreaterThan(0);
    expect(
      secondWaterDraws.every(
        (row) =>
          Object.getOwnPropertyDescriptor(row, 'waterOwner')?.writable === false &&
          Object.getOwnPropertyDescriptor(row, 'waterOwner')?.configurable === false &&
          Object.getOwnPropertyDescriptor(row, 'waterMeshTiles')?.writable === false &&
          Object.getOwnPropertyDescriptor(row, 'waterMeshTiles')?.configurable === false,
      ),
    ).toBe(true);
    const finalizedWaterClosure = finalizeWaterMaterialAdmissionDraws(
      secondWaterDraws.map((source, renderableIndex) => ({ renderableIndex, source })),
    );
    expect(finalizedWaterClosure?.draws).toHaveLength(secondWaterDraws.length);
    const admittedTiles = secondWaterDraws.find(
      (row) => row.waterMeshTiles !== undefined,
    )?.waterMeshTiles;
    if (admittedTiles === undefined) throw new Error('CPU WaterMesh must publish tile records');
    const admittedUpload = waterMeshAdmissionUpload(admittedTiles);
    expect(isOwnedWaterMeshAdmissionUpload(admittedUpload)).toBe(true);
    expect(waterMeshAdmissionUpload(admittedTiles)).toBe(admittedUpload);
    const copiedTiles = { ...admittedTiles };
    const copiedUpload = waterMeshAdmissionUpload(copiedTiles);
    expect(isOwnedWaterMeshAdmissionUpload(copiedUpload)).toBe(false);
    expect(waterMeshAdmissionUpload(copiedTiles)).not.toBe(copiedUpload);
    const admittedSourceDraw = sourceOwner.waterMeshSource.views
      .flatMap((view) => view.draws)
      .find((draw) => draw.drawKey === admittedTiles.drawKey);
    if (admittedSourceDraw === undefined)
      throw new Error('Tile records must retain their admitted draw');
    const offsetDraw = offsetWaterMeshAdmissionDraw(admittedSourceDraw, 2);
    const offsetTiles = projectWaterMeshAdmissionTiles({ ...admittedTiles }, offsetDraw);
    expect(waterMeshAdmissionUpload(offsetTiles)).toBe(admittedUpload);
    for (const replaced of [
      { ...admittedTiles, bodyGeneration: admittedTiles.bodyGeneration + 1 },
      { ...admittedTiles, zoneGeneration: admittedTiles.zoneGeneration + 1 },
      { ...admittedTiles, worldIdentity: 'different-world' },
      { ...admittedTiles, viewIdentity: 'different-view' },
      { ...admittedTiles, bytes: admittedTiles.bytes.slice() },
      { ...admittedTiles, coverageBytes: admittedTiles.coverageBytes.slice() },
      { ...admittedTiles, layout: { ...admittedTiles.layout } },
      { ...admittedTiles, transitionTargets: [...admittedTiles.transitionTargets] },
    ]) {
      const projected = projectWaterMeshAdmissionTiles(replaced, admittedSourceDraw);
      expect(isOwnedWaterMeshAdmissionUpload(waterMeshAdmissionUpload(projected))).toBe(false);
    }
    expect(
      secondWaterDraws.every(
        (row) =>
          row.entityKey === Number(bodyEntity) &&
          row.waterOwner?.generation === body.sceneGeneration &&
          row.waterOwner.zoneGeneration === liveZone.generation,
      ),
    ).toBe(true);
    expect(
      second.viewFrame.renderables.some(
        (row) => row.entityKey === Number(bodyEntity) && row.assetHandle === ownerMesh,
      ),
    ).toBe(true);
    expect(water.snapshot(bodyGuid)?.outputs.waterMesh).toBe('ready');
    expectMainWaterDraw(second, body.sceneGeneration, liveZone.generation);

    const firstTargetName = firstWaterInfo?.targets.find((target) => target.write)?.targetName;
    const replacementZone = zoneAsset(128);
    const previousZoneGeneration = liveZone.generation;
    liveZone.generation = 2;
    liveZone.asset = replacementZone;
    const replacementBody = water.mountBody(bodyGuid, '2', bodyAsset).unwrap();
    for (let index = 0; index < 2; index++) {
      const pending = index === 0 ? await publishAndDraw() : await publishReadyFrame();
      const publication = waterInfoFramePublicationForRenderer(
        receiverFeature,
        viewIdentity,
        pending.receipt.frameId,
        pending.receipt.deviceGeneration,
      );
      if (publication === undefined) throw new Error('Retained proxy inputs must remain published');
      expect([...publication.rows.values()].map((row) => row.bodyGeneration)).toEqual([
        body.sceneGeneration,
      ]);
      expect(publication?.waveBodies.map((row) => row.bodyGeneration).sort()).toEqual(
        [body.sceneGeneration, replacementBody.sceneGeneration].sort(),
      );
      expect(
        publication?.waveBodies.find((row) => row.bodyGeneration === body.sceneGeneration)
          ?.heightSource.kind,
      ).toBe('water-info');
      expect(
        publication?.waveBodies.find(
          (row) => row.bodyGeneration === replacementBody.sceneGeneration,
        )?.heightSource.kind,
      ).toBe('fixed');
      expect(
        publication?.targets.find((target) => target.targetName === firstTargetName)?.write,
      ).toBe(false);
      const pendingOwner = pending.accepted.frame.renderables.find(
        (row) => row.entityKey === Number(bodyEntity),
      );
      if (pendingOwner !== undefined)
        expect(pendingOwner.waterMeshSource?.generation).toBe(body.sceneGeneration);
      const retainedDraws = pending.viewFrame.renderables.filter(
        (row) => row.waterMeshTiles !== undefined,
      );
      expect(retainedDraws.length).toBeGreaterThan(0);
      expect(
        retainedDraws.every(
          (row) =>
            row.waterOwner?.generation === body.sceneGeneration &&
            row.waterOwner.zoneGeneration === previousZoneGeneration,
        ),
      ).toBe(true);
      if (index > 0) {
        const retained = water.zoneMeshView(zoneGuid, viewIdentity);
        if (retained === undefined)
          throw new Error('Old WaterMesh proxy must survive the replacement wait');
        const meshIndexCounts = new Set(
          retained.receipt.buckets.map((bucket) => bucket.indexCount),
        );
        expect(
          pending.drawCalls.some(
            (call, at) =>
              pending.drawContexts[at]?.passName === 'main' && meshIndexCounts.has(call[0]),
          ),
        ).toBe(true);
      }
      expect(water.snapshot(bodyGuid)?.outputReceipts.waterInfo).toBeUndefined();
      expect(water.snapshot(bodyGuid)?.outputReceipts.waterMesh).toBeUndefined();
      expect(rendererErrors.map((error) => (error instanceof Error ? error.stack : error))).toEqual(
        [],
      );
    }
    water
      .acceptOutput(bodyGuid, 'geometry', replacementBody.outputGenerations.geometry, {
        generation: 3,
        digest: 'water-mesh-render-geometry-v2',
      })
      .unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();

    const rolledInfo = await publishAndDraw();
    const replacementWaterInfo = waterInfoFramePublicationForRenderer(
      receiverFeature,
      viewIdentity,
      rolledInfo.receipt.frameId,
      rolledInfo.receipt.deviceGeneration,
    );
    assert(replacementWaterInfo);
    expect([...replacementWaterInfo.rows.values()].map((row) => row.bodyGeneration).sort()).toEqual(
      [body.sceneGeneration, replacementBody.sceneGeneration],
    );
    const oldRow = [...replacementWaterInfo.rows.values()].find(
      (row) => row.bodyGeneration === body.sceneGeneration,
    );
    expect(oldRow?.targetName).toBe(firstTargetName);
    expect(
      replacementWaterInfo?.targets.find((target) => target.targetName === firstTargetName)?.write,
    ).toBe(false);
    expect(
      [...replacementWaterInfo.rows.values()].find(
        (row) => row.bodyGeneration === replacementBody.sceneGeneration,
      )?.zoneGeneration,
    ).toBe(liveZone.generation);
    expect(replacementWaterInfo?.targets.find((target) => target.write)?.targetName).not.toBe(
      firstTargetName,
    );
    expect(replacementWaterInfo?.targets.find((target) => target.write)?.width).toBe(128);

    const rolledMesh = await publishReadyFrame();
    const rolledOwner = rolledMesh.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(rolledOwner?.waterMeshSource?.generation).toBe(replacementBody.sceneGeneration);
    expect(rolledOwner?.waterMeshSource?.zoneGeneration).toBe(liveZone.generation);
    expect(rolledOwner?.assetHandle).toBe(ownerMesh);
    const rolledWaterDraws = rolledMesh.viewFrame.renderables.filter(
      (row) => row.waterOwner !== undefined,
    );
    expect(rolledWaterDraws.length).toBeGreaterThan(0);
    expect(
      rolledWaterDraws.every(
        (row) =>
          row.waterOwner?.generation === replacementBody.sceneGeneration &&
          row.waterOwner.zoneGeneration === liveZone.generation,
      ),
    ).toBe(true);
    const settledWaterInfo = waterInfoFramePublicationForRenderer(
      receiverFeature,
      viewIdentity,
      rolledMesh.receipt.frameId,
      rolledMesh.receipt.deviceGeneration,
    );
    assert(settledWaterInfo);
    expect([...settledWaterInfo.rows.values()].map((row) => row.bodyGeneration)).toEqual([
      replacementBody.sceneGeneration,
    ]);
    expect(water.snapshot(bodyGuid)?.outputs.waterMesh).toBe('ready');
    expectMainWaterDraw(rolledMesh, replacementBody.sceneGeneration, liveZone.generation);
    expect(submit).toHaveBeenCalledTimes(submittedFrameCount);
  } finally {
    dispatch.mockRestore();
    indexedDraw.mockRestore();
    createBundleSpy.mockRestore();
    executeBundlesSpy.mockRestore();
    setBindGroup.mockRestore();
    createBindGroup.mockRestore();
    submit.mockRestore();
    if (receipt !== undefined) await receipt.completed;
    scene.dispose();
    receiver.dispose();
    await renderer.dispose();
    publisher.dispose();
  }
});
