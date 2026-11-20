import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError, type TextureView } from '@forgeax/engine-rhi';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import { createHdrpUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import { worldRenderResources } from '../publication/resource-scope';
import {
  observeClusterMeshBinding,
  prepareClusterMeshBindings,
  rememberClusterMeshBinding,
  retireClusterMeshBindings,
} from '../record/cluster-mesh-binding-preparation';
import type { GraphBindingViews } from '../record/graph-binding-views';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { bindGroupByteRangeLeaf4 } from '../record/mesh-ssbo';
import { MATERIAL_UNIFORM_BYTES } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

async function fixture() {
  const f = await rendererInputHandoffFixture();
  const runtime = f.manager.currentOwner.internals;
  let capacity: GpuSceneCapacityPreparation | undefined;
  let work: ReturnType<typeof f.scene.prepareSourceCapacity> | undefined;
  const graphs: CompiledRenderGraph<RenderPipelineFrame>[] = [];
  const tasks = new Set<ReturnType<typeof prepareClusterMeshBindings>>();
  const cache = f.manager.currentOwner.frameState.meshBindGroupCache;
  const close = async () => {
    const failures: unknown[] = [];
    const attempt = async (action: () => unknown | Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        failures.push(cause);
      }
    };
    for (const task of tasks) await attempt(() => task.release());
    tasks.clear();
    for (const graph of graphs)
      await attempt(async () => {
        retireClusterMeshBindings(cache, graph);
        (await graph.retire()).unwrap();
      });
    await attempt(() => work?.return(undefined as never));
    await attempt(() => runtime.device.queue.onSubmittedWorkDone());
    await attempt(() => {
      if (capacity === undefined) return;
      let retired = capacity.retireStep();
      for (let count = 0; !retired && count < 1000; count++) retired = capacity.retireStep();
      expect(retired).toBe(true);
    });
    await attempt(async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
    if (failures.length > 0) throw new AggregateError(failures, 'binding fixture cleanup failed');
  };
  try {
    const hdrp = getOrCreateHdrpBuffers(runtime);
    assert(hdrp);
    const row = f.internals.sceneComposition?.entry?.projection.slotsSnapshot().at(0)?.snapshot;
    assert(row);
    work = f.scene.prepareSourceCapacity(
      Array.from({ length: f.scene.rowCapacity + 4 }, () => row),
      (value) => {
        capacity = value;
      },
      () => true,
    );
    let next = work.next();
    for (let count = 0; !next.done && count < 10000; count++) next = work.next();
    assert(next.done && capacity);
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    const graph = (previous?: CompiledRenderGraph<RenderPipelineFrame>) => {
      const builder = new RenderGraphBuilder<RenderPipelineFrame>();
      const size = { width: 8, height: 8, depthOrArrayLayers: 1 };
      const texture = builder.createTexture('ao', { format: 'rgba8unorm', size }).unwrap();
      const port = builder.view(texture).unwrap();
      builder
        .addRasterPass('ao', {
          accesses: [{ resource: port, usage: 'color-attachment' }],
          colorAttachments: [{ view: port, loadOp: 'clear', storeOp: 'store' }],
          encode: () => {},
        })
        .unwrap();
      const compiled = builder
        .compile({ device: runtime.device, surfaceSize: size, reuseResourcesFrom: previous })
        .unwrap();
      graphs.push(compiled);
      const view = compiled.createdTextureView(port);
      assert(view);
      const facts: GraphBindingViews = { graph: compiled, views: [['ssao', port, view]] };
      return { compiled, view, facts };
    };
    const noAo = {};
    const issue = (view?: TextureView) => {
      const lightingKey = view ?? noAo;
      const leaf = bindGroupByteRangeLeaf4(
        cache,
        f.scene.transformBuffer,
        hdrp.unifiedBindGroupLayout,
        hdrp,
        lightingKey,
      );
      const group = createHdrpUnifiedBindGroup(
        runtime,
        hdrp,
        f.scene.transformBuffer,
        view === undefined ? { enabled: false } : { enabled: true, ssaoBlurredView: view },
        f.scene.transformByteLength,
        (created, descriptor) =>
          rememberClusterMeshBinding(cache, created, {
            runtime,
            hdrp,
            lightingKey,
            descriptor,
            leaf,
            key: f.scene.transformByteLength,
          }),
      );
      assert(group);
      leaf.set(f.scene.transformByteLength, group);
      return group;
    };
    const result = {
      f,
      runtime,
      cache,
      target,
      graph,
      issue,
      task: () => {
        const task = prepareClusterMeshBindings(runtime, cache, target, () => true);
        tasks.add(task);
        return task;
      },
      close,
    };
    onTestFinished(result.close);
    return result;
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'binding fixture setup and cleanup failed');
    }
    throw cause;
  }
}

