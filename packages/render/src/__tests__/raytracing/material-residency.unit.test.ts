import type { AssetReader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  type Asset,
  AssetError,
  err,
  ok,
  type SamplerAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../device/gpu-residency';
import type { PublishedRenderResources } from '../../publication/resource-scope';
import { prepareSurfaceMaterialTextures } from '../../raytracing/material-residency';
import { defaultMaterialSnapshot } from '../../render-system-extract';

it('fences exact texture and sampler payloads, fingerprints sampling changes and releases cold candidates', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const world = new World();
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'generate' },
    data: new Uint8Array(64).fill(255),
  };
  const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const textureHandle = world.allocSharedRef('TextureAsset', texture),
    samplerHandle = world.allocSharedRef('SamplerAsset', sampler);
  const values = new Map<number, Asset>([
    [Number(textureHandle), texture],
    [Number(samplerHandle), sampler],
  ]);
  const source: AssetReader = {
    identity: 'accepted-resource-fixture',
    resolveAsset<T extends Asset>(handle: Parameters<AssetReader['resolveAsset']>[0]) {
      const value = values.get(Number(handle));
      return value
        ? ok(value as T)
        : err(
            new AssetError({
              code: 'asset-not-found',
              expected: 'fixture source',
              hint: 'repair fixture',
            }),
          );
    },
  };
  const scope = source as PublishedRenderResources;
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cube');
    },
    device.caps,
  );
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
  values.set(Number(samplerHandle), { ...sampler, minFilter: 'linear', magFilter: 'linear' });
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
  values.set(Number(textureHandle), { ...texture, data: new Uint8Array(64) });
  expect(second.current()).toBe(false);
  await first.release();
  await second.release();
  expect(firstTexture.entry.texture.isDestroyed).toBe(true);
  const array: TextureAsset = {
    ...texture,
    shape: { viewDimension: '2d-array', extent: { width: 4, height: 4, layers: 1 } },
    mips: { kind: 'none' },
  };
  values.set(Number(textureHandle), array);
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
});
