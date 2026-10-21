import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import {
  projectMeshMaterialBindingObservation,
  publishMeshMaterialBindingResidency,
} from '../mesh-material-bindings';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import {
  createMaterialResidencyObserver,
  observeMaterialResidency,
} from '../render-system-residency';

function assetWorld() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  return new World({ assets });
}

it('keeps mutable readiness, first failures, sampler and video observations without detail rows', async () => {
  const world = assetWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const mips = { kind: 'packed' as const, levelCount: 3 };
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    mips,
    data: new Uint8Array(84),
  };
  const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const textureHandle = runtimeAssetRegistry(world.assets).create(texture).unwrap();
  const samplerHandle = runtimeAssetRegistry(world.assets).create(sampler).unwrap();
  const material: MaterialSnapshot = {
    ...defaultMaterialSnapshot(),
    textureHandles: new Map([['source', textureHandle]]),
    samplerHandles: new Map([['source', samplerHandle]]),
  };
  let videoReady = false;
  const internals = {
    gpuStore: store,
    dynamicTextureStore: {
      getView: () =>
        videoReady
          ? store.getTextureGpuView(textureHandle, worldRenderResources(world))
          : undefined,
    },
  } as unknown as RenderSystemInternals;
  const compare = (value: MaterialSnapshot) => {
    const full = observeMaterialResidency(worldRenderResources(world), value, internals);
    const status = observeMaterialResidency(worldRenderResources(world), value, internals, false);
    expect(status.readiness).toBe(full.readiness);
    expect(status.preparationFailure).toEqual(full.preparationFailure);
    expect(status.textures).toEqual([]);
    expect(status.samplers).toEqual([]);
    return full;
  };
  try {
    const ready = compare(material);
    expect(ready.readiness).toBe('ready');
    expect(ready.textures).toEqual([{ handle: Number(textureHandle), mipLevelCount: 3 }]);
    expect(ready.samplers).toEqual([{ handle: Number(samplerHandle), resident: true }]);
    expect(
      runtimeAssetRegistry(world.assets).update(textureHandle, {
        mips: { kind: 'packed', levelCount: 0 },
      }).ok,
    ).toBe(false);
    expect(compare(material).readiness).toBe('ready');
    const video = {
      ...material,
      videoTextureFields: new Map([['clip', Number(1) as AssetHandle<'video'>]]),
    };
    expect(compare(video).readiness).toBe('pending');
    videoReady = true;
    expect(compare(video).readiness).toBe('ready');
    store.destroyAll();
    store.configureGpuDevice(device, undefined, device.caps);
    expect(compare(material).readiness).toBe('ready');
    expect(observeMaterialResidency(undefined, material, internals, false).readiness).toBe(
      'pending',
    );
  } finally {
    store.destroyAll();
  }
});

