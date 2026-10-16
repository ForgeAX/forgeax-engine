import type { Asset, TextureAsset, TilesetAsset } from '@forgeax/engine-types';

export const TEST_TILESET_GUID = 'test/tileset';
export const TEST_ATLAS_GUID = 'test/atlas';

export function makeTestTexture(seed = 0): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 32, height: 32 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array(32 * 32 * 4).fill(seed),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

export function makeTilemapAssetLookup(
  tileset: TilesetAsset,
  extra: Readonly<Record<string, Asset>> = {},
): (guid: string) => Asset | undefined {
  const atlas = makeTestTexture();
  const assets = new Map<string, Asset>([
    [TEST_TILESET_GUID, tileset],
    [TEST_ATLAS_GUID, atlas],
    ...Object.entries(extra),
  ]);
  return (guid) => assets.get(guid);
}
