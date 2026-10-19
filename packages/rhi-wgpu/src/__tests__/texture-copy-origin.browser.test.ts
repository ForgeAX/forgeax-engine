import type { MappedBuffer } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { requestAdapter } from '../index';

it('preserves nonzero array origins through upload, texture copies and WebGL2 readback', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const source = device
    .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x01 | 0x02 | 0x10 })
    .unwrap();
  const target = device
    .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x01 | 0x02 | 0x10 })
    .unwrap();
  const upload = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }).unwrap();
  const readback = device.createBuffer({ size: 768, usage: 0x01 | 0x08 }).unwrap();
  const red = [220, 30, 60, 255];
  const green = [20, 200, 90, 255];
  let mapped: MappedBuffer | undefined;
  try {
    device.queue
      .writeTexture({ texture: source, origin: [1, 2, 0] }, new Uint8Array(red), {}, [1, 1])
      .unwrap();
    device.queue.writeBuffer(upload, 0, new Uint8Array(green)).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToTexture(
      { buffer: upload, bytesPerRow: 256 },
      { texture: source, origin: [2, 1] },
      [1, 1],
    );
    encoder.copyTextureToTexture(
      { texture: source, origin: [1, 2] },
      { texture: target, origin: [3, 1] },
      [1, 1],
    );
    encoder.copyTextureToTexture(
      { texture: source, origin: [2, 1] },
      { texture: target, origin: [1, 3] },
      [1, 1],
    );
    encoder.copyTextureToBuffer(
      { texture: target, origin: [1, 1] },
      { buffer: readback, bytesPerRow: 256 },
      [3, 3],
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    mapped = (await readback.mapAsync(1)).unwrap();
    const pixels = new Uint8Array(mapped.getMappedRange().unwrap());
    expect([...pixels.slice(8, 12)]).toEqual(red);
    expect([...pixels.slice(512, 516)]).toEqual(green);
    expect([...pixels.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(canvas.getContext('webgl2')?.getError()).toBe(0);
  } finally {
    mapped?.unmap();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(upload).unwrap();
    device.destroyTexture(target).unwrap();
    device.destroyTexture(source).unwrap();
    canvas.remove();
  }
});