it.each([
  'first',
  'successor',
] as const)('keeps the other graph qualified when %s retires its shared SSAO binding', async (side) => {
  const f = await fixture();
  const task = f.task();
  try {
    const a = f.graph(),
      b = f.graph(a.compiled);
    expect(b.view).toBe(a.view);
    const group = f.issue(a.view);
    observeClusterMeshBinding(f.cache, group, a.compiled, a.facts, false).unwrap();
    observeClusterMeshBinding(f.cache, group, b.compiled, b.facts, false).unwrap();
    const retired = side === 'first' ? a : b;
    const survivor = side === 'first' ? b : a;
    retireClusterMeshBindings(f.cache, retired.compiled);
    (await retired.compiled.retire()).unwrap();
    task.prepareIssued(survivor.compiled).unwrap();
    expect(task.isCurrent()).toBe(true);
    task.publish().unwrap();
  } finally {
    task.release();
  }
});

it('refuses replacement when native creation retires the original graph', async () => {
  const f = await fixture();
  const task = f.task();
  const a = f.graph();
  const group = f.issue(a.view);
  observeClusterMeshBinding(f.cache, group, a.compiled, a.facts, false).unwrap();
  const create = f.runtime.device.createBindGroup.bind(f.runtime.device);
  const spy = vi.spyOn(f.runtime.device, 'createBindGroup').mockImplementationOnce((descriptor) => {
    const result = create(descriptor);
    retireClusterMeshBindings(f.cache, a.compiled);
    void a.compiled.retire();
    return result;
  });
  try {
    expect(task.prepareIssued(a.compiled).ok).toBe(false);
    expect(task.isCurrent()).toBe(false);
    expect(task.publish().ok).toBe(false);
    expect(observeClusterMeshBinding(f.cache, group, a.compiled, a.facts, false).ok).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
    task.release();
  }
});

it('invalidates an empty issued roster when its first actual group appears', async () => {
  const f = await fixture();
  const task = f.task();
  try {
    const a = f.graph();
    task.prepareIssued(a.compiled).unwrap();
    const group = f.issue();
    observeClusterMeshBinding(f.cache, group, a.compiled, undefined, false).unwrap();
    expect(task.isCurrent()).toBe(false);
    expect(task.publish().ok).toBe(false);
  } finally {
    task.release();
  }
});

it('rejects material table preparation if native creation issues another variant', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry !== undefined && handle !== undefined);
  const identity = worldRenderResources(f.f.world).identity;
  const create = f.runtime.device.createBindGroup.bind(f.runtime.device);
  const spy = vi.spyOn(f.runtime.device, 'createBindGroup').mockImplementationOnce((descriptor) => {
    const result = create(descriptor);
    cache.set(identity, handle, entry.material.materialShaderId, 99, entry);
    return result;
  });
  try {
    expect(cache.prepareTableBindings(f.runtime, f.target, () => true).ok).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(
      [...cache.values()].every((value) => value.sceneMaterialBuffer === entry.sceneMaterialBuffer),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('rebinds current material assemblies even after a different material lifetime has retired', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry !== undefined && handle !== undefined);
  const identity = worldRenderResources(f.f.world).identity;
  const shader = entry.material.materialShaderId;
  const retired = f.runtime.device.createBindGroup(entry.descriptor).unwrap();
  cache.set(identity, handle, shader, 65, {
    ...entry,
    bindGroup: retired,
    bindingsCurrent: () => false,
  });
  const prepared = cache.prepareTableBindings(f.runtime, f.target, () => true).unwrap();
  try {
    expect(prepared.replacement(retired)).toBeUndefined();
    expect(prepared.replacement(entry.bindGroup)).toBeDefined();
    expect(cache.get(identity, handle, shader, 65, entry.graphViews)).toBeUndefined();
    prepared.publish().unwrap();
    expect([...cache.values()]).toHaveLength(1);
    expect([...cache.values()][0]?.sceneMaterialBuffer).toBe(f.target.materialBuffer);
  } finally {
    prepared.release();
  }
});

