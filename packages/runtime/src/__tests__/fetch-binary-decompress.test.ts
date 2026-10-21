import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';
import { binaryAssetFixture } from './helpers/binary-asset-fixture';

function makeMeshBinPayload(): Uint8Array {
  const attributes = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: new Float32Array(6),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  };
  const { vertices } = packInterleavedVertexAttributes(attributes, 3).unwrap();
  const indices = new Uint16Array([0, 1, 2]);

  const packed = packMeshBin(
    {
      vertices,
      indices,
      attributes,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    },
    'runtime://fetch-binary',
  );
  if (!packed.ok) throw new Error(packed.error.actual);
  return packed.value;
}

describe('binary artifact decompression through managed source loading', () => {
  it.each([
    'zstd',
    'identity',
    undefined,
  ] as const)('admits only complete artifacts with contentEncoding=%s', async (encoding) => {
    const original = makeMeshBinPayload();
    const { assets, guid, requests } = await binaryAssetFixture(
      'mesh',
      {},
      original,
      'application/x-forgeax-mesh',
      encoding,
    );
    try {
      if (encoding === undefined) {
        expect(await assets.load(guid, 'mesh')).toMatchObject({
          ok: false,
          error: { code: 'asset-package-invalid' },
        });
        return;
      }
      const mesh = assets.read((await assets.load(guid, 'mesh')).unwrap()).unwrap();
      expect(mesh.kind).toBe('mesh');
      expect(mesh.indices).toEqual(new Uint16Array([0, 1, 2]));
      expect(requests).toContain('https://binary.invalid/body.bin');
    } finally {
      assets.dispose();
    }
  });

  it('preserves the artifact decompression error for corrupt zstd bytes', async () => {
    const { assets, guid } = await binaryAssetFixture(
      'mesh',
      {},
      makeMeshBinPayload(),
      'application/x-forgeax-mesh',
      'zstd',
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3]),
    );
    try {
      const result = await assets.load(guid, 'mesh');
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'asset-integrity-failed',
          expected: 'valid bytes for the declared outer content encoding',
          detail: { artifactKey: 'body.bin' },
        },
      });
    } finally {
      assets.dispose();
    }
  });
});
