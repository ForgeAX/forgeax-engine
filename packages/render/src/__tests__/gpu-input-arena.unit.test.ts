import { mat4 } from '@forgeax/engine-math';
import { err, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { GpuInputDescriptorReservation } from '../gpu-input-arena';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene } from '../gpu-scene';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { RenderScene } from '../scene/render-scene';
import { SkinInputs } from '../scene/skin-inputs';
import { StableRangeAllocator } from '../stable-range-allocator';
import { receiptRow } from './gpu-draw-selection-fixture';

async function device(): Promise<RhiDevice> {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

it('releases only the unused numeric tail without relocating a survivor or private reservation', () => {
  const arena = new GpuInputArena(4 * 1024 * 1024);
  const survivor = arena.allocateDescriptor(8);
  const bulk = arena.allocateDescriptor(65536);
  const reservation = arena.reserveDescriptor(32, (address, data) =>
    data.setUint32(0, address, true),
  );
  const peak = arena.byteLength;
  arena.writeDescriptorWord(survivor, 8, 7, 456);
  expect(() => arena.allocateDescriptor(arena.byteLimit / 4 + 1)).toThrow();
  arena.releaseDescriptor(bulk, 65536);
  arena.reclaimTail();
  expect(arena.byteLength).toBe(peak);
  expect(reservation.readWord(0)).toBe(reservation.address);
  reservation.release();
  arena.reclaimTail();
  expect(arena.byteLength).toBe(1024);
  expect(arena.readWord(survivor + 7)).toBe(456);
  for (let i = 0; i < 4; i++) {
    const temporary = arena.allocateDescriptor(65536);
    expect(temporary).toBe(bulk);
    arena.releaseDescriptor(temporary, 65536);
    arena.reclaimTail();
    expect(arena.byteLength).toBe(1024);
    expect(arena.readWord(survivor + 7)).toBe(456);
  }
  arena.releaseDescriptor(survivor, 8);
  arena.dispose();
});

it.each([
  { count: 12, words: 8, bytes: 1024 },
  { count: 8, words: 4096, bytes: 262144 },
])('hands off a $bytes-byte Inputs buffer while an old reader is held', async ({
  count,
  words,
  bytes,
}) => {
  const target = await device();
  const inputs = new GpuSceneInputs(target);
  const arena = inputs.arena;
  const survivors = Array.from({ length: count }, () => arena.allocateDescriptor(words));
  const tail = arena.allocateDescriptor(524288);
  const oldRead = inputs.capture();
  const old = oldRead.buffer().unwrap();
  oldRead.seal().unwrap();
  const destroyed = vi.spyOn(target, 'destroyBuffer');
  try {
    arena.releaseDescriptor(tail, 524288);
    for (let frame = 0; frame < 8; frame++) {
      const read = inputs.capture();
      try {
        for (const address of survivors)
          arena.writeDescriptorWord(address, words, frame, frame + 1);
        read.buffer().unwrap();
        read.seal().unwrap();
        inputs.reclaimSubmittedCapacity();
      } finally {
        read.release();
      }
    }
    const current = inputs.uploadedBuffer();
    expect(current?.buffer).not.toBe(old.buffer);
    expect(current?.byteLength).toBe(bytes);
    expect(arena.byteLength).toBe(bytes);
    for (const address of survivors) expect(arena.readWord(address)).toBe(1);
    expect(destroyed).not.toHaveBeenCalled();
    oldRead.release();
    await target.queue.onSubmittedWorkDone();
    await Promise.resolve();
    expect(destroyed).toHaveBeenCalledWith(old.buffer);
  } finally {
    oldRead.release();
    inputs.dispose();
    destroyed.mockRestore();
  }
});

it('lets source preparation supersede contraction and never revokes its active input buffer', async () => {
  const target = await device();
  const inputs = new GpuSceneInputs(target);
  const arena = inputs.arena;
  const tail = arena.allocateDescriptor(65536);
  const read = inputs.capture();
  const original = read.buffer().unwrap();
  read.seal().unwrap();
  try {
    arena.releaseDescriptor(tail, 65536);
    inputs.reclaimSubmittedCapacity();
    const source = inputs.prepareBuffer().unwrap();
    try {
      expect(inputs.isCurrentBuffer(original.buffer)).toBe(true);
      expect(source.step(1024).unwrap().phase).toBe('current');
      inputs.reclaimSubmittedCapacity();
      expect(source.isCurrent()).toBe(true);
      source.commitPrepared().unwrap();
      expect(inputs.isCurrentBuffer(source.buffer)).toBe(true);
    } finally {
      source.release();
    }
  } finally {
    read.release();
    inputs.dispose();
  }
});

it('owns private descriptor words without changing active bytes, dirty work or ordinary capacity', async () => {
  const target = await device();
  const arena = new GpuInputArena(65536);
  const address = arena.allocateDescriptor(4);
  arena.writeDescriptorWord(address, 4, 0, 7);
  const upload = arena.connect();
  upload.activate();
  const buffer = target
    .createBuffer({ size: 65536, usage: 128 | 8, mappedAtCreation: false })
    .unwrap();
  upload.flush(target.queue, buffer, true).unwrap();
  const bytes = arena.byteLength;
  const before = Array.from({ length: bytes / 4 }, (_, index) => arena.readWord(index));
  let borrowed: DataView | undefined;
  const row = arena.reserveDescriptor(512, (physical, scratch) => {
    borrowed = scratch;
    scratch.setUint32(0, physical, true);
    scratch.setUint32(4, 91, true);
  });
  borrowed?.setUint32(4, 17, true);
  const writes = vi.spyOn(target.queue, 'writeBuffer');
  try {
    expect(arena.byteLength).toBe(bytes);
    expect(Array.from({ length: bytes / 4 }, (_, index) => arena.readWord(index))).toEqual(before);
    expect(row.readWord(0)).toBe(row.address);
    expect(row.readWord(1)).toBe(91);
    upload.flush(target.queue, buffer, false).unwrap();
    expect(writes).not.toHaveBeenCalled();
    row.release();
    expect(row.isCurrent()).toBe(false);
    expect(() => row.readWord(0)).toThrow();
    expect(arena.allocateDescriptor(512)).toBe(row.address);
  } finally {
    row.release();
    upload.release();
    arena.dispose();
    target.destroyBuffer(buffer).unwrap();
    writes.mockRestore();
  }
});

it('rolls back an initializer failure and refuses descriptor resurrection after disposal', () => {
  const arena = new GpuInputArena(4096);
  expect(() =>
    arena.reserveDescriptor(4, () => {
      throw new Error('initializer');
    }),
  ).toThrow('initializer');
  const first = arena.reserveDescriptor(4, () => undefined);
  expect(first.address).toBe(1);
  first.release();
  expect(() => arena.reserveDescriptor(4, () => arena.dispose())).toThrow();
  expect(first.isCurrent()).toBe(false);
});

it('transfers descriptor custody before initialization and retains an unknown rollback without retry', () => {
  const arena = new GpuInputArena(4096);
  const ranges = (arena as unknown as { ranges: StableRangeAllocator }).ranges;
  const release = ranges.release.bind(ranges);
  const failure = new Error('unknown private range release');
  const retire = vi.spyOn(ranges, 'release').mockImplementation((start, count) => {
    release(start, count);
    throw failure;
  });
  let captured: GpuInputDescriptorReservation | undefined;
  try {
    expect(() =>
      arena.reserveDescriptor(
        4,
        () => {
          throw new Error('initializer');
        },
        (value) => {
          captured = value;
        },
      ),
    ).toThrow('rollback failed');
    expect(captured).toBeDefined();
    expect(captured?.isCurrent()).toBe(false);
    expect(arena.live).toBe(false);
    expect(() => captured?.release()).toThrow(failure);
    expect(retire).toHaveBeenCalledOnce();
  } finally {
    retire.mockRestore();
    arena.dispose();
  }
});

it('serves complete CPU Skin demand without a device, upload or GPU Scene', () => {
  const arena = new GpuInputArena(65536),
    skin = new SkinInputs(arena),
    source = skin.source();
  const identity = mat4.identity(mat4.create());
  const skeleton = skin.skeleton(1, identity);
  const world = mat4.identity(mat4.create());
  world[12] = 9;
  skin.setJoint(source, 7, world);
  skin.bind(0, source, skeleton, new Uint32Array([7]));
  const frame = skin.capture();
  try {
    expect(frame.available(0)).toBe(true);
    const out = mat4.create();
    expect(frame.matrix(0, 0, out)).toBe(true);
    expect(out[12]).toBe(9);
  } finally {
    frame.release();
    skin.dispose();
    arena.dispose();
  }
});

it('keeps independent dirty populations and retries after a candidate upload fails', async () => {
  const a = await device(),
    b = await device(),
    arena = new GpuInputArena(65536);
  const inputsA = new GpuSceneInputs(a, (slot) => slot, arena);
  const inputsB = new GpuSceneInputs(b, (slot) => slot, arena);
  inputsA.activate();
  const address = arena.allocateDescriptor(1);
  const writesA = vi.spyOn(a.queue, 'writeBuffer'),
    writesB = vi.spyOn(b.queue, 'writeBuffer');
  const initial = inputsA.capture();
  initial.buffer().unwrap();
  initial.seal().unwrap();
  initial.release();
  const next = inputsB.capture();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected candidate upload failure',
    hint: 'retry',
  });
  writesB.mockReturnValueOnce(err(failure));
  arena.writeDescriptorWord(address, 1, 0, 17);
  try {
    const rejected = next.buffer();
    if (rejected.ok) throw new Error('Candidate upload must fail');
    expect(rejected.error).toBe(failure);
    const retried = next.buffer().unwrap();
    next.seal().unwrap();
    next.release();
    expect(retried.byteLength).toBe(arena.byteLength);
    writesA.mockClear();
    const current = inputsA.capture();
    current.buffer().unwrap();
    current.seal().unwrap();
    current.release();
    expect(
      writesA.mock.calls.map(([, offset, data, start = 0, size]) => [
        offset,
        Array.from(
          new Uint32Array(
            data instanceof ArrayBuffer ? data : data.buffer,
            (data instanceof ArrayBuffer ? 0 : data.byteOffset) + start,
            (size ?? data.byteLength - start) / 4,
          ),
        ),
      ]),
    ).toEqual([[address * 4, [17]]]);
    inputsB.dispose();
    arena.writeDescriptorWord(address, 1, 0, 23);
    const after = inputsA.capture();
    after.buffer().unwrap();
    after.seal().unwrap();
    after.release();
    expect(arena.readWord(address)).toBe(23);
  } finally {
    next.release();
    writesA.mockRestore();
    writesB.mockRestore();
    inputsA.dispose();
    inputsB.dispose();
    arena.releaseDescriptor(address, 1);
    arena.dispose();
  }
});

