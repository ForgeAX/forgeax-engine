import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GPU_DRIVEN_LOD_LEVEL_CAPACITY } from '../gpu-driven/batch-layout';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { type GpuDrivenCullingProducerReceipt, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { updateGpuView, updateShadowView } from './helpers/gpu-input-read-domain';

// Counter bytes are supplied by this structural test, not claimed as GPU execution.
const texelWord = 2 + GPU_DRIVEN_LOD_LEVEL_CAPACITY + 2;
const cameraWord = texelWord + 1 + 2 * GPU_DRIVEN_LOD_LEVEL_CAPACITY + 1;
const stride = (cameraWord + 1) * 4;
const receipt = (): GpuDrivenCullingProducerReceipt => ({
  frameId: 17,
  deviceGeneration: 3,
  graphGeneration: 4,
  viewKey: 'directional:0:',
  viewGeneration: 5,
  sourceRevision: 6,
});

async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const source = new RenderScene();
  const material = new MaterialResource({
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
  } as MaterialSnapshot);
  const snapshot = (entityKey: number): RenderableSnapshot => ({
    assetHandle: entityKey,
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
  });
  const delta = source.apply(
    [1, 2].map((entityKey) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: snapshot(entityKey),
    })),
  );
  const available = GpuScene.create(device, 2).unwrap();
  if (available.status !== 'available') throw new Error('scene unavailable');
  available.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(source.slotsSnapshot());
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const factory = { createShaderModule: () => ok(shader) };
  const view = GpuDrivenView.create({ device, shaderModuleFactory: factory }).unwrap();
  updateGpuView(
    view,
    topology.query(topology.sourcePlan(), undefined),
    available.scene,
    planes,
  ).unwrap();
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  view.addPasses(graph).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encode = () => {
    const encoder = device.createCommandEncoder().unwrap();
    const copies = vi.spyOn(encoder, 'copyBufferToBuffer');
    compiled.execute({ encoder }).unwrap();
    encoder.finish().unwrap();
    return copies.mock.calls.length;
  };
  return { device, view, encode, topology, planes, scene: available.scene, factory };
}

function mappedCounters(view: GpuDrivenView) {
  const bytes = new ArrayBuffer(2 * stride);
  const data = new DataView(bytes);
  data.setUint32(0, 1000, true); // Clamped to this copied plan's visibleCapacity.
  data.setUint32(texelWord * 4, 2, true);
  data.setUint32(cameraWord * 4, 3, true);
  data.setUint32(stride, 7, true);
  data.setUint32(stride + 4, 1, true); // Overflow: no valid compacted rows in batch 2.
  data.setUint32(stride + texelWord * 4, 4, true);
  data.setUint32(stride + cameraWord * 4, 5, true);
  const internal = view as unknown as {
    buffers: { lodReadback: object };
    resourceGeneration: number;
  };
  let state = 'unmapped';
  let settle: (() => void) | undefined;
  const mapped = {
    getMappedRange: () => ok(bytes),
    unmap: vi.fn(() => {
      state = 'unmapped';
    }),
  };
  const mapAsync = vi.fn(() => {
    state = 'pending';
    return new Promise<ReturnType<typeof ok<typeof mapped>>>((resolve) => {
      settle = () => {
        state = 'mapped';
        resolve(ok(mapped));
      };
    });
  });
  Object.defineProperties(internal.buffers.lodReadback, {
    mapState: { get: () => state, configurable: true },
    mapAsync: { value: mapAsync, configurable: true },
  });
  return {
    internal,
    mapAsync,
    settle: () => {
      if (settle === undefined) throw new Error('no pending readback');
      settle();
    },
    unmap: mapped.unmap,
  };
}

