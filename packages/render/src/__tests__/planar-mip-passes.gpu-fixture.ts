import {
  encodeMipmapLevel,
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
} from '@forgeax/engine-assets-runtime';
import { halfFloat } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { mipDimension, numMipLevels } from '@forgeax/engine-types';
import { assert, expect, vi } from 'vitest';
import { addPlanarMipPasses } from '../record/planar-mip-passes';
import type { RenderPipelineFrame } from '../render-pipeline';

function checkerboardMipInput(
  width: number,
  height: number,
  format: string,
  bytesPerPixel: number,
  update: number,
): Uint8Array {
  const data = new Uint8Array(width * height * bytesPerPixel);
  const words = new DataView(data.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const high = (x + y + update) % 2;
      const rgba =
        format === 'rgba16float'
          ? [high ? 12 : 4, 2 + update, -1, 1]
          : [high ? 255 : 0, 64 + update * 64, 128, 255];
      for (let channel = 0; channel < 4; channel++) {
        const value = rgba[channel];
        assert(value !== undefined);
        const index = (y * width + x) * bytesPerPixel;
        if (format === 'rgba16float')
          words.setUint16(index + channel * 2, halfFloat.f32ToF16(value), true);
        else data[index + channel] = value;
      }
    }
  return data;
}

/** Execute the production graph against its former scratch/copy path on the same device. */
export async function verifyPlanarMipChain(
  device: RhiDevice,
  shaderFactory: MipmapShaderModuleFactory,
  format: 'rgba8unorm' | 'rgba8unorm-srgb' | 'rgba16float',
  width: number,
  height: number,
) {
  (await getOrCreateMipmapPipeline(device, format, shaderFactory)).unwrap();
  const levels = numMipLevels({ width, height });
  const bytesPerPixel = format === 'rgba16float' ? 8 : 4;
  const descriptor = {
    shape: '2d',
    width,
    height,
    format,
    sampleCount: 1,
    mipLevels: 'full',
    sampled: true,
    readback: true,
  } as const;
  const textures: Texture[] = [];
  const graphs = [];
  const layout = Array.from({ length: levels }, (_, mip) => {
    const w = mipDimension(width, mip),
      h = mipDimension(height, mip);
    return { width: w, height: h, stride: Math.ceil((w * bytesPerPixel) / 256) * 256 };
  });
  const blockSize = layout.reduce((n, row) => n + row.stride * row.height, 0);
  const readback = device.createBuffer({ size: blockSize * 2, usage: 9 }).unwrap();
  try {
    for (const backendKind of ['wgpu-webgl2', device.caps.backendKind] as const) {
      const physical = device
        .createTexture({
          size: { width, height },
          format,
          mipLevelCount: levels,
          usage: 23,
        })
        .unwrap();
      textures.push(physical);
      const builder = new RenderGraphBuilder<RenderPipelineFrame>();
      const texture = builder
        .importTexture(
          'mirror',
          {
            size: { width, height },
            format,
            mipLevelCount: levels,
            usage: 23,
          },
          () => physical,
        )
        .unwrap();
      addPlanarMipPasses(
        builder,
        'mirror',
        texture,
        descriptor,
        levels,
        ({ pass, resources, source }) =>
          encodeMipmapLevel(device, pass, resources.textureView(source).unwrap(), format).unwrap(),
        undefined,
        backendKind,
      ).unwrap();
      graphs.push(builder.compile({ device, surfaceSize: { width, height } }).unwrap());
    }
    for (let update = 0; update < 2; update++) {
      const data = checkerboardMipInput(width, height, format, bytesPerPixel, update);
      for (const texture of textures)
        device.queue
          .writeTexture(
            { texture },
            data,
            { bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
            [width, height, 1],
          )
          .unwrap();
      for (const [index, graph] of graphs.entries()) {
        const encoder = device.createCommandEncoder().unwrap();
        const copy = vi.spyOn(encoder, 'copyTextureToTexture');
        // These graph callbacks use only the encoder and resource resolver.
        graph.execute({ encoder } as RenderPipelineFrame).unwrap();
        expect(copy).toHaveBeenCalledTimes(
          index === 0 || device.caps.backendKind === 'wgpu-webgl2' ? levels - 1 : 0,
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
      }
      const encoder = device.createCommandEncoder().unwrap();
      for (const [index, texture] of textures.entries()) {
        let offset = index * blockSize;
        for (const [mipLevel, row] of layout.entries()) {
          encoder.copyTextureToBuffer(
            { texture, mipLevel },
            { buffer: readback, offset, bytesPerRow: row.stride, rowsPerImage: row.height },
            { width: row.width, height: row.height, depthOrArrayLayers: 1 },
          );
          offset += row.stride * row.height;
        }
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
      let offset = 0;
      for (const row of layout) {
        for (let y = 0; y < row.height; y++) {
          const start = offset + y * row.stride;
          expect(
            bytes.slice(blockSize + start, blockSize + start + row.width * bytesPerPixel),
          ).toEqual(bytes.slice(start, start + row.width * bytesPerPixel));
        }
        offset += row.stride * row.height;
      }
      // Independent known average on an even checkerboard, including linear HDR and sRGB decode/encode.
      if (width === 8 && height === 8) {
        const final = blockSize - 256;
        if (format === 'rgba16float') {
          const view = new DataView(bytes.buffer, bytes.byteOffset);
          expect(view.getUint16(final, true)).toBe(halfFloat.f32ToF16(8));
          expect(view.getUint16(final + 2, true)).toBe(halfFloat.f32ToF16(2 + update));
        } else
          expect(
            Math.abs((bytes[final] ?? 0) - (format.endsWith('srgb') ? 188 : 128)),
          ).toBeLessThanOrEqual(1);
      }
      mapped.unmap();
    }
  } finally {
    for (const graph of graphs) (await graph.retire()).unwrap();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