it('never shares physical member memoization across device incarnations', async () => {
  const arena = new GpuInputArena(65536),
    a = await device(),
    b = await device();
  const inputsA = new GpuSceneInputs(a, (slot) => slot + 10, arena);
  const inputsB = new GpuSceneInputs(b, (slot) => slot + 1000, arena);
  const scene = new RenderScene();
  scene.reset([receiptRow().source]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const plan = topology.sourcePlan(),
    batch = plan.batches.at(0);
  if (plan.sourceGroups === undefined || batch === undefined)
    throw new Error('Missing source fixture');
  inputsA.adoptSources(plan.sourceGroups);
  inputsB.adoptSources(plan.sourceGroups);
  const frameA = inputsA.capture(),
    frameB = inputsB.capture();
  try {
    const rowA = frameA.members(batch.candidates),
      rowB = frameB.members(batch.candidates);
    expect(rowA).not.toBe(rowB);
    expect(arena.readWord(arena.readWord(rowA + 4) + 1)).toBe(10);
    expect(arena.readWord(arena.readWord(rowB + 4) + 1)).toBe(1000);
    inputsB.dispose();
    expect(arena.readWord(arena.readWord(rowA + 4) + 1)).toBe(10);
  } finally {
    frameA.release();
    frameB.release();
    inputsA.dispose();
    inputsB.dispose();
    arena.dispose();
  }
});

it('records each known write once regardless of detached upload count', async () => {
  const arena = new GpuInputArena(65536),
    dev = await device();
  const inputs = Array.from({ length: 16 }, () => new GpuSceneInputs(dev, (slot) => slot, arena));
  inputs[0]?.activate();
  const row = arena.allocateDescriptor(1);
  const original = Map.prototype.set;
  let dirtyWrites = 0;
  const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (
      key === row &&
      (value as { start?: number; end?: number })?.start === row &&
      (value as { end?: number })?.end === row + 1
    )
      dirtyWrites++;
    return original.call(this, key, value);
  });
  try {
    arena.writeDescriptorWord(row, 1, 0, 17);
    expect(dirtyWrites).toBe(1);
  } finally {
    set.mockRestore();
    for (const input of inputs) input.dispose();
    arena.releaseDescriptor(row, 1);
    arena.dispose();
  }
});

