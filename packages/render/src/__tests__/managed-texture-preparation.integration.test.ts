import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

it.each([
  'replace',
  'invalidate',
  'device',
  'range',
] as const)('retires a texture upload superseded by %s during asynchronous mip preparation', async (action) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.configureGpuDevice(
    device,
    async (owner, descriptor) => {
      expect(owner).toBe(device);
      const module = await rhi.createShaderModule(device, descriptor);
      await completed;
      return module;
    },
    device.caps,
  );
  const assets = new AssetRegistry();
  const source: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    mips: { kind: 'generate' },
    data: new Uint8Array(64),
  };
  const handle = assets.create(source).unwrap();
  if (action === 'range') store.ensureResident(handle, source).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  const pending = store.uploadTexture(handle, source);
  const allocated = create.mock.results[0]?.value.unwrap();
  assert(allocated);
  let replacement: ReturnType<GpuResidencyCache['getTextureGpuView']>;
  try {
    if (action === 'replace' || action === 'range') {
      if (action === 'replace')
        store.ensureResident(handle, { ...source, mips: { kind: 'none' as const } }).unwrap();
      replacement = store.getTextureGpuView(handle);
      if (action === 'range') {
        const observer = assets.observe().unwrap();
        assets
          .writeRange(handle, {
            origin: { x: 0, y: 0 },
            size: { width: 1, height: 1 },
            data: new Uint8Array(4).fill(255),
          })
          .unwrap();
        const change = observer.read().unwrap().changes[0];
        assert(change);
        store
          .adoptTextureChange(change, runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap())
          .unwrap();
        observer.dispose();
      }
    } else if (action === 'invalidate') store.invalidateTexture(handle);
    else {
      const next = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      store.configureGpuDevice(next, undefined, next.caps);
    }
    finish();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
    expect(store.getTextureGpuView(handle)).toBe(replacement);
    expect(destroy).toHaveBeenCalledWith(allocated);
    const mips = store.prepareTextureMips().unwrap();
    expect(mips !== undefined).toBe(action === 'range');
    mips?.complete(true);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    finish();
    await pending;
    store.destroyAll();
    assets.dispose();
  }
});

it('keeps one pending allocation and shares one mip pipeline while repeated uploads are coalesced', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shader = vi.fn(async (owner, descriptor) => {
    await gate;
    return rhi.createShaderModule(owner, descriptor);
  });
  store.configureGpuDevice(device, shader, device.caps);
  const assets = new AssetRegistry();
  const source: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    mips: { kind: 'generate' },
    data: new Uint8Array(64),
  };
  const handle = assets.create(source).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  const pending = Array.from({ length: 32 }, () => store.uploadTexture(handle, source));
  try {
    expect(create).toHaveBeenCalledTimes(32);
    expect(destroy).toHaveBeenCalledTimes(31);
    expect(shader).toHaveBeenCalledTimes(1);
    finish();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.at(-1)?.ok).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(31);
  } finally {
    finish();
    await Promise.all(pending);
    store.destroyAll();
    assets.dispose();
  }
});
