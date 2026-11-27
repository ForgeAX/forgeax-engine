import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { RhiNullComputePassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';
import { shadowSourceFixture } from './shadow-source-content.fixture';
import { skinTaskFixture } from './skin-task-fixture';

it.each([
  'observe',
  'execute',
] as const)('refuses a failed Scene even when its real input snapshot remains held (%s)', async (operation) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const inputs = f.gpuScene.inputs;
  const reads = inputs.capture();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  try {
    f.view.update(f.original, f.gpuScene, reads, planes).unwrap();
    const buffer = reads.buffer().unwrap().buffer;
    reads.seal().unwrap();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    const world = mat4.identity(mat4.create());
    world[12] = 7;
    const delta = f.projection.apply([{ kind: 'update', entityKey: 1, world }]);
    writes.mockImplementationOnce(() => {
      throw Error('actual table write lost its completion receipt');
    });
    expect(f.gpuScene.sync(delta).ok).toBe(false);
    expect(f.gpuScene.live).toBe(false);
    expect(inputs.isLiveOn(device)).toBe(true);
    expect(inputs.readHoldsBuffer(reads, buffer)).toBe(true);
    const result =
      operation === 'observe'
        ? f.view.observeInputReads(f.gpuScene, reads)
        : graph.unwrap().execute({ encoder: device.createCommandEncoder().unwrap() });
    expect(result.ok).toBe(false);
  } finally {
    writes.mockRestore();
    if (graph?.ok) await graph.value.retire();
    reads.release();
    f.close();
  }
});

it('does not accept overwritten public liveness methods as input lease authority', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const reads = f.gpuScene.inputs.capture();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  try {
    f.view.update(f.original, f.gpuScene, reads, planes).unwrap();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    reads.seal().unwrap();
    reads.release();
    reads.isCurrent = () => true;
    reads.holdsBuffer = () => true;
    expect(f.view.observeInputReads(f.gpuScene, reads).ok).toBe(false);
    expect(graph.unwrap().execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(
      false,
    );
  } finally {
    if (graph?.ok) await graph.value.retire();
    reads.release();
    f.close();
  }
});

it('rejects mismatched input mapping roots before the first Skin task dispatch', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(device, { code: 'structural Skin fixture' })
  ).unwrap();
  const skin = skinTaskFixture();
  const available = GpuScene.create(device, 4, undefined, skin.arena).unwrap();
  if (available.status !== 'available') throw Error('missing actual shared Skin Scene');
  const scene = available.scene;
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const firstFrame = scene.captureResources().unwrap();
  const first = firstFrame.inputReads();
  let nextFrame: GpuSceneResourceFrame | undefined;
  let next: ReturnType<typeof scene.inputs.capture> | undefined;
  let upload: ReturnType<typeof scene.inputs.capture> | undefined;
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  const slots: number[] = [];
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const dispatch = vi.spyOn(RhiNullComputePassEncoder.prototype, 'dispatchWorkgroups');
  try {
    view
      .update(
        new BatchTopology().sourcePlan(),
        scene,
        first,
        planes,
        undefined,
        0,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        skin.frame,
      )
      .unwrap();
    firstFrame.seal().unwrap();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(graph.unwrap().execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(
      true,
    );
    expect(dispatch).toHaveBeenCalled();
    firstFrame.release();
    for (let index = 0; index < 1024; index++) slots.push(scene.inputs.allocateResource(0));
    upload = scene.inputs.capture();
    upload.buffer().unwrap();
    upload.seal().unwrap();
    upload.release();
    nextFrame = scene.captureResources().unwrap();
    next = nextFrame.inputReads();
    view.observeInputReads(scene, next).unwrap();
    nextFrame.seal().unwrap();
    dispatch.mockClear();
    expect(graph.unwrap().execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(
      false,
    );
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    dispatch.mockRestore();
    if (graph?.ok) await graph.value.retire();
    firstFrame.release();
    nextFrame?.release();
    upload?.release();
    for (const slot of slots) scene.inputs.releaseResource(slot);
    view.dispose();
    scene.dispose();
    skin.dispose();
  }
});