it('counts successful bytes even if a later incremental write fails', async () => {
  const dev = await device(),
    arena = new GpuInputArena(65536),
    inputs = new GpuSceneInputs(dev, (slot) => slot, arena);
  inputs.activate();
  // A spacer beyond the coalescing gap keeps two independent queue writes.
  const first = arena.allocateDescriptor(1);
  arena.allocateDescriptor(128);
  const second = arena.allocateDescriptor(1);
  const base = inputs.capture();
  base.buffer().unwrap();
  base.seal().unwrap();
  base.release();
  const before = inputs.uploadBytes;
  arena.writeDescriptorWord(first, 1, 0, 3);
  arena.writeDescriptorWord(second, 1, 0, 5);
  const original = dev.queue.writeBuffer.bind(dev.queue);
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected second upload failure',
    hint: 'retry',
  });
  const write = vi
    .spyOn(dev.queue, 'writeBuffer')
    .mockImplementationOnce(original)
    .mockReturnValueOnce(err(failure));
  const frame = inputs.capture();
  try {
    expect(frame.buffer().ok).toBe(false);
    expect(inputs.uploadBytes - before).toBe(4);
    frame.buffer().unwrap();
    frame.seal().unwrap();
    expect(inputs.uploadBytes - before).toBe(12);
  } finally {
    write.mockRestore();
    frame.release();
    inputs.dispose();
    arena.releaseDescriptor(first, 1);
    arena.releaseDescriptor(second, 1);
    arena.dispose();
  }
});

