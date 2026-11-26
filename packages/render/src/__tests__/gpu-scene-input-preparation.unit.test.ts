import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { GpuScene } from '../gpu-scene';
import { type GpuSceneInputPreparation, GpuSceneInputs } from '../gpu-scene-inputs';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';

function finish(task: GpuSceneInputPreparation): void {
  for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') return;
  throw new Error('Inputs preparation did not converge');
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const observed = observeGpuInputBytes(device);
  const row = inputs.arena.allocateDescriptor(4);
  inputs.arena.writeDescriptorWord(row, 4, 0, 17);
  const frame = inputs.capture();
  const previous = frame.buffer().unwrap();
  frame.seal().unwrap();
  const nativeDestroy = device.destroyBuffer.bind(device);
  const nativeFence = device.queue.onSubmittedWorkDone.bind(device.queue);
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone');
  const controls = { failure: false };
  onTestFinished(async () => {
    if (controls.failure) expect(() => inputs.dispose()).toThrow(AggregateError);
    else inputs.dispose();
    frame.release();
    await Promise.resolve();
    await Promise.resolve();
    observed.close();
    destroy.mockRestore();
    fence.mockRestore();
  });
  return {
    device,
    inputs,
    observed,
    row,
    frame,
    previous,
    destroy,
    nativeDestroy,
    nativeFence,
    fence,
    controls,
  };
}

function mappedDescriptor(bytes: Uint8Array, root: number, slot: number): number {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  for (const shift of [24, 16, 8]) {
    const page = words[root + ((slot >>> shift) & 255)];
    assert(page !== undefined && page !== 0xffffffff);
    root = page;
  }
  const descriptor = words[root + (slot & 255)];
  assert(descriptor !== undefined);
  return descriptor;
}

it('prepares the same Source mapping again after a live frame grows the Inputs buffer', async () => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(4, (_address, words) =>
    words.setUint32(0, 71, true),
  );
  const mapping = f.inputs.reserveResource(descriptor);
  const begin = () => {
    const work = f.inputs.prepareResourceBuffer(
      [mapping],
      () => true,
      () => {},
    );
    let next = work.next();
    while (!next.done) next = work.next();
    return next.value;
  };
  const first = begin();
  first.step(64).unwrap();
  expect(first.superseded()).toBe(false);
  const words = first.byteLength / 4 + 4;
  const grown = f.inputs.arena.allocateDescriptor(words);
  const live = f.inputs.capture();
  let replacement: GpuSceneInputPreparation | undefined;
  try {
    const { buffer } = live.buffer().unwrap();
    live.seal().unwrap();
    expect(buffer).not.toBe(f.previous.buffer);
    expect(first.isCurrent()).toBe(false);
    expect(first.superseded()).toBe(true);
    first.release();
    for (let step = 0; step < 64; step++) {
      const retirement = first.retirement().unwrap();
      if (retirement.done) break;
      await retirement.pending;
    }
    expect(first.retirement().unwrap().done).toBe(true);
    expect(mapping.isCurrent()).toBe(true);
    replacement = begin();
    finish(replacement);
    replacement.commitPrepared().unwrap();
    expect(replacement.superseded()).toBe(false);
    const result = f.inputs.capture();
    const accepted = result.buffer().unwrap();
    result.seal().unwrap();
    result.release();
    expect(accepted.buffer).toBe(replacement.buffer);
    const bytes = f.observed.bytes.get(accepted.buffer);
    assert(bytes);
    expect(mappedDescriptor(bytes, accepted.resourceRoot, mapping.logicalSlot)).toBe(
      mapping.descriptor,
    );
  } finally {
    first.release();
    replacement?.release();
    live.release();
    mapping.release();
    descriptor.release();
    f.inputs.arena.releaseDescriptor(grown, words);
  }
});

