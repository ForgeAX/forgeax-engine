import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { rhi } from '@forgeax/engine-rhi-null';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';

it('packs only the changed texture columns for upload and preserves a fixed candidate', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1024, height: 4 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(1024 * 4 * 4),
    })
    .unwrap();
  const current = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  const original = store.ensureResident(handle, current()).unwrap();
  const observer = assets.observe().unwrap();
  const write = vi.spyOn(device.queue, 'writeTexture');
  const create = vi.spyOn(device, 'createTexture');
  const edit = (value: number) => {
    assets
      .writeRange(handle, {
        origin: { x: 510, y: 1 },
        size: { width: 2, height: 2 },
        data: new Uint8Array(16).fill(value),
      })
      .unwrap();
    const batch = observer.read().unwrap(),
      change = batch.changes[0];
    assert(change);
    store.adoptTextureChange(change, current()).unwrap();
    batch.accept();
  };
  try {
    edit(127);
    const next = store.ensureResident(handle, current()).unwrap();
    expect(next.texture).toBe(original.texture);
    expect(create).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    assert(call);
    expect(call[0].origin).toEqual({ x: 510, y: 1, z: 0 });
    expect(call[1]).toEqual(new Uint8Array(16).fill(127));
    expect(call[2]).toMatchObject({ bytesPerRow: 8, rowsPerImage: 2 });
    expect(call[3]).toEqual({ width: 2, height: 2, depthOrArrayLayers: 1 });
    const lease = store.retainTextureResidency(handle);
    assert(lease);
    edit(255);
    const replacement = store.ensureResident(handle, current()).unwrap();
    expect(replacement.texture).not.toBe(original.texture);
    expect(original.texture.isDestroyed).toBe(false);
    await lease.release(false);
    expect(original.texture.isDestroyed).toBe(true);
  } finally {
    observer.dispose();
    store.destroyAll();
    assets.dispose();
  }
});

it('recreates a changed managed sampler without changing the bound asset reference', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const handle = assets.create({ kind: 'sampler', minFilter: 'nearest' }).unwrap();
  const current = () => runtimeAssets(assets).borrow<SamplerAsset>(handle).unwrap();
  const first = store.ensureSamplerResident(handle, current()).unwrap();
  const observer = assets.observe().unwrap();
  assets.update(handle, { minFilter: 'linear' }).unwrap();
  const change = observer.read().unwrap().changes[0];
  assert(change);
  store.invalidateSampler(change.handle);
  const next = store.ensureSamplerResident(handle, current()).unwrap();
  expect(next).not.toBe(first);
  expect(store.ensureSamplerResident(handle, current()).unwrap()).toBe(next);
  observer.dispose();
  store.destroyAll();
  assets.dispose();
});
