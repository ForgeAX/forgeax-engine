import { readbackTexturePixels } from '@forgeax/engine/rhi-debug';
import * as backend from '@forgeax/engine/rhi-wgpu';
import type { Texture } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { blitMipmapsSync, getOrCreateMipmapPipeline } from '../mipmap-generator';

it.each([
  'rgba8unorm',
  'rgba8unorm-srgb',
] as const)('preserves distinct array layers and every mip on real WebGL2 (%s)', {
  timeout: 60000,
}, async (format) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  await backend.ensureReady();
  const adapter = (await backend.requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const colors = [
    [160, 115, 80, 255],
    [40, 180, 90, 200],
    [128, 128, 255, 220],
  ];
  const textures: Texture[] = [];
  try {
    (await getOrCreateMipmapPipeline(device, format, backend.createShaderModule)).unwrap();
    // A normal-like texture generated immediately after the albedo array
    // must not alter the albedo's lower mips or layer selection.
    for (const palette of [colors, colors.map(() => [128, 128, 255, 220])]) {
      const texture = device
        .createTexture({
          size: [64, 64, colors.length],
          mipLevelCount: 7,
          format,
          usage: 1 | 2 | 4 | 16,
        })
        .unwrap();
      textures.push(texture);
      const data = new Uint8Array(64 * 64 * 4 * colors.length);
      for (const [layer, color] of palette.entries())
        for (let pixel = 0; pixel < 64 * 64; pixel++)
          data.set(color, (layer * 64 * 64 + pixel) * 4);
      device.queue
        .writeTexture({ texture }, data, { bytesPerRow: 256, rowsPerImage: 64 }, [
          64,
          64,
          colors.length,
        ])
        .unwrap();
      blitMipmapsSync(device, texture, {
        width: 64,
        height: 64,
        format,
        arrayLayerCount: colors.length,
      }).unwrap();
    }
    const texture = textures[0];
    if (texture === undefined) throw Error('Missing generated texture');
    for (const [layer, color] of colors.entries())
      for (let mip = 0; mip < 7; mip++) {
        const pixels = await readbackTexturePixels(device, texture, 64 >> mip, 64 >> mip, {
          mipLevel: mip,
          baseArrayLayer: layer,
        });
        for (const [channel, expected] of color.entries())
          for (let at = channel; at < pixels.length; at += 4) {
            expect(pixels[at]).toBeGreaterThanOrEqual(expected - 2);
            expect(pixels[at]).toBeLessThanOrEqual(expected + 2);
          }
      }
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
});