it.each([
  'before',
  'after',
] as const)('returns other accepted sibling references after %s-effect private rollback failure', async (mode) => {
  const f = await fixture();
  const slots = Array.from({ length: 257 }, () => f.inputs.allocateResource(f.row));
  const first = slots[0];
  assert(first !== undefined);
  f.inputs.releaseResource(first);
  const descriptor = f.inputs.arena.reserveDescriptor(3, (_address, words) =>
    words.setUint32(0, 71, true),
  );
  const mapping = f.inputs.reserveResource(descriptor);
  expect(mapping.logicalSlot).toBe(first);
  type Page = { holders: number; children: Map<number, Page> };
  const root = Reflect.get(f.inputs, 'resources') as Page;
  const sibling = root.children.get(0)?.children.get(0)?.children.get(1);
  assert(sibling);
  const holders = sibling.holders;
  const ranges = Reflect.get(f.inputs.arena, 'ranges') as {
    release(start: number, count: number): void;
  };
  const nativeRelease = ranges.release.bind(ranges);
  const nativeReserve = f.inputs.arena.reserveDescriptor.bind(f.inputs.arena);
  let leaf: number | undefined;
  let pages = 0;
  const construction = new Error('private parent constructor');
  const rollback = new Error('unconfirmed private leaf rollback');
  const reserve = vi
    .spyOn(f.inputs.arena, 'reserveDescriptor')
    .mockImplementation((count, initialize, capture) => {
      if (++pages === 2) throw construction;
      return nativeReserve(count, initialize, (value) => {
        leaf = value.address;
        capture?.(value);
      });
    });
  const release = vi.spyOn(ranges, 'release').mockImplementation((start, count) => {
    if (start === leaf && mode === 'before') throw rollback;
    nativeRelease(start, count);
    if (start === leaf) throw rollback;
  });
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  f.controls.failure = true;
  try {
    let cause: unknown;
    try {
      work.next();
    } catch (error) {
      cause = error;
    }
    expect(sibling.holders).toBe(holders);
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as Error).cause).toBe(construction);
    assert(task);
    expect(task.privatePageBytes).toBe(1024);
    expect(task.retirement().ok).toBe(false);
    expect(task.retirement().ok).toBe(false);
    expect(release.mock.calls.filter(([start]) => start === leaf)).toHaveLength(1);
  } finally {
    work.return(undefined as never);
    task?.release();
    reserve.mockRestore();
    release.mockRestore();
    mapping.release();
    descriptor.release();
  }
});

it('uploads one private resource-tree successor while ordinary mappings and numeric uploads continue', async () => {
  const f = await fixture();
  const accepted = f.inputs.allocateResource(f.row);
  const read = f.inputs.capture();
  const before = read.buffer().unwrap();
  read.seal().unwrap();
  const guard = f.inputs.captureGuard();
  const byteLength = f.inputs.arena.byteLength;
  const descriptor = f.inputs.arena.reserveDescriptor(6, (_address, words) => {
    words.setUint32(0, 0x12345678, true);
    words.setUint32(20, 0x87654321, true);
  });
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* bounded tree paths */
    }
    assert(task);
    expect(task.resourceRoot).not.toBe(before.resourceRoot);
    expect(task.privatePageBytes).toBe(4 * 1024);
    expect(f.inputs.arena.byteLength).toBe(byteLength);
    for (let step = 0; step < 10000; step++) {
      f.inputs.arena.writeDescriptorWord(f.row, 4, 0, step + 100);
      const frame = f.inputs.capture();
      expect(frame.resource(mapping.logicalSlot)).toBeUndefined();
      expect(frame.resource(accepted)).toBe(f.row);
      expect(frame.buffer().unwrap()).toMatchObject(before);
      frame.seal().unwrap();
      frame.release();
      if (task.step(64).unwrap().phase === 'current') break;
    }
    expect(task.isCurrent()).toBe(true);
    const bytes = f.observed.bytes.get(task.buffer);
    assert(bytes);
    expect(mappedDescriptor(bytes, task.resourceRoot, accepted)).toBe(f.row);
    expect(mappedDescriptor(bytes, task.resourceRoot, mapping.logicalSlot)).toBe(
      descriptor.address,
    );
    const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(words.getUint32(descriptor.address * 4, true)).toBe(0x12345678);
    expect(words.getUint32((descriptor.address + 5) * 4, true)).toBe(0x87654321);
    expect(words.getUint32(f.row * 4, true)).toBe(f.inputs.arena.readWord(f.row));
    expect(guard()).toBe(true);
    expect(f.inputs.arena.byteLength).toBe(byteLength);
    for (const call of f.observed.writes.mock.calls.filter((call) => call[0] === task?.buffer))
      expect(call[4]).toBeLessThanOrEqual(64);
    let complete!: () => void;
    f.fence.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          complete = () => resolve(undefined);
        }),
    );
    task.release();
    const waiting = task.retirement().unwrap();
    expect(waiting.done).toBe(false);
    expect(task.privatePageBytes).toBe(4 * 1024);
    complete();
    await waiting.pending;
    for (let step = 0; step < 16; step++) {
      const bytes = task.privatePageBytes;
      const result = task.retirement().unwrap();
      expect(bytes - task.privatePageBytes).toBeLessThanOrEqual(1024);
      if (result.done) break;
    }
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
    expect(mapping.isCurrent()).toBe(true);
    expect(descriptor.isCurrent()).toBe(true);
  } finally {
    work.return(undefined as never);
    task?.release();
    read.release();
    mapping.release();
    descriptor.release();
  }
});

