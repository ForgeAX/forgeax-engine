import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

function texture(generate = false): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: generate ? { kind: 'generate' } : { kind: 'none' },
    data: new Uint8Array(64).fill(255),
  };
}

async function setup() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const scope = DeviceScope.create(1, 'texture-submission');
  store.bindDeviceScope(scope);
  return { device, store, scope, world: new World({ assets: new AssetRegistry() }) };
}

it('invalidates a borrowed texture immediately while old submissions retire in completion order', async () => {
  const { store, scope, world } = await setup();
  const source = texture();
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const original = store.ensureResident(handle, source, worldRenderResources(world)).unwrap();
  const lease = store.retainTextureResidency(handle, worldRenderResources(world));
  assert(lease);
  let finishFirst!: () => void, finishSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  lease.track(first);
  lease.track(second);
  expect(store.evictTexture(handle, worldRenderResources(world)).freed).toBe(0);
  store.invalidateTexture(handle, worldRenderResources(world));
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBeUndefined();
  expect(original.texture.isDestroyed).toBe(false);
  const replacement = store
    .ensureResident(handle, { ...source, data: new Uint8Array(64) }, worldRenderResources(world))
    .unwrap();
  expect(replacement.view).not.toBe(original.view);
  expect(replacement.receipt.generation).toBeGreaterThan(original.receipt.generation);
  const released = lease.release(true);
  finishSecond();
  await second;
  expect(original.texture.isDestroyed).toBe(false);
  finishFirst();
  await first;
  await released;
  expect(original.texture.isDestroyed).toBe(true);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBe(replacement.view);
  expect(replacement.texture.isDestroyed).toBe(false);
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('keeps cold graph mip inputs private until commit without submitting or exposing uninitialized levels', async () => {
  const { device, store, scope, world } = await setup();
  const source = texture(true);
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const submit = vi.spyOn(device.queue, 'submit');
  const candidate = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  expect(candidate.needsMipmaps).toBe(true);
  expect(candidate.entry.receipt.mipLevelCount).toBe(3);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBeUndefined();
  expect(candidate.current()).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  // The graph/submission owner must produce the mips and track its real receipt.
  // This structural test supplies only a controlled completion boundary.
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  candidate.lease.track(completed);
  expect(candidate.commit()).toBe(true);
  expect(candidate.commit()).toBe(true);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBe(candidate.entry.view);
  const hot = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  expect(hot.entry).toBe(candidate.entry);
  expect(hot.needsMipmaps).toBe(false);
  const hotReleased = hot.lease.release(false);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBe(candidate.entry.view);
  store.invalidateTexture(handle, worldRenderResources(world));
  expect(candidate.current()).toBe(false);
  expect(candidate.commit()).toBe(false);
  const released = candidate.lease.release(false);
  expect(candidate.entry.texture.isDestroyed).toBe(false);
  finish();
  await completed;
  await hotReleased;
  await released;
  expect(candidate.entry.texture.isDestroyed).toBe(true);
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('rejects competing cache publication and retires cancelled cold inputs without evicting the winner', async () => {
  const { store, scope, world } = await setup();
  const source = texture();
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const candidate = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  expect(candidate.needsMipmaps).toBe(false);
  const winner = store.ensureResident(handle, source, worldRenderResources(world)).unwrap();
  expect(candidate.current()).toBe(false);
  expect(candidate.commit()).toBe(false);
  // A submitted Card capture can keep the losing private allocation: losing
  // cache publication does not invalidate the bytes held by its native lease.
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  candidate.lease.track(completed);
  expect(candidate.entry.texture.isDestroyed).toBe(false);
  const released = candidate.lease.release(false);
  expect(candidate.entry.texture.isDestroyed).toBe(false);
  finish();
  await released;
  expect(candidate.entry.texture.isDestroyed).toBe(true);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBe(winner.view);
  expect(winner.texture.isDestroyed).toBe(false);
  store.invalidateTexture(handle, worldRenderResources(world));
  const cancelled = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  await cancelled.lease.release(false);
  expect(cancelled.current()).toBe(false);
  expect(cancelled.commit()).toBe(false);
  expect(cancelled.entry.texture.isDestroyed).toBe(true);
  expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBeUndefined();
  const cleared = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  store.destroyAll();
  expect(cleared.current()).toBe(false);
  expect(cleared.commit()).toBe(false);
  await cleared.lease.release(false);
  expect(cleared.entry.texture.isDestroyed).toBe(true);
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it.each([
  'direct',
  'graph',
  'recovery',
] as const)('isolates replacement texture identities through %s publication and stale retirement', async (mode) => {
  const { store, scope, world } = await setup();
  const source = texture();
  const first = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const original = store.ensureResident(first, source, worldRenderResources(world)).unwrap();
  const lease = store.retainTextureResidency(first, worldRenderResources(world));
  assert(lease);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  lease.track(completed);
  runtimeAssetRegistry(world.assets).release(first).unwrap();
  const next = { ...source, data: new Uint8Array(64) };
  const second = runtimeAssetRegistry(world.assets).create(next).unwrap();
  expect(runtimeAssetRegistry(world.assets).validate(first)).toMatchObject({ ok: false });
  expect(second).not.toBe(first);
  expect(store.getTextureGpuView(second, worldRenderResources(world))).toBeUndefined();
  let candidate: ReturnType<GpuResidencyCache['prepareTextureResidencyForGraph']> | undefined;
  if (mode === 'graph') {
    candidate = store.prepareTextureResidencyForGraph(second, next, worldRenderResources(world));
    expect(candidate.unwrap().commit()).toBe(true);
  } else if (mode === 'recovery')
    store.prepareResidentForRecovery(second, next, worldRenderResources(world)).unwrap();
  else store.ensureResident(second, next, worldRenderResources(world)).unwrap();
  const replacement = store.ensureResident(second, next, worldRenderResources(world)).unwrap();
  expect(replacement.view).not.toBe(original.view);
  expect(replacement.receipt.generation).toBeGreaterThan(original.receipt.generation);
  store.invalidateTexture(first, worldRenderResources(world));
  const released = lease.release(true);
  expect(original.texture.isDestroyed).toBe(false);
  expect(store.getTextureGpuView(second, worldRenderResources(world))).toBe(replacement.view);
  finish();
  await completed;
  await released;
  expect(original.texture.isDestroyed).toBe(true);
  expect(replacement.texture.isDestroyed).toBe(false);
  expect(store.evictTexture(first, worldRenderResources(world)).freed).toBe(0);
  if (candidate) await candidate.unwrap().lease.release(false);
  runtimeAssetRegistry(world.assets).release(second).unwrap();
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('keeps numeric scopes separate from handle generations and sweeps exact identities', async () => {
  const { store, scope, world } = await setup();
  const source = texture(),
    first = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const otherWorld = store.ensureResident(first, source, 1).unwrap();
  const original = store.ensureResident(first, source, 0).unwrap();
  runtimeAssetRegistry(world.assets).release(first).unwrap();
  const next = { ...source, data: new Uint8Array(64) },
    second = runtimeAssetRegistry(world.assets).create(next).unwrap();
  const replacement = store.ensureResident(second, next, 0).unwrap();
  expect(replacement.view).not.toBe(original.view);
  expect(replacement.view).not.toBe(otherWorld.view);
  expect(store.getTextureGpuView(first, 1)).toBe(otherWorld.view);
  store.releaseUnreferenced(new Set([Number(second)]));
  expect(store.getTextureGpuView(first, 0)).toBeUndefined();
  expect(store.getTextureGpuView(first, 1)).toBeUndefined();
  expect(store.getTextureGpuView(second, 0)).toBe(replacement.view);
  runtimeAssetRegistry(world.assets).release(second).unwrap();
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});
