/// <reference types="@webgpu/types" />
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { addCloudSceneDepthMinMax } from '../pipeline/cloud-scene-depth-minmax';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';

it('reduces real reverse-Z scene depth through two RG16F attachments including odd edges', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const size = { width: 5, height: 3 };
  const depth = createRenderPipelineTarget(graph, 'scene-depth', {
    format: 'depth32float',
    size,
  }).unwrap();
  const shader = rhi
    .createShaderModuleImmediate(device, {
      code: /* wgsl */ `
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      let position = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
      return vec4f(position * 2.0 - 1.0, 0.0, 1.0);
    }
    @fragment fn fs(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
      let p = vec2i(position.xy);
      if p.x == 4 { return select(0.0, 1.0, p.y == 2); }
      if p.x == 0 { return 0.0; }
      if p.x == 1 { return 0.25; }
      return select(0.5, 0.75, p.y == 2);
    }
  `,
    })
    .unwrap();
  const seed = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [] },
      depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true },
    })
    .unwrap();
  graph
    .addRasterPass('opaque-depth', {
      accesses: [{ resource: depth.view, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
      encodeDirect(pass) {
        pass.setPipeline(seed);
        pass.draw(3);
      },
    })
    .unwrap();
  const { half, quarter } = addCloudSceneDepthMinMax(graph, depth, size).unwrap();
  const readback = device
    .createBuffer({ size: 768, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const copy = graph
    .importBuffer(
      'range-readback',
      {
        size: 768,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      },
      () => readback,
    )
    .unwrap();
  graph
    .addCopyPass('copy-ranges', {
      accesses: [
        { resource: half.view, usage: 'copy-src' },
        { resource: quarter.view, usage: 'copy-src' },
        { resource: copy, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        for (const [target, width, height, offset] of [
          [half, 3, 2, 0],
          [quarter, 2, 1, 512],
        ] as const) {
          encoder.copyTextureToBuffer(
            { texture: resources.texture(target.texture).unwrap() },
            {
              buffer: resources.buffer(copy).unwrap(),
              offset,
              bytesPerRow: 256,
              rowsPerImage: height,
            },
            { width, height, depthOrArrayLayers: 1 },
          );
        }
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: size }).unwrap();
  try {
    expect(compiled.inspect().passes.map(({ name }) => name)).toEqual([
      'opaque-depth',
      'cloud-scene-depth-minmax-half',
      'cloud-scene-depth-minmax-quarter',
      'copy-ranges',
    ]);
    const encoder = device.createCommandEncoder().unwrap();
    const runtime = {
      device,
      immediateShaderModuleFactory: {
        createShaderModule: (desc: Parameters<typeof rhi.createShaderModuleImmediate>[1]) =>
          rhi.createShaderModuleImmediate(device, desc),
      },
    };
    const executed = compiled.execute({ encoder, runtime } as RenderPipelineFrame);
    if (!executed.ok) throw executed.error.detail.cause ?? executed.error;
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const bytes = mapped.getMappedRange().unwrap();
    // Compare exact FP16 bits. Both stages must keep R = far, G = near.
    expect([...new Uint16Array(bytes, 0, 6)]).toEqual([0, 0x3400, 0x3800, 0x3800, 0, 0]);
    expect([...new Uint16Array(bytes, 256, 6)]).toEqual([
      0, 0x3400, 0x3a00, 0x3a00, 0x3c00, 0x3c00,
    ]);
    expect([...new Uint16Array(bytes, 512, 4)]).toEqual([0, 0x3a00, 0, 0x3c00]);
    mapped.unmap();
  } finally {
    (await compiled.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});

it('back-projects both reverse-Z endpoints on the selected off-center ray in meters', async () => {
  const { imports } = await loadEngineShaderEntries();
  const compiled = await compileShader(
    `
#import forgeax_cloud::depth_minmax::cloud_mode0_depth_range_meters
@group(0) @binding(0) var<storage, read_write> output: array<vec2f>;
@compute @workgroup_size(1) fn distances() {
  // Homogeneous (1000 x, 1000 y, 1000, Z), giving 1250 / Z along this ray.
  let inverseViewProjection = mat4x4f(vec4f(1000, 0, 0, 0), vec4f(0, 1000, 0, 0),
    vec4f(0, 0, 0, 1), vec4f(0, 0, 1000, 0));
  let uv = vec2f(0.875, 0.5);
  output[0] = cloud_mode0_depth_range_meters(vec2f(0.25, 0.5), uv, inverseViewProjection, vec3f(0));
  output[1] = cloud_mode0_depth_range_meters(vec2f(0, 0.5), uv, inverseViewProjection, vec3f(0));
}
`,
    { id: 'cloud-depth-range-meter-witness.wgsl', imports },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'distances' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const [near, far, nearWithSky, sky] = new Float32Array(readback.getMappedRange());
    expect(near).toBeCloseTo(2500, 2);
    expect(far).toBeCloseTo(5000, 2);
    expect(nearWithSky).toBe(near);
    expect(sky).toBe(65_504_000);
    readback.unmap();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
