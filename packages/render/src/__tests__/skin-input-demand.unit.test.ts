import { mat4 } from '@forgeax/engine-math';
import type { ShadowCapsuleSet } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { SkinInputs } from '../scene/skin-inputs';
import { poseShadowCapsules } from './skin-capsule-oracle';

function matrix(x = 0) {
  const out = mat4.identity(mat4.create());
  out[12] = x;
  return out;
}
function capsules(radius = 2): ShadowCapsuleSet {
  return {
    joints: new Uint16Array([0, 1]),
    shapes: new Float32Array([1, 2, 3, 4, 5, 6, radius, -1, -2, -3, -4, -5, -6, 1]),
  };
}
function fixture(set?: ShadowCapsuleSet) {
  const arena = new GpuInputArena();
  const skin = new SkinInputs(arena),
    source = skin.source();
  const inverse = new Float32Array(32);
  inverse.set(matrix(1));
  inverse.set(matrix(3), 16);
  const skeleton = skin.skeleton(2, inverse, set);
  skin.setJoint(source, 7, matrix(10));
  skin.setJoint(source, 9, matrix(20));
  skin.bind(11, source, skeleton, new Uint32Array([7, 9]));
  return {
    arena,
    skin,
    source,
    skeleton,
    inverse,
    dispose() {
      skin.dispose();
      arena.dispose();
    },
  };
}

it('retains capsule-only edits in the same fixed Skeleton row and resets history', () => {
  const input = capsules();
  const f = fixture(input),
    old = f.skin.capture();
  const out = new Float32Array(16),
    m = mat4.create(),
    inverse = mat4.create();
  try {
    expect(old.capsuleCount(11)).toBe(2);
    expect(old.capsules(11, out, m, inverse)).toBe(true);
    const expected = Array.from(out);
    input.shapes.fill(0); // No caller-owned capsule storage survives admission.
    input.joints.fill(1);
    expect(old.capsules(11, out, m, inverse)).toBe(true);
    expect(Array.from(out)).toEqual(expected);
    f.skin.updateSkeleton(f.skeleton, 2, f.inverse, capsules(4));
    const next = f.skin.capture();
    try {
      expect(next.historyCompatible(old, 11)).toBe(false);
      expect(next.capsules(11, out, m, inverse)).toBe(true);
      expect(out[3]).toBe(4);
      expect(old.capsules(11, out, m, inverse)).toBe(true);
      expect(Array.from(out)).toEqual(expected);
    } finally {
      next.release();
    }
  } finally {
    old.release();
    f.dispose();
  }
});

it('matches existing capsule semantics for nonuniform and reflected scales without a Skin entity transform', () => {
  const set = capsules(),
    f = fixture(set);
  const first = matrix(10),
    second = matrix(20);
  first[0] = -2;
  first[5] = 3;
  first[10] = 4;
  second[0] = 3;
  second[5] = 4;
  second[10] = 5;
  f.skin.setJoint(f.source, 7, first);
  f.skin.setJoint(f.source, 9, second);
  const frame = f.skin.capture();
  try {
    const out = new Float32Array(16);
    expect(frame.capsules(11, out, mat4.create(), mat4.create())).toBe(true);
    const expected = poseShadowCapsules(set, [matrix(1), matrix(3)], [first, second]);
    expect(Array.from(out)).toEqual(Array.from(expected));
    expect(out[3]).toBe(6);
  } finally {
    frame.release();
    f.dispose();
  }
});

it('preserves distinct absent and empty capsule sets, including removal while an old frame is held', () => {
  const f = fixture(capsules()),
    old = f.skin.capture();
  try {
    f.skin.updateSkeleton(f.skeleton, 2, f.inverse);
    const absent = f.skin.capture();
    f.skin.updateSkeleton(f.skeleton, 2, f.inverse, {
      joints: new Uint16Array(),
      shapes: new Float32Array(),
    });
    const empty = f.skin.capture();
    try {
      expect(absent.capsuleCount(11)).toBeUndefined();
      expect(absent.capsules(11, new Float32Array(16), mat4.create(), mat4.create())).toBe(false);
      expect(empty.capsuleCount(11)).toBe(0);
      expect(empty.capsules(11, new Float32Array(), mat4.create(), mat4.create())).toBe(true);
      expect(old.capsuleCount(11)).toBe(2);
      expect(old.capsules(11, new Float32Array(16), mat4.create(), mat4.create())).toBe(true);
    } finally {
      absent.release();
      empty.release();
    }
  } finally {
    old.release();
    f.dispose();
  }
});