it('consumes private numeric addresses and logical mappings together without first-use native work', async () => {
  const f = await fixture();
  const slot = f.inputs.allocateResource(f.row);
  const read = f.inputs.capture();
  const before = read.buffer().unwrap();
  read.seal().unwrap();
  const descriptor = f.inputs.arena.reserveDescriptor(6, (_address, target) => {
    target.setUint32(0, 0x12345678, true);
    target.setUint32(20, 0x87654321, true);
  });
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping, mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  let committed = false;
  let bodyFailure: unknown;
  let cleanupFailure: unknown;
  const create = vi.spyOn(f.device, 'createBuffer');
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* one mapping, despite repeated demand */
    }
    assert(task);
    finish(task);
    expect(task.privatePageBytes).toBe(4 * 1024);
    const uploadBytes = f.inputs.uploadBytes;
    create.mockClear();
    f.observed.writes.mockClear();
    f.destroy.mockClear();
    f.fence.mockClear();
    task.commitPrepared().unwrap();
    committed = true;
    expect(task.inspect().phase).toBe('committed');
    expect(task.privatePageBytes).toBe(0);
    expect(descriptor.isCurrent()).toBe(false);
    expect(mapping.isCurrent()).toBe(false);
    descriptor.release();
    mapping.release();
    expect(task.commitPrepared().ok).toBe(false);
    const after = f.inputs.capture();
    try {
      expect(after.resource(slot)).toBe(f.row);
      expect(after.resource(mapping.logicalSlot)).toBe(descriptor.address);
      expect(after.buffer().unwrap()).toMatchObject({
        buffer: task.buffer,
        resourceRoot: task.resourceRoot,
      });
      after.seal().unwrap();
      expect(f.inputs.arena.byteLength).toBe(task.byteLength);
      expect(f.inputs.arena.readWord(descriptor.address)).toBe(0x12345678);
      expect(f.inputs.arena.readWord(descriptor.address + 5)).toBe(0x87654321);
      expect(f.inputs.uploadBytes).toBe(uploadBytes);
      expect(f.observed.writes).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.fence).not.toHaveBeenCalled();
      expect(f.inputs.readHoldsBuffer(read, before.buffer, before.resourceRoot)).toBe(true);
      f.inputs.arena.writeDescriptorWord(descriptor.address, 6, 0, 91);
      const changed = f.inputs.capture();
      changed.buffer().unwrap();
      changed.seal().unwrap();
      changed.release();
      expect(f.observed.writes.mock.calls.map((call) => call[4])).toEqual([4]);
    } finally {
      after.release();
    }
    task.release();
    expect(task.retirement().unwrap().done).toBe(true);
    expect(f.inputs.resourceIsCurrent(mapping.logicalSlot, descriptor.address)).toBe(true);
  } catch (cause) {
    bodyFailure = cause;
  } finally {
    try {
      work.return(undefined as never);
      task?.release();
      read.release();
      await f.nativeFence();
      create.mockRestore();
      if (committed) {
        f.inputs.releaseResource(mapping.logicalSlot);
        f.inputs.arena.releaseDescriptor(descriptor.address, descriptor.wordCount);
      } else {
        mapping.release();
        descriptor.release();
      }
    } catch (cleanup) {
      cleanupFailure = cleanup;
    }
  }
  if (bodyFailure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([bodyFailure, cleanupFailure], 'Transfer check and cleanup failed', {
      cause: bodyFailure,
    });
  if (bodyFailure !== undefined) throw bodyFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});

it('rejects reentrant loss of a logical reservation before consuming numeric ownership', async () => {
  const f = await fixture();
  const bytes = f.inputs.arena.byteLength;
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  let armed = false;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => {
      if (armed) mapping.release();
      return true;
    },
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private tree */
    }
    assert(task);
    finish(task);
    armed = true;
    expect(task.commitPrepared().ok).toBe(false);
    expect(f.inputs.arena.ownsDescriptorReservation(descriptor)).toBe(true);
    expect(f.inputs.arena.byteLength).toBe(bytes);
    expect(f.inputs.isCurrentBuffer(f.previous.buffer)).toBe(true);
    expect(f.inputs.lifetimeFailure).toBeUndefined();
  } finally {
    work.return(undefined as never);
    task?.release();
    await f.nativeFence();
    if (task !== undefined)
      for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    mapping.release();
    descriptor.release();
  }
});

it('rejects same-task commit reentry during the real source preflight before any owner transfer', async () => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  let armed = false;
  let nested: boolean | undefined;
  let duringCurrent: boolean | undefined;
  let committed = false;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => {
      if (armed) {
        armed = false;
        duringCurrent = task?.isCurrent();
        nested = task?.commitPrepared().ok;
      }
      return true;
    },
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private tree */
    }
    assert(task);
    finish(task);
    armed = true;
    const result = task.commitPrepared();
    committed = result.ok || nested === true;
    expect(nested).toBe(false);
    expect(duringCurrent).toBe(false);
    expect(result.ok).toBe(true);
    expect(f.inputs.isCurrentBuffer(task.buffer)).toBe(true);
    expect(f.inputs.lifetimeFailure).toBeUndefined();
  } finally {
    work.return(undefined as never);
    task?.release();
    await f.nativeFence();
    if (committed) {
      f.inputs.releaseResource(mapping.logicalSlot);
      f.inputs.arena.releaseDescriptor(descriptor.address, descriptor.wordCount);
    } else {
      mapping.release();
      descriptor.release();
    }
  }
});

