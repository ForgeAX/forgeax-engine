import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModule, createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { createRenderFeatureTarget } from '../features/targets';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';

it('binds a depth-only view for the single-layer nearest depth input', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const depth = device
    .createTexture({
      label: 'single-layer-nearest-depth-dawn',
      size: { width: 1, height: 1 },
      format: 'depth24plus-stencil8',
      usage: 0x04 | 0x10,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  try {
    const depthOnlyView = device
      .createTextureView(depth, {
        label: 'single-layer-nearest-depth-dawn.depth-only',
        aspect: 'depth-only',
      })
      .unwrap();
    const layout = device
      .createBindGroupLayout({
        label: 'single-layer-nearest-depth-dawn-bgl',
        entries: [{ binding: 0, visibility: 4, texture: { sampleType: 'depth' } }],
      })
      .unwrap();
    const bindGroup = device.createBindGroup({
      label: 'single-layer-nearest-depth-dawn-bg',
      layout,
      entries: [{ binding: 0, resource: { kind: 'textureView', value: depthOnlyView } }],
    });
    expect(bindGroup.ok).toBe(true);
  } finally {
    device.destroyTexture(depth).unwrap();
  }
});

it('samples this frame graph depth after its producer on the real GPU', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const code = `@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn sample() { output[0] = textureLoad(depth, vec2<i32>(0), 0); }`;
  const shader = (await createShaderModule(device, { code })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('depth-input', 0);
  const program = session
    .prepareProgram('sample', {
      wgsl: code,
      entryPoints: ['sample'],
      bindings: [
        {
          entries: [
            { binding: 0, visibility: 4, texture: { sampleType: 'depth' } },
            { binding: 1, visibility: 4, buffer: { type: 'storage' } },
          ],
        },
      ],
    })
    .unwrap();
  const output = session
    .prepareBuffer('output', { size: 4, usage: ['storage', 'copy-src'] })
    .unwrap();
  const fallbackTexture = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: 0x04 | 0x10,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const fallback = device.createTextureView(fallbackTexture, {}).unwrap();
  const depth = session
    .prepareTextureView(
      'depth',
      fallback,
      createRenderFeatureTarget({ kind: 'scene-depth', format: 'depth32float', sampleCount: 1 }),
    )
    .unwrap();
  const bindings = session
    .prepareBindings('bindings', {
      program,
      entries: [
        { binding: 0, resource: { kind: 'texture-view', reference: depth } },
        { binding: 1, buffer: output },
      ],
    })
    .unwrap();
  const work = session
    .resolveComputePass('depth-input', {
      program,
      bindings,
      dispatches: [{ entryPoint: 'sample', workgroups: [1] }],
    })
    .unwrap();
  const source = session.resolveBuffer(output);
  if (source === undefined) throw new Error('Missing output buffer');
  const readback = device.createBuffer({ size: 4, usage: 0x01 | 0x08 }).unwrap();
  try {
    for (const expected of [0.25, 0.75]) {
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const texture = graph
        .createTexture('current-depth', {
          format: 'depth32float',
          size: { width: 1, height: 1 },
        })
        .unwrap();
      const view = graph.view(texture).unwrap();
      graph
        .addRasterPass('depth-producer', {
          colorAttachments: [],
          depthStencilAttachment: {
            view,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: expected,
          },
          accesses: [{ resource: view, usage: 'depth-stencil-write' }],
          encode: () => {},
        })
        .unwrap();
      const projection = new RenderFeatureComputeGraphProjection(
        graph,
        undefined,
        undefined,
        () => ({ texture, view }),
      );
      projection
        .addPasses([
          { name: 'sample', featureIdentity: 'depth-input', order: 0, resolvedGpuCompute: work },
        ])
        .unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      encoder.copyBufferToBuffer(source.buffer, 0, readback, 0, 4);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const actual = new DataView(mapped.getMappedRange().unwrap()).getFloat32(0, true);
      mapped.unmap();
      expect(actual).toBeCloseTo(expected, 6);
      await compiled.retire();
    }
  } finally {
    owner.dispose().unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(fallbackTexture).unwrap();
  }
});

it('keeps fragment window depth aligned with the nearest-layer depth comparison', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const source = `
struct VsOut { @builtin(position) clipPosition: vec4<f32> }
${await (
  async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../../shader/src/', import.meta.url));
    const medium = await readFile(resolve(root, 'single-layer-medium.wgsl'), 'utf8');
    const match = medium.match(/fn clipDepth\(input: VsOut\) -> f32 \{[^}]+\}/u);
    if (match === null) throw new Error('single-layer-medium clipDepth function is missing');
    return match[0];
  }
)()}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return VsOut(vec4<f32>(positions[index] * 5.0, 2.5, 5.0));
}
@fragment fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let mediumDepth = clipDepth(input);
  if (mediumDepth > 0.5005) { discard; }
  return vec4<f32>(input.clipPosition.z, mediumDepth, 1.0, 1.0);
}`;
  const shader = createShaderModuleImmediate(device, { code: source }).unwrap();
  const output = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba32float',
      usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const readback = device
    .createBuffer({ size: 256, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  try {
    const emptyLayout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: emptyLayout,
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
        fragment: {
          module: shader,
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba32float' }],
        },
        primitive: { topology: 'triangle-list' },
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
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16)));
    mapped.unmap();
    expect(values[0]).toBeCloseTo(0.5, 5);
    expect(values[1]).toBeCloseTo(0.5, 5);
    expect(values[3]).toBeCloseTo(1.0, 5);
  } finally {
    device.destroyTexture(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