it.each([
  'range',
  'nan',
  'infinite',
  'zero-radius',
  'negative-radius',
  'length',
  'limit',
] as const)('rejects invalid capsule %s without adopting a partial Skeleton', (kind) => {
  const f = fixture(capsules()),
    old = f.skin.capture();
  const next = capsules();
  if (kind === 'range') next.joints[1] = 2;
  if (kind === 'nan') next.shapes[0] = NaN;
  if (kind === 'infinite') next.shapes[1] = Infinity;
  if (kind === 'zero-radius') next.shapes[6] = 0;
  if (kind === 'negative-radius') next.shapes[6] = -1;
  const invalid =
    kind === 'length'
      ? { ...next, shapes: new Float32Array(1) }
      : kind === 'limit'
        ? { joints: new Uint16Array(65), shapes: new Float32Array(65 * 7).fill(1) }
        : next;
  try {
    expect(() => f.skin.updateSkeleton(f.skeleton, 2, f.inverse, invalid)).toThrow();
    const after = f.skin.capture();
    try {
      expect(after.root).toBe(old.root);
      expect(after.historyCompatible(old, 11)).toBe(true);
    } finally {
      after.release();
    }
  } finally {
    old.release();
    f.dispose();
  }
});

it('does not allocate or upload an equal static Skeleton with capsules', () => {
  const f = fixture(capsules()),
    old = f.skin.capture();
  const allocate = vi.spyOn(f.arena, 'allocateDescriptor'),
    write = vi.spyOn(f.arena, 'writeDescriptor');
  try {
    f.skin.updateSkeleton(f.skeleton, 2, new Float32Array(f.inverse), capsules());
    expect(allocate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const next = f.skin.capture();
    try {
      expect(next.root).toBe(old.root);
      expect(next.historyCompatible(old, 11)).toBe(true);
    } finally {
      next.release();
    }
  } finally {
    allocate.mockRestore();
    write.mockRestore();
    old.release();
    f.dispose();
  }
});

it('rejects a whole unavailable pose before writing any palette or capsules, then restores by joint edit only', () => {
  const f = fixture(capsules());
  f.skin.removeJoint(f.source, 9);
  const missing = f.skin.capture(),
    palette = new Float32Array(32).fill(87),
    out = new Float32Array(16).fill(97);
  try {
    expect(missing.palette(11, palette, mat4.create(), mat4.create())).toBe(false);
    expect(missing.capsules(11, out, mat4.create(), mat4.create())).toBe(false);
    expect(Array.from(palette)).toEqual(Array(32).fill(87));
    expect(Array.from(out)).toEqual(Array(16).fill(97));
    f.skin.setJoint(f.source, 9, matrix(30));
    const restored = f.skin.capture();
    try {
      expect(restored.palette(11, palette, mat4.create(), mat4.create())).toBe(true);
      expect(palette[12]).toBe(11);
      expect(palette[28]).toBe(33);
      expect(restored.capsules(11, out, mat4.create(), mat4.create())).toBe(true);
      expect(restored.historyCompatible(missing, 11)).toBe(false);
    } finally {
      restored.release();
    }
  } finally {
    missing.release();
    f.dispose();
  }
});

it('writes an actual palette into a supplied window and keeps both adjacent task regions untouched', () => {
  const f = fixture(),
    frame = f.skin.capture();
  const storage = new Float32Array(64).fill(123);
  const output = storage.subarray(16, 48),
    a = mat4.create(),
    b = mat4.create();
  try {
    expect(frame.palette(11, output, a, b)).toBe(true);
    expect(Array.from(output)).toEqual([...matrix(11), ...matrix(23)]);
    expect(Array.from(storage.subarray(0, 16))).toEqual(Array(16).fill(123));
    expect(Array.from(storage.subarray(48))).toEqual(Array(16).fill(123));
    expect(() => frame.palette(11, new Float32Array(31), a, b)).toThrow();
    expect(() => frame.capsules(11, new Float32Array(1), a, b)).not.toThrow(); // No capsules.
    expect(() => frame.palette(11, output, mat4.view(storage, 1), b)).toThrow();
    expect(() => frame.palette(11, output, a, a)).toThrow();
  } finally {
    frame.release();
    f.dispose();
  }
});

it('rejects undersized and aliased capsule outputs before writing them', () => {
  const f = fixture(capsules()),
    frame = f.skin.capture();
  const out = new Float32Array(16).fill(123),
    a = mat4.create(),
    b = mat4.create();
  try {
    expect(() => frame.capsules(11, out.subarray(0, 15), a, b)).toThrow();
    expect(() => frame.capsules(11, out, mat4.view(out, 0), b)).toThrow();
    expect(() => frame.capsules(11, out, a, a)).toThrow();
    expect(Array.from(out)).toEqual(Array(16).fill(123));
  } finally {
    frame.release();
    f.dispose();
  }
});

it.each([
  'joint',
  'radius',
  'finite',
] as const)('validates the bytes actually captured after a synchronous allocation hook changes capsule %s', (kind) => {
  const f = fixture(capsules()),
    old = f.skin.capture();
  const next = capsules(3);
  const actual = f.arena.allocateDescriptor.bind(f.arena);
  const hook = vi.spyOn(f.arena, 'allocateDescriptor').mockImplementationOnce((words) => {
    if (kind === 'joint') next.joints[0] = 2;
    if (kind === 'radius') next.shapes[6] = 0;
    if (kind === 'finite') next.shapes[0] = NaN;
    return actual(words);
  });
  try {
    expect(() => f.skin.updateSkeleton(f.skeleton, 2, f.inverse, next)).toThrow();
    const after = f.skin.capture();
    try {
      expect(after.root).toBe(old.root);
      expect(after.historyCompatible(old, 11)).toBe(true);
    } finally {
      after.release();
    }
  } finally {
    hook.mockRestore();
    old.release();
    f.dispose();
  }
});

it.each([1e20, 1e-20])('preserves existing finite capsule math at axis scale %s', (scale) => {
  const set = capsules(1 / scale),
    f = fixture(set);
  const first = matrix(),
    second = matrix();
  first[0] = scale;
  first[5] = scale;
  first[10] = scale;
  f.skin.setJoint(f.source, 7, first);
  f.skin.setJoint(f.source, 9, second);
  const frame = f.skin.capture();
  try {
    const out = new Float32Array(16);
    expect(frame.capsules(11, out, mat4.create(), mat4.create())).toBe(true);
    const expected = poseShadowCapsules(set, [matrix(1), matrix(3)], [first, second]);
    expect(Array.from(out)).toEqual(Array.from(expected));
    expect(out[3]).toBeCloseTo(1, 5);
  } finally {
    frame.release();
    f.dispose();
  }
});

it('never reports a ready demand for numerical overflow; actual demand omits only that pose', () => {
  const f = fixture(capsules()),
    giant = matrix();
  giant[0] = 3e38;
  f.skin.setJoint(f.source, 9, giant);
  const inverse = new Float32Array(f.inverse);
  inverse[16] = 3;
  f.skin.updateSkeleton(f.skeleton, 2, inverse, capsules());
  const frame = f.skin.capture();
  try {
    expect(frame.available(11)).toBe(true); // Presence is distinct from representable arithmetic.
    expect(() => frame.palette(11, new Float32Array(32), mat4.create(), mat4.create())).toThrow();
    expect(frame.capsules(11, new Float32Array(16), mat4.create(), mat4.create())).toBe(false);
    expect(
      frame.palettes(
        11,
        undefined,
        new Float32Array(32),
        new Float32Array(32),
        mat4.create(),
        mat4.create(),
      ),
    ).toBe(0);
  } finally {
    frame.release();
    f.dispose();
  }
});

it('keeps a static Binding through incompatible Skeleton versions and restores on a resource-only update', () => {
  const f = fixture(),
    initial = f.skin.capture();
  try {
    f.skin.updateSkeleton(f.skeleton, 1, matrix());
    // An unrelated entity edit can repeat exactly the same static membership.
    expect(() => f.skin.bind(11, f.source, f.skeleton, new Uint32Array([7, 9]))).not.toThrow();
    const mismatch = f.skin.capture();
    try {
      expect(mismatch.jointCount(11)).toBe(2);
      expect(mismatch.available(11)).toBe(false);
      f.skin.updateSkeleton(f.skeleton, 2, f.inverse);
      const restored = f.skin.capture();
      try {
        expect(restored.available(11)).toBe(true);
        const out = new Float32Array(32);
        expect(restored.palette(11, out, mat4.create(), mat4.create())).toBe(true);
        expect(out[12]).toBe(11);
        expect(out[28]).toBe(23);
        expect(restored.historyCompatible(mismatch, 11)).toBe(false);
        expect(initial.available(11)).toBe(true);
      } finally {
        restored.release();
      }
    } finally {
      mismatch.release();
    }
  } finally {
    initial.release();
    f.dispose();
  }
});