it.each([
  'isCurrent',
  'target',
  'inspect',
  'step',
] as const)('rejects same-task commit reentry during %s observation', async (observation) => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  let armed = false;
  let nested: boolean | undefined;
  let committed = false;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => {
      if (armed) {
        armed = false;
        nested = task?.commitPrepared().ok;
      }
      return true;
    },
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private tree */
    }
    assert(task);
    finish(task);
    armed = true;
    const stepped = observation === 'step' ? task.step(64) : undefined;
    const current =
      observation === 'isCurrent'
        ? task.isCurrent()
        : observation === 'target'
          ? f.inputs.preparationTarget(task) === task
          : observation === 'inspect'
            ? task.inspect().phase === 'current'
            : stepped?.ok === true && stepped.value.phase === 'current';
    committed = task.inspect().phase === 'committed';
    expect(nested).toBe(false);
    expect(current).toBe(true);
    expect(f.inputs.isCurrentBuffer(f.previous.buffer)).toBe(true);
    expect(f.inputs.lifetimeFailure).toBeUndefined();
  } finally {
    work.return(undefined as never);
    task?.release();
    await f.nativeFence();
    if (committed) {
      f.inputs.releaseResource(mapping.logicalSlot);
      f.inputs.arena.releaseDescriptor(descriptor.address, descriptor.wordCount);
    } else {
      if (task !== undefined)
        for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
      mapping.release();
      descriptor.release();
    }
  }
});

it.each([
  'commit',
  'isCurrent',
  'target',
  'inspect',
  'step',
] as const)('drains a private candidate cancelled inside %s after leaving the busy boundary', async (operation) => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  let armed = false;
  let fencesInside = -1;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => {
      if (armed) {
        armed = false;
        task?.release();
        fencesInside = f.fence.mock.calls.length;
      }
      return true;
    },
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private tree */
    }
    assert(task);
    finish(task);
    f.fence.mockClear();
    f.destroy.mockClear();
    armed = true;
    const result =
      operation === 'commit'
        ? task.commitPrepared().ok
        : operation === 'isCurrent'
          ? task.isCurrent()
          : operation === 'target'
            ? f.inputs.preparationTarget(task) !== undefined
            : operation === 'inspect'
              ? task.inspect().phase !== 'released'
              : task.step(64).ok;
    expect(result).toBe(false);
    expect(fencesInside).toBe(0);
    expect(f.inputs.isCurrentBuffer(f.previous.buffer)).toBe(true);
    await f.nativeFence();
    expect(f.destroy.mock.calls.filter(([buffer]) => buffer === task?.buffer)).toHaveLength(1);
    for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    expect(task.retirement().unwrap().done).toBe(true);
    expect(f.inputs.lifetimeFailure).toBeUndefined();
  } finally {
    work.return(undefined as never);
    task?.release();
    mapping.release();
    descriptor.release();
  }
});

it('faults the owner after a numeric transfer followed by an unknown upload-connection effect', async () => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  const upload = Reflect.get(f.inputs, 'upload') as { release(): void };
  const original = upload.release.bind(upload);
  const cause = new Error('upload connection transfer effect');
  const release = vi.spyOn(upload, 'release').mockImplementationOnce(() => {
    original();
    throw cause;
  });
  f.controls.failure = true;
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private tree */
    }
    assert(task);
    finish(task);
    expect(task.commitPrepared().ok).toBe(false);
    expect(task.inspect().phase).toBe('failed');
    expect(task.isCurrent()).toBe(false);
    expect(descriptor.isCurrent()).toBe(false);
    expect(mapping.isCurrent()).toBe(false);
    expect(f.inputs.lifetimeFailure).toBeInstanceOf(AggregateError);
    expect(() => f.inputs.capture()).toThrow(AggregateError);
    task.release();
    await f.nativeFence();
    expect(task.retirement().ok).toBe(false);
    expect(task.retirement().ok).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    work.return(undefined as never);
    task?.release();
    release.mockRestore();
    mapping.release();
    descriptor.release();
  }
});

it('cancels private tree construction before native allocation and drains exact pages without a frame', async () => {
  const f = await fixture();
  const descriptor = f.inputs.arena.reserveDescriptor(3, (_address, words) =>
    words.setUint32(0, 19, true),
  );
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  const create = vi.spyOn(f.device, 'createBuffer');
  try {
    expect(work.next().done).toBe(false);
    assert(task);
    expect(task.privatePageBytes).toBe(4 * 1024);
    task.release();
    work.return(undefined as never);
    for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
    expect(create).not.toHaveBeenCalled();
    const retry = f.inputs.prepareBuffer().unwrap();
    expect(retry.inspect().phase).toBe('copying');
    retry.release();
  } finally {
    work.return(undefined as never);
    task?.release();
    create.mockRestore();
    mapping.release();
    descriptor.release();
  }
});

