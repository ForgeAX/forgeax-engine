import { mat4 } from '@forgeax/engine-math';
import type { SkeletonAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { SkinInputFrame, SkinInputs } from '../scene/skin-inputs';
import { type SkinBindingInput, SkinSceneInputs } from '../scene/skin-scene-inputs';

function matrix(x = 0) {
  const out = mat4.identity(mat4.create());
  out[12] = x;
  return out;
}
function skeleton(x = 0): SkeletonAsset {
  return { kind: 'skeleton', jointCount: 1, inverseBindMatrices: matrix(x) };
}
const binding: SkinBindingInput = Object.freeze({ skeleton: 7, joints: Object.freeze([19]) });

it('admits one source joint and one resource definition for 1024 Bindings without dynamic consumer work', () => {
  const arena = new GpuInputArena(),
    resolve = vi.fn(() => skeleton(1)),
    scene = new SkinSceneInputs(arena, resolve);
  try {
    for (let slot = 0; slot < 1024; slot++) scene.binding(slot, 0, undefined, binding);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect([...(scene.firstJoints(0) ?? [])]).toEqual([19]);
    scene.joint(0, 19, matrix(3));
    expect(scene.firstJoints(0)?.size).toBe(0);
    const before = scene.capture(),
      bind = vi.spyOn(SkinInputs.prototype, 'bind'),
      available = vi.spyOn(SkinInputFrame.prototype, 'available');
    const write = vi.spyOn(SkinInputs.prototype, 'setJoint');
    try {
      scene.joint(0, 19, matrix(8));
      expect(bind).not.toHaveBeenCalled();
      expect(available).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1);
      const next = scene.capture(),
        out = mat4.create(),
        inverse = mat4.create();
      try {
        expect(next.jointCapacity).toBe(1024);
        expect(before.matrix(1023, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(4);
        expect(next.matrix(1023, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(9);
      } finally {
        next.release();
      }
    } finally {
      bind.mockRestore();
      available.mockRestore();
      write.mockRestore();
      before.release();
    }
  } finally {
    scene.dispose();
    arena.dispose();
  }
});

it('restores a missing or removed shared definition without resolving or rewriting its Bindings', () => {
  const arena = new GpuInputArena(),
    resolve = vi.fn(() => undefined),
    scene = new SkinSceneInputs(arena, resolve);
  try {
    for (let slot = 0; slot < 64; slot++) scene.binding(slot, 0, undefined, binding);
    scene.joint(0, 19, matrix(4));
    const missing = scene.capture(),
      bind = vi.spyOn(SkinInputs.prototype, 'bind');
    try {
      expect(missing.available(63)).toBe(false);
      scene.skeletonChanged(0, 7, skeleton(2));
      const ready = scene.capture();
      try {
        expect(ready.available(63)).toBe(true);
        scene.skeletonChanged(0, 7, undefined);
        const removed = scene.capture();
        try {
          expect(removed.available(63)).toBe(false);
          expect(ready.available(63)).toBe(true);
        } finally {
          removed.release();
        }
        scene.skeletonChanged(0, 7, skeleton(2));
        const restored = scene.capture();
        try {
          expect(restored.available(63)).toBe(true);
          expect(restored.historyCompatible(ready, 63)).toBe(false);
        } finally {
          restored.release();
        }
      } finally {
        ready.release();
      }
      expect(bind).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(1);
      scene.skeletonChanged(0, 99, skeleton()); // Unreferenced assets allocate no Skin identity.
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      bind.mockRestore();
      missing.release();
    }
  } finally {
    scene.dispose();
    arena.dispose();
  }
});

it('retires only last references, isolates Worlds and preserves old roots across source and Scene-slot reuse', () => {
  const arena = new GpuInputArena(),
    scene = new SkinSceneInputs(arena, (world) => skeleton(world + 1));
  try {
    scene.binding(0, 0, undefined, binding);
    scene.binding(1, 0, undefined, binding);
    scene.binding(2, 1, undefined, binding);
    scene.joint(0, 19, matrix(3));
    scene.joint(1, 19, matrix(8));
    const old = scene.capture(),
      out = mat4.create(),
      inverse = mat4.create();
    try {
      scene.binding(0, 0, binding, undefined);
      expect(scene.hasJoint(0, 19)).toBe(true);
      scene.binding(1, 0, binding, undefined);
      expect(scene.hasJoint(0, 19)).toBe(false);
      expect(scene.firstJoints(0)).toBeUndefined();
      scene.joint(0, 19, matrix(99)); // A late retired delta cannot create an orphan source.
      scene.binding(0, 0, undefined, binding);
      expect([...(scene.firstJoints(0) ?? [])]).toEqual([19]);
      scene.joint(0, 19, matrix(11));
      const next = scene.capture();
      try {
        expect(old.matrix(0, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(4);
        expect(next.matrix(0, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(12);
        expect(next.matrix(2, 0, out, inverse)).toBe(true);
        expect(out[12]).toBe(10);
        expect(next.jointCapacity).toBe(2);
        expect(next.historyCompatible(old, 0)).toBe(false);
      } finally {
        next.release();
      }
    } finally {
      old.release();
    }
  } finally {
    scene.dispose();
    arena.dispose();
  }
});

it('balances repeated ordered joints and pending first references through a known rebind', () => {
  const arena = new GpuInputArena(),
    inverse = new Float32Array(48);
  for (let index = 0; index < 3; index++) inverse.set(matrix(), index * 16);
  const scene = new SkinSceneInputs(arena, () => ({
    kind: 'skeleton',
    jointCount: 3,
    inverseBindMatrices: inverse,
  }));
  const first: SkinBindingInput = { skeleton: 7, joints: Object.freeze([19, 19, 20]) },
    second: SkinBindingInput = { skeleton: 7, joints: Object.freeze([20, 21, 21]) };
  try {
    scene.binding(0, 0, undefined, first);
    scene.binding(1, 0, undefined, first);
    scene.joint(0, 19, matrix());
    scene.joint(0, 20, undefined);
    expect(scene.firstJoints(0)?.size).toBe(0);
    scene.binding(0, 0, first, second);
    expect(scene.hasJoint(0, 19)).toBe(true);
    expect([...(scene.firstJoints(0) ?? [])]).toEqual([21]);
    scene.binding(1, 0, first, undefined);
    expect(scene.hasJoint(0, 19)).toBe(false);
    expect(scene.hasJoint(0, 20)).toBe(true);
    scene.joint(0, 20, matrix(2));
    scene.joint(0, 21, matrix(3));
    const frame = scene.capture();
    try {
      expect(frame.available(0)).toBe(true);
      expect(frame.jointCapacity).toBe(3);
    } finally {
      frame.release();
    }
    scene.binding(0, 0, second, undefined);
    expect(scene.hasJoint(0, 21)).toBe(false);
    const empty = scene.capture();
    try {
      expect(empty.jointCapacity).toBe(0);
    } finally {
      empty.release();
    }
  } finally {
    scene.dispose();
    arena.dispose();
  }
});

it('terminates partial Scene adoption while an earlier frame remains independently readable', () => {
  const arena = new GpuInputArena(),
    scene = new SkinSceneInputs(arena, () => skeleton(1));
  scene.binding(0, 0, undefined, binding);
  scene.joint(0, 19, matrix(3));
  const old = scene.capture(),
    actual = SkinInputs.prototype.setJoint;
  const failure = vi.spyOn(SkinInputs.prototype, 'setJoint').mockImplementationOnce(function (
    this: SkinInputs,
    source,
    entity,
    matrix,
  ) {
    actual.call(this, source, entity, matrix);
    throw new Error('after write');
  });
  try {
    expect(() => scene.joint(0, 19, matrix(8))).toThrow('after write');
    expect(() => scene.capture()).toThrow();
    expect(() => scene.skeletonChanged(0, 7, skeleton())).toThrow();
    const out = mat4.create(),
      inverse = mat4.create();
    expect(old.matrix(0, 0, out, inverse)).toBe(true);
    expect(out[12]).toBe(4);
    scene.dispose();
    expect(old.available(0)).toBe(true);
  } finally {
    failure.mockRestore();
    old.release();
    scene.dispose();
    arena.dispose();
  }
});
