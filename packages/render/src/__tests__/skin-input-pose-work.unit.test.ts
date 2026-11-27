import { mat4 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { type SkinInputFrame, type SkinInputSlot, SkinInputs } from '../scene/skin-inputs';

function translated(x: number) {
  const matrix = mat4.identity(mat4.create());
  matrix[12] = x;
  return matrix;
}

function fixture() {
  const arena = new GpuInputArena();
  const skin = new SkinInputs(arena);
  const source = skin.source();
  const frames: SkinInputFrame[] = [];
  return {
    arena,
    skin,
    source,
    skeleton(count: number) {
      const inverseBinds = new Float32Array(count * 16);
      const identity = translated(0);
      for (let joint = 0; joint < count; joint++) inverseBinds.set(identity, joint * 16);
      return skin.skeleton(count, inverseBinds);
    },
    capture() {
      const frame = skin.capture();
      frames.push(frame);
      return frame;
    },
    dispose() {
      for (const frame of frames) frame.release();
      skin.dispose();
      arena.dispose();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function expectPose(frame: SkinInputFrame, binding: number, positions: readonly number[]) {
  const out = mat4.create();
  const inverse = mat4.create();
  for (const [joint, x] of positions.entries()) {
    expect(frame.matrix(binding, joint, out, inverse)).toBe(true);
    expect(out[12]).toBe(x);
  }
}

interface JointColumns {
  readonly cells: Map<number, number>;
  matrices: Float32Array;
}

function jointStores(skin: SkinInputs) {
  return Reflect.get(skin, 'stores') as Map<SkinInputSlot, JointColumns>;
}

function observePoseWork(f: Fixture, jointCount: number) {
  const stores = jointStores(f.skin);
  let matrixReads = 0;
  let paletteReads = 0;
  const poses = Reflect.get(Reflect.get(f.skin, 'poses'), 'slots') as Map<
    number,
    { joints: unknown[] }
  >;
  const palettes = Array.from(new Set(poses.values()), (pose) => ({ pose, joints: pose.joints }));
  for (const { pose, joints } of palettes) {
    pose.joints = new Proxy(joints, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) paletteReads++;
        return Reflect.get(target, key, receiver);
      },
    });
  }
  const originals = Array.from(stores.values(), (store) => ({
    store,
    matrices: store.matrices,
  }));
  const numericRead = {
    get(target: Float32Array, key: PropertyKey) {
      if (typeof key === 'string' && /^\d+$/.test(key)) matrixReads++;
      return Reflect.get(target, key, target);
    },
  };
  // Per-fixture instrumentation keeps the actual joint columns and publisher.
  for (const { store, matrices } of originals) {
    store.matrices = new Proxy<Float32Array>(matrices, numericRead);
  }
  const visit = vi.spyOn(stores, 'get');
  const write = vi.spyOn(f.arena, 'writeDescriptor');
  return {
    capture() {
      matrixReads = paletteReads = 0;
      visit.mockClear();
      write.mockClear();
      const frame = f.capture();
      const poseWords = 1 + jointCount * 16;
      const poseRows = write.mock.calls.filter(([, , words]) => words === poseWords).length;
      const work = {
        rosterVisits: visit.mock.calls.length,
        paletteReads,
        matrixReads,
        poseRows,
        poseBytes: poseRows * poseWords * 4,
      };
      return { frame, work };
    },
    restore() {
      for (const { pose, joints } of palettes) pose.joints = joints;
      visit.mockRestore();
      write.mockRestore();
      for (const { store, matrices } of originals) {
        store.matrices = matrices;
      }
    },
  };
}

it('reads and publishes one affected roster among 256 disjoint admitted rosters', () => {
  const f = fixture();
  const skeleton = f.skeleton(3);
  const changedSlot = 127;
  const changedJoint = changedSlot * 3 + 2;
  try {
    for (let slot = 0; slot < 256; slot++) {
      const first = slot * 3 + 1;
      const roster = [first, first + 1, first + 2];
      for (const joint of roster) f.skin.setJoint(f.source, joint, translated(joint));
      f.skin.bind(slot, f.source, skeleton, roster);
    }
    const held = f.capture();
    const observe = observePoseWork(f, 3);
    try {
      f.skin.setJoint(f.source, changedJoint, translated(1000));
      const { frame, work } = observe.capture();
      expectPose(frame, changedSlot, [changedJoint - 1, 1000, changedJoint + 1]);
      expectPose(held, changedSlot, [changedJoint - 1, changedJoint, changedJoint + 1]);
      expectPose(frame, 128, [385, 386, 387]);
      expect(work).toEqual({
        rosterVisits: 1,
        paletteReads: 3,
        matrixReads: 48,
        poseRows: 1,
        poseBytes: 196,
      });
      expect(observe.capture().work).toEqual({
        rosterVisits: 0,
        paletteReads: 0,
        matrixReads: 0,
        poseRows: 0,
        poseBytes: 0,
      });
    } finally {
      observe.restore();
    }
  } finally {
    f.dispose();
  }
});

it('coalesces repeated joint changes for shared, reordered and repeated rosters after late Binding', () => {
  const f = fixture();
  const other = f.skin.source();
  const skeleton = f.skeleton(2);
  try {
    f.skin.setJoint(f.source, 7, translated(1));
    f.skin.setJoint(f.source, 8, translated(9));
    f.skin.setJoint(other, 7, translated(31));
    f.skin.setJoint(other, 8, translated(39));
    expect(f.capture().available(1)).toBe(false);
    f.skin.bind(1, f.source, skeleton, [7, 8]);
    f.skin.bind(2, f.source, skeleton, [7, 8]);
    f.skin.bind(3, f.source, skeleton, [8, 7]);
    f.skin.bind(4, f.source, skeleton, [7, 7]);
    f.skin.bind(5, other, skeleton, [7, 8]);
    const observe = observePoseWork(f, 2);
    try {
      const initial = observe.capture();
      expect(initial.work.poseRows).toBe(4);
      expectPose(initial.frame, 1, [1, 9]);
      expectPose(initial.frame, 2, [1, 9]);
      f.skin.setJoint(f.source, 7, translated(2));
      f.skin.setJoint(f.source, 7, translated(3));
      const { frame, work } = observe.capture();
      expectPose(frame, 1, [3, 9]);
      expectPose(frame, 2, [3, 9]);
      expectPose(frame, 3, [9, 3]);
      expectPose(frame, 4, [3, 3]);
      expectPose(frame, 5, [31, 39]);
      expectPose(initial.frame, 1, [1, 9]);
      expect(work).toEqual({
        rosterVisits: 3,
        paletteReads: 6,
        matrixReads: 96,
        poseRows: 3,
        poseBytes: 396,
      });
    } finally {
      observe.restore();
    }
  } finally {
    f.dispose();
  }
});

it('restores repeated absent dependencies exactly once for each palette', () => {
  const f = fixture(),
    skeleton = f.skeleton(2);
  try {
    f.skin.bind(1, f.source, skeleton, [7, 7]);
    f.skin.bind(2, f.source, skeleton, [7, 8]);
    expect(f.capture().available(1)).toBe(false);
    f.skin.setJoint(f.source, 7, translated(3));
    const first = f.capture();
    expectPose(first, 1, [3, 3]);
    expect(first.available(2)).toBe(false);
    f.skin.setJoint(f.source, 8, translated(4));
    f.skin.removeJoint(f.source, 7);
    const missing = f.capture();
    expect(missing.available(1)).toBe(false);
    expect(missing.available(2)).toBe(false);
    f.skin.setJoint(f.source, 7, translated(5));
    const restored = f.capture();
    expectPose(restored, 1, [5, 5]);
    expectPose(restored, 2, [5, 4]);
    expectPose(first, 1, [3, 3]);
  } finally {
    f.dispose();
  }
});

it('keeps a removed joint absent through cell reuse and source retirement', () => {
  const f = fixture();
  const other = f.skin.source();
  const skeleton = f.skeleton(1);
  try {
    f.skin.bind(3, f.source, skeleton, [7]);
    f.skin.bind(4, other, skeleton, [7]);
    expect(f.capture().available(3)).toBe(false);
    f.skin.setJoint(f.source, 7, translated(2));
    f.skin.setJoint(other, 7, translated(4));
    const held = f.capture();
    const columns = jointStores(f.skin).get(f.source);
    if (columns === undefined) throw new Error('Expected the admitted source joint store');
    const oldCell = columns.cells.get(7);
    expect(oldCell).toBeDefined();
    f.skin.removeJoint(f.source, 7);
    f.skin.setJoint(f.source, 99, translated(900));
    expect(columns.cells.get(99)).toBe(oldCell);
    const missing = f.capture();
    expect(missing.jointCount(3)).toBe(1);
    expect(missing.available(3)).toBe(false);
    expectPose(missing, 4, [4]);
    f.skin.setJoint(f.source, 7, translated(3));
    const restored = f.capture();
    expectPose(restored, 3, [3]);
    f.skin.setJoint(f.source, 7, translated(5));
    f.skin.remove(f.source);
    const retired = f.capture();
    expect(retired.jointCount(3)).toBe(1);
    expect(retired.available(3)).toBe(false);
    expectPose(retired, 4, [4]);
    f.skin.bind(3, other, skeleton, [7]);
    expectPose(f.capture(), 3, [4]);
    expectPose(held, 3, [2]);
    expectPose(restored, 3, [3]);
  } finally {
    f.dispose();
  }
});

it('retries a failed pose publication and keeps the remaining queued readers without another write', () => {
  const f = fixture();
  const skeleton = f.skeleton(1);
  try {
    for (const joint of [1, 2, 3]) {
      f.skin.setJoint(f.source, joint, translated(joint));
      f.skin.bind(joint, f.source, skeleton, [joint]);
    }
    const held = f.capture();
    for (const joint of [1, 2, 3]) f.skin.setJoint(f.source, joint, translated(joint * 10));
    const cause = new Error('Pose descriptor publication failed');
    const original = f.arena.writeDescriptor.bind(f.arena);
    const written: number[] = [];
    let reject = true;
    const write = vi
      .spyOn(f.arena, 'writeDescriptor')
      .mockImplementation((address, data, words, offset) => {
        const translation = words === 17 ? data.getFloat32(13 * 4, true) : undefined;
        if (translation === 20 && reject) {
          reject = false;
          throw cause;
        }
        original(address, data, words, offset);
        if (translation !== undefined) written.push(translation);
      });
    try {
      expect(() => f.capture()).toThrow(cause);
      expect(written).toEqual([10]);
      for (const joint of [1, 2, 3]) expectPose(held, joint, [joint]);
      const retried = f.capture();
      for (const joint of [1, 2, 3]) expectPose(retried, joint, [joint * 10]);
      expect([...written].sort((a, b) => a - b)).toEqual([10, 20, 30]);
      const quiet = f.capture();
      expect(quiet.inputRevision).toBe(retried.inputRevision);
      expect(written).toHaveLength(3);
    } finally {
      write.mockRestore();
    }
  } finally {
    f.dispose();
  }
});
