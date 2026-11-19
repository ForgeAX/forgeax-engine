import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { err, ok, type WaterBodyAsset, type WaterZoneAsset } from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  WaterSystem,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { RendererContractFailureError } from '../../errors/render';
import type { RenderFeatureSubmission } from '../../features/types';
import {
  createWaterInfoCaptureDeferralProbe,
  type WaterInfoFramePublication,
  waterInfoMaterialBindingSnapshots,
} from '../water-info-feature';
import {
  buildWaterMaterialFrameUpload,
  type WaterMaterialFrameBindings,
  waterMaterialDrawBinding,
  waterMaterialFrameBindingResources,
} from '../wave-material';

it.each([
  'river geometry',
  'ocean material',
] as const)('keeps retained transition draws intact after an %s revision', async (revision) => {
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000889');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const zoneGuid = guid('zone');
  const zone: WaterZoneAsset = {
    kind: 'water-zone',
    extentM: { spanXM: 32, spanZM: 32 },
    tileSizeM: 8,
    tessellationFactor: 1,
    lodScale: 1,
    waterInfo: {
      resolution: { widthPx: 32, heightPx: 32 },
      format: 'rgba16f',
      blurRadius: 0,
      localTessellation: false,
    },
  };
  const point = (inputKey: number, x: number, z: number) => ({
    inputKey,
    positionM: [x, 0, z] as const,
    arriveTangentM: [0, 0, 0] as const,
    leaveTangentM: [0, 0, 0] as const,
    up: [0, 1, 0] as const,
    rollAngle: 0,
    angleUnit: 'degrees' as const,
    widthM: 6,
    depthM: 3,
    velocityMPerSec: 1,
    audioIntensity: 0,
    interpolationMode: 'linear' as const,
    rotationQuat: [0, 0, 0, 1] as const,
  });
  const common = {
    kind: 'water-body' as const,
    zoneGuid,
    baseHeightM: 0,
    overlapPriority: 0,
    maxWaveHeightM: 0,
    surfaceMaterialGuid: guid('material'),
    flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
    collision: { type: 'none' as const, enabled: false },
    queryFootprint: [
      [-16, -16],
      [16, -16],
      [16, 16],
      [-16, 16],
    ] as const,
  };
  const packed = (
    await buildWaterPackOutputs(
      {
        ocean: {
          ...common,
          type: 'ocean',
          oceanExtentM: [64, 64],
          centerOnWaterZone: false,
          spline: {
            closed: true,
            points: [point(0, -12, -12), point(1, -8, -12), point(2, -8, -8), point(3, -12, -8)],
          },
        },
        river: {
          ...common,
          type: 'river',
          overlapPriority: 3,
          riverToOceanTransitionMaterialGuid: guid('transition'),
          spline: { closed: false, points: [point(0, -8, 0), point(1, 0, 0), point(2, 8, 0)] },
        },
        'river-edited': {
          ...common,
          type: 'river',
          overlapPriority: 3,
          riverToOceanTransitionMaterialGuid: guid('transition'),
          spline: { closed: false, points: [point(0, -8, 0), point(1, 0, 4), point(2, 8, 0)] },
        },
      },
      { packageId },
    )
  ).unwrap();
  const outputs = new Map(Object.entries(packed).map(([key, value]) => [guid(key), value]));
  const water = new WaterSystem(
    (key) => (key === zoneGuid ? { generation: 1, asset: zone } : undefined),
    (asset) =>
      [
        'waterInfoMeshGuid',
        'dilatedWaterInfoMeshGuid',
        'visibleMeshGuid',
        'riverSegmentMeshGuids',
      ].flatMap((field) => {
        const value = asset[field as keyof WaterBodyAsset];
        return (typeof value === 'string' ? [value] : Array.isArray(value) ? value : []).flatMap(
          (key, index) => {
            const payload = typeof key === 'string' ? outputs.get(key) : undefined;
            return payload === undefined
              ? []
              : [
                  {
                    guid: String(key),
                    field: Array.isArray(value) ? `${field}[${index}]` : field,
                    kind: 'mesh',
                    status: 'valid' as const,
                    payload,
                  },
                ];
          },
        );
      }),
    () => [{ guid: zoneGuid, generation: 1, asset: zone }],
  );
  const ocean = water.mountBody('ocean', '1', packed.ocean as WaterBodyAsset).unwrap();
  const river = water.mountBody('river', '1', packed.river as WaterBodyAsset).unwrap();
  for (const body of [ocean, river])
    water
      .acceptOutput(body.guid, 'geometry', body.outputGenerations.geometry, {
        generation: 1,
        digest: body.guid,
      })
      .unwrap();
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  const deferral = createWaterInfoCaptureDeferralProbe();
  const feature = deferral.feature;
  const graphResources = { owner: {}, retained: true };
  const caps = {
    compute: true,
    storageBuffer: true,
    storageTexture: true,
    rgba16floatRenderable: true,
    rgba16floatStorage: true,
  } as never;
  const extract = (frameNumber: number, deviceGeneration = 1) => {
    water.buildZoneMeshView(zoneGuid, 1, zone, { viewId: 'view', observerM: [0, 4, 12] }).unwrap();
    return feature
      .extract({
        world: world,
        frameNumber,
        caps,
        views: [
          {
            identity: 'view',
            render: true,
            graphResources,
            frame: {
              view: {
                identity: 'view',
                width: 64,
                height: 64,
                cameraRevision: 0,
                deviceGeneration,
                cameraPosition: [0, 4, 12],
              },
            },
          },
        ],
      })
      .unwrap();
  };
  const submission = (
    frame: ReturnType<typeof extract>,
    frameNumber: number,
  ): RenderFeatureSubmission => {
    const plan = feature
      .plan(frame, { caps, frame: { frameNumber }, generation: 1, views: [] })
      .unwrap();
    return {
      works: plan.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({
          name: pass.name,
          ...(pass.kind === 'raster'
            ? { graphics: { draws: pass.draws.map((draw) => ({ kind: draw.draw.kind })) } }
            : {}),
          ...(pass.kind === 'compute'
            ? { resolvedGpuComputeDispatchCount: pass.dispatches.length }
            : {}),
        })),
      })),
    };
  };
  const first = extract(1);
  feature.onFrameSubmitted?.(first, submission(first, 1));
  feature.onFrameReceipt?.(
    {
      frameId: 1,
      deviceGeneration: 1,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    },
    Promise.resolve(ok([])),
  );
  await Promise.resolve();
  const previous = first.views[0]?.publication;
  if (previous === undefined) throw new Error('initial publication missing');
  const previousName = previous.targets[0]?.targetName;
  const oceanKey = waterBodyOwnerKey(world.identity, 'ocean', ocean.sceneGeneration, 1);
  const riverKey = waterBodyOwnerKey(world.identity, 'river', river.sceneGeneration, 1);
  const mesh = water.zoneMeshView(zoneGuid, 'view');
  if (mesh === undefined) throw new Error('initial mesh was not accepted on completion');
  const drawUploads = (receipt: typeof mesh.receipt) =>
    receipt.buckets
      .flatMap((bucket) => bucket.ownerDraws)
      .map((draw) => ({
        drawKey: draw.drawKey,
        bodyGuid: waterBodyOwnerKey(world.identity, draw.ownerGuid, draw.ownerGeneration, 1),
        bodyGeneration: draw.ownerGeneration,
        zoneGeneration: 1,
        viewIdentity: 'view',
        bytes: draw.instanceBytes,
        coverageBytes: draw.coverageBytes,
        layout: draw.layout,
        transitionTargets: draw.instances.flatMap((instance, instanceIndex) =>
          instance.transitionBodyGuid === undefined ||
          instance.transitionBodyGeneration === undefined
            ? []
            : [
                {
                  instanceIndex,
                  bodyGuid: waterBodyOwnerKey(
                    world.identity,
                    instance.transitionBodyGuid,
                    instance.transitionBodyGeneration,
                    1,
                  ),
                  bodyGeneration: instance.transitionBodyGeneration,
                  zoneGeneration: 1,
                },
              ],
        ),
      }));
  const draws = drawUploads(mesh.receipt);
  expect(
    draws.some((draw) => draw.bodyGuid === riverKey && draw.transitionTargets.length > 0),
  ).toBe(true);
  const assertDrawable = (
    publication: WaterInfoFramePublication,
    frameNumber: number,
    materialDraws = draws,
    expectedTarget = previousName,
  ) => {
    const bindings = new Map<string, WaterMaterialFrameBindings>();
    for (const snapshot of waterInfoMaterialBindingSnapshots(publication).unwrap()) {
      const target = snapshot.targets[0];
      if (target === undefined) continue;
      const upload = buildWaterMaterialFrameUpload(
        snapshot.waveUploadPlan,
        new Map([...snapshot.rows].map(([key, row]) => [key, row.descriptor])),
        materialDraws.filter(
          (draw) =>
            snapshot.rows.has(draw.bodyGuid) &&
            draw.transitionTargets.every((peer) => snapshot.rows.has(peer.bodyGuid)),
        ),
      );
      bindings.set(target.targetName, {
        ...waterMaterialFrameBindingResources({
          upload,
          buffers: {
            bodyDataBuffer: 1 as never,
            waveDataBuffer: 2 as never,
            drawDataBuffer: 3 as never,
            waterInfoDescriptorBuffer: 4 as never,
            waterMeshInstanceBuffer: 5 as never,
            bakedDescriptorBuffer: 6 as never,
            bakedSamplesBuffer: 7 as never,
          },
          waterInfoTextureView: 8 as never,
          waterInfoSampler: 9 as never,
          waterInfoContentFrameGeneration: target.contentFrameGeneration,
          waterInfoContentGraphResourceVersion: target.graphResourceVersion,
          waterInfoTargetName: target.targetName,
          waterInfoFormat: target.targetFormat,
          bodyTargetNames: new Map([...snapshot.rows].map(([key, row]) => [key, row.targetName])),
          bodyTargetFormats: new Map(
            [...snapshot.rows].map(([key, row]) => [key, row.targetFormat]),
          ),
          viewIdentity: 'view',
          deviceGeneration: 1,
          frameGeneration: frameNumber,
        }),
        bindGroup: 10 as never,
      });
    }
    for (const draw of materialDraws) {
      const binding = waterMaterialDrawBinding(
        bindings,
        draw.bodyGuid,
        {
          viewIdentity: 'view',
          zoneGeneration: 1,
          deviceGeneration: 1,
          frameGeneration: frameNumber,
          bodyGeneration: draw.bodyGeneration,
        },
        draw.drawKey,
      ).unwrap();
      if (expectedTarget !== undefined)
        expect(binding.frameBindings.waterInfoTargetName).toBe(expectedTarget);
    }
  };
  if (revision === 'ocean material') {
    const revisedOcean = water.mountBody('ocean', '2', packed.ocean as WaterBodyAsset).unwrap();
    water
      .acceptOutput('ocean', 'geometry', revisedOcean.outputGenerations.geometry, {
        generation: 2,
        digest: 'ocean-material-revised',
      })
      .unwrap();
    const revisedFrame = extract(2);
    const revisedPublication = revisedFrame.views[0]?.publication;
    if (revisedPublication === undefined) throw new Error('revised publication missing');
    expect(revisedPublication.rows.get(riverKey)?.targetName).not.toBe(previousName);
    expect(
      revisedPublication.bindingSnapshots?.some((snapshot) => snapshot.rows.has(riverKey)),
    ).toBe(true);
    assertDrawable(revisedPublication, 2);
    const live = water.waterMeshCandidateViews('view')[0];
    if (live === undefined) throw new Error('material revision candidate missing');
    assertDrawable(
      revisedPublication,
      2,
      drawUploads(live.receipt),
      revisedPublication.targets.find((target) => target.write)?.targetName,
    );
    feature.onFrameAborted?.(revisedFrame);
    return;
  }
  const revised = water.mountBody('river', '2', packed['river-edited'] as WaterBodyAsset).unwrap();
  water
    .acceptOutput('river', 'geometry', revised.outputGenerations.geometry, {
      generation: 2,
      digest: 'river-edited',
    })
    .unwrap();
  deferral.deferNextCapture({ viewIdentity: 'view', deviceGeneration: 1 });
  const delayed = extract(2);
  const delayedPublication = delayed.views[0]?.publication;
  if (delayedPublication === undefined) throw new Error('delayed publication missing');
  expect(delayed.views[0]?.captures).toHaveLength(0);
  expect(delayedPublication.targets.map((target) => target.write)).toEqual([false]);
  expect(delayedPublication.targets[0]?.targetName).toBe(previousName);
  expect(delayedPublication.targets[0]?.contentFrameGeneration).toBe(1);
  expect(delayedPublication.rows.get(riverKey)?.targetName).toBe(previousName);
  expect(deferral.inspect().deferred?.frameGeneration).toBe(2);
  assertDrawable(delayedPublication, 2);
  feature.onFrameSubmitted?.(delayed, submission(delayed, 2));
  feature.onFrameReceipt?.(
    {
      frameId: 2,
      deviceGeneration: 1,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    },
    Promise.resolve(ok([])),
  );
  await Promise.resolve();
  expect(water.zoneMeshView(zoneGuid, 'view')?.publicationGeneration).toBe(
    mesh.publicationGeneration,
  );
  const candidate = extract(3);
  const publication = candidate.views[0]?.publication;
  if (publication === undefined) throw new Error('candidate publication missing');
  expect(publication.rows.get(oceanKey)?.targetName).not.toBe(previousName);
  const retained =
    publication.bindingSnapshots?.find((snapshot) =>
      snapshot.targets.some((target) => target.targetName === previousName),
    ) ?? publication;
  expect(retained.rows.get(riverKey)?.targetName).toBe(previousName);
  expect(retained.rows.get(oceanKey)?.targetName).toBe(previousName);
  expect(retained.waveUploadPlan.bodyIndices.has(oceanKey)).toBe(true);
  expect(retained.waveUploadPlan.bodyIndices.has(riverKey)).toBe(true);
  assertDrawable(publication, 3);
  feature.onFrameAborted?.(candidate);
  const retry = extract(4);
  const retried = retry.views[0]?.publication as typeof publication;
  expect(retried.targets.filter((target) => target.write)).toHaveLength(1);
  expect(retried.targets.map((target) => target.targetName)).toEqual(
    publication.targets.map((target) => target.targetName),
  );
  assertDrawable(retried, 4);
  feature.onFrameSubmitted?.(retry, submission(retry, 4));
  const retryCandidate = water.waterMeshCandidateViews('view')[0];
  const latest = water.mountBody('river', '3', packed.river as WaterBodyAsset).unwrap();
  water
    .acceptOutput('river', 'geometry', latest.outputGenerations.geometry, {
      generation: 3,
      digest: 'river-latest',
    })
    .unwrap();
  const next = extract(5);
  const nextCandidate = water.waterMeshCandidateViews('view')[0];
  expect(nextCandidate?.publicationGeneration).not.toBe(retryCandidate?.publicationGeneration);
  feature.onFrameSubmitted?.(next, submission(next, 5));
  let finishPrevious!: (result: ReturnType<typeof ok<void>>) => void;
  const previousCompleted = new Promise<ReturnType<typeof ok<void>>>((resolve) => {
    finishPrevious = resolve;
  });
  let finishNext!: (result: ReturnType<typeof ok<void>>) => void;
  const nextCompleted = new Promise<ReturnType<typeof ok<void>>>((resolve) => {
    finishNext = resolve;
  });
  feature.onFrameReceipt?.(
    { frameId: 4, deviceGeneration: 1, presentation: 'ready', completed: previousCompleted },
    Promise.resolve(ok([])),
  );
  feature.onFrameReceipt?.(
    { frameId: 5, deviceGeneration: 1, presentation: 'ready', completed: nextCompleted },
    Promise.resolve(ok([])),
  );
  const inFlight = next.views[0]?.publication;
  if (inFlight === undefined) throw new Error('in-flight publication missing');
  expect(inFlight?.rows.has(riverKey)).toBe(true);
  expect(inFlight?.targets.some((target) => target.targetName === previousName)).toBe(true);
  assertDrawable(inFlight, 5);
  finishNext(ok(undefined));
  await Promise.resolve();
  expect(water.zoneMeshView(zoneGuid, 'view')?.publicationGeneration).toBe(
    nextCandidate?.publicationGeneration,
  );
  expect(water.zoneMeshView(zoneGuid, 'view')?.sourceGenerations.river).toBe(
    latest.sceneGeneration,
  );
  const converged = extract(6).views[0]?.publication;
  expect(converged?.rows.has(riverKey)).toBe(false);
  expect(converged?.targets.some((target) => target.targetName === previousName)).toBe(false);
  expect(converged?.bindingSnapshots).toEqual([]);
  finishPrevious(ok(undefined));
  await Promise.resolve();
  expect(water.zoneMeshView(zoneGuid, 'view')?.publicationGeneration).toBe(
    nextCandidate?.publicationGeneration,
  );
  const failedBody = water
    .mountBody('river', '4', packed['river-edited'] as WaterBodyAsset)
    .unwrap();
  water
    .acceptOutput('river', 'geometry', failedBody.outputGenerations.geometry, {
      generation: 4,
      digest: 'river-failed',
    })
    .unwrap();
  const failed = extract(7);
  feature.onFrameSubmitted?.(failed, submission(failed, 7));
  feature.onFrameReceipt?.(
    {
      frameId: 7,
      deviceGeneration: 1,
      presentation: 'ready',
      completed: Promise.resolve(
        err(new RendererContractFailureError('draw', 'injected completion failure')),
      ),
    },
    Promise.resolve(ok([])),
  );
  await Promise.resolve();
  expect(water.zoneMeshView(zoneGuid, 'view')?.publicationGeneration).toBe(
    nextCandidate?.publicationGeneration,
  );
  const retired = extract(8);
  feature.onFrameSubmitted?.(retired, submission(retired, 8));
  let finishRetired!: (result: ReturnType<typeof ok<void>>) => void;
  const retiredCompleted = new Promise<ReturnType<typeof ok<void>>>((resolve) => {
    finishRetired = resolve;
  });
  feature.onFrameReceipt?.(
    { frameId: 8, deviceGeneration: 1, presentation: 'ready', completed: retiredCompleted },
    Promise.resolve(ok([])),
  );
  extract(9, 2);
  finishRetired(ok(undefined));
  await Promise.resolve();
  expect(water.zoneMeshView(zoneGuid, 'view')).toBeUndefined();
});
