import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { BindGroup, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import {
  computeBindGroup,
  createComputeStateForModule,
  resolvedGraphView,
} from '../../compute-graph-state';
import { createRenderFeatureGraphTextureTargets } from '../graph-texture-targets';
import {
  importSharedGraphTextures,
  type SharedGraphTexturePublication,
  sharedGraphTextureTopology,
} from '../shared-graph-textures';

export async function verifySharedTexturePhysicalReplacement(): Promise<void> {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const surfaceSize = { width: 4, height: 4 };
  const produce = (value: number) => {
    const builder = new RenderGraphBuilder();
    const descriptor = {
      format: 'rgba16float' as const,
      size: { ...surfaceSize, depthOrArrayLayers: 1 },
      usage: 4 | 16,
    };
    const texture = builder.createTexture('shared-output', descriptor).unwrap();
    const view = builder.view(texture).unwrap();
    builder
      .addRasterPass('write-shared', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [
          { view, loadOp: 'clear', storeOp: 'store', clearValue: [value, 0, 0, 1] },
        ],
        encode() {},
      })
      .unwrap();
    const textures = [
      {
        name: 'output',
        label: 'shared-output',
        scope: 'frame',
        descriptor,
        view: { dimension: '2d' as const },
      },
    ];
    return {
      graph: builder.compile({ device, surfaceSize }).unwrap(),
      textures,
      passes: new Set(),
      topologyKey: sharedGraphTextureTopology(textures),
    } satisfies SharedGraphTexturePublication;
  };
  const first = produce(0.25);
  const second = produce(0.75);
  interface Frame extends RenderGraphFrame {
    readonly shared: SharedGraphTexturePublication;
    readonly runtime: { readonly device: RhiDevice };
    readonly bindGroupCounts: { createBindGroup: number; keys: string[] };
  }
  const builder = new RenderGraphBuilder<Frame>();
  const imported = importSharedGraphTextures(
    builder,
    first,
    createRenderFeatureGraphTextureTargets(),
    (frame) => frame.shared,
  ).get('frame:output');
  assert(imported);
  const output = device.createBuffer({ size: 16, usage: 128 | 4 }).unwrap();
  const readback = device.createBuffer({ size: 16, usage: 1 | 8 }).unwrap();
  const graphOutput = builder
    .importBuffer('sampled-output', { size: 16, usage: 128 | 4 }, () => output)
    .unwrap();
  const module = createShaderModuleImmediate(device, {
    code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result: vec4<f32>;
@compute @workgroup_size(1) fn main() { result = textureLoad(source, vec2<i32>(0), 0); }
`,
  }).unwrap();
  const state = createComputeStateForModule(
    device,
    module,
    'sample-shared',
    [
      {
        binding: 0,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    ],
    'main',
  );
  const groups: BindGroup[] = [];
  const views: TextureView[] = [];
  const bindGroupCounts = { createBindGroup: 0, keys: [] as string[] };
  builder
    .addComputePass('sample-shared', {
      accesses: [
        { resource: imported.view, usage: 'sampled-read' },
        { resource: graphOutput, usage: 'storage-write' },
      ],
      encodeDirect(pass, frame, resources) {
        const view = resolvedGraphView(resources, imported.view);
        const group = computeBindGroup(frame, state, [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output, size: 16 } } },
        ]);
        views.push(view);
        groups.push(group);
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
      },
    })
    .unwrap();
  const consumer = builder.compile({ device, surfaceSize }).unwrap();
  try {
    expect(first.graph.getColorTargetTexture('shared-output')).not.toBe(
      second.graph.getColorTargetTexture('shared-output'),
    );
    const consumerGeneration = consumer.inspect().generation;
    for (const shared of [first, first, second, second, first]) {
      const encoder = device.createCommandEncoder().unwrap();
      shared.graph.execute({ encoder }).unwrap();
      consumer.execute({ encoder, shared, runtime: { device }, bindGroupCounts }).unwrap();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      shared.graph.commitExecution();
      consumer.commitExecution();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const values = Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0)));
      mapped.unmap();
      expect(values).toEqual([shared === first ? 0.25 : 0.75, 0, 0, 1]);
      expect(consumer.inspect().generation).toBe(consumerGeneration);
    }
    expect(views[0]).toBe(views[1]);
    expect(views[1]).not.toBe(views[2]);
    expect(views[2]).toBe(views[3]);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[1]).not.toBe(groups[2]);
    expect(groups[2]).toBe(groups[3]);
    expect(bindGroupCounts.createBindGroup).toBe(3);
    expect(errors).toEqual([]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    for (const graph of [consumer, first.graph, second.graph]) (await graph.retire()).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
}