it('transfers incremental authority only at acceptance and old retirement cannot clear new changes', async () => {
  const arena = new GpuInputArena(65536),
    a = await device(),
    b = await device();
  const inputsA = new GpuSceneInputs(a, (slot) => slot, arena),
    inputsB = new GpuSceneInputs(b, (slot) => slot, arena);
  inputsA.activate();
  const row = arena.allocateDescriptor(1);
  const old = inputsA.capture();
  old.buffer().unwrap();
  old.seal().unwrap();
  const candidate = inputsB.capture();
  candidate.buffer().unwrap();
  candidate.seal().unwrap();
  const before = inputsB.uploadBytes;
  inputsB.activate();
  const accepted = inputsB.capture();
  accepted.buffer().unwrap();
  accepted.seal().unwrap();
  accepted.release();
  expect(inputsB.uploadBytes - before).toBe(arena.byteLength);
  arena.writeDescriptorWord(row, 1, 0, 29);
  inputsA.dispose();
  const deltaBefore = inputsB.uploadBytes;
  const next = inputsB.capture();
  next.buffer().unwrap();
  next.seal().unwrap();
  next.release();
  expect(inputsB.uploadBytes - deltaBefore).toBe(4);
  old.release();
  candidate.release();
  inputsB.dispose();
  arena.releaseDescriptor(row, 1);
  arena.dispose();
});

it('continues page and buffer retirement after a held read releases a failed range', async () => {
  const arena = new GpuInputArena(65536),
    dev = await device(),
    inputs = new GpuSceneInputs(dev, (slot) => slot, arena);
  inputs.allocateResource(0);
  const frame = inputs.capture();
  frame.buffer().unwrap();
  frame.seal().unwrap();
  const destroy = vi.spyOn(dev, 'destroyBuffer');
  inputs.dispose();
  const cause = new Error('injected free range failure');
  const original = StableRangeAllocator.prototype.release;
  let frees = 0;
  const release = vi.spyOn(StableRangeAllocator.prototype, 'release').mockImplementation(function (
    this: StableRangeAllocator,
    start,
    count,
  ) {
    if (count === 256 && ++frees === 1) throw cause;
    return original.call(this, start, count);
  });
  try {
    expect(() => frame.release()).toThrow();
    expect(frees).toBe(4);
    frame.release();
    expect(frees).toBe(4);
    expect(() => arena.allocateDescriptor(1)).toThrow();
    await dev.queue.onSubmittedWorkDone();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(() => inputs.capture()).toThrow(AggregateError);
    expect(() => inputs.dispose()).toThrow(AggregateError);
  } finally {
    release.mockRestore();
    destroy.mockRestore();
    frame.release();
    expect(() => inputs.dispose()).toThrow(AggregateError);
    arena.dispose();
  }
});

