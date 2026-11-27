import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { GPU_TASK_HEADER_BYTES } from '../gpu-driven/task-header';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';
import { runSharedGeometryCullEvidence } from './gpu-driven-view-gpu-evidence';
import { nativeDeviceFixture } from './native-device-fixture';
import { shadowSourceFixture } from './shadow-source-content.fixture';

it('reuses a compiled shadow graph only with fresh real reads after background native growth', async () => {
  const { device, native } = await nativeDeviceFixture();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
  const source = { ...f.input(), candidatePrimitiveIndices: [0, 1] };
  const inputs = f.scene.inputs;
  if (source.sourcePlan.sourceGroups !== undefined)
    inputs.adoptSources(source.sourcePlan.sourceGroups);
  const first = f.scene.captureResources().unwrap();
  const slots: number[] = [];
  let upload: ReturnType<typeof inputs.capture> | undefined;
  let next: GpuSceneResourceFrame | undefined;
  let refreshed: GpuSceneResourceFrame | undefined;
  let graph: ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']> | undefined;
  native.pushErrorScope('validation');
  try {
    const initial = f.pool.update({ ...source, inputReads: first.inputReads() }).unwrap();
    const oldBuffer = first.inputReads().buffer().unwrap().buffer;
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.pool.project(builder, source.identity).unwrap();
    graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    const compiled = graph.unwrap();
    const execute = async () => {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    };
    first.seal().unwrap();
    f.pool._closeInputReads();
    await execute();
    f.pool._commitResourceReplacement();
    first.release();

    // The independent background reader really publishes the larger native
    // arena before the retained View observes its next ordinary frame.
    for (let index = 0; index < 1024; index++) slots.push(inputs.allocateResource(0));
    upload = inputs.capture();
    const grownBuffer = upload.buffer().unwrap().buffer;
    expect(grownBuffer).not.toBe(oldBuffer);
    upload.seal().unwrap();
    upload.release();
    await device.queue.onSubmittedWorkDone();
    expect(compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(false);

    next = f.scene.captureResources().unwrap();
    const headers = vi.spyOn(next.inputReads(), 'header');
    const reuse = vi.spyOn(next.inputReads(), 'reuseHeader');
    const updates = vi.spyOn(initial.view, 'update');
    const retained = f.pool.update({ ...source, inputReads: next.inputReads() }).unwrap();
    expect(retained.cache).toBe('hit');
    expect(updates).not.toHaveBeenCalled();
    expect(initial.view.sceneInputBuffer).toBe(grownBuffer);
    expect(headers).not.toHaveBeenCalled();
    expect(reuse).not.toHaveBeenCalled();
    next.seal().unwrap();
    f.pool._closeInputReads();
    await execute();

    // Observing a depth-only cache hit refreshes bindings, never the old
    // compute uniform's mapping root. Actual compute must first update it.
    f.pool.invalidate('view-changed', source.identity);
    expect(compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(false);
    next.release();
    refreshed = f.scene.captureResources().unwrap();
    const updated = f.pool.update({ ...source, inputReads: refreshed.inputReads() }).unwrap();
    expect(updated.cache).toBe('invalidated');
    refreshed.seal().unwrap();
    f.pool._closeInputReads();
    await execute();

    const indirect = initial.view.indirectBuffer;
    if (indirect === undefined) throw Error('Missing actual retained indirect buffer');
    const size = 20 * updated.plan.batches.length;
    const readback = device.createBuffer({ size, usage: 1 | 8 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyBufferToBuffer(indirect, 0, readback, 0, size);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const values = new Uint32Array(mapped.getMappedRange().unwrap());
        let instances = 0;
        for (let index = 1; index < values.length; index += 5) instances += values[index] ?? 0;
        expect(instances).toBe(updated.plan.candidateCount);
        expect(instances).toBeGreaterThan(0);
      } finally {
        mapped.unmap();
      }
    } finally {
      device.destroyBuffer(readback);
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    if (graph?.ok) await graph.value.retire();
    first.release();
    upload?.release();
    next?.release();
    refreshed?.release();
    for (const slot of slots) inputs.releaseResource(slot);
    f.dispose();
    native.destroy();
  }
}, 30_000);

it('executes retained-shadow replacement compute with a fresh arena after old reads retire', async () => {
  const { device, native } = await nativeDeviceFixture();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
  const source = { ...f.input(), candidatePrimitiveIndices: [0, 1] };
  if (source.sourcePlan.sourceGroups !== undefined)
    f.scene.inputs.adoptSources(source.sourcePlan.sourceGroups);
  const first = f.scene.captureResources().unwrap();
  const slots: number[] = [];
  let next: GpuSceneResourceFrame | undefined;
  native.pushErrorScope('validation');
  const execute = async (graph: RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>) => {
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    } finally {
      await compiled.retire();
    }
  };
  try {
    const initial = f.pool.update({ ...source, inputReads: first.inputReads() }).unwrap();
    const oldBuffer = first.inputReads().buffer().unwrap().buffer;
    const firstGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    f.pool.project(firstGraph, source.identity).unwrap();
    first.seal().unwrap();
    f.pool._closeInputReads();
    await execute(firstGraph);
    f.pool._commitResourceReplacement();
    first.release();
    for (let index = 0; index < 1024; index++) slots.push(f.scene.inputs.allocateResource(0));
    next = f.scene.captureResources().unwrap();
    const headers = vi.spyOn(next.inputReads(), 'header');
    const reuse = vi.spyOn(next.inputReads(), 'reuseHeader');
    const demands = () => headers.mock.calls.length + reuse.mock.calls.length;
    const retained = f.pool.update({ ...source, inputReads: next.inputReads() }).unwrap();
    expect(retained.cache).toBe('hit');
    expect(demands()).toBe(0);
    const depthOnly = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(f.pool.project(depthOnly, source.identity).unwrap().passNames).toEqual([]);
    const replacement = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(f.pool.project(replacement, source.identity, true).unwrap().passNames).toEqual([
      'gpu-driven.shadow.directional-cascade-0.static.view-selection',
    ]);
    expect(demands()).toBeGreaterThan(0);
    expect(Object.is(next.inputReads().buffer().unwrap().buffer, oldBuffer)).toBe(false);
    next.seal().unwrap();
    f.pool._closeInputReads();
    await execute(replacement);
    const indirect = initial.view.indirectBuffer;
    if (indirect === undefined) throw Error('Missing actual indirect buffer');
    const size = 20 * retained.plan.batches.length;
    const readback = device.createBuffer({ size, usage: 1 | 8 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyBufferToBuffer(indirect, 0, readback, 0, size);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const values = new Uint32Array(mapped.getMappedRange().unwrap());
        let instances = 0;
        for (let index = 1; index < values.length; index += 5) instances += values[index] ?? 0;
        expect(instances).toBe(retained.plan.candidateCount);
        expect(instances).toBeGreaterThan(0);
      } finally {
        mapped.unmap();
      }
    } finally {
      device.destroyBuffer(readback);
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    first.release();
    next?.release();
    for (const slot of slots) f.scene.inputs.releaseResource(slot);
    f.dispose();
    native.destroy();
  }
}, 30_000);

it('reads the exact held Mesh descriptor after replacement, aborted preparation and removal', async () => {
  const { device, native } = await nativeDeviceFixture();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw Error('GPU scene unavailable');
  const scene = available.scene;
  const projection = new RenderScene();
  const mesh = createPrimitiveMesh('cube').unwrap();
  const source = receiptRow().source;
  const first = new MeshFrame().with(9, { ...mesh, aabb: Float32Array.of(-2, -1, -1, 2, 1, 1) });
  const readback = device.createBuffer({ size: 28, usage: 1 | 8 }).unwrap();
  native.pushErrorScope('validation');
  const oldFrames: import('../gpu-scene').GpuSceneResourceFrame[] = [];
  try {
    scene
      .sync({
        ...projection.apply([{ kind: 'update', entityKey: source.entityKey, snapshot: source }]),
        meshes: first,
      })
      .unwrap();
    const buffers = [scene.primitiveBuffer, scene.instanceBuffer, scene.transformBuffer];
    const capacity = scene.rowCapacity;
    const a = scene.captureResources().unwrap();
    oldFrames.push(a);
    const address = a.indexForGeometry(9, first.get(9));
    if (address === undefined) throw Error('missing held geometry');
    const oldInput = a.inputReads().buffer().unwrap().buffer;
    a.seal().unwrap();
    const next = first.with(9, { ...mesh, aabb: Float32Array.of(-9, -1, -1, 9, 1, 1) });
    scene.sync({ ...projection.apply([]), meshes: next }).unwrap();
    const b = scene.captureResources().unwrap();
    oldFrames.push(b);
    const newAddress = b.indexForGeometry(9, next.get(9));
    if (newAddress === undefined) throw Error('B did not pin its current Mesh version');
    expect(newAddress).not.toBe(address);
    b.inputReads().buffer().unwrap();
    b.seal().unwrap();
    b.release(); // Abort B; the current Scene still owns B until removal.
    scene.sync(projection.apply([{ kind: 'remove', entityKey: source.entityKey }])).unwrap();
    expect(scene.geometryIndexForResource(9)).toBeUndefined();
    expect(scene.rowCapacity).toBe(capacity);
    expect(scene.primitiveBuffer).toBe(buffers[0]);
    expect(scene.instanceBuffer).toBe(buffers[1]);
    expect(scene.transformBuffer).toBe(buffers[2]);
    // No helper flush here: this is A's actual input buffer captured before seal.
    const beforeUpload = scene.inputs.uploadBytes;
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(oldInput, address * 4, readback, 0, 28);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = device.queue.onSubmittedWorkDone();
    a.submit(completed);
    await completed;
    const mapped = (await readback.mapAsync(1)).unwrap();
    try {
      const bytes = mapped.getMappedRange().unwrap();
      expect(new Uint32Array(bytes)[0]).toBe(2);
      expect(Array.from(new Float32Array(bytes).slice(1))).toEqual([-2, -1, -1, 2, 1, 1]);
    } finally {
      mapped.unmap();
    }
    expect(scene.inputs.uploadBytes).toBe(beforeUpload);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    for (const frame of oldFrames) frame.release();
    scene.dispose();
    device.destroyBuffer(readback);
    await device.queue.onSubmittedWorkDone();
    native.destroy();
  }
}, 30000);

it('culls old and current shared Mesh bounds with actual descriptor and map upload costs', async () => {
  const result = await runSharedGeometryCullEvidence();
  expect(result.frames.map((frame) => frame.visible)).toEqual([0, 1024, 0, 1024, 0]);
  expect(result.geometryUpload).toBe(4 * 1024 + 32 + GPU_TASK_HEADER_BYTES);
  expect(result.frames.slice(1).map((frame) => frame.sharedInputUploadBytes)).toEqual([
    4 * 1024 + 32 + GPU_TASK_HEADER_BYTES,
    GPU_TASK_HEADER_BYTES,
    4 * 1024 + 12 + GPU_TASK_HEADER_BYTES,
    GPU_TASK_HEADER_BYTES,
  ]);
  const members = result.frames[0]?.memberNodesWritten;
  expect(members).toBeGreaterThan(0);
  expect(result.frames.map((frame) => frame.memberNodesWritten)).toEqual(Array(5).fill(members));
  expect(result.frames.map((frame) => frame.taskHeadersWritten)).toEqual([1, 2, 3, 4, 5]);
}, 30_000);
