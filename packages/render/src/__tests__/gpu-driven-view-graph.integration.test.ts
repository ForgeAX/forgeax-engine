import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { EMPTY_GPU_DRAW_SELECTION } from '../gpu-driven/draw-selection';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GPU_DRIVEN_BATCH_STRIDE, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { MaterialResource } from '../material-resource';
import type { RenderFrameState } from '../record/frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { ensureCompiledFrameGraph, executeCompiledFrameGraph } from '../record/typed-frame-graph';
import type { RenderPipeline, RenderPipelineFrame } from '../render-pipeline';
import type { ExtractedLights, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { createTemporalFrameTransaction } from '../temporal/frame';
import { updateGpuView } from './helpers/gpu-input-read-domain';

const material = new MaterialResource({
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 1,
  passes: [],
});

function snapshot(entityKey: number): RenderableSnapshot {
  return {
    assetHandle: 3,
    transform: { world: new Float32Array(mat4.identity(mat4.create())) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        geometry: {
          receipt: { identity: 'cube', vertexInputs: [], topology: 'triangle-list', indexed: true },
          draw: { kind: 'indexed', topology: 'triangle-list', first: 0, count: 36, baseVertex: 0 },
          deformation: 'rigid',
        },
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
      },
    ],
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function preparedFrame(view: GpuDrivenView): PreparedGpuDrivenFrame {
  return {
    topologySignature: `view-generation:${view.inspect().resourceGeneration}`,
    worldKeys: [],
    materialBindings: [],
    shadowDirectRequired: false,
    selection: EMPTY_GPU_DRAW_SELECTION,
    _trackSubmittedWork: () => undefined,
    _sealResourceReads: () => ok(undefined),
    standardPbrFrameResources: {
      prepareMaterialBinding: (
        (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
        (slot: number) => {
          const group = groups[slot];
          return group === undefined ? undefined : { group, byteOffset: slot * 0 };
        }
      )([]),
      materialSlotIndicesByBinding: new Map(),

      sceneMaterialBuffer: {} as never,
    },
    _commitResourceReplacement: () => view._commitResourceReplacement(),
    project: (graph) => {
      const projected = view.addPasses(graph);
      return projected.ok
        ? ok({ accesses: [], hasWork: () => false, encode: () => undefined })
        : projected;
    },
  };
}

describe('GpuDrivenView graph projection', () => {
  it('keeps receiver rows optional, updates stable addresses, and reseeds them after overflow', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const available = GpuScene.create(device, 1).unwrap();
    if (available.status !== 'available') throw new Error('missing structural GPU Scene');
    available.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const update = (rows?: Uint32Array) =>
      updateGpuView(
        view,
        topology.query(topology.sourcePlan(), undefined),
        available.scene,
        planes,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        rows,
      );
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const destroys = vi.spyOn(device, 'destroyBuffer');
    try {
      expect(view.currentResourceGeneration).toBe(0);
      update().unwrap();
      expect(view.currentResourceGeneration).toBe(view.inspect().resourceGeneration);
      expect(view.currentResourceGeneration).toBeGreaterThan(0);
      expect(view.visibleSurfaceRowsBuffer).toBeUndefined();
      expect(update(new Uint32Array(2)).ok).toBe(false);
      update(new Uint32Array([7])).unwrap();
      const generation = view.currentResourceGeneration;
      const first = view.visibleSurfaceRowsBuffer;
      expect(first).toBeDefined();
      writes.mockClear();
      update(new Uint32Array([7])).unwrap();
      expect(view.currentResourceGeneration).toBe(generation);
      expect(writes.mock.calls.some(([buffer]) => buffer === first)).toBe(false);
      update(new Uint32Array([11])).unwrap();
      expect(view.visibleSurfaceRowsBuffer).toBe(first);
      expect(
        writes.mock.calls.some(
          ([buffer, , data]) => buffer === first && data instanceof Uint32Array && data[0] === 11,
        ),
      ).toBe(true);
      view._commitResourceReplacement();
      await device.queue.onSubmittedWorkDone();
      destroys.mockClear();
      view._recoverFromOverflow().unwrap();
      expect(view.currentResourceGeneration).toBe(view.inspect().resourceGeneration);
      const next = view.visibleSurfaceRowsBuffer;
      expect(next).toBeDefined();
      expect(next).not.toBe(first);
      expect(destroys).not.toHaveBeenCalledWith(first);
      writes.mockClear();
      update(new Uint32Array([11])).unwrap();
      expect(writes.mock.calls.some(([buffer]) => buffer === next)).toBe(true);
      // View-local overflow leaves the shared member arena resident.
      expect(view.inspect().sharedInputUploadBytes).toBe(0);
      view._commitResourceReplacement();
      await device.queue.onSubmittedWorkDone();
      expect(destroys).toHaveBeenCalledWith(first);
      update().unwrap();
      expect(view.visibleSurfaceRowsBuffer).toBeUndefined();
    } finally {
      view.dispose();
      available.scene.dispose();
    }
  });

  it('rebuilds the compiled graph only when GPU projection presence changes', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const activePipeline: RenderPipeline = {
      build: ({ projectGpuDriven }) => {
        const projected = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 });
        return projected.ok ? ok(undefined) : projected;
      },
    };
    const frameState = {
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      compiledFrameGraph: null,
      retiredCompiledFrameGraphs: new Set(),
      activePipeline,
      installedPipelineConfig: undefined,
    } as unknown as RenderFrameState;
    const errors: unknown[] = [];
    const errorRegistry = new RhiErrorListenerRegistry();
    errorRegistry.add((error) => errors.push(error));
    const internals = { device, errorRegistry } as unknown as RenderSystemInternals;
    const pipelineState = {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState;
    const lights = {
      cascadeCount: undefined,
      pointShadow: [],
      spot: [],
    } as unknown as ExtractedLights;
    const compile = (prepared?: PreparedGpuDrivenFrame) =>
      ensureCompiledFrameGraph(
        internals,
        frameState,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        1,
        1,
        undefined,
        prepared,
      );

    const first = compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    const prepared: PreparedGpuDrivenFrame = {
      topologySignature: 'stable-gpu-driven-test',
      worldKeys: [],
      materialBindings: [],
      shadowDirectRequired: false,
      selection: EMPTY_GPU_DRAW_SELECTION,
      _trackSubmittedWork: () => undefined,
      _sealResourceReads: () => ok(undefined),
      standardPbrFrameResources: {
        prepareMaterialBinding: (
          (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
          (slot: number) => {
            const group = groups[slot];
            return group === undefined ? undefined : { group, byteOffset: slot * 0 };
          }
        )([]),
        materialSlotIndicesByBinding: new Map(),

        sceneMaterialBuffer: {} as never,
      },
      _commitResourceReplacement: () => undefined,
      project: (graph) => {
        const pass = graph.addComputePass('gpu-driven-test', {
          accesses: [],
          encode: () => undefined,
        });
        return pass.ok ? ok({ accesses: [], hasWork: () => false, encode: () => undefined }) : pass;
      },
    };
    const gpu = compile(prepared);
    expect(gpu).not.toBe(first);
    expect(gpu?.inspect().passes.map(({ name }) => name)).toContain('gpu-driven-test');
    expect(compile(prepared)).toBe(gpu);
    const second = compile();
    expect(second).not.toBe(gpu);
    expect(errors).toHaveLength(0);
  });

  it('records reset, compact, and finalize in one typed graph', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const sceneAvailability = GpuScene.create(device, 1).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    ).unwrap();
    expect(view.inspect()).toMatchObject({
      topologyRevision: topology.query(topology.sourcePlan(), undefined).revision,
      candidateCount: 1,
      batchCount: 1,
      visibleCapacity: 64,
      updateCount: 1,
      bufferRebuilds: 1,

      batchUploadBytes: GPU_DRIVEN_BATCH_STRIDE,
      viewConstantsUploadBytes: 784,
      bindGroupCreates: 1,
    });
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThan(0);

    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    ).unwrap();
    expect(view.inspect()).toMatchObject({
      updateCount: 2,
      bufferRebuilds: 1,
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 784,
      bindGroupCreates: 0,
    });

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(view.addPasses(graph).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes).toMatchObject([
      { name: 'gpu-driven.view-reset', kind: 'compute', dependencies: [] },
      {
        name: 'gpu-driven.frustum-compact',
        kind: 'compute',
        dependencies: ['gpu-driven.view-reset'],
      },
      {
        name: 'gpu-driven.finalize-indirect',
        kind: 'compute',
        dependencies: ['gpu-driven.frustum-compact'],
      },
      {
        name: 'gpu-driven.lod-selection-readback',
        kind: 'copy',
        dependencies: ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'],
      },
    ]);
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-view' }).unwrap();
    compiled.execute({ encoder }).unwrap();
    encoder.finish().unwrap();
    expect((device as RhiNullDevice).framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
    ]);

    view.dispose();
    sceneAvailability.scene.dispose();
  });

  it('keeps last-known-good graph buffers alive until replacement promotion', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
    const projection = new RenderScene();
    const firstDelta = projection.apply([updateSnapshot(snapshot(1))]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(firstDelta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
    ).unwrap();
    const previousVisible = view.visibleBuffer;
    expect(previousVisible).toBeDefined();
    if (previousVisible === undefined) return;

    let forceCompileFailure = false;
    const activePipeline: RenderPipeline = {
      build: ({ graph, projectGpuDriven }) => {
        const projected = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 });
        if (!projected.ok) return projected;
        if (forceCompileFailure) {
          const dangling = graph
            .createBuffer('forced-candidate-compile-failure', { size: 4 })
            .unwrap();
          graph
            .addComputePass('forced-candidate-compile-failure', {
              accesses: [{ resource: dangling, usage: 'storage-read' }],
              encode: () => undefined,
            })
            .unwrap();
        }
        return ok(undefined);
      },
    };
    const frameState = {
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      compiledFrameGraph: null,
      compiledFrameGraphGeneration: 0,
      retiredCompiledFrameGraphs: new Set(),
      activePipeline,
      installedPipelineConfig: undefined,
    } as unknown as RenderFrameState;
    const errors: unknown[] = [];
    const errorRegistry = new RhiErrorListenerRegistry();
    errorRegistry.add((error) => errors.push(error));
    const internals = { device, errorRegistry } as unknown as RenderSystemInternals;
    const pipelineState = {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState;
    const lights = {
      cascadeCount: undefined,
      pointShadow: [],
      spot: [],
    } as unknown as ExtractedLights;
    const compile = (prepared: PreparedGpuDrivenFrame, width = 1) =>
      ensureCompiledFrameGraph(
        internals,
        frameState,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        width,
        1,
        undefined,
        prepared,
      );

    Object.defineProperty(device, 'surfaceViewFormats', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(device, 'caps', {
      configurable: true,
      value: { ...device.caps, rgba16floatRenderable: false },
    });
    expect(compile(preparedFrame(view))).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'surface-raw-endpoint-failed' } },
    });
    errors.length = 0;
    delete (device as unknown as { caps?: unknown }).caps;
    delete (device as unknown as { surfaceViewFormats?: unknown }).surfaceViewFormats;

    const compiledPrevious = compile(preparedFrame(view));
    expect(compiledPrevious).not.toBeNull();
    if (compiledPrevious === null) return;
    expect(frameState.compiledFrameGraphGeneration).toBe(1);
    const initialEncoder = device
      .createCommandEncoder({ label: 'gpu-driven-view-initial' })
      .unwrap();
    expect(
      executeCompiledFrameGraph(
        internals,
        frameState,
        { encoder: initialEncoder, pipelineState } as unknown as RenderPipelineFrame,
        initialEncoder,
      ),
    ).toBe(true);

    Object.defineProperty(device, 'surfaceViewFormats', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(device, 'caps', {
      configurable: true,
      value: { ...device.caps, rgba16floatRenderable: false },
    });
    expect(compile(preparedFrame(view))).toBe(compiledPrevious);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'surface-raw-endpoint-failed' } },
    });
    errors.length = 0;
    delete (device as unknown as { caps?: unknown }).caps;
    delete (device as unknown as { surfaceViewFormats?: unknown }).surfaceViewFormats;

    const secondDelta = projection.apply([updateSnapshot(snapshot(2))]);
    sceneAvailability.scene.sync(secondDelta).unwrap();
    topology.rebuild(projection.slotsSnapshot());
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
    ).unwrap();

    expect(view.inspect()).toMatchObject({ candidateCount: 2, candidateCapacity: 2 });
    forceCompileFailure = true;
    expect(compile(preparedFrame(view), 2)).toBe(compiledPrevious);
    expect(frameState.compiledFrameGraphGeneration).toBe(1);
    expect(errors).toHaveLength(1);
    expect(destroyBuffer.mock.calls.some(([buffer]) => buffer === previousVisible)).toBe(false);
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-view-lkg' }).unwrap();
    expect(compiledPrevious.execute({ encoder } as RenderPipelineFrame).ok).toBe(true);

    forceCompileFailure = false;
    const retirePrevious = vi.spyOn(compiledPrevious, 'retire');
    const acceptedGraph = compile(preparedFrame(view), 2);
    expect(acceptedGraph).not.toBe(compiledPrevious);
    expect(retirePrevious).not.toHaveBeenCalled();
    expect(destroyBuffer.mock.calls.some(([buffer]) => buffer === previousVisible)).toBe(false);
    expect(frameState.compiledFrameGraphGeneration).toBe(2);
    expect(retirePrevious).not.toHaveBeenCalled();
    const acceptedEncoder = device
      .createCommandEncoder({ label: 'gpu-driven-view-accepted' })
      .unwrap();
    expect(
      executeCompiledFrameGraph(
        internals,
        frameState,
        { encoder: acceptedEncoder, pipelineState } as unknown as RenderPipelineFrame,
        acceptedEncoder,
      ),
    ).toBe(true);
    expect(retirePrevious).toHaveBeenCalledOnce();
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    expect(destroyBuffer.mock.calls.some(([buffer]) => buffer === previousVisible)).toBe(true);

    const returnedToPreviousTopology = compile(preparedFrame(view), 1);
    expect(returnedToPreviousTopology).not.toBe(acceptedGraph);
    expect(frameState.compiledFrameGraphGeneration).toBe(3);

    view.dispose();
    sceneAvailability.scene.dispose();
  });

  it('releases a promoted generation once when the queue fence rejects', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
    const projection = new RenderScene();
    const firstDelta = projection.apply([updateSnapshot(snapshot(1))]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(firstDelta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
    ).unwrap();
    const firstVisible = view.visibleBuffer;
    expect(firstVisible).toBeDefined();
    if (firstVisible === undefined) return;

    const secondDelta = projection.apply([updateSnapshot(snapshot(2))]);
    sceneAvailability.scene.sync(secondDelta).unwrap();
    topology.rebuild(projection.slotsSnapshot());
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
    ).unwrap();
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockRejectedValueOnce(new Error('device lost'));
    view._commitResourceReplacement();
    await Promise.resolve();
    await Promise.resolve();
    expect(destroyBuffer.mock.calls.filter(([buffer]) => buffer === firstVisible)).toHaveLength(1);

    view.dispose();
    sceneAvailability.scene.dispose();
  });
});
