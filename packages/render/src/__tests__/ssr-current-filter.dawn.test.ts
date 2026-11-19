import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

it('reconstructs a half-density current trace using its own lattice and full-size receivers', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = readFileSync(resolve('packages/shader/src/ssr-temporal.wgsl'), 'utf8');
  const compiled = (
    await compiler.compileShader(
      `${source}
@group(1) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_current() {
  let coordinates = array<vec2<f32>,5>(vec2<f32>(0.25),vec2<f32>(0.375,0.25),vec2<f32>(0.5),vec2<f32>(0.625,0.25),vec2<f32>(0.75));
  for (var i=0u; i<5u; i++) { result[i]=sampleCurrentSsr(coordinates[i],vec2<u32>(4u),4.0,vec3<f32>(0.0,0.0,1.0)).color; }
}`,
      {
        id: 'forgeax_ssr::temporal',
        imports: {
          'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
          'forgeax_pbr::gbuffer': gbufferSource,
          forgeax_scene_temporal: readFileSync(
            resolve('packages/shader/src/scene-temporal.wgsl'),
            'utf8',
          ),
        },
      },
    )
  ).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = (
    width: number,
    height: number,
    format: 'rgba32float' | 'depth32float' | 'r32uint',
    usage: number,
  ) =>
    device
      .createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        format,
        textureBindingViewDimension: '2d',
        usage,
      })
      .unwrap();
  const sampled = GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST;
  const trace = texture(2, 2, 'rgba32float', sampled);
  const reactive = texture(2, 2, 'rgba32float', sampled);
  const depth = texture(
    4,
    4,
    'depth32float',
    GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  );
  const normal = texture(
    4,
    4,
    'r32uint',
    GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_STORAGE_BINDING,
  );
  const params = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const output = device
    .createBuffer({ size: 80, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 80, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    device.queue
      .writeTexture(
        { texture: trace },
        new Float32Array([2, 0, 1, 1, 6, 0, 1, 1, 2, 4, 1, 1, 6, 4, 1, 1]),
        { bytesPerRow: 32, rowsPerImage: 2 },
        { width: 2, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();
    writePackedNormals(
      device,
      normal,
      4,
      4,
      Array.from({ length: 16 }, () => [0.5, 0.5, 1, 0.1]).flat(),
    );
    device.queue.writeBuffer(params, 0, new Float32Array([1, 0.9, 0.02, 0.9, 0, 0, 0, 0])).unwrap();
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set([2, 6, 1, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();
    const inputs = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 4,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          { binding: 1, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
          { binding: 2, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
          {
            binding: 11,
            visibility: 4,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          { binding: 6, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 8, visibility: 4, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const outputs = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [inputs, outputs] }).unwrap(),
        compute: { module, entryPoint: 'probe_current' },
      })
      .unwrap();
    const input = device
      .createBindGroup({
        layout: inputs,
        entries: [
          {
            binding: 0,
            resource: { kind: 'textureView', value: device.createTextureView(trace, {}).unwrap() },
          },
          {
            binding: 1,
            resource: { kind: 'textureView', value: device.createTextureView(depth, {}).unwrap() },
          },
          {
            binding: 2,
            resource: { kind: 'textureView', value: device.createTextureView(normal, {}).unwrap() },
          },
          {
            binding: 11,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(reactive, {}).unwrap(),
            },
          },
          { binding: 6, resource: { kind: 'buffer', value: { buffer: params } } },
          { binding: 8, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const result = device
      .createBindGroup({
        layout: outputs,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const clear = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: device.createTextureView(depth, {}).unwrap(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.5,
      },
    });
    clear.end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, input);
    pass.setBindGroup(1, result);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0))];
    mapped.unmap();
    // This independent linear field has the same analytic footprint at every trace density.
    const expected = [2, 0, 1, 1, 3, 0, 1, 1, 4, 2, 1, 1, 5, 0, 1, 1, 6, 4, 1, 1];
    values.forEach((value, index) => {
      expect(value, `lane ${index}`).toBeCloseTo(expected[index] ?? NaN, 5);
    });
  } finally {
    for (const resource of [trace, reactive, depth, normal])
      device.destroyTexture(resource).unwrap();
    for (const resource of [params, view, output, readback])
      device.destroyBuffer(resource).unwrap();
  }
});