it('retires all independent Scene owners exactly once after one Version release fails', async () => {
  const arena = new GpuInputArena(65536),
    dev = await device();
  const created = GpuScene.create(dev, 256, undefined, arena).unwrap();
  if (created.status !== 'available') throw new Error('Null fixture must support storage');
  const scene = created.scene,
    projection = new RenderScene(),
    source = receiptRow().source;
  scene
    .sync(projection.apply([{ kind: 'update', entityKey: source.entityKey, snapshot: source }]))
    .unwrap();
  const descriptor = scene.materialIndexForResource(source.material);
  if (descriptor === undefined) throw new Error('Missing live material Version');
  const buffers = [
    scene.primitiveBuffer,
    scene.instanceBuffer,
    scene.transformBuffer,
    scene.materialBuffer,
  ];
  const disposeInputs = vi.spyOn(scene.inputs, 'dispose'),
    destroy = vi.spyOn(dev, 'destroyBuffer');
  const cause = new Error('injected material retirement failure');
  const original = StableRangeAllocator.prototype.release;
  let failures = 0;
  const release = vi.spyOn(StableRangeAllocator.prototype, 'release').mockImplementation(function (
    this: StableRangeAllocator,
    start,
    count,
  ) {
    if (start === descriptor && count === 3) {
      failures++;
      throw cause;
    }
    return original.call(this, start, count);
  });
  try {
    expect(() => scene.dispose()).toThrow(expect.objectContaining({ cause, errors: [cause] }));
    expect(disposeInputs).toHaveBeenCalledTimes(1);
    expect(failures).toBe(1);
    expect(() => scene.dispose()).toThrow(expect.objectContaining({ cause, errors: [cause] }));
    expect(failures).toBe(1);
    expect(disposeInputs).toHaveBeenCalledTimes(1);
    expect(() => arena.allocateDescriptor(1)).toThrow();
    await dev.queue.onSubmittedWorkDone();
    for (const buffer of buffers)
      expect(destroy.mock.calls.filter(([value]) => value === buffer)).toHaveLength(1);
    expect(new Set(destroy.mock.calls.map(([buffer]) => buffer)).size).toBe(
      destroy.mock.calls.length,
    );
  } finally {
    release.mockRestore();
    disposeInputs.mockRestore();
    destroy.mockRestore();
    expect(() => scene.dispose()).toThrow(AggregateError);
    arena.dispose();
  }
});

it('rejects a smaller device upload without invalidating shared CPU pose facts or the active incarnation', async () => {
  const arena = new GpuInputArena(65536),
    a = await device(),
    b = await device();
  vi.spyOn(b, 'limits', 'get').mockReturnValue({
    ...b.limits,
    maxStorageBufferBindingSize: 8192,
    maxBufferSize: 8192,
  });
  const active = new GpuSceneInputs(a, (slot) => slot, arena);
  const candidate = new GpuSceneInputs(b, (slot) => slot, arena);
  active.activate();
  const skin = new SkinInputs(arena),
    source = skin.source();
  const identity = mat4.identity(mat4.create()),
    skeleton = skin.skeleton(1, identity);
  skin.setJoint(source, 7, identity);
  skin.bind(0, source, skeleton, new Uint32Array([7]));
  const fixed = skin.capture(),
    rejected = candidate.capture();
  try {
    expect(arena.byteLength).toBeGreaterThan(8192);
    expect(rejected.buffer().ok).toBe(false);
    rejected.release();
    candidate.dispose();
    const out = mat4.create();
    expect(fixed.matrix(0, 0, out)).toBe(true);
    expect(Array.from(out)).toEqual(Array.from(identity));
    const accepted = active.capture();
    try {
      accepted.buffer().unwrap();
      accepted.seal().unwrap();
    } finally {
      accepted.release();
    }
    const next = skin.capture();
    expect(next.available(0)).toBe(true);
    next.release();
  } finally {
    rejected.release();
    fixed.release();
    skin.dispose();
    candidate.dispose();
    active.dispose();
    arena.dispose();
  }
});

