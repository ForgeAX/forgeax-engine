import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { nativeDeviceFixture } from './native-device-fixture';
import { shadowSourceFixture } from './shadow-source-content.fixture';
import { skinInputBindingPlan, skinTaskFixture } from './skin-task-fixture';

it('runs old native shadow compute during preparation and reuses its compiled graph after pure publication', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
  const source = { ...f.input(), candidatePrimitiveIndices: [0, 1] };
  const inputs = f.scene.inputs;
  if (source.sourcePlan.sourceGroups !== undefined)
    inputs.adoptSources(source.sourcePlan.sourceGroups);
  const firstResources = f.scene.captureResources().unwrap();
  const first = firstResources.inputReads();
  const initial = f.pool.update({ ...source, inputReads: first }).unwrap();
  firstResources.seal().unwrap();
  f.pool._closeInputReads();
  const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  initial.view.addPasses(builder).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const task = inputs.prepareBuffer().unwrap();
  const binding = initial.view.prepareInputBindings(f.scene, task).unwrap();
  const creates = vi.spyOn(device, 'createBindGroup');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  let nextResources: GpuSceneResourceFrame | undefined;
  const extent = Math.max(
    ...Array.from(initial.plan.batches, (batch) => batch.indirectOffset + 20),
  );
  const readback = device.createBuffer({ size: extent, usage: 1 | 8 }).unwrap();
  const execute = async () => {
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder }).unwrap();
    const indirect = initial.view.indirectBuffer;
    if (indirect === undefined) throw new Error('Missing actual indirect target');
    encoder.copyBufferToBuffer(indirect, 0, readback, 0, extent);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    try {
      const view = new DataView(mapped.getMappedRange().unwrap());
      let instances = 0;
      for (const batch of initial.plan.batches)
        instances += view.getUint32(batch.indirectOffset + 4, true);
      expect(instances).toBe(initial.plan.candidateCount);
      expect(instances).toBeGreaterThan(0);
    } finally {
      mapped.unmap();
    }
  };
  let primaryFailure: unknown;
  let failed = false;
  const failures: unknown[] = [];
  try {
    let oldExecutions = 0;
    for (let step = 0; step < 1000; step++) {
      if (step % 4 === 0) {
        await execute();
        oldExecutions++;
      }
      if (task.step(64).unwrap().phase === 'current') break;
    }
    expect(oldExecutions).toBeGreaterThan(1);
    expect(binding.isCurrent()).toBe(true);
    const graphGeneration = initial.view.graphResourceGeneration;
    creates.mockClear();
    writes.mockClear();
    task.commitPrepared().unwrap();
    binding.publish().unwrap();
    expect(creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(graph.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(false);
    nextResources = f.scene.captureResources().unwrap();
    const next = nextResources.inputReads();
    initial.view.observeInputReads(f.scene, next).unwrap();
    nextResources.seal().unwrap();
    expect(inputs.readHoldsBuffer(next, task.buffer)).toBe(true);
    await execute();
    expect(initial.view.graphResourceGeneration).toBe(graphGeneration);
    expect(creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(await native.popErrorScope()).toBeNull();
  } catch (cause) {
    primaryFailure = cause;
    failed = true;
  } finally {
    const attempt = async (action: () => unknown | Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        failures.push(cause);
      }
    };
    await attempt(async () => (await graph.retire()).unwrap());
    await attempt(() => binding.release());
    await attempt(() => task.release());
    await attempt(() => firstResources.release());
    await attempt(() => nextResources?.release());
    await attempt(() => f.dispose());
    await attempt(() => device.queue.onSubmittedWorkDone());
    creates.mockRestore();
    writes.mockRestore();
    await attempt(() => device.destroyBuffer(readback).unwrap());
    await attempt(() => native.destroy());
  }
  if (failures.length > 0)
    throw new AggregateError(
      failed ? [primaryFailure, ...failures] : failures,
      'native View preparation cleanup failed',
    );
  if (failed) throw primaryFailure;
}, 30000);

it.each([
  'publish',
  'cancel',
  'dispose',
] as const)('owns the native cached cull and Skin bindings through %s', async (mode) => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const skin = skinTaskFixture();
  const created = GpuScene.create(device, 4, undefined, skin.arena).unwrap();
  if (created.status !== 'available') throw new Error('Storage required');
  const scene = created.scene;
  scene.inputs.activate();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const plan = skinInputBindingPlan(skin.scene, scene);
  expect(plan.candidateCount).toBe(2);
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const first = scene.inputs.capture();
  view
    .update(
      plan,
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
  first.seal().unwrap();
  const inactive = scene.inputs.capture();
  view.update(plan, scene, inactive, planes).unwrap();
  inactive.seal().unwrap();
  const task = scene.inputs.prepareBuffer().unwrap();
  const original = device.createBindGroup.bind(device);
  const creates = vi.spyOn(device, 'createBindGroup').mockImplementation((descriptor) => {
    const result = original(descriptor);
    if (mode === 'cancel') task.release();
    if (mode === 'dispose') scene.inputs.dispose();
    return result;
  });
  try {
    const prepared = view.prepareInputBindings(scene, task);
    expect(creates.mock.calls.map(([descriptor]) => descriptor.label)).toEqual(
      mode === 'publish'
        ? ['gpu-driven-view-bg', 'gpu-driven-view-skin-bg', 'gpu-driven-view-skin-finalize-bg']
        : ['gpu-driven-view-bg'],
    );
    if (mode === 'publish') {
      const binding = prepared.unwrap();
      for (let step = 0; step < 1000; step++) if (task.step(64).unwrap().phase === 'current') break;
      expect(binding.isCurrent()).toBe(true);
      task.commitPrepared().unwrap();
      binding.publish().unwrap();
      binding.release();
      creates.mockClear();
      const active = scene.inputs.capture();
      view
        .update(
          plan,
          scene,
          active,
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
      active.seal().unwrap();
      expect(creates).not.toHaveBeenCalled();
      active.release();
    } else expect(prepared.ok).toBe(false);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    creates.mockRestore();
    task.release();
    first.release();
    inactive.release();
    view.dispose();
    scene.dispose();
    skin.dispose();
    await device.queue.onSubmittedWorkDone();
    native.destroy();
  }
}, 30000);
