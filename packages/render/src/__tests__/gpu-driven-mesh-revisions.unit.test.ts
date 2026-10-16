import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, ok } from '@forgeax/engine-rhi';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import { deriveMaterialDynamicInputLayout } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import {
  BatchTopology,
  buildBatchAlignedSubmission,
  type GpuDrivenBatch,
} from '../gpu-driven/batch-topology';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import * as materialBindings from '../gpu-driven/material-bindings';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type {
  PreparedBatchRows,
  PreparedProductionPlan,
} from '../gpu-driven/production-raster-prepare';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

async function fixture(materialIndices?: readonly number[]) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  const configure = () =>
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('Unused cubemap registration');
      },
      device.caps,
    );
  configure();
  const world = new World();
  const pods = [1, 2].map((size) => createBoxGeometry(size, size, size).unwrap());
  const handles = pods.map((pod) => world.allocSharedRef('MeshAsset', pod));
  const meshes = pods.map((pod, index) =>
    store.ensureResident(defined(handles[index]), pod, world).unwrap(),
  );
  const projection = new RenderScene();
  const snapshots = (materialIndices ?? [0, 1]).map((meshIndex, index): RenderableSnapshot => {
    const handle = defined(handles[meshIndex]);
    const material = {
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      materialHandle: (materialIndices === undefined ? index : meshIndex) + 100,
    };
    const matrix = mat4.identity(mat4.create());
    const transforms = new Float32Array(8 * 16);
    for (let ordinal = 0; ordinal < 8; ordinal++) transforms.set(matrix, ordinal * 16);
    const base = preparedPbrSnapshot({
      worldId: 0,
      entityKey: index + 1,
      assetHandle: Number(handle),
      transform: { world: matrix },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      instances: { transforms, instanceCount: 8, cacheKey: index + 1, archVersion: 1 },
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: defined(pods[meshIndex]?.indices).length,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'fixture',
          materialResourceClass: 'fixture',
        },
      ],
    });
    if (materialIndices === undefined) return base;
    const materialShaderId =
      meshIndex === 0 ? base.material.materialShaderId : 'fixture::second-material';
    return {
      ...base,
      material: { ...base.material, materialShaderId },
      materials: base.materials.map((material) => ({ ...material, materialShaderId })),
      gpuDrivenDraws: defined(base.gpuDrivenDraws).map((draw) => ({
        ...draw,
        prepared: {
          ...defined(draw.prepared),
          receiptIdentity: createStandardPbrArtifactReceipt().receiptIdentity,
          identity: { ...defined(draw.prepared).identity, material: defined(materialShaderId) },
        },
      })),
    };
  });
  const delta = projection.apply(
    snapshots.map((snapshot) => ({
      kind: 'update' as const,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  const availability = GpuScene.create(device, materialIndices === undefined ? 16 : 32).unwrap();
  if (availability.status !== 'available') throw new Error('Expected Null GPU Scene capability');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  expect(topology.plan().batches).toHaveLength(2);
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const bySlot = new Map(
    projection
      .slotsSnapshot()
      .map((slot) => [
        slot.slot,
        defined(meshes[slot.snapshot.assetHandle === Number(handles[0]) ? 0 : 1]),
      ]),
  );
  const input = {
    ...standardPbrInputs(device, shader, viewLayout),
    scene: {
      scene: availability.scene,
      plan: topology.plan(),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: bySlot,
    viewBindGroupLayout: viewLayout,
    meshResidencyEpoch: store.meshResidencyEpoch,
  };
  const prepare = () => {
    input.meshResidencyEpoch = store.meshResidencyEpoch;
    const frame = production.prepare(input).unwrap();
    if (frame === undefined) throw new Error('Expected admitted prepared frame');
    frame._commitResourceReplacement();
    return frame;
  };
  const unrelatedUpload = () => {
    const pod = createBoxGeometry(3, 3, 3).unwrap(),
      handle = world.allocSharedRef('MeshAsset', pod);
    return store.ensureResident(handle, pod, world).unwrap();
  };
  return {
    device,
    store,
    world,
    pods,
    handles,
    meshes,
    bySlot,
    input,
    production,
    projection,
    topology,
    shader,
    configure,
    prepare,
    unrelatedUpload,
    close() {
      production.dispose();
      availability.scene.dispose();
      store.destroyAll();
    },
  };
}

describe('GPU-driven resident mesh identity and content epochs', () => {
  it('retains stock graph structure across mesh replacement while encoding current buffers', async () => {
    const f = await fixture();
    let completeOld: () => void = () => undefined;
    const oldCompleted = new Promise<void>((resolve) => {
      completeOld = resolve;
    });
    const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
    let compiled: ReturnType<RenderGraphBuilder<RenderPipelineFrame>['compile']> | undefined;
    try {
      let current = f.prepare();
      const firstSignature = current.topologySignature;
      const recordingSignature = current._recordingTopologySignature;
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const gpu = current
        .project(graph, 'rgba8unorm', 1, undefined, undefined, false, true)
        .unwrap();
      const target = graph
        .createTexture('live-mesh-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
        .unwrap();
      const view = graph.view(target).unwrap();
      const viewGroup = f.device
        .createBindGroup({ layout: f.input.viewBindGroupLayout, entries: [] })
        .unwrap();
      const materialLayout = f.device.createBindGroupLayout({ entries: [] }).unwrap();
      const materialGroup = f.device
        .createBindGroup({ layout: materialLayout, entries: [] })
        .unwrap();
      graph
        .addRasterPass('live-mesh', {
          accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          encode: ({ pass, resources }) =>
            gpu.encode(viewGroup, pass, resources, {
              ...current.standardPbrFrameResources,
              materialBindGroups: [materialGroup],
            }),
        })
        .unwrap();
      compiled = graph.compile({ device: f.device, surfaceSize: { width: 1, height: 1 } });
      const retained = compiled.unwrap();
      const encode = () => {
        const encoder = f.device.createCommandEncoder().unwrap();
        retained.execute({ encoder } as RenderPipelineFrame).unwrap();
        f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      };
      encode();
      f.store.trackMeshSubmission(oldCompleted);
      const old = defined(f.meshes[0]);
      f.store.evictMesh(defined(f.handles[0]), f.world);
      const pod = defined(f.pods[0]);
      const changedVertices = new Float32Array(pod.vertices);
      changedVertices[0] = (changedVertices[0] ?? 0) + 0.125;
      const replacement = f.store
        .ensureResident(defined(f.handles[0]), { ...pod, vertices: changedVertices }, f.world)
        .unwrap();
      expect(replacement.vertexBuffer).not.toBe(old.vertexBuffer);
      expect(old.vertexBuffer.isDestroyed).toBe(false);
      f.bySlot.set(0, replacement);
      current = f.prepare();
      expect(current.topologySignature).not.toBe(firstSignature);
      expect(current._recordingTopologySignature).toBe(recordingSignature);
      vertices.mockClear();
      encode();
      expect(
        vertices.mock.calls.some(([, buffer]) => buffer === replacement.vertexBuffer.handle),
      ).toBe(true);
      expect(vertices.mock.calls.some(([, buffer]) => buffer === old.vertexBuffer.handle)).toBe(
        false,
      );
      completeOld();
      await oldCompleted;
      await Promise.resolve();
      expect(old.vertexBuffer.isDestroyed).toBe(true);
      expect(replacement.vertexBuffer.isDestroyed).toBe(false);
      const changedArtifact = {
        ...defined(f.input.standardPbrArtifact),
        fragmentEntry: 'changed-entry',
      };
      const changedProgram = defined(
        f.production
          .prepare({
            ...f.input,
            meshResidencyEpoch: f.store.meshResidencyEpoch,
            standardPbrArtifact: changedArtifact,
          })
          .unwrap(),
      );
      expect(changedProgram._recordingTopologySignature).not.toBe(recordingSignature);
      changedProgram._commitResourceReplacement();
    } finally {
      completeOld();
      vertices.mockRestore();
      if (compiled?.ok) await compiled.value.retire();
      f.close();
    }
  });

  it('observes stable rows without allocating a live set or rescanning retained batches', async () => {
    const f = await fixture();
    const retained = f.production as unknown as {
      preparedBatches: Map<number, { value: PreparedBatchRows }>;
      preparedCache: { batchRows: readonly PreparedBatchRows[]; value: PreparedProductionPlan };
    };
    try {
      const first = f.prepare();
      const rows = retained.preparedCache.batchRows;
      const plan = retained.preparedCache.value;
      const keys = vi.spyOn(retained.preparedBatches, 'keys');
      const sets: unknown[] = [];
      const NativeSet = globalThis.Set;
      class CountedSet<T> extends NativeSet<T> {
        constructor(values?: Iterable<T> | null) {
          super(values);
          sets.push(this);
        }
      }
      let comparisons = 0;
      for (let index = 0; index < 12; index++) {
        const frame = defined(
          f.production
            .prepare({
              ...f.input,
              profilePhase: (phase, action) => {
                if (phase !== 'record/gpu-driven-prepare/plan') return action();
                const every = Array.prototype.every;
                const repeated = vi.spyOn(Array.prototype, 'every').mockImplementation(function (
                  this: unknown[],
                  predicate,
                  thisArg,
                ) {
                  comparisons++;
                  return every.call(this, predicate, thisArg);
                });
                globalThis.Set = CountedSet;
                try {
                  return action();
                } finally {
                  globalThis.Set = NativeSet;
                  repeated.mockRestore();
                }
              },
            })
            .unwrap(),
        );
        frame._commitResourceReplacement();
        expect(frame.topologySignature).toBe(first.topologySignature);
        expect(retained.preparedCache.batchRows).toBe(rows);
        expect(retained.preparedCache.value).toBe(plan);
        expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      }
      expect(sets).toHaveLength(0);
      expect(keys).not.toHaveBeenCalled();
      expect(comparisons).toBe(0);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it('prunes exactly the retired native batch IDs through reorder, replacement and empty plans', async () => {
    const f = await fixture();
    const retained = f.production as unknown as {
      preparedBatches: Map<number, { value: PreparedBatchRows }>;
      preparedCache: { batchRows: readonly PreparedBatchRows[] };
    };
    const snapshots = f.input.scene.slots.map((slot) => slot.snapshot);
    const patch = (changes: Parameters<RenderScene['apply']>[0]) => {
      const delta = f.projection.apply(changes);
      f.input.scene.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.input.scene.plan = f.topology.plan();
      f.input.scene.slots = f.projection.slotsSnapshot();
      f.bySlot.clear();
      for (const slot of f.input.scene.slots)
        f.bySlot.set(
          slot.slot,
          defined(
            f.meshes[f.handles.findIndex((handle) => Number(handle) === slot.snapshot.assetHandle)],
          ),
        );
    };
    const check = () => {
      const frame = f.production.prepare(f.input).unwrap();
      frame?._commitResourceReplacement();
      const ids = f.input.scene.plan.batches.map((batch) => batch.batchId);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...retained.preparedBatches.keys()].sort()).toEqual([...ids].sort());
      expect(retained.preparedCache.batchRows.map((row) => row.source.batchId)).toEqual(ids);
      return frame;
    };
    try {
      check();
      const original = retained.preparedCache.batchRows;
      const native = f.input.scene.plan;
      f.input.scene.plan = { ...native, batches: Object.freeze([...native.batches].reverse()) };
      check();
      expect(retained.preparedCache.batchRows).toEqual([...original].reverse());
      expect(original.map((row) => row.source.batchId)).toEqual(
        native.batches.map((batch) => batch.batchId),
      );
      patch([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      check();
      expect(retained.preparedBatches.size).toBe(1);
      const add = (entityKey: number, source = defined(snapshots[0])) => ({
        kind: 'update' as const,
        worldId: 0,
        entityKey,
        snapshot: { ...source, entityKey },
      });
      patch([add(3)]);
      check();
      expect(retained.preparedBatches.size).toBe(2);
      const replaced = f.input.scene.plan.batches;
      patch([{ kind: 'remove', worldId: 0, entityKey: 3 }, add(4)]);
      check();
      expect(retained.preparedBatches.size).toBe(2);
      expect(f.input.scene.plan.batches).not.toEqual(replaced);
      patch([
        { kind: 'remove', worldId: 0, entityKey: 2 },
        { kind: 'remove', worldId: 0, entityKey: 4 },
      ]);
      expect(check()).toBeUndefined();
      expect(retained.preparedBatches.size).toBe(0);
      patch([add(5), add(6, defined(snapshots[1]))]);
      check();
      expect(retained.preparedBatches.size).toBe(2);
      const pod = defined(f.pods[0]);
      const handle = f.world.allocSharedRef('MeshAsset', pod);
      f.handles.push(handle);
      f.meshes.push(f.store.ensureResident(handle, pod, f.world).unwrap());
      patch([add(7, { ...defined(snapshots[0]), assetHandle: Number(handle) })]);
      const full = f.input.scene.plan;
      expect(full.batches).toHaveLength(3);
      // Two native aligned rosters have equal cardinality but different IDs.
      for (const selected of [full.batches.slice(0, 2), full.batches.slice(1)]) {
        f.input.scene.plan = buildBatchAlignedSubmission(
          full,
          new Map(selected.map((batch) => [batch.batchId, batch.candidates])),
        );
        check();
        expect(retained.preparedBatches.size).toBe(2);
      }
    } finally {
      f.close();
    }
  });

  it('keeps row observations and publishes a partially refreshed row after an artifact getter retry', async () => {
    const f = await fixture([0, 1]);
    const retained = f.production as unknown as {
      preparedBatches: Map<number, { value: PreparedBatchRows }>;
      preparedCache: { batchRows: readonly PreparedBatchRows[]; value: PreparedProductionPlan };
    };
    const first = { ...defined(f.input.standardPbrArtifact), fragmentEntry: 'fs-before' };
    const second = { ...first, material: 'fixture::second-material' };
    const batches = f.input.scene.plan.batches;
    const artifacts = new Map([
      [artifactKey(defined(batches[0])), first],
      [artifactKey(defined(batches[1])), second],
    ]);
    const trace: string[] = [];
    const failure = new Error('second-artifact-getter-failed');
    let rejectSecond = false;
    let observing = false;
    const readArtifact = artifacts.get.bind(artifacts);
    const readMesh = f.bySlot.get.bind(f.bySlot);
    vi.spyOn(artifacts, 'get').mockImplementation((key) => {
      if (observing) trace.push(`artifact:${key}`);
      if (rejectSecond && key === artifactKey(defined(batches[1]))) throw failure;
      return readArtifact(key);
    });
    vi.spyOn(f.bySlot, 'get').mockImplementation((slot) => {
      if (observing) trace.push(`mesh:${slot}`);
      return readMesh(slot);
    });
    const prepare = () =>
      f.production.prepare({
        ...f.input,
        materialArtifacts: artifacts,
        profilePhase: (phase, action) => {
          if (phase !== 'record/gpu-driven-prepare/plan') return action();
          observing = true;
          try {
            return action();
          } finally {
            observing = false;
          }
        },
      });
    try {
      const initial = defined(prepare().unwrap());
      initial._commitResourceReplacement();
      const accepted = retained.preparedCache;
      first.fragmentEntry = 'fs-after';
      rejectSecond = true;
      trace.length = 0;
      expect(prepare).toThrow(failure);
      expect(trace.at(-1)).toBe(`artifact:${artifactKey(defined(batches[1]))}`);
      expect(retained.preparedCache).toBe(accepted);
      const refreshed = defined(retained.preparedBatches.get(defined(batches[0]).batchId)).value;
      expect(refreshed).not.toBe(accepted.batchRows[0]);
      rejectSecond = false;
      trace.length = 0;
      const retried = defined(prepare().unwrap());
      retried._commitResourceReplacement();
      expect(trace).toEqual(
        batches.flatMap((batch) => [
          `artifact:${artifactKey(batch)}`,
          ...[...defined(retained.preparedBatches.get(batch.batchId)).value.meshes.keys()].map(
            (slot) => `mesh:${slot}`,
          ),
        ]),
      );
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      expect(retained.preparedCache.batchRows[0]).toBe(refreshed);
      expect(retained.preparedCache.value).not.toBe(accepted.value);
      expect(retried.topologySignature).not.toBe(initial.topologySignature);
      artifacts.delete(artifactKey(defined(batches[1])));
      const missing = prepare();
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('missing-material-receipt');
      expect(retained.preparedBatches.size).toBe(2);
      artifacts.set(artifactKey(defined(batches[1])), second);
      const restored = defined(prepare().unwrap());
      restored._commitResourceReplacement();
      expect(restored.topologySignature).toBe(retried.topologySignature);
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      const full = f.input.scene.plan;
      const firstBatch = defined(batches[0]);
      f.input.scene.plan = buildBatchAlignedSubmission(
        full,
        new Map([[firstBatch.batchId, firstBatch.candidates]]),
      );
      artifacts.delete(artifactKey(firstBatch));
      const rejectedShrink = prepare();
      expect(rejectedShrink.ok).toBe(false);
      if (!rejectedShrink.ok) expect(rejectedShrink.error.code).toBe('missing-material-receipt');
      expect([...retained.preparedBatches.keys()]).toEqual([firstBatch.batchId]);
      f.input.scene.plan = full;
      artifacts.set(artifactKey(firstBatch), first);
      const recovered = defined(prepare().unwrap());
      recovered._commitResourceReplacement();
      expect(retained.preparedBatches.size).toBe(2);
      expect(recovered.topologySignature).toBe(restored.topologySignature);
      expect(f.production.inspect().preparedBatchBuilds).toBe(2);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  });

  it('reuses admitted binding keys while observing in-place consumed class changes', async () => {
    const f = await fixture();
    const bindings = new Map<string, string>();
    const keys = vi.spyOn(materialBindings, 'materialBindingKey');
    const prepare = () => {
      const frame = defined(
        f.production.prepare({ ...f.input, materialBindingClasses: bindings }).unwrap(),
      );
      frame._commitResourceReplacement();
      return frame;
    };
    try {
      const first = prepare();
      keys.mockClear();
      const stable = prepare();
      expect(stable.topologySignature).toBe(first.topologySignature);
      expect(keys).not.toHaveBeenCalled();
      const slot = defined(f.input.scene.slots[0]);
      const key = materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1);
      bindings.set(key, 'forward|probe:3');
      const changed = prepare();
      expect(changed.drawKeys).toEqual(first.drawKeys);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredBatchBuilds: 1,
        filteredPlanBuilds: 1,
      });
      keys.mockClear();
      prepare();
      expect(keys).not.toHaveBeenCalled();
      expect(f.production.inspect().filteredPlanBuilds).toBe(0);
    } finally {
      keys.mockRestore();
      f.close();
    }
  });

  it('retains unrelated prepared batches across uploads with unchanged resident epochs', async () => {
    const f = await fixture();
    try {
      const first = f.prepare();
      expect(f.production.inspect().planRebuildCandidates).toBe(16);
      const epochs = f.meshes.map((entry) => entry.contentEpoch);
      f.unrelatedUpload();
      expect(f.meshes.map((entry) => entry.contentEpoch)).toEqual(epochs);
      const next = f.prepare();
      expect(next.drawKeys).toEqual(first.drawKeys);
      expect(next.ownsAllDrawItems).toBe(first.ownsAllDrawItems);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        planRebuildCandidates: 0,
        filteredPlanBuilds: 0,
      });
    } finally {
      f.close();
    }
  });

  it('invalidates only the changed batch for in-place writes and resident replacement', async () => {
    const f = await fixture();
    try {
      // Acquire private writable buffers before exercising exclusive in-place writes.
      const source = defined(f.pods[0]);
      f.store.updateMesh(
        defined(f.handles[0]),
        source.vertices,
        new Uint16Array(defined(source.indices)),
        f.world,
      );
      f.meshes[0] = defined(f.store.getMeshGpuHandles(defined(f.handles[0]), f.world));
      f.bySlot.set(0, f.meshes[0]);
      f.prepare();
      const handle = defined(f.handles[0]),
        entry = defined(f.meshes[0]),
        pod = defined(f.pods[0]);
      const firstEpoch = entry.contentEpoch;
      const vertices = new Float32Array(pod.vertices);
      vertices[0] = (vertices[0] ?? 0) + 0.25;
      f.store.updateMesh(handle, vertices, new Uint16Array(defined(pod.indices)), f.world);
      expect(f.store.getMeshGpuHandles(handle, f.world)).toBe(entry);
      expect(entry.contentEpoch).toBeGreaterThan(firstEpoch);
      const writtenEpoch = entry.contentEpoch;
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 8,
      });
      const expanded = new Float32Array(vertices.length * 2);
      expanded.set(vertices);
      expanded.set(vertices, vertices.length);
      f.store.updateMesh(handle, expanded, new Uint16Array(defined(pod.indices)), f.world);
      const replacement = defined(f.store.getMeshGpuHandles(handle, f.world));
      expect(replacement).not.toBe(entry);
      expect(replacement.contentEpoch).toBeGreaterThan(writtenEpoch);
      expect(replacement.vertexBuffer).not.toBe(entry.vertexBuffer);
      expect(entry.vertexBuffer.isDestroyed).toBe(true);
      expect(entry.indexBuffer?.isDestroyed).toBe(true);
      f.bySlot.set(0, replacement);
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 8,
      });
    } finally {
      f.close();
    }
  });

  it('removes and restores only the batch whose resident mesh slot changes', async () => {
    const f = await fixture();
    try {
      const first = f.prepare();
      const handle = defined(f.handles[0]);
      const entry = defined(f.store.getMeshGpuHandles(handle, f.world));
      f.bySlot.delete(0);
      const missing = f.prepare();
      expect(defined(missing.drawKeys).size).toBe(defined(first.drawKeys).size / 2);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 8,
      });
      f.unrelatedUpload();
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      expect(f.store.getMeshGpuHandles(handle, f.world)).toBe(entry);
      f.bySlot.set(0, entry);
      expect(f.prepare().drawKeys).toEqual(first.drawKeys);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 8,
      });
    } finally {
      f.close();
    }
  });

  it('clears retired owner entries and re-admits fresh meshes after residency destruction', async () => {
    const f = await fixture();
    try {
      f.prepare();
      const handle = defined(f.handles[0]),
        old = defined(f.meshes[0]);
      f.store.evictMesh(handle, f.world);
      expect(f.store.getMeshGpuHandles(handle, f.world)).toBeUndefined();
      expect(old.vertexBuffer.isDestroyed).toBe(true);
      const reinserted = f.store.ensureResident(handle, defined(f.pods[0]), f.world).unwrap();
      expect(reinserted).not.toBe(old);
      expect(reinserted.contentEpoch).toBeGreaterThan(old.contentEpoch);
      f.bySlot.set(0, reinserted);
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      const beforeConfigure = reinserted.contentEpoch;
      f.configure();
      expect(f.store.getMeshGpuHandles(handle, f.world)).toBe(reinserted);
      expect(reinserted.contentEpoch).toBe(beforeConfigure);
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const previous = [...f.bySlot.values()];
      f.store.destroyAll();
      for (const ownedHandle of f.handles)
        expect(f.store.getMeshGpuHandles(ownedHandle, f.world)).toBeUndefined();
      for (const entry of previous) expect(entry.vertexBuffer.isDestroyed).toBe(true);
      f.bySlot.clear();
      f.configure();
      for (let index = 0; index < f.pods.length; index++) {
        const entry = f.store
          .ensureResident(defined(f.handles[index]), defined(f.pods[index]), f.world)
          .unwrap();
        expect(entry).not.toBe(previous[index]);
        expect(entry.contentEpoch).toBeGreaterThan(defined(previous[index]).contentEpoch);
        f.bySlot.set(index, entry);
      }
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 2,
        planRebuildCandidates: 16,
      });
      f.unrelatedUpload();
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe('GPU preparation pass dependencies before partitioning', () => {
  it('observes custom binding iteration before preparation callbacks on every invocation', async () => {
    const f = await fixture();
    try {
      const trace: string[] = [];
      const bindings = new Map<string, string>();
      const iterator = bindings[Symbol.iterator].bind(bindings);
      const get = bindings.get.bind(bindings);
      Object.defineProperty(bindings, 'get', {
        value: (key: string) => {
          trace.push('get');
          return get(key);
        },
      });
      Object.defineProperty(bindings, Symbol.iterator, {
        configurable: true,
        value: () => {
          trace.push('iterate');
          return iterator();
        },
      });
      const prepare = () => {
        const frame = defined(
          f.production
            .prepare({
              ...f.input,
              materialBindingClasses: bindings,
              profilePhase: (phase, action) => {
                trace.push(phase);
                return action();
              },
            })
            .unwrap(),
        );
        frame._commitResourceReplacement();
        return frame;
      };
      const first = prepare();
      expect(trace).toContain('get');
      trace.length = 0;
      const next = prepare();
      expect(trace[0]).toBe('iterate');
      expect(trace.filter((event) => event === 'iterate')).toHaveLength(1);
      // Legacy warm filtering does not add observations of a caller's get method.
      expect(trace).not.toContain('get');
      expect(next.topologySignature).toBe(first.topologySignature);
      expect(f.production.inspect().filteredPlanBuilds).toBe(0);
      trace.length = 0;
      bindings.set('unconsumed', 'changed');
      const changed = prepare();
      // Raw collection changes retain the original projection callback path,
      // while their unused entries remain outside the compiled graph identity.
      expect(trace).toContain('record/gpu-driven-prepare/filter/main-plan/groups/key');
      expect(trace).toContain('record/gpu-driven-prepare/filter/shadow-plan');
      expect(changed.topologySignature).toBe(first.topologySignature);
      const failure = new Error('first-iterator-error');
      Object.defineProperty(bindings, Symbol.iterator, {
        configurable: true,
        value: () => {
          throw failure;
        },
      });
      trace.length = 0;
      expect(prepare).toThrow(failure);
      expect(trace).toEqual([]);
    } finally {
      f.close();
    }
  });

  it('keeps compiled raster identity independent of live binding-map order and unconsumed entries', async () => {
    const f = await fixture();
    try {
      const bindings = new Map<string, string>(
        f.input.scene.slots.map((slot) => [
          materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
          'forward|probe:2',
        ]),
      );
      const prepare = (materialBindingClasses: ReadonlyMap<string, string>) => {
        const frame = defined(
          f.production.prepare({ ...f.input, materialBindingClasses }).unwrap(),
        );
        frame._commitResourceReplacement();
        return frame;
      };
      const first = prepare(bindings);
      const signature = first.topologySignature;
      const reordered = new Map([...bindings].reverse());
      reordered.set('99:9999:12345', 'unconsumed-class');
      const next = prepare(reordered);
      expect(next.drawKeys).toEqual(first.drawKeys);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredBatchBuilds: 0,
        filteredPlanBuilds: 0,
      });
      // Unconsumed entries and insertion order affect neither filtering nor
      // the compiled graph; actual consumed values remain observed.
      expect(next.topologySignature).toBe(signature);
      const slot = defined(f.input.scene.slots[0]);
      reordered.set(
        materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
        'forward|probe:3',
      );
      const changed = prepare(reordered);
      expect(f.production.inspect().filteredBatchBuilds).toBeGreaterThan(0);
      expect(changed.topologySignature).toBe(signature);
      expect(changed.drawKeys).toEqual(first.drawKeys);
      // Shader/material artifact mutation remains an independent graph fence.
      const main = { ...defined(f.input.standardPbrArtifact), fragmentEntry: 'changed-entry' };
      const changedArtifact = defined(
        f.production
          .prepare({ ...f.input, standardPbrArtifact: main, materialBindingClasses: reordered })
          .unwrap(),
      );
      expect(changedArtifact.topologySignature).not.toBe(signature);
      changedArtifact._commitResourceReplacement();
      const handle = defined(f.handles[0]);
      f.store.evictMesh(handle, f.world);
      const replacement = f.store.ensureResident(handle, defined(f.pods[0]), f.world).unwrap();
      f.bySlot.set(0, replacement);
      const changedResource = prepare(reordered);
      expect(changedResource.topologySignature).not.toBe(signature);
      const failure = new Error('binding-iterator-failure');
      const throwing = new Map<string, string>();
      Object.defineProperty(throwing, Symbol.iterator, {
        value: () => {
          throw failure;
        },
      });
      let caught: unknown;
      try {
        prepare(throwing);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    } finally {
      f.close();
    }
  });

  it('observes mutable shadow programs and fails closed on removal without replacing the main graph', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.standardPbrArtifact);
      const shadow = { ...main, pass: 'shadow', program: createMaterialShaderProgram('shadow-a') };
      const key = artifactKey(defined(f.input.scene.plan.batches[0]));
      const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>([[key, shadow]]);
      const identity = { kind: 'directional', index: 0, layer: 'static' } as const;
      const views = [{ identity, planes: new Float32Array(24), candidatePrimitiveIndices: [0, 1] }];
      const prepare = () =>
        defined(f.production.prepare({ ...f.input, shadowMaterialArtifacts }).unwrap());
      const first = prepare();
      first.updateShadowViews?.(views).unwrap();
      const signature = first.topologySignature;
      const original = [...defined(first.shadowBatchProjections).values()][0];
      first._commitResourceReplacement();
      const stable = prepare();
      stable.updateShadowViews?.(views).unwrap();
      expect(stable.shadowViewPool?.cacheState(identity)).toBe('hit');
      stable._commitResourceReplacement();
      shadow.program = createMaterialShaderProgram('shadow-b');
      const next = prepare();
      next.updateShadowViews?.(views).unwrap();
      expect(next.shadowViewPool?.invalidationReason(identity)).toBe('artifact-changed');
      expect(next.topologySignature).toBe(signature);
      for (const [batch, projection] of defined(
        [...defined(next.shadowBatchProjections).values()][0],
      )) {
        expect(projection).not.toBe(original?.get(batch));
        expect(projection.shadowArtifact.program).toBe(shadow.program);
      }
      expect(next.drawKeys).toEqual(first.drawKeys);
      expect(next.ownsAllDrawItems).toBe(first.ownsAllDrawItems);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
      });
      next._commitResourceReplacement();
      shadowMaterialArtifacts.delete(key);
      const removed = prepare();
      const rejected = defined(removed.updateShadowViews?.(views));
      expect(rejected.ok).toBe(false);
      expect(removed.shadowViewPool?.cacheState(identity)).toBe('invalidated');
      removed._abortResourceReplacement?.();
      shadowMaterialArtifacts.set(key, shadow);
      const retry = prepare();
      retry.updateShadowViews?.(views).unwrap();
      expect(retry.shadowViewPool?.cacheState(identity)).toBe('invalidated');
      expect(retry.topologySignature).toBe(signature);
      retry._commitResourceReplacement();
    } finally {
      f.close();
    }
  });

  it('still observes mutable main entry metadata and effective binding classes', async () => {
    const f = await fixture();
    try {
      const main = { ...defined(f.input.standardPbrArtifact), fragmentEntry: 'fs-a' };
      const materialBindingClasses = new Map<string, string>();
      const prepare = () => {
        const frame = defined(
          f.production
            .prepare({ ...f.input, standardPbrArtifact: main, materialBindingClasses })
            .unwrap(),
        );
        frame._commitResourceReplacement();
        return frame;
      };
      const first = prepare();
      prepare();
      expect(f.production.inspect().filteredPlanBuilds).toBe(0);
      main.fragmentEntry = 'fs-b';
      const changed = prepare();
      expect(changed.drawKeys).toEqual(first.drawKeys);
      expect(changed.topologySignature).not.toBe(first.topologySignature);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 2,
        filteredPlanBuilds: 1,
      });
      const slot = defined(f.input.scene.slots[0]);
      materialBindingClasses.set(
        materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
        'forward|probe:2',
      );
      prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 1,
      });
    } finally {
      f.close();
    }
  });
});

