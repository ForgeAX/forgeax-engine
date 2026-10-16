import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { gbufferSource } from './standard-gbuffer.fixture';

type Pixel = readonly [number, number, number, number];

const BYTES_PER_PIXEL = 8;
const READBACK_BYTES_PER_ROW = 256;

function readShader(name: string): string {
  return readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function floatToHalf(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0xfc00 : 0x7c00;
  const sign = value < 0 ? 0x8000 : 0;
  const absolute = Math.abs(value);
  if (absolute === 0) return sign;
  if (absolute >= 65504) return sign | 0x7bff;
  const exponent = Math.floor(Math.log2(absolute));
  if (exponent < -14) return sign | Math.round(absolute / 2 ** -24);
  const mantissa = absolute / 2 ** exponent - 1;
  return sign | ((exponent + 15) << 10) | Math.round(mantissa * 1024);
}

async function createDevice() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

async function compileTemporalShader(): Promise<string> {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const result = await compiler.compileShader(readShader('ssr-temporal'), {
    id: 'forgeax_ssr::temporal',
    imports: {
      'forgeax_view::common': readShader('common'),
      'forgeax_pbr::gbuffer': gbufferSource,
    },
  });
  if (!result.ok || result.value === undefined) throw new Error(JSON.stringify(result.error));
  return result.value.wgsl;
}

async function runReducer(
  shader: string,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  sourcePixels: readonly Pixel[],
): Promise<number[]> {
  const device = await createDevice();
  const source = device
    .createTexture({
      size: { width: sourceWidth, height: sourceHeight, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const target = device
    .createTexture({
      size: { width: targetWidth, height: targetHeight, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: READBACK_BYTES_PER_ROW * targetHeight,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    const packed = new Uint16Array(sourceWidth * sourceHeight * 4);
    for (let i = 0; i < sourcePixels.length; i++) {
      const pixel = sourcePixels[i];
      if (pixel === undefined) throw new Error(`missing source pixel ${i}`);
      for (const channel of [0, 1, 2, 3] as const) {
        packed[i * 4 + channel] = floatToHalf(pixel[channel]);
      }
    }
    device.queue
      .writeTexture(
        { texture: source },
        packed,
        {
          bytesPerRow: sourceWidth * BYTES_PER_PIXEL,
          rowsPerImage: sourceHeight,
        },
        { width: sourceWidth, height: sourceHeight, depthOrArrayLayers: 1 },
      )
      .unwrap();

    const module = createShaderModuleImmediate(device, { code: shader }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          {
            binding: 7,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'ssr_reflection_mip' },
      })
      .unwrap();
    const sourceView = device.createTextureView(source, { dimension: '2d' }).unwrap();
    const targetView = device.createTextureView(target, { dimension: '2d' }).unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: sourceView } },
          { binding: 7, resource: { kind: 'textureView', value: targetView } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(targetWidth / 8), Math.ceil(targetHeight / 8), 1);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: READBACK_BYTES_PER_ROW, rowsPerImage: targetHeight },
      { width: targetWidth, height: targetHeight, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const bytes = new DataView(mapped.getMappedRange().unwrap().slice(0));
    const values: number[] = [];
    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const offset = y * READBACK_BYTES_PER_ROW + x * BYTES_PER_PIXEL;
        for (let channel = 0; channel < 4; channel++) {
          values.push(halfToFloat(bytes.getUint16(offset + channel * 2, true)));
        }
      }
    }
    mapped.unmap();
    return values;
  } finally {
    device.destroyTexture(source).unwrap();
    device.destroyTexture(target).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}

function averageFootprint(
  pixels: readonly Pixel[],
  sourceWidth: number,
  sourceHeight: number,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
): Pixel {
  const firstX = Math.floor((targetX * sourceWidth) / targetWidth);
  const endX = Math.floor(((targetX + 1) * sourceWidth) / targetWidth);
  const firstY = Math.floor((targetY * sourceHeight) / targetHeight);
  const endY = Math.floor(((targetY + 1) * sourceHeight) / targetHeight);
  const sum: [number, number, number, number] = [0, 0, 0, 0];
  let count = 0;
  for (let y = firstY; y < endY; y++) {
    for (let x = firstX; x < endX; x++) {
      const pixel = pixels[y * sourceWidth + x];
      if (pixel === undefined) throw new Error(`missing footprint pixel ${x},${y}`);
      for (const channel of [0, 1, 2, 3] as const) sum[channel] += pixel[channel];
      count += 1;
    }
  }
  if (count === 0) throw new Error(`empty footprint at ${targetX},${targetY}`);
  return [sum[0] / count, sum[1] / count, sum[2] / count, sum[3] / count];
}

it('uses the production four-load 2x2 reducer for even extents', async () => {
  const sourceWidth = 6;
  const sourceHeight = 4;
  const targetWidth = 3;
  const targetHeight = 2;
  const pixels = Array.from({ length: sourceWidth * sourceHeight }, (_, index): Pixel => {
    const x = index % sourceWidth;
    const y = Math.floor(index / sourceWidth);
    return [1 + x + y * sourceWidth, 0.25 + x * 0.5, 0.5 + y * 0.75, 0.25 + ((x + y) % 4) * 0.25];
  });
  const values = await runReducer(
    await compileTemporalShader(),
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    pixels,
  );
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const expected = averageFootprint(
        pixels,
        sourceWidth,
        sourceHeight,
        x,
        y,
        targetWidth,
        targetHeight,
      );
      const offset = (y * targetWidth + x) * 4;
      for (const channel of [0, 1, 2, 3] as const) {
        expect(values[offset + channel]).toBeCloseTo(expected[channel], 2);
      }
    }
  }
});

