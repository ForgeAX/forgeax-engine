// @forgeax/engine-assets-runtime -- register-time payload validation coverage
// (fix issue #709). Covers validateMeshPayload branch tree, validateTilesetPayload
// R-6 first-error ordering, and inferAtlasExtent.

import type { Asset, MeshAsset, TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { inferAtlasExtent, validateMeshPayload, validateTilesetPayload } from '../payload-validate';

function mesh(
  vertexCount = 0,
  submesh: Partial<MeshAsset['submeshes'][number]> = {},
  over: Partial<MeshAsset> = {},
): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(vertexCount * 12),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount,
        topology: 'triangle-list',
        materialSlot: 0,
        ...submesh,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
    ...over,
  } as MeshAsset;
}

describe('validateMeshPayload', () => {
  it.each([
    ['a non-mesh asset', { kind: 'material' } as Asset],
    ['an empty mesh', mesh()],
    ['a vertex-only mesh', mesh(2)],
    ['a line strip', mesh(1, { topology: 'line-strip' })],
    ['a triangle strip', mesh(1, { topology: 'triangle-strip' })],
    ['an indexed mesh', mesh(3, { indexCount: 3 }, { indices: Uint16Array.of(0, 1, 2) })],
    [
      'sparse Landscape LOD indices into shared vertices',
      mesh(4, { indexCount: 3 }, { indices: Uint16Array.of(0, 1, 2) }),
    ],
    [
      'optional vertex colors',
      mesh(
        3,
        { indexCount: 3 },
        {
          vertices: new Float32Array(3 * 16),
          indices: Uint16Array.of(0, 1, 2),
          attributes: {
            position: new Float32Array(9),
            normal: new Float32Array(9),
            uv: new Float32Array(6),
            tangent: new Float32Array(12),
            color: new Float32Array(12),
          },
        },
      ),
    ],
  ] as const)('accepts %s', (_name, asset) => {
    expect(validateMeshPayload(asset)).toBeNull();
  });

  it.each([
    ['no submeshes', mesh(0, {}, { submeshes: [] }), { code: 'mesh-asset-submeshes-empty' }],
    [
      'non-triangle topology on empty geometry',
      mesh(0, { topology: 'line-list' }),
      {
        code: 'asset-invalid-value',
        detail: { reason: 'empty-geometry-non-default-topology' },
      },
    ],
    [
      'an index range beyond its buffer',
      mesh(3, { indexCount: 6 }, { indices: Uint16Array.of(0, 1, 2) }),
      {
        code: 'mesh-submesh-index-range-out-of-bounds',
      },
    ],
    [
      'a vertex buffer with an invalid stride',
      mesh(1, {}, { vertices: new Float32Array(13) }),
      {
        code: 'mesh-vertex-stride-mismatch',
      },
    ],
    [
      'an out-of-range index',
      mesh(2, { indexCount: 3 }, { indices: Uint16Array.of(0, 1, 5) }),
      {
        code: 'mesh-vertex-stride-mismatch',
        detail: { vertexCount: 6 },
      },
    ],
    [
      'an out-of-range Landscape LOD index',
      mesh(4, { indexCount: 3 }, { indices: Uint16Array.of(0, 1, 4) }),
      {
        code: 'mesh-vertex-stride-mismatch',
      },
    ],
  ] as const)('rejects %s', (_name, asset, error) => {
    expect(validateMeshPayload(asset)).toMatchObject(error);
  });
});

function tileset(over: Partial<TilesetAsset>): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: ['atlas-guid'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 4,
    rows: 4,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
    ...over,
  } as TilesetAsset;
}

describe('validateTilesetPayload', () => {
  it('accepts a well-formed tileset', () => {
    expect(validateTilesetPayload(tileset({}))).toBeNull();
  });

  it('errors when atlases is empty', () => {
    const e = validateTilesetPayload(tileset({ atlases: [] }));
    expect(e?.code).toBe('tileset-tile-entry-malformed');
    expect((e?.detail as { field: string }).field).toBe('atlases');
  });

  it('errors on a negative/zero region rectangle', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: -1, y: 0, width: 16, height: 16 }] }),
    );
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it('errors when a region escapes the supplied atlas extent', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: 0, y: 0, width: 100, height: 16 }] }),
      { atlasWidth: 64, atlasHeight: 64 },
    );
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it('errors on an out-of-range region.atlasIndex', () => {
    const e = validateTilesetPayload(
      tileset({ regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: 5 }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('atlasIndex');
  });

  it('errors on an out-of-range tile.regionIndex', () => {
    const e = validateTilesetPayload(tileset({ tiles: [{ regionIndex: 9 }] }));
    expect(e?.code).toBe('tileset-region-index-out-of-range');
  });

  it.each([
    ['widthCells', 0],
    ['heightCells', 65],
    ['pivotX', 2],
    ['pivotY', -1],
  ] as const)('rejects out-of-bounds %s', (field, value) => {
    const asset = tileset({ tiles: [{ regionIndex: 0, [field]: value }] });
    expect(validateTilesetPayload(asset)?.detail).toMatchObject({ field });
  });

  it('accepts a valid rect collider and rejects a malformed one', () => {
    expect(
      validateTilesetPayload(
        tileset({
          tiles: [{ regionIndex: 0, collider: { type: 'rect', rect: [0, 0, 0.5, 0.5] } }],
        }),
      ),
    ).toBeNull();
    const e = validateTilesetPayload(
      tileset({ tiles: [{ regionIndex: 0, collider: { type: 'rect', rect: [0, 0, 2, 2] } }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('collider');
  });

  it('accepts a valid polygon collider and rejects fewer-than-3 points', () => {
    expect(
      validateTilesetPayload(
        tileset({
          tiles: [
            {
              regionIndex: 0,
              collider: {
                type: 'polygon',
                points: [
                  [0, 0],
                  [1, 0],
                  [0, 1],
                ],
              },
            },
          ],
        }),
      ),
    ).toBeNull();
    const e = validateTilesetPayload(
      tileset({ tiles: [{ regionIndex: 0, collider: { type: 'polygon', points: [[0, 0]] } }] }),
    );
    expect((e?.detail as { field: string }).field).toBe('collider');
  });

  it("accepts a 'none' collider", () => {
    expect(
      validateTilesetPayload(tileset({ tiles: [{ regionIndex: 0, collider: { type: 'none' } }] })),
    ).toBeNull();
  });
});

describe('inferAtlasExtent', () => {
  it('multiplies columns*tileWidth and rows*tileHeight', () => {
    expect(
      inferAtlasExtent(tileset({ columns: 8, tileWidth: 16, rows: 4, tileHeight: 32 })),
    ).toEqual({ atlasWidth: 128, atlasHeight: 128 });
  });
});
