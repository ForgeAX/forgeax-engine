import { World } from '@forgeax/engine-ecs';
import { createTerrainGrids } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { GpuResidencyCache } from '../../device/gpu-residency.js';

it('shares serialized rule-grid vertex uploads and fences the last owner across independent LOD indices', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused');
    },
    device.caps,
  );
  const world = new World(),
    grids = createTerrainGrids(8).map((mesh) => ({
      ...mesh,
      vertices: new Float32Array(mesh.vertices),
    }));
  const handles = grids.map((mesh) => world.allocSharedRef('MeshAsset', mesh));
  const entries = grids.map((mesh, i) =>
    store.ensureResident(defined(handles[i]), mesh, world).unwrap(),
  );
  for (const entry of entries) expect(entry.vertexBuffer).toBe(defined(entries[0]).vertexBuffer);
  expect(new Set(entries.map((entry) => entry.indexBuffer)).size).toBe(3);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  for (const handle of handles) store.invalidateMesh(handle, world);
  expect(defined(entries[0]).vertexBuffer.isDestroyed).toBe(false);
  finish();
  await completed;
  expect(defined(entries[0]).vertexBuffer.isDestroyed).toBe(true);
  store.destroyAll();
});
it('detaches a mutable mesh update without modifying another grid owner', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused');
    },
    device.caps,
  );
  const world = new World(),
    grids = createTerrainGrids(4),
    handles = grids.map((mesh) => world.allocSharedRef('MeshAsset', mesh));
  const entries = grids.map((mesh, i) =>
    store.ensureResident(defined(handles[i]), mesh, world).unwrap(),
  );
  const lease = defined(store.retainMeshResidency(defined(handles[0]), world));
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  store.updateMesh(
    defined(handles[0]),
    new Float32Array(defined(grids[0]).vertices),
    new Uint16Array(defined(defined(grids[0]).indices)),
    world,
  );
  expect(store.getMeshGpuHandles(defined(handles[0]), world)?.vertexBuffer).not.toBe(
    defined(entries[1]).vertexBuffer,
  );
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  lease.release(true);
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  finish();
  await completed;
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  expect(defined(defined(entries[0]).indexBuffer).isDestroyed).toBe(true);
  store.destroyAll();
});

it('advances only the written mesh content epoch through reuse and growth', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused');
    },
    device.caps,
  );
  const world = new World();
  const mesh = defined(createTerrainGrids(4)[0]);
  const handle = world.allocSharedRef('MeshAsset', mesh);
  const entry = store.ensureResident(handle, mesh, world).unwrap();
  const originalEpoch = entry.contentEpoch;
  const otherMesh = defined(createTerrainGrids(8)[0]);
  const otherHandle = world.allocSharedRef('MeshAsset', otherMesh);
  store.ensureResident(otherHandle, otherMesh, world).unwrap();
  store.invalidateMesh(otherHandle, world);
  expect(entry.contentEpoch).toBe(originalEpoch);
  store.updateMesh(
    handle,
    new Float32Array(mesh.vertices),
    new Uint16Array(defined(mesh.indices)),
    world,
  );
  expect(store.getMeshGpuHandles(handle, world)).toBe(entry);
  expect(entry.contentEpoch).toBe(store.meshResidencyEpoch);
  expect(entry.contentEpoch).toBeGreaterThan(originalEpoch);
  const reusedEpoch = entry.contentEpoch;
  store.updateMesh(
    handle,
    new Float32Array(otherMesh.vertices),
    new Uint16Array(defined(otherMesh.indices)),
    world,
  );
  const grown = defined(store.getMeshGpuHandles(handle, world));
  expect(grown).not.toBe(entry);
  expect(grown.contentEpoch).toBeGreaterThan(reusedEpoch);
  expect(grown.contentEpoch).toBe(store.meshResidencyEpoch);
  store.destroyAll();
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}
