import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { ScopedGpuResources } from '../device/scoped-gpu-resources';
import { worldRenderResources } from '../publication/resource-scope';

function submission() {
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { completed, finish };
}

it.each([
  1, 64,
])('submits and completes unchanged frames without visiting %s resident meshes', async (count) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (let index = 0; index < count; index++) {
    const mesh = createBoxGeometry(index + 1, 1, 1).unwrap();
    store.ensureResident(assets.create(mesh).unwrap(), mesh, worldRenderResources(world)).unwrap();
  }
  const values = vi.spyOn(ScopedGpuResources.prototype, 'values');
  const track = vi.spyOn(ResidencyLifetime.prototype, 'track');
  const first = submission();
  const second = submission();
  try {
    store.trackMeshSubmission(first.completed);
    store.trackMeshSubmission(second.completed);
    second.finish();
    await second.completed;
    first.finish();
    await first.completed;
    expect(values).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  } finally {
    first.finish();
    second.finish();
    await Promise.all([first.completed, second.completed]);
    values.mockRestore();
    track.mockRestore();
    store.destroyAll();
    assets.dispose();
  }
});

it('releases a caller at its captured fence while physical retirement waits for later resident use', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = assets.create(mesh).unwrap();
  const entry = store.ensureResident(handle, mesh, scope).unwrap();
  const lease = store.retainMeshResidency(handle, scope);
  if (lease === undefined) throw new Error('mesh residency missing');
  const first = submission();
  const later = submission();
  store.trackMeshSubmission(first.completed);
  const released = lease.release(true);
  expect(released).toBeDefined();
  let releaseFinished = false;
  void released?.then(() => {
    releaseFinished = true;
  });
  store.trackMeshSubmission(later.completed);
  try {
    first.finish();
    await first.completed;
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(releaseFinished).toBe(true);
    expect(store.getMeshGpuHandles(handle, scope)).toBeUndefined();
    expect(entry.vertexBuffer.isDestroyed).toBe(false);
    expect(entry.indexBuffer?.isDestroyed).toBe(false);
    later.finish();
    await later.completed;
    expect(entry.vertexBuffer.isDestroyed).toBe(true);
    expect(entry.indexBuffer?.isDestroyed).toBe(true);
  } finally {
    first.finish();
    later.finish();
    await Promise.all([first.completed, later.completed, released]);
    store.destroyAll();
    assets.dispose();
  }
});

it.each([
  false,
  true,
])('does not hold a retired mesh for unrelated later submissions (evict: %s)', async (evict) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = assets.create(mesh).unwrap();
  const entry = store.ensureResident(handle, mesh, scope).unwrap();
  const lease = store.retainMeshResidency(handle, scope);
  if (lease === undefined) throw new Error('mesh residency missing');
  const first = submission();
  const later = submission();
  store.trackMeshSubmission(first.completed);
  store.invalidateMesh(handle, scope);
  store.trackMeshSubmission(later.completed);
  const released = lease.release(evict);
  let releaseFinished = false;
  void released?.then(() => {
    releaseFinished = true;
  });
  try {
    first.finish();
    await first.completed;
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(releaseFinished).toBe(true);
    expect(entry.vertexBuffer.isDestroyed).toBe(true);
    expect(entry.indexBuffer?.isDestroyed).toBe(true);
  } finally {
    first.finish();
    later.finish();
    await Promise.all([first.completed, later.completed, released]);
    store.destroyAll();
    assets.dispose();
  }
});

it.each([
  'current',
  'candidate',
] as const)('keeps %s lease completion within its device generation', async (kind) => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = assets.create(mesh).unwrap();
  store.ensureResident(handle, mesh, scope).unwrap();
  const lease =
    kind === 'current'
      ? store.retainMeshResidency(handle, scope)
      : store.prepareMeshResidency(handle, mesh, 1, scope).unwrap().lease;
  if (lease === undefined) throw new Error('mesh residency missing');
  const old = submission();
  const current = submission();
  store.trackMeshSubmission(old.completed);
  store.destroyAll();
  const replacementDevice = (await adapter.requestDevice()).unwrap();
  store.configureGpuDevice(replacementDevice, undefined, replacementDevice.caps);
  const replacement = store.ensureResident(handle, mesh, scope).unwrap();
  store.trackMeshSubmission(current.completed);
  let releaseFinished = false;
  const released = lease.release(true);
  expect(released).toBeDefined();
  void released?.then(() => {
    releaseFinished = true;
  });
  try {
    old.finish();
    await old.completed;
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(releaseFinished).toBe(true);
    expect(store.getMeshGpuHandles(handle, scope)).toBe(replacement);
    store.invalidateMesh(handle, scope);
    expect(replacement.vertexBuffer.isDestroyed).toBe(false);
    current.finish();
    await current.completed;
    expect(replacement.vertexBuffer.isDestroyed).toBe(true);
  } finally {
    old.finish();
    current.finish();
    await Promise.all([old.completed, current.completed, released]);
    store.destroyAll();
    assets.dispose();
  }
});