it.each([
  'mapping-change',
  'reservation-release',
  'owner-dispose',
] as const)('invalidates a private resource root on %s and still drains its native and page custody', async (mode) => {
  const f = await fixture();
  const other = f.inputs.arena.allocateDescriptor(4);
  const accepted = f.inputs.allocateResource(f.row);
  const frame = f.inputs.capture();
  frame.buffer().unwrap();
  frame.seal().unwrap();
  frame.release();
  const descriptor = f.inputs.arena.reserveDescriptor(3, (_address, words) =>
    words.setUint32(0, 13, true),
  );
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  try {
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* bounded tree paths */
    }
    assert(task);
    finish(task);
    expect(task.isCurrent()).toBe(true);
    if (mode === 'mapping-change') f.inputs.updateResource(accepted, other);
    else if (mode === 'reservation-release') mapping.release();
    else f.inputs.dispose();
    expect(task.isCurrent()).toBe(false);
    expect(task.step(64).ok).toBe(false);
    task.release();
    await f.nativeFence();
    for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
  } finally {
    work.return(undefined as never);
    task?.release();
    mapping.release();
    descriptor.release();
  }
});

it('rejects a foreign logical reservation even when both Inputs borrow the same numeric arena', async () => {
  const f = await fixture();
  const foreign = new GpuSceneInputs(f.device, (slot) => slot, f.inputs.arena);
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = foreign.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  try {
    expect(() => work.next()).toThrow(RhiError);
    assert(task);
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
    const retry = f.inputs.prepareBuffer().unwrap();
    expect(retry.inspect().phase).toBe('copying');
    retry.release();
    expect(mapping.isCurrent()).toBe(true);
  } finally {
    work.return(undefined as never);
    task?.release();
    mapping.release();
    foreign.dispose();
    descriptor.release();
  }
});

it('checks private resource backing against the actual device storage budget before native creation', async () => {
  const f = await fixture();
  const limits = Object.getOwnPropertyDescriptor(f.device, 'limits');
  Object.defineProperty(f.device, 'limits', {
    configurable: true,
    value: {
      ...f.device.limits,
      maxStorageBufferBindingSize: 1024,
    },
  });
  const descriptor = f.inputs.arena.reserveDescriptor(3, () => {});
  const mapping = f.inputs.reserveResource(descriptor);
  let task: GpuSceneInputPreparation | undefined;
  const work = f.inputs.prepareResourceBuffer(
    [mapping],
    () => true,
    (value) => {
      task = value;
    },
  );
  const create = vi.spyOn(f.device, 'createBuffer');
  try {
    expect(() => {
      for (let step = 0; step < 16; step++) if (work.next().done) break;
    }).toThrow('capacity within device limits');
    expect(create).not.toHaveBeenCalled();
    assert(task);
    for (let step = 0; step < 16; step++) if (task.retirement().unwrap().done) break;
    expect(task.retirement().unwrap().done).toBe(true);
    expect(task.privatePageBytes).toBe(0);
  } finally {
    work.return(undefined as never);
    task?.release();
    create.mockRestore();
    if (limits === undefined) Reflect.deleteProperty(f.device, 'limits');
    else Object.defineProperty(f.device, 'limits', limits);
    mapping.release();
    descriptor.release();
  }
});

