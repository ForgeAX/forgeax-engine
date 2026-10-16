// tileset-asset-validate.test - validateTilesetPayload baseline + M1 fail-fast
// matrix (feat-20260608 M0 baseline rebuild + M1 schema extension).
//
// M0 boundary: region rectangle out of atlas extent OR tiles[].regionIndex
// out of regions.length range -> AssetError 'tileset-region-index-out-of-range'.
// M1 boundary extension (plan-strategy §R-6 first-error order):
//   1. atlases.length < 1 -> 'tileset-tile-entry-malformed' .field='atlases'
//      .scope='tileset-asset' (top-level fail-fast before region check).
//   2. region rectangle out of atlas extent -> M0 code as above.
//   3. region.atlasIndex out of [0, atlases.length) -> 'tileset-tile-entry-malformed'
//      .field='atlasIndex' .scope='tileset-asset'.
//   4. tiles[i].regionIndex out of [0, regions.length) -> M0 code.
//   5. tiles[i].widthCells out of (0, 64] -> 'tileset-tile-entry-malformed'
//      .field='widthCells' .scope='tile-entry' .tileEntryIndex=i.
//   6. tiles[i].heightCells out of (0, 64] -> .field='heightCells'.
//   7. tiles[i].pivotX out of [0, 1] -> .field='pivotX'.
//   8. tiles[i].pivotY out of [0, 1] -> .field='pivotY'.
//   9. tiles[i].collider schema invariant -> .field='collider'.
//
// Anchors: plan-tasks m0-t5 / m0-t6 / m1-t5 / m1-t6; plan-strategy §D-4
// (collider schema, no consumer) + §D-6 (closed 7-variant .detail.field
// enum) + §R-6 (first-error order); feat-20260604 D-5 single-error-code
// continuation.

import { AssetRegistry, validateTilesetPayload } from '@forgeax/engine-assets-runtime';
import {
  AssetError,
  type TilesetAsset,
  type TilesetTileCollider,
  type TilesetTileEntry,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeAssetRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makeTileset(overrides: Partial<TilesetAsset> = {}): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: [
      { x: 0, y: 0, width: 16, height: 16 },
      { x: 16, y: 0, width: 16, height: 16 },
    ],
    tiles: [{ regionIndex: 0 }, { regionIndex: 1 }],
    ...overrides,
  };
}

describe('validateTilesetPayload — M0 baseline (region + regionIndex)', () => {
  it('valid tileset returns null', () => {
    const asset = makeTileset();
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('region rectangle escapes atlas width — assume atlas extent 32x32', () => {
    const asset = makeTileset({
      regions: [{ x: 24, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    });
    const err = validateTilesetPayload(asset, { atlasWidth: 32, atlasHeight: 32 });
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
    if (err?.detail !== undefined && 'regionIndex' in err.detail) {
      expect(err.detail.regionIndex).toBe(0);
    } else {
      expect.fail('expected regionIndex detail');
    }
  });

  it('region rectangle escapes atlas height — assume atlas extent 32x32', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 24, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    });
    const err = validateTilesetPayload(asset, { atlasWidth: 32, atlasHeight: 32 });
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });

  it('tiles[i].regionIndex >= regions.length', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 5 }],
    });
    const err = validateTilesetPayload(asset);
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
    if (err?.detail !== undefined && 'regionIndex' in err.detail) {
      expect(err.detail.regionIndex).toBe(5);
      expect(err.detail.regionCount).toBe(1);
      expect(err.detail.tilesetGuid).toBe('<no-guid>');
    } else {
      expect.fail('expected regionIndex detail');
    }
  });

  it('tiles[i].regionIndex negative', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: -1 }],
    });
    const err = validateTilesetPayload(asset);
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });

  it('region with negative coords', () => {
    const asset = makeTileset({
      regions: [{ x: -1, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    });
    const err = validateTilesetPayload(asset);
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });
});

