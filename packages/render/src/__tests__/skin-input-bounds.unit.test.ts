import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { skinGeometryEnvelopes } from '../scene/skin-geometry';
import { SkinInputs } from '../scene/skin-inputs';

function matrix(x = 0) {
  const out = mat4.identity(mat4.create());
  out[12] = x;
  return out;
}
function fixture() {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const inverse = new Float32Array(32);
  inverse.set(matrix(1));
  inverse.set(matrix(-2), 16);
  const skeleton = skin.skeleton(2, inverse);
  const a = matrix(5),
    b = matrix(-3);
  a[0] = -2;
  a[5] = 3;
  a[9] = 0.5;
  b[1] = 2;
  b[10] = -4;
  skin.setJoint(source, 17, a);
  skin.setJoint(source, 29, b);
  skin.bind(0, source, skeleton, new Uint32Array([17, 29]));
  const position = new Float32Array([-2, 1, 0, 3, -1, 2, 0, 2, -1]);
  const skinIndex = new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  const skinWeight = new Float32Array([0.25, 0.75, 0, 0, 2, 0, 0, 0, 0.125, 0.375, 0, 0]);
  const envelopes = skinGeometryEnvelopes({
    kind: 'mesh',
    vertices: new Float32Array(0),
    materialSlots: [],
    submeshes: [],
    attributes: { position, skinIndex, skinWeight },
  });
  if (envelopes === undefined) throw new Error('Expected a supported shared envelope');
  return { arena, skin, source, skeleton, position, skinIndex, skinWeight, envelopes };
}

it('encloses actual weighted vertices and all material-displacement corners with caller-owned output', () => {
  const f = fixture(),
    frame = f.skin.capture(),
    current = mat4.create(),
    inverse = mat4.create();
  try {
    const out = new Float32Array(8).fill(123),
      radius = 0.75;
    expect(frame.bounds(0, f.envelopes, radius, out, current, inverse)).toBe(true);
    expect(Array.from(out.subarray(6))).toEqual([123, 123]);
    for (let vertex = 0; vertex < 3; vertex++)
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 0, 0];
        for (let lane = 0; lane < 4; lane++) {
          const weight = f.skinWeight[vertex * 4 + lane] as number;
          const joint = f.skinIndex[vertex * 4 + lane] as number;
          expect(frame.matrix(0, joint, current, inverse)).toBe(true);
          for (let axis = 0; axis < 3; axis++) {
            let value = current[12 + axis] as number;
            for (let dimension = 0; dimension < 3; dimension++)
              value +=
                (current[dimension * 4 + axis] as number) *
                ((f.position[vertex * 3 + dimension] as number) +
                  ((corner & (1 << dimension)) === 0 ? -radius : radius));
            point[axis] = (point[axis] as number) + value * weight;
          }
        }
        for (let axis = 0; axis < 3; axis++) {
          expect(point[axis]).toBeGreaterThanOrEqual(out[axis] as number);
          expect(point[axis]).toBeLessThanOrEqual(out[axis + 3] as number);
        }
      }
  } finally {
    frame.release();
    f.skin.dispose();
    f.arena.dispose();
  }
});

it('reads fixed current roots independently of later joint changes and rejects incomplete Skin', () => {
  const f = fixture(),
    before = f.skin.capture(),
    current = mat4.create(),
    inverse = mat4.create(),
    out = new Float32Array(6),
    prior = new Float32Array(6);
  try {
    expect(before.bounds(0, f.envelopes, 0, prior, current, inverse)).toBe(true);
    f.skin.setJoint(f.source, 17, matrix(999));
    const next = f.skin.capture();
    try {
      expect(next.bounds(0, f.envelopes, 0, out, current, inverse)).toBe(true);
      expect(out).not.toEqual(prior);
      expect(before.bounds(0, f.envelopes, 0, out, current, inverse)).toBe(true);
      expect(out).toEqual(prior);
    } finally {
      next.release();
    }
    f.skin.removeJoint(f.source, 29);
    const missing = f.skin.capture();
    try {
      out.fill(123);
      expect(missing.bounds(0, f.envelopes, 0, out, current, inverse)).toBe(false);
      expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
    } finally {
      missing.release();
    }
  } finally {
    before.release();
    f.skin.dispose();
    f.arena.dispose();
  }
});

