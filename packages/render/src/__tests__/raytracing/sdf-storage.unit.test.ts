import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  distanceFieldTexel,
} from '@forgeax/engine-geometry';
import { assert, expect, it } from 'vitest';
import { brickDistanceFieldValues } from '../../../../geometry/src/distance-field-bricks';
import { packSdfScene } from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

// Independent address decoder: each 4^3 brick table entry addresses
// 32 payload words. Identical bricks share that payload, including constants.
function codeAt(bytes: Uint8Array, dims: readonly [number, number, number], index: number) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nx = dims[0],
    ny = dims[1];
  const x = index % nx,
    y = Math.floor(index / nx) % ny,
    z = Math.floor(index / (nx * ny));
  const brick =
    (Math.floor(z / 4) * Math.ceil(ny / 4) + Math.floor(y / 4)) * Math.ceil(nx / 4) +
    Math.floor(x / 4);
  const entry = v.getUint32(brick * 4, true);
  const local = ((z % 4) * 4 + (y % 4)) * 4 + (x % 4);
  return v.getInt16(entry * 4 + local * 2, true);
}

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

it('packs sampled visibility into SNORM16 distances with a half-step scalar error bound', async () => {
  const field = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.25,
      triangleSidedness: [0],
    })
  ).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  field.values[0] = 0;
  const source = { instanceId: 1, geometryId: 2, mask: 255, transform, field };
  const packed = packSdfScene([source, { ...source, instanceId: 3 }]).unwrap();
  expect(packed.fields.byteLength % 4).toBe(0);
  const instances = new DataView(packed.instances.buffer);
  expect(instances.getUint32(80, true)).toBe(0);
  expect(instances.getUint32(144 + 80, true)).toBe(0);
  expect(instances.getFloat32(124, true)).toBe(field.policy.distanceBand);
  const band = field.policy.distanceBand;
  let negative = 0,
    positive = 0,
    zero = 0;
  for (let i = 0; i < field.dimensions.reduce((a, b) => a * b); i++) {
    const value = distanceFieldTexel(
      field,
      i % field.dimensions[0],
      Math.floor(i / field.dimensions[0]) % field.dimensions[1],
      Math.floor(i / (field.dimensions[0] * field.dimensions[1])),
    );
    const code = codeAt(packed.fields, field.dimensions, i);
    expect(code).toBe(Math.max(-32767, Math.min(32767, Math.round((value / band) * 32767))));
    const restored = (code / 32767) * band;
    expect(Math.abs(restored - value)).toBeLessThanOrEqual(band / (2 * 32767) + 1e-12);
    if (value < 0) negative++;
    if (value > 0) positive++;
    if (value === 0) {
      zero++;
      expect(code).toBe(0);
    }
  }
  expect(negative).toBeGreaterThan(0);
  expect(positive).toBeGreaterThan(0);
  expect(zero).toBeGreaterThan(0);
});

it('keeps geometric fields bit-exact after boundary SNORM16 bricks and shares immutable inputs', async () => {
  const sampled = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0.4], [0, 1, 2], {
      voxelSize: 0.35,
      triangleSidedness: [1],
    })
  ).unwrap();
  const original = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const storage = new Float32Array(original.values.length + 3);
  const values = storage.subarray(1, original.values.length + 1);
  values.set(original.values);
  const geometric = { ...original, values };
  const source = { instanceId: 1, geometryId: 2, mask: 255, transform, field: sampled };
  const packed = packSdfScene([
    source,
    { ...source, instanceId: 3, geometryId: 4, field: geometric },
    { ...source, instanceId: 5 },
  ]).unwrap();
  const offset = packSdfScene([source]).unwrap().fields.byteLength;
  expect(sampled.dimensions.reduce((a, b) => a * b) % 2).not.toBe(0);
  const instances = new DataView(packed.instances.buffer);
  expect(instances.getUint32(144 + 80, true)).toBe(offset / 4);
  expect(instances.getUint32(288 + 80, true)).toBe(0);
  const dense = Float32Array.from(
    { length: geometric.dimensions.reduce((a, b) => a * b) },
    (_, i) =>
      distanceFieldTexel(
        geometric,
        i % geometric.dimensions[0],
        Math.floor(i / geometric.dimensions[0]) % geometric.dimensions[1],
        Math.floor(i / (geometric.dimensions[0] * geometric.dimensions[1])),
      ),
  );
  expect(packed.fields.byteLength).toBe(offset + dense.byteLength);
  expect(packed.fields.subarray(offset)).toEqual(new Uint8Array(dense.buffer));
  const frozen = packed.fields.slice();
  sampled.values.fill(0);
  geometric.values.fill(0);
  expect(packed.fields).toEqual(frozen);
});

