import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
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
import {
  BatchTopology,
  buildBatchAlignedSubmission,
  type GpuDrivenBatch,
} from '../gpu-driven/batch-topology';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type {
  PreparedBatchRows,
  PreparedProductionPlan,
} from '../gpu-driven/production-raster-prepare';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinSceneInputs } from '../scene/skin-scene-inputs';
import {
  admitGpuFixture,
  snapshot as gpuSnapshot,
  preparedPbrSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';
import { duplicateMeshVertices, editResidentMesh } from './managed-mesh-edit';

async function fixture(materialIndices?: readonly number[]) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  const configure = () => store.configureGpuDevice(device, undefined, device.caps);
  configure();
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const pods = [1, 2].map((size) => createBoxGeometry(size, size, size).unwrap());
  const handles = pods.map((pod) => assets.create(pod).unwrap());
  const meshes = pods.map((pod, index) =>
    store.ensureResident(defined(handles[index]), pod, worldRenderResources(world)).unwrap(),
  );
  const projection = new RenderScene();
  const sharedMaterials = new Map<number, MaterialResource>();
  const snapshots = (materialIndices ?? [0, 1]).map((meshIndex, index): RenderableSnapshot => {
    const handle = defined(handles[meshIndex]);
    const material = new MaterialResource({
      passes: [],
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      materialHandle: ((materialIndices === undefined ? index : meshIndex) + 100) as never,
    });
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
          ...defined(gpuSnapshot(index + 1, Number(handle)).gpuDrivenDraws?.[0]),
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
    base.material.adopt({
      ...base.material.snapshot,
      passes: [
        ...base.material.snapshot.passes,
        {
          name: 'shadow',
          program: { module: defined(base.material.snapshot.materialShaderId) },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
      materialProgramKeys: {
        ...base.material.snapshot.materialProgramKeys,
        shadow: defined(base.material.snapshot.materialShaderId),
      },
    });
    if (materialIndices === undefined) return base;
    const materialShaderId =
      meshIndex === 0 ? base.material.snapshot.materialShaderId : 'fixture::second-material';
    let selectedMaterial = sharedMaterials.get(meshIndex);
    if (selectedMaterial === undefined) {
      selectedMaterial = new MaterialResource({
        ...base.material.snapshot,
        materialShaderId,
        materialProgramKeys: {
          forward: defined(materialShaderId),
          shadow: defined(materialShaderId),
        },
      });
      sharedMaterials.set(meshIndex, selectedMaterial);
    }
    return {
      ...base,
      material: selectedMaterial,
      materials: [selectedMaterial],
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
  expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(2);
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
      plan: topology.query(topology.sourcePlan(), undefined),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: bySlot,
    viewBindGroupLayout: viewLayout,
  };
  const prepare = () => {
    const frame = production.prepare(admitGpuFixture(input)).unwrap();
    if (frame === undefined) throw new Error('Expected admitted prepared frame');
    frame._commitResourceReplacement();
    return frame;
  };
  const unrelatedUpload = () => {
    const pod = createBoxGeometry(3, 3, 3).unwrap(),
      handle = assets.create(pod).unwrap();
    return store.ensureResident(handle, pod, worldRenderResources(world)).unwrap();
  };
  return {
    device,
    store,
    assets,
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
      assets.dispose();
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
              prepareMaterialBinding: (
                (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                (slot: number) => {
                  const group = groups[slot];
                  return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                }
              )([materialGroup]),
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
      f.store.evictMesh(defined(f.handles[0]), worldRenderResources(f.world));
      const pod = defined(f.pods[0]);
      const changedVertices = new Float32Array(pod.vertices);
      changedVertices[0] = (changedVertices[0] ?? 0) + 0.125;
      const replacement = f.store
        .ensureResident(
          defined(f.handles[0]),
          { ...pod, vertices: changedVertices },
          worldRenderResources(f.world),
        )
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
        ...defined(f.input.materialArtifact),
        fragmentEntry: 'changed-entry',
      };
      const changedProgram = defined(
        f.production
          .prepare(
            admitGpuFixture({
              ...f.input,

              materialArtifact: changedArtifact,
            }),
          )
          .unwrap(),
      );
      // A program change is a new stock class: the compiled graph projects it
      // from the live frame instead of recompiling.
      expect(changedProgram._recordingTopologySignature).toBe(recordingSignature);
      const late = f.production.lateRasterClasses.projected;
      current = changedProgram;
      encode();
      expect(f.production.lateRasterClasses.projected).toBe(late + 1);
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
    const retained = (
      f.production as unknown as {
        preparations: {
          forward: {
            batches: Map<number, { value: PreparedBatchRows }>;
            cached: { batchRows: readonly PreparedBatchRows[]; value: PreparedProductionPlan };
          };
        };
      }
    ).preparations.forward;
    try {
      const first = f.prepare();
      const rows = retained.cached.batchRows;
      const plan = retained.cached.value;
      const keys = vi.spyOn(retained.batches, 'keys');
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
            .prepare(
              admitGpuFixture({
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
              }),
            )
            .unwrap(),
        );
        frame._commitResourceReplacement();
        expect(frame.topologySignature).toBe(first.topologySignature);
        expect(retained.cached.batchRows).toBe(rows);
        expect(retained.cached.value).toBe(plan);
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
    const retained = (
      f.production as unknown as {
        preparations: {
          forward: {
            batches: Map<number, { value: PreparedBatchRows }>;
            cached: { batchRows: readonly PreparedBatchRows[] };
          };
        };
      }
    ).preparations.forward;
    const snapshots = f.input.scene.slots.map((slot) => slot.snapshot);
    const patch = (changes: Parameters<RenderScene['apply']>[0]) => {
      const delta = f.projection.apply(changes);
      f.input.scene.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.input.scene.plan = f.topology.query(f.topology.sourcePlan(), undefined);
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
      const frame = f.production.prepare(admitGpuFixture(f.input)).unwrap();
      frame?._commitResourceReplacement();
      const ids = f.input.scene.plan.batches.map((batch) => batch.batchId);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...retained.batches.keys()].sort()).toEqual([...ids].sort());
      expect(retained.cached.batchRows.map((row) => row.source.batchId)).toEqual(ids);
      return frame;
    };
    try {
      check();
      const original = retained.cached.batchRows;
      const native = f.input.scene.plan;
      f.input.scene.plan = { ...native, batches: Object.freeze([...native.batches].reverse()) };
      check();
      expect(retained.cached.batchRows).toEqual([...original].reverse());
      expect(original.map((row) => row.source.batchId)).toEqual(
        native.batches.map((batch) => batch.batchId),
      );
      patch([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      check();
      expect(retained.batches.size).toBe(1);
      const add = (entityKey: number, source = defined(snapshots[0])) => ({
        kind: 'update' as const,
        worldId: 0,
        entityKey,
        snapshot: { ...source, entityKey },
      });
      patch([add(3)]);
      check();
      expect(retained.batches.size).toBe(2);
      const replaced = f.input.scene.plan.batches;
      patch([{ kind: 'remove', worldId: 0, entityKey: 3 }, add(4)]);
      check();
      expect(retained.batches.size).toBe(2);
      expect(f.input.scene.plan.batches).not.toEqual(replaced);
      patch([
        { kind: 'remove', worldId: 0, entityKey: 2 },
        { kind: 'remove', worldId: 0, entityKey: 4 },
      ]);
      expect(check()).toBeUndefined();
      expect(retained.batches.size).toBe(0);
      patch([add(5), add(6, defined(snapshots[1]))]);
      check();
      expect(retained.batches.size).toBe(2);
      const pod = defined(f.pods[0]);
      const handle = f.assets.create(pod).unwrap();
      f.handles.push(handle);
      f.meshes.push(f.store.ensureResident(handle, pod, worldRenderResources(f.world)).unwrap());
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
        expect(retained.batches.size).toBe(2);
      }
    } finally {
      f.close();
    }
  });

  it('retains unrelated prepared batches across uploads with unchanged resident epochs', async () => {
    const f = await fixture();
    try {
      const first = f.prepare();
      expect(f.production.inspect().planRebuildCandidates).toBe(0);
      const epochs = f.meshes.map((entry) => entry.contentEpoch);
      f.unrelatedUpload();
      expect(f.meshes.map((entry) => entry.contentEpoch)).toEqual(epochs);
      const next = f.prepare();
      expect(next.selection.has(defined(f.input.scene.slots.at(0)).snapshot, 0)).toBe(true);
      expect(first.selection.has(defined(f.input.scene.slots.at(0)).snapshot, 0)).toBe(true);
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
      f.prepare();
      const handle = defined(f.handles[0]),
        entry = defined(f.meshes[0]),
        pod = defined(f.pods[0]);
      const firstEpoch = entry.contentEpoch;
      const position = pod.attributes.position;
      if (!(position instanceof Float32Array)) throw new Error('Expected box position attribute');
      const movedPosition = new Float32Array(position);
      for (let index = 0; index < movedPosition.length; index += 3)
        movedPosition[index] = (movedPosition[index] ?? 0) + 0.25;
      editResidentMesh(
        f.assets,
        f.store,
        handle,
        () => {
          f.assets
            .writeRange(handle, { attribute: 'position', first: 0, values: movedPosition })
            .unwrap();
        },
        worldRenderResources(f.world),
      );
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBe(entry);
      expect(entry.contentEpoch).toBeGreaterThan(firstEpoch);
      const writtenEpoch = entry.contentEpoch;
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 0,
      });
      const accepted = runtimeAssets(f.assets)
        .borrow<import('@forgeax/engine-types').MeshAsset>(handle)
        .unwrap();
      editResidentMesh(
        f.assets,
        f.store,
        handle,
        () => {
          f.assets.replace(handle, duplicateMeshVertices(accepted)).unwrap();
        },
        worldRenderResources(f.world),
      );
      const replacement = defined(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world)));
      expect(replacement).not.toBe(entry);
      expect(replacement.contentEpoch).toBeGreaterThan(writtenEpoch);
      expect(replacement.vertexBuffer).not.toBe(entry.vertexBuffer);
      expect(entry.vertexBuffer.isDestroyed).toBe(true);
      expect(replacement.indexBuffer).toBe(entry.indexBuffer);
      expect(entry.indexBuffer?.isDestroyed).toBe(false);
      f.bySlot.set(0, replacement);
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 0,
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
      const entry = defined(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world)));
      f.bySlot.delete(0);
      const missing = f.prepare();
      const sources = f.input.scene.slots.map((slot) => slot.snapshot);
      expect(first.selection.has(defined(sources[0]), 0)).toBe(true);
      expect(missing.selection.has(defined(sources[0]), 0)).toBe(false);
      expect(missing.selection.has(defined(sources[1]), 0)).toBe(true);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 0,
      });
      f.unrelatedUpload();
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBe(entry);
      f.bySlot.set(0, entry);
      expect(f.prepare().selection.has(defined(sources[0]), 0)).toBe(true);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 1,
        planRebuildCandidates: 0,
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
      f.store.evictMesh(handle, worldRenderResources(f.world));
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBeUndefined();
      expect(old.vertexBuffer.isDestroyed).toBe(true);
      const reinserted = f.store
        .ensureResident(handle, defined(f.pods[0]), worldRenderResources(f.world))
        .unwrap();
      expect(reinserted).not.toBe(old);
      expect(reinserted.contentEpoch).toBeGreaterThan(old.contentEpoch);
      f.bySlot.set(0, reinserted);
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      const beforeConfigure = reinserted.contentEpoch;
      f.configure();
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBe(reinserted);
      expect(reinserted.contentEpoch).toBe(beforeConfigure);
      f.prepare();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const previous = [...f.bySlot.values()];
      f.store.destroyAll();
      for (const ownedHandle of f.handles)
        expect(
          f.store.getMeshGpuHandles(ownedHandle, worldRenderResources(f.world)),
        ).toBeUndefined();
      for (const entry of previous) expect(entry.vertexBuffer.isDestroyed).toBe(true);
      f.bySlot.clear();
      f.configure();
      for (let index = 0; index < f.pods.length; index++) {
        const entry = f.store
          .ensureResident(
            defined(f.handles[index]),
            defined(f.pods[index]),
            worldRenderResources(f.world),
          )
          .unwrap();
        expect(entry).not.toBe(previous[index]);
        expect(entry.contentEpoch).toBeGreaterThan(defined(previous[index]).contentEpoch);
        f.bySlot.set(index, entry);
      }
      f.prepare();
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 2,
        planRebuildCandidates: 0,
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
  it('observes mutable shadow programs and fails closed on removal without replacing the main graph', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.materialArtifact);
      const shadow = { ...main, pass: 'shadow', program: createMaterialShaderProgram('shadow-a') };
      const key = artifactKey(defined(f.input.scene.plan.batches.at(0)));
      const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>([[key, shadow]]);
      const identity = { kind: 'directional', index: 0, layer: 'static' } as const;
      const views = [{ identity, planes: new Float32Array(24), candidatePrimitiveIndices: [0, 1] }];
      const prepare = () =>
        defined(
          f.production
            .prepare(admitGpuFixture({ ...f.input, shadowMaterialArtifacts, shadowViews: true }))
            .unwrap(),
        );
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
      expect(next.selection.has(defined(f.input.scene.slots.at(0)).snapshot, 0)).toBe(true);
      expect(first.selection.has(defined(f.input.scene.slots.at(0)).snapshot, 0)).toBe(true);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 2,
        filteredPlanBuilds: 0,
      });
      next._commitResourceReplacement();
      shadowMaterialArtifacts.delete(key);
      expect(prepare).toThrowError(expect.objectContaining({ code: 'missing-material-receipt' }));
      shadowMaterialArtifacts.set(key, shadow);
      const retry = prepare();
      retry.updateShadowViews?.(views).unwrap();
      expect(retry.shadowViewPool?.cacheState(identity)).toBe('hit');
      expect(retry.topologySignature).toBe(signature);
      retry._commitResourceReplacement();
    } finally {
      f.close();
    }
  });

  it('projects a directional view once when its light disables the static shadow cache', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.materialArtifact);
      const shadow = { ...main, pass: 'shadow', program: createMaterialShaderProgram('shadow-a') };
      const key = artifactKey(defined(f.input.scene.plan.batches.at(0)));
      const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>([[key, shadow]]);
      const final = { kind: 'directional', index: 0 } as const;
      const staticLayer = { ...final, layer: 'static' } as const;
      const view = (staticShadowCache: boolean) => [
        {
          identity: final,
          planes: new Float32Array(24),
          candidatePrimitiveIndices: [0, 1],
          ...(staticShadowCache ? {} : { staticLayer: false as const }),
        },
      ];
      const candidates = (
        frame: PreparedGpuDrivenFrame,
        identity: typeof final | typeof staticLayer,
      ) =>
        (frame.shadowViewPool?.submission(identity)?.plan.batches ?? []).reduce(
          (sum, batch) => sum + batch.candidates.length,
          0,
        );
      const update = (staticShadowCache: boolean) => {
        const frame = defined(
          f.production
            .prepare(admitGpuFixture({ ...f.input, shadowMaterialArtifacts, shadowViews: true }))
            .unwrap(),
        );
        frame.updateShadowViews?.(view(staticShadowCache)).unwrap();
        return frame;
      };

      // Default: initial casters are settled, so they live in the static layer.
      const cached = update(true);
      expect(cached.shadowViewPool?.isActive(staticLayer)).toBe(true);
      const settled = candidates(cached, staticLayer);
      expect(settled).toBeGreaterThan(0);
      expect(candidates(cached, final)).toBe(0);
      cached._commitResourceReplacement();
      const cachedHit = update(true);
      expect(cachedHit.shadowViewPool?.cacheState(final)).toBe('hit');
      expect(cachedHit.shadowViewPool?.cacheState(staticLayer)).toBe('hit');
      cachedHit._commitResourceReplacement();

      // Disabled: one view draws every caster and no static view stays active.
      const single = update(false);
      expect(single.shadowViewPool?.isActive(staticLayer)).toBe(false);
      expect(single.shadowViewPool?.submission(staticLayer)).toBeUndefined();
      expect(candidates(single, final)).toBe(settled);
      expect(single.shadowViewPool?.invalidationReason(final)).toBe('configuration-changed');
      expect(
        single.shadowViewPool?.inspect().filter((entry) => entry.identity.layer === 'static'),
      ).toEqual([]);
      single._commitResourceReplacement();
      const singleHit = update(false);
      expect(singleHit.shadowViewPool?.cacheState(final)).toBe('hit');
      singleHit._commitResourceReplacement();

      // Re-enabled: a static view retired by the submitted single-layer frame
      // starts fresh; one still retained is invalidated, never reused stale.
      const restored = update(true);
      expect(restored.shadowViewPool?.isActive(staticLayer)).toBe(true);
      expect(['configuration-changed', 'first-publication']).toContain(
        restored.shadowViewPool?.invalidationReason(staticLayer),
      );
      expect(restored.shadowViewPool?.cacheState(final)).toBe('invalidated');
      expect(candidates(restored, staticLayer)).toBe(settled);
      expect(candidates(restored, final)).toBe(0);
      restored._commitResourceReplacement();
      const restoredHit = update(true);
      expect(restoredHit.shadowViewPool?.cacheState(staticLayer)).toBe('hit');
      restoredHit._commitResourceReplacement();

      // A toggle whose frame never submits keeps the retired static record;
      // switching back must not adopt it as a hit.
      const off = update(false);
      off._abortResourceReplacement?.();
      const on = update(true);
      expect(on.shadowViewPool?.invalidationReason(staticLayer)).toBe('configuration-changed');
      expect(on.shadowViewPool?.cacheState(final)).toBe('invalidated');
      on._commitResourceReplacement();
    } finally {
      f.close();
    }
  });

  it('observes selected program entry changes without rebuilding unchanged geometry', async () => {
    const f = await fixture();
    try {
      const main = { ...defined(f.input.materialArtifact), fragmentEntry: 'fs-a' };
      const prepare = () => {
        const frame = defined(
          f.production.prepare(admitGpuFixture({ ...f.input, materialArtifact: main })).unwrap(),
        );
        frame._commitResourceReplacement();
        return frame;
      };
      const first = prepare();
      prepare();
      expect(f.production.inspect().filteredPlanBuilds).toBe(0);
      main.fragmentEntry = 'fs-b';
      const changed = prepare();
      expect(changed.selection.has(defined(f.input.scene.slots.at(0)).snapshot, 0)).toBe(true);
      expect(changed.topologySignature).not.toBe(first.topologySignature);
      expect(f.production.inspect()).toMatchObject({
        preparedBatchBuilds: 2,
        filteredPlanBuilds: 1,
      });
    } finally {
      f.close();
    }
  });
});

