// parse-gltf-multi-uv.test.ts (feat-20260629-multi-uv-set-support m1-w1).
//
// TDD red-green-red: byte-level tests for TEXCOORD_0..7 parsing. Uses
// hand-crafted glTF JSON with data: URIs to exercise the primitive-decode
// loop.  Initial state is RED because GltfMeshIr currently only carries
// texcoord0 — texcoord1..texcoord7 fields do not yet exist.
//
// Covers: 2/3/8 sets byte-level fidelity, sparse (skip-index) boundary,
// and missing TEXCOORD_0 → texcoord0 undefined.

import { describe, expect, it } from 'vitest';
import type { GltfMeshIr } from '../parse-gltf.js';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_: string) => new ArrayBuffer(0);

interface BufferEntry {
  readonly uri: string;
}
interface BufferViewEntry {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}
interface AccessorEntry {
  readonly bufferView: number;
  readonly byteOffset: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
}

const FLOAT = 5126;

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function addBuf(
  buffers: BufferEntry[],
  bufferViews: BufferViewEntry[],
  accessors: AccessorEntry[],
  bytes: Uint8Array,
  type: string,
  count: number,
  componentType: number,
): number {
  const bufIdx = buffers.length;
  buffers.push({ uri: `data:application/octet-stream;base64,${bytesToB64(bytes)}` });
  const bvIdx = bufferViews.length;
  bufferViews.push({ buffer: bufIdx, byteOffset: 0, byteLength: bytes.byteLength });
  const acIdx = accessors.length;
  accessors.push({ bufferView: bvIdx, byteOffset: 0, componentType, count, type });
  return acIdx;
}

/**
 * Build a minimal glTF 2.0 JSON document with configurable TEXCOORD sets.
 *
 * @param texcoordSets  Array of UV data arrays (Float32Array per set).
 *                      undefined entries represent missing sets (skip).
 */
function buildMultiUvJson(texcoordSets: ReadonlyArray<Float32Array | undefined>): unknown {
  const buffers: BufferEntry[] = [];
  const bufferViews: BufferViewEntry[] = [];
  const accessors: AccessorEntry[] = [];

  // Positions: 4 vertices * VEC3 * F32 = 48 bytes.
  const posF32 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const posIdx = addBuf(
    buffers,
    bufferViews,
    accessors,
    new Uint8Array(posF32.buffer),
    'VEC3',
    4,
    FLOAT,
  );

  const attributes: Record<string, number> = { POSITION: posIdx };

  for (let k = 0; k < texcoordSets.length; k++) {
    const set = texcoordSets[k];
    if (set === undefined) continue;
    const bytes = new Uint8Array(set.buffer);
    const count = set.byteLength / 4 / 2;
    const idx = addBuf(buffers, bufferViews, accessors, bytes, 'VEC2', count, FLOAT);
    attributes[`TEXCOORD_${k}`] = idx;
  }

  return {
    asset: { version: '2.0' },
    buffers,
    bufferViews,
    accessors,
    meshes: [{ name: 'MultiUvMesh', primitives: [{ attributes }] }],
    materials: [],
    nodes: [],
    scenes: [],
  };
}

/** Cast a GltfMeshIr to a dynamic record for forward-looking field access (texcoord1..7). */
function asDict(mesh: GltfMeshIr): Record<string, unknown> {
  return mesh as unknown as Record<string, unknown>;
}

