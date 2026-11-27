import { type Buffer, err, RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';

function fixture(texture = false) {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (ledger, owner) => new RhiNullCommandEncoder(ledger, owner),
  );
  const bytes = new Uint8Array(128 * 1024);
  let current = true;
  const finished = vi.fn();
  const task = new GpuSceneCapacityPreparation(
    device,
    texture ? 'texture' : 'buffer',
    [{ name: 'transform', stride: 64, bytes: bytes.byteLength }],
    () => bytes,
    () => current,
    finished,
  );
  return {
    device,
    bytes,
    task,
    finished,
    invalidate: () => {
      current = false;
    },
  };
}

it('preserves owned target rows while recopying old-world bytes in both shared chunks', async () => {
  const f = fixture();
  const observed = observeGpuInputBytes(f.device);
  try {
    for (let step = 0; !f.task.isCurrent() && step < 20; step++) f.task.step().unwrap();
    const row = new Uint8Array(128).fill(91);
    f.task.writeRows('transform', 65536 - 64, row).unwrap();
    row.fill(17);
    f.bytes.fill(29);
    f.task.dirty('transform', 0, f.bytes.byteLength);
    expect(f.task.isCurrent()).toBe(false);
    for (let step = 0; !f.task.isCurrent() && step < 20; step++) f.task.step().unwrap();
    const target = f.task.preparedTables()?.[0];
    expect(target).toBeDefined();
    if (target === undefined || target.resource.kind !== 'buffer')
      throw new Error('Missing real target');
    const native = observed.bytes.get(target.resource.buffer);
    expect(native?.subarray(65536 - 64, 65536 + 64)).toEqual(new Uint8Array(128).fill(91));
    expect(native?.[0]).toBe(29);
    expect(native?.[65536 + 64]).toBe(29);
    expect(target.bytes).toEqual(native);
    expect(f.task.inspect().privateWriteBytes).toBe(128);
  } finally {
    await f.device.queue.onSubmittedWorkDone();
    while (!f.task.retireStep()) {
      /* no frame */
    }
    expect(f.task.writeRows('transform', 0, new Uint8Array(64)).ok).toBe(false);
    observed.close();
  }
});

it('catches a reentrant source write after copying a chunk without publishing a stale copy', async () => {
  const f = fixture();
  const memory = new Map<Buffer, Uint8Array>();
  let reentered = false;
  const original = f.device.queue.writeBuffer.bind(f.device.queue);
  const write = vi
    .spyOn(f.device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, start, size) => {
      const result = original(buffer, offset, data, start, size);
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const target = memory.get(buffer) ?? new Uint8Array(f.bytes.byteLength);
      target.set(view.subarray(start ?? 0, (start ?? 0) + (size ?? view.byteLength)), offset);
      memory.set(buffer, target);
      if (!reentered) {
        reentered = true;
        f.bytes[0] = 73;
        f.task.dirty('transform', 0, 1);
        expect(f.task.step().ok).toBe(false);
        expect(f.task.isCurrent()).toBe(false);
      }
      return result;
    });
  try {
    for (let steps = 0; !f.task.isCurrent() && steps < 20; steps++) f.task.step().unwrap();
    expect(f.task.isCurrent()).toBe(true);
    expect([...memory.values()][0]?.[0]).toBe(73);
    expect(write).toHaveBeenCalledTimes(3);
  } finally {
    write.mockRestore();
    await f.device.queue.onSubmittedWorkDone();
    while (!f.task.retireStep()) {
      /* one released table per grant */
    }
  }
  expect(f.finished).toHaveBeenCalledOnce();
});

it.each([
  'error',
  'throw',
] as const)('does not report retirement after native buffer destruction %s', (kind) => {
  const f = fixture();
  f.task.step().unwrap();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected failure',
    hint: 'retain responsibility',
  });
  const destroy = vi.spyOn(f.device, 'destroyBuffer').mockImplementation(() => {
    if (kind === 'throw') throw failure;
    return err(failure);
  });
  try {
    expect(() => f.task.retireStep()).toThrow(failure);
    expect(f.task.inspect()).toMatchObject({ phase: 'retiring', tables: 1 });
    expect(f.finished).not.toHaveBeenCalled();
    expect(() => f.task.retireStep()).toThrow(failure);
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    destroy.mockRestore();
  }
});

