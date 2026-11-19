import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { RhiNullComputePassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  type WaterBodyAsset,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, CameraView } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import type { RenderFeature, RenderFeatureSubmission } from '../features/types';
import { createRenderPublisher } from '../publication/publisher';
import {
  encodeRenderPublication,
  type RenderPublicationMessage,
  renderPublicationTransfers,
} from '../publication/record';
import type { FrameReceipt } from '../render-contract';
import {
  createWaterInfoFeature,
  type WaterInfoPublicationInput,
  type WaterInfoSourceFeedback,
  waterInfoFramePublicationForRenderer,
} from '../water/water-info-feature';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const zoneGuid = '00000000-0000-7000-8000-000000000006';
const zone: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 1,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 32, heightPx: 32 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};

const bodySource = {
  kind: 'water-body',
  type: 'lake',
  zoneGuid,
  spline: {
    closed: true,
    points: (
      [
        [-4, -4],
        [4, -4],
        [4, 4],
        [-4, 4],
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
  flags: { affectsWaterInfo: true, affectsWaterMesh: false, affectsLandscape: false },
  collision: { type: 'none', enabled: false },
  queryFootprint: [
    [-4, -4],
    [4, -4],
    [4, 4],
    [-4, 4],
  ],
} as const;

function cameraRotationTowardLake(eye: readonly [number, number, number]) {
  return quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]);
}

it('materializes source WaterInfo and rebuilds its contents when the same camera moves between recorder owners', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000618');
  const packed = await buildWaterPackOutputs({ lake: bodySource }, { packageId });
  if (!packed.ok || packed.value.lake?.kind !== 'water-body')
    throw new Error('WaterInfo fixture body must cook successfully');
  const outputByGuid = new Map(
    Object.entries(packed.value).map(
      ([key, asset]) =>
        [AssetGuid.format(AssetGuid.derive(packageId, key)).toLowerCase(), asset] as const,
    ),
  );
  const bodyAsset = packed.value.lake as WaterBodyAsset;
  const liveZone = { guid: zoneGuid, generation: 1, asset: zone };
  const liveZones = [liveZone];
  const water = new WaterSystem(
    (guid) => liveZones.find((candidate) => candidate.guid === guid),
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
    () => liveZones,
  );
  const bodyGuid = 'scene-entity:water-info-source';
  const body = water.mountBody(bodyGuid, '1', bodyAsset).unwrap();
  water
    .acceptOutput(bodyGuid, 'geometry', body.outputGenerations.geometry, {
      generation: 1,
      digest: 'water-info-source-geometry',
    })
    .unwrap();
  water.observeZoneGroundInputs(zoneGuid, 1, []);
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();

  const identity = { source: 'water-info-source-publication', epoch: 1 };
  const receiverFeature = createWaterInfoFeature() as RenderFeature<unknown>;
  const sourceFeature = requiredFixtureValue(receiverFeature.source);
  let graphOwners: readonly object[] = [];
  const receiverPlan = receiverFeature.plan.bind(receiverFeature);
  receiverFeature.plan = (data, context) => {
    graphOwners = context.views
      .filter((view) => view.render)
      .map((view) => {
        if (view.graphResources === undefined) throw new Error('Missing recorder allocation owner');
        expect(Object.isFrozen(view.graphResources.owner)).toBe(true);
        return view.graphResources.owner;
      });
    return receiverPlan(data, context);
  };
  const publisher = createRenderPublisher(world, assets, identity);
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, publicationSource: identity, features: [receiverFeature] },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const dispatch = vi.spyOn(RhiNullComputePassEncoder.prototype, 'dispatchWorkgroups');
  let submittedFeedback: WaterInfoSourceFeedback | undefined;
  const receipts: FrameReceipt[] = [];
  const sourceMessages: RenderPublicationMessage[] = [];

  try {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const sourceInput = packet.features.find(
      (feature) => feature.identity === sourceFeature.identity,
    )?.data;
    expect(sourceInput).toMatchObject({ kind: 'forgeax-water-info-input', version: 6 });
    const input = sourceInput as WaterInfoPublicationInput;
    expect(input.views).toHaveLength(1);
    expect(input.views[0]?.captures).toHaveLength(1);
    expect(input.views[0]?.captures[0]?.context).not.toHaveProperty('slice');
    expect(input.views[0]?.captures[0]?.context).not.toHaveProperty('deviceGeneration');

    const message = encodeRenderPublication(packet);
    sourceMessages.push(message);
    const drawn = await renderer.draw({
      publication: message,
      onFeatureSourceSubmitted: (featureIdentity, feedback, submission) => {
        expect(featureIdentity).toBe(sourceFeature.identity);
        const finalize = submission?.works
          .flatMap((work) => work.passes)
          .find((pass) => pass.name.startsWith('water-info-finalize-'));
        expect(finalize?.resolvedGpuComputeDispatchCount).toBe(1);
        submittedFeedback = feedback as WaterInfoSourceFeedback;
        publisher
          .acknowledgeFeatures(packet.revision, [
            { identity: featureIdentity, feedback, submission },
          ])
          .unwrap();
      },
    });
    if (!drawn.ok) throw drawn.error;
    const receipt = drawn.value;
    receipts.push(receipt);
    expect(receipt.presentation).toBe('ready');
    expect((await receipt.completed).ok).toBe(true);
    expect(dispatch).toHaveBeenCalled();
    expect(water.snapshot(bodyGuid)?.outputReceipts.waterInfo).toMatchObject({
      outputGeneration: body.outputGenerations.waterInfo,
      consumerGeneration: receipt.frameId,
    });
    expect(submittedFeedback?.views).toMatchObject([
      {
        viewIdentity: requiredFixtureValue(input.views[0]).viewIdentity,
        receiverFrameGeneration: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        targets: [{ targetFormat: 'rgba16float', write: true }],
        bodies: [
          {
            bodyGeneration: body.sceneGeneration,
            outputGeneration: body.outputGenerations.waterInfo,
          },
        ],
      },
    ]);
    const publication = waterInfoFramePublicationForRenderer(
      receiverFeature,
      requiredFixtureValue(input.views[0]).viewIdentity,
      receipt.frameId,
      receipt.deviceGeneration,
    );
    expect(publication?.rows.size).toBe(1);
    expect([...(publication?.rows.values() ?? [])][0]?.slice).toBe(0);
    expect(publication?.targets.some((target) => target.write)).toBe(true);

    expect(water.zoneGroundSnapshot(zoneGuid)?.dirty).toBe(false);
    const invalidatedGround = water.invalidateZoneGround(zoneGuid, 1).unwrap();
    expect(invalidatedGround.dirty).toBe(true);
    const retryCandidate = publisher.prepare(1 / 60).unwrap();
    const retryPacket = structuredClone(retryCandidate.packet, {
      transfer: renderPublicationTransfers(retryCandidate.message),
    });
    retryCandidate.accept();
    const retryInput = retryPacket.features.find(
      (feature) => feature.identity === sourceFeature.identity,
    )?.data as WaterInfoPublicationInput | undefined;
    expect(retryInput?.views[0]?.captures[0]?.groundGeneration).toBe(invalidatedGround.generation);

    const retryMessage = encodeRenderPublication(retryPacket);
    sourceMessages.push(retryMessage);
    const retryDrawn = await renderer.draw({
      publication: retryMessage,
      onFeatureSourceSubmitted: (featureIdentity, feedback, submission) => {
        expect(featureIdentity).toBe(sourceFeature.identity);
        if (submission === undefined)
          throw new Error('WaterInfo writer submission receipt is required');
        const incomplete: RenderFeatureSubmission = {
          works: submission.works.map((work) => ({
            ...work,
            passes: work.passes.filter((pass) => !pass.name.startsWith('water-info-finalize-')),
          })),
        };
        publisher
          .acknowledgeFeatures(retryPacket.revision, [
            {
              identity: featureIdentity,
              feedback,
              submission: incomplete,
            },
          ])
          .unwrap();
      },
    });
    if (!retryDrawn.ok) throw retryDrawn.error;
    receipts.push(retryDrawn.value);
    expect((await retryDrawn.value.completed).ok).toBe(true);
    expect(water.zoneGroundSnapshot(zoneGuid)?.dirty).toBe(true);
    expect(water.snapshot(bodyGuid)?.outputReceipts.waterInfo?.consumerGeneration).toBe(
      receipt.frameId,
    );
    const receiverPublication = waterInfoFramePublicationForRenderer(
      receiverFeature,
      requiredFixtureValue(requiredFixtureValue(retryInput).views[0]).viewIdentity,
      retryDrawn.value.frameId,
      retryDrawn.value.deviceGeneration,
    );
    expect(receiverPublication?.frameGeneration).toBe(retryDrawn.value.frameId);
    expect(receiverPublication?.targets.some((target) => target.write)).toBe(true);

    const drawNext = async (write: boolean) => {
      for (const sourceMessage of sourceMessages.splice(0)) {
        const buffers = renderPublicationTransfers(sourceMessage);
        const returned = structuredClone(buffers, { transfer: buffers });
        publisher.recycle(sourceMessage.revision, returned).unwrap();
      }
      const next = publisher.prepare(1 / 60).unwrap();
      const nextPacket = structuredClone(next.packet, {
        transfer: renderPublicationTransfers(next.message),
      });
      next.accept();
      const nextInput = nextPacket.features.find(
        (feature) => feature.identity === sourceFeature.identity,
      )?.data as WaterInfoPublicationInput;
      const nextMessage = encodeRenderPublication(nextPacket);
      sourceMessages.push(nextMessage);
      const result = await renderer.draw({
        publication: nextMessage,
        onFeatureSourceSubmitted: (featureIdentity, feedback, submission) => {
          publisher
            .acknowledgeFeatures(nextPacket.revision, [
              { identity: featureIdentity, feedback, submission },
            ])
            .unwrap();
        },
      });
      expect(result.ok, JSON.stringify(result.ok ? undefined : result.error)).toBe(true);
      if (!result.ok) throw result.error;
      receipts.push(result.value);
      expect(result.value.presentation).toBe('ready');
      expect((await result.value.completed).ok).toBe(true);
      const publications = [];
      for (const view of nextInput.views) {
        const accepted = waterInfoFramePublicationForRenderer(
          receiverFeature,
          view.viewIdentity,
          result.value.frameId,
          result.value.deviceGeneration,
        );
        expect(accepted?.targets.map((target) => target.write)).toEqual([write]);
        if (accepted === undefined) throw new Error('Missing submitted WaterInfo publication');
        publications.push(accepted);
      }
      return publications;
    };

    await drawNext(false);
    const primaryOwner = graphOwners[0];
    expect(primaryOwner).toBeDefined();
    world
      .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } })
      .unwrap();
    const secondCamera = world
      .spawn(
        { component: Transform, data: { pos: [0, 4, -12] } },
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
        { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    await drawNext(true);
    expect(graphOwners).toHaveLength(2);
    expect(graphOwners[0]).not.toBe(primaryOwner);
    expect(graphOwners[1]).not.toBe(primaryOwner);
    expect(graphOwners[0]).not.toBe(graphOwners[1]);
    await drawNext(false);
    world.removeComponent(camera, CameraView).unwrap();
    world.despawn(secondCamera).unwrap();
    await drawNext(true);
    expect(graphOwners).toEqual([primaryOwner]);
    const beforeExpansion = await drawNext(false);
    const beforeTarget = beforeExpansion[0]?.targets[0];
    if (beforeTarget === undefined) throw new Error('Missing initial array target');

    const extraZoneGuid = '00000000-0000-7000-8000-000000000007';
    liveZones.push({ ...liveZone, guid: extraZoneGuid });
    const extraBodyGuid = 'scene-entity:water-info-expansion';
    const extraBody = water
      .mountBody(extraBodyGuid, '1', { ...bodyAsset, zoneGuid: extraZoneGuid })
      .unwrap();
    water
      .acceptOutput(extraBodyGuid, 'geometry', extraBody.outputGenerations.geometry, {
        generation: 1,
        digest: 'water-info-expansion-geometry',
      })
      .unwrap();
    water.observeZoneGroundInputs(extraZoneGuid, 1, []);
    const expanded = await drawNext(true);
    expect(expanded[0]?.targets[0]?.layers).toBeGreaterThan(beforeTarget.layers);
    expect(expanded[0]?.targets[0]?.epoch).toBeGreaterThan(beforeTarget.epoch);
    await drawNext(false);
    water.unmountBody(extraBodyGuid);
    liveZones.pop();
    const shrunk = await drawNext(true);
    expect(shrunk[0]?.targets[0]?.layers).toBe(beforeTarget.layers);
    await drawNext(false);

    for (const sourceMessage of sourceMessages) {
      const buffers = renderPublicationTransfers(sourceMessage);
      const returned = structuredClone(buffers, { transfer: buffers });
      publisher.recycle(sourceMessage.revision, returned).unwrap();
    }
  } finally {
    dispatch.mockRestore();
    for (const receipt of receipts) await receipt.completed;
    await renderer.dispose();
    publisher.dispose();
  }
});
