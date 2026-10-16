import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-rhi';
import { type RhiNullDevice, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import { RenderScene } from '../scene/render-scene';
import {
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

it.each([
  'vertex-getter',
  'index-getter',
  'diverging-vertex',
] as const)('preserves raw imported buffer resolver semantics: %s', async (scenario) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const materialGroup = device.createBindGroup({ layout: materialLayout, entries: [] }).unwrap();
  const first = mesh(device);
  const replacement = mesh(device);
  const second = { ...first };
  const projection = new RenderScene();
  const delta = projection.apply(
    [preparedSnapshot(1, 3), { ...preparedSnapshot(2, 5), worldId: 1 }].map(updateSnapshot),
  );
  const topology = new BatchTopology();
  topology.apply(delta);
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  availability.scene.sync(delta).unwrap();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const frame = production
    .prepare({
      ...standardPbrInputs(device, shader, viewLayout),
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([
        [0, first],
        [1, second],
      ]),
      meshResidencyEpoch: 1,
      viewBindGroupLayout: viewLayout,
      shadowCasterMembership: [],
    })
    .unwrap();
  if (frame === undefined) throw Error('missing GPU frame');
  const cause = new Error(`raw ${scenario}`);
  const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  let restore = () => {};
  let retire: (() => Promise<unknown>) | undefined;
  try {
    if (scenario !== 'diverging-vertex') {
      const wrapper = scenario === 'vertex-getter' ? first.vertexBuffer : first.indexBuffer;
      if (wrapper === null) throw Error('missing indexed fixture');
      const descriptor = Object.getOwnPropertyDescriptor(wrapper, 'handle');
      if (descriptor === undefined) throw Error('missing handle descriptor');
      Object.defineProperty(wrapper, 'handle', {
        configurable: true,
        get: () => {
          throw cause;
        },
      });
      restore = () => {
        Object.defineProperty(wrapper, 'handle', descriptor);
      };
    }
    // Raw project must preserve execution-time reads, including their errors.
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = frame.project(graph, 'rgba8unorm', 1).unwrap();
    const color = graph
      .createTexture('raw-resolver-color', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const view = graph.view(color).unwrap();
    graph
      .addRasterPass('raw-resolvers', {
        accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ pass, resources }) =>
          gpu.encode(viewGroup, pass, resources, {
            ...frame.standardPbrFrameResources,
            materialBindGroups: [materialGroup],
          }),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    retire = () => compiled.retire();
    if (scenario === 'diverging-vertex') {
      Object.defineProperty(second, 'vertexBuffer', { value: replacement.vertexBuffer });
    }
    const encoder = device.createCommandEncoder().unwrap();
    const result = compiled.execute({ encoder } as RenderPipelineFrame);
    if (scenario === 'diverging-vertex') {
      result.unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      frame._commitResourceReplacement();
      expect(draws).toHaveBeenCalledTimes(2);
      expect(new Set(vertices.mock.calls.map(([, buffer]) => buffer))).toEqual(
        new Set([first.vertexBuffer.handle, replacement.vertexBuffer.handle]),
      );
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('resource-resolution-failed');
        expect(result.error.detail).toMatchObject({ accesses: [String(cause)] });
      }
      // Retrying the same compiled graph resolves the restored owner again.
      restore();
      const retryEncoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder: retryEncoder } as RenderPipelineFrame).unwrap();
      device.queue.submit([retryEncoder.finish().unwrap()]).unwrap();
      frame._commitResourceReplacement();
    }
  } finally {
    restore();
    vertices.mockRestore();
    draws.mockRestore();
    await retire?.();
    production.dispose();
    availability.scene.dispose();
    for (const resident of [first, replacement]) {
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    }
  }
});
