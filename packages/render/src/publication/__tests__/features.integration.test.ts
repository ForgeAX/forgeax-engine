import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { MeshFilter, MeshRenderer } from '../../components';
import { createFullscreenRenderFeature } from '../../features/fullscreen';
import type { RenderFeature } from '../../features/types';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it('admits feature references only for the current owner borrow and canonical handle', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const handle = assets.create(BUILTIN_CUBE).unwrap();
  const mesh = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
  let captured = mesh;
  const feature: RenderFeature<{ handle: number | undefined }> = {
    identity: 'captured-mesh',
    extract: (context) => {
      const reference = context.referenceAsset;
      if (reference === undefined) throw new Error('Expected publication admission');
      expect(reference(1, handle, captured)).toBeUndefined();
      expect(reference(0, 'missing-mesh', captured)).toBeUndefined();
      expect(reference(0, handle, { ...captured })).toBeUndefined();
      return ok({ handle: reference(0, handle, captured) });
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
    assets.replace(handle, { ...BUILTIN_CUBE, materialSlots: [{ slotName: 'changed' }] }).unwrap();
    captured = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
    expect(captured.materialSlots).toEqual([{ slotName: 'changed' }]);
    expect(prepare()).toEqual({ handle });
    assets.replace(handle, BUILTIN_CUBE).unwrap();
    captured = runtimeAssets(world.assets).resolveAsset<MeshAsset>(handle).unwrap();
    expect(prepare()).toEqual({ handle });
  } finally {
    publisher.dispose();
  }
});

it('acknowledges only submitted source data, rejecting stale and duplicate receipts atomically', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
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
    transfer: renderPublicationTransfers(candidate.message),
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
  publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(packet))).unwrap();
  const next = publisher.prepare(1).unwrap();
  next.discard();
  expect(consumed).toHaveLength(1);
  publisher.dispose();
});

it('publishes feature-only GUID resources and retires them when the producer drops the root', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = BUILTIN_CUBE;
  publishRuntimeAssets(assets, [{ guid, asset: mesh }]);
  const loaded = (await assets.load(guid, 'mesh')).unwrap();
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
  const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toEqual(
    runtimeAssets(assets).resolveAsset(loaded).unwrap(),
  );
  expect(packet.assets.filter((row) => row.guid === guid)).toHaveLength(1);
  publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(packet))).unwrap();
  roots = [];
  const next = publisher.prepare(1).unwrap();
  expect(next.packet.retiredAssets).toContain(accepted.resources.handleForGuid(guid));
  receiver.accept(next.message).unwrap();
  expect(accepted.resources.lookupAsset(guid)).toBeUndefined();
  next.discard();
  publisher.dispose();
});

it('publishes LOD GUID dependencies and rejects a missing lower-detail asset before acceptance', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const guid = '12345678-1234-1234-1234-123456789abc';
  const mesh = BUILTIN_CUBE;
  publishRuntimeAssets(assets, [{ guid, asset: mesh }]);
  (await assets.load(guid, 'mesh')).unwrap();
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) throw parsed.error;
  const assetHandle = assets
    .create({
      ...mesh,
      lods: [{ mesh: parsed.value, screenCoverage: 0.5 }],
    })
    .unwrap();
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
  expect(receiver.accept(encodeRenderPublication(missing)).ok).toBe(false);
  expect(receiver.acceptedRevision).toBe(0);
  expect(receiver.accept(encodeRenderPublication(structuredClone(candidate.packet))).ok).toBe(true);
  candidate.discard();
  publisher.dispose();
});

it('keeps two sealed publications and their feedback independent of later source mutation', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
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
      transfer: renderPublicationTransfers(candidate.message),
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
    expect(
      publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(second))).ok,
    ).toBe(false);
    publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).unwrap();
    publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(first))).unwrap();
    expect(
      publisher.acknowledgeFeatures(1, [{ identity: feature.identity, feedback: null }]).ok,
    ).toBe(false);
    publisher.acknowledgeFeatures(2, [{ identity: feature.identity, feedback: null }]).unwrap();
    expect(consumed).toEqual([{ value: 1 }, { value: 2 }]);
    publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(second))).unwrap();
    const third = seal();
    expect(third.base).toBe(2);
    expect(third.features[0]?.data).toEqual({ value: 99 });
  } finally {
    publisher.dispose();
  }
});

it('publishes a late fullscreen declaration once and retains only per-frame enable data', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
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
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
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