it.each([
  false,
  true,
])('refuses ordinary first issuance after native callback retires its graph, SSAO %s', async (ssao) => {
  const f = await fixture();
  const task = f.task();
  const a = f.graph();
  const create = f.runtime.device.createBindGroup.bind(f.runtime.device);
  const spy = vi.spyOn(f.runtime.device, 'createBindGroup').mockImplementationOnce((descriptor) => {
    const result = create(descriptor);
    retireClusterMeshBindings(f.cache, a.compiled);
    void a.compiled.retire();
    return result;
  });
  try {
    const group = f.issue(ssao ? a.view : undefined);
    expect(
      observeClusterMeshBinding(f.cache, group, a.compiled, ssao ? a.facts : undefined, false).ok,
    ).toBe(false);
    expect(task.prepareIssued(a.compiled).ok).toBe(false);
    expect(task.isCurrent()).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
    task.release();
  }
});

it('cannot reinsert a material graph variant after its original graph retires', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry !== undefined && handle !== undefined);
  const a = f.graph();
  const aoPort = a.facts.views[0]?.[1];
  assert(aoPort !== undefined);
  const graphViews: GraphBindingViews = {
    graph: a.compiled,
    views: [['backdrop', aoPort, a.view]],
  };
  const identity = worldRenderResources(f.f.world).identity;
  cache.set(identity, handle, entry.material.materialShaderId, 99, { ...entry, graphViews });
  expect([...cache.values()].some((value) => value.graphViews?.graph === a.compiled)).toBe(true);
  cache.retireGraph(a.compiled);
  (await a.compiled.retire()).unwrap();
  expect(() =>
    cache.set(identity, handle, entry.material.materialShaderId, 99, { ...entry, graphViews }),
  ).toThrow();
  expect([...cache.values()].some((value) => value.graphViews?.graph === a.compiled)).toBe(false);
});

it.each([
  'native',
  'retention',
] as const)('refuses an ordinary material result when %s callback retires its original graph', async (stage) => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  assert(entry);
  const a = f.graph();
  const port = a.facts.views[0]?.[1];
  assert(port);
  const graphViews: GraphBindingViews = { graph: a.compiled, views: [['backdrop', port, a.view]] };
  const pipelineState = recordContext(f.runtime).getPipelineState();
  assert(pipelineState);
  const deps: PerSubmeshMaterialBgDeps = {
    runtime: f.runtime,
    pipelineState,
    world: worldRenderResources(f.f.world),
    store: f.runtime.gpuStore,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: false,
    skylightResources: entry.skylightResources,
    materialBgShared: f.f.manager.currentOwner.frameState.materialBgShared,
    materialBgAssemblyCache: cache,
    sceneMaterialBuffer: f.f.scene.materialBuffer,
    transmissionBackdropView: a.view,
    graphViews,
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: f.f.manager.currentOwner.frameState,
  };
  const retire = () => {
    cache.retireGraph(a.compiled);
    void a.compiled.retire();
  };
  const create = f.runtime.device.createBindGroup.bind(f.runtime.device);
  const set = cache.set.bind(cache);
  const native = vi.spyOn(f.runtime.device, 'createBindGroup');
  const retention = vi.spyOn(cache, 'set');
  if (stage === 'native')
    native.mockImplementationOnce((descriptor) => {
      const result = create(descriptor);
      retire();
      return result;
    });
  else
    retention.mockImplementationOnce((...args) => {
      retire();
      return set(...args);
    });
  try {
    expect(() => buildPerSubmeshMaterialBg(deps, entry.material, undefined)).toThrow(RhiError);
    expect(native).toHaveBeenCalledOnce();
    if (stage === 'retention') expect(retention).toHaveBeenCalledOnce();
    expect([...cache.values()].some((value) => value.graphViews?.graph === a.compiled)).toBe(false);
  } finally {
    native.mockRestore();
    retention.mockRestore();
  }
});
