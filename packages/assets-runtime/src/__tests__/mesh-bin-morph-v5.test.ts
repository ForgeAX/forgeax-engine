import { readFileSync } from 'node:fs';
import { decodeMeshBinary, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { unpackMeshBin } from '../loaders/mesh-bin';
import { defined } from './assert-defined.js';

// Independent byte oracle: deliberately does not use the production encoder/header writer.
function fixture(
  masks: unknown = [1, 6],
  metadata: Record<string, unknown> = {},
  inputLanes?: readonly number[],
) {
  const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
  const lanes = inputLanes ?? [
    -0,
    0.5,
    -0.75,
    1,
    2,
    3,
    4,
    5,
    6,
    ...Array.from({ length: 21 }, (_, i) => i + 0.25),
  ];
  const json = new TextEncoder().encode(
    JSON.stringify({
      submeshes: [{ indexOffset: 0, indexCount: 3, materialSlot: 0 }],
      materialSlots: [{ slotName: 'Default' }],
      morphTargetMasks: masks,
      morphWeights: [0.25, 0.75],
      ...metadata,
    }),
  );
  const storage = new Uint8Array(7 + 80 + 36 + lanes.length * 4 + 6 + json.length + 11);
  const bytes = storage.subarray(7, storage.length - 11);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [offset, value] of [
    [0, 5],
    [4, 1],
    [8, projection.mask],
    [12, 12],
    [16, 3],
    [20, 36],
    [24, 3],
    [28, 2],
    [32, 6],
    [36, json.length],
    [40, lanes.length * 4],
  ])
    view.setUint32(defined(offset), defined(value), true);
  bytes.set(new TextEncoder().encode(projection.digest), 48);
  for (let i = 0; i < 9; i++) view.setFloat32(80 + i * 4, i / 8, true);
  lanes.forEach((value, i) => {
    view.setFloat32(116 + i * 4, value, true);
  });
  for (let i = 0; i < 3; i++) view.setUint16(116 + lanes.length * 4 + i * 2, i, true);
  bytes.set(json, 122 + lanes.length * 4);
  return bytes;
}

const readers = {
  runtime: (bytes: Uint8Array) => {
    const result = unpackMeshBin(bytes, 'fixture/morph');
    return result.ok ? result.value : undefined;
  },
  geometry: (bytes: Uint8Array) => decodeMeshBinary(bytes, []),
};

