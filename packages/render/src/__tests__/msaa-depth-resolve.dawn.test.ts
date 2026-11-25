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

function expectResolvedPixels(live: Uint8Array, motion: boolean) {
  const expected = [0, 64, 223, 255];
  const expectedSample = [0, 0, 170, 255];
  for (let pixel = 0; pixel < 4; pixel++) {
    expect(Math.abs((live[pixel * 4] ?? -1000) - (expected[pixel] ?? -2000))).toBeLessThanOrEqual(
      1,
    );
    if (motion)
      expect(
        Math.abs((live[pixel * 4 + 1] ?? -1000) - (expectedSample[pixel] ?? -2000)),
      ).toBeLessThanOrEqual(1);
    expect(live[pixel * 4 + 3]).toBe(255);
  }
}

it.each([
  false,
  true,
])('resolves nearest Reverse-Z depth and replays it (motion=%s)', async (motion) => {
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (
      await recorder.backend.rhi.requestAdapter()
    )
      .unwrap()
      .requestDevice(motion ? { requiredFeatures: ['depth32float-stencil8'] } : {})
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
  const temporal = motion
    ? createRenderPipelineTarget(graph, 'motion-oracle', {
        size,
        format: 'rgba16float',
        sampleCount: 4,
      }).unwrap()
    : undefined;
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
fn seedDepth(p: vec4f, s: u32) -> f32 {
  switch u32(p.x) {
    case 0u: { return 0.0; }
    case 1u: { return select(0.0, 0.25, s == 0u); }
    case 2u: { return array<f32, 4>(0.125, 0.5, 0.875, 0.25)[s]; }
    default: { return select(0.0, 1.0, s == 3u); }
  }
}
${
  motion
    ? `
struct Seed {
  @builtin(frag_depth) depth: f32,
  @location(0) motion: vec4f,
};
@fragment fn fs_seed(@builtin(position) p: vec4f, @builtin(sample_index) s: u32) -> Seed {
  return Seed(seedDepth(p, s), vec4f(f32(s) / 3.0, 0.0, 0.0, 1.0));
}
`
    : `
@fragment fn fs_seed(@builtin(position) p: vec4f, @builtin(sample_index) s: u32) -> @builtin(frag_depth) f32 {
  return seedDepth(p, s);
}
`
}`),
        entryPoint: 'fs_seed',
        targets: temporal === undefined ? [] : [{ format: temporal.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 4 },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  graph
    .addRasterPass('seed-each-sample', {
      accesses: [
        { resource: depth.view, usage: 'depth-stencil-write' },
        ...(temporal === undefined
          ? []
          : [{ resource: temporal.view, usage: 'color-attachment' as const }]),
      ],
      colorAttachments:
        temporal === undefined
          ? []
          : [{ view: temporal.view, loadOp: 'clear' as const, storeOp: 'store' as const }],
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
  const resolved = addMsaaNearestDepthResolve(graph, depth, size, 'nearest-resolve', {
    temporal,
    ...(motion ? { format: 'depth32float-stencil8' } : {}),
  }).unwrap();
  const resolvedDepth = graph.view(resolved.depth.texture, { aspect: 'depth-only' }).unwrap();
  const resolvedTemporal = resolved.temporal;
  const color = device.createTexture({ size, format: 'rgba8unorm', usage: 0x11 }).unwrap();
  const output = graph
    .importTexture('oracle-pixels', { size, format: 'rgba8unorm', usage: 0x11 }, () => color)
    .unwrap();
  const outputView = graph.view(output).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
        ...(motion
          ? [
              {
                binding: 1,
                visibility: 2,
                texture: {
                  sampleType: 'unfilterable-float' as const,
                  viewDimension: '2d' as const,
                },
              },
            ]
          : []),
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
${motion ? '@group(0) @binding(1) var selectedMotion: texture_2d<f32>;' : ''}
@fragment fn fs_read(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let value = textureLoad(depth, vec2i(p.xy), 0);
  return vec4f(value, ${motion ? 'textureLoad(selectedMotion, vec2i(p.xy), 0).r' : 'value'}, value, 1.0);
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
        { resource: resolvedDepth, usage: 'sampled-read' },
        ...(resolvedTemporal === undefined
          ? []
          : [
              {
                resource: resolvedTemporal.view,
                usage: 'sampled-read' as const,
              },
            ]),
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
                  value: resources.textureView(resolvedDepth).unwrap(),
                },
              },
              ...(resolvedTemporal === undefined
                ? []
                : [
                    {
                      binding: 1,
                      resource: {
                        kind: 'textureView' as const,
                        value: resources.textureView(resolvedTemporal.view).unwrap(),
                      },
                    },
                  ]),
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
    expectResolvedPixels(live, motion);
    const fresh = (
      await (
        await backend.rhi.requestAdapter()
      )
        .unwrap()
        .requestDevice(motion ? { requiredFeatures: ['depth32float-stencil8'] } : {})
    ).unwrap();
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
    writeFileSync(
      `${outputDirectory}/nearest${motion ? '-with-motion' : ''}.rhitape`,
      captured.bytes,
    );
  } finally {
    await compiled.retire();
    (await recorder.dispose()).unwrap();
  }
}, 30_000);
