import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { assert, expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { type GpuSceneInputPreparation, GpuSceneInputs } from '../gpu-scene-inputs';
import { nativeDeviceFixture } from './native-device-fixture';

async function readBuffer(device: RhiDevice, source: Buffer, offset: number, length: number) {
  const target = device.createBuffer({ size: length, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, offset, target, 0, length);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await target.mapAsync(1)).unwrap();
    try {
      return new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
    } finally {
      mapping.unmap();
    }
  } finally {
    device.destroyBuffer(target).unwrap();
  }
}

it.each([
  'cancel',
  'commit',
] as const)('uploads exact private descriptor and resource-tree addresses before %s', async (mode) => {
  const f = await nativeDeviceFixture();
  const inputs = new GpuSceneInputs(f.device, (slot) => slot);
  const active = inputs.arena.allocateDescriptor(4);
  inputs.arena.writeDescriptorWord(active, 4, 0, 17);
  const accepted = inputs.allocateResource(active);
  const held = inputs.capture();
  const before = held.buffer().unwrap();
  held.seal().unwrap();
  const extent = inputs.arena.byteLength;
  const descriptor = inputs.arena.reserveDescriptor(6, (_address, words) => {
    words.setUint32(0, 0x12345678, true);
    words.setUint32(20, 0x87654321, true);
  });
  const mapping = inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  let committed = false;
  const create = vi.spyOn(f.device, 'createBuffer');
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  const destroy = vi.spyOn(f.device, 'destroyBuffer');
  const fence = vi.spyOn(f.device.queue, 'onSubmittedWorkDone');
  f.native.pushErrorScope('validation');
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* bounded tree paths */
    }
    assert(task);
    for (let step = 0; step < 1000; step++) {
      inputs.arena.writeDescriptorWord(active, 4, 0, step + 100);
      const frame = inputs.capture();
      expect(frame.buffer().unwrap()).toMatchObject(before);
      expect(frame.resource(mapping.logicalSlot)).toBeUndefined();
      frame.seal().unwrap();
      frame.release();
      if (task.step(64).unwrap().phase === 'current') break;
    }
    expect(task.isCurrent()).toBe(true);
    expect(task.privatePageBytes).toBe(4 * 1024);
    expect(inputs.arena.byteLength).toBe(extent);
    const words = new Uint32Array(
      (await readBuffer(f.device, task.buffer, 0, task.byteLength)).buffer,
    );
    const candidate = task;
    const lookup = (slot: number) => {
      let root: number = candidate.resourceRoot;
      for (const shift of [24, 16, 8]) {
        const page = words[root + ((slot >>> shift) & 255)];
        assert(page !== undefined && page !== 0xffffffff);
        root = page;
      }
      return words[root + (slot & 255)];
    };
    expect(lookup(accepted)).toBe(active);
    expect(lookup(mapping.logicalSlot)).toBe(descriptor.address);
    expect(words[descriptor.address]).toBe(0x12345678);
    expect(words[descriptor.address + 5]).toBe(0x87654321);
    expect(words[active]).toBe(inputs.arena.readWord(active));
    expect(
      new Uint32Array((await readBuffer(f.device, before.buffer, active * 4, 4)).buffer)[0],
    ).toBe(words[active]);
    if (mode === 'commit') {
      create.mockClear();
      write.mockClear();
      destroy.mockClear();
      fence.mockClear();
      task.commitPrepared().unwrap();
      committed = true;
      const current = inputs.capture();
      expect(current.resource(mapping.logicalSlot)).toBe(descriptor.address);
      expect(current.resource(accepted)).toBe(active);
      expect(current.buffer().unwrap()).toMatchObject({
        buffer: task.buffer,
        resourceRoot: task.resourceRoot,
      });
      current.seal().unwrap();
      current.release();
      expect(inputs.arena.readWord(descriptor.address)).toBe(0x12345678);
      expect(mapping.isCurrent()).toBe(false);
      expect(descriptor.isCurrent()).toBe(false);
      expect(inputs.readHoldsBuffer(held, before.buffer, before.resourceRoot)).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(fence).not.toHaveBeenCalled();
      const acceptedBytes = await readBuffer(f.device, task.buffer, 0, task.byteLength);
      expect(equalBytes(acceptedBytes, new Uint8Array(words.buffer))).toBe(true);
    }
    task.release();
    await f.device.queue.onSubmittedWorkDone();
    for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    work.return(undefined as never);
    task?.release();
    held.release();
    await f.device.queue.onSubmittedWorkDone();
    create.mockRestore();
    write.mockRestore();
    destroy.mockRestore();
    fence.mockRestore();
    if (committed) {
      inputs.releaseResource(mapping.logicalSlot);
      inputs.arena.releaseDescriptor(descriptor.address, descriptor.wordCount);
    } else {
      mapping.release();
      descriptor.release();
    }
    inputs.dispose();
    await f.device.queue.onSubmittedWorkDone();
    f.native.destroy();
  }
}, 30000);