it('writes a checked suffix under its full allocation owner and rejects partial mutations', async () => {
  const arena = new GpuInputArena(65536),
    gpu = await device(),
    upload = arena.connect();
  const created = gpu
    .createBuffer({ size: arena.byteLength, usage: 0x88, mappedAtCreation: false })
    .unwrap();
  const writes = vi.spyOn(gpu.queue, 'writeBuffer');
  const address = arena.allocateDescriptor(4),
    data = new DataView(new Uint32Array([7, 9]).buffer);
  upload.activate();
  try {
    upload.flush(gpu.queue, created, true).unwrap();
    writes.mockClear();
    arena.writeDescriptorWord(address, 4, 0, 13);
    arena.writeDescriptor(address, data, 4, 2);
    expect(arena.readWord(address)).toBe(13);
    expect(arena.readWord(address + 2)).toBe(7);
    expect(arena.readWord(address + 3)).toBe(9);
    const before = Array.from({ length: 4 }, (_, index) => arena.readWord(address + index));
    for (const index of [-1, NaN, 0.5, 4, 5])
      expect(() => arena.writeDescriptor(address, data, 4, index)).toThrow();
    expect(() => arena.writeDescriptor(address, new DataView(new ArrayBuffer(4)), 4, 2)).toThrow();
    expect(Array.from({ length: 4 }, (_, index) => arena.readWord(address + index))).toEqual(
      before,
    );
    upload.flush(gpu.queue, created, false).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toBe(address * 4);
    expect(writes.mock.calls[0]?.[4]).toBe(16);
    writes.mockClear();
    data.setUint32(0, 11, true);
    arena.writeDescriptor(address, data, 4, 2);
    upload.flush(gpu.queue, created, false).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toBe((address + 2) * 4);
    expect(writes.mock.calls[0]?.[4]).toBe(8);
    writes.mockClear();
    arena.writeDescriptorWord(address, 4, 1, 97);
    upload.flush(gpu.queue, created, false).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toBe((address + 1) * 4);
    expect(writes.mock.calls[0]?.[4]).toBe(4);
    writes.mockClear();
    data.setUint32(0, 17, true);
    arena.writeDescriptor(address, data, 4, 2);
    arena.releaseDescriptor(address, 4);
    upload.flush(gpu.queue, created, false).unwrap();
    expect(writes).not.toHaveBeenCalled();
  } finally {
    writes.mockRestore();
    upload.release();
    arena.dispose();
    gpu.destroyBuffer(created);
  }
});

it('coalesces nearby known changes into address-ordered queue writes of current words', async () => {
  const dev = await device(),
    arena = new GpuInputArena(65536),
    inputs = new GpuSceneInputs(dev, (slot) => slot, arena);
  inputs.activate();
  const rows = Array.from({ length: 6 }, () => arena.allocateDescriptor(17));
  arena.allocateDescriptor(256);
  const far = arena.allocateDescriptor(17);
  const base = inputs.capture();
  base.buffer().unwrap();
  base.seal().unwrap();
  base.release();
  // Reverse edit order and a skipped neighbour still produce ordered ranges.
  for (const row of [rows[5], rows[1], rows[0], rows[3], far])
    arena.writeDescriptorWord(row as number, 17, 4, 9);
  const write = vi.spyOn(dev.queue, 'writeBuffer');
  const frame = inputs.capture();
  try {
    frame.buffer().unwrap();
    frame.seal().unwrap();
    expect(write.mock.calls.map((call) => [call[1], call[4]])).toEqual([
      [((rows[0] as number) + 4) * 4, ((rows[5] as number) - (rows[0] as number) + 1) * 4],
      [(far + 4) * 4, 4],
    ]);
  } finally {
    write.mockRestore();
    frame.release();
  }
});