it('observes a repeated material once per World and refreshes the next phase', () => {
  const first = assetWorld(),
    second = assetWorld();
  const clip = Number(1) as AssetHandle<'video'>;
  const material = { ...defaultMaterialSnapshot(), videoTextureFields: new Map([['clip', clip]]) };
  let ready = true;
  const getView = vi.fn(() => (ready ? {} : undefined));
  const internals = { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals;
  const observe = createMaterialResidencyObserver(internals, false);
  for (let i = 0; i < 2048; i++)
    expect(observe(worldRenderResources(first), material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(1);
  expect(observe(worldRenderResources(second), material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(2);
  expect(observe(worldRenderResources(first), { ...material }).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(3);
  ready = false;
  const next = createMaterialResidencyObserver(internals, false);
  expect(next(worldRenderResources(first), material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
  expect(next(undefined, material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
});

it('reuses the accepted texture allocation across value clones and rejects invalid edits before observation', async () => {
  const world = assetWorld();
  const assets = runtimeAssetRegistry(world.assets);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const handle = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'packed', levelCount: 1 },
      data: new Uint8Array(4),
    })
    .unwrap();
  const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
  const internals = { gpuStore: store } as RenderSystemInternals;
  const scope = worldRenderResources(world);
  const createTexture = vi.spyOn(device, 'createTexture');
  try {
    const observe = createMaterialResidencyObserver(internals, false);
    for (let index = 0; index < 2048; index++)
      expect(observe(scope, { ...material, roughness: index / 2048 }).readiness).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(assets.update(handle, { mips: { kind: 'packed', levelCount: 0 } }).ok).toBe(false);
    expect(createMaterialResidencyObserver(internals, false)(scope, material).readiness).toBe(
      'ready',
    );
    expect(createTexture).toHaveBeenCalledTimes(1);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('captures a shared residency record before the producer changes it', () => {
  const world = assetWorld();
  const observe = createMaterialResidencyObserver({} as RenderSystemInternals, false);
  const value = observe(worldRenderResources(world), defaultMaterialSnapshot());
  const captured = [];
  for (let entityKey = 1; entityKey <= 128; entityKey++) {
    const projected = projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey,
      bindings: [{ handle: 0, source: 'engine-default' }],
      diagnostics: [],
      residency: [value],
    });
    captured.push(projected.residency[0]);
    expect(projected.residency[0]).toEqual(value);
    expect(Object.isFrozen(projected.residency[0])).toBe(true);
  }
  Reflect.set(value, 'readiness', 'failed');
  expect(captured.every((record) => record?.readiness === 'ready')).toBe(true);
});

it('detaches raw mutable residency even when only its outer record is frozen', () => {
  const textures = [{ handle: 17, mipLevelCount: 3 }];
  const samplers = [{ handle: 18, resident: true }];
  const detail = { slot: 1 };
  const failure = { code: 'invalid', expected: 'texture', hint: 'repair', detail };
  const value = Object.freeze({
    readiness: 'last-known-good' as const,
    textures,
    samplers,
    preparationFailure: failure,
  });
  const projected = projectMeshMaterialBindingObservation({
    worldId: 0,
    entityKey: 9,
    bindings: [{ handle: 0, source: 'engine-default' }],
    diagnostics: [],
    residency: [value],
  });
  const texture = textures[0],
    sampler = samplers[0];
  if (texture === undefined || sampler === undefined)
    throw Error('Missing mutable observation fixture');
  texture.mipLevelCount = 0;
  sampler.resident = false;
  detail.slot = 2;
  expect(projected.residency[0]).not.toBe(value);
  expect(projected.residency[0]).toMatchObject({
    textures: [{ handle: 17, mipLevelCount: 3 }],
    samplers: [{ handle: 18, resident: true }],
    preparationFailure: { detail: { slot: 1 } },
  });
});

it('shares producer-captured residency while recapturing raw and shallow-frozen accessors', () => {
  let handle = 7,
    reads = 0;
  const sampler = {
    get handle() {
      reads++;
      return handle;
    },
    resident: true,
  };
  const source = Object.freeze({ readiness: 'ready' as const, samplers: [sampler], textures: [] });
  const input = {
    worldId: 0,
    entityKey: 1,
    bindings: [{ handle: 1, source: 'engine-default' as const }],
    diagnostics: [],
  };
  const published = publishMeshMaterialBindingResidency(source);
  const count = reads;
  const first = projectMeshMaterialBindingObservation({ ...input, residency: [published] });
  const second = projectMeshMaterialBindingObservation({ ...input, residency: [published] });
  expect(reads).toBe(count);
  expect(first.residency[0]).toBe(second.residency[0]);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
  handle = 9;
  const raw = projectMeshMaterialBindingObservation({ ...input, residency: [source] });
  const rawAgain = projectMeshMaterialBindingObservation({ ...input, residency: [source] });
  expect(raw.residency[0]).not.toBe(rawAgain.residency[0]);
  expect(raw.residency[0]?.samplers[0]?.handle).toBe(9);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
});
