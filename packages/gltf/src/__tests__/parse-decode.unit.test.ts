// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=6):
//   - packages/gltf/src/__tests__/attribute-decode.test.ts
//   - packages/gltf/src/__tests__/decode-accessor.test.ts
//   - packages/gltf/src/__tests__/decompose-node-transform.test.ts
//   - packages/gltf/src/__tests__/parse-animation.test.ts
//   - packages/gltf/src/__tests__/parse-header.test.ts
//   - packages/gltf/src/__tests__/parse-skin.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPONENT_TYPE, decodeAccessor } from '../accessor/decode-accessor.js';
import { parseAnimation } from '../parse-animation.js';
import { parseGlbChunks, parseGltfHeader } from '../parse-glb-chunks.js';
import type { GltfMeshIr } from '../parse-gltf.js';
import { parseGltf } from '../parse-gltf.js';
import { parseSkin } from '../parse-skin.js';
import { decomposeNodeTransform } from '../transform.js';

{
  // ─── from attribute-decode.test.ts ───

  const noopLoader = async (_: string) => new ArrayBuffer(0);

  describe('attribute-decode.test.ts', () => {
    describe('parseGltf attribute decode (T-M2-02)', () => {
      function buildPositionNormalTexcoordTangentJson(includeTangent: boolean): unknown {
        const posBytes = new Uint8Array(36);
        const posF32 = new Float32Array(posBytes.buffer);
        posF32[0] = 1.0;
        posF32[1] = 2.0;
        posF32[2] = 3.0;
        posF32.set([1, 2, 3, 1, 2, 3], 3);

        const normBytes = new Uint8Array(36);
        const normF32 = new Float32Array(normBytes.buffer);
        normF32[0] = 0.0;
        normF32[1] = 1.0;
        normF32[2] = 0.0;
        normF32[3] = 0.0;
        normF32[4] = 1.0;
        normF32[5] = 0.0;
        normF32[6] = 1.0;
        normF32[7] = 0.0;
        normF32[8] = 0.0;

        const texBytes = new Uint8Array(24);
        const texF32 = new Float32Array(texBytes.buffer);
        texF32[0] = 0.0;
        texF32[1] = 0.0;
        texF32[2] = 0.5;
        texF32[3] = 0.5;
        texF32[4] = 1.0;
        texF32[5] = 0.0;

        const tanBytes = new Uint8Array(48);
        const tanF32 = new Float32Array(tanBytes.buffer);
        tanF32[0] = 1.0;
        tanF32[1] = 0.0;
        tanF32[2] = 0.0;
        tanF32[3] = 1.0;
        tanF32[4] = 1.0;
        tanF32[5] = 0.0;
        tanF32[6] = 0.0;
        tanF32[7] = 1.0;
        tanF32[8] = 1.0;
        tanF32[9] = 0.0;
        tanF32[10] = 0.0;
        tanF32[11] = 1.0;

        const buffers: Array<{ uri: string }> = [];
        const bufferViews: Array<Record<string, unknown>> = [];
        const accessors: Array<Record<string, unknown>> = [];

        function addBuf(
          bytes: Uint8Array,
          viewByteLength: number,
          type: string,
          count: number,
        ): number {
          const b64 = btoa(String.fromCharCode(...bytes));
          const bufIdx = buffers.length;
          buffers.push({ uri: `data:application/octet-stream;base64,${b64}` });
          const bvIdx = bufferViews.length;
          bufferViews.push({ buffer: bufIdx, byteOffset: 0, byteLength: viewByteLength });
          const acIdx = accessors.length;
          accessors.push({ bufferView: bvIdx, componentType: 5126, type, count });
          return acIdx;
        }

        const posIdx = addBuf(posBytes, 36, 'VEC3', 3);
        const normIdx = addBuf(normBytes, 36, 'VEC3', 3);
        const texIdx = addBuf(texBytes, 24, 'VEC2', 3);
        const tanIdx = includeTangent ? addBuf(tanBytes, 48, 'VEC4', 3) : -1;

        const primAttributes: Record<string, number> = {
          POSITION: posIdx,
          NORMAL: normIdx,
          TEXCOORD_0: texIdx,
        };
        if (includeTangent) {
          primAttributes.TANGENT = tanIdx;
        }

        return {
          asset: { version: '2.0' },
          buffers,
          bufferViews,
          accessors,
          meshes: [{ name: 'AttrMesh', primitives: [{ attributes: primAttributes }] }],
          materials: [],
          nodes: [],
          scenes: [],
        };
      }

      it('decodes NORMAL as Float32Array with 3-component normals', async () => {
        const json = buildPositionNormalTexcoordTangentJson(false);
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;

        expect(mesh.normals).toBeDefined();
        const normals = mesh.normals;
        if (!normals) return;
        expect(normals.length).toBe(9);
        expect(normals[0]).toBeCloseTo(0.0);
        expect(normals[1]).toBeCloseTo(1.0);
        expect(normals[2]).toBeCloseTo(0.0);
        expect(normals[6]).toBeCloseTo(1.0);
        expect(normals[7]).toBeCloseTo(0.0);
        expect(normals[8]).toBeCloseTo(0.0);
      });

      it('decodes TEXCOORD_0 as Float32Array with 2-component UVs', async () => {
        const json = buildPositionNormalTexcoordTangentJson(false);
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;

        expect(mesh.texcoord0).toBeDefined();
        const uvs = mesh.texcoord0;
        if (!uvs) return;
        expect(uvs.length).toBe(6);
        expect(uvs[0]).toBeCloseTo(0.0);
        expect(uvs[1]).toBeCloseTo(0.0);
        expect(uvs[2]).toBeCloseTo(0.5);
        expect(uvs[3]).toBeCloseTo(0.5);
        expect(uvs[4]).toBeCloseTo(1.0);
        expect(uvs[5]).toBeCloseTo(0.0);
      });

      it('decodes TANGENT as Float32Array with 4-component tangents when present', async () => {
        const json = buildPositionNormalTexcoordTangentJson(true);
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;

        expect(mesh.tangents).toBeDefined();
        const tangents = mesh.tangents;
        if (!tangents) return;
        expect(tangents.length).toBe(12);
        expect(tangents[0]).toBeCloseTo(1.0);
        expect(tangents[1]).toBeCloseTo(0.0);
        expect(tangents[2]).toBeCloseTo(0.0);
        expect(tangents[3]).toBeCloseTo(1.0);
      });

      it('TANGENT is undefined when attribute is absent', async () => {
        const json = buildPositionNormalTexcoordTangentJson(false);
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;

        expect(mesh.tangents).toBeUndefined();
      });

      it('positions still decoded correctly alongside new attributes', async () => {
        const json = buildPositionNormalTexcoordTangentJson(false);
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;

        expect(mesh.positions.length).toBe(9);
        expect(mesh.positions[0]).toBeCloseTo(1.0);
        expect(mesh.positions[1]).toBeCloseTo(2.0);
        expect(mesh.positions[2]).toBeCloseTo(3.0);
      });

      // U32 indices (componentType 5125) are preserved end-to-end rather than
      // rejected. Blender / UniGLTF commonly export U32 even for tiny meshes;
      // the decoder keeps the source width (bridge.ts narrows to U16 when the
      // merged maxIndex fits). Regression guard for the prior over-rejection
      // that surfaced as gltf-accessor-type-mismatch / unknownComponentType.
      it('preserves U32 SCALAR INDICES as Uint32Array (no rejection)', async () => {
        const posBytes = new Uint8Array(36);
        const posF32 = new Float32Array(posBytes.buffer);
        // 3 vertices forming one triangle.
        posF32.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const idxBytes = new Uint8Array(12);
        new Uint32Array(idxBytes.buffer).set([0, 1, 2]);

        const toDataUri = (bytes: Uint8Array) =>
          `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`;

        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: toDataUri(posBytes) }, { uri: toDataUri(idxBytes) }],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36 },
            { buffer: 1, byteOffset: 0, byteLength: 12 },
          ],
          accessors: [
            { bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 },
            { bufferView: 1, componentType: 5125, type: 'SCALAR', count: 3 },
          ],
          // Authored NORMAL keeps the indexed topology (no flat-normal de-indexing).
          meshes: [
            {
              name: 'U32Mesh',
              primitives: [{ attributes: { POSITION: 0, NORMAL: 0 }, indices: 1 }],
            },
          ],
          materials: [],
          nodes: [],
          scenes: [],
        };

        const result = await parseGltf(json, noopLoader, '/u32.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const mesh: GltfMeshIr | undefined = result.value.meshes[0];
        expect(mesh).toBeDefined();
        if (!mesh) return;
        expect(mesh.indices).toBeInstanceOf(Uint32Array);
        expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 2]);
      });
    });
  });
}

