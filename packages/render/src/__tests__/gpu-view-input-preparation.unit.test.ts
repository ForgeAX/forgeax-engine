import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type Buffer,
  err,
  ok,
  type RhiCommandEncoder,
  RhiError,
} from '@forgeax/engine-rhi';
import { RhiNullComputePassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, onTestFinished, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { skinInputBindingPlan, skinTaskFixture } from './skin-task-fixture';

function finish(task: GpuSceneInputPreparation): void {
  for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') return;
  throw new Error('Numeric preparation did not converge');
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const groups = new Map<BindGroup, Buffer>();
  const original = device.createBindGroup.bind(device);
  const creates = vi.spyOn(device, 'createBindGroup').mockImplementation((descriptor) => {
    const result = original(descriptor);
    const input = [...descriptor.entries].find((entry) => entry.binding === 3)?.resource;
    if (result.ok && input?.kind === 'buffer') groups.set(result.value, input.value.buffer);
    return result;
  });
  const f = uploadFixture(device, shader);
  f.update().unwrap();
  const reads: { release(): void }[] = [];
  const tasks: GpuSceneInputPreparation[] = [];
  const leases: { release(): void }[] = [];
  const graphs: { retire(): Promise<unknown> }[] = [];
  const begin = () => {
    const task = f.gpuScene.inputs.prepareBuffer().unwrap();
    tasks.push(task);
    return task;
  };
  const prepare = (task: GpuSceneInputPreparation) => {
    const result = f.view.prepareInputBindings(f.gpuScene, task).unwrap();
    leases.push(result);
    return result;
  };
  const graph = () => {
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    f.view.addPasses(builder).unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    graphs.push(compiled);
    return compiled;
  };
  onTestFinished(async () => {
    for (const graph of graphs) await graph.retire();
    for (const lease of leases) lease.release();
    for (const task of tasks) task.release();
    for (const read of reads) read.release();
    f.close();
    await device.queue.onSubmittedWorkDone();
    creates.mockRestore();
  });
  return { ...f, device, shader, groups, creates, begin, prepare, graph, reads };
}

it('prebuilds without changing old execution, then publishes with no native work or graph rebuild', async () => {
  const f = await fixture();
  const graph = f.graph();
  const old = f.view.sceneInputBuffer;
  const compute = vi.spyOn(RhiNullComputePassEncoder.prototype, 'setBindGroup');
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  const bufferCreates = vi.spyOn(f.device, 'createBuffer');
  const generation = f.view.currentResourceGeneration;
  const graphGeneration = f.view.graphResourceGeneration;
  try {
    const task = f.begin();
    const binding = f.prepare(task);
    expect(binding.isCurrent()).toBe(false);
    expect(f.view.sceneInputBuffer).toBe(old);
    expect(graph.execute({ encoder: f.device.createCommandEncoder().unwrap() }).ok).toBe(true);
    expect(
      new Set(compute.mock.calls.map((call) => f.groups.get(call[1])).filter(Boolean)),
    ).toEqual(new Set([old]));
    finish(task);
    expect(binding.isCurrent()).toBe(true);
    expect(binding.publish().ok).toBe(false);
    f.creates.mockClear();
    writes.mockClear();
    bufferCreates.mockClear();
    task.commitPrepared().unwrap();
    binding.publish().unwrap();
    expect(binding.publish().ok).toBe(false);
    expect(binding.isCurrent()).toBe(false);
    expect(f.creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(bufferCreates).not.toHaveBeenCalled();
    expect(f.view.currentResourceGeneration).toBe(generation);
    expect(f.view.graphResourceGeneration).toBe(graphGeneration);
    // Pointer publication never turns the previous read into a holder of the new buffer.
    expect(graph.execute({ encoder: f.device.createCommandEncoder().unwrap() }).ok).toBe(false);
    const frame = f.gpuScene.captureResources().unwrap();
    const next = frame.inputReads();
    f.reads.push(frame);
    f.view.observeInputReads(f.gpuScene, next).unwrap();
    frame.seal().unwrap();
    expect(f.gpuScene.inputs.readHoldsBuffer(next, task.buffer)).toBe(true);
    compute.mockClear();
    expect(graph.execute({ encoder: f.device.createCommandEncoder().unwrap() }).ok).toBe(true);
    expect(
      new Set(compute.mock.calls.map((call) => f.groups.get(call[1])).filter(Boolean)),
    ).toEqual(new Set([task.buffer]));
    expect(f.creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  } finally {
    compute.mockRestore();
    writes.mockRestore();
    bufferCreates.mockRestore();
  }
});

it('keeps prepared binding facts across ordinary same-storage frames and numeric edits', async () => {
  const f = await fixture();
  const task = f.begin();
  const binding = f.prepare(task);
  const before = f.creates.mock.calls.length;
  f.update().unwrap();
  expect(f.creates.mock.calls.length).toBe(before);
  finish(task);
  expect(binding.isCurrent()).toBe(true);
  task.commitPrepared().unwrap();
  binding.publish().unwrap();
});

it('refuses copied, proxied and foreign issuer targets before any native binding creation', async () => {
  const f = await fixture();
  const other = uploadFixture(f.device, f.shader);
  const foreign = other.gpuScene.inputs.prepareBuffer().unwrap();
  const task = f.begin();
  const fake = {
    ...task,
    isCurrent: () => {
      throw new Error('must not call foreign current');
    },
  };
  f.creates.mockClear();
  try {
    expect(f.view.prepareInputBindings(f.gpuScene, fake).ok).toBe(false);
    expect(f.view.prepareInputBindings(f.gpuScene, new Proxy(task, {})).ok).toBe(false);
    expect(f.view.prepareInputBindings(f.gpuScene, foreign).ok).toBe(false);
    expect(f.creates).not.toHaveBeenCalled();
    const binding = f.prepare(task);
    finish(task);
    expect(binding.isCurrent()).toBe(true);
  } finally {
    foreign.release();
    other.close();
  }
});

it.each([
  'cancel',
  'dispose',
  'create-failure',
  'throw',
] as const)('closes a private native binding factory after %s and preserves active bindings', async (mode) => {
  const f = await fixture();
  const old = f.view.sceneInputBuffer;
  const task = f.begin();
  const original = f.creates.getMockImplementation();
  if (original === undefined) throw new Error('Missing binding observer');
  const error = new RhiError({
    code: 'internal-error',
    expected: 'native bind group',
    hint: 'retry',
  });
  f.creates.mockImplementationOnce((descriptor) => {
    if (mode === 'create-failure') return err(error);
    if (mode === 'throw') throw error;
    const result = original(descriptor);
    if (mode === 'cancel') task.release();
    else f.view.dispose();
    return result;
  });
  if (mode === 'throw') expect(() => f.view.prepareInputBindings(f.gpuScene, task)).toThrow(error);
  else expect(f.view.prepareInputBindings(f.gpuScene, task).ok).toBe(false);
  if (mode !== 'dispose') {
    expect(f.view.sceneInputBuffer).toBe(old);
    if (mode === 'cancel') {
      const retry = f.begin();
      f.prepare(retry);
    } else f.prepare(task);
  }
});

it.each([
  'cancel',
  'view-dispose',
  'scene-dispose',
  'ordinary-rebind',
] as const)('rejects stale prepared publication after %s', async (mode) => {
  const f = await fixture();
  const task = f.begin();
  const binding = f.prepare(task);
  finish(task);
  if (mode === 'cancel') task.release();
  if (mode === 'view-dispose') f.view.dispose();
  if (mode === 'scene-dispose') f.gpuScene.dispose();
  if (mode === 'ordinary-rebind') {
    f.gpuScene.inputs.arena.allocateDescriptor(task.byteLength / 4);
    f.update().unwrap();
  }
  expect(binding.isCurrent()).toBe(false);
  expect(binding.publish().ok).toBe(false);
  binding.release();
  binding.release();
});

it('prepares cached inactive Skin and cull bindings and preserves them on failure', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(device, { code: 'structural Skin fixture' })
  ).unwrap();
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
  const reads = scene.inputs.capture();
  view
    .update(
      plan,
      scene,
      reads,
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
  reads.seal().unwrap();
  const inactive = scene.inputs.capture();
  view.update(plan, scene, inactive, planes).unwrap();
  inactive.seal().unwrap();
  const task = scene.inputs.prepareBuffer().unwrap();
  const original = device.createBindGroup.bind(device);
  const creates = vi.spyOn(device, 'createBindGroup');
  try {
    const binding = view.prepareInputBindings(scene, task).unwrap();
    expect(creates.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([
      'gpu-driven-view-bg',
      'gpu-driven-view-skin-bg',
      'gpu-driven-view-skin-finalize-bg',
    ]);
    for (const [descriptor] of creates.mock.calls) {
      const input = [...descriptor.entries].find((entry) => entry.binding === 3)?.resource;
      expect(input?.kind === 'buffer' ? input.value.buffer : undefined).toBe(task.buffer);
    }
    binding.release();
    const old = view.sceneInputBuffer;
    let attempts = 0;
    creates.mockImplementation((descriptor) =>
      ++attempts === 2
        ? err(new RhiError({ code: 'internal-error', expected: 'Skin group', hint: 'retry' }))
        : original(descriptor),
    );
    expect(view.prepareInputBindings(scene, task).ok).toBe(false);
    expect(view.sceneInputBuffer).toBe(old);
    creates.mockImplementation(original);
    const retry = view.prepareInputBindings(scene, task).unwrap();
    finish(task);
    task.commitPrepared().unwrap();
    retry.publish().unwrap();
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
    active.release();
    expect(creates).not.toHaveBeenCalled();
    retry.release();
  } finally {
    creates.mockRestore();
    task.release();
    reads.release();
    inactive.release();
    view.dispose();
    scene.dispose();
    skin.dispose();
  }
});

it('rejects an already failed Scene before native creation even when its real Inputs target stays live', async () => {
  const f = await fixture();
  const task = f.begin();
  const world = mat4.identity(mat4.create());
  world[12] = 7;
  const write = vi.spyOn(f.device.queue, 'writeBuffer').mockImplementationOnce(() => {
    throw new Error('injected native table failure');
  });
  try {
    const delta = f.projection.apply([{ kind: 'update', entityKey: 1, world }]);
    expect(f.gpuScene.sync(delta).ok).toBe(false);
    expect(f.gpuScene.live).toBe(false);
    expect(f.gpuScene.inputs.preparationTarget(task)).toBeDefined();
    f.creates.mockClear();
    expect(f.view.prepareInputBindings(f.gpuScene, task).ok).toBe(false);
    expect(f.creates).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});