function artifactKey(batch: GpuDrivenBatch): string {
  const prepared = defined(batch.prepared);
  return gpuDrivenMaterialArtifactKey({
    material: prepared.identity.material,
    deformation: prepared.identity.deformation,
    receiptIdentity: prepared.receiptIdentity,
    receiptGeneration: prepared.receiptGeneration,
  });
}

function projectFacts(frame: PreparedGpuDrivenFrame) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const imports: { name: string; buffer: Buffer; size: number; usage: number }[] = [];
  const original = graph.importBuffer.bind(graph);
  vi.spyOn(graph, 'importBuffer').mockImplementation((name, descriptor, get) => {
    imports.push({
      name,
      buffer: get({} as RenderPipelineFrame),
      size: descriptor.size,
      usage: descriptor.usage,
    });
    return original(name, descriptor, get);
  });
  return { imports, accesses: frame.project(graph, 'rgba8unorm', 1).unwrap().accesses };
}

function sameProjection(
  left: ReturnType<typeof projectFacts>,
  right: ReturnType<typeof projectFacts>,
) {
  expect(right.accesses).toEqual(left.accesses);
  expect(right.imports).toHaveLength(left.imports.length);
  for (const [index, before] of left.imports.entries()) {
    const after = defined(right.imports[index]);
    expect(after.buffer).toBe(before.buffer);
    expect({ ...after, buffer: undefined }).toEqual({ ...before, buffer: undefined });
  }
}

