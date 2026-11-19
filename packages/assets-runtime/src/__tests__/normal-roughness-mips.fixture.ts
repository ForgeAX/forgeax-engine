import type { RhiDevice } from '@forgeax/engine-rhi';
import { numMipLevels } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { readbackTexturePixels } from '../../../rhi-debug/src/readback';
import {
  blitMipmapsSync,
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
} from '../mipmap-generator';

/** Test-only readback of actual generated array mips. Production never reads pixels. */
export async function verifyNormalRoughnessMips(
  device: RhiDevice,
  factory: MipmapShaderModuleFactory,
) {
  const width = 22,
    height = 10,
    layers = 2,
    levels = numMipLevels({ width, height });
  (await getOrCreateMipmapPipeline(device, 'rgba8unorm', factory, 'normal-roughness')).unwrap();
  const texture = device
    .createTexture({
      size: [width, height, layers],
      mipLevelCount: levels,
      format: 'rgba8unorm',
      usage: 1 | 2 | 4 | 16,
    })
    .unwrap();
  const data = new Uint8Array(width * height * layers * 4);
  for (let layer = 0; layer < layers; layer++)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.set(
          [layer === 1 && x % 2 === 0 ? 51 : 204, 230, 128, 0],
          ((layer * height + y) * width + x) * 4,
        );
  device.queue
    .writeTexture({ texture }, data, { bytesPerRow: width * 4, rowsPerImage: height }, [
      width,
      height,
      layers,
    ])
    .unwrap();
  const descriptor = {
    width,
    height,
    format: 'rgba8unorm' as const,
    arrayLayerCount: layers,
    filter: 'normal-roughness' as const,
  };
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      blitMipmapsSync(device, texture, descriptor).unwrap();
      for (let layer = 0; layer < layers; layer++)
        for (let mip = 0; mip < levels; mip++) {
          const pixels = await readbackTexturePixels(
            device,
            texture,
            Math.max(1, width >> mip),
            Math.max(1, height >> mip),
            { baseArrayLayer: layer, mipLevel: mip },
          );
          for (let i = 0; i < pixels.length; i += 4) {
            if (mip === 0) expect(pixels[i + 3]).toBe(0);
            else if (layer === 0) {
              expect(pixels[i]).toBeGreaterThanOrEqual(202);
              expect(pixels[i]).toBeLessThanOrEqual(206);
              expect(pixels[i + 3]).toBe(0); // No artificial variance, including tilted normals.
            } else {
              expect(pixels[i]).toBeGreaterThanOrEqual(126);
              expect(pixels[i]).toBeLessThanOrEqual(129);
              // Analytic opposing normals: mean length ~= .8, perceptual floor ~= .70.
              expect(pixels[i + 3]).toBeGreaterThanOrEqual(175);
              expect(pixels[i + 3]).toBeLessThanOrEqual(182);
            }
          }
        }
    }
  } finally {
    device.destroyTexture(texture).unwrap();
  }
}
