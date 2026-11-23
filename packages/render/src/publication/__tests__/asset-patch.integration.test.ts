import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { createPublishedMeshResidencyHost } from '../../assembly/published-mesh-residency';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { PersistentRenderScene } from '../../scene/render-scene';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1024, height: 32 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(1024 * 32 * 4),
    })
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1, 1], roughness: 0.5, baseColorTexture: { texture } },
    } as const)
    .unwrap();
  const identity = { source: 'asset-patches', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  for (let i = 0; i < 128; i++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  world.update(0).unwrap();
  const transfer = () => {
    const candidate = publisher.prepare(0).unwrap();
    const assetBuffers = renderPublicationAssetTransfers(candidate.message);
    const bytes = assetBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const packet = structuredClone(candidate.packet, {
      transfer: [...renderPublicationTransfers(candidate.message), ...assetBuffers],
    });
    candidate.accept();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return { packet, bytes };
  };
  const initial = transfer();
  const accepted = receiver.accept(encodeRenderPublication(initial.packet)).unwrap();
  const close = () => {
    publisher.dispose();
    receiver.dispose();
    assets.dispose();
  };
  return { assets, world, mesh, texture, identity, receiver, publisher, transfer, accepted, close };
}

it('delivers published asset changes to every retained scene without publishing their users', () => {
  const f = fixture();
  const observers = [vi.fn(), vi.fn()];
  const scenes = observers.map(
    (onAssetChange) => new PersistentRenderScene({ assets: f.assets, onAssetChange }),
  );
  try {
    for (const scene of scenes) scene.consumePublication(f.accepted);
    for (const observer of observers) observer.mockClear();
    f.assets
      .writeRange(f.texture, {
        origin: { x: 510, y: 10 },
        size: { width: 2, height: 2 },
        data: new Uint8Array(16).fill(127),
      })
      .unwrap();
    const { packet } = f.transfer();
    expect(packet.upserts).toHaveLength(0);
    expect(packet.templates).toHaveLength(0);
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    for (const scene of scenes) scene.consumePublication(accepted);
    for (const observer of observers) {
      expect(observer).toHaveBeenCalledExactlyOnceWith(
        accepted.resources,
        expect.objectContaining({ handle: f.texture, removed: false }),
      );
    }
    const unchanged = f.receiver.accept(encodeRenderPublication(f.transfer().packet)).unwrap();
    for (const scene of scenes) scene.consumePublication(unchanged);
    for (const observer of observers) expect(observer).toHaveBeenCalledTimes(1);
  } finally {
    for (const scene of scenes) scene.dispose();
    f.close();
  }
});

it('transfers only mesh channel and texture region bytes without publishing their users', () => {
  const f = fixture();
  try {
    const beforeMesh = f.accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap();
    const beforeTexture = f.accepted.resources.resolveAsset<TextureAsset>(f.texture).unwrap();
    f.assets
      .writeRange(f.mesh, {
        attribute: 'position',
        first: 0,
        values: new Float32Array([0.125, 0.25, 0.375]),
      })
      .unwrap();
    f.assets
      .writeRange(f.texture, {
        origin: { x: 510, y: 10 },
        size: { width: 2, height: 2 },
        data: new Uint8Array(16).fill(127),
      })
      .unwrap();
    const discarded = f.publisher.prepare(0).unwrap();
    expect(discarded.packet.assetPatches).toHaveLength(2);
    discarded.discard();
    const { packet, bytes } = f.transfer();
    expect(packet.assets).toHaveLength(0);
    expect(packet.upserts).toHaveLength(0);
    expect(packet.templates).toHaveLength(0);
    // One position range and one texture region; no duplicate CPU channel.
    expect(bytes).toBe(12 + 16);
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    const mesh = accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap();
    const texture = accepted.resources.resolveAsset<TextureAsset>(f.texture).unwrap();
    expect(mesh.vertices.buffer).toBe(beforeMesh.vertices.buffer);
    expect(texture.data.buffer).toBe(beforeTexture.data.buffer);
    expect([...mesh.vertices.subarray(0, 3)]).toEqual([0.125, 0.25, 0.375]);
    expect([...texture.data.subarray((10 * 1024 + 510) * 4, (10 * 1024 + 512) * 4)]).toEqual(
      new Array(8).fill(127),
    );
    expect(texture.data[(10 * 1024 + 512) * 4]).toBe(0);
    expect(
      accepted.assetChanges.find((change) => change.handle === f.texture)?.ranges[0],
    ).toMatchObject({ rowBytes: 8, byteStride: 4096 });
    f.assets
      .writeRange(f.texture, {
        origin: { x: 510, y: 10 },
        size: { width: 2, height: 2 },
        data: new Uint8Array(16).fill(255),
      })
      .unwrap();
    expect(texture.data[(10 * 1024 + 510) * 4]).toBe(127);
  } finally {
    f.close();
  }
});

it('publishes a multi-range mesh write as one patch with changed bytes only', () => {
  const f = fixture();
  try {
    const source = runtimeAssets(f.assets).borrow<MeshAsset>(f.mesh).unwrap();
    const stride = deriveVertexLayoutProjection(source.attributes).arrayStride;
    const rows = source.vertices.slice(0, (2 * stride) / 4);
    const indices =
      source.indices instanceof Uint16Array ? Uint16Array.of(0, 0, 0) : Uint32Array.of(0, 0, 0);
    f.assets
      .writeRange(f.mesh, [
        { first: 2, vertices: rows },
        { first: 3, indices },
      ])
      .unwrap();
    const { packet } = f.transfer();
    expect(packet.assets).toHaveLength(0);
    expect(packet.upserts).toHaveLength(0);
    expect(packet.assetPatches).toHaveLength(1);
    const patch = packet.assetPatches[0];
    assert(patch);
    const patchBytes = patch.ranges.reduce((sum, range) => sum + range.bytes.byteLength, 0);
    // Interleaved rows once and three indices; channels remain derived views.
    expect(patchBytes).toBe(2 * stride + 3 * indices.BYTES_PER_ELEMENT);
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    const mesh = accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap();
    expect([...mesh.vertices.subarray((2 * stride) / 4, (4 * stride) / 4)]).toEqual([...rows]);
    assert(mesh.indices);
    expect([...mesh.indices.subarray(3, 6)]).toEqual([0, 0, 0]);
  } finally {
    f.close();
  }
});

it('rejects a late invalid range atomically and keeps fixed preparation bytes through a valid update', () => {
  const f = fixture();
  try {
    const before = f.accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap();
    const original = before.vertices.slice();
    const candidate = f.receiver
      .prepareMesh({
        ...f.identity,
        meshHandle: f.mesh,
        revision: runtimeAssets(f.assets).version(f.mesh).unwrap(),
        mesh: before,
      })
      .unwrap();
    f.assets
      .writeRange(f.mesh, {
        attribute: 'position',
        first: 0,
        values: new Float32Array([0.125, 0.25, 0.375]),
      })
      .unwrap();
    const { packet } = f.transfer();
    const bad = structuredClone(packet);
    const patch = bad.assetPatches[0];
    assert(patch);
    const last = patch.ranges[patch.ranges.length - 1];
    assert(last);
    Object.assign(last, { byteOffset: Number.MAX_SAFE_INTEGER });
    expect(f.receiver.accept(encodeRenderPublication(bad)).ok).toBe(false);
    expect(before.vertices).toEqual(original);
    expect(candidate.isCurrent()).toBe(true);
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    expect(candidate.isCurrent()).toBe(false);
    expect(candidate.mesh.vertices).toEqual(original);
    const current = accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap();
    expect(current.vertices.buffer).not.toBe(before.vertices.buffer);
    expect(current.vertices.subarray(0, 3)).toEqual(new Float32Array([0.125, 0.25, 0.375]));
    candidate.release();
  } finally {
    f.close();
  }
});

it('prepares a future mesh revision without changing the drawn allocation, then adopts the matching patch', async () => {
  const f = fixture();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const old = store
    .ensureResident(
      f.mesh,
      f.accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap(),
      f.accepted.resources,
    )
    .unwrap();
  const oldLease = store.retainMeshResidency(f.mesh, f.accepted.resources);
  assert(oldLease);
  const prepare = createPublishedMeshResidencyHost({
    receiver: f.receiver,
    getGpuStore: () => store,
    currentGeneration: () => 1,
    completeUploads: () => device.queue.onSubmittedWorkDone(),
    isCurrentFrame: () => true,
    recordStageLane: () => undefined,
  });
  try {
    f.assets
      .writeRange(f.mesh, {
        attribute: 'position',
        first: 0,
        values: Float32Array.of(0.125, 0.25, 0.375),
      })
      .unwrap();
    const input = {
      ...f.identity,
      meshHandle: f.mesh,
      revision: runtimeAssets(f.assets).version(f.mesh).unwrap(),
      mesh: f.assets.read(f.mesh).unwrap(),
    };
    const candidate = (await prepare(input)).unwrap();
    expect(candidate.isCurrent()).toBe(true);
    expect(store.getMeshGpuHandles(f.mesh, f.accepted.resources)).toBe(old);
    const { packet } = f.transfer();
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    const next = store.getMeshGpuHandles(f.mesh, accepted.resources);
    assert(next);
    expect(next).not.toBe(old);
    expect(old.vertexBuffer.isDestroyed).toBe(false);
    for (const change of accepted.assetChanges)
      store
        .adoptMeshChange(
          change,
          accepted.resources.resolveAsset<MeshAsset>(f.mesh).unwrap(),
          accepted.resources,
        )
        .unwrap();
    expect(store.getMeshGpuHandles(f.mesh, accepted.resources)).toBe(next);
    expect(candidate.isCurrent()).toBe(true);
    await candidate.release(false);
    await oldLease.release(false);
    expect(old.vertexBuffer.isDestroyed).toBe(true);
    expect(next.vertexBuffer.isDestroyed).toBe(false);
    expect(f.receiver.prepareMesh({ ...input, revision: input.revision - 1 }).ok).toBe(false);
  } finally {
    await oldLease.release(false);
    store.destroyAll();
    f.close();
  }
});

it('retains a cold Level Mesh once and adopts the exact payload into the ordinary namespace', () => {
  const f = fixture();
  try {
    const mesh = f.assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();
    const revision = runtimeAssets(f.assets).version(mesh).unwrap();
    const received = structuredClone(f.assets.read(mesh).unwrap());
    const transferred = structuredClone(received, {
      transfer: [received.vertices.buffer as ArrayBuffer],
    });
    expect(received.vertices.byteLength).toBe(0);
    const asset = { handle: mesh, revision, value: transferred };
    expect(f.receiver.retainClosedLevelAsset({ ...f.identity, epoch: 2 }, asset).ok).toBe(false);
    const level = f.receiver.retainClosedLevelAsset(f.identity, asset).unwrap();
    const shared = f.receiver.retainClosedLevelAsset(f.identity, structuredClone(asset)).unwrap();
    const conflicting = structuredClone(asset);
    conflicting.value.vertices[0] = 42;
    const invalid = f.receiver.retainClosedLevelAsset(f.identity, conflicting);
    expect(invalid).toMatchObject({ ok: false, error: { detail: { reason: 'shape' } } });
    expect(shared.value).toBe(level.value);
    const prepared = f.receiver
      .prepareMesh({
        ...f.identity,
        meshHandle: mesh,
        revision,
        mesh: structuredClone(transferred),
      })
      .unwrap();
    expect(prepared.mesh).toBe(level.value);
    prepared.release();
    expect(f.accepted.resources.resolveAsset(mesh, revision).unwrap()).toBe(level.value);
    expect(f.accepted.resources.resolveAsset(mesh).unwrap()).toBe(level.value);
    expect(f.receiver.acceptedRevision).toBe(f.accepted.packet.revision);
    expect(f.accepted.frame.renderables.some((row) => row.assetHandle === mesh)).toBe(false);
    level.release();
    expect(level.isCurrent()).toBe(false);
    expect(shared.isCurrent()).toBe(true);
    const consumer = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    f.world.update(0).unwrap();
    const packet = f.transfer().packet;
    expect(packet.assets.some((row) => row.handle === mesh)).toBe(true);
    const accepted = f.receiver.accept(encodeRenderPublication(packet)).unwrap();
    expect(accepted.scene.rows.lookup(consumer)?.snapshot.assetHandle).toBe(mesh);
    expect(accepted.resources.resolveAsset(mesh).unwrap()).toBe(shared.value);
    shared.release();
    expect(accepted.resources.resolveAsset(mesh).unwrap()).toBe(shared.value);
  } finally {
    f.close();
  }
});

it('resolves cold Level GPU generation dependencies by GUID until the last hold retires', () => {
  const f = fixture();
  try {
    const guid = '38490823-ce4b-5d26-83f6-cde7e9c5f676';
    const row = { handle: 1000, revision: 1, guid, value: { kind: 'sampler' } as const };
    const first = f.receiver.retainClosedLevelAsset(f.identity, row).unwrap();
    const second = f.receiver
      .retainClosedLevelAsset(f.identity, { handle: row.handle, revision: 1 })
      .unwrap();
    expect(f.accepted.resources.handleForGuid(guid)).toBe(row.handle);
    expect(f.accepted.resources.lookupAsset(guid)).toBe(first.value);
    expect(f.receiver.referencesAcceptedAsset(row.handle)).toBe(false);
    expect(f.receiver.retainClosedLevelAsset(f.identity, { ...row, handle: 1001 }).ok).toBe(false);
    first.release();
    expect(f.accepted.resources.lookupAsset(guid)).toBe(second.value);
    second.release();
    expect(f.accepted.resources.lookupAsset(guid)).toBeUndefined();
  } finally {
    f.close();
  }
});

it('keeps held Level texels fixed while an ordinary frame installs a newer region', () => {
  const f = fixture();
  try {
    const revision = runtimeAssets(f.assets).version(f.texture).unwrap();
    const asset = {
      handle: f.texture,
      revision,
      value: structuredClone(f.assets.read(f.texture).unwrap()),
    };
    const held = f.receiver.retainClosedLevelAsset(f.identity, asset).unwrap();
    const old = f.accepted.resources.resolveAsset<TextureAsset>(f.texture).unwrap();
    expect(old).toBe(held.value);
    expect(held.isCurrent()).toBe(true);
    f.assets
      .writeRange(f.texture, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: Uint8Array.of(21, 23, 25, 27),
      })
      .unwrap();
    const frame = f.receiver.accept(encodeRenderPublication(f.transfer().packet)).unwrap();
    const latest = frame.resources.resolveAsset<TextureAsset>(f.texture).unwrap();
    expect([...latest.data.subarray(0, 4)]).toEqual([21, 23, 25, 27]);
    expect([...old.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(frame.resources.resolveAsset(f.texture, revision).unwrap()).toBe(old);
    expect(held.isCurrent()).toBe(false);
    held.release();
    expect(frame.resources.resolveAsset(f.texture, revision).ok).toBe(false);
    expect(frame.resources.resolveAsset(f.texture).unwrap()).toBe(latest);
  } finally {
    f.close();
  }
});