it('fences ordinary mesh submissions independently of candidates, including reversed completion', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const scope = DeviceScope.create(1, 'mesh-submission');
  store.bindDeviceScope(scope);
  const world = new World({ assets: new AssetRegistry() });
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = runtimeAssetRegistry(world.assets).create(mesh).unwrap();
  store.ensureResident(handle, mesh, worldRenderResources(world)).unwrap();
  const original = store.getMeshGpuHandles(handle, worldRenderResources(world));
  if (original === undefined) throw new Error('mesh residency missing');
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  store.trackMeshSubmission(first);
  store.trackMeshSubmission(second);
  const lease = store.retainMeshResidency(handle, worldRenderResources(world));
  if (lease === undefined) throw new Error('residency lease missing');
  store.invalidateMesh(handle, worldRenderResources(world));
  lease.release(true);
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  // The same cache key can upload changed indices before old work completes.
  // Equal immutable index bytes deliberately share their physical allocation.
  if (mesh.indices === undefined) throw new Error('indexed source mesh missing');
  mesh.indices.reverse();
  store.ensureResident(handle, mesh, worldRenderResources(world)).unwrap();
  const replacement = store.getMeshGpuHandles(handle, worldRenderResources(world));
  if (replacement === undefined) throw new Error('replacement residency missing');
  expect(replacement).not.toBe(original);
  expect(replacement.vertexBuffer).toBe(original.vertexBuffer);
  const originalIndices = original.indexBuffer;
  const replacementIndices = replacement.indexBuffer;
  if (!originalIndices || !replacementIndices) throw new Error('indexed mesh residency missing');
  expect(replacementIndices).not.toBe(originalIndices);
  finishSecond();
  await second;
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  expect(originalIndices.isDestroyed).toBe(false);
  // Two independent index buffers share one immutable vertex allocation.
  expect(scope.resourceDelta()).toBe(3);
  finishFirst();
  await first;
  expect(originalIndices.isDestroyed).toBe(true);
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  expect(scope.resourceDelta()).toBe(2);
  expect(store.getMeshGpuHandles(handle, worldRenderResources(world))).toBe(replacement);
  expect(replacement.vertexBuffer.isDestroyed).toBe(false);
  expect(replacementIndices.isDestroyed).toBe(false);
  store.destroyAll();
  scope.retire();
  expect(replacement.vertexBuffer.isDestroyed).toBe(true);
  expect(replacementIndices.isDestroyed).toBe(true);
  expect(scope.resourceDelta()).toBe(0);
});

it('separates replacement asset identities while old GPU work is still retained', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const world = new World({ assets: new AssetRegistry() });
  const first = createBoxGeometry(1, 1, 1).unwrap();
  const oldHandle = runtimeAssetRegistry(world.assets).create(first).unwrap();
  const oldMesh = store.ensureResident(oldHandle, first, worldRenderResources(world)).unwrap();
  const lease = store.retainMeshResidency(oldHandle, worldRenderResources(world));
  if (lease === undefined) throw new Error('mesh residency missing');
  runtimeAssetRegistry(world.assets).release(oldHandle).unwrap();
  const next = createBoxGeometry(8, 8, 8).unwrap();
  const newHandle = runtimeAssetRegistry(world.assets).create(next).unwrap();
  expect(runtimeAssetRegistry(world.assets).read(oldHandle).ok).toBe(false);
  expect(newHandle).not.toBe(oldHandle);
  const newMesh = store.ensureResident(newHandle, next, worldRenderResources(world)).unwrap();
  expect(newMesh).not.toBe(oldMesh);
  store.invalidateMesh(oldHandle, worldRenderResources(world));
  lease.release(true);
  expect(store.getMeshGpuHandles(newHandle, worldRenderResources(world))).toBe(newMesh);
  expect(newMesh.vertexBuffer.isDestroyed).toBe(false);
  store.destroyAll();
});
