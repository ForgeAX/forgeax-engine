import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { TranscodeModel } from '@forgeax/engine-codec';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { encodedTexture } from './managed-basis-texture-fixture';

it.each([
  [{ bc: false, astc: false, etc2: false }, 'rgba8unorm', 1364],
  [{ bc: true, astc: false, etc2: false }, 'bc7-rgba-unorm', 368],
  [{ bc: false, astc: true, etc2: false }, 'astc-4x4-unorm', 368],
  [{ bc: false, astc: false, etc2: true }, 'etc2-rgba8unorm', 368],
  [{ bc: true, astc: true, etc2: true }, 'bc7-rgba-unorm', 368],
] as const)('derives the supported GPU format from one immutable source: %s', async (caps, format, bytes) => {
  expectTypeOf<TranscodeModel>().toEqualTypeOf<'etc1s' | 'uastc-ldr' | 'uastc-hdr'>();
  const source = await encodedTexture();
  const original = source.data.slice();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, {
    ...device.caps,
    textureCompressionBc: caps.bc,
    textureCompressionAstc: caps.astc,
    textureCompressionEtc2: caps.etc2,
  });
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const handle = assets.create(source).unwrap();
  const pod = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  const writes = vi.spyOn(device.queue, 'writeTexture');
  expect(store.ensureResident(handle, pod(), worldRenderResources(world))).toMatchObject({
    ok: false,
    error: { code: 'asset-not-ready' },
  });
  await store.waitTextureData(handle, worldRenderResources(world));
  const ready = store.ensureResident(handle, pod(), worldRenderResources(world)).unwrap();
  expect(ready.receipt).toMatchObject({ format, mipLevelCount: 5, bytes });
  expect(writes).toHaveBeenCalledTimes(5);
  expect(store.ensureResident(handle, pod(), worldRenderResources(world)).unwrap()).toBe(ready);
  expect(writes).toHaveBeenCalledTimes(5);
  expect(assets.read(handle).unwrap().data).toEqual(original);
  expect(
    assets.writeRange(handle, {
      origin: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      data: new Uint8Array(4),
    }),
  ).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
  store.destroyAll();
  assets.dispose();
});

it('keeps a private pending source, replaces only its version, and feeds exact RGBA image pages', async () => {
  const first = await encodedTexture(32),
    next = await encodedTexture(192);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const assets = new AssetRegistry(),
    world = new World({ assets }),
    store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const handle = assets.create(first).unwrap();
  const pod = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  expect(() => store.ensureImagePage(handle, pod(), worldRenderResources(world))).toThrow(
    /asset-not-ready/,
  );
  await store.waitTextureData(handle, worldRenderResources(world));
  const id = store.ensureImagePage(handle, pod(), worldRenderResources(world)),
    before = store.imagePages.get(id);
  expect(before).toBeDefined();
  const observer = assets.observe().unwrap();
  assets.replace(handle, next).unwrap();
  const batch = observer.read().unwrap();
  for (const change of batch.changes)
    store.adoptTextureChange(change, pod(), worldRenderResources(world)).unwrap();
  batch.accept();
  expect(store.imagePages.get(id)).toBe(before);
  await store.waitTextureData(handle, worldRenderResources(world));
  expect(store.imagePages.get(id)).not.toBe(before);
  expect((before?.uniformCandidate ?? -1) & 255).toBe(32);
  expect((store.imagePages.get(id)?.uniformCandidate ?? -1) & 255).toBe(192);
  observer.dispose();
  store.destroyAll();
  assets.dispose();
});

it('rejects encoded metadata edits that disagree with the retained container', async () => {
  const source = await encodedTexture();
  const assets = new AssetRegistry(),
    handle = assets.create(source).unwrap();
  const revision = runtimeAssets(assets).version(handle).unwrap();
  for (const patch of [
    { colorSpace: 'srgb', format: 'rgba8unorm-srgb' },
    { mips: { kind: 'none' } },
    { mips: { kind: 'generate' } },
    { shape: { viewDimension: '2d', extent: { width: 8, height: 16 } } },
    { format: 'rgba16float' },
  ] as const) {
    expect(assets.update(handle, patch)).toMatchObject({
      ok: false,
      error: { code: 'asset-invalid-value' },
    });
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
  }
  assets.dispose();
});

it('preserves the image identity across a failed encoded replacement and repair', async () => {
  const first = await encodedTexture(32),
    next = await encodedTexture(192);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const assets = new AssetRegistry(),
    world = new World({ assets }),
    store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const handle = assets.create(first).unwrap(),
    observer = assets.observe().unwrap();
  const pod = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  store.prepareTextureData(handle, pod(), worldRenderResources(world), 'rgba8unorm');
  await store.waitTextureData(handle, worldRenderResources(world));
  const id = store.ensureImagePage(handle, pod(), worldRenderResources(world)),
    before = store.imagePages.get(id);
  const replace = async (value: TextureAsset) => {
    assets.replace(handle, value).unwrap();
    const batch = observer.read().unwrap();
    for (const change of batch.changes)
      store.adoptTextureChange(change, pod(), worldRenderResources(world)).unwrap();
    batch.accept();
    await store.waitTextureData(handle, worldRenderResources(world));
  };
  const invalid = new Uint8Array(77);
  invalid.set([0x73, 0x42]);
  await replace({ ...first, encoding: 'basis', data: invalid });
  expect(() => store.imagePages.get(id)).toThrow();
  expect((before?.uniformCandidate ?? -1) & 255).toBe(32);
  await replace(next);
  expect(store.ensureImagePage(handle, pod(), worldRenderResources(world))).toBe(id);
  expect((store.imagePages.get(id)?.uniformCandidate ?? -1) & 255).toBe(192);
  observer.dispose();
  store.destroyAll();
  assets.dispose();
});
