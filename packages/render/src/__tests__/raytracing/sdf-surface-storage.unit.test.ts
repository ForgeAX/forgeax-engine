import {
  buildVisibilityDistanceField,
  createPlaneGeometry,
  meshDistanceFieldSource,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { packSampledField } from '../../raytracing/sdf-field-storage';
import {
  packSdfSurfacePool,
  validateSdfSurfacePoolHeader,
} from '../../raytracing/sdf-surface-storage';
import { SdfTransformCertificate } from '../../raytracing/sdf-transform-certificate';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
async function source() {
  const mesh = createPlaneGeometry(2, 2).unwrap(),
    input = meshDistanceFieldSource(mesh, { sectionSidedness: [1] }).unwrap();
  return (
    await buildVisibilityDistanceField(input.positions, input.indices, {
      voxelSize: 0.5,
      triangleSidedness: input.triangleSidedness,
    })
  ).unwrap();
}
function row(field: Awaited<ReturnType<typeof source>>, forward = identity, inverse = identity) {
  return {
    field,
    forward,
    inverse,
    certificate: SdfTransformCertificate.create(forward, inverse).unwrap(),
  };
}
function words(array: Float32Array | Uint32Array) {
  return new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4);
}
it('qualifies only exact uploaded lattice facts while retaining legal non-f32 external geometry', async () => {
  const canonical = await source(),
    origin = [...canonical.origin] as [number, number, number];
  origin[0] += 2 ** -25;
  for (const changed of [
    canonical,
    { ...canonical, origin },
    { ...canonical, spacing: canonical.spacing + Number.EPSILON },
  ]) {
    // The changed source centers move by much less than this extra allowance.
    const field = {
      ...changed,
      policy: {
        ...changed.policy,
        unsignedSampleError: changed.policy.unsignedSampleError + 2 ** -16,
      },
    };
    expect(validateMeshDistanceField(field).ok).toBe(true);
    let maximum = 0;
    for (const axis of [0, 1, 2] as const)
      for (let index = 0; index < field.dimensions[axis]; index++)
        maximum = Math.max(
          maximum,
          Math.abs(
            Math.fround(field.origin[axis] + Math.fround(index * field.spacing)) -
              Math.fround(canonical.origin[axis] + Math.fround(index * canonical.spacing)),
          ),
        );
    expect(maximum).toBeLessThan(2 ** -16);
    const packed = packSdfSurfacePool([row(field)], 1).unwrap(),
      expected = changed === canonical ? 1 : 0;
    expect(validateSdfSurfacePoolHeader(packed.words, 0, 1).ok).toBe(true);
    expect(packed.words[11]).toBe(expected);
    // Eligibility never replaces or deletes the exact canonical surface.
    const position = packed.words[12] ?? 0;
    expect(packed.words.subarray(position, position + field.surface.positions.length)).toEqual(
      words(field.surface.positions),
    );
  }
});
it('reserves real row capacity and independently reconstructs every Mesh channel without rebasing local indices', async () => {
  const field = await source(),
    packed = packSdfSurfacePool([row(field), undefined, row(field)], 4).unwrap(),
    pool = packed.words;
  // Independent literal ABI oracle, not production offset/layout helpers.
  expect(Array.from(pool.subarray(0, 4))).toEqual([0x53534650, 4, 4, pool.length]);
  expect(pool[4]).toBe(4 + 4 * 24);
  expect(pool[4 + 2]).toBe(1);
  expect(Array.from(pool.subarray(24, 44))).toEqual(new Array(20).fill(0));
  expect(pool[44]).toBe(pool[4]);
  expect(pool[45]).toBe(pool[5]);
  expect(packed.meshes.size).toBe(1);
  expect(validateSdfSurfacePoolHeader(pool, 0, 4).ok).toBe(true);
  expect(validateSdfSurfacePoolHeader(pool, 1, 4).ok).toBe(false);
  expect(validateSdfSurfacePoolHeader(pool, 2, 4).ok).toBe(true);
  const s = field.surface,
    samples = packSampledField(field.values, field.bricks, field.policy.distanceBand, 4_194_304);
  if (!samples) throw Error('Expected independently packed samples');
  const nodes = new DataView(s.nodes.buffer, s.nodes.byteOffset, s.nodes.byteLength),
    nodeWords = Uint32Array.from({ length: s.nodes.byteLength / 4 }, (_, i) =>
      nodes.getUint32(i * 4, true),
    );
  for (const [slot, expected] of [
    [8, samples],
    [12, words(s.positions)],
    [14, s.indices],
    [16, nodeWords],
    [18, s.primitiveOrder],
    [20, s.triangleSidedness],
  ] as const) {
    const first = pool[slot] ?? -1;
    expect(Array.from(pool.subarray(first, first + expected.length))).toEqual(Array.from(expected));
  }
  const before = field.surface.positions[0];
  pool[pool[12] ?? 0] = 0;
  expect(field.surface.positions[0]).toBe(before);
});
it('shares only Mesh bytes across 1024 rows while keeping each exact source-pair certificate local', async () => {
  const field = await source(),
    forward = identity.slice(),
    inverse = identity.slice();
  forward[0] = 3;
  forward[12] = 1.25;
  inverse[0] = Math.fround(1 / 3);
  inverse[12] = Math.fround(-1.25 / 3);
  const original = row(field),
    changed = row(field, forward, inverse),
    packed = packSdfSurfacePool(
      [original, ...Array.from({ length: 1023 }, () => changed)],
      1024,
    ).unwrap();
  expect(packed.meshes.size).toBe(1);
  expect(packed.words[4]).toBe(4 + 1024 * 24);
  expect(packed.words[24]).toBe(packed.words[4]);
  expect(packed.words[25]).toBe(packed.words[5]);
  expect(packed.words[22]).toBe(0);
  expect(packed.words[23]).toBe(0);
  expect(packed.words[42]).toBeGreaterThan(0);
  expect(packed.words[43]).toBeGreaterThan(0);
  expect(validateSdfSurfacePoolHeader(packed.words, 1023, 1024).ok).toBe(true);
  const stale = { ...changed, inverse: identity };
  expect(packSdfSurfacePool([stale], 1).ok).toBe(false);
});
it('rejects actual capacity, storage span, malformed coefficient metadata and overlapping channels', async () => {
  const field = await source(),
    packed = packSdfSurfacePool([row(field)], 1).unwrap();
  for (const capacity of [0, 1.5, 1025, 2 ** 32])
    expect(packSdfSurfacePool([row(field)], capacity).ok).toBe(false);
  expect(packSdfSurfacePool([row(field), row(field)], 1).ok).toBe(false);
  expect(packSdfSurfacePool([row(field)], 1, packed.words.byteLength - 16).ok).toBe(false);
  expect(packSdfSurfacePool([row(field)], 1, SDF_SURFACE_POOL_LAYOUT.maxBytes + 16).ok).toBe(false);
  expect(validateSdfSurfacePoolHeader(packed.words, 0, 2).ok).toBe(false);
  const headroom = new Uint32Array(packed.words.length + 1);
  headroom.set(packed.words);
  headroom[headroom.length - 1] = 0xffffffff;
  expect(validateSdfSurfacePoolHeader(headroom, 0, 1).ok).toBe(true);
  expect(validateSdfSurfacePoolHeader(packed.words.subarray(0, -4), 0, 1).ok).toBe(false);
  for (const [offset, value] of [
    [0, 0],
    [1, 5],
    [2, 2 ** 32 - 1],
    [3, 2 ** 32 - 1],
    [4, 0],
    [5, 2 ** 32 - 1],
    [6, 2],
    [7, 1],
    [8, 0],
    [9, 0],
    [10, 1],
    [11, 2],
    [12, packed.words[8] ?? 0],
    [13, 2 ** 32 - 1],
    [15, 2 ** 32 - 1],
    [17, 2 ** 32 - 1],
    [19, 2 ** 32 - 1],
    [21, 0],
    [22, 0x7f800000],
    [23, 1],
  ]) {
    const mutant = packed.words.slice();
    mutant[offset ?? -1] = value ?? 0;
    expect(mutant).not.toEqual(packed.words);
    expect(validateSdfSurfacePoolHeader(mutant, 0, 1).ok, `word ${offset}`).toBe(false);
  }
});