it.each([NaN, Infinity, -1, 1e100])('grants no culling for displacement radius %s', (radius) => {
  const f = fixture(),
    frame = f.skin.capture(),
    out = new Float32Array(6).fill(123);
  try {
    expect(frame.bounds(0, f.envelopes, radius, out, mat4.create(), mat4.create())).toBe(false);
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
  } finally {
    frame.release();
    f.skin.dispose();
    f.arena.dispose();
  }
});

it('leaves unsupported/projective/unrepresentable demand uncullable without writing partial bounds', () => {
  const f = fixture(),
    current = mat4.create(),
    inverse = mat4.create(),
    out = new Float32Array(6).fill(123);
  try {
    const projective = matrix();
    projective[3] = 0.125;
    f.skin.setJoint(f.source, 17, projective);
    const a = f.skin.capture();
    try {
      expect(a.bounds(0, f.envelopes, 0, out, current, inverse)).toBe(false);
    } finally {
      a.release();
    }
    f.skin.setJoint(f.source, 17, matrix(3e38));
    const b = f.skin.capture();
    try {
      expect(b.bounds(0, f.envelopes, 3e38, out, current, inverse)).toBe(false);
      expect(b.bounds(0, undefined, 0, out, current, inverse)).toBe(false);
      const invalid = f.envelopes.slice();
      invalid[2] = 3;
      expect(b.bounds(0, invalid, 0, out, current, inverse)).toBe(false);
      invalid.set(f.envelopes);
      invalid[3] = 100;
      expect(b.bounds(0, invalid, 0, out, current, inverse)).toBe(false);
    } finally {
      b.release();
    }
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
  } finally {
    f.skin.dispose();
    f.arena.dispose();
  }
});

it('rejects overlapping output/scratch/shared Mesh storage before mutation', () => {
  const f = fixture(),
    frame = f.skin.capture(),
    matrix = mat4.create(),
    inverse = mat4.create();
  const saved = f.envelopes.slice();
  try {
    expect(() => frame.bounds(0, f.envelopes, 0, f.envelopes, matrix, inverse)).toThrow();
    expect(() => frame.bounds(0, f.envelopes, 0, matrix, matrix, inverse)).toThrow();
    expect(() => frame.bounds(0, f.envelopes, 0, new Float32Array(6), matrix, matrix)).toThrow();
    expect(() => frame.bounds(0, f.envelopes, 0, new Float32Array(5), matrix, inverse)).toThrow();
    expect(f.envelopes).toEqual(saved);
  } finally {
    frame.release();
    f.skin.dispose();
    f.arena.dispose();
  }
});

it('rejects released roots even for unsupported bounds demand', () => {
  const f = fixture(),
    frame = f.skin.capture();
  try {
    expect(() =>
      frame.bounds(-1, undefined, 0, new Float32Array(6), mat4.create(), mat4.create()),
    ).toThrow();
    frame.release();
    expect(() =>
      frame.bounds(0, undefined, 0, new Float32Array(6), mat4.create(), mat4.create()),
    ).toThrow();
  } finally {
    frame.release();
    f.skin.dispose();
    f.arena.dispose();
  }
});

it.each([
  'cancellation',
  'subnormal',
] as const)('encloses GPU f32 composition differences at %s', (mode) => {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const joint = matrix(),
    inverseBind = matrix();
  let x = 1;
  if (mode === 'cancellation') {
    joint[0] = 2 ** 40 * (1 + 2 ** -23);
    joint[4] = -(2 ** 40);
    inverseBind[0] = 1 - 2 ** -23;
    inverseBind[1] = 1;
  } else {
    joint[0] = 1e-30;
    inverseBind[0] = 1e-10;
    x = 1e38;
  }
  const skeleton = skin.skeleton(1, inverseBind);
  skin.setJoint(source, 17, joint);
  skin.bind(0, source, skeleton, new Uint32Array([17]));
  const frame = skin.capture(),
    out = new Float32Array(6),
    current = mat4.create(),
    inverse = mat4.create();
  const envelopes = new Float32Array([1, 1, 1, 1, x, 0, 0, 0, x, 0, 0, 0]);
  try {
    expect(frame.matrix(0, 0, current, inverse)).toBe(true);
    expect(current[0]).not.toBe(0);
    const gpuCoefficient =
      mode === 'cancellation'
        ? Math.fround(
            Math.fround((joint[0] as number) * (inverseBind[0] as number)) +
              Math.fround((joint[4] as number) * (inverseBind[1] as number)),
          )
        : 0; // A legal GPU f32 flush-to-zero of a subnormal composition.
    expect(gpuCoefficient).toBe(0);
    expect(frame.bounds(0, envelopes, 0, out, current, inverse)).toBe(true);
    expect(out[0]).toBeLessThanOrEqual(0);
    expect(out[3]).toBeGreaterThanOrEqual(0);
  } finally {
    frame.release();
    skin.dispose();
    arena.dispose();
  }
});

