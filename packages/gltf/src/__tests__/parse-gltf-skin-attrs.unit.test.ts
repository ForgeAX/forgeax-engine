// parse-gltf-skin-attrs.unit.test.ts (feat-20260611 M1).
//
// Covers AC-06 (JOINTS_0/WEIGHTS_0 paired-presence fail-fast) and
// AC-10 (UBYTE JOINTS_0 width-convert to Uint16Array at parse stage).
// Owns parseGltf primitive-decode skin-attr surface; parse-decode.unit.test.ts
// continues to cover positions/normals/texcoord/tangent.

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

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

interface SkinPrimitiveOptions {
  readonly includeJoints: boolean;
  readonly includeWeights: boolean;
  readonly jointsComponentType: number;
}

// glTF spec component-type IDs.
const UBYTE = 5121;
const FLOAT = 5126;

function buildSkinPrimitiveJson(opts: SkinPrimitiveOptions): unknown {
  // 4 vertices for VEC4 attributes; positions are VEC3.
  const buffers: BufferEntry[] = [];
  const bufferViews: BufferViewEntry[] = [];
  const accessors: AccessorEntry[] = [];

  function addBuf(bytes: Uint8Array, type: string, count: number, componentType: number): number {
    const bufIdx = buffers.length;
    buffers.push({ uri: `data:application/octet-stream;base64,${bytesToB64(bytes)}` });
    const bvIdx = bufferViews.length;
    bufferViews.push({ buffer: bufIdx, byteOffset: 0, byteLength: bytes.byteLength });
    const acIdx = accessors.length;
    accessors.push({ bufferView: bvIdx, byteOffset: 0, componentType, count, type });
    return acIdx;
  }

  // Positions: 4 vertices * VEC3 * F32 = 48 bytes.
  const posBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer);
  const posIdx = addBuf(posBytes, 'VEC3', 4, FLOAT);

  let jointsIdx: number | undefined;
  if (opts.includeJoints) {
    if (opts.jointsComponentType === UBYTE) {
      // 4 vertices * VEC4 * U8 = 16 bytes; include 0 and 255 boundaries.
      const j = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255]);
      jointsIdx = addBuf(j, 'VEC4', 4, UBYTE);
    } else {
      // U16 path: 4 * VEC4 * 2 = 32 bytes.
      const j16 = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 65535]);
      const jBytes = new Uint8Array(j16.buffer);
      jointsIdx = addBuf(jBytes, 'VEC4', 4, 5123);
    }
  }
  let weightsIdx: number | undefined;
  if (opts.includeWeights) {
    const w = new Float32Array([
      1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.25, 0.25, 0.25, 0.25, 0.7, 0.1, 0.1, 0.1,
    ]);
    const wBytes = new Uint8Array(w.buffer);
    weightsIdx = addBuf(wBytes, 'VEC4', 4, FLOAT);
  }

  const attributes: Record<string, number> = { POSITION: posIdx };
  if (jointsIdx !== undefined) attributes.JOINTS_0 = jointsIdx;
  if (weightsIdx !== undefined) attributes.WEIGHTS_0 = weightsIdx;

  return {
    asset: { version: '2.0' },
    buffers,
    bufferViews,
    accessors,
    meshes: [{ name: 'SkinMesh', primitives: [{ attributes }] }],
    materials: [],
    nodes: [],
    scenes: [],
  };
}

describe('parse-gltf-skin-attrs.unit.test.ts', () => {
  describe('parseGltf JOINTS_0 / WEIGHTS_0 paired skinning attributes', () => {
    it('AC-10: UBYTE JOINTS_0 width-converts to Uint16Array (length 16, 0/255 boundaries preserved)', async () => {
      const json = buildSkinPrimitiveJson({
        includeJoints: true,
        includeWeights: true,
        jointsComponentType: UBYTE,
      });
      const result = await parseGltf(json, noopLoader, '/skin.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh: GltfMeshIr | undefined = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      expect(mesh.joints0).toBeDefined();
      const joints = mesh.joints0;
      if (!joints) return;
      expect(joints).toBeInstanceOf(Uint16Array);
      expect(joints.length).toBe(16);
      // Source UBYTE values: 0..14, 255 (boundary).
      const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255];
      for (let i = 0; i < 16; i++) {
        expect(joints[i]).toBe(expected[i]);
      }
    });

    it('AC-06: JOINTS_0 present without WEIGHTS_0 -> gltf-skin-attr-asymmetric (hasJoints=true)', async () => {
      const json = buildSkinPrimitiveJson({
        includeJoints: true,
        includeWeights: false,
        jointsComponentType: UBYTE,
      });
      const result = await parseGltf(json, noopLoader, '/skin.gltf');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('gltf-skin-attr-asymmetric');
      if (result.error.code !== 'gltf-skin-attr-asymmetric') return;
      expect(result.error.detail.hasJoints).toBe(true);
      expect(result.error.detail.hasWeights).toBe(false);
      expect(result.error.detail.meshIndex).toBe(0);
      expect(result.error.detail.primitiveIndex).toBe(0);
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    });

    it('AC-06: WEIGHTS_0 present without JOINTS_0 -> gltf-skin-attr-asymmetric (hasWeights=true)', async () => {
      const json = buildSkinPrimitiveJson({
        includeJoints: false,
        includeWeights: true,
        jointsComponentType: UBYTE,
      });
      const result = await parseGltf(json, noopLoader, '/skin.gltf');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('gltf-skin-attr-asymmetric');
      if (result.error.code !== 'gltf-skin-attr-asymmetric') return;
      expect(result.error.detail.hasJoints).toBe(false);
      expect(result.error.detail.hasWeights).toBe(true);
    });

    it('AC-06+AC-10: complete skin pair parses cleanly + non-skin attrs unaffected', async () => {
      const json = buildSkinPrimitiveJson({
        includeJoints: true,
        includeWeights: true,
        jointsComponentType: UBYTE,
      });
      const result = await parseGltf(json, noopLoader, '/skin.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const mesh: GltfMeshIr | undefined = result.value.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      // (b) joints0 typed + length === vertex count * 4.
      expect(mesh.joints0).toBeInstanceOf(Uint16Array);
      expect(mesh.joints0?.length).toBe(16);
      // (c) weights0 typed + length === vertex count * 4.
      expect(mesh.weights0).toBeInstanceOf(Float32Array);
      expect(mesh.weights0?.length).toBe(16);
      // (d) positions still decoded; no regression on the non-skin path.
      expect(mesh.positions).toBeInstanceOf(Float32Array);
      expect(mesh.positions.length).toBe(12);
      expect(mesh.positions[0]).toBeCloseTo(0);
      expect(mesh.positions[3]).toBeCloseTo(1);
    });
  });
});
