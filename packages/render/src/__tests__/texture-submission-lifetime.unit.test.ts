import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { type MaterialSourceSnapshot, materialSourceScope } from '../material-source';
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

it('retains accepted material scopes across drained frames and retires replaced scopes after their submissions', async () => {
  const { device, store, scope, world } = await setup();
  const owner = worldRenderResources(world);
  const firstSource = texture();
  const handle = runtimeAssetRegistry(world.assets).create(firstSource).unwrap();
  const source = (revision: number, value: TextureAsset): MaterialSourceSnapshot => ({
    root: handle,
    revision,
    assets: [{ handle, revision, value }],
  });
  const firstScope = materialSourceScope(owner, source(1, firstSource));
  const firstOwner = store.retainMaterialScope(firstScope);
  const created = vi.spyOn(device, 'createTexture');
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const first = store.ensureResident(handle, firstSource, firstScope).unwrap();
  for (let frame = 0; frame < 4; frame++) {
    const completed = Promise.resolve();
    store.trackMeshSubmission(completed);
    await completed;
    expect(store.ensureResident(handle, firstSource, firstScope).unwrap().view).toBe(first.view);
  }
  expect(created).toHaveBeenCalledTimes(1);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  const nextSource = { ...firstSource, data: new Uint8Array(64) };
  const nextScope = materialSourceScope(owner, source(2, nextSource));
  const nextOwner = store.retainMaterialScope(nextScope);
  const next = store.ensureResident(handle, nextSource, nextScope).unwrap();
  const released = firstOwner.release(true);
  expect(firstScope.resolveAsset(handle).unwrap()).toBe(firstSource);
  expect(first.texture.isDestroyed).toBe(false);
  expect(next.view).not.toBe(first.view);
  finish();
  await released;
  expect(first.texture.isDestroyed).toBe(true);
  expect(next.texture.isDestroyed).toBe(false);
  expect(destroyed).toHaveBeenCalledTimes(1);
  await nextOwner.release(true);
  expect(next.texture.isDestroyed).toBe(true);
  for (let revision = 3; revision < 35; revision++) {
    const currentScope = materialSourceScope(owner, source(revision, texture()));
    const currentOwner = store.retainMaterialScope(currentScope);
    const current = store.ensureResident(handle, texture(), currentScope).unwrap();
    expect(current.texture.isDestroyed).toBe(false);
    expect(created.mock.calls.length - destroyed.mock.calls.length).toBe(1);
    await currentOwner.release(true);
    expect(current.texture.isDestroyed).toBe(true);
  }
  expect(created.mock.calls.length).toBe(destroyed.mock.calls.length);
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('retires a replaced material scope after its own submission without waiting for unrelated work', async () => {
  const { store, scope, world } = await setup();
  const owner = worldRenderResources(world);
  const image = texture();
  const handle = runtimeAssetRegistry(world.assets).create(image).unwrap();
  const source = (revision: number): MaterialSourceSnapshot => ({
    root: handle,
    revision,
    assets: [{ handle, revision, value: image }],
  });
  const firstScope = materialSourceScope(owner, source(1));
  const firstOwner = store.retainMaterialScope(firstScope);
  const first = store.ensureResident(handle, image, firstScope).unwrap();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstCompleted = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondCompleted = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  store.trackMeshSubmission(firstCompleted);
  const released = firstOwner.release(true);
  const secondScope = materialSourceScope(owner, source(2));
  const secondOwner = store.retainMaterialScope(secondScope);
  const second = store.ensureResident(handle, image, secondScope).unwrap();
  store.trackMeshSubmission(secondCompleted);
  try {
    expect(first.texture.isDestroyed).toBe(false);
    finishFirst();
    await released;
    expect(first.texture.isDestroyed).toBe(true);
    expect(second.texture.isDestroyed).toBe(false);
  } finally {
    finishSecond();
    await secondCompleted;
    await secondOwner.release(true);
    store.destroyAll();
    scope.retire();
  }
  expect(scope.resourceDelta()).toBe(0);
});

it('keeps a separately held material scope alive until its own later submission completes', async () => {
  const { store, scope, world } = await setup();
  const image = texture();
  const handle = runtimeAssetRegistry(world.assets).create(image).unwrap();
  const fixed = materialSourceScope(worldRenderResources(world), {
    root: handle,
    revision: 1,
    assets: [{ handle, revision: 1, value: image }],
  });
  const current = store.retainMaterialScope(fixed);
  const held = store.retainMaterialScope(fixed);
  const resident = store.ensureResident(handle, image, fixed).unwrap();
  await current.release(true);
  expect(resident.texture.isDestroyed).toBe(false);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  held.track(completed);
  const released = held.release(true);
  expect(resident.texture.isDestroyed).toBe(false);
  finish();
  await released;
  expect(resident.texture.isDestroyed).toBe(true);
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('retires pending material texture derivations even before a resident allocation exists', async () => {
  const { store, scope, world } = await setup();
  const image = texture();
  const handle = runtimeAssetRegistry(world.assets).create(image).unwrap();
  const encoded: TextureAsset = { ...image, encoding: 'ktx2', data: new Uint8Array(4) };
  const fixed = materialSourceScope(worldRenderResources(world), {
    root: handle,
    revision: 1,
    assets: [{ handle, revision: 1, value: encoded }],
  });
  const current = store.retainMaterialScope(fixed);
  expect(store.prepareTextureData(handle, encoded, fixed).ok).toBe(false);
  const completed = store.waitTextureData(handle, fixed);
  expect(store.isTexturePreparing(handle, fixed)).toBe(true);
  try {
    const released = current.release(true);
    expect(store.isTexturePreparing(handle, fixed)).toBe(false);
    await released;
  } finally {
    await completed;
    store.destroyAll();
    scope.retire();
  }
  expect(scope.resourceDelta()).toBe(0);
});

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
  const otherWorld = store.ensureResident(first, source, undefined).unwrap();
  const original = store.ensureResident(first, source, undefined).unwrap();
  runtimeAssetRegistry(world.assets).release(first).unwrap();
  const next = { ...source, data: new Uint8Array(64) },
    second = runtimeAssetRegistry(world.assets).create(next).unwrap();
  const replacement = store.ensureResident(second, next, undefined).unwrap();
  expect(replacement.view).not.toBe(original.view);
  expect(replacement.view).not.toBe(otherWorld.view);
  expect(store.getTextureGpuView(first, undefined)).toBe(otherWorld.view);
  store.releaseUnreferenced(new Set([Number(second)]));
  expect(store.getTextureGpuView(first, undefined)).toBeUndefined();
  expect(store.getTextureGpuView(first, undefined)).toBeUndefined();
  expect(store.getTextureGpuView(second, undefined)).toBe(replacement.view);
  runtimeAssetRegistry(world.assets).release(second).unwrap();
  store.destroyAll();
  scope.retire();
  expect(scope.resourceDelta()).toBe(0);
});

it('transfers exact private texture cleanup before a preparation wrapper throws', async () => {
  const { store, scope, world } = await setup();
  const source = texture();
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  let captured: import('../device/gpu-residency').GraphTextureResidencyPreparation | undefined;
  const failure = Error('consumer failed after texture preparation');
  try {
    expect(() => {
      store
        .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world), (value) => {
          captured = value;
        })
        .unwrap();
      throw failure;
    }).toThrow(failure);
    assert(captured);
    expect(captured.current()).toBe(true);
    expect(store.getTextureGpuView(handle, worldRenderResources(world))).toBeUndefined();
    await captured.lease.release(false);
    expect(captured.entry.texture.isDestroyed).toBe(true);
    expect(captured.entry.texture.destructionFailure).toBeUndefined();
  } finally {
    store.destroyAll();
    scope.retire();
  }
});