it('prepares and publishes actual Inputs while old native reads remain held', async () => {
  const f = await nativeDeviceFixture();
  const inputs = new GpuSceneInputs(f.device, (slot) => slot);
  const address = inputs.arena.allocateDescriptor(4);
  const held = inputs.capture();
  const previous = held.buffer().unwrap();
  held.seal().unwrap();
  const task = inputs.prepareBuffer().unwrap();
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  const destroy = vi.spyOn(f.device, 'destroyBuffer');
  const fence = vi.spyOn(f.device.queue, 'onSubmittedWorkDone');
  f.native.pushErrorScope('validation');
  try {
    for (let step = 0; step < 100; step++) {
      inputs.arena.writeDescriptorWord(address, 4, 0, step + 100);
      const frame = inputs.capture();
      expect(frame.buffer().unwrap().buffer).toBe(previous.buffer);
      frame.seal().unwrap();
      frame.release();
      expect(
        new Uint32Array((await readBuffer(f.device, previous.buffer, address * 4, 4)).buffer)[0],
      ).toBe(step + 100);
      if (task.step(64).unwrap().phase === 'current') break;
    }
    expect(task.isCurrent()).toBe(true);
    const expected = Uint32Array.from({ length: inputs.arena.byteLength / 4 }, (_, index) =>
      inputs.arena.readWord(index),
    );
    expect(
      equalBytes(
        await readBuffer(f.device, task.buffer, 0, expected.byteLength),
        new Uint8Array(expected.buffer),
      ),
    ).toBe(true);
    for (const call of writes.mock.calls.filter((call) => call[0] === task.buffer))
      expect(call[4]).toBeLessThanOrEqual(64);
    const total = inputs.uploadBytes;
    writes.mockClear();
    destroy.mockClear();
    fence.mockClear();
    task.commitPrepared().unwrap();
    expect(writes).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
    expect(inputs.uploadBytes).toBe(total);
    const next = inputs.capture();
    expect(next.buffer().unwrap().buffer).toBe(task.buffer);
    next.seal().unwrap();
    next.release();
    expect(writes).not.toHaveBeenCalled();
    expect(inputs.readHoldsBuffer(held, previous.buffer, previous.resourceRoot)).toBe(true);
    await f.device.queue.onSubmittedWorkDone();
    expect(destroy.mock.calls.filter(([buffer]) => buffer === previous.buffer)).toHaveLength(0);
    expect(
      equalBytes(
        await readBuffer(f.device, previous.buffer, 0, expected.byteLength),
        new Uint8Array(expected.buffer),
      ),
    ).toBe(true);
    held.release();
    await f.device.queue.onSubmittedWorkDone();
    expect(destroy.mock.calls.filter(([buffer]) => buffer === previous.buffer)).toHaveLength(1);
    inputs.arena.writeDescriptorWord(address, 4, 0, 999);
    const changed = inputs.capture();
    changed.buffer().unwrap();
    changed.seal().unwrap();
    changed.release();
    expect(
      writes.mock.calls.filter((call) => call[0] === task.buffer).map((call) => call[4]),
    ).toEqual([16]);
    expect(
      new Uint32Array((await readBuffer(f.device, task.buffer, address * 4, 4)).buffer)[0],
    ).toBe(999);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    task.release();
    held.release();
    inputs.dispose();
    await f.device.queue.onSubmittedWorkDone();
    writes.mockRestore();
    destroy.mockRestore();
    fence.mockRestore();
    f.native.destroy();
  }
}, 30000);

it.each([
  'release',
  'dispose',
] as const)('retires the actual native candidate once after reentrant %s without another frame', async (mode) => {
  const f = await nativeDeviceFixture();
  const inputs = new GpuSceneInputs(f.device, (slot) => slot);
  const address = inputs.arena.allocateDescriptor(4);
  const held = inputs.capture();
  const previous = held.buffer().unwrap();
  held.seal().unwrap();
  const task = inputs.prepareBuffer().unwrap();
  const total = inputs.uploadBytes;
  const destroy = vi.spyOn(f.device, 'destroyBuffer');
  const fence = vi.spyOn(f.device.queue, 'onSubmittedWorkDone');
  const original = f.device.queue.writeBuffer.bind(f.device.queue);
  const write = vi.spyOn(f.device.queue, 'writeBuffer').mockImplementationOnce((...args) => {
    const result = original(...args);
    if (mode === 'release') task.release();
    else inputs.dispose();
    expect(fence).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    return result;
  });
  f.native.pushErrorScope('validation');
  try {
    expect(task.step(64).ok).toBe(false);
    expect(task.isCurrent()).toBe(false);
    expect(inputs.uploadBytes - total).toBe(64);
    await f.device.queue.onSubmittedWorkDone();
    expect(destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(1);
    expect(destroy.mock.calls.filter(([buffer]) => buffer === previous.buffer)).toHaveLength(0);
    if (mode === 'release') {
      inputs.arena.writeDescriptorWord(address, 4, 0, 71);
      const frame = inputs.capture();
      frame.buffer().unwrap();
      frame.seal().unwrap();
      frame.release();
      expect(
        new Uint32Array((await readBuffer(f.device, previous.buffer, address * 4, 4)).buffer)[0],
      ).toBe(71);
    }
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    task.release();
    held.release();
    inputs.dispose();
    await f.device.queue.onSubmittedWorkDone();
    write.mockRestore();
    destroy.mockRestore();
    fence.mockRestore();
    f.native.destroy();
  }
}, 30000);
