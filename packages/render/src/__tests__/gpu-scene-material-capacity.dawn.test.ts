import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { assert, expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { preparedSnapshot } from './gpu-driven-production-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

async function readBuffer(device: RhiDevice, source: Buffer, length: number): Promise<Uint8Array> {
  const readback = device.createBuffer({ size: length, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, 0, readback, 0, length);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    try {
      return new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
    } finally {
      mapping.unmap();
    }
  } finally {
    device.destroyBuffer(readback);
  }
}

it('grows distinct material storage and reconstructs its bytes on a replacement native device', async () => {
  const original = await nativeDeviceFixture();
  const replacement = await nativeDeviceFixture();
  const create = (device: RhiDevice) => {
    const available = GpuScene.create(device, 4096).unwrap();
    assert(available.status === 'available');
    expect(available.scene.inspect().tables.material.bytes).toBeLessThanOrEqual(256);
    return available.scene;
  };
  const scene = create(original.device),
    rebuilt = create(replacement.device);
  original.native.pushErrorScope('validation');
  replacement.native.pushErrorScope('validation');
  try {
    const projection = new RenderScene();
    const sources = Array.from({ length: 129 }, (_, index) => {
      const source = preparedSnapshot(index, 1);
      const material = new MaterialResource({
        ...source.material.snapshot,
        materialShaderId: 'fixture::tint',
        materialParamSchema: [{ name: 'tint', type: 'color' }],
        paramSnapshot: { tint: [index / 128, 0.25, 0.5, 1] },
      });
      return { ...source, material, materials: [material] };
    });
    const updates = sources.map((snapshot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    }));
    const first = updates[0];
    assert(first);
    scene.sync(projection.apply([first])).unwrap();
    const accepted = await readBuffer(original.device, scene.materialBuffer, 16);
    const initial = scene.materialBuffer;
    const firstPrimitive = scene.primitiveIndexForSlot(0);
    scene.sync(projection.apply(updates.slice(1))).unwrap();
    expect(Object.is(scene.materialBuffer, initial)).toBe(false);
    expect(scene.primitiveIndexForSlot(0)).toBe(firstPrimitive);
    expect(equalBytes(await readBuffer(original.device, scene.materialBuffer, 16), accepted)).toBe(
      true,
    );
    const byteLength = scene.inspect().tables.material.bytes;
    expect(byteLength).toBeGreaterThanOrEqual(sources.length * 16);
    expect(byteLength).toBeLessThan(sources.length * 32);
    expect(scene.inspect().tables.primitive.capacity).toBe(4096);
    const bytes = await readBuffer(original.device, scene.materialBuffer, byteLength);
    const primitiveBytes = await readBuffer(
      original.device,
      scene.primitiveBuffer,
      scene.inspect().tables.primitive.bytes,
    );
    const primitives = new DataView(primitiveBytes.buffer);
    const sourceOffset = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'sourceIndex');
    const firstRow = scene.primitiveIndexForSlot(1);
    assert(firstRow !== undefined);
    expect(firstRow).toBe(1); // Shared materials consume no primitive rows.
    for (const slot of projection.slotsSnapshot()) {
      const row = scene.primitiveIndexForSlot(slot.slot);
      assert(row !== undefined);
      expect(
        primitives.getUint32(row * GPU_SCENE_LAYOUTS.primitive.stride + sourceOffset, true),
      ).toBe(slot.slot);
    }
    const recoveredProjection = new RenderScene();
    rebuilt.sync(recoveredProjection.apply(updates)).unwrap();
    expect(rebuilt.inspect().tables.material.bytes).toBe(byteLength);
    expect(
      equalBytes(await readBuffer(replacement.device, rebuilt.materialBuffer, byteLength), bytes),
    ).toBe(true);
    expect(await original.native.popErrorScope()).toBeNull();
    expect(await replacement.native.popErrorScope()).toBeNull();
  } finally {
    scene.dispose();
    rebuilt.dispose();
    original.native.destroy();
    replacement.native.destroy();
  }
}, 30000);
