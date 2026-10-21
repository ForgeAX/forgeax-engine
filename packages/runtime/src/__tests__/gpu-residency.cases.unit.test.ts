import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { worldRenderResources } from '../../../render/src/publication/resource-scope';

it('reuses mesh residency without allocating or uploading again and reports a missing device', async () => {
  const assets = new AssetRegistry();
  const handle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const mesh = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
  const store = new GpuResidencyCache();
  expect(store.ensureResident(handle, mesh)).toMatchObject({
    ok: false,
    error: { code: 'rhi-not-available' },
  });
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  store.configureGpuDevice(device, undefined, device.caps);
  const create = vi.spyOn(device, 'createBuffer');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    const first = store.ensureResident(handle, mesh).unwrap();
    expect(create).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.ensureResident(handle, mesh).unwrap()).toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('keeps replacement texture identities independent when a retired asset is evicted again', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const store = new GpuResidencyCache();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  store.configureGpuDevice(device, undefined, device.caps);
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array([255, 255, 255, 255]),
  };
  try {
    const previous = assets.create(texture).unwrap();
    const first = store
      .ensureResident(
        previous,
        runtimeAssets(assets).borrow<TextureAsset>(previous).unwrap(),
        scope,
      )
      .unwrap();
    assets.release(previous).unwrap();
    const next = assets.create(texture).unwrap();
    expect(next).not.toBe(previous);
    expect(assets.validate(previous).ok).toBe(false);
    expect(store.getTextureGpuView(next, scope)).toBeUndefined();
    const replacement = store
      .ensureResident(next, runtimeAssets(assets).borrow<TextureAsset>(next).unwrap(), scope)
      .unwrap();
    expect(replacement.view).not.toBe(first.view);
    expect(store.evictTexture(previous, scope).freed).toBe(1);
    expect(first.texture.isDestroyed).toBe(true);
    expect(store.evictTexture(previous, scope).freed).toBe(0);
    expect(store.getTextureGpuView(next, scope)).toBe(replacement.view);
    expect(replacement.texture.isDestroyed).toBe(false);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('retires old mesh buffers without retiring a newly admitted asset identity', async () => {
  const assets = new AssetRegistry();
  const scope = worldRenderResources(new World({ assets }));
  const store = new GpuResidencyCache();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  store.configureGpuDevice(device, undefined, device.caps);
  try {
    const previous = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const first = store
      .ensureResident(previous, runtimeAssets(assets).borrow<MeshAsset>(previous).unwrap(), scope)
      .unwrap();
    assets.release(previous).unwrap();
    const next = assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();
    expect(next).not.toBe(previous);
    expect(assets.validate(previous).ok).toBe(false);
    expect(store.getMeshGpuHandles(next, scope)).toBeUndefined();
    const replacement = store
      .ensureResident(next, runtimeAssets(assets).borrow<MeshAsset>(next).unwrap(), scope)
      .unwrap();
    expect(replacement.vertexBuffer).not.toBe(first.vertexBuffer);
    expect(store.evictMesh(previous, scope).freed).toBe(2);
    expect(first.vertexBuffer.isDestroyed).toBe(true);
    expect(first.indexBuffer?.isDestroyed).toBe(true);
    expect(store.evictMesh(previous, scope).freed).toBe(0);
    expect(store.getMeshGpuHandles(next, scope)).toBe(replacement);
    expect(replacement.vertexBuffer.isDestroyed).toBe(false);
    expect(replacement.indexBuffer?.isDestroyed).toBe(false);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});
