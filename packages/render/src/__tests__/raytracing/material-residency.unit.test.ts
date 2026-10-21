import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok, type SamplerAsset, type TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { samplerContribution } from '../../assets/asset-decoders';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { worldRenderResources } from '../../publication/resource-scope';
import { prepareSurfaceMaterialTextures } from '../../raytracing/material-residency';
import { defaultMaterialSnapshot } from '../../render-system-extract';

it('fences exact texture and sampler payloads, fingerprints sampling changes and releases cold candidates', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'generate' },
    data: new Uint8Array(64).fill(255),
  };
  const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const textureHandle = assets.create(texture).unwrap();
  const samplerHandle = assets.create(sampler).unwrap();
  const scope = worldRenderResources(world);
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const defaultSampler = device.createSampler({}).unwrap();
  const snapshot = {
    ...defaultMaterialSnapshot(),
    textureHandles: new Map([['baseColorTexture', textureHandle]]),
    samplerHandles: new Map([['baseColorTexture', samplerHandle]]),
  };
  const schema = [{ name: 'baseColorTexture', type: 'texture2d' as const }];
  const submit = vi.spyOn(device.queue, 'submit');
  const firstTexture = store
    .prepareTextureResidencyForGraph(textureHandle, texture, scope)
    .unwrap();
  const first = prepareSurfaceMaterialTextures(store, defaultSampler, schema, scope, snapshot, () =>
    ok(firstTexture),
  ).unwrap();
  expect(first.current()).toBe(true);
  expect(store.getTextureGpuView(textureHandle, scope)).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  assets.update(samplerHandle, { minFilter: 'linear', magFilter: 'linear' }).unwrap();
  expect(first.current()).toBe(false);
  const second = prepareSurfaceMaterialTextures(
    store,
    defaultSampler,
    schema,
    scope,
    snapshot,
    () => ok(firstTexture),
  ).unwrap();
  expect(second.current()).toBe(true);
  expect(second.textures.get('baseColorTexture')?.sampler).not.toBe(
    first.textures.get('baseColorTexture')?.sampler,
  );
  expect(second.contentKey).not.toBe(first.contentKey);
  assets.update(textureHandle, { data: new Uint8Array(64) }).unwrap();
  expect(second.current()).toBe(false);
  await first.release();
  await second.release();
  expect(firstTexture.entry.texture.isDestroyed).toBe(true);
  const array: TextureAsset = {
    ...texture,
    shape: { viewDimension: '2d-array', extent: { width: 4, height: 4, layers: 1 } },
    mips: { kind: 'none' },
  };
  assets.replace(textureHandle, array).unwrap();
  const arrayTexture = store.prepareTextureResidencyForGraph(textureHandle, array, scope).unwrap();
  const rejected = prepareSurfaceMaterialTextures(
    store,
    defaultSampler,
    schema,
    scope,
    snapshot,
    () => ok(arrayTexture),
  );
  expect(rejected.ok).toBe(false);
  await arrayTexture.lease.release(false);
  expect(arrayTexture.entry.texture.isDestroyed).toBe(true);
  const missing = { ...snapshot, textureHandles: new Map() };
  expect(prepareSurfaceMaterialTextures(store, defaultSampler, schema, scope, missing).ok).toBe(
    false,
  );
  assert(submit.mock.calls.length === 0);
  store.destroyAll();
  assets.dispose();
});