it('publishes the prepared native target without RHI work and preserves the same read issuer', async () => {
  const f = await fixture();
  const slot = f.inputs.allocateResource(123);
  // Settle ordinary capacity before beginning the private target.
  const before = f.inputs.capture();
  const old = before.buffer().unwrap();
  before.seal().unwrap();
  const task = f.inputs.prepareBuffer().unwrap();
  expect(f.inputs.prepareBuffer().ok).toBe(false);
  for (let step = 0; step < 10000; step++) {
    f.inputs.arena.writeDescriptorWord(f.row, 4, 0, step + 100);
    const reading = f.inputs.capture();
    expect(reading.buffer().unwrap().buffer).toBe(old.buffer);
    reading.seal().unwrap();
    reading.release();
    if (task.step(64).unwrap().phase === 'current') break;
  }
  expect(task.isCurrent()).toBe(true);
  expect(f.observed.bytes.get(task.buffer)).toEqual(
    new Uint8Array(
      Uint32Array.from({ length: f.inputs.arena.byteLength / 4 }, (_, index) =>
        f.inputs.arena.readWord(index),
      ).buffer,
    ),
  );
  const total = f.inputs.uploadBytes;
  const create = vi.spyOn(f.device, 'createBuffer');
  f.observed.writes.mockClear();
  f.destroy.mockClear();
  f.fence.mockClear();
  task.commitPrepared().unwrap();
  expect(f.observed.writes).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.fence).not.toHaveBeenCalled();
  expect(f.inputs.uploadBytes).toBe(total);
  const preparedBytes = task.inspect().uploadBytes;
  expect(f.inputs.ownsRead(before)).toBe(true);
  expect(f.inputs.readHoldsBuffer(before, old.buffer, old.resourceRoot)).toBe(true);
  expect(task.commitPrepared().ok).toBe(false);
  const after = f.inputs.capture();
  expect(after.resource(slot)).toBe(123);
  expect(after.buffer().unwrap().buffer).toBe(task.buffer);
  after.seal().unwrap();
  expect(f.observed.writes).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === old.buffer)).toHaveLength(0);
  before.release();
  await f.device.queue.onSubmittedWorkDone();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === old.buffer)).toHaveLength(1);
  f.inputs.arena.writeDescriptorWord(f.row, 4, 0, 999);
  const changed = f.inputs.capture();
  changed.buffer().unwrap();
  changed.seal().unwrap();
  expect(f.observed.writes.mock.calls.map((call) => call[4])).toEqual([4]);
  expect(task.inspect().uploadBytes).toBe(preparedBytes);
  changed.release();
  after.release();
  task.release();
  create.mockRestore();
});

it('retires a cancelled candidate without another frame and retains accepted upload accounting', async () => {
  const f = await fixture();
  const total = f.inputs.uploadBytes;
  const task = f.inputs.prepareBuffer().unwrap();
  task.step(64).unwrap();
  task.release();
  task.release();
  expect(task.isCurrent()).toBe(false);
  expect(task.inspect().phase).toBe('released');
  expect(task.commitPrepared().ok).toBe(false);
  expect(f.inputs.uploadBytes - total).toBe(64);
  await f.device.queue.onSubmittedWorkDone();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(1);
  expect(f.inputs.isCurrentBuffer(f.previous.buffer)).toBe(true);
  const retry = f.inputs.prepareBuffer().unwrap();
  finish(retry);
  retry.commitPrepared().unwrap();
  retry.release();
});

it.each([
  'release',
  'dispose',
] as const)('defers candidate retirement until a reentrant %s returns from its native write', async (mode) => {
  const f = await fixture();
  const total = f.inputs.uploadBytes;
  const task = f.inputs.prepareBuffer().unwrap();
  const original = f.observed.writes.getMockImplementation();
  if (original === undefined) throw new Error('Missing queue observer');
  f.observed.writes.mockImplementationOnce((...args) => {
    const result = original(...args);
    if (mode === 'release') task.release();
    else f.inputs.dispose();
    expect(f.fence).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(task.commitPrepared().ok).toBe(false);
    return result;
  });
  expect(task.step(64).ok).toBe(false);
  expect(f.inputs.uploadBytes - total).toBe(64);
  await f.device.queue.onSubmittedWorkDone();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(1);
  expect(task.step(64).ok).toBe(false);
});

it('accounts for a buffer created during reentrant owner disposal', async () => {
  const f = await fixture();
  const original = f.device.createBuffer.bind(f.device);
  const create = vi.spyOn(f.device, 'createBuffer').mockImplementationOnce((descriptor) => {
    const result = original(descriptor);
    f.inputs.dispose();
    return result;
  });
  expect(f.inputs.prepareBuffer().ok).toBe(false);
  const created = create.mock.results[0]?.value;
  expect(created?.ok).toBe(true);
  await f.device.queue.onSubmittedWorkDone();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === created.value)).toHaveLength(1);
  create.mockRestore();
});

it('releases the role after expected or unexpected native creation failure', async () => {
  const f = await fixture();
  const error = new RhiError({
    code: 'internal-error',
    expected: 'a native buffer',
    hint: 'retry',
  });
  const create = vi.spyOn(f.device, 'createBuffer').mockReturnValueOnce(err(error));
  const result = f.inputs.prepareBuffer();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected native creation refusal');
  expect(result.error).toBe(error);
  create.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => f.inputs.prepareBuffer()).toThrow(error);
  const retry = f.inputs.prepareBuffer().unwrap();
  finish(retry);
  retry.release();
  create.mockRestore();
});

it('rejects insufficient candidate capacity and invalidates on ordinary target replacement', async () => {
  const f = await fixture();
  const task = f.inputs.prepareBuffer().unwrap();
  f.inputs.arena.allocateDescriptor(task.byteLength / 4);
  expect(task.step(64).ok).toBe(false);
  expect(task.commitPrepared().ok).toBe(false);
  const reading = f.inputs.capture();
  expect(reading.buffer().unwrap().buffer).not.toBe(f.previous.buffer);
  reading.seal().unwrap();
  reading.release();
  expect(task.inspect().phase).toBe('released');
  await f.device.queue.onSubmittedWorkDone();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(1);
});

