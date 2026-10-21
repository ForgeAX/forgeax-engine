import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { numMipLevels } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';

it.each([
  ['rgba8unorm-srgb', 1, 188, false],
  ['rgba8unorm', 1, 128, false],
  ['rgba8unorm-srgb', 2, 188, true],
  ['rgba8unorm', 2, 128, true],
  ['rgba8unorm', 100, 64, false],
  ['rgba8unorm', 256, 128, true],
] as const)(
  'uploads %s at width %i with byte %i and generated mips %s',
  async (format, width, value, mipmap) => {
    const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const raw = gpu._internal_getRawDevice(device);
    assert(raw);
    raw.pushErrorScope('validation');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const assets = new AssetRegistry();
    const bytes = new Uint8Array(width * width * 4);
    for (let offset = 0; offset < bytes.length; offset += 4)
      bytes.set([value, value, value, 255], offset);
    const source: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height: width } },
      format,
      colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
      data: bytes,
      mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
    };
    const handle = assets.create(source).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      (_owner, descriptor) => gpu.createShaderModule(device, descriptor),
      device.caps,
    );
    let readback: ReturnType<typeof device.createBuffer> | undefined;
    try {
      (await store.uploadTexture(handle, source)).unwrap();
      const mipWork = store.prepareTextureMips().unwrap();
      if (mipWork !== undefined) {
        device.queue.submit([mipWork.buffer]).unwrap();
        mipWork.complete(true);
      }
      const texture = store._getTextureGpuTexture(handle);
      assert(texture);
      const write = vi.spyOn(device.queue, 'writeTexture');
      for (let frame = 0; frame < 60; frame++) store.ensureResident(handle, source).unwrap();
      expect(write).not.toHaveBeenCalled();
      const mipLevel = mipmap ? numMipLevels({ width, height: width }) - 1 : 0;
      const extent = Math.max(1, width >> mipLevel);
      const bytesPerRow = Math.ceil((extent * 4) / 256) * 256;
      readback = device.createBuffer({ size: bytesPerRow * extent, usage: 9 });
      const buffer = readback.unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyTextureToBuffer(
        { texture: texture.handle, mipLevel },
        { buffer, bytesPerRow, rowsPerImage: extent },
        { width: extent, height: extent, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await buffer.mapAsync(1)).unwrap();
      const pixels = new Uint8Array(mapped.getMappedRange().unwrap());
      for (let y = 0; y < extent; y++)
        for (let x = 0; x < extent; x++) {
          const offset = y * bytesPerRow + x * 4;
          for (let channel = 0; channel < 3; channel++)
            expect(Math.abs((pixels[offset + channel] ?? -1000) - value)).toBeLessThanOrEqual(1);
          expect(pixels[offset + 3]).toBe(255);
        }
      mapped.unmap();
      await device.queue.onSubmittedWorkDone();
      expect(await raw.popErrorScope()).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      if (readback?.ok) device.destroyBuffer(readback.value).unwrap();
      store.destroyAll();
      assets.dispose();
      raw.destroy();
    }
  },
  60_000,
);
