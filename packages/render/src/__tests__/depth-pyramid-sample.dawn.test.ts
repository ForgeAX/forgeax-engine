import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { buildDepthPyramidPlan } from '../depth-pyramid/plan';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';

const LANES = 64;

const readShader = (name: string) =>
  readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');

// Pyramid consumers pick a level per pixel. Every lane of one workgroup here
// asks for a different level, which is the divergent case where lavapipe
// answered textureDimensions(t, level) with the first lane's level and a
// consumer read clamped, wrong texels.
it('derives divergent per-lane extents and complete even/odd footprints exactly', async () => {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const probe = await compiler.compileShader(
    `#import forgeax_depth_pyramid::sample::{depthPyramidLevelSize, depthPyramidFootprintStart, depthPyramidFootprintEnd}
@group(0) @binding(0) var pyramid : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> sizes : array<vec2<u32>>;
@compute @workgroup_size(${LANES}, 1, 1)
fn probe(@builtin(local_invocation_index) lane : u32) {
  let fine = depthPyramidLevelSize(pyramid, lane % textureNumLevels(pyramid));
  let coarse = max(fine / 2u, vec2<u32>(1u));
  let cell = select(vec2<u32>(lane, lane * 3u) % coarse, coarse - 1u, lane >= ${LANES / 2}u);
  sizes[lane] = fine;
  sizes[${LANES}u + lane] = depthPyramidFootprintStart(cell, fine, coarse);
  sizes[${2 * LANES}u + lane] = depthPyramidFootprintEnd(cell, fine, coarse);
}`,
    {
      id: 'forgeax_depth_pyramid::level-size-probe',
      imports: { 'forgeax_depth_pyramid::sample': readShader('depth-pyramid-sample') },
    },
  );
  if (!probe.ok || !probe.value) throw new Error(JSON.stringify(probe.error));
  const extent = { width: 37, height: 23 };
  const levels = buildDepthPyramidPlan(extent).levels;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const pyramid = device
    .createTexture({
      size: { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
      mipLevelCount: levels.length,
      format: 'r32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const output = device
    .createBuffer({ size: LANES * 24, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({
      size: LANES * 24,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  try {
    const module = createShaderModuleImmediate(device, { code: probe.value.wgsl }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'probe' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(pyramid, {}).unwrap(),
            },
          },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, LANES * 24);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const sizes = Array.from(new Uint32Array(mapped.getMappedRange().unwrap().slice(0)));
    mapped.unmap();

    const expected = Array.from({ length: LANES }, (_, lane) => {
      const level = levels[lane % levels.length];
      return [level?.width ?? 0, level?.height ?? 0];
    }).flat();
    const footprints = Array.from({ length: LANES }, (_, lane) => {
      const level = levels[lane % levels.length];
      if (!level) throw new Error('missing expected level');
      const fine = [level.width, level.height];
      const coarse = fine.map((value) => Math.max(1, Math.floor(value / 2)));
      const cell = coarse.map((value, axis) =>
        lane >= LANES / 2 ? value - 1 : (lane * (axis === 0 ? 1 : 3)) % value,
      );
      return {
        start: fine.map((value, axis) =>
          Math.floor(((cell[axis] ?? 0) * value) / (coarse[axis] ?? 1)),
        ),
        end: fine.map((value, axis) =>
          Math.min(value, Math.ceil((((cell[axis] ?? 0) + 1) * value) / (coarse[axis] ?? 1))),
        ),
      };
    });
    expect(sizes).toEqual([
      ...expected,
      ...footprints.flatMap((value) => value.start),
      ...footprints.flatMap((value) => value.end),
    ]);
  } finally {
    device.destroyTexture(pyramid).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
