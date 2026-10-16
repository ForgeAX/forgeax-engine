import {
  AssetRegistry,
  HANDLE_CUBE,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type Handle, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { createFullscreenRenderFeature } from '../../features/fullscreen';
import type { RenderFeature } from '../../features/types';
import { internSharedRefFromGuid } from '../../render-system-extract';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

it('admits feature references only for the exact current World projection and canonical GUID handle', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = assets
    .catalog(guid, resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap())
    .unwrap();
  const handle = internSharedRefFromGuid(world, assets, guid, 'MeshAsset');
  if (handle === undefined) throw new Error('Expected the canonical mesh handle');
  let captured = mesh;
  const feature: RenderFeature<{ handle: Handle<string, 'shared'> | undefined }> = {
    identity: 'captured-mesh',
    extract: (context) => {
      const reference = context.referenceAsset;
      if (reference === undefined) throw new Error('Expected publication admission');
      expect(reference(1, guid, captured)).toBeUndefined();
      expect(reference(0, 'missing-mesh', captured)).toBeUndefined();
      expect(reference(0, guid, { ...captured })).toBeUndefined();
      return ok({ handle: reference(0, guid, captured) });
    },
    assetDependencies: (data) => (data.handle === undefined ? [] : [data.handle]),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'admission', epoch: 1 },
    undefined,
    [feature],
  );
  const prepare = () => {
    const candidate = publisher.prepare(0).unwrap();
    const data = candidate.packet.features[0]?.data;
    candidate.discard();
    return data;
  };
  try {
    expect(prepare()).toEqual({ handle });
    const vertices = new Float32Array(mesh.vertices);
    vertices[0] = Number(vertices[0]) + 0.25;
    const content = world
      .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices } })
      .unwrap();
    world.update(0).unwrap();
    expect(prepare()).toEqual({ handle: undefined });
    captured = resolveAssetHandle<MeshAsset>(world, handle).unwrap();
    expect(captured).not.toBe(mesh);
    expect(prepare()).toEqual({ handle });
    world.despawn(content).unwrap();
    world.update(0).unwrap();
    expect(prepare()).toEqual({ handle: undefined });
    captured = mesh;
    expect(prepare()).toEqual({ handle });
  } finally {
    publisher.dispose();
  }
});

it('acknowledges only submitted source data, rejecting stale and duplicate receipts atomically', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const consumed: unknown[] = [];
  let value = 1;
  const feature: RenderFeature<unknown> = {
    identity: 'source-events',
    extract: () => ok({ value }),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onSourceFrameSubmitted: (data, feedback) => consumed.push({ data, feedback }),
  };
  const publisher = createRenderPublisher(world, assets, { source: 'ack', epoch: 1 }, undefined, [
    feature,
  ]);
  const candidate = publisher.prepare(0).unwrap();
  const packet = structuredClone(candidate.packet, {
    transfer: renderPublicationTransfers(candidate.packet),
  });
  candidate.accept();
  value = 2;
  expect(consumed).toEqual([]);
  expect(publisher.acknowledgeFeatures(0, [{ identity: feature.identity, feedback: 1 }]).ok).toBe(
    false,
  );
  expect(
    publisher.acknowledgeFeatures(1, [
      { identity: feature.identity, feedback: 1 },
      { identity: 'unknown', feedback: 1 },
    ]).ok,
  ).toBe(false);
  expect(consumed).toEqual([]);
  publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: 1 }]).unwrap();
  expect(consumed).toEqual([{ data: { value: 1 }, feedback: 1 }]);
  expect(publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: 1 }]).ok).toBe(
    false,
  );
  publisher.recycle(1, renderPublicationTransfers(packet)).unwrap();
  const next = publisher.prepare(1).unwrap();
  next.discard();
  expect(consumed).toHaveLength(1);
  publisher.dispose();
});