it.each([
  -1, 0, 1,
])('shares one payload for constant %i bricks without changing signed codes', async (sign) => {
  const field = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.25,
      triangleSidedness: [0],
    })
  ).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  field.values.fill(sign * field.policy.distanceBand);
  const packed = packSdfScene([
    {
      instanceId: 1,
      geometryId: 2,
      mask: 255,
      transform,
      field: {
        ...field,
        quality: {
          ...field.quality,
          negativeSamples: sign < 0 ? field.dimensions.reduce((a, b) => a * b) : 0,
        },
      },
    },
  ]).unwrap();
  const bricks = field.dimensions.reduce((n, d) => n * Math.ceil(d / 4), 1);
  expect(packed.fields.byteLength).toBe((bricks + 32) * 4);
  const words = new Uint32Array(packed.fields.buffer);
  for (const word of words.subarray(0, bricks)) expect(word).toBe(bricks);
  for (let i = 0; i < field.dimensions.reduce((a, b) => a * b); i++)
    expect(codeAt(packed.fields, field.dimensions, i)).toBe(sign * 32767);
});

// Keep the full pool admission/rejection/reuse workload under V8 instrumentation.
it('counts tables and payloads against the shared 16 MiB pool before publication', async () => {
  const original = (
    await buildVisibilityDistanceField([0, 0, 0, 4, 0, 0, 0, 4, 4], [0, 1, 2], {
      voxelSize: 0.2,
      triangleSidedness: [1],
    })
  ).unwrap();
  assert(original.policy.kind === 'sampled-visibility');
  const band = original.policy.distanceBand;
  let seed = 123456789;
  const values = Float32Array.from({ length: original.dimensions.reduce((a, b) => a * b) }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 0xffffffff) * band;
  });
  const storage = brickDistanceFieldValues(original.dimensions, values);
  assert(storage);
  const field = { ...original, ...storage, quality: { ...original.quality, negativeSamples: 0 } };
  const source = { instanceId: 0, geometryId: 1, mask: 255, transform, field };
  const one = packSdfScene([source]).unwrap();
  const limit = Math.floor((16 * 1024 * 1024) / one.fields.byteLength);
  expect(limit).toBeLessThan(1024);
  const admitted = Array.from({ length: limit }, (_, i) => ({
    ...source,
    instanceId: i,
    field: { ...field },
  }));
  expect(packSdfScene(admitted, 1024).unwrap().fields.byteLength).toBe(
    limit * one.fields.byteLength,
  );
  const rejected = packSdfScene(
    [...admitted, { ...source, instanceId: limit, field: { ...field } }],
    1024,
  );
  assert(!rejected.ok);
  expect(rejected.error.code).toBe('ray-reference-limit');
  // The same field object across the same roster occupies the pool only once.
  expect(
    packSdfScene(
      admitted.map((m) => ({ ...m, field })),
      1024,
    ).unwrap().fields,
  ).toEqual(one.fields);
}, 15_000);

it('shares nonconstant bricks and preserves distinct payloads when their hashes collide', async () => {
  const { packSampledField } = await import('../../raytracing/sdf-field-storage');
  const hash = (words: Uint32Array) =>
    words.reduce((h, w) => Math.imul(h ^ w, 16777619) >>> 0, 2166136261);
  const original = new Uint32Array(32),
    collision = new Uint32Array(32);
  const target = hash(original);
  // FNV multiplication is invertible modulo 2^32. Choose valid SNORM16 codes.
  for (let first = 1; first < 100; first++) {
    collision[0] = first;
    const prefix = hash(collision.subarray(0, 31));
    collision[31] = (prefix ^ Math.imul(target, 899433627)) >>> 0;
    if (((collision[31] ?? 0) & 65535) !== 32768 && (collision[31] ?? 0) >>> 16 !== 32768) break;
  }
  expect(hash(collision)).toBe(target);
  expect(collision).not.toEqual(original);
  const makeValues = (other: Uint32Array) => {
    const values = new Float32Array(128);
    for (let b = 0; b < 2; b++)
      for (let i = 0; i < 64; i++) {
        const word = (b ? other : original)[i >> 1] ?? 0;
        const code = ((word >>> ((i & 1) * 16)) << 16) >> 16;
        values[((i >> 4) * 4 + ((i >> 2) & 3)) * 8 + (i & 3) + b * 4] = code / 32767;
      }
    const field = brickDistanceFieldValues([8, 4, 4], values);
    assert(field);
    return field;
  };
  const first = makeValues(collision);
  const distinct = packSampledField(first.values, first.bricks, 1, 66);
  assert(distinct);
  expect(distinct.length).toBe(66);
  expect(distinct[0]).not.toBe(distinct[1]);
  expect(packSampledField(first.values, first.bricks, 1, 65)).toBeNull();
  original.set(collision);
  const repeated = makeValues(collision);
  const shared = packSampledField(repeated.values, repeated.bricks, 1, 34);
  assert(shared);
  expect(shared.length).toBe(34);
  expect(shared[0]).toBe(shared[1]);
  expect(packSampledField(repeated.values, repeated.bricks, 1, 33)).toBeNull();
});