it('retains the exact texture when view creation and later cleanup fail', () => {
  const f = fixture(true);
  const viewFailure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected view failure',
    hint: 'cancel',
  });
  const cleanupFailure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected cleanup failure',
    hint: 'retain',
  });
  const view = vi.spyOn(f.device, 'createTextureView').mockReturnValue(err(viewFailure));
  const destroy = vi.spyOn(f.device, 'destroyTexture').mockReturnValue(err(cleanupFailure));
  try {
    const step = f.task.step();
    expect(step.ok).toBe(false);
    if (!step.ok) expect(step.error).toBe(viewFailure);
    expect(destroy).not.toHaveBeenCalled();
    expect(f.task.inspect().tables).toBe(1);
    expect(() => f.task.retireStep()).toThrow(cleanupFailure);
    expect(f.task.inspect()).toMatchObject({ phase: 'retiring', tables: 1 });
    expect(f.finished).not.toHaveBeenCalled();
  } finally {
    view.mockRestore();
    destroy.mockRestore();
  }
});

it('closes the release role before a native destroy callback can reenter', () => {
  const f = fixture();
  f.task.step().unwrap();
  const original = f.device.destroyBuffer.bind(f.device);
  const destroy = vi.spyOn(f.device, 'destroyBuffer').mockImplementation((buffer) => {
    expect(() => f.task.retireStep()).toThrow();
    expect(f.task.step().ok).toBe(false);
    return original(buffer);
  });
  try {
    expect(f.task.retireStep()).toBe(false);
    expect(f.task.retireStep()).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    destroy.mockRestore();
  }
});

it('retains cleanup after a failed upload or an invalidated owner', async () => {
  const f = fixture();
  f.task.step().unwrap();
  const write = vi.spyOn(f.device.queue, 'writeBuffer').mockReturnValue(
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'injected upload failure',
        hint: 'cancel',
      }),
    ),
  );
  expect(() => f.task.step()).toThrow();
  write.mockRestore();
  f.invalidate();
  expect(f.task.step().ok).toBe(false);
  expect(f.task.isCurrent()).toBe(false);
  await f.device.queue.onSubmittedWorkDone();
  expect(f.task.retireStep()).toBe(false);
  expect(f.task.retireStep()).toBe(true);
  expect(f.finished).toHaveBeenCalledOnce();
});

it('cannot regain current after a completed copy catch-up throws', async () => {
  const f = fixture();
  for (let steps = 0; !f.task.isCurrent() && steps < 10; steps++) f.task.step().unwrap();
  expect(f.task.isCurrent()).toBe(true);
  f.bytes[0] = 91;
  f.task.dirty('transform', 0, 1);
  const write = vi.spyOn(f.device.queue, 'writeBuffer').mockImplementation(() => {
    throw undefined;
  });
  try {
    expect(() => f.task.step()).toThrow();
    expect(f.task.isCurrent()).toBe(false);
    expect(f.task.step().ok).toBe(false);
  } finally {
    write.mockRestore();
    await f.device.queue.onSubmittedWorkDone();
    while (!f.task.retireStep()) {
      /* preserve exact cleanup */
    }
  }
});

it('does not starve a later cold table behind continuous earlier stamp writes', async () => {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (ledger, owner) => new RhiNullCommandEncoder(ledger, owner),
  );
  const bytes = new Uint8Array(128 * 1024);
  const task = new GpuSceneCapacityPreparation(
    device,
    'buffer',
    [
      { name: 'transform', stride: 64, bytes: bytes.byteLength },
      { name: 'material', stride: 16, bytes: bytes.byteLength },
    ],
    () => bytes,
    () => true,
    () => undefined,
  );
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    for (let steps = 0; steps < 10; steps++) {
      task.step().unwrap();
      task.dirty('transform', 0, 4);
    }
    expect(new Set(write.mock.calls.map(([buffer]) => buffer)).size).toBe(2);
    for (let steps = 0; !task.isCurrent() && steps < 10; steps++) task.step().unwrap();
    expect(task.isCurrent()).toBe(true);
  } finally {
    write.mockRestore();
    await device.queue.onSubmittedWorkDone();
    while (!task.retireStep()) {
      /* all private tables */
    }
  }
});

it('does no native work after its live callback cancels the preparation', () => {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (ledger, owner) => new RhiNullCommandEncoder(ledger, owner),
  );
  const bytes = new Uint8Array(64);
  const task = new GpuSceneCapacityPreparation(
    device,
    'buffer',
    [{ name: 'transform', stride: 64, bytes: 64 }],
    () => bytes,
    () => {
      task.invalidate();
      return true;
    },
    () => undefined,
  );
  const create = vi.spyOn(device, 'createBuffer');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  expect(task.step().ok).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(task.retireStep()).toBe(true);
  create.mockRestore();
  write.mockRestore();
});
