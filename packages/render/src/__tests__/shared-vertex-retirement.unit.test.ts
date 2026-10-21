import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createTerrainGrids } from '@forgeax/engine-geometry';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { editResidentMesh } from './managed-mesh-edit';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const meshes = createTerrainGrids(8).map((mesh) => ({
    ...mesh,
    vertices: new Float32Array(mesh.vertices),
  }));
  const handles = meshes.map((mesh) => runtimeAssetRegistry(world.assets).create(mesh).unwrap());
  const upload = (index: number) =>
    store.ensureResident(
      defined(handles[index]),
      defined(meshes[index]),
      worldRenderResources(world),
    );
  const retire = (index: number) =>
    store.invalidateMesh(defined(handles[index]), worldRenderResources(world));
  return { device, store, assets, world, meshes, handles, upload, retire };
}

it.each([
  'immediate',
  'submission',
  'lease',
] as const)('keeps a shared VBO discoverable when one owner retires with %s lifetime', async (lifetime) => {
  const f = await fixture();
  const createBuffer = vi.spyOn(f.device, 'createBuffer');
  const writeBuffer = vi.spyOn(f.device.queue, 'writeBuffer');
  const first = f.upload(0).unwrap();
  const second = f.upload(1).unwrap();
  expect(second.vertexBuffer).toBe(first.vertexBuffer);
  expect(createBuffer).toHaveBeenCalledTimes(3);
  expect(writeBuffer).toHaveBeenCalledTimes(3);
  let finish!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const lease =
    lifetime === 'lease'
      ? defined(f.store.retainMeshResidency(defined(f.handles[0]), worldRenderResources(f.world)))
      : undefined;
  if (lifetime === 'submission') f.store.trackMeshSubmission(submitted);
  f.retire(0);
  const third = f.upload(2).unwrap();
  // The third mesh uploads only its independent IBO, not the common vertices.
  expect({
    bufferCreates: createBuffer.mock.calls.length,
    bufferWrites: writeBuffer.mock.calls.length,
    sharedVertices: third.vertexBuffer === second.vertexBuffer,
  }).toEqual({ bufferCreates: 4, bufferWrites: 4, sharedVertices: true });
  expect(new Set([first.indexBuffer, second.indexBuffer, third.indexBuffer]).size).toBe(3);
  finish();
  await submitted;
  await lease?.release(true);
  expect(defined(first.indexBuffer).isDestroyed).toBe(true);
  expect(third.vertexBuffer.isDestroyed).toBe(false);
  f.retire(1);
  expect(third.vertexBuffer.isDestroyed).toBe(false);
  f.retire(2);
  expect(third.vertexBuffer.isDestroyed).toBe(true);
  const replacement = f.upload(0).unwrap();
  expect(replacement.vertexBuffer).not.toBe(first.vertexBuffer);
  expect(replacement.vertexBuffer.isDestroyed).toBe(false);
  f.store.destroyAll();
});

it('removes an exclusively updated VBO from the immutable sharing index', async () => {
  const f = await fixture();
  f.upload(0).unwrap();
  const second = f.upload(1).unwrap();
  f.retire(0);
  const mesh = defined(f.meshes[1]);
  const handle = defined(f.handles[1]);
  const position = mesh.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('Expected grid position attribute');
  editResidentMesh(
    f.assets,
    f.store,
    handle,
    () => {
      f.assets
        .writeRange(handle, {
          attribute: 'position',
          first: 0,
          values: Float32Array.of(defined(position[0]) + 1, 0, 0),
        })
        .unwrap();
    },
    worldRenderResources(f.world),
  );
  expect(f.store.getMeshGpuHandles(defined(f.handles[1]), worldRenderResources(f.world))).toBe(
    second,
  );
  const third = f.upload(2).unwrap();
  expect(third.vertexBuffer).not.toBe(second.vertexBuffer);
  expect(second.vertexBuffer.isDestroyed).toBe(false);
  f.store.destroyAll();
  expect(second.vertexBuffer.isDestroyed).toBe(true);
  expect(third.vertexBuffer.isDestroyed).toBe(true);
});

it.each([
  'allocation',
  'upload',
] as const)('does not acquire or destroy a retired shared VBO when the new IBO %s fails', async (failure) => {
  const f = await fixture();
  const first = f.upload(0).unwrap();
  const lease = defined(
    f.store.retainMeshResidency(defined(f.handles[0]), worldRenderResources(f.world)),
  );
  f.retire(0);
  const rejected = err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'successful index buffer preparation',
      hint: 'injected IBO failure',
    }),
  );
  const createBuffer = vi.spyOn(f.device, 'createBuffer');
  const writeBuffer = vi.spyOn(f.device.queue, 'writeBuffer');
  const destroyBuffer = vi.spyOn(f.device, 'destroyBuffer');
  if (failure === 'allocation') createBuffer.mockReturnValueOnce(rejected);
  else writeBuffer.mockReturnValueOnce(rejected);
  expect(f.upload(1).ok).toBe(false);
  expect(createBuffer.mock.calls).toHaveLength(1);
  expect(createBuffer.mock.calls[0]?.[0].label).toMatch(/-ibo$/);
  expect(writeBuffer.mock.calls).toHaveLength(failure === 'upload' ? 1 : 0);
  expect(destroyBuffer.mock.calls).toHaveLength(failure === 'upload' ? 1 : 0);
  expect(first.vertexBuffer.isDestroyed).toBe(false);
  expect(
    f.store.getMeshGpuHandles(defined(f.handles[1]), worldRenderResources(f.world)),
  ).toBeUndefined();
  await lease.release(true);
  expect(first.vertexBuffer.isDestroyed).toBe(true);
  const replacement = f.upload(1).unwrap();
  expect(replacement.vertexBuffer).not.toBe(first.vertexBuffer);
  f.store.destroyAll();
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected fixture value');
  return value;
}