describe('parse-gltf-multi-uv.test.ts', () => {
  describe('parseGltf TEXCOORD_0..7 multi-UV parsing', () => {
    it('parses 2 sets of UV (TEXCOORD_0 + TEXCOORD_1) byte-identical', async () => {
      const uv0 = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      const uv1 = new Float32Array([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]);
      const json = buildMultiUvJson([uv0, uv1]);
      const result = await parseGltf(json, noopLoader, '/multi-uv.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh: GltfMeshIr | undefined = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      // texcoord0 must exist and match byte-for-byte
      expect(mesh.texcoord0).toBeInstanceOf(Float32Array);
      expect(mesh.texcoord0?.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(mesh.texcoord0?.[i]).toBeCloseTo(uv0[i] ?? NaN, 6);
      }

      // texcoord1 should exist once GltfMeshIr is extended (m1-w2).
      // Until then, this assertion will fail (RED — expected TDD red phase).
      // After m1-w2 adds texcoord1 to GltfMeshIr and parse-gltf.ts decodes
      // TEXCOORD_1, this assertion becomes green.
      const meshRecord = asDict(mesh);
      const uv1Actual = meshRecord.texcoord1 as Float32Array | undefined;
      expect(uv1Actual, 'texcoord1 should exist on GltfMeshIr after m1-w2').toBeDefined();
      if (!uv1Actual) return;
      expect(uv1Actual.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(uv1Actual[i]).toBeCloseTo(uv1[i] ?? NaN, 6);
      }
    });

    it('parses 3 sets of UV (TEXCOORD_0..2) byte-identical', async () => {
      const uv0 = new Float32Array([0.0, 0.0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
      const uv1 = new Float32Array([1.0, 1.0, 1.1, 1.1, 1.2, 1.2, 1.3, 1.3]);
      const uv2 = new Float32Array([2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.3]);
      const json = buildMultiUvJson([uv0, uv1, uv2]);
      const result = await parseGltf(json, noopLoader, '/multi-uv.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      expect(mesh.texcoord0?.length).toBe(8);
      const meshRecord = asDict(mesh);
      const uv1Actual = meshRecord.texcoord1 as Float32Array | undefined;
      const uv2Actual = meshRecord.texcoord2 as Float32Array | undefined;
      expect(uv1Actual, 'texcoord1').toBeDefined();
      expect(uv2Actual, 'texcoord2').toBeDefined();
      if (!uv1Actual || !uv2Actual) return;
      expect(uv1Actual.length).toBe(8);
      expect(uv2Actual.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(uv1Actual[i]).toBeCloseTo(uv1[i] ?? NaN, 6);
        expect(uv2Actual[i]).toBeCloseTo(uv2[i] ?? NaN, 6);
      }
    });

    it('parses 8 sets of UV (TEXCOORD_0..7) byte-identical', async () => {
      const sets = Array.from({ length: 8 }, (_, k) => {
        const arr = new Float32Array(8); // 4 verts * 2
        for (let i = 0; i < 8; i++) arr[i] = k + i * 0.01;
        return arr;
      });
      const json = buildMultiUvJson(sets);
      const result = await parseGltf(json, noopLoader, '/multi-uv.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      expect(mesh.texcoord0?.length).toBe(8);

      const meshRecord = asDict(mesh);
      for (let k = 1; k <= 7; k++) {
        const actual = meshRecord[`texcoord${k}`] as Float32Array | undefined;
        expect(actual, `texcoord${k} should exist`).toBeDefined();
        if (!actual) continue;
        expect(actual.length).toBe(8);
        for (let i = 0; i < 8; i++) {
          expect(actual[i]).toBeCloseTo(sets[k]?.[i] ?? NaN, 6);
        }
      }
    });

    it('handles sparse UV sets: TEXCOORD_0 + TEXCOORD_2 (no TEXCOORD_1) → texcoord1 undefined', async () => {
      const uv0 = new Float32Array([0.0, 0.0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
      const uv2 = new Float32Array([2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.3]);
      const json = buildMultiUvJson([uv0, undefined, uv2]);
      const result = await parseGltf(json, noopLoader, '/sparse-uv.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      expect(mesh.texcoord0?.length).toBe(8);

      const meshRecord = asDict(mesh);
      // texcoord1 should be undefined (missing set)
      expect(meshRecord.texcoord1, 'texcoord1 should be undefined for sparse set').toBeUndefined();
      // texcoord2 should exist
      const uv2Actual = meshRecord.texcoord2 as Float32Array | undefined;
      expect(uv2Actual, 'texcoord2 should exist even when texcoord1 is skipped').toBeDefined();
      if (!uv2Actual) return;
      expect(uv2Actual.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(uv2Actual[i]).toBeCloseTo(uv2[i] ?? NaN, 6);
      }
    });

    it('handles mesh with no TEXCOORD_0 → texcoord0 undefined', async () => {
      const json = buildMultiUvJson([]); // zero UV sets
      const result = await parseGltf(json, noopLoader, '/no-uv.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      expect(mesh.texcoord0).toBeUndefined();
      expect(mesh.positions.length).toBe(12); // positions still decoded
    });
  });
});
