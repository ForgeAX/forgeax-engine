import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { BindGroup, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { ensureCompiledFrameGraph } from '../record/typed-frame-graph';
import type { RenderPipeline, RenderPipelineFrame } from '../render-pipeline';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { PersistentRenderScene } from '../scene/render-scene';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../temporal/frame';
import type { ViewLights } from '../world/render-lights';
import { admitPbrDawnFixture } from './gpu-driven-raster-class-dawn-fixture';

/** Read real cooked Standard color through both live material-pass filters. */
export async function verifyRetainedRasterRouting(input: {
  readonly device: RhiDevice;
  readonly native: GPUDevice;
  readonly production: GpuDrivenProduction;
  readonly prepareInput: Parameters<typeof admitPbrDawnFixture>[0];
  readonly source: RenderableSnapshot;
  readonly persistentScene: PersistentRenderScene;
  readonly persistentWorld: World;
  readonly persistentLease: RenderReadLease;
  readonly persistentFrame: ExtractedFrame;
  readonly viewBindGroup: BindGroup;
  readonly materialBindGroup: BindGroup;
}): Promise<void> {
  const { device } = input;
  const originalMesh = input.prepareInput.meshBySlot?.values().next().value;
  if (originalMesh === undefined) throw Error('missing resident Standard triangle');
  let mesh: MeshGpuHandles = originalMesh;
  let current: PreparedGpuDrivenFrame;
  const readback = device
    .createBuffer({ size: 512, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const activePipeline: RenderPipeline = {
    build: ({ graph, projectGpuDriven }) => {
      const gpu = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 }).unwrap();
      if (gpu === undefined) throw Error('missing Standard GPU projection');
      const depth = graph
        .createTexture('routing-depth', {
          format: 'depth32float-stencil8',
          size: { width: 1, height: 1 },
        })
        .unwrap();
      const depthView = graph.view(depth).unwrap();
      const destination = graph
        .importBuffer(
          'routing-pixels',
          { size: 512, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
          () => readback,
        )
        .unwrap();
      for (const [index, filter] of (
        ['deferred-opaque', 'forward-only-opaque'] as const
      ).entries()) {
        const color = graph
          .createTexture(filter, { format: 'rgba8unorm', size: { width: 1, height: 1 } })
          .unwrap();
        const colorView = graph.view(color).unwrap();
        graph
          .addRasterPass(filter, {
            accesses: [
              ...gpu.accesses,
              { resource: colorView, usage: 'color-attachment' },
              { resource: depthView, usage: 'depth-stencil-write' },
            ],
            colorAttachments: [
              {
                view: colorView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'discard',
              stencilLoadOp: 'clear',
              stencilStoreOp: 'discard',
            },
            encode: ({ pass, resources }) =>
              gpu.encode(
                input.viewBindGroup,
                pass,
                resources,
                {
                  ...current.standardPbrFrameResources,
                  prepareMaterialBinding: (
                    (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                    (slot: number) => {
                      const group = groups[slot];
                      return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                    }
                  )([input.materialBindGroup]),
                },
                filter,
                'fs_opaque',
              ),
          })
          .unwrap();
        graph
          .addCopyPass(`${filter}-readback`, {
            accesses: [
              { resource: colorView, usage: 'copy-src' },
              { resource: destination, usage: 'copy-dst' },
            ],
            encode: ({ encoder, resources }) =>
              encoder.copyTextureToBuffer(
                { texture: resources.texture(color).unwrap() },
                {
                  buffer: resources.buffer(destination).unwrap(),
                  offset: index * 256,
                  bytesPerRow: 256,
                  rowsPerImage: 1,
                },
                { width: 1, height: 1, depthOrArrayLayers: 1 },
              ),
          })
          .unwrap();
      }
      return ok(undefined);
    },
  };
  const state = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  const compile = () => {
    const graph = ensureCompiledFrameGraph(
      { device, errorRegistry } as unknown as RenderSystemInternals,
      state,
      { format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' } as PipelineState,
      makeZeroCameraFallbackSnapshot(),
      { cascades: undefined, pointShadow: [], spot: [], shadowViews: [] } as unknown as ViewLights,
      1,
      1,
      undefined,
      current,
    );
    if (graph === null) throw Error(`Standard routing graph failed: ${String(errors[0])}`);
    return graph;
  };
  let firstGraph: ReturnType<typeof compile> | undefined;
  let secondGraph: ReturnType<typeof compile> | undefined;
  let baseline: number[] | undefined;
  let resourceGeneration: number | undefined;
  let pipelineCount = 0;
  let completed = 0;
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  input.native.pushErrorScope('validation');
  try {
    for (let frame = 0; frame < 60; frame += 1) {
      const deferred = Math.floor(frame / 10) % 2 === 1;
      if (frame === 30) {
        // Repack the same triangle and same buffer from UV0/UV1/UV7 to
        // UV0-only. The real Standard eight-UV ABI aliases UV1 to UV0; its
        // transformed alpha texture still selects the original opaque texel.
        const vertices = new Float32Array([
          -0.8, -0.8, -2, 0, 0, 1, 0.8, 0.8, 1, 0, 0, 1, 0.8, -0.8, -2, 0, 0, 1, 0.8, 0.8, 1, 0, 0,
          1, 0, 0.8, -2, 0, 0, 1, 0.8, 0.8, 1, 0, 0, 1,
        ]);
        device.queue.writeBuffer(originalMesh.vertexBuffer.handle, 0, vertices).unwrap();
        mesh = {
          ...originalMesh,
          contentEpoch: originalMesh.contentEpoch + 1,
          uvSetCount: 1,
          layoutProjection: deriveVertexLayoutProjection({
            position: new Float32Array(9),
            normal: new Float32Array(9),
            uv: new Float32Array(6),
            tangent: new Float32Array(12),
          }),
        };
      }
      input.source.material.adopt({ ...input.source.material.snapshot, deferredPass: deferred });
      const scene = input.prepareInput.scene;
      if (scene === undefined) throw Error('missing retained routing source');
      const prepared = input.production
        .prepare(
          admitPbrDawnFixture({
            ...input.prepareInput,
            scene,
            meshBySlot: new Map(scene.slots.map((slot) => [slot.slot, mesh])),
            shadowViews: false,
          }),
        )
        .unwrap();
      if (prepared === undefined) throw Error('missing prepared routing frame');
      current = prepared;
      current.updateShadowViews?.([]).unwrap();
      resourceGeneration ??= current.standardPbrFrameResources.resourceGeneration;
      expect(current.standardPbrFrameResources.resourceGeneration).toBe(resourceGeneration);
      const sourceDraw = input.source.gpuDrivenDraws?.[0];
      if (sourceDraw === undefined) throw Error('missing source draw');
      expect(current.selection.owns(input.source, sourceDraw, 0)).toBe(true);
      const graph = compile();
      if (frame === 0) {
        firstGraph = graph;
        pipelineCount = pipelines.mock.calls.length;
      } else if (frame === 30) {
        secondGraph = graph;
        expect(secondGraph).not.toBe(firstGraph);
        const changed = pipelines.mock.calls.slice(pipelineCount);
        expect(changed).toHaveLength(1);
        expect(changed[0]?.[0].vertex.buffers?.[0]?.arrayStride).toBe(48);
        expect(originalMesh.layoutProjection.arrayStride).toBe(64);
        pipelineCount = pipelines.mock.calls.length;
      } else {
        expect(graph).toBe(frame < 30 ? firstGraph : secondGraph);
        expect(pipelines.mock.calls.length).toBe(pipelineCount);
      }
      expect(state.compiledFrameGraphGeneration).toBe(frame < 30 ? 1 : 2);
      const encoder = device.createCommandEncoder().unwrap();
      graph.execute({ encoder } as RenderPipelineFrame).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      current._commitResourceReplacement();
      completed += 1;
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      try {
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        const selectedOffset = deferred ? 0 : 256;
        const selected = [...bytes.slice(selectedOffset, selectedOffset + 4)];
        const emptyOffset = deferred ? 256 : 0;
        expect([...bytes.slice(emptyOffset, emptyOffset + 4)]).toEqual([0, 0, 0, 0]);
        expect(selected[0]).toBeGreaterThan(0);
        expect(selected[1]).toBeGreaterThan(0);
        expect(selected[3]).toBeGreaterThan(0);
        baseline ??= selected;
        expect(selected).toEqual(baseline);
      } finally {
        mapped.unmap();
      }
    }
    expect(completed).toBe(60);
    expect(errors).toHaveLength(0);
    const validation = await input.native.popErrorScope();
    expect(validation, validation?.message).toBeNull();
  } finally {
    pipelines.mockRestore();
    await state.compiledFrameGraph?.graph.retire();
    for (const graph of state.retiredCompiledFrameGraphs) await graph.retire();
    device.destroyBuffer(readback);
  }
}
