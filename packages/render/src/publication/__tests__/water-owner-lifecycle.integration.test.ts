import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Time, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { textureContribution } from '@forgeax/engine-image';
import { quat } from '@forgeax/engine-math';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { definePackageId } from '@forgeax/engine-pack/source';
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
  type WaterBodySourceAsset,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import {
  waterMeshCandidateViewsForRenderer,
  waterZoneMeshViewForRenderer,
} from '@forgeax/engine-water/internal';
import { expect, it, vi } from 'vitest';
import { waterMeshTestAssets } from '../../__tests__/water-mesh-assets.fixture';
import { materialContribution, samplerContribution } from '../../assets/asset-decoders';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { MaterialResource } from '../../material-resource';
import { materialSourceScope } from '../../material-source';
import { Materials } from '../../materials';
import { PersistentRenderScene } from '../../scene/render-scene';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { type RenderPublicationMessage, renderPublicationTransfers } from '../record';

const zoneGuid = '00000000-0000-7000-8000-000000000006';
const materialGuid = '00000000-0000-7000-8000-000000000001';
const bodyAsset: WaterBodySourceAsset = {
  kind: 'water-body',
  type: 'lake',
  zoneGuid,
  surfaceMaterialGuid: materialGuid,
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
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'polygon', enabled: true, channelDepthM: 4 },
  queryFootprint: [
    [-6, -6],
    [6, -6],
    [6, 6],
    [-6, 6],
  ],
};
const zoneAsset: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 2,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 64, heightPx: 64 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};

function cameraRotationTowardLake(eye: readonly [number, number, number]) {
  return quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]);
}

