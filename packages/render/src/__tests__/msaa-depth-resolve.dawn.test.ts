import { mkdirSync, writeFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { addMsaaNearestDepthResolve } from '../pipeline/msaa-depth-resolve';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';

it('resolves every native MSAA depth sample with nearest Reverse-Z semantics and fresh replay', async () => {
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const immediate = recorder.backend.createShaderModuleImmediate;
  if (immediate === undefined) throw new Error('missing native shader factory');
  const module = (code: string) => immediate(device, { code }).unwrap();
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const size = { width: 4, height: 1 };
  const depth = createRenderPipelineTarget(graph, 'sample-oracle', {
    size,
    format: 'depth32float',
    sampleCount: 4,
  }).unwrap();
  const vertex = `
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const seed = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: { module: module(vertex), entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: module(`
@fragment fn fs_seed(@builtin(position) p: vec4f, @builtin(sample_index) s: u32) -> @builtin(frag_depth) f32 {
  switch u32(p.x) {
    case 0u: { return 0.0; }
    case 1u: { return select(0.0, 0.25, s == 0u); }
    case 2u: { return array<f32, 4>(0.125, 0.5, 0.875, 0.25)[s]; }
    default: { return select(0.0, 1.0, s == 3u); }
  }
}`),
        entryPoint: 'fs_seed',
        targets: [],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 4 },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  graph
    .addRasterPass('seed-each-sample', {
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
  const resolved = addMsaaNearestDepthResolve(graph, depth, size, 'nearest-resolve').unwrap();
  const color = device.createTexture({ size, format: 'rgba8unorm', usage: 0x11 }).unwrap();
  const output = graph
    .importTexture('oracle-pixels', { size, format: 'rgba8unorm', usage: 0x11 }, () => color)
    .unwrap();
  const outputView = graph.view(output).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
      ],
    })
    .unwrap();
  const read = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: module(vertex), entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: module(`
@group(0) @binding(0) var depth: texture_depth_2d;
@fragment fn fs_read(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let value = textureLoad(depth, vec2i(p.xy), 0);
  return vec4f(value, value, value, 1.0);
}`),
        entryPoint: 'fs_read',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  graph
    .addRasterPass('observe-depth', {
      accesses: [
        { resource: resolved.view, usage: 'sampled-read' },
        { resource: outputView, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encodeDirect(pass, _frame, resources) {
        const group = device
          .createBindGroup({
            layout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(resolved.view).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(read);
        pass.setBindGroup(0, group);
        pass.draw(3);
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: size }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    // Only the explicitly consumed runtime inputs are needed by this graph.
    compiled
      .execute({
        encoder,
        runtime: {
          device,
          immediateShaderModuleFactory: {
            createShaderModule: (descriptor) => immediate(device, descriptor),
          },
        },
      } as RenderPipelineFrame)
      .unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const captured = (await capture).unwrap();
    const decoded = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(decoded);
    const live = await readbackTexturePixels(device, color, 4, 1);
    const expected = [0, 64, 223, 255];
    for (let pixel = 0; pixel < 4; pixel++) {
      expect(Math.abs((live[pixel * 4] ?? -1000) - (expected[pixel] ?? -2000))).toBeLessThanOrEqual(
        1,
      );
      expect(live[pixel * 4 + 3]).toBe(255);
    }
    const fresh = (await (await backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(decoded, { device: fresh, createShaderModule: backend.createShaderModule })
    ).unwrap();
    try {
      const inspection = (await replay.inspectWork(model.works.length - 1, ['pixels'])).unwrap();
      if (inspection.attachment === undefined) throw new Error('missing replay attachment');
      expect([...inspection.attachment.bytes]).toEqual([...live]);
    } finally {
      (await replay.dispose()).unwrap();
    }
    const outputDirectory = 'artifacts/msaa-depth-resolve';
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(`${outputDirectory}/nearest.rhitape`, captured.bytes);
  } finally {
    await compiled.retire();
    (await recorder.dispose()).unwrap();
  }
}, 30_000);