it.each([
  false,
  true,
])('requires a real held input read before replaying cached compute (held=%s)', async (held) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const inputs = f.gpuScene.inputs;
  if (f.original.sourceGroups !== undefined) inputs.adoptSources(f.original.sourceGroups);
  const frame = f.gpuScene.captureResources().unwrap();
  const reads = frame.inputReads();
  let growth: ReturnType<typeof inputs.capture> | undefined;
  const slots: number[] = [];
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  try {
    f.view.update(f.original, f.gpuScene, reads, planes).unwrap();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    const compiled = graph.unwrap();
    frame.seal().unwrap();
    expect(compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(true);
    if (!held) frame.release();
    for (let index = 0; index < 1024; index++) slots.push(inputs.allocateResource(0));
    growth = inputs.capture();
    growth.buffer().unwrap();
    growth.seal().unwrap();
    growth.release();
    await device.queue.onSubmittedWorkDone();
    const result = compiled.execute({ encoder: device.createCommandEncoder().unwrap() });
    expect(result.ok).toBe(held);
    if (!result.ok) expect(result.error.code).toBe('resource-resolution-failed');
  } finally {
    if (graph?.ok) await graph.value.retire();
    frame.release();
    growth?.release();
    for (const slot of slots) inputs.releaseResource(slot);
    f.close();
  }
});

it('refuses copied and foreign input reads before changing native View state', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const other = uploadFixture(device, shader);
  const reads = f.gpuScene.inputs.capture();
  const foreign = other.gpuScene.inputs.capture();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  try {
    expect(f.view.update(f.original, f.gpuScene, { ...reads }, planes).ok).toBe(false);
    expect(f.view.update(f.original, f.gpuScene, foreign, planes).ok).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    f.view.update(f.original, f.gpuScene, reads, planes).unwrap();
    writes.mockClear();
    expect(f.view.observeInputReads(f.gpuScene, foreign).ok).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  } finally {
    writes.mockRestore();
    reads.release();
    foreign.release();
    f.close();
    other.close();
  }
});

it.each([
  'update',
  'observe',
] as const)('keeps the outer mutation guard after nested %s refuses', async (operation) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const firstFrame = f.gpuScene.captureResources().unwrap();
  const nextFrame = f.gpuScene.captureResources().unwrap();
  const first = firstFrame.inputReads();
  const next = nextFrame.inputReads();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  let nested: boolean | undefined;
  let during: boolean | undefined;
  const write = device.queue.writeBuffer.bind(device.queue);
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    f.view.update(f.original, f.gpuScene, first, planes).unwrap();
    firstFrame.seal().unwrap();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.view.addPasses(builder).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    const compiled = graph.unwrap();
    hook = vi.spyOn(device.queue, 'writeBuffer').mockImplementationOnce((...args) => {
      nested =
        operation === 'update'
          ? f.view.update(f.original, f.gpuScene, next, planes).ok
          : f.view.observeInputReads(f.gpuScene, next).ok;
      during = compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).ok;
      return write(...args);
    });
    f.view.update(f.original, f.gpuScene, next, planes).unwrap();
    nextFrame.seal().unwrap();
    expect(nested).toBe(false);
    expect(during).toBe(false);
    expect(compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(true);
  } finally {
    hook?.mockRestore();
    if (graph?.ok) await graph.value.retire();
    firstFrame.release();
    nextFrame.release();
    f.close();
  }
});

it('reads mutable raw task headers and current physical fallback rows on every actual update', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const observed = observeGpuInputBytes(device);
  const raw = {
    ...f.original,
    batches: f.original.batches.map((batch) => ({ ...batch, key: { ...batch.key } })),
  };
  const held = f.gpuScene.captureResources().unwrap();
  try {
    held.indexForResource(f.material, f.material.snapshot);
    held.seal().unwrap();
    f.update(raw).unwrap();
    const header = observed.header;
    const first = raw.batches[0];
    if (first === undefined) throw new Error('Missing raw task');
    const count = first.key.count,
      material = header().getUint32(40, true);
    first.key.count++;
    f.update(raw).unwrap();
    expect(header().getUint32(8, true)).toBe(count + 1);
    f.material.adopt({ ...f.material.snapshot, roughness: 0.25 });
    f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
    const current = f.gpuScene.materialIndexForResource(f.material);
    expect(current).not.toBe(material);
    f.update(raw).unwrap();
    expect(header().getUint32(40, true)).toBe(current);
  } finally {
    observed.close();
    held.release();
    f.close();
  }
});