it('publishes pending WaterMesh readiness once, retries on accepted WaterInfo, and removes stale owners', async () => {
  const assets = await waterMeshTestAssets(materialGuid);
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
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
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
  let ordinaryMesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  let ordinaryMaterial = assets.create(Materials.unlit([0.2, 0.4, 0.8, 1])).unwrap();
  const bodyEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterBodyInstance, data: { body: 0 as never } },
      { component: MeshFilter, data: { assetHandle: ordinaryMesh } },
      { component: MeshRenderer, data: { materials: [ordinaryMaterial] } },
    )
    .unwrap();
  let zoneReady = false;
  const liveZone = { guid: zoneGuid, generation: 1, asset: zoneAsset };
  const water = new WaterSystem(
    (guid) => (zoneReady && guid === zoneGuid ? liveZone : undefined),
    () => [],
    () => (zoneReady ? [liveZone] : []),
  );
  const packed = await buildWaterPackOutputs(
    { body: bodyAsset },
    { packageId: definePackageId('019a0000-0000-7000-8000-000000000495') },
  );
  if (!packed.ok || packed.value.body?.kind !== 'water-body')
    throw new Error('WaterMesh fixture body must cook successfully');
  const bodyGuid = `scene-entity:${bodyEntity}`;
  water.mountBody(bodyGuid, '1', packed.value.body).unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();

  const identity = { source: 'water-owner-lifecycle', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  propagateTransforms(world).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const publish = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const upsertEntities = Array.from(candidate.packet.upserts).filter(
      (_, index) => index % 2 === 0,
    );
    const removedEntities = Array.from(candidate.packet.removed);
    const sent = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(sent).unwrap();
    const viewFrame = scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(sent), {
      transfer: renderPublicationTransfers(sent),
    });
    publisher.recycle(sent.revision, returned).unwrap();
    return { upsertEntities, removedEntities, accepted, viewFrame, revision: sent.revision };
  };
  const viewId = `camera:${Number(camera)}`;

  try {
    expect(water.snapshot(bodyGuid)?.outputs.waterInfo).toBe('zone-unbound');
    const unbound = publish();
    expect(unbound.upsertEntities).toContain(Number(bodyEntity));
    const ordinaryOwner = unbound.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(ordinaryOwner?.assetHandle).toBe(ordinaryMesh);
    expect(
      ordinaryOwner?.materials.some(
        (material) => material.snapshot.materialHandle === ordinaryMaterial,
      ),
    ).toBe(true);
    expect(ordinaryOwner?.waterMeshSource).toBeUndefined();

    zoneReady = true;
    const pendingInfo = water.snapshot(bodyGuid);
    if (pendingInfo === undefined) throw new Error('Pending WaterMesh body must exist');
    expect(pendingInfo?.outputs.waterInfo).toBe('unsupported');
    water
      .acceptOutput(bodyGuid, 'geometry', pendingInfo.outputGenerations.geometry, {
        generation: 1,
        digest: 'geometry-ready',
      })
      .unwrap();
    const pendingFrame = publish();
    expect(pendingFrame.upsertEntities).toContain(Number(bodyEntity));
    const pendingCandidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    if (pendingCandidate === undefined) throw new Error('Pending WaterMesh candidate must exist');

    const waterInfoBody = water.snapshot(bodyGuid);
    if (waterInfoBody === undefined) throw new Error('WaterInfo body must exist');
    expect(waterInfoBody?.outputs.waterInfo).toBe('unsupported');
    water
      .acceptOutput(bodyGuid, 'waterInfo', waterInfoBody.outputGenerations.waterInfo, {
        generation: 2,
        digest: 'water-info-ready',
      })
      .unwrap();

    const discarded = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const discardedRevision = discarded.message.revision;
    const discardedWaterCandidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    if (discardedWaterCandidate === undefined)
      throw new Error('Discarded WaterMesh candidate must exist');
    expect(
      discarded.packet.templates.some(
        (template) => template.snapshot.waterMeshSource !== undefined,
      ),
    ).toBe(true);
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)).toBeUndefined();
    discarded.discard();
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)).toBeUndefined();
    expect(water.snapshot(bodyGuid)?.outputs.waterMesh).not.toBe('ready');

    const waterMeshPublished = publish();
    expect(waterMeshPublished.upsertEntities).toContain(Number(bodyEntity));
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)).toBeUndefined();
    const retriedWaterCandidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    // Discard retries the transport packet. Unchanged mesh inputs retain the
    // scene-owned candidate until an actual Renderer accepts its generation.
    expect(waterMeshPublished.revision).toBe(discardedRevision);
    expect(waterMeshPublished.revision).toBeGreaterThan(pendingFrame.revision);
    expect(retriedWaterCandidate).toBe(discardedWaterCandidate);
    expect(retriedWaterCandidate?.receipt).toBe(discardedWaterCandidate.receipt);
    const ownerRows = waterMeshPublished.accepted.frame.renderables.filter(
      (row) => row.waterMeshSource !== undefined,
    );
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]?.entityKey).toBe(Number(bodyEntity));
    expect(ownerRows[0]?.assetHandle).toBe(ordinaryMesh);
    expect(
      ownerRows[0]?.materials.some(
        (material) => material.snapshot.materialHandle === ordinaryMaterial,
      ),
    ).toBe(true);
    const ownerViews = ownerRows[0]?.waterMeshSource?.views ?? [];
    expect(ownerViews).toHaveLength(1);
    expect(ownerViews[0]?.viewIdentity).toBe(viewId);
    expect(ownerViews[0]?.draws.length).toBeGreaterThan(1);
    expect(ownerRows[0]?.generatedMesh).toBeUndefined();
    const projectedWaterDraws = waterMeshPublished.viewFrame.renderables.filter(
      (row) => row.waterOwner !== undefined,
    );
    expect(projectedWaterDraws.length).toBe(ownerViews[0]?.draws.length);
    expect(projectedWaterDraws.every((row) => row.entityKey === Number(bodyEntity))).toBe(true);
    expect(new Set(projectedWaterDraws.map((row) => row.nativeDraw?.key)).size).toBe(
      projectedWaterDraws.length,
    );
    expect(
      waterMeshPublished.viewFrame.renderables.some(
        (row) => row.entityKey === Number(bodyEntity) && row.assetHandle === ordinaryMesh,
      ),
    ).toBe(true);
    const ordinaryOwnerIndex = waterMeshPublished.viewFrame.renderables.findIndex(
      (row) => row.entityKey === Number(bodyEntity) && row.assetHandle === ordinaryMesh,
    );
    expect(
      waterMeshPublished.viewFrame.dispatch.some(
        (entry) =>
          entry.entityIndex === Number(bodyEntity) && entry.renderableIndex === ordinaryOwnerIndex,
      ),
    ).toBe(true);
    const waterDrawCount = projectedWaterDraws.length;
    const readyCandidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    if (readyCandidate === undefined) throw new Error('Ready WaterMesh candidate must exist');
    expect(readyCandidate).toBe(retriedWaterCandidate);
    expect(readyCandidate.sourceGenerations).toEqual(pendingCandidate.sourceGenerations);
    expect(water.acceptWaterMeshView(zoneGuid, viewId, readyCandidate.publicationGeneration)).toBe(
      true,
    );
    expect(water.snapshot(bodyGuid)?.outputs.waterMesh).toBe('ready');
    const acceptedWaterMeshGeneration = waterZoneMeshViewForRenderer(
      water,
      zoneGuid,
      viewId,
    )?.publicationGeneration;
    expect(acceptedWaterMeshGeneration).toBe(readyCandidate.publicationGeneration);

    ordinaryMesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    ordinaryMaterial = assets.create(Materials.unlit([0.9, 0.2, 0.1, 1])).unwrap();
    world.set(bodyEntity, MeshFilter, { assetHandle: ordinaryMesh }).unwrap();
    world.set(bodyEntity, MeshRenderer, { materials: [ordinaryMaterial] }).unwrap();
    const changedOrdinaryMesh = publish();
    expect(changedOrdinaryMesh.upsertEntities).toContain(Number(bodyEntity));
    expect(changedOrdinaryMesh.removedEntities).not.toContain(Number(bodyEntity));
    const changedOwner = changedOrdinaryMesh.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(changedOwner?.assetHandle).toBe(ordinaryMesh);
    expect(changedOwner?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
    expect(
      changedOrdinaryMesh.viewFrame.renderables.filter((row) => row.waterOwner !== undefined),
    ).toHaveLength(waterDrawCount);

    assets.replace(ordinaryMaterial, Materials.unlit([0.1, 0.8, 0.3, 1])).unwrap();
    const invalidatedMaterial = publish();
    expect(invalidatedMaterial.upsertEntities).toContain(Number(bodyEntity));
    expect(invalidatedMaterial.removedEntities).not.toContain(Number(bodyEntity));
    const invalidatedOwner = invalidatedMaterial.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(
      invalidatedOwner?.materials.some(
        (material) => material.snapshot.materialHandle === ordinaryMaterial,
      ),
    ).toBe(true);
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)?.publicationGeneration).toBe(
      acceptedWaterMeshGeneration,
    );
    expect(waterMeshCandidateViewsForRenderer(water, viewId)).toEqual([]);

    // WaterMesh candidates are scene-owned until a renderer feature submits them.
    // This mirror only checks publisher membership, so give it an isolated system.
    const mirrorWater = new WaterSystem(() => undefined);
    world.insertResource(WATER_SYSTEM_RESOURCE, mirrorWater);
    const mirror = createRenderPublisher(world, assets, {
      source: 'water-owner-lifecycle-mirror',
      epoch: 1,
    });
    try {
      const mirrorCandidate = mirror.prepare(world.getResource(Time).elapsed).unwrap();
      expect(
        Array.from(mirrorCandidate.packet.upserts).filter((_, index) => index % 2 === 0),
      ).toContain(Number(bodyEntity));
      const mirrorMessage = structuredClone(mirrorCandidate.message, {
        transfer: renderPublicationTransfers(mirrorCandidate.message),
      });
      mirrorCandidate.accept();
      const mirrorReturned = structuredClone(renderPublicationTransfers(mirrorMessage), {
        transfer: renderPublicationTransfers(mirrorMessage),
      });
      mirror.recycle(mirrorMessage.revision, mirrorReturned).unwrap();
      const mirrorQuiet = mirror.prepare(world.getResource(Time).elapsed).unwrap();
      expect(Array.from(mirrorQuiet.packet.upserts)).toEqual([]);
      mirrorQuiet.discard();
    } finally {
      mirror.dispose();
      world.insertResource(WATER_SYSTEM_RESOURCE, water);
    }

    expect(waterMeshCandidateViewsForRenderer(water, viewId)).toEqual([]);
    const quiet = publish();
    expect(quiet.upsertEntities).toEqual([]);
    expect(quiet.removedEntities).toEqual([]);
    expect(quiet.accepted.frame.renderables.some((row) => row.waterMeshSource !== undefined)).toBe(
      false,
    );
    expect(quiet.viewFrame.renderables.filter((row) => row.waterOwner !== undefined)).toHaveLength(
      waterDrawCount,
    );
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)?.publicationGeneration).toBe(
      acceptedWaterMeshGeneration,
    );
    expect(waterMeshCandidateViewsForRenderer(water, viewId)).toEqual([]);

    water.unmountBody(bodyGuid);
    const restored = publish();
    expect(restored.removedEntities).not.toContain(Number(bodyEntity));
    expect(restored.upsertEntities).toContain(Number(bodyEntity));
    expect(restored.accepted.frame.renderables).toHaveLength(1);
    expect(restored.accepted.frame.renderables.at(0)?.waterMeshSource).toBeUndefined();
    expect(restored.viewFrame.renderables.some((row) => row.waterOwner !== undefined)).toBe(false);
    expect(restored.accepted.frame.renderables.at(0)?.assetHandle).toBe(ordinaryMesh);
    expect(restored.accepted.frame.renderables.at(0)?.materials[0]?.snapshot.materialHandle).toBe(
      Number(ordinaryMaterial),
    );
    const quietAfterRemoval = publish();
    expect(quietAfterRemoval.upsertEntities).toEqual([]);
    expect(
      quietAfterRemoval.viewFrame.renderables.some((row) => row.waterOwner !== undefined),
    ).toBe(false);
  } finally {
    scene.dispose();
    receiver.dispose();
    publisher.dispose();
  }
});