describe('AssetRegistry.catalog<TilesetAsset> wires validateTilesetPayload', () => {
  it('rejects an out-of-range regionIndex via Result.err', () => {
    const registry = makeAssetRegistry();
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 99 }],
    });
    const result = registry.catalog<TilesetAsset>('test/tileset', asset);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('tileset-region-index-out-of-range');
    }
  });

  it('accepts a valid tileset', () => {
    const registry = makeAssetRegistry();
    const asset = makeTileset();
    const result = registry.catalog<TilesetAsset>('test/tileset', asset);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M1 schema extension: 7 new boundary segments + R-6 first-error order
// (plan-tasks m1-t5; plan-strategy §R-6; charter P3 explicit failure;
// charter P4 single closed error code with structured .detail.field enum).
// ---------------------------------------------------------------------------

function expectMalformed(
  err: AssetError | null,
  field: 'widthCells' | 'heightCells' | 'pivotX' | 'pivotY' | 'collider' | 'atlases' | 'atlasIndex',
  opts: { scope?: 'tileset-asset' | 'tile-entry'; tileEntryIndex?: number } = {},
): void {
  expect(err).toBeInstanceOf(AssetError);
  expect(err?.code).toBe('tileset-tile-entry-malformed');
  const d = err?.detail;
  if (d !== undefined && 'code' in d && d.code === 'tileset-tile-entry-malformed') {
    expect(d.field).toBe(field);
    if (opts.scope !== undefined) {
      expect(d.scope).toBe(opts.scope);
    }
    if (opts.tileEntryIndex !== undefined) {
      expect(d.tileEntryIndex).toBe(opts.tileEntryIndex);
    }
    expect(d.tilesetGuid).toBe('<no-guid>');
  } else {
    expect.fail(`expected tileset-tile-entry-malformed detail; got ${JSON.stringify(d)}`);
  }
}

describe('validateTilesetPayload -- M1 atlases / atlasIndex top-level fail-fast', () => {
  it('atlases empty -> .field="atlases" .scope="tileset-asset"', () => {
    const asset = makeTileset({ atlases: [] });
    expectMalformed(validateTilesetPayload(asset), 'atlases', { scope: 'tileset-asset' });
  });

  it('region.atlasIndex >= atlases.length -> .field="atlasIndex" .scope="tileset-asset"', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: 5 }],
      tiles: [{ regionIndex: 0 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'atlasIndex', { scope: 'tileset-asset' });
  });

  it('region.atlasIndex negative -> .field="atlasIndex"', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: -1 }],
      tiles: [{ regionIndex: 0 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'atlasIndex', { scope: 'tileset-asset' });
  });

  it('region.atlasIndex omitted -> default 0 accepted', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('region.atlasIndex 0 with single atlas -> accepted', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 }],
      tiles: [{ regionIndex: 0 }],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });
});

describe('validateTilesetPayload -- M1 widthCells / heightCells boundary (range (0, 64])', () => {
  it('widthCells=0 -> .field="widthCells" .scope="tile-entry" .tileEntryIndex=0', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, widthCells: 0 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'widthCells', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('widthCells=65 -> .field="widthCells"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0 }, { regionIndex: 1, widthCells: 65 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'widthCells', {
      scope: 'tile-entry',
      tileEntryIndex: 1,
    });
  });

  it('widthCells=64 accepted (upper inclusive)', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, widthCells: 64 }, { regionIndex: 1 }],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('heightCells=0 -> .field="heightCells"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, heightCells: 0 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'heightCells', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('heightCells=65 -> .field="heightCells"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, heightCells: 65 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'heightCells', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });
});

describe('validateTilesetPayload -- M1 pivotX / pivotY boundary (range [0, 1])', () => {
  it('pivotX=-0.1 -> .field="pivotX"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, pivotX: -0.1 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotX', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotX=1.5 -> .field="pivotX"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, pivotX: 1.5 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotX', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotY=-0.1 -> .field="pivotY"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, pivotY: -0.1 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotY', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotY=1.5 -> .field="pivotY"', () => {
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, pivotY: 1.5 }, { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotY', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotX=0 / pivotY=1 accepted (inclusive boundary)', () => {
    const asset = makeTileset({
      tiles: [
        { regionIndex: 0, pivotX: 0, pivotY: 1 },
        { regionIndex: 1, pivotX: 1, pivotY: 0 },
      ],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });
});

describe('validateTilesetPayload -- M1 collider 3-variant schema (rect / polygon / none)', () => {
  function withCollider(c: TilesetTileCollider): TilesetTileEntry {
    return { regionIndex: 0, collider: c };
  }

  it('collider.type="none" accepted', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'none' }), { regionIndex: 1 }],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('collider.type="rect" with valid 4-tuple accepted', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [0, 0, 1, 1] }), { regionIndex: 1 }],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('collider.rect with negative coord -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [-0.1, 0, 0.5, 0.5] }), { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.rect width <= 0 -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [0, 0, 0, 0.5] }), { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.rect height <= 0 -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [0, 0, 0.5, 0] }), { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.rect x + w > 1 -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [0.5, 0, 0.6, 0.5] }), { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.rect y + h > 1 -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [withCollider({ type: 'rect', rect: [0, 0.5, 0.5, 0.6] }), { regionIndex: 1 }],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.type="polygon" with >= 3 normalized points accepted', () => {
    const asset = makeTileset({
      tiles: [
        withCollider({
          type: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [0.5, 1],
          ],
        }),
        { regionIndex: 1 },
      ],
    });
    expect(validateTilesetPayload(asset)).toBeNull();
  });

  it('collider.polygon with < 3 points -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [
        withCollider({
          type: 'polygon',
          points: [
            [0, 0],
            [1, 0],
          ],
        }),
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider.polygon with out-of-range point -> .field="collider"', () => {
    const asset = makeTileset({
      tiles: [
        withCollider({
          type: 'polygon',
          points: [
            [0, 0],
            [1.1, 0],
            [0.5, 1],
          ],
        }),
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });
});

