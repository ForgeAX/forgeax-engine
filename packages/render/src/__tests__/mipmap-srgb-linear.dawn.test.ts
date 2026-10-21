import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { numMipLevels, type TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

it.each([
  { name: 'sRGB mid-gray', format: 'rgba8unorm-srgb', width: 2, values: [188], expected: 188 },
  { name: 'linear mid-gray', format: 'rgba8unorm', width: 2, values: [128], expected: 128 },
  { name: 'nine-level chain', format: 'rgba8unorm', width: 256, values: [128], expected: 128 },
  {
    name: 'sRGB black-white average',
    format: 'rgba8unorm-srgb',
    width: 2,
    values: [0, 255],
    expected: 188,
  },
  {
    name: 'linear black-white average',
    format: 'rgba8unorm',
    width: 2,
    values: [0, 255],
    expected: 128,
  },
] as const)('uploads $name through managed residency and reads the real final mip', async ({
  format,
  width,
  values,
  expected,
}) => {
  const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = gpu._internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => gpu.createShaderModule(device, descriptor),
    device.caps,
  );
  const levels = numMipLevels({ width, height: width });
  const data = new Uint8Array(width * width * 4);
  for (let pixel = 0; pixel < width * width; pixel++) {
    const value = values[pixel % values.length] ?? 0;
    data.set([value, value, value, 255], pixel * 4);
  }
  const asset: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height: width } },
    format,
    colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
    mips: { kind: 'generate' },
    data,
  };
  const readback = device.createBuffer({ size: 256, usage: 9 }).unwrap();
  try {
    const reference = assets.create(asset).unwrap();
    (await store.uploadTexture(reference, assets.read(reference).unwrap())).unwrap();
    const mipWork = store.prepareTextureMips().unwrap();
    if (mipWork !== undefined) {
      assert(mipWork.buffer);
      device.queue.submit([mipWork.buffer]).unwrap();
      mipWork.complete(true);
    }
    const texture = store._getTextureGpuTexture(reference);
    assert(texture);
    expect(levels).toBe(width === 256 ? 9 : 2);
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture: texture.handle, mipLevel: levels - 1 },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const pixel = new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4);
    mapped.unmap();
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs((pixel[channel] ?? 0) - expected)).toBeLessThanOrEqual(1);
    expect(pixel[3]).toBe(255);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    store.destroyAll();
    assets.dispose();
    raw.destroy();
  }
});