it('refreshes and leases current shared inputs only when a retained shadow actually forces compute', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const f = shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
  const source = f.input();
  if (source.sourcePlan.sourceGroups !== undefined)
    f.scene.inputs.adoptSources(source.sourcePlan.sourceGroups);
  const first = f.scene.inputs.capture();
  let next: ReturnType<typeof f.scene.inputs.capture> | undefined;
  const slots: number[] = [];
  try {
    f.pool.update({ ...source, inputReads: first }).unwrap();
    const previousBuffer = first.buffer().unwrap().buffer;
    first.seal().unwrap();
    f.pool._closeInputReads();
    f.pool._commitResourceReplacement();
    first.release();
    await device.queue.onSubmittedWorkDone();
    for (let index = 0; index < 1024; index++) slots.push(f.scene.inputs.allocateResource(index));
    next = f.scene.inputs.capture();
    const headers = vi.spyOn(next, 'header');
    const reuse = vi.spyOn(next, 'reuseHeader');
    const demands = () => headers.mock.calls.length + reuse.mock.calls.length;
    const hit = f.pool.update({ ...f.input(), inputReads: next }).unwrap();
    expect(hit.cache).toBe('hit');
    expect(demands()).toBe(0);
    const depth = f.pool.project(new RenderGraphBuilder(), f.identity).unwrap();
    expect(depth.passNames).toHaveLength(0);
    expect(demands()).toBe(0);
    const forced = f.pool.project(new RenderGraphBuilder(), f.identity, true).unwrap();
    expect(forced.cache).toBe('hit');
    expect(forced.passNames).toEqual([
      'gpu-driven.shadow.directional-cascade-0.static.view-selection',
    ]);
    expect(demands()).toBeGreaterThan(0);
    expect(next.buffer().unwrap().buffer).not.toBe(previousBuffer);
    next.seal().unwrap();
    f.pool._closeInputReads();
    expect(f.pool.project(new RenderGraphBuilder(), f.identity, true).ok).toBe(false);
  } finally {
    first.release();
    next?.release();
    for (const slot of slots) f.scene.inputs.releaseResource(slot);
    f.dispose();
  }
});

it('poisons a partially updated Scene on a real mapping capacity failure and still releases held frames', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const arena = new GpuInputArena(8192);
  const created = GpuScene.create(device, 4, undefined, arena).unwrap();
  if (created.status !== 'available') throw new Error('Scene unavailable');
  const gpu = created.scene,
    source = receiptRow().source,
    scene = new RenderScene();
  gpu
    .sync(scene.apply([{ kind: 'update', entityKey: source.entityKey, snapshot: source }]))
    .unwrap();
  const held = gpu.captureResources().unwrap();
  try {
    held.indexForResource(source.material, source.material.snapshot);
    held.seal().unwrap();
    source.material.adopt({ ...source.material.snapshot, roughness: 0.25 });
    const failed = gpu.sync({ ...scene.apply([]), materialUpdates: [source.material] });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('Expected real arena capacity rejection');
    const next = gpu.sync(scene.apply([]));
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error('A poisoned owner must not consume another diff');
    expect(next.error).toBe(failed.error);
    expect(gpu.captureResources().ok).toBe(false);
    let complete!: () => void;
    held.submit(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    complete();
    await Promise.resolve();
    expect(() => held.release()).not.toThrow();
  } finally {
    held.release();
    gpu.dispose();
    arena.dispose();
  }
});

it.each([
  false,
  true,
])('faults the Scene and drains remaining frame references after release failure (after=%s)', async (after) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const f = uploadFixture(device, shader);
  const frame = f.gpuScene.captureResources().unwrap();
  frame.indexForResource(f.material, f.material.snapshot);
  const allocation = Reflect.get(f.gpuScene, 'sharedMaterials').get(f.material);
  expect(allocation.version.references).toBe(2);
  const reads = frame.inputReads();
  const release = reads.release.bind(reads);
  const witness = new Error('read retirement witness');
  const hook = vi.spyOn(reads, 'release').mockImplementation(() => {
    if (after) release();
    throw witness;
  });
  try {
    let failure: unknown;
    try {
      frame.release();
    } catch (cause) {
      failure = cause;
    }
    expect(allocation.version.references).toBe(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(f.gpuScene.captureResources().ok).toBe(false);
    expect(f.gpuScene.sync(f.projection.apply([])).ok).toBe(false);
    expect(() => frame.release()).toThrow(AggregateError);
    expect(() => f.gpuScene.dispose()).toThrow(AggregateError);
    expect(() => f.gpuScene.dispose()).toThrow(AggregateError);
  } finally {
    hook.mockRestore();
    release();
    try {
      f.close();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AggregateError);
    }
  }
});
