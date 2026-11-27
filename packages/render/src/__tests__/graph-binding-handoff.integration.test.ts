import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import { worldRenderResources } from '../publication/resource-scope';
import type { GraphBindingViews } from '../record/graph-binding-views';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
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
  const close = async () => {
    const failures: unknown[] = [];
    const attempt = async (action: () => unknown | Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        failures.push(cause);
      }
    };
    for (const graph of graphs)
      await attempt(async () => {
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
    const result = {
      f,
      runtime,
      target,
      graph,
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

it('tracks the material that issued a shared physical group when another material retires', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry && handle !== undefined);
  const source = worldRenderResources(f.f.world).identity;
  const shader = entry.material.materialShaderId;
  const second = { ...entry, bindingsCurrent: () => true };
  cache.set(source, handle + 1, shader, undefined, second);
  const current = cache.captureBindingCurrent(source, handle + 1, shader, undefined, 0, second);
  assert(current);
  expect(current()).toBe(true);
  cache.releaseBinding(handle, entry);
  expect(current()).toBe(true);
  cache.releaseBinding(handle + 1, second);
  expect(current()).toBe(false);
});

it('keeps retired rows absent when another binding retires them during publication', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry && handle !== undefined);
  const source = worldRenderResources(f.f.world).identity;
  let retire = false;
  const survivor = {
    ...entry,
    bindingsCurrent: () => {
      if (retire) cache.releaseBinding(handle, entry);
      return true;
    },
  };
  cache.set(source, handle + 1, entry.material.materialShaderId, undefined, survivor);
  const prepared = cache.prepareTableBindings(f.runtime, f.target, () => true).unwrap();
  retire = true;
  expect(prepared.publish().ok).toBe(false);
  expect([...cache.values()]).toEqual([survivor]);
  prepared.release();
  cache
    .prepareTableBindings(f.runtime, f.target, () => true)
    .unwrap()
    .publish()
    .unwrap();
  expect([...cache.values()][0]?.sceneMaterialBuffer).toBe(f.target.materialBuffer);
});

it('prepares changed scene tables with linear material readiness checks', async () => {
  const f = await fixture();
  const cache = f.f.manager.currentOwner.frameState.materialBgAssemblyCache;
  const entry = [...cache.values()][0];
  const handle = entry?.material.materialHandle;
  assert(entry && handle !== undefined);
  const source = worldRenderResources(f.f.world).identity;
  const current = vi.fn(() => true);
  const count = 32;
  for (let i = 0; i < count; i++) {
    cache.set(source, handle, entry.material.materialShaderId, i, {
      ...entry,
      bindingsCurrent: current,
      bindGroup: f.runtime.device.createBindGroup(entry.descriptor).unwrap(),
    });
  }
  const prepared = cache.prepareTableBindings(f.runtime, f.target, () => true).unwrap();
  try {
    expect(prepared.isCurrent()).toBe(true);
    prepared.publish().unwrap();
    expect(current.mock.calls.length).toBeLessThanOrEqual(count * 8);
  } finally {
    prepared.release();
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

it('retires a graph variant without invalidating ordinary or other probe bindings at that material', async () => {
  const f = await fixture();
  const cache = new MaterialBgAssemblyCache();
  const [entry] = f.f.manager.currentOwner.frameState.materialBgAssemblyCache.values();
  assert(entry);
  const a = f.graph();
  const port = a.facts.views[0]?.[1];
  assert(port);
  const graphViews: GraphBindingViews = { graph: a.compiled, views: [['backdrop', port, a.view]] };
  const graphEntry = { ...entry, graphViews };
  cache.set('world', 12, 'surface', 0, graphEntry, 3);
  cache.set('world', 12, 'surface', 0, entry, 3);
  const probe = { ...entry };
  cache.set('world', 12, 'surface', undefined, probe, 3);
  cache.retireGraph(a.compiled);
  expect(cache.get('world', 12, 'surface', 0, graphViews, 3)).toBeUndefined();
  expect(cache.get('world', 12, 'surface', 0, undefined, 3)).toBe(entry);
  cache.releaseBinding(12, entry);
  expect([...cache.values()]).toEqual([probe]);
  expect(cache.get('world', 12, 'surface', undefined, undefined, 3)).toBe(probe);
  (await a.compiled.retire()).unwrap();
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
  const entry = [...f.f.manager.currentOwner.frameState.materialBgAssemblyCache.values()][0];
  assert(entry);
  const cache = new MaterialBgAssemblyCache();
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