it('rejects nonzero unused sidedness bits instead of publishing another implicit primitive', async () => {
  const field = await source(),
    pool = packSdfSurfacePool([row(field)], 1).unwrap().words,
    tail = (pool[20] ?? 0) + (pool[21] ?? 0) - 1,
    mutant = pool.slice();
  mutant[tail] = (mutant[tail] ?? 0) | 0x80000000;
  expect(mutant[tail]).not.toBe(pool[tail]);
  expect(validateSdfSurfacePoolHeader(mutant, 0, 1).ok).toBe(false);
});

it('rounds stored unsigned error outward across exact zero, subnormal, midpoint and finite limits', async () => {
  const field = await source(),
    view = new DataView(new ArrayBuffer(4));
  for (const value of [0, Number.MIN_VALUE, 2 ** -126, 1 + 2 ** -25, 3.4028234663852886e38]) {
    const changed = { ...field, policy: { ...field.policy, unsignedSampleError: value } },
      pool = packSdfSurfacePool([row(changed)], 1).unwrap().words,
      word = pool[10] ?? 0;
    view.setUint32(0, word, true);
    expect(view.getFloat32(0, true)).toBeGreaterThanOrEqual(value);
    expect(word === 0 || (word >= 0x00800000 && word < 0x7f800000)).toBe(true);
  }
  expect(Math.fround(1 + 2 ** -25)).toBeLessThan(1 + 2 ** -25);
  const overflow = { ...field, policy: { ...field.policy, unsignedSampleError: 2 ** 128 } };
  expect(packSdfSurfacePool([row(overflow)], 1).ok).toBe(false);
});

