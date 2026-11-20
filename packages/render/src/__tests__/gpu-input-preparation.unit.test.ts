import { type Buffer, err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, onTestFinished, vi } from 'vitest';
import { GpuInputArena, type GpuInputPreparation } from '../gpu-input-arena';

function finish(task: GpuInputPreparation, bytes = 64): void {
  for (let step = 0; step < 10000; step++)
    if (task.step(bytes).unwrap().phase === 'current') return;
  throw new Error('Private input upload did not converge');
}
async function fixture(withActive = true) {
  const gpu = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const arena = new GpuInputArena(65536),
    active = arena.connect(),
    candidate = arena.connect();
  const targets: Buffer[] = [],
    images = new Map<Buffer, Uint8Array>();
  const target = () => {
    const buffer = gpu.createBuffer({ size: 65536, usage: 0x88 }).unwrap();
    targets.push(buffer);
    images.set(buffer, new Uint8Array(65536));
    return buffer;
  };
  const a = target(),
    b = target();
  const controls: { action?: () => void } = {};
  const original = gpu.queue.writeBuffer.bind(gpu.queue);
  const writes = vi
    .spyOn(gpu.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, start = 0, size) => {
      const result = original(buffer, offset, data, start, size);
      if (result.ok) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset + start, size ?? data.byteLength - start)
          : new Uint8Array(data, start, size ?? data.byteLength - start);
        images.get(buffer)?.set(bytes, offset);
      }
      const action = controls.action;
      delete controls.action;
      action?.();
      return result;
    });
  if (withActive) {
    active.activate();
    active.flush(gpu.queue, a, true).unwrap();
  }
  writes.mockClear();
  const tasks: GpuInputPreparation[] = [];
  const begin = () => {
    const task = candidate.prepare(gpu.queue, b).unwrap();
    tasks.push(task);
    return task;
  };
  const matches = () => {
    const image = images.get(b);
    if (image === undefined) throw new Error('Missing private target image');
    expect(Array.from(new Uint32Array(image.buffer, 0, arena.byteLength / 4))).toEqual(
      Array.from({ length: arena.byteLength / 4 }, (_, index) => arena.readWord(index)),
    );
  };
  onTestFinished(() => {
    for (const task of tasks) task.release();
    candidate.release();
    active.release();
    arena.dispose();
    writes.mockRestore();
    for (const buffer of targets) gpu.destroyBuffer(buffer);
  });
  return { gpu, arena, active, candidate, a, b, begin, writes, controls, target, images, matches };
}

it('observes only the actual fully uploaded queue, buffer and numeric revision', async () => {
  const f = await fixture();
  expect(f.active.isCurrent(f.gpu.queue, f.a)).toBe(true);
  expect(f.active.isCurrent(f.gpu.queue, f.b)).toBe(false);
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(false);
  const address = f.arena.allocateDescriptor(1);
  f.arena.writeDescriptorWord(address, 1, 0, 19);
  expect(f.active.isCurrent(f.gpu.queue, f.a)).toBe(false);
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  expect(f.active.isCurrent(f.gpu.queue, f.a)).toBe(true);
  const task = f.begin();
  finish(task);
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(false);
  task.commitPrepared().unwrap();
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(true);
  f.arena.writeDescriptorWord(address, 1, 0, 23);
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(false);
  f.candidate.flush(f.gpu.queue, f.b, false).unwrap();
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(true);
  f.candidate.release();
  expect(f.candidate.isCurrent(f.gpu.queue, f.b)).toBe(false);
});