it('keeps the actual texture destruction Result failure observable after lease release', async () => {
  const { store, scope, world, device } = await setup();
  const source = texture();
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const prepared = store
    .prepareTextureResidencyForGraph(handle, source, worldRenderResources(world))
    .unwrap();
  const { RhiError, err } = await import('@forgeax/engine-rhi');
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'physical texture retirement',
    hint: 'retain this exact failed allocation',
  });
  const destroy = vi.spyOn(device, 'destroyTexture').mockReturnValueOnce(err(failure));
  try {
    await prepared.lease.release(false);
    expect(prepared.entry.texture.isDestroyed).toBe(false);
    expect(prepared.entry.texture.destructionFailure).toBe(failure);
    prepared.entry.texture.destroy().unwrap();
    expect(prepared.entry.texture.isDestroyed).toBe(true);
    expect(prepared.entry.texture.destructionFailure).toBe(failure);
  } finally {
    destroy.mockRestore();
    if (!prepared.entry.texture.isDestroyed) prepared.entry.texture.destroy().unwrap();
    store.destroyAll();
    scope.retire();
  }
});

it('prepares fixed texture copies with an explicit checked revision without weakening ordinary identity proof', async () => {
  const { store, scope, world, device } = await setup();
  const handle = runtimeAssetRegistry(world.assets).create(texture()).unwrap();
  const source = worldRenderResources(world);
  const version = source.assetRevision(handle);
  assert(version !== undefined);
  const copied = structuredClone(source.resolveAsset<TextureAsset>(handle).unwrap());
  const ordinary = store.prepareTextureResidencyForGraph(handle, copied, source).unwrap();
  expect(ordinary.entry.receipt.sourceRevision).toBeUndefined();
  await ordinary.lease.release(false);
  const create = vi.spyOn(device, 'createTexture');
  try {
    expect(
      store.prepareTextureResidencyForGraph(handle, copied, source, undefined, version + 1).ok,
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
    const fixed = store
      .prepareTextureResidencyForGraph(handle, copied, source, undefined, version)
      .unwrap();
    expect(fixed.entry.receipt.sourceRevision).toBe(version);
    expect(store.getTextureGpuView(handle, source)).toBeUndefined();
    await fixed.lease.release(false);
    expect(fixed.entry.texture.isDestroyed).toBe(true);
  } finally {
    create.mockRestore();
    store.destroyAll();
    scope.retire();
  }
});
