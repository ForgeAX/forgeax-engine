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
    'runtime://four-path',
  );
  if (!packed.ok) throw new Error(packed.error.actual);
  return packed.value;
}

describe('binary assets and inline font payloads use their domain loading contracts', () => {
  it('mesh bytes reach the canonical mesh decoder', async () => {
    const { assets, guid } = await binaryAssetFixture(
      'mesh',
      {},
      makeMeshBinPayload(),
      'application/x-forgeax-mesh',
      'zstd',
    );
    try {
      const mesh = assets.read((await assets.load(guid, 'mesh')).unwrap()).unwrap();
      expect(mesh.indices).toEqual(new Uint16Array([0, 1, 2]));
    } finally {
      assets.dispose();
    }
  });

  it('texture bytes retain every RGBA pixel', async () => {
    const pixels = Uint8Array.from({ length: 64 }, (_, index) => (index * 17) % 256);
    const { assets, guid } = await binaryAssetFixture(
      'texture',
      {
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        mips: { kind: 'none' },
      },
      pixels,
      'application/x-forgeax-rgba8',
      'zstd',
    );
    try {
      const texture = assets.read((await assets.load(guid, 'texture')).unwrap()).unwrap();
      expect(
        new Uint8Array(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength),
      ).toEqual(pixels);
    } finally {
      assets.dispose();
    }
  });

  it('equirect bytes retain every half-float pixel', async () => {
    const pixels = new Uint8Array(4 * 4 * 8);
    const { assets, guid } = await binaryAssetFixture(
      'equirect',
      {
        width: 4,
        height: 4,
        format: 'rgba16float',
        colorSpace: 'linear',
      },
      pixels,
      'application/x-forgeax-rgba16f',
      'zstd',
    );
    try {
      const texture = assets.read((await assets.load(guid, 'equirect')).unwrap()).unwrap();
      expect(
        new Uint8Array(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength),
      ).toEqual(pixels);
    } finally {
      assets.dispose();
    }
  });

  it('font rejects invalid inline metadata without fetching an unrelated binary body', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ assets: [{ kind: 'font', payload: {} }] }),
    );
    const { assets, guid, requests } = await binaryAssetFixture(
      'font',
      {},
      bytes,
      'application/json',
      'zstd',
    );
    try {
      const result = await assets.load(guid, 'font');
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'asset-package-invalid',
          detail: { reason: 'font owner validation failed' },
        },
      });
      expect(requests).not.toContain('https://binary.invalid/body.bin');
    } finally {
      assets.dispose();
    }
  });
});
