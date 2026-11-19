import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { decodeMeshBinary } from '../assets/mesh-binary';
import { packMeshBin, prepareMeshData } from '../mesh-data';
import { copyMeshAttribute, meshAttributeChannels, meshAttributeWindow } from '../mesh-storage';
import { packMeshTangentFrame32 } from '../pack-tangent-frame32';
import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '../vertex-attribute-layout';

function fixture(): MeshAsset {
  const attributes = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([-0, 2, 3, 4, 5, 6]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1]),
    uv1: new Float32Array([2179, 0, 2179, 0, 2179, 0]),
  };
  const vertices = packInterleavedVertexAttributes(attributes, 3).unwrap().vertices;
  return {
    kind: 'mesh',
    attributes,
    vertices,
    indices: new Uint16Array([0, 1, 2]),
    materialSlots: [{ slotName: 'wall' }],
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' },
    ],
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
  };
}

it('uses 32-byte terrain rows while preserving UV bits, positions, bounds and topology', () => {
  const source = fixture(),
    snapshot = source.vertices.slice();
  const backing = new Float32Array(source.vertices.length + 8).fill(77);
  backing.set(source.vertices, 4);
  const packed = packMeshTangentFrame32({ ...source, vertices: backing.subarray(4, -4) }).unwrap();
  expect(deriveVertexLayoutProjection(packed.attributes).arrayStride).toBe(32);
  expect(packed.vertices.byteLength).toBe(3 * 32);
  expect(packed.attributeStorage).toBe('interleaved');
  expect(packed.attributes.normal).toBeUndefined();
  expect(packed.attributes.tangent).toBeUndefined();
  expect(packed.attributes.tangentFrame).toBeInstanceOf(Uint32Array);
  expect(
    Object.values(packed.attributes).every(
      (value) =>
        ArrayBuffer.isView(value) && value.byteLength === 0 && value.buffer.byteLength === 0,
    ),
  ).toBe(true);
  for (const key of ['position', 'uv', 'uv1'] as const) {
    const actual = copyMeshAttribute(packed, key) as Float32Array,
      expected = source.attributes[key] as Float32Array;
    expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
  }
  expect(source.vertices).toEqual(snapshot);
  expect(packed.indices).toBe(source.indices);
  expect(packed.aabb).toBe(source.aabb);
  expect(packed.submeshes).toBe(source.submeshes);
  expect(meshAttributeWindow(packed, 'tangentFrame')?.count).toBe(3);
  expect(
    Array.from(copyMeshAttribute(packed, 'tangent') as Float32Array).filter((_, i) => i % 4 === 3),
  ).toEqual([1, -1, 1]);
  expect(prepareMeshData(packed, 'test').ok).toBe(true);
  expect(packMeshTangentFrame32(packed).unwrap()).toBe(packed);
});

it('round-trips the versioned binary and keeps arbitrary u32 patterns out of float validation', () => {
  const packed = packMeshTangentFrame32(fixture()).unwrap();
  const frame = meshAttributeWindow(packed, 'tangentFrame') as NonNullable<
    ReturnType<typeof meshAttributeWindow>
  >;
  frame.data[frame.offset] = 0x7fc00000;
  expect(prepareMeshData(packed, 'bits').ok).toBe(true);
  const bytes = packMeshBin(packed, 'bits').unwrap();
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(6);
  const restored = decodeMeshBinary(bytes, [], 'interleaved') as MeshAsset;
  expect(restored).toBeDefined();
  expect(
    new Uint32Array(
      restored.vertices.buffer,
      restored.vertices.byteOffset,
      restored.vertices.length,
    ),
  ).toEqual(new Uint32Array(packed.vertices.buffer));
  expect(restored.attributes.tangentFrame).toBeInstanceOf(Uint32Array);
  expect(meshAttributeWindow(restored, 'tangentFrame')?.data.buffer).toBe(restored.vertices.buffer);
  expect(copyMeshAttribute(restored, 'normal')?.every(Number.isFinite)).toBe(true);
  const authored = meshAttributeChannels(restored);
  expect(authored.tangentFrame).toBeUndefined();
  expect(authored.normal).toHaveLength(9);
  expect(authored.tangent).toHaveLength(12);
});

it('rejects coexisting packed and expanded directions and invalid source frames', () => {
  const original = fixture(),
    packed = packMeshTangentFrame32(original).unwrap();
  expect(
    prepareMeshData(
      { ...packed, attributes: { ...packed.attributes, normal: new Float32Array(0) } },
      'duplicate',
    ).ok,
  ).toBe(false);
  (original.attributes.normal as Float32Array).fill(0);
  expect(packMeshTangentFrame32(original).ok).toBe(false);
});