it.each([
  'matrix-input',
  'vertex-input',
] as const)('handles GPU source subnormal flushing at %s', (mode) => {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const joint = matrix(),
    inverseBind = matrix();
  if (mode === 'matrix-input') {
    joint[0] = 1e-40;
    inverseBind[0] = 1e38;
  } else joint[0] = 1e38;
  const skeleton = skin.skeleton(1, inverseBind);
  skin.setJoint(source, 17, joint);
  skin.bind(0, source, skeleton, new Uint32Array([17]));
  const frame = skin.capture(),
    out = new Float32Array(6).fill(123);
  const x = mode === 'vertex-input' ? 1e-40 : 1;
  const envelopes = new Float32Array([1, 1, 1, 1, x, 0, 0, 0, x, 0, 0, 0]);
  try {
    const valid = frame.bounds(0, envelopes, 0, out, mat4.create(), mat4.create());
    if (mode === 'matrix-input') {
      expect(valid).toBe(false);
      expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
    } else {
      expect(valid).toBe(true);
      expect(out[0]).toBeLessThanOrEqual(0);
      expect(out[3]).toBeGreaterThanOrEqual(0);
    }
  } finally {
    frame.release();
    skin.dispose();
    arena.dispose();
  }
});

it.each([
  false,
  true,
])('encloses palette-weight FTZ before a large vertex, cancelling=%s', (cancelling) => {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const joint = matrix();
  joint[0] = 1e-34;
  joint[4] = cancelling ? -2e-34 : 0;
  joint[5] = 2 ** -126;
  const skeleton = skin.skeleton(1, matrix());
  skin.setJoint(source, 17, joint);
  skin.bind(0, source, skeleton, new Uint32Array([17]));
  const frame = skin.capture(),
    out = new Float32Array(6),
    weight = Math.fround(1e-4);
  const x = Math.fround(cancelling ? 2e38 : 1e38),
    y = Math.fround(cancelling ? 1e38 : 0);
  const envelopes = new Float32Array([weight, weight, 1, 1, x, y, 0, 0, x, y, 0, 0]);
  try {
    expect(frame.bounds(0, envelopes, 0, out, mat4.create(), mat4.create())).toBe(true);
    // The x coefficient flushes, while y's larger product remains normal.
    const remaining = cancelling ? Math.fround(Math.fround((joint[4] as number) * weight) * y) : 0;
    if (cancelling) expect(remaining).toBeLessThan(-1.9);
    expect(out[0]).toBeLessThanOrEqual(remaining);
    expect(out[3]).toBeGreaterThanOrEqual(remaining);
    expect(out[0]).toBeLessThanOrEqual(remaining / weight);
    expect(out[3]).toBeGreaterThanOrEqual(remaining / weight);
  } finally {
    frame.release();
    skin.dispose();
    arena.dispose();
  }
});

it('leaves a finite box uncullable when weighted palette coefficients can overflow', () => {
  const arena = new GpuInputArena(),
    skin = new SkinInputs(arena),
    source = skin.source();
  const joint = matrix();
  joint[0] = 0.75 * 3.4028234663852886e38;
  joint[12] = 1;
  const skeleton = skin.skeleton(1, matrix());
  skin.setJoint(source, 17, joint);
  skin.bind(0, source, skeleton, new Uint32Array([17]));
  const frame = skin.capture(),
    out = new Float32Array(6).fill(123);
  const envelopes = new Float32Array([2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  try {
    expect(frame.bounds(0, envelopes, 0, out, mat4.create(), mat4.create())).toBe(false);
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
  } finally {
    frame.release();
    skin.dispose();
    arena.dispose();
  }
});
