import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { SkinInputFrame, SkinInputs } from '../scene/skin-inputs';
import { StableRangeAllocator } from '../stable-range-allocator';

const world = (x: number) => {
  const m = mat4.identity(mat4.create());
  m[12] = x;
  return m;
};
async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const arena = inputs.arena;
  const skin = new SkinInputs(arena);
  const source = skin.source();
  return { device, inputs, arena, skin, source };
}

it('resolves equal full entity identities in separate source namespaces from one root', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const other = skin.source();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  skin.setJoint(other, 7, world(9));
  skin.bind(11, source, skeleton, new Uint32Array([7]));
  skin.bind(27, other, skeleton, new Uint32Array([7]));
  const frame = skin.capture();
  try {
    const out = mat4.create(),
      inverse = mat4.create();
    expect(frame.available(11)).toBe(true);
    expect(frame.available(27)).toBe(true);
    expect(frame.matrix(11, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(frame.matrix(27, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(10);
    expect(() => Object.defineProperty(frame, 'root', { value: 0 })).toThrow();
    expect(() => Object.defineProperty(source, 'id', { value: other.id })).toThrow();
    expect(() => skin.setJoint({ id: source.id, kind: 'source' }, 7, world(0))).toThrow();
    expect(() => frame.matrix(11, 0, out, out)).toThrow();
  } finally {
    frame.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('owns unqueried Binding and Skeleton bytes through removal and Scene-slot reuse', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  skin.bind(11, source, skeleton, new Uint32Array([7]));
  const old = skin.capture(); // No per-binding CPU admission or pin.
  skin.unbind(11);
  skin.remove(skeleton);
  const nextSkeleton = skin.skeleton(1, world(9));
  skin.bind(11, source, nextSkeleton, new Uint32Array([7]));
  const next = skin.capture();
  try {
    const out = mat4.create(),
      inverse = mat4.create();
    expect(old.matrix(11, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(next.matrix(11, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(12);
    expect(next.historyCompatible(old, 11)).toBe(false);
    expect(nextSkeleton.id).not.toBe(skeleton.id);
    next.release();
    expect(old.available(11)).toBe(true);
  } finally {
    old.release();
    next.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it.each([
  1, 64, 1024,
])('updates shared facts without querying or rewriting %i bindings', async (count) => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  for (let slot = 0; slot < count; slot++) skin.bind(slot, source, skeleton, new Uint32Array([7]));
  const old = skin.capture();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  const query = vi.spyOn(SkinInputFrame.prototype, 'available');
  try {
    skin.setJoint(source, 7, world(5));
    expect(allocate.mock.calls.map(([words]) => words)).toEqual([17, ...Array(8).fill(256)]);
    allocate.mockClear();
    skin.updateSkeleton(skeleton, 1, world(2));
    expect(allocate.mock.calls.map(([words]) => words)).toEqual([18, ...Array(8).fill(256)]);
    expect(query).not.toHaveBeenCalled();
    const next = skin.capture();
    expect(allocate.mock.calls).toHaveLength(9); // Root capture does not enumerate/pin rows.
    const out = mat4.create(),
      inverse = mat4.create();
    expect(old.matrix(count - 1, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(next.matrix(count - 1, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(7);
    next.release();
  } finally {
    allocate.mockRestore();
    query.mockRestore();
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('copies an eight-level held path once per edited page and allocates nothing for equal writes', async () => {
  const { inputs, arena, skin, source } = await fixture();
  for (let i = 0; i < 256; i++) skin.setJoint(source, i, world(i));
  const old = skin.capture();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  try {
    skin.setJoint(source, 0, world(0));
    expect(allocate).not.toHaveBeenCalled();
    for (let i = 0; i < 256; i++) skin.setJoint(source, i, world(i + 1000));
    expect(allocate.mock.calls.filter(([words]) => words === 256)).toHaveLength(8);
    expect(allocate.mock.calls.filter(([words]) => words === 17)).toHaveLength(256);
    const next = skin.capture();
    const out = mat4.create();
    for (let i = 0; i < 256; i++) {
      expect(old.readJoint(source, i, out)).toBe(true);
      expect(out[12]).toBe(i);
      expect(next.readJoint(source, i, out)).toBe(true);
      expect(out[12]).toBe(i + 1000);
    }
    next.release();
  } finally {
    allocate.mockRestore();
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it.each([
  1, 2, 3, 4, 5, 6, 7, 8, 9,
])('rolls back allocation failure %i on an owning eight-level path', async (step) => {
  const { inputs, arena, skin, source } = await fixture();
  skin.setJoint(source, 7, world(1));
  const old = skin.capture();
  const actual = arena.allocateDescriptor.bind(arena);
  let calls = 0;
  const cause = new Error('path allocation failed');
  const allocate = vi.spyOn(arena, 'allocateDescriptor').mockImplementation((words) => {
    if (++calls === step) throw cause;
    return actual(words);
  });
  try {
    expect(() => skin.setJoint(source, 7, world(2))).toThrow(cause);
    allocate.mockRestore();
    const current = skin.capture();
    expect(current.root).toBe(old.root);
    current.release();
    skin.setJoint(source, 7, world(3));
    const next = skin.capture();
    const out = mat4.create();
    expect(next.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(3);
    expect(old.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(1);
    next.release();
  } finally {
    allocate.mockRestore();
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('keeps namespace identities leased by unqueried fixed facts and recycles only after retirement', async () => {
  const { inputs, arena, skin, source } = await fixture();
  skin.setJoint(source, 7, world(1));
  const old = skin.capture();
  skin.remove(source);
  const other = skin.source();
  try {
    expect(other.id).not.toBe(source.id);
    const out = mat4.create();
    expect(old.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(1);
    const current = skin.capture();
    expect(current.readJoint(source, 7, out)).toBe(false);
    current.release();
    old.release();
    const reused = skin.source();
    expect(reused.id).toBe(source.id);
    skin.setJoint(reused, 7, world(8));
    const next = skin.capture();
    expect(next.readJoint(reused, 7, out)).toBe(true);
    expect(out[12]).toBe(8);
    next.release();
  } finally {
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('retains complete ordered duplicate influences and recovers without rebinding after joint loss', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(2, new Float32Array([...world(1), ...world(2)]));
  skin.setJoint(source, 7, world(3));
  skin.bind(0, source, skeleton, new Uint32Array([7, 7]));
  const old = skin.capture();
  const out = mat4.create(),
    inverse = mat4.create();
  try {
    expect(old.matrix(0, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(old.matrix(0, 1, out, inverse)).toBe(true);
    expect(out[12]).toBe(5);
    skin.removeJoint(source, 7);
    const missing = skin.capture();
    expect(missing.available(0)).toBe(false);
    missing.release();
    skin.setJoint(source, 7, world(9));
    const next = skin.capture();
    expect(next.available(0)).toBe(true);
    expect(next.matrix(0, 1, out, inverse)).toBe(true);
    expect(out[12]).toBe(11);
    expect(next.historyCompatible(old, 0)).toBe(true);
    next.release();
    skin.updateSkeleton(skeleton, 1, world(0));
    const mismatch = skin.capture();
    expect(mismatch.available(0)).toBe(false);
    mismatch.release();
    skin.updateSkeleton(skeleton, 2, new Float32Array([...world(1), ...world(2)]));
    const restored = skin.capture();
    expect(restored.available(0)).toBe(true);
    expect(restored.historyCompatible(old, 0)).toBe(false);
    restored.release();
  } finally {
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('continues independent cleanup and poisons adoption after physical retirement fails', async () => {
  const { inputs, arena, skin, source } = await fixture();
  skin.setJoint(source, 7, world(1));
  const frame = skin.capture();
  skin.removeJoint(source, 7);
  const actual = arena.releaseDescriptor.bind(arena);
  const cause = new Error('row retirement failed');
  let calls = 0;
  const release = vi.spyOn(arena, 'releaseDescriptor').mockImplementation((address, words) => {
    calls++;
    if (words === 17) throw cause;
    actual(address, words);
  });
  try {
    expect(() => frame.release()).toThrow();
    expect(calls).toBe(9);
    frame.release();
    expect(calls).toBe(9);
    expect(() => skin.capture()).toThrow();
    expect(() => skin.setJoint(source, 7, world(2))).toThrow();
  } finally {
    release.mockRestore();
    frame.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it.each([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
])('keeps the accepted root after Map insertion failure %i', async (failure) => {
  const { inputs, arena, skin, source } = await fixture();
  skin.setJoint(source, 7, world(1));
  const old = skin.capture();
  const original = Map.prototype.set;
  const cause = new Error('joint path Map insertion failure');
  let insertions = 0;
  const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (
      value !== null &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'holders') &&
      Object.hasOwn(value, 'address') &&
      ++insertions === failure
    )
      throw cause;
    return original.call(this, key, value);
  });
  let thrown: unknown;
  try {
    skin.setJoint(source, 7, world(2));
  } catch (error) {
    thrown = error;
  } finally {
    set.mockRestore();
  }
  try {
    expect(thrown).toBe(cause);
    const current = skin.capture();
    expect(current.root).toBe(old.root);
    current.release();
    skin.setJoint(source, 7, world(3));
    const recovered = skin.capture();
    const out = new Float32Array(16);
    expect(recovered.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(3);
    recovered.release();
    expect(old.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(1);
  } finally {
    old.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('rolls back a failed fixed-root construction before retrying', async () => {
  const { inputs, arena, skin, source } = await fixture();
  skin.setJoint(source, 1, world(1));
  const actual = Object.freeze;
  const capture = vi.spyOn(Object, 'freeze').mockImplementation((value) => {
    if (value instanceof SkinInputFrame) throw new Error('fixed-root construction failure');
    return actual(value);
  });
  try {
    expect(() => skin.capture()).toThrow('fixed-root construction failure');
    capture.mockRestore();
    const frames = Array.from({ length: 128 }, () => skin.capture());
    expect(() => skin.capture()).toThrow();
    for (const frame of frames) frame.release();
  } finally {
    capture.mockRestore();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('fails closed when a logical identity cannot retire and preserves admission and cleanup causes', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const admission = new Error('invalid inverse binds');
  const cleanup = new Error('logical release failed');
  const update = vi.spyOn(skin, 'updateSkeleton').mockImplementationOnce(() => {
    throw admission;
  });
  const release = vi.spyOn(StableRangeAllocator.prototype, 'release').mockImplementationOnce(() => {
    throw cleanup;
  });
  try {
    expect(() => skin.skeleton(1, world(0))).toThrow(
      expect.objectContaining({ cause: admission, errors: [admission, cleanup] }),
    );
    expect(() => skin.capture()).toThrow();
    expect(() => skin.setJoint(source, 7, world(1))).toThrow();
  } finally {
    update.mockRestore();
    release.mockRestore();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('rejects identities beyond u32 before radix truncation and rolls back the logical range', async () => {
  const { inputs, arena, skin } = await fixture();
  const allocate = vi
    .spyOn(StableRangeAllocator.prototype, 'allocate')
    .mockReturnValueOnce(0x100000000);
  const release = vi.spyOn(StableRangeAllocator.prototype, 'release');
  try {
    expect(() => skin.source()).toThrow();
    expect(release).toHaveBeenCalledWith(0x100000000, 1);
    allocate.mockRestore();
    // The returned out-of-range capacity remains exhausted, never a wrapped alias.
    expect(() => skin.source()).toThrow();
  } finally {
    allocate.mockRestore();
    release.mockRestore();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('fails closed on removal when the final logical release fails', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const cause = new Error('logical release failed');
  const release = vi.spyOn(StableRangeAllocator.prototype, 'release').mockImplementationOnce(() => {
    throw cause;
  });
  try {
    expect(() => skin.remove(source)).toThrow(cause);
    expect(() => skin.source()).toThrow();
    expect(() => skin.capture()).toThrow();
  } finally {
    release.mockRestore();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('restores the exclusive pointer after numeric dirty registration fails', async () => {
  const { inputs, device, arena, skin, source } = await fixture();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  skin.setJoint(source, 7, world(1));
  const row = allocate.mock.results[0]?.value as number;
  const leaf = allocate.mock.results[1]?.value as number;
  allocate.mockRestore();
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const actual = Map.prototype.set;
  const cause = new Error('dirty range registration failed');
  let failed = false;
  const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (!failed && key === leaf && value === 256) {
      failed = true;
      throw cause;
    }
    return actual.call(this, key, value);
  });
  try {
    expect(() => skin.setJoint(source, 7, world(2))).toThrow(cause);
    set.mockRestore();
    expect(failed).toBe(true);
    const frame = skin.capture();
    const out = mat4.create();
    expect(frame.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(1);
    const numeric = inputs.capture();
    numeric.buffer().unwrap();
    numeric.seal().unwrap();
    numeric.release();
    frame.release();
    const words = write.mock.calls[0]?.[2] as Uint32Array;
    expect(words[leaf + 7]).toBe(row);
    skin.setJoint(source, 7, world(3));
    const next = skin.capture();
    expect(next.readJoint(source, 7, out)).toBe(true);
    expect(out[12]).toBe(3);
    next.release();
  } finally {
    set.mockRestore();
    write.mockRestore();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('rejects foreign sources and incomplete or non-finite facts without replacing accepted rows', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const foreign = new SkinInputs(arena),
    other = foreign.source();
  const skeleton = skin.skeleton(1, world(0));
  skin.setJoint(source, 7, world(1));
  skin.bind(0, source, skeleton, new Uint32Array([7]));
  const old = skin.capture();
  try {
    expect(() => skin.setJoint(other, 7, world(2))).toThrow();
    expect(() => skin.bind(0, other, skeleton, new Uint32Array([7]))).toThrow();
    const invalid = world(2);
    invalid[3] = Infinity;
    expect(() => skin.setJoint(source, 7, invalid)).toThrow();
    expect(() => skin.updateSkeleton(skeleton, 1, invalid)).toThrow();
    expect(() => skin.bind(0, source, skeleton, new Uint32Array())).toThrow();
    const next = skin.capture();
    expect(next.root).toBe(old.root);
    expect(next.available(0)).toBe(true);
    next.release();
  } finally {
    old.release();
    foreign.dispose();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('keeps empty fixed roots live and rejects reads after their idempotent release', async () => {
  const { inputs, arena, skin } = await fixture();
  const frame = skin.capture();
  expect(frame.root).toBe(0xffffffff);
  expect(frame.available(0)).toBe(false);
  frame.release();
  frame.release();
  expect(() => frame.available(0)).toThrow();
  skin.dispose();
  inputs.dispose();
  arena.dispose();
});

it('reuses numeric backing during bounded two-root joint churn', async () => {
  const { inputs, arena, skin, source } = await fixture();
  for (let i = 0; i < 256; i++) skin.setJoint(source, i, world(i));
  let previous = skin.capture();
  let settledBytes = 0;
  try {
    for (let round = 0; round < 16; round++) {
      for (let i = 0; i < 256; i++) skin.setJoint(source, i, world(i + round * 1000));
      const next = skin.capture(),
        numeric = inputs.capture();
      try {
        const buffer = numeric.buffer().unwrap();
        numeric.seal().unwrap();
        if (round === 7) settledBytes = buffer.byteLength;
        if (round > 7) expect(buffer.byteLength).toBe(settledBytes);
        const out = mat4.create();
        expect(previous.readJoint(source, 7, out)).toBe(true);
        expect(out[12]).toBe(7 + Math.max(0, round - 1) * 1000);
      } finally {
        numeric.release();
      }
      previous.release();
      previous = next;
    }
  } finally {
    previous.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('reads retained numeric rows after owner retirement and rejects all demand after arena retirement', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const empty = skin.capture();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  skin.bind(0, source, skeleton, new Uint32Array([7]));
  const held = skin.capture(),
    out = mat4.create(),
    inverse = mat4.create();
  try {
    skin.dispose();
    expect(held.available(0)).toBe(true);
    expect(held.matrix(0, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(empty.available(0)).toBe(false);
    arena.dispose();
    for (const frame of [empty, held]) {
      expect(() => frame.available(0)).toThrow();
      expect(() => frame.jointCount(0)).toThrow();
      expect(() => frame.readJoint(source, 7, out)).toThrow();
      expect(() => frame.matrix(0, 0, out, inverse)).toThrow();
      expect(() => frame.historyCompatible(held, 0)).toThrow();
    }
    expect(() => skin.capture()).toThrow();
  } finally {
    empty.release();
    held.release();
    held.release();
    inputs.dispose();
    arena.dispose();
  }
});

it('keeps signed zero changes and old rows exact across numeric backing growth', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const matrix = world(3);
  skin.setJoint(source, 7, matrix);
  const before = skin.capture();
  const bytes = arena.byteLength;
  matrix[1] = -0;
  skin.setJoint(source, 7, matrix);
  for (let entity = 256; entity < 512; entity++) skin.setJoint(source, entity, world(entity));
  const after = skin.capture(),
    out = mat4.create();
  try {
    expect(arena.byteLength).toBeGreaterThan(bytes);
    expect(before.readJoint(source, 7, out)).toBe(true);
    expect(Object.is(out[1], 0)).toBe(true);
    expect(after.readJoint(source, 7, out)).toBe(true);
    expect(Object.is(out[1], -0)).toBe(true);
    const allocate = vi.spyOn(arena, 'allocateDescriptor');
    try {
      skin.setJoint(source, 7, matrix);
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
  } finally {
    before.release();
    after.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('preserves binding and Skeleton history for equal static facts without allocating', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const inverseBind = world(1);
  const skeleton = skin.skeleton(1, inverseBind);
  skin.setJoint(source, 7, world(3));
  skin.bind(0, source, skeleton, new Uint32Array([7]));
  const before = skin.capture();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  try {
    skin.updateSkeleton(skeleton, 1, new Float32Array(inverseBind));
    skin.bind(0, source, skeleton, new Uint32Array([7]));
    expect(allocate).not.toHaveBeenCalled();
    const same = skin.capture();
    try {
      expect(same.root).toBe(before.root);
      expect(same.historyCompatible(before, 0)).toBe(true);
    } finally {
      same.release();
    }
    const negativeZero = new Float32Array(inverseBind);
    negativeZero[1] = -0;
    skin.updateSkeleton(skeleton, 1, negativeZero);
    const changed = skin.capture();
    try {
      expect(changed.historyCompatible(before, 0)).toBe(false);
      expect(changed.available(0)).toBe(true);
    } finally {
      changed.release();
    }
  } finally {
    allocate.mockRestore();
    before.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('derives task joint capacity from fixed Binding roots without a separate capacity catalogue', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const single = skin.skeleton(1, world(0));
  const pair = skin.skeleton(2, new Float32Array([...world(0), ...world(0)]));
  skin.bind(0, source, single, new Uint32Array([7]));
  const old = skin.capture();
  skin.bind(257, source, pair, new Uint32Array([7, 9]));
  skin.bind(0, source, pair, new Uint32Array([7, 7]));
  const next = skin.capture();
  try {
    expect(old.jointCapacity).toBe(1);
    expect(next.jointCapacity).toBe(4);
    skin.unbind(257);
    skin.remove(source); // Missing dynamic facts do not retire static Bindings.
    skin.remove(pair);
    const missing = skin.capture();
    try {
      expect(missing.jointCapacity).toBe(2);
      expect(missing.available(0)).toBe(false);
    } finally {
      missing.release();
    }
    skin.unbind(0);
    const empty = skin.capture();
    try {
      expect(empty.jointCapacity).toBe(0);
    } finally {
      empty.release();
    }
    expect(old.jointCapacity).toBe(1);
    expect(next.jointCapacity).toBe(4);
  } finally {
    old.release();
    next.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('keeps one Skeleton identity through missing, ready, retired definition and restored versions without Binding fanout', async () => {
  const { inputs, skin, source } = await fixture();
  const skeleton = skin.reserveSkeleton();
  skin.setJoint(source, 7, world(3));
  for (let slot = 0; slot < 64; slot++) skin.bind(slot, source, skeleton, [7]);
  const missing = skin.capture();
  const bind = vi.spyOn(skin, 'bind');
  let ready: SkinInputFrame | undefined,
    unavailable: SkinInputFrame | undefined,
    restored: SkinInputFrame | undefined;
  try {
    expect(missing.available(63)).toBe(false);
    expect(missing.jointCapacity).toBe(64);
    skin.updateSkeleton(skeleton, 1, world(1));
    ready = skin.capture();
    expect(ready.available(63)).toBe(true);
    skin.clearSkeleton(skeleton);
    unavailable = skin.capture();
    expect(unavailable.available(63)).toBe(false);
    expect(ready.available(63)).toBe(true);
    skin.updateSkeleton(skeleton, 1, world(1));
    restored = skin.capture();
    expect(restored.available(63)).toBe(true);
    expect(restored.historyCompatible(ready, 63)).toBe(false);
    expect(restored.historyCompatible(unavailable, 63)).toBe(false);
    expect(bind).not.toHaveBeenCalled();
    expect(() => skin.clearSkeleton(source)).toThrow();
  } finally {
    bind.mockRestore();
    missing.release();
    ready?.release();
    unavailable?.release();
    restored?.release();
    skin.dispose();
    inputs.dispose();
  }
});

it('retains the exact submitted root independently of newer Scene facts and original frame retirement', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  skin.bind(0, source, skeleton, [7]);
  const submitted = skin.capture();
  skin.setJoint(source, 7, world(9));
  const latest = skin.capture();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  const history = submitted.retain();
  try {
    expect(history.root).toBe(submitted.root);
    expect(history.root).not.toBe(latest.root);
    expect(allocate).not.toHaveBeenCalled();
    submitted.release();
    skin.dispose();
    const out = mat4.create(),
      inverse = mat4.create();
    expect(history.matrix(0, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    expect(latest.matrix(0, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(10);
    const completion = history.retain();
    try {
      expect(completion.root).toBe(history.root);
    } finally {
      completion.release();
    }
    expect(() => submitted.retain()).toThrow();
  } finally {
    allocate.mockRestore();
    submitted.release();
    history.release();
    latest.release();
    skin.dispose();
    inputs.dispose();
  }
});

it('bounds exact-root history retention and rejects a released arena without retaining another root', async () => {
  const { inputs, arena, skin } = await fixture();
  const original = skin.capture(),
    clones: SkinInputFrame[] = [];
  try {
    for (let index = 0; index < 127; index++) clones.push(original.retain());
    expect(() => original.retain()).toThrow();
    clones.pop()?.release();
    const retry = original.retain();
    retry.release();
    arena.dispose();
    expect(() => original.retain()).toThrow();
  } finally {
    for (const clone of clones) clone.release();
    original.release();
    skin.dispose();
    inputs.dispose();
  }
});

it('copies ordered array membership once at admission and rolls back a changing or throwing extent', async () => {
  const { inputs, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.setJoint(source, 7, world(3));
  const joints = [7];
  skin.bind(0, source, skeleton, joints);
  const before = skin.capture();
  joints[0] = 9;
  let reads = 0;
  try {
    expect(before.available(0)).toBe(true);
    expect(() =>
      skin.bind(0, source, skeleton, {
        get length() {
          return ++reads === 1 ? 1 : 2;
        },
        0: 7,
      }),
    ).toThrow();
    const same = skin.capture();
    try {
      expect(same.root).toBe(before.root);
    } finally {
      same.release();
    }
    let values = 0;
    expect(() =>
      skin.bind(1, source, skeleton, {
        length: 1,
        get 0() {
          if (++values === 2) throw new Error('copy failed');
          return 7;
        },
      }),
    ).toThrow('copy failed');
    skin.bind(1, source, skeleton, Object.freeze([7]));
    const next = skin.capture();
    try {
      expect(next.available(1)).toBe(true);
      expect(next.jointCapacity).toBe(2);
    } finally {
      next.release();
    }
  } finally {
    before.release();
    skin.dispose();
    inputs.dispose();
  }
});

it('writes actual-demand current/history outputs without visiting other bindings or allocating views', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.bind(0, source, skeleton, [7]);
  skin.setJoint(source, 7, world(2));
  const previous = skin.capture();
  skin.setJoint(source, 7, world(4));
  const current = skin.capture();
  const a = new Float32Array(32).fill(-9),
    b = new Float32Array(32).fill(-7);
  const matrix = mat4.create(),
    inverse = mat4.create();
  const allocate = vi.spyOn(arena, 'allocateDescriptor');
  const subarray = vi.spyOn(Float32Array.prototype, 'subarray');
  try {
    expect(current.palettes(0, previous, a, b, matrix, inverse)).toBe(3);
    expect(a[12]).toBe(5);
    expect(b[12]).toBe(3);
    expect(a[31]).toBe(-9);
    expect(b[31]).toBe(-7);
    expect(current.palettes(0, undefined, a, b, matrix, inverse)).toBe(1);
    expect(b[12]).toBe(5);
    expect(current.palettes(999, previous, a, b, matrix, inverse)).toBe(0);
    expect(allocate).not.toHaveBeenCalled();
    expect(subarray).not.toHaveBeenCalled();
  } finally {
    allocate.mockRestore();
    subarray.mockRestore();
    current.release();
    previous.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('seeds the complete previous pose on static rebind, unavailable previous and previous-only numerical overflow, and omits current overflow', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const scale = world(0);
  scale[0] = 2;
  const skeleton = skin.skeleton(2, new Float32Array([...scale, ...scale]));
  skin.bind(0, source, skeleton, [7, 8]);
  const missing = skin.capture();
  const huge = world(0);
  huge[0] = 3e38;
  skin.setJoint(source, 7, world(2));
  skin.setJoint(source, 8, huge);
  const overflow = skin.capture();
  skin.setJoint(source, 8, world(4));
  const current = skin.capture();
  const a = new Float32Array(32),
    b = new Float32Array(32);
  const matrix = mat4.create(),
    inverse = mat4.create();
  try {
    expect(current.palettes(0, missing, a, b, matrix, inverse)).toBe(1);
    expect(b).toEqual(a);
    b.fill(-7);
    expect(current.palettes(0, overflow, a, b, matrix, inverse)).toBe(1);
    expect(b).toEqual(a); // no compatible prefix survives previous overflow
    // A current-pose overflow omits only this actual draw, as GPU resolution does.
    expect(overflow.palettes(0, current, a, b, matrix, inverse)).toBe(0);
    skin.bind(0, source, skeleton, [8, 7]);
    const rebound = skin.capture();
    try {
      expect(rebound.palettes(0, current, a, b, matrix, inverse)).toBe(1);
      expect(a[12]).toBe(4);
      expect(a[28]).toBe(2);
      expect(b).toEqual(a);
    } finally {
      rebound.release();
    }
  } finally {
    missing.release();
    overflow.release();
    current.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('rejects overlapping or undersized actual-demand outputs before any write', async () => {
  const { inputs, arena, skin, source } = await fixture();
  const skeleton = skin.skeleton(1, world(1));
  skin.bind(0, source, skeleton, [7]);
  skin.setJoint(source, 7, world(3));
  const frame = skin.capture();
  const a = new Float32Array(32).fill(-5),
    b = new Float32Array(16).fill(-7);
  const matrix = mat4.create(),
    inverse = mat4.create();
  try {
    expect(() => frame.palettes(0, undefined, a, a.subarray(16), matrix, inverse)).toThrow();
    expect(() => frame.palettes(0, undefined, a, b.subarray(1), matrix, inverse)).toThrow();
    expect(() => frame.palettes(0, undefined, a, matrix, matrix, inverse)).toThrow();
    expect(a.every((value) => value === -5)).toBe(true);
    expect(b.every((value) => value === -7)).toBe(true);
    const prior = frame.retain();
    prior.release();
    expect(() => frame.palettes(0, prior, a, b, matrix, inverse)).toThrow();
    expect(a.every((value) => value === -5)).toBe(true);
  } finally {
    frame.release();
    skin.dispose();
    inputs.dispose();
    arena.dispose();
  }
});

it('never overwrites a captured joint row through a remembered exclusive leaf', async () => {
  const { inputs, skin, source } = await fixture();
  const out = mat4.create();
  try {
    skin.setJoint(source, 7, world(1));
    // An exclusive path writes in place and remembers this leaf.
    skin.setJoint(source, 7, world(2));
    const captured = skin.capture();
    try {
      // The same leaf after capture must copy, never reuse the remembered page.
      skin.setJoint(source, 7, world(3));
      skin.setJoint(source, 8, world(4));
      expect(captured.readJoint(source, 7, out)).toBe(true);
      expect(out[12]).toBe(2);
      expect(captured.readJoint(source, 8, out)).toBe(false);
      const next = skin.capture();
      try {
        expect(next.readJoint(source, 7, out)).toBe(true);
        expect(out[12]).toBe(3);
        expect(next.readJoint(source, 8, out)).toBe(true);
        expect(out[12]).toBe(4);
      } finally {
        next.release();
      }
    } finally {
      captured.release();
    }
  } finally {
    skin.dispose();
    inputs.dispose();
  }
});