it.each([
  'throw',
  'reject',
  'destroy',
  'destroy-error',
] as const)('retains a sticky retirement failure after %s without blindly retrying destruction', async (mode) => {
  const f = await fixture();
  const task = f.inputs.prepareBuffer().unwrap();
  task.step(64).unwrap();
  const cause = new Error(`injected ${mode}`);
  if (mode === 'throw')
    f.fence.mockImplementationOnce(() => {
      throw cause;
    });
  if (mode === 'reject') f.fence.mockRejectedValueOnce(cause);
  if (mode === 'destroy') {
    f.destroy.mockImplementationOnce((buffer) => {
      f.nativeDestroy(buffer);
      throw cause;
    });
  }
  if (mode === 'destroy-error')
    f.destroy.mockReturnValueOnce(
      err(new RhiError({ code: 'internal-error', expected: 'native retirement', hint: 'recover' })),
    );
  task.release();
  await Promise.resolve();
  await Promise.resolve();
  f.controls.failure = true;
  expect(() => f.inputs.capture()).toThrow(AggregateError);
  expect(() => f.inputs.dispose()).toThrow(AggregateError);
  task.release();
  expect(() => f.inputs.dispose()).toThrow(AggregateError);
  await Promise.resolve();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(
    mode.startsWith('destroy') ? 1 : 0,
  );
  expect(() => f.inputs.dispose()).toThrow(AggregateError);
});

it('journals an unaccepted ordinary target when upload and physical cleanup both fail', async () => {
  const f = await fixture();
  f.inputs.arena.allocateDescriptor(f.previous.byteLength / 4);
  const error = new RhiError({ code: 'internal-error', expected: 'an upload', hint: 'recover' });
  f.observed.injectFailure(1, false, error);
  f.destroy.mockReturnValueOnce(err(error));
  const create = vi.spyOn(f.device, 'createBuffer');
  const frame = f.inputs.capture();
  expect(frame.buffer().ok).toBe(false);
  frame.release();
  const target = create.mock.results[0]?.value;
  expect(target?.ok).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  f.controls.failure = true;
  expect(() => f.inputs.dispose()).toThrow(AggregateError);
  expect(() => f.inputs.dispose()).toThrow(AggregateError);
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === target.value)).toHaveLength(1);
  create.mockRestore();
});

it.each([
  'failure',
  'dispose',
] as const)('rejects growth before allocation after cancellation causes %s', async (mode) => {
  const f = await fixture();
  const task = f.inputs.prepareBuffer().unwrap();
  f.inputs.arena.allocateDescriptor(task.byteLength / 4);
  f.fence.mockImplementationOnce(() => {
    if (mode === 'failure') throw new Error('injected fence failure');
    f.inputs.dispose();
    return f.nativeFence();
  });
  const create = vi.spyOn(f.device, 'createBuffer');
  const frame = f.inputs.capture();
  expect(frame.buffer().ok).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(task.isCurrent()).toBe(false);
  frame.release();
  f.controls.failure = mode === 'failure';
  create.mockRestore();
});

it.each([
  'existing',
  'fresh',
] as const)('rejects ordinary %s upload after callback disposal and defers its native retirement', async (mode) => {
  const f = await fixture();
  f.frame.release();
  if (mode === 'fresh') f.inputs.arena.allocateDescriptor(f.previous.byteLength / 4);
  else f.inputs.arena.writeDescriptorWord(f.row, 4, 0, 23);
  const original = f.observed.writes.getMockImplementation();
  if (original === undefined) throw new Error('Missing native queue observer');
  f.observed.writes.mockImplementationOnce((...args) => {
    const result = original(...args);
    f.inputs.dispose();
    expect(f.fence).not.toHaveBeenCalled();
    return result;
  });
  const frame = f.inputs.capture();
  expect(frame.buffer().ok).toBe(false);
  frame.release();
  await f.nativeFence();
  await Promise.resolve();
  expect(f.destroy.mock.calls.filter(([buffer]) => buffer === f.previous.buffer)).toHaveLength(1);
});

it('rejects ordinary publication when retiring its predecessor disposes the owner', async () => {
  const f = await fixture();
  f.frame.release();
  f.inputs.arena.allocateDescriptor(f.previous.byteLength / 4);
  f.fence.mockImplementationOnce(() => {
    f.inputs.dispose();
    return f.nativeFence();
  });
  const frame = f.inputs.capture();
  const result = frame.buffer();
  expect(result.ok).toBe(false);
  frame.release();
  await f.nativeFence();
});