describe('selected GPU material graph dependencies', () => {
  it('retains the graph and shadow filtering when unconsumed publication entries change', async () => {
    const f = await fixture();
    try {
      const artifact = defined(f.input.standardPbrArtifact);
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), artifact]),
      );
      const shadowMaterialArtifacts = new Map(materialArtifacts);
      const prepare = () => {
        const frame = defined(
          f.production.prepare({ ...f.input, materialArtifacts, shadowMaterialArtifacts }).unwrap(),
        );
        frame._commitResourceReplacement();
        return frame;
      };
      const first = prepare(),
        signature = first.topologySignature,
        facts = projectFacts(first);
      const unused = {
        ...artifact,
        material: 'fixture::unused',
        vertexEntry: 'unused-vs',
        fragmentEntry: 'unused-fs',
      };
      materialArtifacts.set('unused', unused);
      shadowMaterialArtifacts.set('unused', unused);
      const second = prepare();
      expect(second.topologySignature).toBe(signature);
      sameProjection(facts, projectFacts(second));
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
        filteredBatchBuilds: 0,
      });
      materialArtifacts.delete('unused');
      shadowMaterialArtifacts.delete('unused');
      expect(prepare().topologySignature).toBe(signature);
    } finally {
      f.close();
    }
  });

  it('keeps graph identity when retiring the first receiver changes only the collector fallback', async () => {
    const f = await fixture([0, 1, 0]);
    try {
      const main = defined(f.input.standardPbrArtifact);
      const second = {
        ...main,
        material: 'fixture::second-material',
        program: createMaterialShaderProgram('second-program'),
      };
      const materialPipelineFactory: NonNullable<
        Parameters<GpuDrivenProduction['prepare']>[0]['materialPipelineFactory']
      > = (
        material,
        _hdr,
        _state,
        _topology,
        _index,
        _variant,
        _pass,
        _attributes,
        _samples,
        _format,
        _uv,
        _depth,
        _layout,
        _projection,
        _mode,
        _kind,
        sceneEntry,
        _formats,
        vertexEntry,
        fragmentEntry,
      ) => ({
        group2Contract: 'mesh',
        pipeline: f.device
          .createRenderPipeline({
            label: material,
            layout: defined(f.input.standardPbrPipelineState?.gpuDrivenPbrPipelineLayout),
            vertex: {
              module: f.shader,
              entryPoint: vertexEntry ?? sceneEntry ?? 'vs_scene',
              buffers: [],
            },
            fragment: {
              module: f.shader,
              entryPoint: fragmentEntry ?? 'fs_main',
              targets: [{ format: 'rgba8unorm' }],
            },
          })
          .unwrap(),
      });
      const prepare = () => {
        const selected = collectGpuDrivenMaterialArtifacts({
          rows: f.projection
            .slotsSnapshot()
            .map((slot, renderableIndex) => ({ source: slot.snapshot, renderableIndex })),
          dispatch: [],
          resolve: (material) => (material === main.material ? main : second),
          clustered: false,
          reflectionFallback: false,
          shadowViews: false,
        });
        expect(selected.materialArtifacts.size).toBe(2);
        const frame = defined(
          f.production
            .prepare({
              ...f.input,
              materialPipelineFactory,
              materialArtifacts: selected.materialArtifacts,
              materialArtifact: defined(selected.firstArtifact),
            })
            .unwrap(),
        );
        frame._commitResourceReplacement();
        return { frame, selected };
      };
      const first = prepare(),
        signature = first.frame.topologySignature,
        facts = projectFacts(first.frame);
      const roster = f.input.scene.plan.batches.map((batch) => ({
        id: batch.batchId,
        generation: batch.generation,
        key: batch.key,
      }));
      const before = f.production.inspect();
      const delta = f.projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      f.input.scene.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.input.scene.plan = f.topology.plan();
      f.input.scene.slots = f.projection.slotsSnapshot();
      const next = prepare();
      expect(next.selected.firstArtifact?.material).toBe(second.material);
      expect(first.selected.firstArtifact?.material).toBe(main.material);
      expect([...next.selected.materialArtifacts.keys()].sort()).toEqual(
        [...first.selected.materialArtifacts.keys()].sort(),
      );
      expect(f.input.scene.plan.candidateCount).toBe(16);
      expect(
        f.input.scene.plan.batches.map((batch) => ({
          id: batch.batchId,
          generation: batch.generation,
          key: batch.key,
        })),
      ).toEqual(roster);
      expect(next.frame.topologySignature).toBe(signature);
      sameProjection(facts, projectFacts(next.frame));
      expect(f.production.inspect()).toMatchObject({
        candidateCapacity: before.candidateCapacity,
        batchCapacity: before.batchCapacity,
        indirectCapacity: before.indirectCapacity,
      });
    } finally {
      f.close();
    }
  });

  it('ignores an unconsumed Surface publication with a required dynamic page', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.standardPbrArtifact);
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), main]),
      );
      const prepare = () =>
        defined(f.production.prepare({ ...f.input, materialArtifacts }).unwrap());
      const first = prepare(),
        signature = first.topologySignature,
        facts = projectFacts(first);
      first._commitResourceReplacement();
      const layout = deriveMaterialDynamicInputLayout({
        name: 'unusedEvents',
        fields: [{ name: 'strength', type: 'f32' }],
        maxRecords: 4,
        maxDomains: 1,
        maxPageBytes: 256,
        maxBindings: 1,
        maxEventsPerSample: 1,
      }).unwrap();
      materialArtifacts.set('unused-surface', {
        ...main,
        material: 'fixture::unused-surface',
        receipt: {
          ...defined(main.receipt),
          surface: {
            model: 'single-layer-medium',
            module: 'forgeax::single-layer-medium',
            inputAbi: 'SingleLayerMediumSurfaceInput',
            outputAbi: 'SingleLayerMediumSurfaceData',
            passes: ['nearest-layer', 'color'],
            dynamicInput: {
              layout,
              group: 3,
              binding: 3,
              readOnly: true,
              accessor: `read_${layout.name}`,
            },
          },
        },
      });
      const next = prepare();
      expect(next.surfaceSubmission).toBeUndefined();
      expect(f.production.inspect().surfaceArtifact).toBeUndefined();
      expect(next.topologySignature).toBe(signature);
      sameProjection(facts, projectFacts(next));
    } finally {
      f.close();
    }
  });

  it('builds the skin adapter from its selected receipt instead of an unused fallback', async () => {
    const f = await fixture();
    const allocator = createSkinPaletteAllocator(f.device, 1 << 20);
    try {
      const main = defined(f.input.standardPbrArtifact);
      const receipt = createStandardPbrArtifactReceipt(true);
      const skinArtifact = { ...main, receipt };
      const source = defined(f.input.scene.slots[1]).snapshot;
      const skin = allocator.allocatePersistentSlice({
        identity: 'fixture-skin',
        generation: 1,
        jointCount: 1,
        bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
      });
      const snapshot: RenderableSnapshot = {
        ...source,
        skin,
        gpuDrivenDraws: defined(source.gpuDrivenDraws).map((draw) => ({
          ...draw,
          prepared: {
            ...defined(draw.prepared),
            identity: { ...defined(draw.prepared).identity, deformation: 'skin' },
            vertexInputs: receipt.vertexInputs,
            skinPaletteAddress: receipt.skinPaletteAddress,
          },
        })),
      };
      const delta = f.projection.apply([
        { kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot },
      ]);
      f.input.scene.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.input.scene.plan = f.topology.plan();
      f.input.scene.slots = f.projection.slotsSnapshot();
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [
          artifactKey(batch),
          batch.prepared?.identity.deformation === 'skin' ? skinArtifact : main,
        ]),
      );
      const state = defined(f.input.standardPbrPipelineState);
      const skinLayout = f.device
        .createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
          ],
        })
        .unwrap();
      const standardPbrPipelineState = {
        ...state,
        skinPaletteAllocator: allocator,
        gpuDrivenPbrSkinPipelineLayout: defined(state.gpuDrivenPbrPipelineLayout),
        pbrSkinMeshBindGroupLayout: skinLayout,
      };
      const prepare = (materialSkinArtifact: MaterialShaderArtifact) =>
        defined(
          f.production
            .prepare({
              ...f.input,
              materialArtifacts,
              standardPbrPipelineState,
              materialSkinArtifact,
            })
            .unwrap(),
        );
      const first = prepare({ ...skinArtifact, layoutIdentity: 'unused-invalid-layout' });
      expect(f.production.inspect().resourceAllocationOwners?.skinRaster).toBeDefined();
      const signature = first.topologySignature,
        facts = projectFacts(first);
      first._commitResourceReplacement();
      const next = prepare({ ...skinArtifact, fragmentEntry: 'unused-skin-entry' });
      expect(next.topologySignature).toBe(signature);
      sameProjection(facts, projectFacts(next));
    } finally {
      f.close();
      allocator.dispose();
    }
  });

  it('observes selected shadow programs across unsubmitted replacement, reversal and abort', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.standardPbrArtifact);
      const a = { ...main, pass: 'shadow', program: createMaterialShaderProgram('shadow-a') };
      const b = {
        ...a,
        program: createMaterialShaderProgram('shadow-b'),
        vertexEntry: 'vs-shadow-b',
        fragmentEntry: 'fs-shadow-b',
      };
      const shadowMaterialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), a]),
      );
      const prepare = (artifact: MaterialShaderArtifact) => {
        for (const key of shadowMaterialArtifacts.keys())
          shadowMaterialArtifacts.set(key, artifact);
        const frame = defined(
          f.production.prepare({ ...f.input, shadowMaterialArtifacts }).unwrap(),
        );
        frame
          .updateShadowViews?.([
            {
              identity: { kind: 'directional', index: 0 },
              planes: new Float32Array(24),
              matrix: mat4.identity(mat4.create()),
              candidatePrimitiveIndices: [0, 1],
            },
          ])
          .unwrap();
        const projections = [...defined(frame.shadowBatchProjections).values()].flatMap(
          (byBatch) => [...byBatch.values()],
        );
        expect(projections.length).toBeGreaterThan(0);
        expect(projections.every((projection) => projection.shadowArtifact === artifact)).toBe(
          true,
        );
        return frame;
      };
      const first = prepare(a),
        firstSignature = first.topologySignature;
      first._commitResourceReplacement();
      const second = prepare(b);
      expect(second.topologySignature).toBe(firstSignature);
      expect(second.shadowViewPool?.cacheState({ kind: 'directional', index: 0 })).toBe(
        'invalidated',
      );
      expect(f.production.inspect().filteredBatchBuilds).toBe(0);
      const restored = prepare(a);
      expect(restored.topologySignature).toBe(second.topologySignature);
      expect(restored.shadowViewPool?.cacheState({ kind: 'directional', index: 0 })).toBe(
        'invalidated',
      );
      restored._abortResourceReplacement?.();
      const retry = prepare(b);
      expect(retry.topologySignature).toBe(restored.topologySignature);
      expect(retry.shadowViewPool?.cacheState({ kind: 'directional', index: 0 })).toBe(
        'invalidated',
      );
      retry._commitResourceReplacement();
      const stable = prepare(b);
      expect(stable.topologySignature).toBe(retry.topologySignature);
      expect(stable.shadowViewPool?.cacheState({ kind: 'directional', index: 0 })).toBe('hit');
    } finally {
      f.close();
    }
  });

  it.each([
    'vertexEntry',
    'fragmentEntry',
  ] as const)('reprojects the selected %s and records its new pipeline entry', async (entry) => {
    const f = await fixture();
    try {
      const artifact = {
        ...defined(f.input.standardPbrArtifact),
        vertexEntry: 'vs-before',
        fragmentEntry: 'fs-before',
      };
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), artifact]),
      );
      const prepare = () =>
        defined(f.production.prepare({ ...f.input, materialArtifacts }).unwrap());
      const first = prepare(),
        signature = first.topologySignature;
      projectFacts(first);
      first._commitResourceReplacement();
      artifact[entry] = entry === 'vertexEntry' ? 'vs-after' : 'fs-after';
      const next = prepare();
      expect(next.topologySignature).not.toBe(signature);
      const pipelines = vi.spyOn(f.device, 'createRenderPipeline');
      projectFacts(next);
      expect(
        pipelines.mock.calls.some(([descriptor]) =>
          entry === 'vertexEntry'
            ? descriptor.vertex.entryPoint === 'vs-after'
            : descriptor.fragment?.entryPoint === 'fs-after',
        ),
      ).toBe(true);
      next._commitResourceReplacement();
      expect(prepare().topologySignature).toBe(next.topologySignature);
    } finally {
      f.close();
    }
  });
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected fixture value');
  return value;
}