it('copies in bounded writes and commits without repeating the prepared upload', async () => {
  const f = await fixture();
  const address = f.arena.allocateDescriptor(4);
  f.arena.writeDescriptorWord(address, 4, 0, 17);
  const task = f.begin();
  for (const bytes of [0, -4, 3, 5, NaN, Infinity]) expect(task.step(bytes).ok).toBe(false);
  finish(task);
  expect(task.isCurrent()).toBe(true);
  f.matches();
  for (const call of f.writes.mock.calls.filter((call) => call[0] === f.b)) {
    expect(call[4]).toBeGreaterThan(0);
    expect(call[4]).toBeLessThanOrEqual(64);
  }
  f.writes.mockClear();
  task.commitPrepared().unwrap();
  expect(task.inspect().phase).toBe('committed');
  expect(task.commitPrepared().ok).toBe(false);
  f.candidate.flush(f.gpu.queue, f.b, false).unwrap();
  expect(f.writes).not.toHaveBeenCalled();
  f.arena.writeDescriptorWord(address, 4, 0, 23);
  f.candidate.flush(f.gpu.queue, f.b, false).unwrap();
  expect(f.writes.mock.calls.map((call) => [call[1], call[4]])).toEqual([[address * 4, 16]]);
  f.active.activate();
  f.writes.mockClear();
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  expect(f.writes).toHaveBeenCalledTimes(1);
  expect(f.writes.mock.calls[0]?.[2].byteLength).toBe(f.arena.byteLength);
});

it('cancels without consuming the active dirty population', async () => {
  const f = await fixture();
  const address = f.arena.allocateDescriptor(1);
  const task = f.begin();
  task.step(64).unwrap();
  f.arena.writeDescriptorWord(address, 1, 0, 19);
  task.release();
  task.release();
  expect(task.commitPrepared().ok).toBe(false);
  f.writes.mockClear();
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  expect(f.writes.mock.calls.map((call) => call[1])).toEqual([address * 4]);
});

it.each([
  false,
  true,
])('observes writes without an active upload and keeps retired/reused bytes (reuse=%s)', async (reuse) => {
  const f = await fixture(false);
  const address = f.arena.allocateDescriptor(1),
    task = f.begin();
  f.controls.action = () => {
    f.arena.writeDescriptorWord(address, 1, 0, 41);
    f.arena.releaseDescriptor(address, 1);
    if (reuse) {
      const next = f.arena.allocateDescriptor(1);
      f.arena.writeDescriptorWord(next, 1, 0, 73);
    }
  };
  task.step(64).unwrap();
  finish(task);
  f.matches();
  expect(task.isCurrent()).toBe(true);
});

it('does not acknowledge a new dirty ticket produced by the write callback', async () => {
  const f = await fixture();
  const address = f.arena.allocateDescriptor(1),
    task = f.begin();
  finish(task);
  f.arena.writeDescriptorWord(address, 1, 0, 1);
  let nested: boolean | undefined;
  f.controls.action = () => {
    f.arena.writeDescriptorWord(address, 1, 0, 2);
    nested = task.commitPrepared().ok;
    expect(task.step(4).ok).toBe(false);
  };
  expect(task.step(4).unwrap().phase).toBe('copying');
  expect(nested).toBe(false);
  finish(task);
  f.matches();
  expect(task.isCurrent()).toBe(true);
});

it('catches up with active writes after their ordinary flush and with a growing backing', async () => {
  const f = await fixture(),
    task = f.begin();
  task.step(64).unwrap();
  const address = f.arena.allocateDescriptor(1024);
  f.arena.writeDescriptorWord(address, 1024, 0, 29);
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  finish(task);
  f.matches();
  expect(task.inspect().extentBytes).toBe(f.arena.byteLength);
});

it('invalidates the original active incarnation even when activation returns to the same writer', async () => {
  const f = await fixture(),
    task = f.begin();
  finish(task);
  const other = f.arena.connect();
  try {
    other.activate();
    f.active.activate();
    expect(task.isCurrent()).toBe(false);
    expect(task.commitPrepared().ok).toBe(false);
  } finally {
    other.release();
  }
});

it('rejects target aliasing, parallel preparation and ordinary writes to a private target', async () => {
  const f = await fixture();
  expect(f.candidate.prepare(f.gpu.queue, f.a).ok).toBe(false);
  const task = f.begin(),
    other = f.arena.connect();
  try {
    expect(other.prepare(f.gpu.queue, f.target()).ok).toBe(false);
    expect(f.candidate.flush(f.gpu.queue, f.b, true).ok).toBe(false);
    expect(other.flush(f.gpu.queue, f.b, true).ok).toBe(false);
    task.release();
    expect(f.candidate.prepare(f.gpu.queue, f.b).ok).toBe(false);
  } finally {
    other.release();
  }
});