for (const [name, decode] of Object.entries(readers))
  describe(`${name} morph wire reader`, () => {
    it('reads target-major v5 channels from an unaligned subview into private arrays', () => {
      const bytes = fixture();
      const mesh = defined(decode(bytes));
      expect(mesh).toBeDefined();
      expect(mesh.morphTargets).toHaveLength(2);
      expect(mesh.morphTargets?.[0]?.position).toEqual(
        new Float32Array([-0, 0.5, -0.75, 1, 2, 3, 4, 5, 6]),
      );
      expect(Object.is(mesh.morphTargets?.[0]?.position?.[0], -0)).toBe(true);
      expect(mesh.morphTargets?.[1]?.normal).toEqual(
        new Float32Array(Array.from({ length: 9 }, (_, i) => i + 0.25)),
      );
      expect(mesh.morphTargets?.[1]?.tangent).toEqual(
        new Float32Array(Array.from({ length: 12 }, (_, i) => i + 9.25)),
      );
      expect(mesh.morphWeights).toEqual(new Float32Array([0.25, 0.75]));
      expect(mesh.indices).toEqual(new Uint16Array([0, 1, 2]));
      bytes.fill(0);
      expect(mesh.morphTargets?.[0]?.position?.[1]).toBe(0.5);
    });

    it('restores independent arrays for elided zero channels and preserves subsequent dense offsets', () => {
      const bytes = fixture([63, 63], {}, []);
      const mesh = defined(decode(bytes));
      const repeat = defined(decode(bytes));
      for (const target of mesh.morphTargets ?? []) {
        expect(target.position).toHaveLength(9);
        expect(target.normal).toHaveLength(9);
        expect(target.tangent).toHaveLength(12);
        for (const values of Object.values(target))
          expect([...values].every((value) => Object.is(value, 0))).toBe(true);
      }
      defined(mesh.morphTargets?.[0]?.position)[0] = 42;
      expect(mesh.morphTargets?.[1]?.position?.[0]).toBe(0);
      expect(repeat.morphTargets?.[0]?.position?.[0]).toBe(0);
      const mixed = defined(
        decode(
          fixture(
            [47, 1],
            {},
            Array.from({ length: 18 }, (_, i) => i + 1),
          ),
        ),
      );
      expect(mixed.morphTargets?.[0]?.normal).toEqual(
        new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      );
      expect(mixed.morphTargets?.[0]?.position).toEqual(new Float32Array(9));
      expect(mixed.morphTargets?.[0]?.tangent).toEqual(new Float32Array(12));
      expect(mixed.morphTargets?.[1]?.position).toEqual(
        new Float32Array([10, 11, 12, 13, 14, 15, 16, 17, 18]),
      );
      expect(mixed.indices).toEqual(new Uint16Array([0, 1, 2]));
      expect(mixed.morphWeights).toEqual(new Float32Array([0.25, 0.75]));
    });
    it.each([8, 16, 32, 17, 64, 65])('rejects an invalid zero-channel mask %s', (mask) => {
      expect(decode(fixture([mask], { morphWeights: [1] }, []))).toBeUndefined();
    });
    it('requires exact stored bytes for zero and dense masks', () => {
      expect(decode(fixture([63, 63]))).toBeUndefined();
      expect(decode(fixture([1, 6], {}, []))).toBeUndefined();
    });

    it('loads frozen published v4 bytes with inline morph metadata', () => {
      // Preserve published v4 bytes without tracking a binary in the source repository.
      const bytes = Buffer.from(
        readFileSync(
          new URL('../../../pack/src/__tests__/fixtures/mesh-v4-morph.base64', import.meta.url),
          'utf8',
        ).trim(),
        'base64',
      );
      const mesh = defined(decode(bytes));
      expect(mesh).toBeDefined();
      expect(mesh.morphTargets).toHaveLength(1);
      expect(mesh.morphTargets?.[0]?.position).toEqual(
        new Float32Array(Array.from({ length: 9 }, (_, i) => (i + 1) / 10)),
      );
      expect(mesh.morphTargets?.[0]?.tangent).toEqual(
        new Float32Array(Array.from({ length: 12 }, (_, i) => i + 1)),
      );
      expect(mesh.morphWeights).toEqual(new Float32Array([0.25]));
    });

    it.each([
      undefined,
      null,
      [],
      [0],
      [8],
      [1.5],
      ['1'],
      Array(9).fill(1),
      [1],
    ])('rejects absent, invalid, or wrong-size masks: %j', (masks) => {
      expect(decode(fixture(masks, { morphTargetMasks: masks }))).toBeUndefined();
    });
    it.each([
      2,
      null,
      [null, 'oops'],
      [0.25],
      [1e40, 0],
    ])('rejects invalid morph weights: %j', (weights) => {
      expect(decode(fixture([1, 6], { morphWeights: weights }))).toBeUndefined();
    });
    it.each([NaN, Infinity, -Infinity])('rejects non-finite binary values: %s', (value) => {
      const bytes = fixture();
      new DataView(bytes.buffer, bytes.byteOffset).setFloat32(116, value, true);
      expect(decode(bytes)).toBeUndefined();
    });
    it.each([2, 3, 6])('rejects unsupported wire version %i', (version) => {
      const bytes = fixture();
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(0, version, true);
      expect(decode(bytes)).toBeUndefined();
    });
    it.each([
      [40, 119],
      [40, 124],
      [44, 1],
    ])('rejects malformed header lane %i=%i', (offset, value) => {
      const bytes = fixture();
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, value, true);
      expect(decode(bytes)).toBeUndefined();
    });
    it('rejects inline morphs in v5 and binary morph metadata in v4', () => {
      expect(decode(fixture([1, 6], { morphTargets: [] }))).toBeUndefined();
      const bytes = fixture();
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(0, 4, true);
      expect(decode(bytes)).toBeUndefined();
    });
    it('rejects truncated and trailing payload bytes', () => {
      const bytes = fixture();
      expect(decode(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
      expect(decode(new Uint8Array([...bytes, 0]))).toBeUndefined();
    });
  });