it('keeps the explicit footprint reducer for odd extents and bounded confidence', async () => {
  const sourceWidth = 5;
  const sourceHeight = 3;
  const targetWidth = 2;
  const targetHeight = 1;
  const pixels = Array.from({ length: sourceWidth * sourceHeight }, (_, index): Pixel => {
    const x = index % sourceWidth;
    const y = Math.floor(index / sourceWidth);
    return [0.5 + x * 0.25, 2 + y, 0.125 + (x + y) * 0.0625, ((x + y) % 5) * 0.25];
  });
  const values = await runReducer(
    await compileTemporalShader(),
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    pixels,
  );
  for (let x = 0; x < targetWidth; x++) {
    const expected = averageFootprint(
      pixels,
      sourceWidth,
      sourceHeight,
      x,
      0,
      targetWidth,
      targetHeight,
    );
    const offset = x * 4;
    for (const channel of [0, 1, 2, 3] as const) {
      expect(values[offset + channel]).toBeCloseTo(expected[channel], 2);
    }
    expect(values[offset + 3]).toBeGreaterThanOrEqual(0);
    expect(values[offset + 3]).toBeLessThanOrEqual(1);
    expect(values.slice(offset, offset + 4).every(Number.isFinite)).toBe(true);
  }
});

it('keeps premultiplied radiance through hit and miss footprints', async () => {
  const pixels: readonly Pixel[] = [
    [4, 2, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 1, 0.5, 0.5],
  ];
  const values = await runReducer(await compileTemporalShader(), 2, 2, 1, 1, pixels);
  // The input is the presentation representation (a * L, a). A miss carries
  // no RGB mass, so the reduced value remains premultiplied rather than
  // turning into a black radiance sample.
  expect(values[0]).toBeCloseTo(1.5, 2);
  expect(values[1]).toBeCloseTo(0.75, 2);
  expect(values[2]).toBeCloseTo(0.375, 2);
  expect(values[3]).toBeCloseTo(0.375, 2);
  expect(values[3]).toBeGreaterThan(0);
  const [red, green, blue, alpha] = values;
  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
    throw new Error('the reducer must return one complete RGBA pixel');
  }
  expect(red / alpha).toBeCloseTo(4, 2);
  expect(green / alpha).toBeCloseTo(2, 2);
  expect(blue / alpha).toBeCloseTo(1, 2);
});
