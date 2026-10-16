import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import type { RenderFeatureGpuBufferRef } from '../features/prepared-gpu-work';
import type { RenderFeatureGraphicsPassDescriptor } from '../features/prepared-graphics';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { nativeDeviceFixture } from './native-device-fixture';

it('reads draw visibility from each submission of one retained graph without stale indirect draws', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const module = createShaderModuleImmediate(device, {
    code: `
struct Vertex { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) index: u32, @location(0) offset: f32) -> Vertex {
  var positions = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  var colors = array<vec4f, 3>(vec4f(0.5,0,0,0.5), vec4f(0,0.5,0,0.5), vec4f(0,0,0.5,0.5));
  return Vertex(vec4f(positions[index % 3u] + vec2f(offset, 0), 0, 1), colors[index / 3u]);
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f { return vertex.color; }
`,
  }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const nativeBindings = device.createBindGroup({ layout, entries: [] }).unwrap();
  const nativePipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [
          {
            arrayStride: 4,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32' }],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [
          {
            format: 'rgba8unorm',
            blend: {
              color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const output = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 17 })
    .unwrap();
  const vertexBuffer = device.createBuffer({ size: 36, usage: 40 }).unwrap();
  const vertices = { kind: 'vertex-data', generation: 0 } as const;
  const indirect = device.createBuffer({ size: 48, usage: 264 }).unwrap();
  const readback = device.createBuffer({ size: 256, usage: 9 }).unwrap();
  // These nonzero commands deliberately survive every visibility transition.
  device.queue
    .writeBuffer(indirect, 0, new Uint32Array([3, 1, 0, 0, 3, 1, 3, 0, 3, 1, 6, 0]))
    .unwrap();
  const pipeline = { kind: 'pipeline', generation: 0 } as const;
  const bindings = { kind: 'bindings', generation: 0 } as const;
  const args = { name: 'args', generation: 0 } as RenderFeatureGpuBufferRef;
  const descriptor: RenderFeatureGraphicsPassDescriptor = {
    attachments: {
      colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
    },
    draws: [0, 1, 2].map((index) => ({
      kind: 'draw-indirect',
      enabled: index !== 1,
      pipeline,
      bindings: [bindings],
      vertexData: [{ slot: 0, resource: vertices }],
      command: { buffer: args, offset: index * 16 },
    })),
  };
  const graph = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  const target = graph
    .importTexture(
      'color',
      { size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 17 },
      () => output,
    )
    .unwrap();
  const view = graph.view(target).unwrap();
  graph
    .addRasterPass('clear', {
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      accesses: [{ resource: view, usage: 'color-attachment' }],
      encode: () => {},
    })
    .unwrap();
  const state = {
    capabilityAvailable: true,
    generation: 0,
    attachments: [{ resource: 'color', format: 'rgba8unorm' as const }],
    pipeline,
    bindings: [bindings],
    vertexData: [vertices],
    indexData: [],
  };
  const snapshot = {
    generation: 0,
    resolve: (reference: object) =>
      reference === pipeline
        ? { kind: 'pipeline' as const, reference: pipeline, handle: nativePipeline }
        : reference === bindings
          ? { kind: 'bindings' as const, reference: bindings, handle: nativeBindings }
          : reference === vertices
            ? {
                kind: 'vertex-data' as const,
                reference: vertices,
                handle: vertexBuffer,
                size: 36,
                physicalUsage: 40,
              }
            : undefined,
    resolveGpuBuffer: () => ({ buffer: indirect, size: 48, physicalUsage: 264 }),
  };
  const projection = new RenderFeatureRasterGraphProjection(graph, () => ({
    texture: target,
    view,
  }));
  projection.addPass('particles', 'visibility', 0, descriptor, state, snapshot).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    for (const [mask, expected] of [
      [
        [true, false, true],
        [64, 0, 128, 191],
      ],
      [
        [true, true, true],
        [32, 64, 128, 223],
      ],
      [
        [false, true, false],
        [0, 128, 0, 128],
      ],
      [
        [false, false, false],
        [0, 0, 0, 0],
      ],
      [
        [true, false, true],
        [64, 0, 128, 191],
      ],
    ] as const) {
      const encoder = device.createCommandEncoder().unwrap();
      const offsets: number[] = [];
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (input) => {
        const pass = begin(input);
        const draw = pass.drawIndirect.bind(pass);
        pass.drawIndirect = (buffer, offset) => {
          offsets.push(offset);
          draw(buffer, offset);
        };
        return pass;
      };
      compiled
        .execute({
          encoder,
          featureExecutions: [
            {
              featureIdentity: 'visibility',
              order: 0,
              passes: [
                {
                  featureIdentity: 'visibility',
                  name: 'particles',
                  order: 0,
                  enabled: mask.some(Boolean),
                  graphics: {
                    ...descriptor,
                    draws: descriptor.draws.map((draw, index) => ({
                      ...draw,
                      enabled: mask[index],
                    })),
                  },
                  resolvedGraphics: snapshot,
                },
              ],
            },
          ],
        })
        .unwrap();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
      for (let channel = 0; channel < 4; channel++)
        expect(Math.abs((bytes[channel] ?? 0) - (expected[channel] ?? 0))).toBeLessThanOrEqual(1);
      mapped.unmap();
      expect(offsets).toEqual(mask.flatMap((enabled, index) => (enabled ? [index * 16] : [])));
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    await compiled.retire();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(indirect).unwrap();
    device.destroyBuffer(vertexBuffer).unwrap();
    device.destroyTexture(output).unwrap();
    native.destroy();
  }
});
