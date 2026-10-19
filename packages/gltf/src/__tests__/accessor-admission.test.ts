import { describe, expect, it, vi } from 'vitest';
import { decodeAccessor } from '../accessor/decode-accessor.js';
import { parseGltf } from '../parse-gltf.js';

describe('glTF accessor layout admission', () => {
  it.each([
    'constructor',
    '__proto__',
    'MAT4',
  ])('rejects unsupported Draco attribute shape %s before decoding', async (type) => {
    const decode = vi.fn(async () => {
      throw new Error('decoder must not run');
    });
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        extensionsRequired: ['KHR_draco_mesh_compression'],
        buffers: [{ uri: 'data:application/octet-stream;base64,AA==', byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteLength: 1 }],
        accessors: [{ componentType: 5126, type, count: 3 }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0 },
                extensions: {
                  KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } },
                },
              },
            ],
          },
        ],
      },
      async () => new ArrayBuffer(0),
      'invalid-shape.gltf',
      { draco: { decode } },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'gltf-draco-decode-failed',
        detail: { reason: 'invalid POSITION attribute declaration' },
      },
    });
    expect(decode).not.toHaveBeenCalled();
  });
  it.each([
    'constructor',
    'toString',
    '__proto__',
  ])('rejects inherited shape name %s as a structured failure', (type) => {
    expect(() =>
      decodeAccessor({
        accessorIndex: 0,
        accessor: { componentType: 5126, count: 1, type },
        bufferViews: [],
        buffers: [],
        role: 'attribute',
      }),
    ).not.toThrow();
    expect(
      decodeAccessor({
        accessorIndex: 0,
        accessor: { componentType: 5126, count: 1, type },
        bufferViews: [],
        buffers: [],
        role: 'attribute',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'gltf-accessor-type-mismatch',
        detail: { reason: 'unknownComponentType' },
      },
    });
  });
});