function artifactKey(batch: GpuDrivenBatch): string {
  return defined(batch.binding?.material.snapshot.materialShaderId);
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
      const artifact = defined(f.input.materialArtifact);
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), artifact]),
      );
      const shadowMaterialArtifacts = new Map(materialArtifacts);
      const prepare = () => {
        const frame = defined(
          f.production
            .prepare(admitGpuFixture({ ...f.input, materialArtifacts, shadowMaterialArtifacts }))
            .unwrap(),
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

  it('retains shared executions and graph when one repeated material consumer retires', async () => {
    const f = await fixture([0, 1, 0]);
    try {
      const main = defined(f.input.materialArtifact);
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
            layout: defined(f.input.materialPipelineState?.gpuDrivenPbrPipelineLayout),
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
        const selected = admitGpuFixture({
          ...f.input,
          materialArtifacts: new Map([
            [main.material, main],
            [second.material, second],
          ]),
        });
        expect(defined(selected.materialArtifacts).size).toBe(2);
        const frame = defined(
          f.production
            .prepare(
              admitGpuFixture({
                ...f.input,
                ...selected,
                materialPipelineFactory,
                materialArtifacts: new Map([
                  [main.material, main],
                  [second.material, second],
                ]),
                materialArtifact: defined(selected.materialArtifacts?.values().next().value),
              }),
            )
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
      f.input.scene.plan = f.topology.query(f.topology.sourcePlan(), undefined);
      f.input.scene.slots = f.projection.slotsSnapshot();
      const next = prepare();
      expect([...defined(next.selected.materialArtifacts).keys()].sort()).toEqual(
        [...defined(first.selected.materialArtifacts).keys()].sort(),
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
      const main = defined(f.input.materialArtifact);
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), main]),
      );
      const prepare = () =>
        defined(f.production.prepare(admitGpuFixture({ ...f.input, materialArtifacts })).unwrap());
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
    const skinInputs = new SkinSceneInputs(f.input.scene.scene.inputs.arena, () => ({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: mat4.identity(mat4.create()),
    }));
    try {
      const main = defined(f.input.materialArtifact);
      const receipt = createStandardPbrArtifactReceipt(true);
      const skinArtifact = { ...main, material: 'forgeax::pbr-skin', receipt };
      const source = defined(f.input.scene.slots.at(1)).snapshot;
      const material = new MaterialResource({
        ...source.material.snapshot,
        materialShaderId: skinArtifact.material,
        materialProgramKeys: { forward: skinArtifact.material, shadow: skinArtifact.material },
      });
      const snapshot: RenderableSnapshot = {
        ...source,
        material,
        materials: [material],
        skinBinding: { skeleton: 7, joints: [19] },
        gpuDrivenDraws: defined(source.gpuDrivenDraws).map((draw) => ({
          ...draw,
          geometry: {
            ...draw.geometry,
            deformation: 'skin',
            receipt: { ...draw.geometry.receipt, vertexInputs: receipt.vertexInputs },
          },
          prepared: {
            ...defined(draw.prepared),
            identity: { ...defined(draw.prepared).identity, deformation: 'skin' },
            vertexInputs: receipt.vertexInputs,
          },
        })),
      };
      const delta = f.projection.apply([
        { kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot },
      ]);
      skinInputs.apply(delta);
      skinInputs.joint(0, 19, mat4.identity(mat4.create()));
      Object.assign(f.input.scene, { skin: skinInputs.prepareFrame(f.projection.slotsSnapshot()) });
      f.input.scene.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.input.scene.plan = f.topology.query(f.topology.sourcePlan(), undefined);
      f.input.scene.slots = f.projection.slotsSnapshot();
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [
          artifactKey(batch),
          batch.binding?.geometry.deformation === 'skin' ? skinArtifact : main,
        ]),
      );
      const state = defined(f.input.materialPipelineState);
      const skinLayout = f.device
        .createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: 1,
              buffer: { type: 'read-only-storage', hasDynamicOffset: true },
            },
            { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
          ],
        })
        .unwrap();
      const materialPipelineState = {
        ...state,
        gpuDrivenPbrPrograms: new Map([
          ...defined(state.gpuDrivenPbrPrograms),
          [
            defined(standardPbrProgramKey(skinArtifact.material)),
            {
              module: defined([...defined(state.gpuDrivenPbrPrograms).values()][0]).module,
              artifact: skinArtifact,
            },
          ],
        ]),
        gpuDrivenPbrSkinPipelineLayout: defined(state.gpuDrivenPbrPipelineLayout),
        pbrSkinMeshBindGroupLayout: skinLayout,
      };
      const prepare = (materialSkinArtifact: MaterialShaderArtifact) =>
        defined(
          f.production
            .prepare(
              admitGpuFixture({
                ...f.input,
                materialArtifacts,
                materialPipelineState,
                materialSkinArtifact,
              }),
            )
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
      skinInputs.dispose();
      f.close();
    }
  });

  it('observes selected shadow programs across unsubmitted replacement, reversal and abort', async () => {
    const f = await fixture();
    try {
      const main = defined(f.input.materialArtifact);
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
          f.production
            .prepare(admitGpuFixture({ ...f.input, shadowMaterialArtifacts, shadowViews: true }))
            .unwrap(),
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
        expect(
          projections.every((projection) => projection.shadowArtifact.program === artifact.program),
        ).toBe(true);
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
      expect(f.production.inspect().filteredBatchBuilds).toBe(2);
      second._abortResourceReplacement?.();
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
        ...defined(f.input.materialArtifact),
        vertexEntry: 'vs-before',
        fragmentEntry: 'fs-before',
      };
      const materialArtifacts = new Map(
        f.input.scene.plan.batches.map((batch) => [artifactKey(batch), artifact]),
      );
      const prepare = () =>
        defined(f.production.prepare(admitGpuFixture({ ...f.input, materialArtifacts })).unwrap());
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