it('refreshes an accepted empty WaterMesh owner when a mesh-only candidate is committed', async () => {
  const assets = await waterMeshTestAssets(materialGuid);
  const world = new World({ assets });
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 4, -8],
          quat: cameraRotationTowardLake([0, 4, -8]),
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
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
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
  const bodyEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterBodyInstance, data: { body: 0 as never } },
    )
    .unwrap();
  const meshOnlyAsset: WaterBodySourceAsset = {
    ...bodyAsset,
    flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
  };
  const packed = await buildWaterPackOutputs(
    { body: meshOnlyAsset },
    { packageId: definePackageId('019a0000-0000-7000-8000-000000000496') },
  );
  if (!packed.ok || packed.value.body?.kind !== 'water-body')
    throw new Error('WaterMesh mesh-only fixture body must cook successfully');
  const liveZone = { guid: zoneGuid, generation: 1, asset: zoneAsset };
  const water = new WaterSystem(
    (guid) => (guid === zoneGuid ? liveZone : undefined),
    () => [],
    () => [liveZone],
  );
  const bodyGuid = `scene-entity:${bodyEntity}`;
  water.mountBody(bodyGuid, '1', packed.value.body).unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();

  const identity = { source: 'water-owner-mesh-only-lifecycle', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  propagateTransforms(world).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const publish = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const upsertEntities = Array.from(candidate.packet.upserts).filter(
      (_, index) => index % 2 === 0,
    );
    const sent = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(sent).unwrap();
    const viewFrame = scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(sent), {
      transfer: renderPublicationTransfers(sent),
    });
    publisher.recycle(sent.revision, returned).unwrap();
    return { upsertEntities, accepted, viewFrame };
  };
  const viewId = `camera:${Number(camera)}`;

  try {
    const first = publish();
    const firstOwner = first.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(firstOwner?.waterMeshSource?.views).toEqual([]);
    expect(
      first.viewFrame.renderables.some(
        (row) => row.entityKey === Number(bodyEntity) && row.waterOwner === undefined,
      ),
    ).toBe(false);
    const beforeCommit = water.snapshot(bodyGuid);
    if (beforeCommit === undefined) throw new Error('WaterMesh body must exist before commit');
    expect(beforeCommit.outputReceipts.waterInfo).toBeUndefined();
    const candidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    if (candidate === undefined) throw new Error('WaterMesh candidate must exist');
    expect(water.acceptWaterMeshView(zoneGuid, viewId, candidate.publicationGeneration)).toBe(true);
    const afterCommit = water.snapshot(bodyGuid);
    if (afterCommit === undefined) throw new Error('WaterMesh body must exist after commit');
    expect(afterCommit.outputReceipts.waterInfo).toEqual(beforeCommit.outputReceipts.waterInfo);
    expect(afterCommit.outputGenerations.waterInfo).toBe(beforeCommit.outputGenerations.waterInfo);
    expect(afterCommit.outputs.waterMesh).toBe('ready');

    const refreshed = publish();
    expect(refreshed.upsertEntities).toContain(Number(bodyEntity));
    const owner = refreshed.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(owner?.assetHandle).toBeUndefined();
    expect(owner?.waterMeshSource?.views[0]?.viewIdentity).toBe(viewId);
    expect(owner?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
    expect(
      refreshed.viewFrame.renderables.filter(
        (row) => row.entityKey === Number(bodyEntity) && row.waterOwner === undefined,
      ),
    ).toHaveLength(0);
    expect(water.snapshot(bodyGuid)?.outputReceipts.waterInfo).toBeUndefined();
  } finally {
    scene.dispose();
    receiver.dispose();
    publisher.dispose();
  }
});

