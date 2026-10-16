// bridge-skin-stride.unit.test.ts (feat-20260611 M2 / w9 + w10).
//
// Covers AC-08: meshIrToMeshAsset per-MeshAsset stride decision.
// - w9: skinned + unskinned primitives sharing one glTF mesh both walk the
//   18-float stride; unskinned primitive's skin slots are zero-filled.
// - w10: a single unskinned primitive stays on the legacy 12-float stride
//   (OOS-9 / AC-04 — learn-render unskinned demos must not regress).

import { describe, expect, it } from 'vitest';
import type { GltfMeshIr } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

function makeUnskinnedPrim(meshIndex: number, vertexCount: number): GltfMeshIr {
  return {
    meshIndex,
    materialIndex: null,
    positions: new Float32Array(vertexCount * 3),
    indices: new Uint16Array(Array.from({ length: vertexCount }, (_, i) => i)),
  };
}

function makeSkinnedPrim(meshIndex: number, vertexCount: number): GltfMeshIr {
  const joints0 = new Uint16Array(vertexCount * 4);
  const weights0 = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    joints0[v * 4 + 0] = v;
    joints0[v * 4 + 1] = v + 1;
    joints0[v * 4 + 2] = v + 2;
    joints0[v * 4 + 3] = v + 3;
    weights0[v * 4 + 0] = 0.4;
    weights0[v * 4 + 1] = 0.3;
    weights0[v * 4 + 2] = 0.2;
    weights0[v * 4 + 3] = 0.1;
  }
  return {
    meshIndex,
    materialIndex: null,
    positions: new Float32Array(vertexCount * 3),
    indices: new Uint16Array(Array.from({ length: vertexCount }, (_, i) => i)),
    joints0,
    weights0,
  };
}

describe('meshIrToMeshAsset stride decision (AC-08)', () => {
  it('skinned + unskinned primitives co-located -> 18F unified, unskinned skin slots zero-filled', () => {
    const skinned = makeSkinnedPrim(0, 3);
    const unskinned = makeUnskinnedPrim(0, 2);
    const asset = meshIrToMeshAsset([skinned, unskinned]);

    const totalVerts = 3 + 2;
    expect(asset.vertices.length / 18).toBe(totalVerts);
    expect(asset.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(asset.attributes.skinWeight).toBeInstanceOf(Float32Array);

    const stride = 18;
    // Layout per deriveVertexBufferLayout (72-byte stride):
    //   pos[0..2] norm[3..5] uv[6..7] tangent[8..11]
    //   skinIndex (uint16x4) at float[12..13] (8 bytes)
    //   skinWeight (float32x4) at float[14..17] (16 bytes)
    const interleavedU16 = new Uint16Array(asset.vertices.buffer);
    for (let v = 0; v < 3; v++) {
      const u16Base = (v * stride + 12) * 2;
      expect(interleavedU16[u16Base + 0]).toBe(v);
      expect(interleavedU16[u16Base + 1]).toBe(v + 1);
      expect(interleavedU16[u16Base + 2]).toBe(v + 2);
      expect(interleavedU16[u16Base + 3]).toBe(v + 3);
      expect(asset.vertices[v * stride + 14]).toBeCloseTo(0.4, 5);
      expect(asset.vertices[v * stride + 15]).toBeCloseTo(0.3, 5);
      expect(asset.vertices[v * stride + 16]).toBeCloseTo(0.2, 5);
      expect(asset.vertices[v * stride + 17]).toBeCloseTo(0.1, 5);
    }
    // Unskinned primitive (vertex 3..4) skin slots must be all zero.
    for (let v = 3; v < totalVerts; v++) {
      const u16Base = (v * stride + 12) * 2;
      expect(interleavedU16[u16Base + 0]).toBe(0);
      expect(interleavedU16[u16Base + 1]).toBe(0);
      expect(interleavedU16[u16Base + 2]).toBe(0);
      expect(interleavedU16[u16Base + 3]).toBe(0);
      expect(asset.vertices[v * stride + 14]).toBe(0);
      expect(asset.vertices[v * stride + 15]).toBe(0);
      expect(asset.vertices[v * stride + 16]).toBe(0);
      expect(asset.vertices[v * stride + 17]).toBe(0);
    }
  });
});

describe('meshIrToMeshAsset pure-unskinned path (AC-04 / AC-08 / OOS-9)', () => {
  it('all primitives unskinned -> 12F stride preserved, no skinIndex/skinWeight in attributes', () => {
    const unskinned = makeUnskinnedPrim(0, 4);
    const asset = meshIrToMeshAsset([unskinned]);

    expect(asset.vertices.length / 12).toBe(4);
    expect(asset.attributes.skinIndex).toBeUndefined();
    expect(asset.attributes.skinWeight).toBeUndefined();
    // Position / normal / uv / tangent attributes still populated.
    expect(asset.attributes.position).toBeInstanceOf(Float32Array);
    expect(asset.attributes.normal).toBeInstanceOf(Float32Array);
    expect(asset.attributes.uv).toBeInstanceOf(Float32Array);
    expect(asset.attributes.tangent).toBeInstanceOf(Float32Array);
  });
});

describe('glTF bridge uses geometry-owned packing', () => {
  it('persists a generated tangent frame when source TANGENT is absent', () => {
    const asset = meshIrToMeshAsset([
      {
        meshIndex: 0,
        materialIndex: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        texcoord0: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
      },
    ]);

    const tangent = asset.attributes.tangent;
    expect(tangent).toBeInstanceOf(Float32Array);
    if (!(tangent instanceof Float32Array)) throw new Error('generated tangent stream missing');
    expect(tangent?.length).toBe(12);
    expect(tangent?.[0]).toBeCloseTo(1, 5);
    expect(tangent?.[1]).toBeCloseTo(0, 5);
    expect(tangent?.[2]).toBeCloseTo(0, 5);
    expect(Math.abs(tangent?.[3] ?? 0)).toBeCloseTo(1, 5);
  });

  it('does not own a parallel 12F/18F stride or uv count calculation', () => {
    const asset = meshIrToMeshAsset([makeUnskinnedPrim(0, 4)]);
    expect(asset.vertices.length / 12).toBe(4);
    expect(asset.attributes.position).toBeInstanceOf(Float32Array);
  });

  it('keeps no-color producer output free of a synthetic color stream', () => {
    const asset = meshIrToMeshAsset([makeUnskinnedPrim(0, 4)]);
    expect(asset.attributes.color).toBeUndefined();
  });
});
