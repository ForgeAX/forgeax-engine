import type { MappedBuffer } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { ensureReady, requestAdapter } from '../index';

it('reads back uploaded index bytes through a real WebGL2 staging copy', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await ensureReady();
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const source = device
    .createBuffer({ size: indices.byteLength, usage: 0x10 | 0x08 | 0x04 })
    .unwrap();
  const staging = device.createBuffer({ size: indices.byteLength, usage: 0x08 | 0x01 }).unwrap();
  let mapped: MappedBuffer | undefined;
  try {
    device.queue.writeBuffer(source, 0, indices).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, 0, staging, 0, indices.byteLength);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    mapped = (await staging.mapAsync(1)).unwrap();
    expect([...new Uint32Array(mapped.getMappedRange().unwrap())]).toEqual([...indices]);
  } finally {
    mapped?.unmap();
    device.destroyBuffer(staging).unwrap();
    device.destroyBuffer(source).unwrap();
    canvas.remove();
  }
});
