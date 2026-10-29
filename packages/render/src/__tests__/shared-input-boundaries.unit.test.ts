import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene } from '../gpu-scene';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';
import { shadowSourceFixture } from './shadow-source-content.fixture';

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
    const members = vi.spyOn(next, 'members');
    const hit = f.pool.update({ ...f.input(), inputReads: next }).unwrap();
    expect(hit.cache).toBe('hit');
    expect(members).not.toHaveBeenCalled();
    const depth = f.pool.project(new RenderGraphBuilder(), f.identity).unwrap();
    expect(depth.passNames).toHaveLength(0);
    expect(members).not.toHaveBeenCalled();
    const forced = f.pool.project(new RenderGraphBuilder(), f.identity, true).unwrap();
    expect(forced.cache).toBe('hit');
    expect(forced.passNames).toHaveLength(3);
    expect(members).toHaveBeenCalled();
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
    .sync(
      scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
    )
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
