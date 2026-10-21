import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';
import { runSharedGeometryCullEvidence } from './gpu-driven-view-gpu-evidence';
import { nativeDeviceFixture } from './native-device-fixture';
import { shadowSourceFixture } from './shadow-source-content.fixture';

it('executes retained-shadow replacement compute with a fresh arena after old reads retire', async () => {
  const { device, native } = await nativeDeviceFixture();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
  const source = { ...f.input(), candidatePrimitiveIndices: [0, 1] };
  if (source.sourcePlan.sourceGroups !== undefined)
    f.scene.inputs.adoptSources(source.sourcePlan.sourceGroups);
  const first = f.scene.inputs.capture();
  const slots: number[] = [];
  let next: ReturnType<typeof f.scene.inputs.capture> | undefined;
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
    const initial = f.pool.update({ ...source, inputReads: first }).unwrap();
    const oldBuffer = first.buffer().unwrap().buffer;
    const firstGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    f.pool.project(firstGraph, source.identity).unwrap();
    first.seal().unwrap();
    f.pool._closeInputReads();
    await execute(firstGraph);
    f.pool._commitResourceReplacement();
    first.release();
    for (let index = 0; index < 1024; index++) slots.push(f.scene.inputs.allocateResource(0));
    next = f.scene.inputs.capture();
    const demands = vi.spyOn(next, 'members');
    const retained = f.pool.update({ ...source, inputReads: next }).unwrap();
    expect(retained.cache).toBe('hit');
    expect(demands).not.toHaveBeenCalled();
    const depthOnly = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(f.pool.project(depthOnly, source.identity).unwrap().passNames).toEqual([]);
    const replacement = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(f.pool.project(replacement, source.identity, true).unwrap().passNames).toHaveLength(3);
    expect(demands).toHaveBeenCalled();
    expect(next.buffer().unwrap().buffer).not.toBe(oldBuffer);
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
  const first = new MeshFrame().with(0, 9, { ...mesh, aabb: Float32Array.of(-2, -1, -1, 2, 1, 1) });
  const readback = device.createBuffer({ size: 28, usage: 1 | 8 }).unwrap();
  native.pushErrorScope('validation');
  const oldFrames: import('../gpu-scene').GpuSceneResourceFrame[] = [];
  try {
    scene
      .sync({
        ...projection.apply([
          { kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source },
        ]),
        meshes: first,
      })
      .unwrap();
    const buffers = [scene.primitiveBuffer, scene.instanceBuffer, scene.transformBuffer];
    const capacity = scene.rowCapacity;
    const a = scene.captureResources().unwrap();
    oldFrames.push(a);
    const address = a.indexForGeometry(0, 9, first.get(0, 9));
    if (address === undefined) throw Error('missing held geometry');
    const oldInput = a.inputReads().buffer().unwrap().buffer;
    a.seal().unwrap();
    const next = first.with(0, 9, { ...mesh, aabb: Float32Array.of(-9, -1, -1, 9, 1, 1) });
    scene.sync({ ...projection.apply([]), meshes: next }).unwrap();
    const b = scene.captureResources().unwrap();
    oldFrames.push(b);
    const newAddress = b.indexForGeometry(0, 9, next.get(0, 9));
    if (newAddress === undefined) throw Error('B did not pin its current Mesh version');
    expect(newAddress).not.toBe(address);
    b.inputReads().buffer().unwrap();
    b.seal().unwrap();
    b.release(); // Abort B; the current Scene still owns B until removal.
    scene
      .sync(projection.apply([{ kind: 'remove', worldId: 0, entityKey: source.entityKey }]))
      .unwrap();
    expect(scene.geometryIndexForResource(0, 9)).toBeUndefined();
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
}, 30_000);

it('culls old and current shared Mesh bounds with actual descriptor and map upload costs', async () => {
  const result = await runSharedGeometryCullEvidence();
  expect(result.frames.map((frame) => frame.visible)).toEqual([0, 1024, 0, 1024, 0]);
  expect(result.geometryUpload).toBe(4 * 1024 + 28);
  expect(result.frames.slice(1).map((frame) => frame.sharedInputUploadBytes)).toEqual([
    4 * 1024 + 28,
    0,
    4 * 1024 + 8,
    0,
  ]);
}, 30_000);
