import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import type { RenderFeaturePlanExecution } from '../features/host';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import type { RenderFeaturePreparedRef } from '../features/prepared-graphics';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import {
  inspectTransientViewGraphs,
  projectTransientViewPlans,
  selectTransientViewPlans,
} from '../features/transient-view-graph';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsReference,
} from '../prepare/prepared-graphics-resolver';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  retireTemporalGpuState,
} from '../temporal/gpu';
import { nativeDeviceFixture } from './native-device-fixture';

function isGraphicsReference(
  reference: RenderFeaturePreparedRef,
): reference is PreparedGraphicsReference {
  return (
    reference.kind === 'pipeline' ||
    reference.kind === 'bindings' ||
    reference.kind === 'vertex-data' ||
    reference.kind === 'index-data'
  );
}

// Actual published TAA shader and actual prepared raster bindings. History is
// deliberately invalid: the current color must survive the resolve exactly.
// This tests insertion/ports and dynamic command replacement, not TAA convergence.
export async function verifyTransientSceneTaa(
  source: string,
  depthFormat: 'depth24plus' | 'depth24plus-stencil8',
) {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const extent = { width: 2, height: 1 };
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(17, 'transient-scene-taa'),
    extent.width,
    extent.height,
  );
  if (state.algorithm !== 'taa' || state.flicker === undefined) {
    retireTemporalGpuState(state);
    native.destroy();
    throw Error('Expected the TAA owner and its flicker history');
  }
  const flicker = state.flicker;
  const inputs = getTemporalBindGroupResources(state),
    params = getTemporalParamsBuffer(state);
  if (inputs.sampler === null || inputs.temporalSampler === null)
    throw Error('Missing TAA samplers');
  const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
  const emptyGroup = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
  const taaModule = createShaderModuleImmediate(device, { code: source }).unwrap();
  const taa = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, inputs.layout] }).unwrap(),
      vertex: { module: taaModule, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: taaModule,
        entryPoint: 'fs_main',
        targets: [
          { format: 'rgba16float' },
          { format: 'rgba16float' },
          { format: 'r8unorm' },
          { format: 'rgba8unorm' },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const particleModule = createShaderModuleImmediate(device, {
    code: `
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0.5,1);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1,0,0,1); }
`,
  }).unwrap();
  const particle = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty] }).unwrap(),
      vertex: { module: particleModule, entryPoint: 'vertex', buffers: [] },
      fragment: {
        module: particleModule,
        entryPoint: 'fragment',
        targets: [{ format: 'rgba16float' }],
      },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const color = device
    .createTexture({ size: extent, format: 'rgba16float', usage: 1 | 4 | 16 })
    .unwrap();
  const colorView = device.createTextureView(color, {}).unwrap();
  const depth = device.createTexture({ size: extent, format: depthFormat, usage: 16 }).unwrap();
  const metadata = device
    .createTexture({ size: extent, format: 'rgba16float', usage: 2 | 4 })
    .unwrap();
  const metadataView = device.createTextureView(metadata, {}).unwrap();
  device.queue
    .writeTexture(
      { texture: metadata },
      new Uint16Array(8),
      { bytesPerRow: 16, rowsPerImage: 1 },
      extent,
    )
    .unwrap();
  const group = device
    .createBindGroup({
      layout: inputs.layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: colorView } },
        { binding: 1, resource: { kind: 'sampler', value: inputs.sampler } },
        { binding: 2, resource: { kind: 'textureView', value: state.color[0].view } },
        { binding: 3, resource: { kind: 'sampler', value: inputs.sampler } },
        { binding: 4, resource: { kind: 'textureView', value: state.temporal[0].view } },
        { binding: 5, resource: { kind: 'sampler', value: inputs.temporalSampler } },
        { binding: 6, resource: { kind: 'textureView', value: metadataView } },
        { binding: 7, resource: { kind: 'sampler', value: inputs.temporalSampler } },
        { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
        { binding: 9, resource: { kind: 'textureView', value: state.stability[0].view } },
        { binding: 10, resource: { kind: 'textureView', value: metadataView } },
        { binding: 11, resource: { kind: 'textureView', value: metadataView } },
        { binding: 12, resource: { kind: 'textureView', value: metadataView } },
        { binding: 13, resource: { kind: 'textureView', value: flicker[0].view } },
      ],
    })
    .unwrap();
  const readback = device.createBuffer({ size: 512, usage: 1 | 8 }).unwrap();
  const store = createPreparedGraphicsStore(),
    tx = store.beginFrame('scene-particle', 1);
  const program = tx
    .prepare('pipeline', 'particle', {
      shader: 'test::scene-particle',
      vertexLayout: 'none',
      colorFormats: ['rgba16float'],
      depthFormat,
    })
    .unwrap();
  const binding = tx
    .prepare('bindings', 'particle-bindings', { pipeline: program, values: {} })
    .unwrap();
  const resolver = createPreparedGraphicsResolver({
    device,
    generation: 1,
    capabilityAvailable: true,
    lookup: (reference) => tx.lookup(reference),
    resolvePipeline: () => ok(particle),
    resolveBindings: () => ok(emptyGroup),
  });
  const descriptor = {
    attachments: {
      colors: [{ resource: 'color', format: 'rgba16float', loadOp: 'load', storeOp: 'store' }],
      depthStencil: {
        resource: 'depth',
        format: depthFormat,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    },
    draws: [
      {
        kind: 'draw',
        pipeline: program,
        bindings: [binding],
        vertexData: [],
        vertexLayout: 'none',
        command: { vertexCount: 3, instanceCount: 1 },
      },
    ],
  } as const;
  const graphicsState = tx
    .validateGraphicsPass(descriptor, true, [
      { resource: 'color', format: 'rgba16float' },
      { resource: 'depth', format: depthFormat },
    ])
    .unwrap();
  const execution = (count: number, placement: 'scene' | 'post'): RenderFeaturePlanExecution => ({
    featureIdentity: 'scene-particle',
    scope: 'view:main',
    order: 0,
    placement,
    passes: Array.from({ length: count }, (_, index) => ({
      featureIdentity: 'scene-particle',
      order: 0,
      name: `particle-${index}`,
      graphics: descriptor,
      graphicsState,
      resolvedGraphics: {
        generation: 1,
        resolve: (reference) =>
          isGraphicsReference(reference) ? resolver.resolve(reference).unwrap() : undefined,
      },
    })),
  });
  const planned = (placement: 'scene' | 'post'): RenderFeaturePlannedFrame => ({
    featureIdentity: 'scene-particle',
    scope: { view: 'main' },
    generation: 1,
    signature: 'native-particle',
    viewGraph: 'transient',
    placement,
    plan: { resources: [], passes: [] },
  });
  const build = (current: RenderFeaturePlanExecution, isolated: boolean) => {
    const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>(),
      owner = {};
    const c = builder
        .importTexture(
          'color',
          { size: extent, format: 'rgba16float', usage: 1 | 4 | 16 },
          () => color,
        )
        .unwrap(),
      cv = builder.view(c).unwrap();
    const d = builder
        .importTexture('depth', { size: extent, format: depthFormat, usage: 16 }, () => depth)
        .unwrap(),
      dv = builder.view(d).unwrap();
    builder
      .addRasterPass('scene', {
        accesses: [
          { resource: cv, usage: 'color-attachment' },
          { resource: dv, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [
          { view: cv, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 1, 1] },
        ],
        depthStencilAttachment: {
          view: dv,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
          ...(depthFormat === 'depth24plus-stencil8'
            ? {
                stencilLoadOp: 'clear' as const,
                stencilStoreOp: 'store' as const,
                stencilClearValue: 0,
              }
            : {}),
        },
        encode: () => {},
      })
      .unwrap();
    const selected = isolated
      ? selectTransientViewPlans(owner, [planned(current.placement ?? 'post')], [current], true)
          .identities
      : new Set<string>();
    if (isolated) expect(selected.has('scene-particle')).toBe(true);
    const contribute = () =>
      projectTransientViewPlans(
        builder,
        [current],
        selected,
        {
          placement: current.placement,
          resolveTarget: (target) =>
            target === 'depth' ? { texture: d, view: dv } : { texture: c, view: cv },
        },
        {
          owner,
          device,
          surfaceSize: extent,
          slots: new Map(),
          ports: [
            { resource: cv, usage: 'color-attachment' },
            { resource: dv, usage: 'depth-stencil-write' },
          ],
        },
      ).unwrap();
    if (current.placement === 'scene') contribute();
    builder
      .addCopyPass('read-pre-taa', {
        accesses: [{ resource: cv, usage: 'copy-src' }],
        encode: ({ encoder }) => {
          encoder.copyTextureToBuffer(
            { texture: color },
            { buffer: readback, offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
            extent,
          );
        },
      })
      .unwrap();
    const surfaces = [state.color[1], state.temporal[1], state.stability[1], flicker[1]];
    const formats = ['rgba16float', 'rgba16float', 'r8unorm', 'rgba8unorm'] as const;
    const outputs = surfaces.map((surface, index) => {
      const format = formats[index];
      if (format === undefined) throw Error('Missing TAA output format');
      return builder
        .view(
          builder
            .importTexture(
              `taa-${index}`,
              { size: extent, format, usage: 1 | 4 | 16 },
              () => surface.texture,
            )
            .unwrap(),
        )
        .unwrap();
    });
    builder
      .addRasterPass('taa-resolve', {
        accesses: [
          { resource: cv, usage: 'sampled-read' },
          ...outputs.map((resource) => ({ resource, usage: 'color-attachment' as const })),
        ],
        colorAttachments: outputs.map((view) => ({
          view,
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
        })),
        encode: ({ pass }) => {
          pass.setPipeline(taa);
          pass.setBindGroup(0, emptyGroup);
          pass.setBindGroup(1, group);
          pass.draw(3);
        },
      })
      .unwrap();
    if (current.placement === 'post') contribute();
    const resultView = outputs[0];
    if (resultView === undefined) throw Error('Missing TAA color');
    builder
      .addCopyPass('read-taa', {
        accesses: [{ resource: resultView, usage: 'copy-src' }],
        encode: ({ encoder }) => {
          encoder.copyTextureToBuffer(
            { texture: state.color[1].texture },
            { buffer: readback, offset: 256, bytesPerRow: 256, rowsPerImage: 1 },
            extent,
          );
        },
      })
      .unwrap();
    return { owner, graph: builder.compile({ device, surfaceSize: extent }).unwrap() };
  };
  const sequence = async (isolated: boolean, placement: 'scene' | 'post') => {
    const retained = isolated ? build(execution(0, placement), true) : undefined,
      pixels: number[][] = [],
      inputPixels: number[][] = [],
      frameEvents: string[][] = [];
    try {
      for (const count of [0, 3, 1, 0]) {
        const current = execution(count, placement),
          parent = retained ?? build(current, false),
          events: string[] = [];
        try {
          device.queue.writeBuffer(params, 0, new Uint32Array(12)).unwrap();
          const encoder = device.createCommandEncoder().unwrap();
          parent.graph
            .execute({ encoder, featureExecutions: [current] }, (pass, encode) => {
              events.push(pass.name);
              encode();
            })
            .unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          await device.queue.onSubmittedWorkDone();
          const mapped = (await readback.mapAsync(1)).unwrap();
          const bytes = mapped.getMappedRange().unwrap();
          inputPixels.push([...new Uint16Array(bytes.slice(0, 16))]);
          pixels.push([...new Uint16Array(bytes.slice(256, 272))]);
          mapped.unmap();
          frameEvents.push(events);
        } finally {
          if (retained === undefined) await parent.graph.retire();
        }
      }
      if (retained !== undefined)
        expect(inspectTransientViewGraphs(retained.owner)).toMatchObject({
          commandFrames: 4,
          childCompiles: 0,
          childFailures: 0,
        });
      return { placement, pixels, inputPixels, frameEvents };
    } finally {
      await retained?.graph.retire();
    }
  };
  try {
    const monolithic = await sequence(false, 'scene'),
      isolated = await sequence(true, 'scene'),
      legacyPost = await sequence(true, 'post');
    const validation = await native.popErrorScope();
    console.info(
      '[transient-scene-taa]',
      JSON.stringify({
        depthFormat,
        validation: validation === null ? null : { message: validation.message },
        monolithic,
        isolated,
        legacyPost,
      }),
    );
    expect(validation?.message ?? null).toBeNull();
    for (const result of [monolithic, isolated, legacyPost])
      for (const index of [1, 2]) {
        const events = result.frameEvents[index];
        if (events === undefined) throw Error('Missing active frame events');
        expect(events.indexOf('particle-0') < events.indexOf('taa-resolve')).toBe(
          result.placement === 'scene',
        );
      }
    const background = [0, 0, 0x3c00, 0x3c00, 0, 0, 0x3c00, 0x3c00],
      radiance = [0x3c00, 0, 0, 0x3c00, 0x3c00, 0, 0, 0x3c00];
    expect(monolithic.inputPixels).toEqual([background, radiance, radiance, background]);
    expect(monolithic.pixels).toEqual([background, radiance, radiance, background]);
    expect(isolated.pixels).toEqual(monolithic.pixels);
    expect(isolated.inputPixels).toEqual(monolithic.inputPixels);
    // The old post-stage routing writes the input after TAA already consumed it.
    // Keep this negative witness; making both paths identically invisible cannot pass.
    expect(legacyPost.pixels).toEqual([background, background, background, background]);
  } finally {
    device.destroyBuffer(readback).unwrap();
    for (const texture of [color, depth, metadata]) device.destroyTexture(texture).unwrap();
    retireTemporalGpuState(state);
    native.destroy();
  }
}
