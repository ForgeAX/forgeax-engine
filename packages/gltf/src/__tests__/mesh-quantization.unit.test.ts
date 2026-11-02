import { describe, expect, it } from 'vitest';
import { checkExtensions } from '../check-extensions.js';
import { parseGltf } from '../parse-gltf.js';

// One buffer laid out with 4-byte aligned views:
//   0: POSITION  VEC3 SHORT normalized (3 verts, padded stride 8)
//   24: NORMAL   VEC3 BYTE normalized  (3 verts, padded stride 4)
//   36: TEXCOORD_0 VEC2 UNSIGNED_SHORT normalized (3 verts, stride 4)
//   48: indices  SCALAR UNSIGNED_SHORT (3, padded to 8)
//   56: anim input  SCALAR FLOAT (2)
//   64: anim output VEC4 SHORT normalized rotation (2)
function quantizedGltf(): unknown {
  const bytes = new ArrayBuffer(80);
  const view = new DataView(bytes);
  const positions = [
    [-32767, 0, 0],
    [32767, 0, 0],
    [0, 32767, -16384],
  ];
  positions.forEach((p, i) => {
    p.forEach((v, c) => {
      view.setInt16(i * 8 + c * 2, v, true);
    });
  });
  for (let i = 0; i < 3; i++) view.setInt8(24 + i * 4 + 2, 127);
  const uvs = [
    [0, 0],
    [65535, 0],
    [0, 65535],
  ];
  uvs.forEach((uv, i) => {
    uv.forEach((v, c) => {
      view.setUint16(36 + i * 4 + c * 2, v, true);
    });
  });
  [0, 1, 2].forEach((v, i) => {
    view.setUint16(48 + i * 2, v, true);
  });
  view.setFloat32(56, 0, true);
  view.setFloat32(60, 1, true);
  view.setInt16(64 + 6, 32767, true);
  view.setInt16(72 + 4, 32767, true);
  const base64 = Buffer.from(bytes).toString('base64');
  return {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    buffers: [{ uri: `data:application/octet-stream;base64,${base64}`, byteLength: 80 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 24, byteStride: 8 },
      { buffer: 0, byteOffset: 24, byteLength: 12, byteStride: 4 },
      { buffer: 0, byteOffset: 36, byteLength: 12, byteStride: 4 },
      { buffer: 0, byteOffset: 48, byteLength: 6 },
      { buffer: 0, byteOffset: 56, byteLength: 8 },
      { buffer: 0, byteOffset: 64, byteLength: 16 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5122,
        normalized: true,
        type: 'VEC3',
        count: 3,
        min: [-32767, 0, -16384],
        max: [32767, 32767, 0],
      },
      { bufferView: 1, componentType: 5120, normalized: true, type: 'VEC3', count: 3 },
      { bufferView: 2, componentType: 5123, normalized: true, type: 'VEC2', count: 3 },
      { bufferView: 3, componentType: 5123, type: 'SCALAR', count: 3 },
      { bufferView: 4, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
      { bufferView: 5, componentType: 5122, normalized: true, type: 'VEC4', count: 2 },
    ],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }],
      },
    ],
    nodes: [{ name: 'quantized', mesh: 0, scale: [2, 2, 2] }],
    scenes: [{ nodes: [0] }],
    animations: [
      {
        samplers: [{ input: 4, output: 5 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      },
    ],
  };
}

function rounded(values: ArrayLike<number> | undefined): number[] {
  return Array.from(values ?? [], (v) => Math.round(v * 1000) / 1000);
}

describe('KHR_mesh_quantization', () => {
  it('admits the extension when it is required', () => {
    expect(checkExtensions({ extensionsRequired: ['KHR_mesh_quantization'] }).ok).toBe(true);
  });

  it('dequantizes normalized SHORT/BYTE vertex attributes like Three.js', async () => {
    const result = await parseGltf(
      quantizedGltf(),
      async () => new ArrayBuffer(0),
      'quantized.gltf',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const mesh = result.value.meshes[0];
    expect(rounded(mesh?.positions)).toEqual([-1, 0, 0, 1, 0, 0, 0, 1, -0.5]);
    expect(rounded(mesh?.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(rounded(mesh?.texcoord0)).toEqual([0, 0, 1, 0, 0, 1]);
    // Dequantization stays in the mesh; the node transform keeps its scale.
    expect(Array.from(result.value.nodes[0]?.transform.scale ?? [])).toEqual([2, 2, 2]);
  });

  it('accepts normalized SHORT rotation animation outputs', async () => {
    const result = await parseGltf(
      quantizedGltf(),
      async () => new ArrayBuffer(0),
      'quantized.gltf',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const channel = result.value.animationClips[0]?.channels[0];
    expect(rounded(channel?.sampler.output)).toEqual([0, 0, 0, 1, 0, 0, 1, 0]);
  });

  it('keeps 32-bit integer animation outputs rejected', async () => {
    const doc = quantizedGltf() as { accessors: { componentType: number }[] };
    const output = doc.accessors[5];
    if (output !== undefined) output.componentType = 5125;
    const result = await parseGltf(doc, async () => new ArrayBuffer(0), 'quantized.gltf');
    expect(result.ok).toBe(false);
  });
});
