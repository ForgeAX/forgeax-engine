import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { GpuInputArena } from '../gpu-input-arena';
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
    device.destroyBuffer(target);
  }
}

it('prepares bounded native bytes while the active buffer continues receiving independent updates', async () => {
  const f = await nativeDeviceFixture(),
    arena = new GpuInputArena(65536);
  const active = arena.connect(),
    candidate = arena.connect();
  const a = f.device.createBuffer({ size: 65536, usage: 0x8c }).unwrap();
  const b = f.device.createBuffer({ size: 65536, usage: 0x8c }).unwrap();
  const address = arena.allocateDescriptor(4);
  active.activate();
  active.flush(f.device.queue, a, true).unwrap();
  const task = candidate.prepare(f.device.queue, b).unwrap();
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  f.native.pushErrorScope('validation');
  try {
    let current = false;
    for (let step = 0; step < 100; step++) {
      arena.writeDescriptorWord(address, 4, 0, step + 100);
      active.flush(f.device.queue, a, false).unwrap();
      expect(new Uint32Array((await readBuffer(f.device, a, address * 4, 4)).buffer)[0]).toBe(
        step + 100,
      );
      const before = writes.mock.calls.filter((call) => call[0] === b).length;
      const status = task.step(64).unwrap();
      expect(writes.mock.calls.filter((call) => call[0] === b).length - before).toBeLessThanOrEqual(
        1,
      );
      if (status.phase === 'current') {
        current = true;
        break;
      }
    }
    expect(current).toBe(true);
    for (const call of writes.mock.calls.filter((call) => call[0] === b))
      expect(call[4]).toBeLessThanOrEqual(64);
    const expected = new Uint32Array(
      Array.from({ length: arena.byteLength / 4 }, (_, index) => arena.readWord(index)),
    );
    expect(
      equalBytes(
        await readBuffer(f.device, b, 0, expected.byteLength),
        new Uint8Array(expected.buffer),
      ),
    ).toBe(true);
    writes.mockClear();
    task.commitPrepared().unwrap();
    candidate.flush(f.device.queue, b, false).unwrap();
    expect(writes).not.toHaveBeenCalled();
    arena.writeDescriptorWord(address, 4, 0, 999);
    candidate.flush(f.device.queue, b, false).unwrap();
    expect(new Uint32Array((await readBuffer(f.device, b, address * 4, 4)).buffer)[0]).toBe(999);
    expect(writes.mock.calls.map((call) => call[4])).toEqual([4]);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    task.release();
    candidate.release();
    active.release();
    arena.dispose();
    writes.mockRestore();
    f.device.destroyBuffer(a);
    f.device.destroyBuffer(b);
    f.native.destroy();
  }
}, 30000);

it('rejects a too-small native candidate without consuming active updates or claiming current data', async () => {
  const f = await nativeDeviceFixture(),
    arena = new GpuInputArena(65536);
  const active = arena.connect(),
    candidate = arena.connect();
  const a = f.device.createBuffer({ size: 65536, usage: 0x8c }).unwrap();
  const b = f.device.createBuffer({ size: 512, usage: 0x8c }).unwrap();
  const address = arena.allocateDescriptor(1);
  active.activate();
  active.flush(f.device.queue, a, true).unwrap();
  const task = candidate.prepare(f.device.queue, b).unwrap();
  f.native.pushErrorScope('validation');
  try {
    task.step(256).unwrap();
    task.step(256).unwrap();
    expect(task.step(256).ok).toBe(false);
    expect(task.inspect().copiedBytes).toBe(512);
    expect(task.isCurrent()).toBe(false);
    expect(task.commitPrepared().ok).toBe(false);
    arena.writeDescriptorWord(address, 1, 0, 91);
    task.release();
    active.flush(f.device.queue, a, false).unwrap();
    expect(new Uint32Array((await readBuffer(f.device, a, address * 4, 4)).buffer)[0]).toBe(91);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    task.release();
    candidate.release();
    active.release();
    arena.dispose();
    f.device.destroyBuffer(a);
    f.device.destroyBuffer(b);
    f.native.destroy();
  }
}, 30000);

it.each([
  'active',
  'detached',
] as const)('preserves native full-upload recovery after reentrant %s activation', async (mode) => {
  const f = await nativeDeviceFixture(),
    arena = new GpuInputArena(65536);
  const active = arena.connect(),
    other = arena.connect();
  const buffer = f.device.createBuffer({ size: 65536, usage: 0x8c }).unwrap();
  const address = arena.allocateDescriptor(1);
  arena.writeDescriptorWord(address, 1, 0, 13);
  if (mode === 'active') active.activate();
  active.flush(f.device.queue, buffer, true).unwrap();
  arena.writeDescriptorWord(address, 1, 0, 17);
  const original = f.device.queue.writeBuffer.bind(f.device.queue);
  let changed = false;
  const hook = vi.spyOn(f.device.queue, 'writeBuffer').mockImplementation((...args) => {
    const result = original(...args);
    if (!changed) {
      changed = true;
      arena.writeDescriptorWord(address, 1, 0, 23);
      if (mode === 'active') other.activate();
      active.activate();
    }
    return result;
  });
  f.native.pushErrorScope('validation');
  try {
    expect(active.flush(f.device.queue, buffer, false).ok).toBe(false);
    active.flush(f.device.queue, buffer, false).unwrap();
    expect(new Uint32Array((await readBuffer(f.device, buffer, address * 4, 4)).buffer)[0]).toBe(
      23,
    );
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    hook.mockRestore();
    active.release();
    other.release();
    arena.dispose();
    f.device.destroyBuffer(buffer);
    f.native.destroy();
  }
});
