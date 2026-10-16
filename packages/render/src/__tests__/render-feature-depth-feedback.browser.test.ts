import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipeline, RhiCommandEncoder, Texture } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureTarget } from '../features/targets';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolvedResource,
} from '../prepare/prepared-graphics-resolver';
import { nativeDeviceFixture } from './native-device-fixture';

// Actual prepared owner -> graph -> browser WebGPU validation and pixels.
// The first draw must sample 0.25 while writing 0.75; the next consumer must
// observe that 0.75. Disabling depth writes or binding a fallback fails pixels.
it('preserves single-sample depth sampling and writes for 60 submitted frames', async () => {
  const sampleCount = 1;
  const { device, native } = await nativeDeviceFixture({
    requiredFeatures: ['depth32float-stencil8'],
  });
  const format = 'depth32float-stencil8' as const;
  native.pushErrorScope('validation');
  const code = `
@group(0) @binding(0) var scene_depth: texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
  return vec4<f32>(p[i],0.75,1.0);
}
@fragment fn fs_main(@builtin(position) p:vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(textureLoad(scene_depth,vec2<i32>(p.xy),0),0,0,1);
}`;
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'depth' },
        },
      ],
    })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const shader = createShaderModuleImmediate(device, { code }).unwrap();
  const makePipeline = (writes: boolean): RenderPipeline =>
    device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
        fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
        ...(writes
          ? { depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always' } }
          : {}),
        multisample: { count: writes ? sampleCount : 1 },
      })
      .unwrap();
  const pipeline = makePipeline(true);
  const observer = makePipeline(false);
  const output = device
    .createTexture({ format: 'rgba8unorm', size: { width: 2, height: 1 }, usage: 0x11 })
    .unwrap();
  const readback = device.createBuffer({ size: 512, usage: 0x09 }).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const depth = graph
    .createTexture('depth', { format, size: { width: 2, height: 1 }, sampleCount })
    .unwrap();
  const depthView = graph.view(depth).unwrap();
  const result = graph
    .importTexture(
      'output',
      { format: 'rgba8unorm', size: { width: 2, height: 1 }, usage: 0x11 },
      () => output,
    )
    .unwrap();
  const resultView = graph.view(result).unwrap();
  graph
    .addRasterPass('opaque', {
      accesses: [{ resource: depthView, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.25,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store',
        stencilClearValue: 0,
      },
      encode: () => undefined,
    })
    .unwrap();
  const depthTarget = createRenderFeatureTarget({
    name: 'depth',
    kind: 'scene-depth',
    format,
    sampleCount,
  });
  const colorTarget = createRenderFeatureTarget({
    name: 'color',
    kind: 'scene-color',
    format: 'rgba8unorm',
    sampleCount,
  });
  const store = createPreparedGraphicsStore();
  const tx = store.beginFrame('depth-feedback', 1);
  const program = tx
    .prepare('pipeline', 'writer', {
      shader: 'depth-feedback',
      vertexLayout: 'none',
      colorFormats: ['rgba8unorm'],
      depthFormat: format,
      sampleCount,
      renderState: { depthWriteEnabled: true },
    })
    .unwrap();
  const bindings = tx
    .prepare('bindings', 'depth', { pipeline: program, values: { sceneDepth: depthTarget } })
    .unwrap();
  const bindDepth = (texture: Texture) => {
    const view = device
      .createTextureView(texture, { dimension: '2d', aspect: 'depth-only' })
      .unwrap();
    return device
      .createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: view } }],
      })
      .unwrap();
  };
  const resolver = createPreparedGraphicsResolver({
    device,
    generation: 1,
    capabilityAvailable: true,
    lookup: (reference) => tx.lookup(reference),
    resolvePipeline: () => ok(pipeline),
    resolveBindings: () => ok(undefined),
  });
  const resources = new Map<object, PreparedGraphicsResolvedResource>(
    [program, bindings].map((ref) => [ref, resolver.resolve(ref).unwrap()]),
  );
  const descriptor = {
    attachments: {
      colors: [{ resource: colorTarget, format: 'rgba8unorm', loadOp: 'clear', storeOp: 'store' }],
      depthStencil: { resource: depthTarget, format, depthLoadOp: 'load', depthStoreOp: 'store' },
    },
    sampledTargets: [depthTarget],
    sceneDepth: 'before-pass',
    draws: [
      {
        kind: 'draw',
        pipeline: program,
        bindings: [bindings],
        vertexData: [],
        vertexLayout: 'none',
        command: { vertexCount: 3, instanceCount: 1 },
      },
    ],
  } as const;
  const available = [
    { resource: depthTarget, format },
    { resource: colorTarget, format: 'rgba8unorm' as const },
  ];
  const projection = new RenderFeatureRasterGraphProjection(
    graph,
    (target) =>
      target === depthTarget
        ? { texture: depth, view: depthView }
        : {
            texture: result,
            view: resultView,
          },
    ({ resolveTarget, resources }) => {
      const sampled = resolveTarget(depthTarget);
      if (sampled === undefined) throw Error('missing sampled depth');
      return bindDepth(resources.texture(sampled.texture).unwrap());
    },
  );
  projection
    .addPass('writer', 'depth-feedback', 0, descriptor, tx.graphicsState(true, available), {
      generation: 1,
      resolve: (ref) => resources.get(ref),
    })
    .unwrap();
  const copyColor = (name: string, offset: number) =>
    graph
      .addCopyPass(name, {
        accesses: [{ resource: resultView, usage: 'copy-src' }],
        encode: ({ encoder }) =>
          encoder.copyTextureToBuffer(
            { texture: output },
            { buffer: readback, offset, bytesPerRow: 256, rowsPerImage: 1 },
            { width: 2, height: 1, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
  copyColor('sampled-before-write', 0);
  graph
    .addRasterPass('observe-written-depth', {
      accesses: [
        { resource: depthView, usage: 'sampled-read' },
        { resource: resultView, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: resultView, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) => {
        pass.setPipeline(observer);
        pass.setBindGroup(0, bindDepth(resources.texture(depth).unwrap()));
        pass.draw(3);
      },
    })
    .unwrap();
  copyColor('depth-after-write', 256);
  const compiled = graph.compile({ device, surfaceSize: { width: 20, height: 10 } }).unwrap();
  try {
    for (let frame = 0; frame < 60; frame++) {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    }
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const pixels = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    expect((await native.popErrorScope())?.message ?? null).toBeNull();
    expect(pixels[0]).toBeCloseTo(64, 0);
    expect(pixels[256]).toBeCloseTo(191, 0);
  } finally {
    await compiled.retire();
    resolver.release().unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(output).unwrap();
    native.destroy();
  }
}, 30_000);
