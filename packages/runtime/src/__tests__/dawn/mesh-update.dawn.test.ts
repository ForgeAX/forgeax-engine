import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { editResidentMesh } from '../../../../render/src/__tests__/managed-mesh-edit';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';

function mesh(vertices: number): MeshAsset {
  const positions = new Float32Array(vertices * 3);
  const indices = vertices > 4 ? Uint16Array.of(0, 1, 2, 4, 5, 6) : Uint16Array.of(0, 1, 2);
  return {
    kind: 'mesh',
    vertices: positions,
    attributes: { position: positions },
    indices,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

it.each([
  'same-size',
  'expansion',
  'repeated',
] as const)('updates mesh GPU residency through the real RHI (%s)', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = _internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  try {
    const handle = assets.create(mesh(4)).unwrap();
    const initial = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
    const before = store.ensureResident(handle, initial).unwrap();
    const vertexBuffer = before.vertexBuffer;
    const indexBuffer = before.indexBuffer;
    const replacement = mesh(mode === 'expansion' ? 16 : 4);
    assert(replacement.indices instanceof Uint16Array);
    assert(replacement.attributes.position instanceof Float32Array);
    for (let frame = 0; frame < (mode === 'repeated' ? 60 : 1); frame++) {
      replacement.attributes.position[0] = frame + 1;
      const updated = editResidentMesh(assets, store, handle, () => {
        if (mode === 'expansion') assets.replace(handle, replacement).unwrap();
        else
          assets
            .writeRange(handle, {
              attribute: 'position',
              first: 0,
              values: Float32Array.of(frame + 1, 0, 0),
            })
            .unwrap();
      });
      if (mode !== 'expansion') {
        expect(updated).toBe(before);
        expect(updated.vertexBuffer).toBe(vertexBuffer);
        expect(updated.indexBuffer).toBe(indexBuffer);
      }
      await raw.queue.onSubmittedWorkDone();
    }
    const after = store.getMeshGpuHandles(handle);
    assert(after);
    if (mode === 'expansion') {
      expect(Object.is(after.vertexBuffer, vertexBuffer)).toBe(false);
      expect(Object.is(after.indexBuffer, indexBuffer)).toBe(false);
      expect(after.vboBytes).toBe(replacement.vertices.byteLength);
    } else {
      expect(after.vertexBuffer).toBe(vertexBuffer);
      expect(after.indexBuffer).toBe(indexBuffer);
    }
    expect(after.indexCount).toBe(replacement.indices.length);
    const positions = assets.read(handle).unwrap().attributes.position;
    assert(positions instanceof Float32Array);
    expect(positions[0]).toBe(mode === 'repeated' ? 60 : 1);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    store.destroyAll();
    assets.dispose();
    raw.destroy();
  }
});
