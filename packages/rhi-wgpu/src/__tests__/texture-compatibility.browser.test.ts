import { expect, it } from 'vitest';
import { requestAdapter } from '../index';

it('preserves typed ranges and iterable texture rows through real WebGL2 readback', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const texture = device
    .createTexture({ size: [2, 2, 1], format: 'rgba8unorm', usage: 1 | 2 })
    .unwrap();
  const staging = device.createBuffer({ size: 512, usage: 1 | 8 }).unwrap();
  const source = device.createBuffer({ size: 16, usage: 4 | 8 }).unwrap();
  try {
    const data = new Uint8Array([
      11, 22, 33, 255, 44, 55, 66, 255, 99, 99, 99, 99, 77, 88, 99, 255, 111, 122, 133, 255,
    ]);
    device.queue
      .writeTexture({ texture }, data, { bytesPerRow: 12, rowsPerImage: 2 }, [2, 2, 1].values())
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: staging, bytesPerRow: 256, rowsPerImage: 2 },
      [2, 2, 1].values(),
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    try {
      const pixels = new Uint8Array(mapped.getMappedRange().unwrap());
      expect([...pixels.slice(0, 8), ...pixels.slice(256, 264)]).toEqual([
        11, 22, 33, 255, 44, 55, 66, 255, 77, 88, 99, 255, 111, 122, 133, 255,
      ]);
    } finally {
      mapped.unmap();
    }

    device.queue.writeBuffer(source, 0, new Float32Array([11, 22, 33, 44]), 1, 2).unwrap();
    const copy = device.createCommandEncoder().unwrap();
    copy.copyBufferToBuffer(source, staging);
    device.queue.submit([copy.finish().unwrap()]).unwrap();
    const result = (await staging.mapAsync(1, 0, 16)).unwrap();
    try {
      expect([...new Float32Array(result.getMappedRange(0, 16).unwrap())]).toEqual([22, 33, 0, 0]);
    } finally {
      result.unmap();
    }
  } finally {
    device.destroyBuffer(source).unwrap();
    device.destroyBuffer(staging).unwrap();
    device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
});