describe('existing shadow culling readback producer receipt', () => {
  it('keeps default copies/maps and legacy counters unchanged without diagnostic decoding', async () => {
    const f = await fixture();
    const mapped = mappedCounters(f.view);
    expect(f.encode()).toBe(3);
    const pending = f.view.readCullingCounts();
    mapped.settle();
    expect(await pending).toEqual({ texelCulled: 6, cameraCulled: 8 });
    expect(mapped.mapAsync).toHaveBeenCalledTimes(1);
    expect(mapped.unmap).toHaveBeenCalledTimes(1);
    f.view.dispose();
    f.scene.dispose();
  });

  it('captures immutable producer/copy facts and overflow without adding copies or maps', async () => {
    const f = await fixture();
    const mapped = mappedCounters(f.view);
    const identity = receipt();
    f.view._setCullingTelemetrySubmit(identity);
    expect(await f.view.readCullingCounts()).toBeUndefined();
    expect(mapped.mapAsync).not.toHaveBeenCalled();
    expect(f.encode()).toBe(3);
    // Caller/latest submit changes after encoding must not relabel the pending bytes.
    Object.assign(identity, { frameId: 99, sourceRevision: 999 });
    f.view._setCullingTelemetrySubmit({ ...receipt(), frameId: 18 });
    const pending = f.view.readCullingCounts();
    mapped.settle();
    const result = await pending;
    expect(result?.observation).toMatchObject({
      producer: receipt(),
      resourceGeneration: f.view.computeResourceGeneration,
      planRevision: f.topology.query(f.topology.sourcePlan(), undefined).revision,
      candidateCount: 2,
      batchCount: 2,
      visible: f.topology.query(f.topology.sourcePlan(), undefined).batches.at(0)?.visibleCapacity,
      overflow: true,
      texelCulled: 6,
      cameraCulled: 8,
    });
    expect(Object.isFrozen(result?.observation)).toBe(true);
    expect(Object.isFrozen(result?.observation?.producer)).toBe(true);
    expect(mapped.mapAsync).toHaveBeenCalledTimes(1);
    f.view.dispose();
    f.scene.dispose();
  });

  it('keeps a pending-map skipped copy on its original producer, then recovers', async () => {
    const f = await fixture();
    const mapped = mappedCounters(f.view);
    f.view._setCullingTelemetrySubmit(receipt());
    expect(f.encode()).toBe(3);
    const first = f.view.readCullingCounts();
    f.view._setCullingTelemetrySubmit({ ...receipt(), frameId: 18 });
    expect(f.encode()).toBe(0);
    mapped.settle();
    expect((await first)?.observation?.producer.frameId).toBe(17);
    expect(f.encode()).toBe(3);
    const second = f.view.readCullingCounts();
    mapped.settle();
    expect((await second)?.observation?.producer.frameId).toBe(18);
    updateGpuView(
      f.view,
      f.topology.query(f.topology.sourcePlan(), undefined),
      f.scene,
      f.planes,
    ).unwrap();
    expect(f.encode()).toBe(3);
    const withoutReceipt = f.view.readCullingCounts();
    mapped.settle();
    expect((await withoutReceipt)?.observation).toBeUndefined();
    f.view.dispose();
    f.scene.dispose();
  });

  it('rejects replaced resources while mapping and unmaps the old buffer', async () => {
    const f = await fixture();
    const mapped = mappedCounters(f.view);
    f.view._setCullingTelemetrySubmit(receipt());
    f.encode();
    const pending = f.view.readCullingCounts();
    mapped.internal.resourceGeneration += 1;
    mapped.settle();
    expect(await pending).toBeUndefined();
    expect(mapped.unmap).toHaveBeenCalledTimes(1);
    f.view.dispose();
    f.scene.dispose();
  });

  it('retains old observation identity separately from the current shadow generation', async () => {
    const f = await fixture();
    const pool = ShadowViewStatePool.create({
      device: f.device,
      shaderModuleFactory: f.factory,
    }).unwrap();
    const identity = { kind: 'directional' as const, index: 0 };
    const input = {
      identity,
      sourcePlan: f.topology.query(f.topology.sourcePlan(), undefined),
      scene: f.scene,
      planes: f.planes,
      matrix: mat4.identity(mat4.create()),
      targetSize: 1024,
      graphGeneration: 4,
    };
    const first = updateShadowView(pool, input).unwrap();
    const mapped = mappedCounters(first.view);
    pool._setTelemetrySubmit({ frameId: 17, deviceGeneration: 3, graphGeneration: 4 });
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    pool.project(graph, identity).unwrap();
    const compiled = graph
      .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
      .unwrap();
    const encoder = f.device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    encoder.finish().unwrap();
    pool._commitResourceReplacement(4);
    expect(mapped.mapAsync).toHaveBeenCalledTimes(1);
    const planes = new Float32Array(input.planes);
    planes[3] = (planes[3] ?? 0) + 0.1;
    const next = updateShadowView(pool, { ...input, planes }).unwrap();
    pool._setTelemetrySubmit({ frameId: 18, deviceGeneration: 3, graphGeneration: 4 });
    expect(next.generation).toBeGreaterThan(first.generation);
    mapped.settle();
    await Promise.resolve();
    await Promise.resolve();
    const observed = pool.inspect()[0];
    expect(observed?.generation).toBe(next.generation);
    expect(observed?.lastCullingObservation?.producer).toMatchObject({
      frameId: 17,
      deviceGeneration: 3,
      graphGeneration: 4,
      viewGeneration: first.generation,
      sourceRevision: input.sourcePlan.revision,
    });
    // No submit/map for an aborted next frame, and the old result is explicitly old.
    pool._abortResourceReplacement();
    expect(mapped.mapAsync).toHaveBeenCalledTimes(1);
    pool.dispose();
    f.view.dispose();
    f.scene.dispose();
  });
});
