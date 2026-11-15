/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

it('queries actual atmospheric BSM with an unfilterable32F map and independent atmosphere strength', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = await compileShader(
    `
#import forgeax_view::common::{View, AtmosphereMedium}
#import forgeax_atmosphere::visibility::{atmosphere_visibility_sample}
@group(1) @binding(0) var depth: texture_depth_2d_array;
@group(1) @binding(1) var compare: sampler_comparison;
@group(1) @binding(2) var cloud: texture_2d<f32>;
@group(1) @binding(3) var filtering: sampler;
@group(1) @binding(4) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn main() {
  var v: View;
  var m: AtmosphereMedium;
  v.cloudShadowOrigin=vec4f(0.0,100.0,0.0,0.0);
  v.cloudShadowRight=vec4f(1.0,0.0,0.0,1.0);
  v.cloudShadowProjection=vec4f(100.0,0.0,0.0,1.0);
  v.cloudShadowUp=vec3f(0.0,0.0,-1.0);
  output[0]=atmosphere_visibility_sample(v,m,vec3f(0.0),depth,compare,cloud,filtering);
  v.cloudShadowProjection.y=1.0;
  v.cloudShadowRight.w=0.0;
  output[1]=atmosphere_visibility_sample(v,m,vec3f(0.0),depth,compare,cloud,filtering);
  v.cloudShadowRight.w=0.25;
  output[2]=atmosphere_visibility_sample(v,m,vec3f(0.0),depth,compare,cloud,filtering);
}`,
    { id: 'actual-atmosphere-shadow-test.wgsl', imports: engine.imports },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1') {
    expect(adapter.info.isFallbackAdapter).toBe(false);
    process.stdout.write(
      `atmosphere-shadow-device ${JSON.stringify({ vendor: adapter.info.vendor, device: adapter.info.device, isFallbackAdapter: adapter.info.isFallbackAdapter })}\n`,
    );
  }
  const device = await adapter.requestDevice();
  const map = device.createTexture({
    size: [2, 2],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const depth = device.createTexture({
    size: [1, 1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const output = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const empty = device.createBindGroupLayout({ entries: [] });
    const bindings = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'depth', viewDimension: '2d-array' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, bindings] }),
      compute: { module, entryPoint: 'main' },
    });
    device.queue.writeTexture(
      { texture: map },
      new Float32Array([10, 0.01, 1, 0, 10, 0.01, 1, 0, 10, 0.01, 1, 0, 10, 0.01, 1, 0]),
      { bytesPerRow: 32 },
      [2, 2],
    );
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      })
      .end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: empty, entries: [] }));
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: bindings,
        entries: [
          { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
          { binding: 1, resource: device.createSampler({ compare: 'less' }) },
          { binding: 2, resource: map.createView() },
          {
            binding: 3,
            resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          },
          { binding: 4, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const expected = [Math.exp(-0.9), 1, 0.75 + 0.25 * Math.exp(-0.9)];
    for (let index = 0; index < 3; index++)
      expect(
        Math.abs((values[index] ?? Number.NaN) - (expected[index] ?? Number.NaN)),
      ).toBeLessThan(1e-4);
    process.stdout.write(
      `atmosphere-shadow-readback ${JSON.stringify({ actual: [...values], expected })}\n`,
    );
  } finally {
    map.destroy();
    depth.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
}, 30000);
