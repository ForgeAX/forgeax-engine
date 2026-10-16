// glTF 2.0 section 3.7.2.1: when NORMAL is absent, client implementations
// MUST calculate flat normals. Indexed corners split by face normal and re-weld
// when every attribute matches; non-indexed primitives keep their layout.

import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_: string) => new ArrayBuffer(0);
const FLOAT = 5126;
const USHORT = 5123;

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

// Two triangles of a quad folded along the x axis: one in z=0, one in y=0.
const FOLDED = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -1]);
const FOLDED_INDICES = [0, 1, 2, 0, 1, 3];
const FOLDED_SOUP = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1]);

function buildJson(positions: Float32Array, indices?: readonly number[], mode?: number): unknown {
  const buffers: { uri: string }[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: {
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: string;
  }[] = [];
  function add(view: ArrayBufferView, type: string, count: number, componentType: number) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    buffers.push({ uri: `data:application/octet-stream;base64,${bytesToB64(bytes)}` });
    bufferViews.push({ buffer: buffers.length - 1, byteOffset: 0, byteLength: bytes.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType,
      count,
      type,
    });
    return accessors.length - 1;
  }
  const count = positions.length / 3;
  const uv = new Float32Array(count * 2).map((_, i) => i / 10);
  const attributes = {
    POSITION: add(positions, 'VEC3', count, FLOAT),
    TEXCOORD_0: add(uv, 'VEC2', count, FLOAT),
  };
  const primitive: Record<string, unknown> = { attributes };
  if (indices !== undefined)
    primitive.indices = add(new Uint16Array(indices), 'SCALAR', indices.length, USHORT);
  if (mode !== undefined) primitive.mode = mode;
  return {
    asset: { version: '2.0' },
    buffers,
    bufferViews,
    accessors,
    meshes: [{ name: 'Folded', primitives: [primitive] }],
    materials: [],
    nodes: [],
    scenes: [],
  };
}

describe('parseGltf flat normals for primitives without NORMAL', () => {
  it('splits indexed corners shared by faces with different normals', async () => {
    const result = await parseGltf(buildJson(FOLDED, FOLDED_INDICES), noopLoader, '/flat.gltf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.meshes[0];
    if (mesh === undefined) throw new Error('mesh missing');
    expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(mesh.positions)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1,
    ]);
    expect(Array.from(mesh.texcoord0 ?? [])).toEqual(
      FOLDED_INDICES.flatMap((v) => [Math.fround((v * 2) / 10), Math.fround((v * 2 + 1) / 10)]),
    );
    expect(Array.from(mesh.normals ?? [], (v) => v + 0)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
  });

  it('computes face normals in place for a non-indexed triangle primitive', async () => {
    const result = await parseGltf(buildJson(FOLDED_SOUP), noopLoader, '/flat.gltf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.meshes[0];
    if (mesh === undefined) throw new Error('mesh missing');
    expect(mesh.positions.length).toBe(18);
    expect(Array.from(mesh.normals ?? [], (v) => v + 0)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
  });

  it('keeps coplanar faces welded to their shared vertices', async () => {
    const flat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const result = await parseGltf(buildJson(flat, [0, 1, 2, 2, 1, 3]), noopLoader, '/quad.gltf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.meshes[0];
    if (mesh === undefined) throw new Error('mesh missing');
    expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 2, 2, 1, 3]);
    expect(Array.from(mesh.positions)).toEqual(Array.from(flat));
    expect(Array.from(mesh.normals ?? [], (v) => v + 0)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it('leaves non-triangle primitives without synthesized normals', async () => {
    const result = await parseGltf(buildJson(FOLDED, FOLDED_INDICES, 1), noopLoader, '/lines.gltf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meshes[0]?.normals).toBeUndefined();
    expect(result.value.meshes[0]?.indices).toBeDefined();
  });
});
