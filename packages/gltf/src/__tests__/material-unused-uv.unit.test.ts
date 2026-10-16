import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

const positionBytes = new Float32Array([0, 0, 0]);
const uvBytes = new Float32Array([0, 0]);
const positionBase64 = Buffer.from(positionBytes.buffer).toString('base64');
const uvBase64 = Buffer.from(uvBytes.buffer).toString('base64');

describe('glTF unused UV sets', () => {
  it('preserves mesh UV sets that no material slot consumes', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_3: 2 } }] }],
        buffers: [
          { uri: `data:application/octet-stream;base64,${positionBase64}`, byteLength: 12 },
          { uri: `data:application/octet-stream;base64,${uvBase64}`, byteLength: 8 },
          { uri: `data:application/octet-stream;base64,${uvBase64}`, byteLength: 8 },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 12 },
          { buffer: 1, byteOffset: 0, byteLength: 8 },
          { buffer: 2, byteOffset: 0, byteLength: 8 },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
          { bufferView: 1, componentType: 5126, count: 1, type: 'VEC2' },
          { bufferView: 2, componentType: 5126, count: 1, type: 'VEC2' },
        ],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
      },
      noopLoader,
      '/unused-uv.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meshes[0]?.texcoord3).toBeInstanceOf(Float32Array);
    expect(
      (result.value.materials[0] as unknown as Record<string, unknown>).coordinatesSet,
    ).toBeUndefined();
  });
});