it('retries a rejected write without advancing or poisoning the active upload', async () => {
  const f = await fixture(),
    task = f.begin();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected write rejection',
    hint: 'retry',
  });
  f.writes.mockReturnValueOnce(err(failure));
  const result = task.step(64);
  expect(result).toMatchObject({ ok: false, error: failure });
  expect(task.inspect().copiedBytes).toBe(0);
  expect(task.isCurrent()).toBe(false);
  finish(task);
  f.matches();
});

it('keeps an unexpected write failure private and retains its cause', async () => {
  const f = await fixture(),
    task = f.begin(),
    cause = new Error('private native write failed');
  f.writes.mockImplementationOnce(() => {
    throw cause;
  });
  const result = task.step(64);
  expect(result).toMatchObject({ ok: false, error: { cause } });
  expect(task.inspect().phase).toBe('failed');
  expect(task.commitPrepared().ok).toBe(false);
  const address = f.arena.allocateDescriptor(1);
  f.arena.writeDescriptorWord(address, 1, 0, 31);
  task.release();
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  expect(f.arena.live).toBe(true);
});

it.each([
  'cancel',
  'dispose',
] as const)('bookends %s during the actual native write', async (mode) => {
  const f = await fixture(),
    task = f.begin();
  f.controls.action = () => {
    if (mode === 'dispose') f.arena.dispose();
    else task.release();
  };
  expect(task.step(64).ok).toBe(false);
  expect(task.isCurrent()).toBe(false);
  expect(task.commitPrepared().ok).toBe(false);
  expect(task.inspect().phase).toBe('released');
});

it('does not commit inside another native write and leaves ordinary recovery activate cold', async () => {
  const f = await fixture(),
    task = f.begin();
  finish(task);
  let nested: boolean | undefined;
  f.controls.action = () => {
    nested = task.commitPrepared().ok;
  };
  f.active.flush(f.gpu.queue, f.a, true).unwrap();
  expect(nested).toBe(false);
  expect(task.isCurrent()).toBe(true);
  task.commitPrepared().unwrap();
  f.active.activate();
  f.writes.mockClear();
  f.active.flush(f.gpu.queue, f.a, false).unwrap();
  expect(f.writes).toHaveBeenCalledTimes(1);
});

it('uploads a different physical target completely even without an initial flag', async () => {
  const f = await fixture();
  f.active.flush(f.gpu.queue, f.target(), false).unwrap();
  expect(f.writes).toHaveBeenCalledTimes(1);
  expect(f.writes.mock.calls[0]?.[2].byteLength).toBe(f.arena.byteLength);
});

it.each([
  'active',
  'detached',
] as const)('preserves full-upload responsibility after reentrant %s activation', async (mode) => {
  const f = await fixture(mode === 'active');
  const other = f.arena.connect();
  const address = f.arena.allocateDescriptor(1);
  f.arena.writeDescriptorWord(address, 1, 0, 13);
  f.active.flush(f.gpu.queue, f.a, true).unwrap();
  f.arena.writeDescriptorWord(address, 1, 0, 17);
  f.controls.action = () => {
    f.arena.writeDescriptorWord(address, 1, 0, 23);
    if (mode === 'active') other.activate();
    f.active.activate();
  };
  try {
    const changed = f.active.flush(f.gpu.queue, f.a, false);
    f.writes.mockClear();
    f.active.flush(f.gpu.queue, f.a, false).unwrap();
    const image = f.images.get(f.a);
    if (image === undefined) throw new Error('Missing active target image');
    expect(new Uint32Array(image.buffer)[address]).toBe(23);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(changed.ok).toBe(false);
  } finally {
    other.release();
  }
});
