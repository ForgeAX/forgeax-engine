import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { halfFloat } from '@forgeax/engine-math';
import type { Texture } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

async function composePixels(
  width: number,
  normals: number[],
  radiance: number[],
  options: {
    mips?: number[][];
    enabled?: number;
    roughnessLimit?: number;
    coverage?: number;
    source?: string;
    height?: number;
  } = {},
) {
  const height = options.height ?? 2;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const common = readFileSync(resolve(process.cwd(), 'packages/shader/src/common.wgsl'), 'utf8');
  const viewDeclarations = common.match(/struct (?:AtmosphereMedium|View)\s*\{[\s\S]*?\};/g);
  expect(viewDeclarations).toHaveLength(2);
  if (viewDeclarations?.length !== 2) throw new Error('Shared View declarations missing');
  const viewStruct = viewDeclarations.join('\n');
  const source = (
    options.source ??
    readFileSync(resolve(process.cwd(), 'packages/shader/src/ssr-compose.wgsl'), 'utf8')
  )
    .replace(/^#define_import_path.*$/gm, '')
    .replace('#import forgeax_view::common::View', viewStruct)
    .replace(
      /^#import forgeax_pbr::gbuffer.*$/gm,
      gbufferSource.replace(/^#define_import_path.*$/gm, ''),
    );
  const textures: Texture[] = [];
  const upload = (width: number, height: number, values: number[], mips: number[][] = []) => {
    const texture = device
      .createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        // Match the production resolved pyramid. rgba16float is filterable
        // without requiring the optional float32-filterable feature.
        format: 'rgba16float',
        mipLevelCount: mips.length + 1,
        textureBindingViewDimension: '2d',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap();
    textures.push(texture);
    for (const [level, data] of [values, ...mips].entries()) {
      const bytes = halfFloat.f32ToF16Bytes(new Uint8Array(new Float32Array(data).buffer));
      device.queue
        .writeTexture(
          { texture, mipLevel: level },
          bytes,
          {
            bytesPerRow: Math.max(1, width >> level) * 8,
            rowsPerImage: Math.max(1, height >> level),
          },
          {
            width: Math.max(1, width >> level),
            height: Math.max(1, height >> level),
            depthOrArrayLayers: 1,
          },
        )
        .unwrap();
    }
    return device.createTextureView(texture, {}).unwrap();
  };
  const repeat = (value: number[]) => Array.from({ length: width * height }, () => value).flat();
  const packed = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'r32uint',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  textures.push(packed);
  writePackedNormals(device, packed, width, height, normals);
  const views = [
    upload(width, height, radiance, options.mips),
    upload(width, height, repeat([0.1, 0.1, 0.1, options.coverage ?? 1])),
    upload(width, height, repeat([1, 1, 1, 1])),
    device.createTextureView(packed, {}).unwrap(),
  ];
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const viewData = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  viewData[238] = options.roughnessLimit ?? 1;
  viewData[239] = options.enabled ?? 1;
  device.queue.writeBuffer(view, 0, viewData).unwrap();
  const output = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
  textures.push(output);
  const readback = device
    .createBuffer({
      size: Math.max(512, 256 * height),
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  const sampler = device
    .createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
    })
    .unwrap();
  try {
    const module = createShaderModuleImmediate(device, { code: source }).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          ...views.map((_, binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: {
              sampleType:
                binding === 3
                  ? ('uint' as const)
                  : binding === 0
                    ? ('float' as const)
                    : ('unfilterable-float' as const),
              viewDimension: '2d' as const,
            },
          })),
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' as const },
          },
          {
            binding: 5,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' as const },
          },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs_ssr_compose', buffers: [] },
        fragment: { module, entryPoint: 'fs_ssr_compose', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          ...views.map((value, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value },
          })),
          { binding: 4, resource: { kind: 'sampler' as const, value: sampler } },
          { binding: 5, resource: { kind: 'buffer' as const, value: { buffer: view } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(output, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const pixels = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return pixels;
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(view).unwrap();
  }
}

it('keeps each full-resolution receiver on its own ray, including one-pixel faces', async () => {
  const normals = [0.5, 1, 0.5, 0.08, 1, 0.5, 0.5, 0.08, 0.5, 1, 0.5, 0.08, 0.5, 0.5, 1, 0.08];
  const radiance = [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0];
  const pixels = await composePixels(2, normals, radiance);
  expect(
    pixels.slice(4, 8).every((value) => value === 0),
    'side face',
  ).toBe(true);
  expect(
    pixels.slice(68, 72).every((value) => value === 0),
    'wall face',
  ).toBe(true);
  expect(pixels[0], 'red first row').toBeCloseTo(0.9, 3);
  expect(pixels[1]).toBeCloseTo(-0.1, 3);
  expect(pixels[64], 'green second row').toBeCloseTo(-0.1, 3);
  expect(pixels[65]).toBeCloseTo(0.9, 3);
});

it('keeps the rough reflected lobe beyond a mirror miss without admitting disabled receivers', async () => {
  // A 2x2 confidence-premultiplied step has a single 1x1 average.
  const radiance = [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
  const mips = [[0.5, 0, 0, 0.5]];
  const normals = Array.from({ length: 4 }, () => [0.5, 1, 0.5, 0.75]).flat();
  const pixels = await composePixels(2, normals, radiance, { mips });
  const confidence = 0.5 * (Math.round(0.75 * 255) / 255) ** 2;
  const fallback = 0.0999755859375;
  expect(pixels[4], 'rough lobe red at the missing central ray').toBeCloseTo(
    confidence * (1 - fallback),
    4,
  );
  expect(pixels[5], 'weighted fallback replacement').toBeCloseTo(-confidence * fallback, 4);
  for (const options of [
    { enabled: 0 },
    { enabled: Number.NaN },
    { enabled: Infinity },
    { roughnessLimit: 0 },
    { roughnessLimit: 0.65 },
    { roughnessLimit: 0.74 },
    { coverage: 0 },
  ]) {
    const guarded = await composePixels(2, normals, radiance, { ...options, mips });
    expect(guarded.slice(4, 8).every((value) => value === 0)).toBe(true);
  }
});

it('samples the roughness pyramid at pixel centers without a half-pixel drift', async () => {
  const source = readFileSync(resolve('packages/shader/src/ssr-compose.wgsl'), 'utf8');
  const radiance = Array.from({ length: 16 }, (_, i) => [i / 16, 0, 0, 1]).flat();
  const mips = [
    [2.5 / 16, 0, 0, 1, 4.5 / 16, 0, 0, 1, 10.5 / 16, 0, 0, 1, 12.5 / 16, 0, 0, 1],
    [7.5 / 16, 0, 0, 1],
  ];
  const normals = Array.from({ length: 16 }, () => [0.5, 1, 0.5, 0.75]).flat();
  const pixels = await composePixels(4, normals, radiance, { height: 4, mips });
  const roughness = Math.round(0.75 * 255) / 255;
  const lodFraction = roughness ** 2 * 2 - 1;
  // At pixel (1,1), the mip-1 bilinear footprint has weights 9/16,3/16,3/16,1/16.
  const mip1 = (2.5 * 9 + 4.5 * 3 + 10.5 * 3 + 12.5) / 256;
  const expected = mip1 * (1 - lodFraction) + (7.5 / 16) * lodFraction - 0.0999755859375;
  expect(pixels[64 + 4]).toBeCloseTo(expected, 3);
  const shifted = source.replace(
    'let uv = in.position.xy /',
    'let uv = (in.position.xy + vec2<f32>(0.5)) /',
  );
  expect(shifted).not.toBe(source);
  const wrong = await composePixels(4, normals, radiance, { height: 4, mips, source: shifted });
  expect(
    Math.abs((wrong[68] ?? 0) - expected),
    'old extra half-pixel is observable',
  ).toBeGreaterThan(0.05);
});
