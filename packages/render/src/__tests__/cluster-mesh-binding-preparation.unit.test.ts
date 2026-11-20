import { assert, expect, it, vi } from 'vitest';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import { createHdrpUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import {
  prepareClusterMeshBindings,
  rememberClusterMeshBinding,
} from '../record/cluster-mesh-binding-preparation';
import { bindGroupByteRangeLeaf4 } from '../record/mesh-ssbo';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';
import { collectWeakOwners } from './weak-owner-collection-fixture';

it('does not restore owner references after native creation releases an actual clustered cohort', async () => {
  const held = await (async () => {
    const f = await rendererInputHandoffFixture();
    const owner = f.manager.currentOwner;
    const runtime = owner.internals;
    const hdrp = getOrCreateHdrpBuffers(runtime);
    assert(hdrp);
    const cache = owner.frameState.meshBindGroupCache;
    const lightingKey = {};
    const leaf = bindGroupByteRangeLeaf4(
      cache,
      f.scene.transformBuffer,
      hdrp.unifiedBindGroupLayout,
      hdrp,
      lightingKey,
    );
    const old = createHdrpUnifiedBindGroup(
      runtime,
      hdrp,
      f.scene.transformBuffer,
      { enabled: false },
      f.scene.transformByteLength,
      (group, descriptor) =>
        rememberClusterMeshBinding(cache, group, {
          runtime,
          hdrp,
          lightingKey,
          descriptor,
          leaf,
          key: f.scene.transformByteLength,
        }),
    );
    assert(old);
    leaf.set(f.scene.transformByteLength, old);
    const row = [...(f.internals.sceneComposition?.entry?.projection.slotsSnapshot() ?? [])][0]
      ?.snapshot;
    assert(row);
    let capacity: GpuSceneCapacityPreparation | undefined;
    const work = f.scene.prepareSourceCapacity(
      Array.from({ length: f.scene.rowCapacity + 4 }, () => row),
      (task) => {
        capacity = task;
      },
      () => true,
    );
    let next = work.next();
    for (let count = 0; !next.done && count < 10000; count++) next = work.next();
    assert(next.done && capacity);
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    const task = prepareClusterMeshBindings(runtime, cache, target, () => true);
    const create = runtime.device.createBindGroup.bind(runtime.device);
    let released = false;
    const native = vi
      .spyOn(runtime.device, 'createBindGroup')
      .mockImplementationOnce((descriptor) => {
        const group = create(descriptor);
        task.release();
        released = true;
        return group;
      });
    try {
      expect(task.replacement(old).ok).toBe(false);
      expect(native).toHaveBeenCalledOnce();
      expect(task.isCurrent()).toBe(false);
    } finally {
      native.mockRestore();
      if (!released) task.release();
      work.return(undefined as never);
      await runtime.device.queue.onSubmittedWorkDone();
      for (let count = 0; !capacity.retireStep() && count < 100; count++) {
        /* bounded private retirement */
      }
      expect((await f.close()).ok).toBe(true);
    }
    return { task, owner: new WeakRef(runtime) };
  })();
  try {
    await collectWeakOwners();
    expect(held.owner.deref()).toBeUndefined();
    expect(held.task.isCurrent()).toBe(false);
  } finally {
    held.task.release();
  }
});