it('rejects ordinary capacity after a predecessor retirement callback grows the backing', async () => {
  const f = await fixture();
  f.frame.release();
  f.inputs.arena.allocateDescriptor(f.previous.byteLength / 4);
  f.fence.mockImplementationOnce(() => {
    f.inputs.arena.allocateDescriptor(f.inputs.arena.byteLength / 4);
    return f.nativeFence();
  });
  const frame = f.inputs.capture();
  expect(frame.buffer().ok).toBe(false);
  frame.release();
  const next = f.inputs.capture();
  expect(next.buffer().unwrap().byteLength).toBeGreaterThanOrEqual(f.inputs.arena.byteLength);
  next.seal().unwrap();
  next.release();
});

it('rejects activation after cancellation faults its actual Inputs owner', async () => {
  const f = await fixture();
  f.inputs.prepareBuffer().unwrap();
  f.fence.mockImplementationOnce(() => {
    throw new Error('injected fence failure');
  });
  f.controls.failure = true;
  expect(() => f.inputs.activate()).toThrow(AggregateError);
});

it.each([
  'existing',
  'fresh',
] as const)('rejects insufficient ordinary %s capacity after a native write callback grows the backing', async (mode) => {
  const f = await fixture();
  if (mode === 'fresh') f.inputs.arena.allocateDescriptor(f.previous.byteLength / 4);
  else f.inputs.arena.writeDescriptorWord(f.row, 4, 0, 23);
  const original = f.observed.writes.getMockImplementation();
  if (original === undefined) throw new Error('Missing native queue observer');
  f.observed.writes.mockImplementationOnce((...args) => {
    const result = original(...args);
    f.inputs.arena.allocateDescriptor(f.inputs.arena.byteLength / 4);
    return result;
  });
  const frame = f.inputs.capture();
  expect(frame.buffer().ok).toBe(false);
  frame.release();
  const next = f.inputs.capture();
  expect(next.buffer().unwrap().byteLength).toBeGreaterThanOrEqual(f.inputs.arena.byteLength);
  next.seal().unwrap();
  next.release();
});

it('keeps late child retirement failure observable through the actual disposed Scene owner', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const created = GpuScene.create(device, 256).unwrap();
  if (created.status !== 'available') throw new Error('Null fixture must support storage');
  const scene = created.scene;
  const held = scene.inputs.capture();
  const target = held.buffer().unwrap().buffer;
  held.seal().unwrap();
  const disposeInputs = vi.spyOn(scene.inputs, 'dispose');
  scene.dispose();
  const original = device.destroyBuffer.bind(device);
  const error = new RhiError({
    code: 'internal-error',
    expected: 'native retirement',
    hint: 'recover',
  });
  const destroy = vi
    .spyOn(device, 'destroyBuffer')
    .mockImplementation((buffer) => (buffer === target ? err(error) : original(buffer)));
  try {
    held.release();
    expect(scene.inputs.lifetimeFailure).toBeInstanceOf(AggregateError);
    expect(() => scene.dispose()).toThrow(AggregateError);
    expect(() => scene.dispose()).toThrow(AggregateError);
    expect(destroy.mock.calls.filter(([buffer]) => buffer === target)).toHaveLength(1);
    expect(disposeInputs).toHaveBeenCalledTimes(1);
  } finally {
    disposeInputs.mockRestore();
    destroy.mockRestore();
    original(target).unwrap();
  }
});

it('propagates a late rejected child fence without replaying disposal or native cleanup', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const created = GpuScene.create(device, 256).unwrap();
  if (created.status !== 'available') throw new Error('Null fixture must support storage');
  const scene = created.scene;
  const task = scene.inputs.prepareBuffer().unwrap();
  task.step(64).unwrap();
  let rejectFence: ((cause: unknown) => void) | undefined;
  const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValueOnce(
    new Promise<undefined>((_, reject) => {
      rejectFence = reject;
    }),
  );
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const disposeInputs = vi.spyOn(scene.inputs, 'dispose');
  const cause = new Error('injected late rejected fence');
  try {
    task.release();
    scene.dispose();
    expect(disposeInputs).toHaveBeenCalledTimes(1);
    if (rejectFence === undefined) throw new Error('Missing actual retirement fence');
    rejectFence(cause);
    await Promise.resolve();
    await Promise.resolve();
    const failure = scene.inputs.lifetimeFailure;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure?.errors).toContain(cause);
    for (let retry = 0; retry < 2; retry++) {
      let raised: unknown;
      try {
        scene.dispose();
      } catch (error) {
        raised = error;
      }
      expect(raised).toBe(failure);
    }
    expect(disposeInputs).toHaveBeenCalledTimes(1);
    expect(destroy.mock.calls.filter(([buffer]) => buffer === task.buffer)).toHaveLength(0);
  } finally {
    fence.mockRestore();
    destroy.mockRestore();
    disposeInputs.mockRestore();
    device.destroyBuffer(task.buffer).unwrap();
  }
});