{
  // ─── from decode-accessor.test.ts ───

  describe('decode-accessor.test.ts', () => {
    describe('decodeAccessor (w9 fixture set)', () => {
      it('(a) decodes sequential POSITION VEC3 F32 accessor', () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const buffer = new Uint8Array(positions.buffer);
        const result = decodeAccessor({
          accessorIndex: 0,
          accessor: {
            bufferView: 0,
            componentType: COMPONENT_TYPE.F32,
            count: 4,
            type: 'VEC3',
          },
          bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
          buffers: [buffer],
          role: 'attribute',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe('f32');
        expect(Array.from(result.value.data)).toEqual(Array.from(positions));
      });

      it('(b) rejects sparse accessor', () => {
        const result = decodeAccessor({
          accessorIndex: 3,
          accessor: {
            bufferView: 0,
            componentType: COMPONENT_TYPE.F32,
            count: 4,
            type: 'VEC3',
            sparse: {
              count: 1,
              indices: { bufferView: 8, componentType: 5119 },
              values: { bufferView: 9 },
            },
          },
          bufferViews: [{ buffer: 0, byteLength: 48 }],
          buffers: [new Uint8Array(48)],
          role: 'attribute',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-accessor-type-mismatch');
        if (result.error.code !== 'gltf-accessor-type-mismatch') return;
        expect(result.error.detail.accessorIndex).toBe(3);
        expect(result.error.detail.reason).toBe('sparse');
      });

      it('(d) rejects truncated interleaved layout', () => {
        const result = decodeAccessor({
          accessorIndex: 1,
          accessor: {
            bufferView: 0,
            componentType: COMPONENT_TYPE.F32,
            count: 4,
            type: 'VEC3',
          },
          bufferViews: [{ buffer: 0, byteLength: 32, byteStride: 32 }],
          buffers: [new Uint8Array(64)],
          role: 'attribute',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-buffer-out-of-bounds');
      });

      it('(e) widens U8 INDICES to U16', () => {
        const indices = new Uint8Array([0, 1, 2, 0, 2, 3]);
        const result = decodeAccessor({
          accessorIndex: 2,
          accessor: {
            bufferView: 0,
            componentType: COMPONENT_TYPE.U8,
            count: 6,
            type: 'SCALAR',
          },
          bufferViews: [{ buffer: 0, byteLength: 6 }],
          buffers: [indices],
          role: 'indices',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe('u16');
        expect(Array.from(result.value.data as Uint16Array)).toEqual([0, 1, 2, 0, 2, 3]);
      });

      it('(f) rejects accessor whose range overruns bufferView.byteLength', () => {
        const result = decodeAccessor({
          accessorIndex: 5,
          accessor: {
            bufferView: 0,
            byteOffset: 32,
            componentType: COMPONENT_TYPE.F32,
            count: 4,
            type: 'VEC3',
          },
          bufferViews: [{ buffer: 0, byteLength: 48 }],
          buffers: [new Uint8Array(48)],
          role: 'attribute',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-buffer-out-of-bounds');
        if (result.error.code !== 'gltf-buffer-out-of-bounds') return;
        expect(result.error.detail.accessor).toBe(5);
        expect(result.error.detail.bufferIndex).toBe(0);
      });

      it('accepts U16 SCALAR INDICES without widening', () => {
        const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
        const result = decodeAccessor({
          accessorIndex: 9,
          accessor: {
            bufferView: 0,
            componentType: COMPONENT_TYPE.U16,
            count: 6,
            type: 'SCALAR',
          },
          bufferViews: [{ buffer: 0, byteLength: indices.byteLength }],
          buffers: [new Uint8Array(indices.buffer)],
          role: 'indices',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe('u16');
        expect(Array.from(result.value.data)).toEqual([0, 1, 2, 3, 4, 5]);
      });
    });
  });
}

{
  // ─── from decompose-node-transform.test.ts ───

  describe('decompose-node-transform.test.ts', () => {
    describe('decomposeNodeTransform (w10 fixture set)', () => {
      let stderrSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });
      afterEach(() => {
        stderrSpy.mockRestore();
      });

      it('(a) decomposes matrix-only node (translation 1/2/3, identity rotation/scale)', () => {
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
        const diagnostics = { matrixTrsCoexistNodes: [] as number[] };
        const trs = decomposeNodeTransform({ matrix }, 0, diagnostics);
        expect(trs.translation).toEqual([1, 2, 3]);
        expect(Array.from(trs.rotation)).toEqual([0, 0, 0, 1]);
        expect(trs.scale).toEqual([1, 1, 1]);
        expect(diagnostics.matrixTrsCoexistNodes).toEqual([]);
      });

      it('(b) returns explicit TRS-only fields verbatim', () => {
        const diagnostics = { matrixTrsCoexistNodes: [] as number[] };
        const trs = decomposeNodeTransform(
          {
            translation: [4, 5, 6],
            rotation: [0, 0, 0, 1],
            scale: [2, 2, 2],
          },
          1,
          diagnostics,
        );
        expect(trs.translation).toEqual([4, 5, 6]);
        expect(trs.rotation).toEqual([0, 0, 0, 1]);
        expect(trs.scale).toEqual([2, 2, 2]);
        expect(diagnostics.matrixTrsCoexistNodes).toEqual([]);
      });

      it('(c) returns identity TRS when all fields are absent', () => {
        const diagnostics = { matrixTrsCoexistNodes: [] as number[] };
        const trs = decomposeNodeTransform({}, 2, diagnostics);
        expect(trs.translation).toEqual([0, 0, 0]);
        expect(trs.rotation).toEqual([0, 0, 0, 1]);
        expect(trs.scale).toEqual([1, 1, 1]);
      });

      it('(d) prefers matrix when matrix + TRS coexist; warns + records node index', () => {
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
        const diagnostics = { matrixTrsCoexistNodes: [] as number[] };
        const trs = decomposeNodeTransform(
          {
            matrix,
            translation: [99, 99, 99],
            rotation: [0.1, 0.2, 0.3, 0.9],
            scale: [3, 3, 3],
          },
          5,
          diagnostics,
        );
        expect(trs.translation).toEqual([7, 8, 9]);
        expect(diagnostics.matrixTrsCoexistNodes).toEqual([5]);
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const message = stderrSpy.mock.calls[0]?.[0];
        expect(typeof message).toBe('string');
        expect(message as string).toContain('node[5]');
        expect(message as string).toContain('matrix takes precedence');
      });
    });
  });
}

{
  // ─── from parse-animation.test.ts ───

  describe('parse-animation.test.ts', () => {
    describe('parseAnimation', () => {
      it('returns empty array when animationsJson is undefined', () => {
        const r = parseAnimation(undefined, [], [], [], []);
        expect(r.ok && r.value.length).toBe(0);
      });

      it('parses a LINEAR animation with one channel', () => {
        const input = new Float32Array([0, 0.5, 1]);
        const output = new Float32Array([0, 0, 0, 1, 2, 3, 2, 4, 6]);
        const inputBuf = new Uint8Array(input.buffer);
        const outputBuf = new Uint8Array(output.buffer);

        const r = parseAnimation(
          [
            {
              channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
              samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
            },
          ],
          [{ name: 'root' }],
          [
            { componentType: 5126, type: 'SCALAR', count: 3, bufferView: 0 },
            { componentType: 5126, type: 'VEC3', count: 3, bufferView: 1 },
          ],
          [
            { buffer: 0, byteLength: inputBuf.byteLength },
            { buffer: 1, byteLength: outputBuf.byteLength },
          ],
          [inputBuf, outputBuf],
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const clip = r.value[0];
        expect(clip).toBeDefined();
        if (!clip) return;
        expect(clip.duration).toBe(1);
        expect(clip.channels.length).toBe(1);
        const ch = clip.channels[0];
        if (!ch) return;
        expect(ch.property).toBe('translation');
        expect(ch.sampler.interpolation).toBe('LINEAR');
        expect(ch.sampler.input.length).toBe(3);
      });

      it('parses a STEP animation', () => {
        const input = new Float32Array([0, 1, 2]);
        const output = new Float32Array([0, 0, 0, 1, 2, 3, 2, 4, 6]);
        const inputBuf = new Uint8Array(input.buffer);
        const outputBuf = new Uint8Array(output.buffer);

        const r = parseAnimation(
          [
            {
              channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
              samplers: [{ input: 0, output: 1, interpolation: 'STEP' }],
            },
          ],
          [{ name: 'joint' }],
          [
            { componentType: 5126, type: 'SCALAR', count: 3, bufferView: 0 },
            { componentType: 5126, type: 'VEC3', count: 3, bufferView: 1 },
          ],
          [
            { buffer: 0, byteLength: inputBuf.byteLength },
            { buffer: 1, byteLength: outputBuf.byteLength },
          ],
          [inputBuf, outputBuf],
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value[0]?.channels[0]?.sampler.interpolation).toBe('STEP');
      });

      it('rejects missing accessors for cubic interpolation', () => {
        const r = parseAnimation(
          [
            {
              channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
              samplers: [{ input: 0, output: 1, interpolation: 'CUBICSPLINE' }],
            },
          ],
          [{ name: 'j' }],
          [],
          [],
          [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('gltf-buffer-out-of-bounds');
      });

      it('preserves morph weights channel output for playback', () => {
        const input = new Float32Array([0, 1]);
        const output = new Float32Array([0, 0, 0, 1, 1, 1]);
        const inputBuf = new Uint8Array(input.buffer);
        const outputBuf = new Uint8Array(output.buffer);

        const r = parseAnimation(
          [
            {
              channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
              samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
            },
          ],
          [{ name: 'j' }],
          [
            { componentType: 5126, type: 'SCALAR', count: 2, bufferView: 0 },
            { componentType: 5126, type: 'SCALAR', count: 6, bufferView: 1 },
          ],
          [
            { buffer: 0, byteLength: inputBuf.byteLength },
            { buffer: 1, byteLength: outputBuf.byteLength },
          ],
          [inputBuf, outputBuf],
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value[0]?.channels[0]?.property).toBe('weights');
          expect(r.value[0]?.channels[0]?.sampler.output).toHaveLength(6);
        }
      });

      it('computes duration as max(input[last]) across channels', () => {
        const inputA = new Float32Array([0, 1, 2]);
        const inputB = new Float32Array([0, 1, 3]);
        const output = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, 1, 1, 1, 3, 3, 3]);

        const buf = new Uint8Array(new Float32Array([...inputA, ...inputB, ...output]).buffer);
        const r = parseAnimation(
          [
            {
              channels: [
                { sampler: 0, target: { node: 0, path: 'translation' } },
                { sampler: 1, target: { node: 1, path: 'scale' } },
              ],
              samplers: [
                { input: 0, output: 2, interpolation: 'LINEAR' },
                { input: 1, output: 3, interpolation: 'LINEAR' },
              ],
            },
          ],
          [{ name: 'A' }, { name: 'B' }],
          [
            { componentType: 5126, type: 'SCALAR', count: 3, bufferView: 0 },
            { componentType: 5126, type: 'SCALAR', count: 3, bufferView: 1 },
            { componentType: 5126, type: 'VEC3', count: 3, bufferView: 2 },
            { componentType: 5126, type: 'VEC3', count: 3, bufferView: 3 },
          ],
          [
            { buffer: 0, byteLength: 12 },
            { buffer: 1, byteLength: 12 },
            { buffer: 2, byteLength: 36 },
            { buffer: 3, byteLength: 36 },
          ],
          [buf.slice(0, 12), buf.slice(12, 24), buf.slice(24, 60), buf.slice(60, 96)],
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value[0]?.duration).toBe(3);
      });
    });
  });
}

{
  // ─── from parse-header.test.ts ───

  const GLB_MAGIC = 0x46546c67;
  const GLB_VERSION = 2;
  const CHUNK_TYPE_JSON = 0x4e4f534a;
  const CHUNK_TYPE_BIN = 0x004e4942;

  function utf8Bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  function padTo4(bytes: Uint8Array, padByte: number): Uint8Array {
    const remainder = bytes.byteLength % 4;
    if (remainder === 0) return bytes;
    const padded = new Uint8Array(bytes.byteLength + (4 - remainder));
    padded.set(bytes, 0);
    for (let i = bytes.byteLength; i < padded.byteLength; i++) {
      padded[i] = padByte;
    }
    return padded;
  }

  interface BuildOptions {
    readonly magic?: number;
    readonly version?: number;
    readonly overrideLength?: number;
    readonly omitJsonChunk?: boolean;
    readonly jsonChunkLengthOverride?: number;
  }

  function buildGlb(
    jsonText: string,
    binBytes: Uint8Array | null,
    opts: BuildOptions = {},
  ): ArrayBuffer {
    const jsonPadded = padTo4(utf8Bytes(jsonText), 0x20);
    const binPadded = binBytes === null ? null : padTo4(binBytes, 0x00);
    const headerSize = 12;
    const jsonChunkHeaderSize = 8;
    const binChunkHeaderSize = binPadded === null ? 0 : 8;
    const jsonChunkSize = opts.omitJsonChunk ? 0 : jsonChunkHeaderSize + jsonPadded.byteLength;
    const binChunkSize = binPadded === null ? 0 : binChunkHeaderSize + binPadded.byteLength;
    const totalLength = headerSize + jsonChunkSize + binChunkSize;
    const declaredLength = opts.overrideLength ?? totalLength;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    view.setUint32(0, opts.magic ?? GLB_MAGIC, true);
    view.setUint32(4, opts.version ?? GLB_VERSION, true);
    view.setUint32(8, declaredLength, true);
    let offset = headerSize;
    if (!opts.omitJsonChunk) {
      view.setUint32(offset, opts.jsonChunkLengthOverride ?? jsonPadded.byteLength, true);
      view.setUint32(offset + 4, CHUNK_TYPE_JSON, true);
      new Uint8Array(buffer, offset + 8, jsonPadded.byteLength).set(jsonPadded);
      offset += 8 + jsonPadded.byteLength;
    }
    if (binPadded !== null) {
      view.setUint32(offset, binPadded.byteLength, true);
      view.setUint32(offset + 4, CHUNK_TYPE_BIN, true);
      new Uint8Array(buffer, offset + 8, binPadded.byteLength).set(binPadded);
    }
    return buffer;
  }

  const MINIMAL_GLTF_JSON = JSON.stringify({ asset: { version: '2.0' } });

  describe('parse-header.test.ts', () => {
    describe('parseGlbChunks (w7 fixture set)', () => {
      it('(a) accepts a valid GLB with JSON + BIN chunk', () => {
        const bin = new Uint8Array([1, 2, 3, 4]);
        const buffer = buildGlb(MINIMAL_GLTF_JSON, bin);
        const result = parseGlbChunks(buffer, '/fixture/box.glb');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.version).toBe(2);
        expect(result.value.length).toBe(buffer.byteLength);
        expect(new TextDecoder().decode(result.value.jsonChunk).trimEnd()).toBe(MINIMAL_GLTF_JSON);
        expect(result.value.binChunk).toBeDefined();
        expect(result.value.binChunk?.byteLength).toBe(4);
      });

      it('(a2) accepts a valid GLB with JSON chunk only (BIN omitted)', () => {
        const buffer = buildGlb(MINIMAL_GLTF_JSON, null);
        const result = parseGlbChunks(buffer, '/fixture/box.glb');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.binChunk).toBeUndefined();
      });

      it('(b) rejects wrong magic 0xDEADBEEF with gltf-malformed-header', () => {
        const buffer = buildGlb(MINIMAL_GLTF_JSON, null, { magic: 0xdeadbeef });
        const result = parseGlbChunks(buffer, '/fixture/bad-magic.glb');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-malformed-header');
        if (result.error.code !== 'gltf-malformed-header') return;
        expect(result.error.detail.filePath).toBe('/fixture/bad-magic.glb');
        expect(result.error.detail.byteOffset).toBe(0);
        expect(result.error.detail.magic).toBe(0xdeadbeef);
      });

      it('(c) rejects version=1 with gltf-version-unsupported', () => {
        const buffer = buildGlb(MINIMAL_GLTF_JSON, null, { version: 1 });
        const result = parseGlbChunks(buffer, '/fixture/v1.glb');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-version-unsupported');
        if (result.error.code !== 'gltf-version-unsupported') return;
        expect(result.error.detail.filePath).toBe('/fixture/v1.glb');
        expect(result.error.detail.actualVersion).toBe('1');
      });

      it('(d) rejects chunk length past buffer end with gltf-malformed-header', () => {
        const buffer = buildGlb(MINIMAL_GLTF_JSON, null, { jsonChunkLengthOverride: 0xffff });
        const result = parseGlbChunks(buffer, '/fixture/oversized.glb');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-malformed-header');
      });

      it('(e) rejects missing JSON chunk with gltf-malformed-header', () => {
        const buffer = buildGlb(MINIMAL_GLTF_JSON, null, { omitJsonChunk: true });
        const result = parseGlbChunks(buffer, '/fixture/no-json.glb');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-malformed-header');
      });

      it('(f) rejects buffers shorter than the 12-byte header with gltf-malformed-header', () => {
        const buffer = new ArrayBuffer(8);
        const result = parseGlbChunks(buffer, '/fixture/truncated.glb');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-malformed-header');
      });
    });

    describe('parseGltfHeader (asset.version check)', () => {
      it('accepts asset.version === "2.0"', () => {
        const result = parseGltfHeader({ asset: { version: '2.0' } }, '/fixture/box.gltf');
        expect(result.ok).toBe(true);
      });

      it('rejects asset.version === "1.0" with gltf-version-unsupported', () => {
        const result = parseGltfHeader({ asset: { version: '1.0' } }, '/fixture/v1.gltf');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-version-unsupported');
        if (result.error.code !== 'gltf-version-unsupported') return;
        expect(result.error.detail.actualVersion).toBe('1.0');
      });

      it('rejects asset missing entirely with gltf-malformed-header', () => {
        const result = parseGltfHeader({}, '/fixture/no-asset.gltf');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-malformed-header');
      });
    });
  });
}

{
  // ─── from parse-skin.test.ts ───

  function makeNode(
    name: string,
    children: readonly number[] = [],
  ): { name: string; children: readonly number[] } {
    return { name, children };
  }

  describe('parse-skin.test.ts', () => {
    describe('parseSkin', () => {
      it('returns empty array when skinsJson is undefined', () => {
        const r = parseSkin(undefined, [], [], [], []);
        expect(r.ok && r.value.length).toBe(0);
      });

      it('returns empty array when skinsJson is empty', () => {
        const r = parseSkin([], [], [], [], []);
        expect(r.ok && r.value.length).toBe(0);
      });

      it('parses a skin with identity IBM (no IBM accessor)', () => {
        const nodes = [makeNode('root', [1, 2]), makeNode('spine'), makeNode('arm')];
        const r = parseSkin([{ joints: [1, 2] }], nodes, [], [], []);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const s = r.value[0];
        expect(s).toBeDefined();
        if (!s) return;
        expect(s.jointCount).toBe(2);
        expect(s.inverseBindMatrices.length).toBe(32);
        expect(s.inverseBindMatrices[0]).toBe(1);
        expect(s.inverseBindMatrices[5]).toBe(1);
        expect(s.inverseBindMatrices[10]).toBe(1);
        expect(s.inverseBindMatrices[15]).toBe(1);
      });

      it('resolves jointPaths from node hierarchy', () => {
        const nodes = [makeNode('root', [1]), makeNode('spine', [2]), makeNode('arm')];
        const r = parseSkin([{ joints: [2] }], nodes, [], [], []);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const s = r.value[0];
        expect(s).toBeDefined();
        if (!s) return;
        expect(s.jointPaths[0]).toBe('root/spine/arm');
      });

      it('fail-fast on missing joint name', () => {
        const nodes = [
          { name: 'root', children: [1] } as const,
          { name: undefined as unknown as string, children: [] } as {
            name?: string;
            children: readonly number[];
          },
        ];
        const r = parseSkin(
          [{ joints: [1] }],
          nodes as { readonly name?: string; readonly children?: readonly number[] }[],
          [],
          [],
          [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('gltf-skin-joint-name-missing');
      });

      it('fail-fast when joint count exceeds MAX_JOINTS (256)', () => {
        const joints = Array.from({ length: 257 }, (_, i) => i);
        const nodes = joints.map((i) => makeNode(`joint${i}`));
        const r = parseSkin([{ joints }], nodes, [], [], []);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('gltf-skin-joint-count-exceeded');
      });

      it('decodes IBM from MAT4 F32 accessor', () => {
        const ibmData = new Float32Array(16 * 2);
        ibmData[0] = 2;
        ibmData[5] = 3;
        const buffer = new Uint8Array(ibmData.buffer);
        const nodes = [makeNode('root', [1]), makeNode('j1')];
        const r = parseSkin(
          [{ joints: [1], inverseBindMatrices: 0 }],
          nodes,
          [{ componentType: 5126, type: 'MAT4', count: 2, bufferView: 0 }],
          [{ buffer: 0, byteLength: ibmData.byteLength }],
          [buffer],
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const s = r.value[0];
        expect(s).toBeDefined();
        if (!s) return;
        expect(s.inverseBindMatrices[0]).toBeCloseTo(2);
        expect(s.inverseBindMatrices[5]).toBeCloseTo(3);
      });
    });
  });
}