describe('validateTilesetPayload -- M1 R-6 first-error order locking', () => {
  // Construct a tileset that simultaneously violates several boundaries and
  // assert the first-error code follows plan-strategy §R-6:
  //   1. atlases (top-level)
  //   2. region rectangle (M0 tileset-region-index-out-of-range)
  //   3. atlasIndex (top-level)
  //   4. tiles[].regionIndex (M0 code)
  //   5. tile-entry widthCells / heightCells / pivotX / pivotY
  //   6. tile-entry collider

  it('atlases empty wins over region rect bug + pivot bug', () => {
    const asset = makeTileset({
      atlases: [],
      regions: [{ x: 100, y: 0, width: 16, height: 16 }], // would fail M0 if extent supplied
      tiles: [{ regionIndex: 0, pivotX: 5 }],
    });
    const err = validateTilesetPayload(asset, { atlasWidth: 32, atlasHeight: 32 });
    expectMalformed(err, 'atlases', { scope: 'tileset-asset' });
  });

  it('region rect bug wins over atlasIndex bug + tile-entry pivot bug', () => {
    const asset = makeTileset({
      regions: [{ x: 100, y: 0, width: 16, height: 16, atlasIndex: 99 }],
      tiles: [{ regionIndex: 0, pivotY: 5 }],
    });
    const err = validateTilesetPayload(asset, { atlasWidth: 32, atlasHeight: 32 });
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });

  it('atlasIndex bug wins over tile-entry pivot bug + collider bug', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16, atlasIndex: 99 }],
      tiles: [
        {
          regionIndex: 0,
          pivotX: 5,
          collider: { type: 'rect', rect: [10, 0, 1, 1] },
        },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'atlasIndex', { scope: 'tileset-asset' });
  });

  it('tiles[].regionIndex bug wins over widthCells / pivot / collider bugs', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [
        {
          regionIndex: 99,
          widthCells: 0,
          pivotY: 5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
      ],
    });
    const err = validateTilesetPayload(asset);
    expect(err).toBeInstanceOf(AssetError);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });

  it('widthCells bug wins over heightCells / pivot / collider bugs', () => {
    const asset = makeTileset({
      tiles: [
        {
          regionIndex: 0,
          widthCells: 0,
          heightCells: 0,
          pivotX: 5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'widthCells', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('heightCells bug wins over pivot + collider bugs (widthCells healthy)', () => {
    const asset = makeTileset({
      tiles: [
        {
          regionIndex: 0,
          widthCells: 3,
          heightCells: 0,
          pivotX: 5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'heightCells', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotX bug wins over pivotY + collider bugs', () => {
    const asset = makeTileset({
      tiles: [
        {
          regionIndex: 0,
          pivotX: 5,
          pivotY: 5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotX', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('pivotY bug wins over collider bug', () => {
    const asset = makeTileset({
      tiles: [
        {
          regionIndex: 0,
          pivotY: 5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'pivotY', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });

  it('collider bug surfaces last when all other fields are healthy', () => {
    const asset = makeTileset({
      tiles: [
        {
          regionIndex: 0,
          widthCells: 3,
          heightCells: 4,
          pivotX: 0.5,
          pivotY: 0.5,
          collider: { type: 'rect', rect: [-1, 0, 1, 1] },
        },
        { regionIndex: 1 },
      ],
    });
    expectMalformed(validateTilesetPayload(asset), 'collider', {
      scope: 'tile-entry',
      tileEntryIndex: 0,
    });
  });
});

describe('validateTilesetPayload -- M0 baseline cases remain GREEN after M1 extension', () => {
  it('M0 tileset-region-index-out-of-range for region rect overflow still fires', () => {
    const asset = makeTileset({
      regions: [{ x: 24, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 0 }],
    });
    const err = validateTilesetPayload(asset, { atlasWidth: 32, atlasHeight: 32 });
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });

  it('M0 tileset-region-index-out-of-range for tiles[].regionIndex still fires', () => {
    const asset = makeTileset({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [{ regionIndex: 99 }],
    });
    const err = validateTilesetPayload(asset);
    expect(err?.code).toBe('tileset-region-index-out-of-range');
  });
});

describe('AssetRegistry.register<TilesetAsset> wires M1 fail-fast', () => {
  it('rejects tile entry with widthCells=0 via Result.err', () => {
    const registry = makeAssetRegistry();
    const asset = makeTileset({
      tiles: [{ regionIndex: 0, widthCells: 0 }, { regionIndex: 1 }],
    });
    const result = registry.catalog<TilesetAsset>('test/tileset', asset);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('tileset-tile-entry-malformed');
    }
  });

  it('rejects atlases=[] via Result.err', () => {
    const registry = makeAssetRegistry();
    const asset = makeTileset({ atlases: [] });
    const result = registry.catalog<TilesetAsset>('test/tileset', asset);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('tileset-tile-entry-malformed');
    }
  });
});