it('publishes feature-only GUID resources and retires them when the producer drops the root', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap();
  assets.catalog(guid, mesh);
  let roots = [guid];
  const feature: RenderFeature<unknown> = {
    identity: 'guid-consumer',
    extract: () => ok({}),
    assetDependencies: () => roots,
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const identity = { source: 'feature-assets', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  const first = publisher.prepare(0).unwrap();
  const packet = structuredClone(first.packet);
  first.accept();
  const accepted = receiver.accept(packet).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toEqual(mesh);
  expect(packet.assets.filter((row) => row.guid === guid)).toHaveLength(1);
  publisher.recycle(1, renderPublicationTransfers(packet)).unwrap();
  roots = [];
  const next = publisher.prepare(1).unwrap();
  expect(next.packet.retiredAssets).toContain(accepted.resources.handleForGuid(guid));
  receiver.accept(next.packet).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toBeUndefined();
  next.discard();
  publisher.dispose();
});

it('publishes LOD GUID dependencies and rejects a missing lower-detail asset before acceptance', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap();
  assets.catalog(guid, mesh);
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) throw parsed.error;
  const assetHandle = world.allocSharedRef('MeshAsset', {
    ...mesh,
    lods: [{ mesh: parsed.value, screenCoverage: 0.5 }],
  });
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const identity = { source: 'lod-assets', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const candidate = publisher.prepare(0).unwrap();
  expect(candidate.packet.assets.some((row) => row.guid === guid)).toBe(true);
  const missing = {
    ...candidate.packet,
    assets: candidate.packet.assets.filter((row) => row.guid !== guid),
  };
  expect(receiver.accept(missing).ok).toBe(false);
  expect(receiver.acceptedRevision).toBe(0);
  expect(receiver.accept(structuredClone(candidate.packet)).ok).toBe(true);
  candidate.discard();
  publisher.dispose();
});

it('keeps two sealed publications and their feedback independent of later source mutation', async () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  let value = 1;
  const consumed: unknown[] = [];
  const feature: RenderFeature<unknown> = {
    identity: 'sealed-events',
    extract: () => ok({ value }),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onSourceFrameSubmitted: (data) => consumed.push(data),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'sealed', epoch: 1 },
    undefined,
    [feature],
  );
  const seal = () => {
    const candidate = publisher.prepare(value).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    return packet;
  };
  try {
    const first = seal();
    value = 2;
    const second = seal();
    await Promise.resolve();
    value = 99;
    expect(second.features[0]?.data).toEqual({ value: 2 });
    expect(publisher.prepare(3).ok).toBe(false);
    expect(publisher.recycle(2, renderPublicationTransfers(second)).ok).toBe(false);
    publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).unwrap();
    publisher.recycle(1, renderPublicationTransfers(first)).unwrap();
    expect(
      publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).ok,
    ).toBe(false);
    publisher.acknowledgeFeatures(2, [{ identity: feature.identity, feedback: null }]).unwrap();
    expect(consumed).toEqual([{ value: 1 }, { value: 2 }]);
    publisher.recycle(2, renderPublicationTransfers(second)).unwrap();
    const third = seal();
    expect(third.base).toBe(2);
    expect(third.features[0]?.data).toEqual({ value: 99 });
  } finally {
    publisher.dispose();
  }
});

it('publishes a late fullscreen declaration once and retains only per-frame enable data', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  let enabled = false;
  const features: RenderFeature<unknown>[] = [];
  const feature = createFullscreenRenderFeature({
    identity: 'game::late-fullscreen',
    source: 'fn fs_main() {}',
    enabled: () => enabled,
  });
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'fullscreen', epoch: 1 },
    undefined,
    features,
  );
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return packet;
  };
  try {
    expect(seal().features).toEqual([]);
    features.push(feature);
    const discarded = publisher.prepare(0).unwrap();
    expect(discarded.packet.features[0]).toHaveProperty('fullscreen');
    discarded.discard();
    const first = seal().features[0];
    expect(first).toMatchObject({
      identity: feature.identity,
      data: false,
      fullscreen: { identity: feature.identity },
    });
    enabled = true;
    expect(seal().features).toEqual([{ identity: feature.identity, data: true }]);
    features.pop();
    expect(seal().features).toEqual([]);
    features.push(feature);
    expect(seal().features).toEqual([{ identity: feature.identity, data: true }]);
  } finally {
    publisher.dispose();
  }
});
