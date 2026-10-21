import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

async function readBytes(device: RhiDevice, source: Buffer, offset: number, size: number) {
  const readback = device
    .createBuffer({ size, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, offset, readback, 0, size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    return bytes;
  } finally {
    device.destroyBuffer(readback);
  }
}

async function readMaterial(
  device: RhiDevice,
  inputs: Buffer,
  values: Buffer,
  descriptor: number,
  size: number,
) {
  const address = await readBytes(device, inputs, descriptor * 4, 4);
  const index = new Uint32Array(address)[0];
  if (index === undefined) throw new Error('Missing material row address');
  return new Float32Array(await readBytes(device, values, index * 16, size));
}

export async function verifyMaterialVersions(device: RhiDevice) {
  const admitted = GpuScene.create(device, 4).unwrap();
  if (admitted.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = admitted.scene;
  const projection = new RenderScene();
  const source = receiptRow().source;
  const initial: MaterialSnapshot = {
    ...source.material.snapshot,
    materialShaderId: 'test::tint',
    materialParamSchema: [{ name: 'tint', type: 'color' }],
    paramSnapshot: { tint: [1, 0, 0, 1] },
  };
  const material = new MaterialResource(initial);
  scene
    .sync(
      projection.apply([
        {
          kind: 'update',
          worldId: source.worldId,
          entityKey: source.entityKey,
          snapshot: { ...source, material, materials: [material] },
        },
      ]),
    )
    .unwrap();
  const first = scene.captureResources().unwrap();
  const oldAddress = first.indexForResource(material, initial);
  if (oldAddress === undefined) throw new Error('Missing first material');
  const sceneBuffers = [scene.primitiveBuffer, scene.instanceBuffer, scene.transformBuffer];
  const rowCapacity = scene.rowCapacity;
  const oldBuffers = {
    inputs: first.inputReads().buffer().unwrap().buffer,
    material: scene.materialBuffer,
  };
  const edit = (value: MaterialSnapshot) => {
    material.adopt(value);
    scene.sync({ ...projection.apply([]), materialUpdates: [material] }).unwrap();
  };
  first.seal().unwrap();
  let second = scene.captureResources().unwrap();
  let aborted: GpuSceneResourceFrame | undefined;
  try {
    edit({ ...initial, paramSnapshot: { tint: [0, 1, 0, 1] } });
    expect(second.indexForResource(material, material.snapshot)).toBeUndefined();
    expect(second.seal().ok).toBe(false);
    second.release();
    second = scene.captureResources().unwrap();
    const greenAddress = second.indexForResource(material, material.snapshot);
    if (greenAddress === undefined) throw new Error('Missing green material');
    expect(greenAddress).not.toBe(oldAddress);
    const greenBuffers = {
      inputs: second.inputReads().buffer().unwrap().buffer,
      material: scene.materialBuffer,
    };
    second.seal().unwrap();
    expect(
      Array.from(
        await readMaterial(device, oldBuffers.inputs, oldBuffers.material, oldAddress, 16),
      ),
    ).toEqual([1, 0, 0, 1]);
    expect(
      Array.from(
        await readMaterial(device, greenBuffers.inputs, greenBuffers.material, greenAddress, 16),
      ),
    ).toEqual([0, 1, 0, 1]);
    const fields = Array.from({ length: 1024 }, (_, index) => ({
      name: `value${index}`,
      type: 'f32' as const,
    }));
    edit({
      ...initial,
      materialParamSchema: [{ name: 'tint', type: 'color' }, ...fields],
      paramSnapshot: { tint: [0, 0, 1, 1] },
    });
    expect(scene.materialBuffer).not.toBe(oldBuffers.material);
    const blueAddress = scene.materialIndexForResource(material);
    if (blueAddress === undefined) throw new Error('Missing resized material');
    aborted = scene.captureResources().unwrap();
    expect(aborted.indexForResource(material, material.snapshot)).toBe(blueAddress);
    const blueBuffer = aborted.inputReads().buffer().unwrap().buffer;
    aborted.seal().unwrap();
    aborted.release();
    expect(scene.rowCapacity).toBe(rowCapacity);
    expect(scene.primitiveBuffer).toBe(sceneBuffers[0]);
    expect(scene.instanceBuffer).toBe(sceneBuffers[1]);
    expect(scene.transformBuffer).toBe(sceneBuffers[2]);
    expect(
      Array.from(
        await readMaterial(device, oldBuffers.inputs, oldBuffers.material, oldAddress, 16),
      ),
    ).toEqual([1, 0, 0, 1]);
    expect(
      Array.from(
        await readMaterial(device, greenBuffers.inputs, greenBuffers.material, greenAddress, 16),
      ),
    ).toEqual([0, 1, 0, 1]);
    expect(
      Array.from(await readMaterial(device, blueBuffer, scene.materialBuffer, blueAddress, 16)),
    ).toEqual([0, 0, 1, 1]);
    first.submit();
    second.submit();
    await device.queue.onSubmittedWorkDone();
  } finally {
    aborted?.release();
    first.release();
    second.release();
    scene.dispose();
  }
}
