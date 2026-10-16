import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';

it('fences ordinary mesh submissions independently of candidates, including reversed completion', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const scope = DeviceScope.create(1, 'mesh-submission');
  store.bindDeviceScope(scope);
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = world.allocSharedRef('MeshAsset', mesh);
  store.ensureResident(handle, mesh, world).unwrap();
  const original = store.getMeshGpuHandles(handle, world);
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
  const lease = store.retainMeshResidency(handle, world);
  if (lease === undefined) throw new Error('residency lease missing');
  store.invalidateMesh(handle, world);
  lease.release(true);
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  // The same cache key can upload changed indices before old work completes.
  // Equal immutable index bytes deliberately share their physical allocation.
  if (mesh.indices === undefined) throw new Error('indexed source mesh missing');
  mesh.indices.reverse();
  store.ensureResident(handle, mesh, world).unwrap();
  const replacement = store.getMeshGpuHandles(handle, world);
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
  expect(store.getMeshGpuHandles(handle, world)).toBe(replacement);
  expect(replacement.vertexBuffer.isDestroyed).toBe(false);
  expect(replacementIndices.isDestroyed).toBe(false);
  store.destroyAll();
  scope.retire();
  expect(replacement.vertexBuffer.isDestroyed).toBe(true);
  expect(replacementIndices.isDestroyed).toBe(true);
  expect(scope.resourceDelta()).toBe(0);
});

it('separates recycled shared mesh generations while old GPU work is still retained', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const world = new World();
  const first = createBoxGeometry(1, 1, 1).unwrap();
  const oldHandle = world.allocSharedRef('MeshAsset', first);
  const oldMesh = store.ensureResident(oldHandle, first, world).unwrap();
  const lease = store.retainMeshResidency(oldHandle, world);
  if (lease === undefined) throw new Error('mesh residency missing');
  world.sharedRefs.release(oldHandle).unwrap();
  const next = createBoxGeometry(8, 8, 8).unwrap();
  const newHandle = world.allocSharedRef('MeshAsset', next);
  expect(Number(newHandle) & 0xffffff).toBe(Number(oldHandle) & 0xffffff);
  expect(newHandle).not.toBe(oldHandle);
  const newMesh = store.ensureResident(newHandle, next, world).unwrap();
  expect(newMesh).not.toBe(oldMesh);
  store.invalidateMesh(oldHandle, world);
  lease.release(true);
  expect(store.getMeshGpuHandles(newHandle, world)).toBe(newMesh);
  expect(newMesh.vertexBuffer.isDestroyed).toBe(false);
  store.destroyAll();
});