it('shares partial content per pool while keeping coverage and changed material overrides placement-owned', async () => {
  const field = await source();
  const bits = new Uint32Array([1]);
  const partial = { kind: 'partial' as const, opaquePrimitives: bits };
  const packed = packSdfSurfacePool(
    [
      { ...row(field), coverage: partial },
      { ...row(field), coverage: { ...partial, opaquePrimitives: bits.slice() } },
    ],
    2,
  ).unwrap();
  const first = packed.words[7] ?? 0,
    second = packed.words[27] ?? 0;
  expect(first).not.toBe(second);
  expect(Array.from(packed.words.subarray(first, first + 3))).toEqual([0, 2, 2]);
  expect(Array.from(packed.words.subarray(second, second + 3))).toEqual([1, 2, 2]);
  expect(packed.words[first + 3]).toBe(packed.words[second + 3]);
  expect(packed.meshes.size).toBe(1);
  const before = packed.words.slice();
  const changed = packSdfSurfacePool(
    [
      { ...row(field), coverage: partial },
      { ...row(field), coverage: { ...partial, opaquePrimitives: new Uint32Array([2]) } },
    ],
    2,
  ).unwrap();
  expect(changed.meshes.size).toBe(1);
  const changedFirst = changed.words[7] ?? 0,
    changedSecond = changed.words[27] ?? 0;
  expect(changed.words[changedFirst + 3]).not.toBe(changed.words[changedSecond + 3]);
  bits[0] = 2;
  expect(packed.words).toEqual(before);
  const a = packed.coverage[0],
    b = packed.coverage[1];
  if (typeof a !== 'object' || typeof b !== 'object')
    throw Error('Owned partial snapshots required');
  expect(a.opaquePrimitives[0]).toBe(1);
  expect(a.opaquePrimitives).not.toBe(bits);
  expect(a.opaquePrimitives).toBe(b.opaquePrimitives);
});

it('charges only fixed row metadata and one shared partial payload for 1024 instances of one Mesh', async () => {
  const field = await source();
  const one = packSdfSurfacePool([row(field)], 1).unwrap();
  const opaque = packSdfSurfacePool(
    Array.from({ length: 1024 }, () => row(field)),
    1024,
  ).unwrap();
  expect(opaque.words.byteLength - one.words.byteLength).toBe(1023 * 24 * 4);
  const partial = { kind: 'partial' as const, opaquePrimitives: new Uint32Array([1]) };
  const shared = packSdfSurfacePool(
    Array.from({ length: 1024 }, () => ({ ...row(field), coverage: partial })),
    1024,
  ).unwrap();
  expect(shared.words.byteLength - opaque.words.byteLength).toBe(32);
  expect(
    packSdfSurfacePool([{ ...row(field), coverage: partial }], 1, one.words.byteLength).ok,
  ).toBe(false);
});

it('rejects missing or corrupt coverage instead of assuming complete opaque geometry', async () => {
  const field = await source();
  const pool = packSdfSurfacePool(
    [{ ...row(field), coverage: { kind: 'partial', opaquePrimitives: new Uint32Array([1]) } }],
    1,
  ).unwrap().words;
  const record = pool[7] ?? 0,
    payload = pool[record + 3] ?? 0;
  for (const [offset, value] of [
    [7, 0],
    [record, 1],
    [record + 1, 3],
    [record + 2, 3],
    [record + 3, 0xffffffff],
    [payload, 0],
    [payload + 1, 3],
    [payload + 2, 0],
    [payload + 3, 1],
    [payload + 4, 5],
  ]) {
    const changed = pool.slice();
    changed[offset ?? 0] = value ?? 0;
    expect(validateSdfSurfacePoolHeader(changed, 0, 1).ok, `coverage word ${offset}`).toBe(false);
  }
});
