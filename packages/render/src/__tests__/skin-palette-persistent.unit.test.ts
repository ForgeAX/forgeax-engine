import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createSkinPaletteOwner } from '../assembly/skin-palette-owner';

const bounds = new Float32Array([-1, -2, -3, 1, 2, 3]);

describe('persistent skin palette owner', () => {
  it('advances content revision only after a GPU palette write', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const receipt = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 1,
    });
    const initial = allocator.contentRevision;
    allocator.writePersistentJointPalette(receipt, [mat4.create()], [mat4.create()]);
    expect(allocator.contentRevision).toBe(initial + 1);
    allocator.beginFrame();
    const stable = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 1,
    });
    allocator.writePersistentJointPalette(stable, [mat4.create()], [mat4.create()]);
    expect(allocator.contentRevision).toBe(initial + 1);
    allocator.dispose();
  });

  it('keeps a stable range for an unchanged skeleton and reports zero upload', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const first = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 7,
      jointCount: 2,
      bounds,
    });
    allocator.beginFrame();
    const stable = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 7,
      jointCount: 2,
      bounds,
    });
    expect(stable.byteOffset).toBe(first.byteOffset);
    expect(stable.generation).toBe(7);
    expect(stable.uploadBytes).toBe(0);
    expect(stable.bounds).toEqual(bounds);
  });

  it('merges dirty joints into aligned ranges and retires stale generations', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const first = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 8,
      bounds,
    });
    allocator.markDirtyJoints('hero', [1, 2, 5]);
    allocator.beginFrame();
    const changed = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 2,
      jointCount: 8,
      bounds,
    });
    expect(changed.byteOffset).not.toBe(first.byteOffset);
    expect(changed.retiredByteOffset).toBe(first.byteOffset);
    // A replacement generation owns a fresh address. It must upload every
    // joint even when the producer pose is unchanged; carrying only the old
    // dirty set would publish an uninitialized palette slice.
    expect(changed.dirtyRanges).toEqual([{ startJoint: 0, jointCount: 8 }]);
    expect(changed.uploadBytes).toBe(8 * 16 * 4);
  });

  it('observes a changed pose and uploads only its merged dirty joint range', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const ibms = [
      mat4.identity(mat4.create()),
      mat4.identity(mat4.create()),
      mat4.identity(mat4.create()),
    ];
    const pose = ibms.map(() => mat4.identity(mat4.create()));

    allocator.observePersistentJoints('hero', ibms, pose);
    allocator.allocatePersistentSlice({ identity: 'hero', generation: 1, jointCount: 3, bounds });
    allocator.beginFrame();
    allocator.observePersistentJoints('hero', ibms, pose);
    const stable = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 3,
      bounds,
    });
    expect(stable.dirtyRanges).toEqual([]);
    expect(stable.uploadBytes).toBe(0);

    const changedPose = pose.map((matrix) => mat4.clone(matrix));
    changedPose[1]?.set([1, 0, 0, 0.25], 12);
    changedPose[2]?.set([1, 0, 0, 0.5], 12);
    allocator.observePersistentJoints('hero', ibms, changedPose);
    const changed = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 3,
      bounds,
    });
    expect(changed.dirtyRanges).toEqual([{ startJoint: 1, jointCount: 2 }]);
    expect(changed.uploadBytes).toBe(2 * 16 * 4);
  });

  it('uploads an unchanged pose when a skeleton generation is replaced', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 2,
      bounds,
    });
    allocator.beginFrame();
    const replacement = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 2,
      jointCount: 2,
      bounds,
    });
    expect(replacement.dirtyRanges).toEqual([{ startJoint: 0, jointCount: 2 }]);
    expect(replacement.uploadBytes).toBe(2 * 16 * 4);
  });

  it('recycles a retired storage range only after the queue fence', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const first = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 2,
    });
    allocator.beginFrame();
    const replacement = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 2,
      jointCount: 2,
    });
    expect(replacement.byteOffset).not.toBe(first.byteOffset);
    allocator.beginFrame();
    const beforeFence = allocator.allocatePersistentSlice({
      identity: 'other',
      generation: 1,
      jointCount: 2,
    });
    expect(beforeFence.byteOffset).not.toBe(first.byteOffset);
    await device.queue.onSubmittedWorkDone();
    allocator.beginFrame();
    const afterFence = allocator.allocatePersistentSlice({
      identity: 'third',
      generation: 1,
      jointCount: 2,
    });
    expect(afterFence.byteOffset).toBe(first.byteOffset);
  });

  it('releases a detached identity and makes its range recyclable', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const first = allocator.allocatePersistentSlice({
      identity: 'detached',
      generation: 1,
      jointCount: 2,
    });
    allocator.releasePersistentSlice('detached');
    await device.queue.onSubmittedWorkDone();
    allocator.beginFrame();
    const replacement = allocator.allocatePersistentSlice({
      identity: 'replacement',
      generation: 1,
      jointCount: 2,
    });
    expect(replacement.byteOffset).toBe(first.byteOffset);
    allocator.dispose();
    allocator.dispose();
  });

  it('uses the same receipt shape for uniform projection', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, false);
    const receipt = allocator.allocatePersistentSlice({
      identity: 'npc',
      generation: 3,
      jointCount: 1,
      bounds,
    });
    expect(receipt.byteOffset).toBe(0);
    expect(receipt.buffer).toBeDefined();
    expect(receipt.storageOrUniform).toBe('uniform');
    expect(receipt.customDataStart).toBe(0);
  });

  it('rebases earlier same-frame receipts when the storage arena grows', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const first = allocator.allocatePersistentSlice({
      identity: 'first',
      generation: 1,
      jointCount: 2,
    });
    const firstBufferBeforeGrow = first.buffer;
    const second = allocator.allocatePersistentSlice({
      identity: 'second',
      generation: 1,
      jointCount: 255,
    });
    expect(second.buffer).not.toBe(firstBufferBeforeGrow);
    expect(first.buffer).toBe(second.buffer);
    expect(first.byteOffset).toBe(0);
    expect(second.byteOffset).toBe(256);
  });

  it('retains the producer bounds instead of inventing an expanded AABB', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const receipt = allocator.allocatePersistentSlice({
      identity: 'hero',
      generation: 1,
      jointCount: 1,
      bounds,
    });
    expect(Array.from(receipt.bounds ?? [])).toEqual(Array.from(bounds));
    const identity = mat4.identity(mat4.create());
    expect(identity[0]).toBe(1);
  });
});
