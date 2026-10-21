import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createTerrainGrids } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { GpuResidencyCache } from '../../device/gpu-residency.js';
import { worldRenderResources } from '../../publication/resource-scope';
import { editResidentMesh } from '../managed-mesh-edit';

it('shares serialized rule-grid vertex uploads and fences the last owner across independent LOD indices', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets }),
    grids = createTerrainGrids(8).map((mesh) => ({
      ...mesh,
      vertices: new Float32Array(mesh.vertices),
    }));
  const handles = grids.map((mesh) => assets.create(mesh).unwrap());
  const entries = grids.map((mesh, i) =>
    store.ensureResident(defined(handles[i]), mesh, worldRenderResources(world)).unwrap(),
  );
  for (const entry of entries) expect(entry.vertexBuffer).toBe(defined(entries[0]).vertexBuffer);
  expect(new Set(entries.map((entry) => entry.indexBuffer)).size).toBe(3);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  for (const handle of handles) store.invalidateMesh(handle, worldRenderResources(world));
  expect(defined(entries[0]).vertexBuffer.isDestroyed).toBe(false);
  finish();
  await completed;
  expect(defined(entries[0]).vertexBuffer.isDestroyed).toBe(true);
  store.destroyAll();
  assets.dispose();
});
it('detaches a mutable mesh update without modifying another grid owner', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets }),
    grids = createTerrainGrids(4),
    handles = grids.map((mesh) => assets.create(mesh).unwrap());
  const entries = grids.map((mesh, i) =>
    store.ensureResident(defined(handles[i]), mesh, worldRenderResources(world)).unwrap(),
  );
  const lease = defined(
    store.retainMeshResidency(defined(handles[0]), worldRenderResources(world)),
  );
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  const editedHandle = defined(handles[0]);
  const originalIndices = defined(assets.read(editedHandle).unwrap().indices);
  editResidentMesh(
    assets,
    store,
    editedHandle,
    () => {
      assets
        .writeRange(editedHandle, {
          attribute: 'position',
          first: 0,
          values: Float32Array.of(1, 0, 0),
        })
        .unwrap();
      assets
        .writeRange(editedHandle, {
          first: 0,
          indices: originalIndices.slice(0, 3).reverse(),
        })
        .unwrap();
    },
    worldRenderResources(world),
  );
  expect(
    store.getMeshGpuHandles(defined(handles[0]), worldRenderResources(world))?.vertexBuffer,
  ).not.toBe(defined(entries[1]).vertexBuffer);
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  lease.release(true);
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  finish();
  await completed;
  expect(defined(entries[1]).vertexBuffer.isDestroyed).toBe(false);
  expect(defined(defined(entries[0]).indexBuffer).isDestroyed).toBe(true);
  store.destroyAll();
  assets.dispose();
});

it('advances only the written mesh content epoch through reuse and growth', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = defined(createTerrainGrids(4)[0]);
  const handle = assets.create(mesh).unwrap();
  const entry = store.ensureResident(handle, mesh, worldRenderResources(world)).unwrap();
  const originalEpoch = entry.contentEpoch;
  const otherMesh = defined(createTerrainGrids(8)[0]);
  const otherHandle = assets.create(otherMesh).unwrap();
  store.ensureResident(otherHandle, otherMesh, worldRenderResources(world)).unwrap();
  store.invalidateMesh(otherHandle, worldRenderResources(world));
  expect(entry.contentEpoch).toBe(originalEpoch);
  editResidentMesh(
    assets,
    store,
    handle,
    () => {
      assets
        .writeRange(handle, {
          attribute: 'position',
          first: 0,
          values: Float32Array.of(1, 0, 0),
        })
        .unwrap();
    },
    worldRenderResources(world),
  );
  expect(store.getMeshGpuHandles(handle, worldRenderResources(world))).toBe(entry);
  expect(entry.contentEpoch).toBe(store.meshResidencyEpoch);
  expect(entry.contentEpoch).toBeGreaterThan(originalEpoch);
  const reusedEpoch = entry.contentEpoch;
  editResidentMesh(
    assets,
    store,
    handle,
    () => {
      assets.replace(handle, otherMesh).unwrap();
    },
    worldRenderResources(world),
  );
  const grown = defined(store.getMeshGpuHandles(handle, worldRenderResources(world)));
  expect(grown).not.toBe(entry);
  expect(grown.contentEpoch).toBeGreaterThan(reusedEpoch);
  expect(grown.contentEpoch).toBe(store.meshResidencyEpoch);
  store.destroyAll();
  assets.dispose();
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}
