import type { EntityHandle } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { ANTIALIAS_MSAA, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GPU_MATERIAL_DESCRIPTOR, type GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { ViewRecorder } from '../world/render-views';
import type { ViewRecorderState } from '../world/view-output-systems';
import { recordContext } from '../world/view-record-context';
import {
  finishRendererInput as finishInput,
  rendererInputHandoffFixture as fixture,
} from './renderer-input-handoff-fixture';
import { collectWeakOwners } from './weak-owner-collection-fixture';

it('hands a new logical resource root to actual Renderer consumers with same-version material custody', async () => {
  const f = await fixture();
  const material = f.internals.sceneComposition?.entry?.projection.slotsSnapshot().at(0)
    ?.snapshot.material;
  assert(material);
  const frame = f.scene.captureResources().unwrap();
  const original = frame.indexForResource(material, material.snapshot);
  assert(original !== undefined);
  frame.seal().unwrap();
  const held = f.scene.holdMaterialRoots(frame).unwrap();
  frame.release();
  const descriptor = f.scene.inputs.arena.reserveDescriptor(
    GPU_MATERIAL_DESCRIPTOR.words,
    (_address, target) => {
      for (let word = 0; word < GPU_MATERIAL_DESCRIPTOR.words; word++)
        target.setUint32(word * 4, f.scene.inputs.arena.readWord(original + word), true);
    },
  );
  const mapping = f.scene.inputs.reserveResource(descriptor);
  let input: GpuSceneInputPreparation | undefined;
  const work = f.scene.inputs.prepareResourceBuffer(
    [mapping],
    () => f.scene.live && held.isCurrent(),
    (value) => {
      input = value;
    },
  );
  let committed = false;
  const groups = vi.spyOn(f.internals.device, 'createBindGroup');
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* closed data root */
    }
    assert(input);
    finishInput(input);
    const handoff = f.manager.prepareInputBindings(f.scene, input).unwrap();
    try {
      expect((await f.draw()).presentation).toBe('ready');
      finishInput(input);
      expect(handoff.isCurrent()).toBe(true);
      groups.mockClear();
      writes.mockClear();
      handoff.publish().unwrap();
      committed = true;
      expect(groups).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(held.isCurrent()).toBe(true);
      expect(f.scene.inputs.resourceIsCurrent(mapping.logicalSlot, descriptor.address)).toBe(true);
      for (const view of f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene))
        expect(view.sceneInputBuffer).toBe(input.buffer);
      expect((await f.draw()).presentation).toBe('ready');
      expect(groups).not.toHaveBeenCalled();
    } finally {
      handoff.release();
    }
  } finally {
    work.return(undefined as never);
    input?.release();
    await f.internals.device.queue.onSubmittedWorkDone();
    groups.mockRestore();
    writes.mockRestore();
    if (committed) {
      f.scene.inputs.releaseResource(mapping.logicalSlot);
      f.scene.inputs.arena.releaseDescriptor(descriptor.address, descriptor.wordCount);
    } else {
      mapping.release();
      descriptor.release();
    }
    held.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('includes the recoverable primary while composed views record and publishes their Inputs together', async () => {
  const f = await fixture();
  const primary = f.manager.currentOwner;
  let input: GpuSceneInputPreparation | undefined;
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepareInputBindings');
  const groups = vi.spyOn(f.internals.device, 'createBindGroup');
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
  try {
    f.world.addComponent(f.camera, { component: CameraView, data: {} }).unwrap();
    await f.draw();
    const composed = f.manager.currentOwner;
    expect(composed).not.toBe(primary);
    const inspected = primary.gpuDriven.inspect();
    expect(
      primary.gpuDriven.inputBindingViews(f.scene).length,
      JSON.stringify({
        channels: inspected.channels,
        gpu: inspected.gpuOwnedEntityCount,
        cpu: inspected.cpuFallbackDrawItems,
      }),
    ).toBeGreaterThan(0);
    input = f.scene.inputs.prepareBuffer().unwrap();
    finishInput(input);
    const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
    expect(prepare.mock.contexts).toContain(primary.gpuDriven);
    expect(prepare.mock.contexts).toContain(composed.gpuDriven);
    expect(task.isCurrent()).toBe(true);
    await f.draw();
    expect(task.isCurrent()).toBe(true);
    groups.mockClear();
    writes.mockClear();
    task.publish().unwrap();
    expect(groups).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(true);
    for (const owner of [primary, composed])
      for (const view of owner.gpuDriven.inputBindingViews(f.scene))
        expect(view.sceneInputBuffer).toBe(input.buffer);
    expect(task.isCurrent()).toBe(false);
    f.world.removeComponent(f.camera, CameraView).unwrap();
    await f.draw();
    expect(f.manager.currentOwner).toBe(primary);
  } finally {
    prepare.mockRestore();
    groups.mockRestore();
    writes.mockRestore();
    input?.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('does not cold-create a dormant primary that never consumed this Inputs', async () => {
  const f = await fixture({ composed: true });
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepareInputBindings');
  try {
    const composed = f.manager.currentOwner;
    const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
    expect(prepare.mock.contexts).toEqual([composed.gpuDriven]);
    task.publish().unwrap();
    expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(true);
    f.world.removeComponent(f.camera, CameraView).unwrap();
    await f.draw();
    expect(f.manager.currentOwner).not.toBe(composed);
    for (const view of f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene))
      expect(view.sceneInputBuffer).toBe(input.buffer);
  } finally {
    prepare.mockRestore();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('rejects actual device scope retirement before consuming Inputs', async () => {
  const f = await fixture();
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
  try {
    recordContext(f.manager.currentOwner.internals).deviceScope.beginRetire();
    expect(input.isCurrent()).toBe(true);
    expect(task.isCurrent()).toBe(false);
    expect(task.publish().ok).toBe(false);
    expect(input.inspect().phase).toBe('current');
  } finally {
    task.release();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('includes an actual RenderTarget camera alongside the composed display owner', async () => {
  const f = await fixture({ composed: true });
  const created = f.renderer.createRenderTarget({
    shape: '2d',
    width: 16,
    height: 16,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: false,
  });
  assert(created.ok);
  let input: GpuSceneInputPreparation | undefined;
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepareInputBindings');
  try {
    f.world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            ...f.world.get(f.camera, Camera).unwrap(),
            target: f.world.allocSharedRef('RenderTarget', created.value),
          },
        },
      )
      .unwrap();
    await f.draw();
    const world = f.internals.renderWorld;
    assert(world);
    const captureOwners = [];
    for (const span of world
      .query({ with: [ViewRecorder] })
      .unwrap()
      .spans()
      .unwrap())
      for (const entity of span.entities) {
        const state = world
          .resolveUniqueRef<ViewRecorderState>(
            world.get(entity as EntityHandle, ViewRecorder).unwrap().state,
          )
          .unwrap();
        if (state.capture !== undefined && !state.retired) captureOwners.push(state.owner);
      }
    expect(captureOwners).toHaveLength(1);
    const capture = captureOwners[0];
    assert(capture);
    expect(capture.gpuDriven.inputBindingViews(f.scene).length).toBeGreaterThan(0);
    input = f.scene.inputs.prepareBuffer().unwrap();
    finishInput(input);
    const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
    expect(prepare.mock.contexts).toContain(capture.gpuDriven);
    expect(prepare.mock.contexts).toContain(f.manager.currentOwner.gpuDriven);
    task.publish().unwrap();
    for (const owner of [...captureOwners, f.manager.currentOwner])
      for (const view of owner.gpuDriven.inputBindingViews(f.scene))
        expect(view.sceneInputBuffer).toBe(input.buffer);
  } finally {
    prepare.mockRestore();
    input?.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it.each([
  'publish',
  'release',
] as const)('drops actual CameraViews and Scene after %s with the closed handoff held', async (operation) => {
  const held = await (async () => {
    const f = await fixture();
    const input = f.scene.inputs.prepareBuffer().unwrap();
    finishInput(input);
    const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
    const manager = new WeakRef(f.manager),
      scene = new WeakRef(f.scene);
    if (operation === 'publish') task.publish().unwrap();
    else task.release();
    input.release();
    expect((await f.close()).ok).toBe(true);
    return { task, manager, scene };
  })();
  await collectWeakOwners();
  expect(held.manager.deref() === undefined).toBe(true);
  expect(held.scene.deref() === undefined).toBe(true);
  expect(held.task.isCurrent()).toBe(false);
});

it('rejects a failed actual Scene even when it has no GPU View consumer and Inputs remain live', async () => {
  const f = await fixture({ material: false });
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
  try {
    expect(f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)).toHaveLength(0);
    const entry = f.internals.sceneComposition?.entry;
    assert(entry);
    const slot = [...entry.projection.slotsSnapshot()][0];
    assert(slot);
    const world = new Float32Array(slot.snapshot.transform.world);
    world[12] = (world[12] ?? 0) + 1;
    const delta = entry.projection.apply([
      {
        kind: 'update',
        entityKey: slot.entityKey,
        snapshot: {
          ...slot.snapshot,
          transform: { ...slot.snapshot.transform, world },
        },
      },
    ]);
    const cause = new Error('injected Scene bounds publication failure');
    expect(
      f.scene.sync(delta, undefined, () => {
        throw cause;
      }).ok,
    ).toBe(false);
    expect(f.scene.live).toBe(false);
    expect(f.internals.sceneComposition?.gpuSceneResident).toBe(f.scene);
    expect(input.isCurrent()).toBe(true);
    expect(task.isCurrent()).toBe(false);
    expect(task.publish().ok).toBe(false);
    expect(input.inspect().phase).toBe('current');
    expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(false);
  } finally {
    task.release();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('publishes prepared Camera inputs across replacement of display-only attachments', async () => {
  const f = await fixture();
  const state = f.manager.currentOwner.frameState;
  const previous = state.compiledFrameGraph;
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const handoff = f.manager.prepareInputBindings(f.scene, input).unwrap();
  try {
    f.world.set(f.camera, Camera, { antialias: ANTIALIAS_MSAA }).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    expect(state.compiledFrameGraph).not.toBe(previous);
    finishInput(input);
    expect(handoff.isCurrent()).toBe(true);
    handoff.publish().unwrap();
    expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(true);
    for (const view of f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene))
      expect(view.sceneInputBuffer).toBe(input.buffer);
  } finally {
    handoff.release();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('rejects a changed actual camera roster before committing the numeric buffer', async () => {
  const f = await fixture();
  let input: GpuSceneInputPreparation | undefined;
  try {
    input = f.scene.inputs.prepareBuffer().unwrap();
    finishInput(input);
    const task = f.manager.prepareInputBindings(f.scene, input).unwrap();
    f.world.addComponent(f.camera, { component: CameraView, data: {} }).unwrap();
    await f.draw();
    finishInput(input);
    expect(input.isCurrent()).toBe(true);
    expect(task.isCurrent()).toBe(false);
    expect(task.publish().ok).toBe(false);
    expect(input.inspect().phase).toBe('current');
    expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(false);
    task.release();
    expect(f.manager.prepareInputBindings(f.scene, input).unwrap().isCurrent()).toBe(true);
  } finally {
    input?.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('stops an actual Renderer handoff at the first native callback when reset cancels construction', async () => {
  const f = await fixture();
  let input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const original = f.internals.device.createBindGroup.bind(f.internals.device);
  let reset = false;
  const creates = vi
    .spyOn(f.internals.device, 'createBindGroup')
    .mockImplementation((descriptor) => {
      const result = original(descriptor);
      if (!reset) {
        reset = true;
        f.manager.reset();
      }
      return result;
    });
  try {
    expect(f.manager.prepareInputBindings(f.scene, input).ok).toBe(false);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(input.inspect().phase).toBe('current');
    creates.mockRestore();
    input.release();
    await f.draw();
    input = f.scene.inputs.prepareBuffer().unwrap();
    finishInput(input);
    const retry = f.manager.prepareInputBindings(f.scene, input).unwrap();
    expect(retry.isCurrent()).toBe(true);
    retry.release();
  } finally {
    creates.mockRestore();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('rejects physical Skin task changes during native binding construction without consuming Inputs', async () => {
  const f = await fixture();
  const views = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene);
  const view = views[0];
  assert(view);
  const skin = vi.spyOn(view, 'skinTaskBinding');
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInput(input);
  const createNative = f.internals.device.createBindGroup.bind(f.internals.device);
  const create = vi
    .spyOn(f.internals.device, 'createBindGroup')
    .mockImplementation((descriptor) => {
      skin.mockReturnValue({
        data: f.scene.transformBuffer,
        auxiliary: f.scene.instanceBuffer,
        dataOffset: 0,
        auxiliaryOffset: 0,
        dataSize: 64,
        auxiliarySize: 64,
      });
      return createNative(descriptor);
    });
  try {
    expect(f.manager.prepareInputBindings(f.scene, input).ok).toBe(false);
    expect(create).toHaveBeenCalled();
    expect(input.inspect().phase).toBe('current');
    create.mockRestore();
    skin.mockRestore();
    const retry = f.manager.prepareInputBindings(f.scene, input).unwrap();
    expect(retry.isCurrent()).toBe(true);
    retry.release();
  } finally {
    create.mockRestore();
    skin.mockRestore();
    input.release();
    expect((await f.close()).ok).toBe(true);
  }
});
