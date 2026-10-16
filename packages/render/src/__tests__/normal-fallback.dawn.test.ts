import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';
import { texelFallbackDescriptor, writeTexelFallback } from '../ibl/skylight-bind-group';

it('samples the actual renderer fallback payload as an exactly neutral tangent normal', async () => {
  const owner = readFileSync(
    resolve(process.cwd(), 'packages/render/src/assembly/webgpu-ready.ts'),
    'utf8',
  );
  const construction = owner.slice(
    owner.indexOf('const fallbackNormalTextureDescriptor ='),
    owner.indexOf('const fallbackNormalTextureViewResult ='),
  );
  const format = construction.match(/'fallback-normal-1x1',\s*'([^']+)'/)?.[1];
  if (format !== 'rgba8unorm' && format !== 'rgba16float')
    throw new Error('Unexpected normal fallback format');
  const payloadSource = construction.slice(
    construction.indexOf('const fallbackNormalTexel ='),
    construction.indexOf('const fallbackNormalWriteResult ='),
  );
  const texel = new Function(`${payloadSource}; return fallbackNormalTexel;`)() as Uint16Array;
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/tbn.wgsl'),
    'utf8',
  ).replace(/^#define_import_path.*$/gm, '');
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const descriptor = texelFallbackDescriptor('normal-fallback-probe', format);
  const texture = device.createTexture(descriptor).unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  const output = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    writeTexelFallback(device.queue, texture, descriptor, texel).unwrap();
    const module = createShaderModuleImmediate(device, {
      code: `${source}
@group(0) @binding(0) var normalTexture: texture_2d<f32>;
@group(0) @binding(1) var normalSampler: sampler;
@group(0) @binding(2) var<storage, read_write> result: vec4<f32>;
@compute @workgroup_size(1) fn probe() {
  let encoded = textureSampleLevel(normalTexture, normalSampler, vec2<f32>(0.37, 0.61), 0.0);
  result = vec4<f32>(decodeTangentSpaceNormalRg(encoded.rg), encoded.a);
}`,
    }).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'float', viewDimension: '2d' },
          },
          { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const pipeline = device
      .createComputePipeline({ layout, compute: { module, entryPoint: 'probe' } })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const result = Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0)));
    mapped.unmap();
    expect(result).toEqual([0, 0, 1, 1]);
  } finally {
    device.destroyTexture(texture).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
