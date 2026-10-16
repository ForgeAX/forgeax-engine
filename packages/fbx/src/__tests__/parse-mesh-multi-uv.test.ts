// parse-mesh-multi-uv.test.ts (feat-20260629-multi-uv-set-support m1-w4).
//
// TDD red-green: byte-level tests for FBX multi-layer UV import. Mock
// FbxRawMesh with 2/3/0 TEXCOORD sets via attributes Record<string,number[]>,
// then run parseMesh -> buildMeshAsset and assert byte-level fidelity of
// each UV set in MeshAsset.attributes (uv, uv1..uvK) and interleaved
// vertex buffer.
//
// Covers: 2/3 sets byte-level fidelity, 0-set boundary (only NORMAL),
// and sparse-set boundary (TEXCOORD_0+TEXCOORD_2, no TEXCOORD_1).

import { decodeMeshBinary } from '@forgeax/engine-geometry';
import type { ImportedAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { FbxRawMesh } from '../parse-mesh.js';
import { parseMesh } from '../parse-mesh.js';
import { buildMeshAsset } from '../to-asset-pack.js';

/** Mock a 4-vertex quad with configurable UV sets. Vertices in XY plane. */
function mockQuadRaw(uvSets: Record<string, number[]>): FbxRawMesh {
  return {
    name: 'MultiUvQuad',
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    attributes: {
      NORMAL: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      ...uvSets,
    },
    polygonCount: 2,
    sourceIndex: 0,
    materialIndex: -1,
  };
}

/** Extract MeshAsset payload from an ImportedAsset (guards kind='mesh'). */
function meshFromAsset(asset: ImportedAsset): MeshAsset {
  if (asset.kind !== 'mesh') throw new TypeError(`expected mesh, got ${asset.kind}`);
  return asset.payload as MeshAsset;
}

/** Computed interleaved FLOATS_PER_VERTEX: 12 base + 2*(uvSetCount-1) for non-skinned. */
function floatsPerVertex(uvSetCount: number): number {
  return 12 + Math.max(0, uvSetCount - 1) * 2;
}

/** Helper: return a Float32Array element at index i, or NaN if out of bounds. */
function atF32(arr: Float32Array | number[], i: number): number {
  return (arr as unknown[])[i] as number;
}

describe('parse-mesh-multi-uv.test.ts', () => {
  describe('parseMesh -> buildMeshAsset multi-UV fidelity', () => {
    it('preserves mixed-width skin lanes and sparse UV gaps through the published binary', () => {
      const pod = parseMesh(mockQuadRaw({ TEXCOORD_3: [1, 2, 3, 4, 5, 6, 7, 8] }), 0);
      const influences = Array.from({ length: 4 }, () => ({
        jointIndices: new Uint16Array([65535, 256, 1, 0]),
        jointWeights: new Float32Array([0.5, 0.25, 0.125, 0.125]),
      }));
      const asset = buildMeshAsset(pod, 'guid-skin-sparse', influences);
      const mesh = meshFromAsset(asset);
      expect(mesh.attributes.uv1).toBeUndefined();
      expect(mesh.attributes.uv2).toBeUndefined();
      expect(mesh.vertices.byteLength).toBe(4 * 96);
      const bytes = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset);
      expect([0, 1, 2, 3].map((lane) => bytes.getUint16(48 + lane * 2, true))).toEqual([
        65535, 256, 1, 0,
      ]);
      expect(Array.from(mesh.vertices.slice(14, 18))).toEqual([0.5, 0.25, 0.125, 0.125]);
      expect(Array.from(mesh.vertices.slice(18, 24))).toEqual([0, 0, 0, 0, 1, 2]);
      expect(Array.from(mesh.vertices.slice(8, 12))).toEqual([1, 0, 0, 1]);
      const body = asset.artifacts?.body;
      expect(body).toBeDefined();
      if (body === undefined) throw new Error('FBX mesh body missing');
      const decoded = decodeMeshBinary(
        body.bytes,
        asset.refs.map((ref) => ref.guid),
      );
      expect(decoded).toBeDefined();
      expect(decoded?.vertices).toEqual(mesh.vertices);
      expect(decoded?.attributes.skinIndex).toEqual(mesh.attributes.skinIndex);
      expect(decoded?.attributes.skinWeight).toEqual(mesh.attributes.skinWeight);
      expect(decoded?.attributes.uv1).toEqual(new Float32Array(8));
      expect(decoded?.attributes.uv2).toEqual(new Float32Array(8));
      expect(decoded?.attributes.uv3).toEqual(mesh.attributes.uv3);
    });

    it('2 UV sets: TEXCOORD_0 + TEXCOORD_1 byte-identical in attributes + interleaved', () => {
      const uv0 = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      const uv1 = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8];
      const raw = mockQuadRaw({ TEXCOORD_0: uv0, TEXCOORD_1: uv1 });
      const pod = parseMesh(raw, 0);
      const asset = buildMeshAsset(pod, 'guid-2uv');
      const mesh = meshFromAsset(asset);

      expect(mesh.submeshes.length).toBe(1);
      expect(mesh.submeshes[0]?.vertexCount).toBe(4);

      const fpv = floatsPerVertex(2);
      expect(mesh.vertices.length).toBe(4 * fpv);

      expect(mesh.attributes.uv).toBeInstanceOf(Float32Array);
      const uvAttr = mesh.attributes.uv as Float32Array;
      expect(uvAttr.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(uvAttr[i]).toBeCloseTo(atF32(uv0, i), 6);
      }

      for (let v = 0; v < 4; v++) {
        const d = v * fpv;
        expect(mesh.vertices[d + 6]).toBeCloseTo(atF32(uv0, v * 2), 6);
        expect(mesh.vertices[d + 7]).toBeCloseTo(atF32(uv0, v * 2 + 1), 6);
      }

      expect(mesh.attributes.uv1, 'uv1 should exist in MeshAsset.attributes').toBeDefined();
      const uv1Attr = mesh.attributes.uv1 as Float32Array | undefined;
      if (!uv1Attr) return;
      expect(uv1Attr.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(uv1Attr[i]).toBeCloseTo(atF32(uv1, i), 6);
      }

      for (let v = 0; v < 4; v++) {
        const d = v * fpv;
        expect(mesh.vertices[d + 12]).toBeCloseTo(atF32(uv1, v * 2), 6);
        expect(mesh.vertices[d + 13]).toBeCloseTo(atF32(uv1, v * 2 + 1), 6);
      }

      for (let k = 2; k <= 7; k++) {
        const key = `uv${k}` as keyof typeof mesh.attributes;
        expect(mesh.attributes[key], `uv${k} should not exist`).toBeUndefined();
      }
    });

    it('3 UV sets: TEXCOORD_0..2 byte-identical', () => {
      const uv0 = [0.0, 0.0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3];
      const uv1 = [1.0, 1.0, 1.1, 1.1, 1.2, 1.2, 1.3, 1.3];
      const uv2 = [2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.3];
      const raw = mockQuadRaw({ TEXCOORD_0: uv0, TEXCOORD_1: uv1, TEXCOORD_2: uv2 });
      const pod = parseMesh(raw, 0);
      const asset = buildMeshAsset(pod, 'guid-3uv');
      const mesh = meshFromAsset(asset);

      const fpv = floatsPerVertex(3);
      expect(mesh.vertices.length).toBe(4 * fpv);

      const uvAttr = mesh.attributes.uv as Float32Array;
      expect(uvAttr.length).toBe(8);
      for (let i = 0; i < 8; i++) expect(uvAttr[i]).toBeCloseTo(atF32(uv0, i), 6);

      expect(mesh.attributes.uv1, 'uv1').toBeDefined();
      const uv1Attr = mesh.attributes.uv1 as Float32Array | undefined;
      if (!uv1Attr) return;
      expect(uv1Attr.length).toBe(8);
      for (let i = 0; i < 8; i++) expect(uv1Attr[i]).toBeCloseTo(atF32(uv1, i), 6);

      expect(mesh.attributes.uv2, 'uv2').toBeDefined();
      const uv2Attr = mesh.attributes.uv2 as Float32Array | undefined;
      if (!uv2Attr) return;
      expect(uv2Attr.length).toBe(8);
      for (let i = 0; i < 8; i++) expect(uv2Attr[i]).toBeCloseTo(atF32(uv2, i), 6);

      for (let v = 0; v < 4; v++) {
        const d = v * fpv;
        expect(mesh.vertices[d + 6]).toBeCloseTo(atF32(uv0, v * 2), 6);
        expect(mesh.vertices[d + 12]).toBeCloseTo(atF32(uv1, v * 2), 6);
        expect(mesh.vertices[d + 14]).toBeCloseTo(atF32(uv2, v * 2), 6);
      }
    });

    it('0 UV sets: only NORMAL, no texcoord attributes', () => {
      const raw = mockQuadRaw({});
      delete (raw.attributes as Record<string, unknown>).TEXCOORD_0;
      const pod = parseMesh(raw, 0);
      const asset = buildMeshAsset(pod, 'guid-0uv');
      const mesh = meshFromAsset(asset);

      const fpv = floatsPerVertex(1);
      expect(mesh.vertices.length).toBe(4 * fpv);

      expect(mesh.attributes.uv).toBeDefined();
      expect(mesh.attributes.position).toBeDefined();
      expect(mesh.attributes.normal).toBeDefined();

      for (let k = 1; k <= 7; k++) {
        const key = `uv${k}` as keyof typeof mesh.attributes;
        expect(mesh.attributes[key], `uv${k} should not exist for 0-UV-set mesh`).toBeUndefined();
      }
    });

    it('sparse UV sets: TEXCOORD_0 + TEXCOORD_2 (no TEXCOORD_1)', () => {
      const uv0 = [0.0, 0.0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3];
      const uv2 = [2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.3];
      const raw = mockQuadRaw({ TEXCOORD_0: uv0, TEXCOORD_2: uv2 });
      const pod = parseMesh(raw, 0);
      const asset = buildMeshAsset(pod, 'guid-sparse');
      const mesh = meshFromAsset(asset);

      const uvAttr = mesh.attributes.uv as Float32Array;
      expect(uvAttr.length).toBe(8);
      for (let i = 0; i < 8; i++) expect(uvAttr[i]).toBeCloseTo(atF32(uv0, i), 6);

      expect(mesh.attributes.uv1, 'uv1 should be undefined for sparse sets').toBeUndefined();

      expect(mesh.attributes.uv2, 'uv2 should exist for sparse set').toBeDefined();
      const uv2Attr = mesh.attributes.uv2 as Float32Array | undefined;
      if (!uv2Attr) return;
      expect(uv2Attr.length).toBe(8);
      for (let i = 0; i < 8; i++) expect(uv2Attr[i]).toBeCloseTo(atF32(uv2, i), 6);

      // uv at offset 6, uv2 at offset 14 (uv1 slot offset 12-13 zeroed)
      const fpv = floatsPerVertex(3);
      expect(mesh.vertices.length).toBe(4 * fpv);
      for (let v = 0; v < 4; v++) {
        const d = v * fpv;
        expect(mesh.vertices[d + 6]).toBeCloseTo(atF32(uv0, v * 2), 6);
        expect(mesh.vertices[d + 12]).toBe(0);
        expect(mesh.vertices[d + 13]).toBe(0);
        expect(mesh.vertices[d + 14]).toBeCloseTo(atF32(uv2, v * 2), 6);
        expect(mesh.vertices[d + 15]).toBeCloseTo(atF32(uv2, v * 2 + 1), 6);
      }
    });
  });
});