it('refreshes shared WaterMesh child materials without rebuilding geometry', async () => {
  const packageUrl = 'https://water-owner-material.invalid/material.pack.json';
  const sourcePath = 'water-owner-material.pack.ts';
  const scopeId = 'water-owner-material';
  const parentMaterialGuid = '00000000-0000-7000-8000-00000000000a';
  const textureGuid = '00000000-0000-7000-8000-00000000000b';
  const samplerGuid = '00000000-0000-7000-8000-00000000000c';
  const textureBinding = { texture: textureGuid, sampler: samplerGuid };
  const initialWaterMaterial = Materials.unlit([0.1, 0.3, 0.9, 1], {
    baseColorTexture: textureBinding,
  });
  const updatedWaterMaterial = Materials.unlit([0.9, 0.2, 0.1, 1], {
    baseColorTexture: textureBinding,
  });
  const initialTexture = {
    kind: 'texture' as const,
    format: 'rgba8unorm' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
    colorSpace: 'linear' as const,
    mips: { kind: 'none' as const },
    data: [255, 255, 255, 255],
  };
  const materialPublication = createRuntimePackPublication({
    scopeId,
    generation: 1,
    sourcePath,
    sourceRevision: '1',
    packageUrl,
    sourceKeys: new Map([
      [parentMaterialGuid, 'root'],
      [materialGuid, 'surface'],
      [textureGuid, 'color'],
      [samplerGuid, 'sampler'],
    ]),
    pack: {
      assets: [
        {
          guid: parentMaterialGuid,
          kind: 'material',
          payload: initialWaterMaterial,
          refs: [textureGuid, samplerGuid],
          artifacts: {},
        },
        { guid: textureGuid, kind: 'texture', payload: initialTexture, refs: [], artifacts: {} },
        {
          guid: samplerGuid,
          kind: 'sampler',
          payload: { kind: 'sampler', magFilter: 'linear', minFilter: 'linear' },
          refs: [],
          artifacts: {},
        },
        {
          guid: materialGuid,
          kind: 'material',
          payload: { kind: 'material', parent: parentMaterialGuid, values: {} },
          refs: [parentMaterialGuid],
          artifacts: {},
        },
      ],
    },
  });
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const materialDecoder = assets.installDecoder(
    materialContribution.kind,
    materialContribution.decoder,
  );
  const textureDecoder = assets.installDecoder(
    textureContribution.kind,
    textureContribution.decoder,
  );
  const samplerDecoder = assets.installDecoder(
    samplerContribution.kind,
    samplerContribution.decoder,
  );
  assets.setCatalogSource(
    createCatalogSource({
      expectedScope: { scopeId, generation: 1 },
      entries: [
        {
          guid: parentMaterialGuid,
          kind: 'material',
          sourcePath,
          sourceKey: 'root',
          refs: [textureGuid, samplerGuid],
          packageUrl,
          publication: materialPublication.publication,
        },
        {
          guid: textureGuid,
          kind: 'texture',
          packageUrl,
          sourcePath,
          sourceKey: 'color',
          publication: materialPublication.publication,
        },
        {
          guid: samplerGuid,
          kind: 'sampler',
          packageUrl,
          sourcePath,
          sourceKey: 'sampler',
          publication: materialPublication.publication,
        },
        {
          guid: materialGuid,
          kind: 'material',
          refs: [parentMaterialGuid],
          packageUrl,
          sourcePath,
          sourceKey: 'surface',
          publication: materialPublication.publication,
        },
      ],
    }),
    async () => Response.json(materialPublication.pack),
  );
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
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
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
  const ordinaryMesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const ordinaryMaterial = assets.create(Materials.unlit([0.2, 0.4, 0.8, 1])).unwrap();
  const spawnBody = () =>
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: 0 as never } },
        { component: MeshFilter, data: { assetHandle: ordinaryMesh } },
        { component: MeshRenderer, data: { materials: [ordinaryMaterial] } },
      )
      .unwrap();
  const bodyEntity = spawnBody();
  const siblingEntity = spawnBody();
  const ownerEntities = [Number(bodyEntity), Number(siblingEntity)];
  const liveZone = { guid: zoneGuid, generation: 1, asset: zoneAsset };
  const water = new WaterSystem(
    (guid) => (guid === zoneGuid ? liveZone : undefined),
    () => [],
    () => [liveZone],
  );
  const bodyAt = (centerXM: number): WaterBodySourceAsset => ({
    ...bodyAsset,
    spline: {
      ...bodyAsset.spline,
      points: bodyAsset.spline.points.map((point) => ({
        ...point,
        positionM: [
          point.positionM[0] * 0.45 + centerXM,
          point.positionM[1],
          point.positionM[2],
        ] as const,
      })),
    },
    queryFootprint: bodyAsset.queryFootprint.map(([x, z]) => [x * 0.45 + centerXM, z] as const),
  });
  const packed = await buildWaterPackOutputs(
    { body: bodyAt(-3.4), sibling: bodyAt(3.4) },
    { packageId: definePackageId('019a0000-0000-7000-8000-000000000496') },
  );
  if (
    !packed.ok ||
    packed.value.body?.kind !== 'water-body' ||
    packed.value.sibling?.kind !== 'water-body'
  )
    throw new Error('WaterMesh material fixture bodies must cook successfully');
  const bodyGuid = `scene-entity:${Number(bodyEntity)}`;
  const body = water.mountBody(bodyGuid, '1', packed.value.body).unwrap();
  const siblingGuid = `scene-entity:${Number(siblingEntity)}`;
  const sibling = water.mountBody(siblingGuid, '1', packed.value.sibling).unwrap();
  water
    .acceptOutput(bodyGuid, 'geometry', body.outputGenerations.geometry, {
      generation: 1,
      digest: 'water-owner-material-geometry',
    })
    .unwrap();
  water
    .acceptOutput(siblingGuid, 'geometry', sibling.outputGenerations.geometry, {
      generation: 1,
      digest: 'water-owner-material-sibling-geometry',
    })
    .unwrap();
  water
    .acceptOutput(bodyGuid, 'waterInfo', body.outputGenerations.waterInfo, {
      generation: 1,
      digest: 'water-owner-material-info',
    })
    .unwrap();
  water
    .acceptOutput(siblingGuid, 'waterInfo', sibling.outputGenerations.waterInfo, {
      generation: 1,
      digest: 'water-owner-material-sibling-info',
    })
    .unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();

  const identity = { source: 'water-owner-material', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const publish = (inspect?: (message: RenderPublicationMessage) => void) => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const upsertEntities = Array.from(candidate.packet.upserts).filter(
      (_, index) => index % 2 === 0,
    );
    const sent = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    inspect?.(sent);
    candidate.accept();
    const accepted = receiver.accept(sent).unwrap();
    const viewFrame = scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(sent), {
      transfer: renderPublicationTransfers(sent),
    });
    publisher.recycle(sent.revision, returned).unwrap();
    return { upsertEntities, accepted, viewFrame };
  };
  const viewId = `camera:${Number(camera)}`;
  const routedErrors: unknown[] = [];
  const errorLog = vi.spyOn(console, 'error').mockImplementation((_context, error) => {
    routedErrors.push(error);
  });

  try {
    publish();
    const unavailable = publish();
    const unavailableOwner = unavailable.accepted.frame.renderables.find(
      (row) => row.entityKey === Number(bodyEntity),
    );
    expect(unavailableOwner?.waterMeshSource?.views).toEqual([]);
    expect(routedErrors).toContainEqual(
      expect.objectContaining({
        code: 'resource-not-ready',
        detail: expect.objectContaining({ owner: 'material', actual: materialGuid }),
      }),
    );

    const waterMaterialHandle = (await assets.load(materialGuid, 'material')).unwrap();
    const first = publish((message) => {
      expect(
        receiver.accept({
          ...message,
          side: {
            ...message.side,
            assetVersions: (message.side?.assetVersions ?? []).filter(
              (asset) => asset.handle !== waterMaterialHandle,
            ),
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { detail: { subject: 'missing material source version' } },
      });
    });
    const ownerFor = (submitted: ReturnType<typeof publish>, entity: number) =>
      submitted.accepted.frame.renderables.find((row) => row.entityKey === entity) ??
      submitted.viewFrame.renderables.find((row) => row.entityKey === entity);
    const waterMaterialFor = (submitted: ReturnType<typeof publish>, entity: number) =>
      [...submitted.accepted.frame.renderables, ...submitted.viewFrame.renderables]
        .filter((row) => row.entityKey === entity)
        .flatMap((row) => row.materials)
        .find((material) => material.snapshot.materialHandle === waterMaterialHandle);
    const expectWaterColor = (
      submitted: ReturnType<typeof publish>,
      entity: number,
      expected: readonly [number, number, number],
    ) => {
      const color = waterMaterialFor(submitted, entity)?.snapshot.baseColor;
      expect(color).toBeDefined();
      expected.forEach((value, channel) => {
        expect(color?.[channel]).toBeCloseTo(value, 5);
      });
    };
    for (const entity of ownerEntities) {
      expect(first.upsertEntities).toContain(entity);
      expect(ownerFor(first, entity)?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
      expectWaterColor(first, entity, [0.1, 0.3, 0.9]);
    }

    const waterCandidate = waterMeshCandidateViewsForRenderer(water, viewId)[0];
    if (waterCandidate === undefined) throw new Error('WaterMesh material candidate must exist');
    expect(water.acceptWaterMeshView(zoneGuid, viewId, waterCandidate.publicationGeneration)).toBe(
      true,
    );
    const committedWaterMesh = waterZoneMeshViewForRenderer(water, zoneGuid, viewId);
    const meshOutputGenerations = [bodyGuid, siblingGuid].map(
      (guid) => water.snapshot(guid)?.outputGenerations.waterMesh,
    );
    expect(committedWaterMesh).toBeDefined();

    const firstSource = waterMaterialFor(first, Number(bodyEntity))?.snapshot.sourceAssets;
    if (firstSource === undefined)
      throw new Error('WaterMesh must retain an exact material source');
    expect(firstSource.assets.every((asset) => asset.value === undefined)).toBe(true);
    const quiet = publish((message) => {
      expect(
        receiver.accept({
          ...message,
          side: {
            ...message.side,
            retiredAssetVersions: [{ handle: firstSource.root, revision: firstSource.revision }],
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { detail: { subject: 'missing material source version' } },
      });
    });
    expect(quiet.upsertEntities).toEqual([]);
    expect(quiet.accepted.packet.materials).toEqual([]);
    expect(quiet.accepted.packet.assetVersions).toEqual([]);
    expect(waterMeshCandidateViewsForRenderer(water, viewId)).toEqual([]);
    expect(waterMaterialFor(quiet, Number(bodyEntity))?.snapshot.sourceAssets).toBe(firstSource);
    const textureHandle = (await assets.load(textureGuid, 'texture')).unwrap();
    const samplerHandle = (await assets.load(samplerGuid, 'sampler')).unwrap();
    expect(firstSource.assets.map((asset) => asset.handle).sort((a, b) => a - b)).toEqual(
      [waterMaterialHandle, textureHandle, samplerHandle].sort((a, b) => a - b),
    );
    const fixed = materialSourceScope(first.accepted.resources, firstSource);

    const invalidKind = assets.replace(
      waterMaterialHandle,
      createPrimitiveMesh('cube').unwrap() as never,
    );
    expect(invalidKind).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    const retained = publish();
    expect(retained.upsertEntities).toEqual([]);
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)?.publicationGeneration).toBe(
      committedWaterMesh?.publicationGeneration,
    );

    const parentMaterialHandle = (await assets.load(parentMaterialGuid, 'material')).unwrap();
    const childRevisionBefore = runtimeAssets(assets).version(waterMaterialHandle).unwrap();
    const childContentBefore = assets.read(waterMaterialHandle).unwrap();
    assets.replace(parentMaterialHandle, updatedWaterMaterial).unwrap();
    const childRevisionAfter = runtimeAssets(assets).version(waterMaterialHandle).unwrap();
    expect(childRevisionAfter).toBe(childRevisionBefore);
    expect(assets.read(waterMaterialHandle).unwrap()).toEqual(childContentBefore);
    const parentOnly = publish();
    expect(parentOnly.upsertEntities).toEqual([]);
    expect(waterMaterialFor(parentOnly, Number(bodyEntity))?.snapshot.sourceAssets).toBe(
      firstSource,
    );

    const ordinaryWaterEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: MeshFilter, data: { assetHandle: ordinaryMesh } },
        { component: MeshRenderer, data: { materials: [waterMaterialHandle] } },
      )
      .unwrap();
    const ordinaryAccepted = publish();
    expect(
      waterMaterialFor(ordinaryAccepted, Number(ordinaryWaterEntity))?.snapshot.sourceAssets,
    ).toBe(firstSource);
    const consumers = [...ownerEntities, Number(ordinaryWaterEntity)];
    const childRevision = runtimeAssets(assets).version(waterMaterialHandle).unwrap();
    assets
      .replace(textureHandle, { ...initialTexture, data: new Uint8Array([32, 64, 96, 255]) })
      .unwrap();
    const textureChanged = publish();
    for (const entity of consumers) {
      expect(textureChanged.upsertEntities).toContain(entity);
      const source = waterMaterialFor(textureChanged, entity)?.snapshot.sourceAssets;
      expect(source).not.toBe(firstSource);
      expect(source?.assets.find((asset) => asset.handle === textureHandle)).toMatchObject({
        revision: runtimeAssets(assets).version(textureHandle).unwrap(),
      });
      expect(
        materialSourceScope(textureChanged.accepted.resources, source)
          .resolveAsset(textureHandle)
          .unwrap(),
      ).toMatchObject({
        data: new Uint8Array([32, 64, 96, 255]),
      });
    }
    expect(runtimeAssets(assets).version(waterMaterialHandle).unwrap()).toBe(childRevision);
    expect(fixed.resolveAsset(textureHandle).unwrap()).toMatchObject({
      data: new Uint8Array([255, 255, 255, 255]),
    });
    expect(publish().upsertEntities).toEqual([]);
    assets
      .replace(samplerHandle, { kind: 'sampler', magFilter: 'nearest', minFilter: 'nearest' })
      .unwrap();
    const samplerChanged = publish();
    for (const entity of consumers) {
      expect(samplerChanged.upsertEntities).toContain(entity);
      const source = waterMaterialFor(samplerChanged, entity)?.snapshot.sourceAssets;
      expect(source?.assets.find((asset) => asset.handle === samplerHandle)).toMatchObject({
        revision: runtimeAssets(assets).version(samplerHandle).unwrap(),
      });
      expect(
        materialSourceScope(samplerChanged.accepted.resources, source)
          .resolveAsset(samplerHandle)
          .unwrap(),
      ).toMatchObject({
        magFilter: 'nearest',
        minFilter: 'nearest',
      });
    }
    expect(fixed.resolveAsset(samplerHandle).unwrap()).toMatchObject({ magFilter: 'linear' });
    expect(publish().upsertEntities).toEqual([]);

    assets.replace(waterMaterialHandle, updatedWaterMaterial).unwrap();
    expect(runtimeAssets(assets).version(waterMaterialHandle).unwrap()).toBeGreaterThan(
      childRevisionAfter,
    );
    const changed = publish();
    for (const entity of ownerEntities) {
      expect(changed.upsertEntities).toContain(entity);
      expectWaterColor(changed, entity, [0.9, 0.2, 0.1]);
      expect(ownerFor(changed, entity)?.waterMeshSource?.generation).toBe(
        ownerFor(first, entity)?.waterMeshSource?.generation,
      );
    }
    expect(
      [bodyGuid, siblingGuid].map((guid) => water.snapshot(guid)?.outputGenerations.waterMesh),
    ).toEqual(meshOutputGenerations);
    expect(waterZoneMeshViewForRenderer(water, zoneGuid, viewId)?.publicationGeneration).toBe(
      committedWaterMesh?.publicationGeneration,
    );
    expect(waterMeshCandidateViewsForRenderer(water, viewId)).toEqual([]);

    assets.replace(waterMaterialHandle, Materials.unlit([0.4, 0.7, 0.2, 1])).unwrap();
    const fromSnapshot = MaterialResource.from.bind(MaterialResource);
    const resolutionCause = new Error('water material snapshot rejected');
    const projectionFault = vi.spyOn(MaterialResource, 'from').mockImplementation((snapshot) => {
      if (
        snapshot.materialHandle === waterMaterialHandle &&
        Math.abs((snapshot.baseColor[0] ?? 0) - 0.4) < 1e-5
      )
        throw resolutionCause;
      return fromSnapshot(snapshot);
    });
    try {
      const failed = publish();
      for (const entity of ownerEntities) {
        expect(failed.upsertEntities).toContain(entity);
        expectWaterColor(failed, entity, [0.9, 0.2, 0.1]);
        const source = waterMaterialFor(failed, entity)?.snapshot.sourceAssets;
        const acceptedSource = materialSourceScope(failed.accepted.resources, source);
        expect(acceptedSource.resolveAsset(waterMaterialHandle).unwrap()).toMatchObject({
          values: { baseColor: [0.9, 0.2, 0.1, 1] },
        });
        expect(acceptedSource.resolveAsset(textureHandle).unwrap()).toMatchObject({
          data: new Uint8Array([32, 64, 96, 255]),
        });
        expect(acceptedSource.resolveAsset(samplerHandle).unwrap()).toMatchObject({
          magFilter: 'nearest',
          minFilter: 'nearest',
        });
      }
      expect(failed.accepted.resources.resolveAsset(textureHandle).ok).toBe(false);
      expect(routedErrors).toContainEqual(
        expect.objectContaining({
          code: 'material-resolution-failed',
          detail: expect.objectContaining({
            reason: 'material-resolution-failed',
            owner: 'material',
            actual: materialGuid,
            cause: resolutionCause,
          }),
        }),
      );
      expect(
        [bodyGuid, siblingGuid].map((guid) => water.snapshot(guid)?.outputGenerations.waterMesh),
      ).toEqual(meshOutputGenerations);
    } finally {
      projectionFault.mockRestore();
    }
    const retried = publish();
    for (const entity of consumers) expectWaterColor(retried, entity, [0.4, 0.7, 0.2]);
    expect(publish().upsertEntities).toEqual([]);
    expect(
      [bodyGuid, siblingGuid].map((guid) => water.snapshot(guid)?.outputGenerations.waterMesh),
    ).toEqual(meshOutputGenerations);
  } finally {
    errorLog.mockRestore();
    scene.dispose();
    receiver.dispose();
    publisher.dispose();
    materialDecoder.dispose();
    textureDecoder.dispose();
    samplerDecoder.dispose();
    assets.dispose();
  }
});
