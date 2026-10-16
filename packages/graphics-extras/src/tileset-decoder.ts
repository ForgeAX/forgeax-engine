import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  type TilesetAsset,
} from '@forgeax/engine-types';

/** Tileset validation is owned here; no physics consumer exists yet. */
export const tilesetContribution: AssetDecoderContribution<TilesetAsset, 'tileset'> = {
  kind: { kind: 'tileset' } as AssetKind<TilesetAsset, 'tileset'>,
  consumer: 'tilemapChunkExtractSystem (physics consumer: missing evidence)',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload as unknown;
      if (payload !== null && typeof payload === 'object') {
        const source = payload as Record<string, unknown>;
        const rawAtlases = source.atlases;
        const regions = source.regions;
        const tiles = source.tiles;
        const atlases = Array.isArray(rawAtlases)
          ? rawAtlases.map((value) =>
              typeof value === 'number' && Number.isSafeInteger(value)
                ? envelope.refs[value]
                : value,
            )
          : undefined;
        if (
          source.kind === 'tileset' &&
          atlases !== undefined &&
          atlases.length > 0 &&
          atlases.every(
            (atlas): atlas is string => typeof atlas === 'string' && atlas.length > 0,
          ) &&
          Array.isArray(regions) &&
          regions.length > 0 &&
          Array.isArray(tiles) &&
          tiles.every(
            (tile) =>
              tile !== null &&
              typeof tile === 'object' &&
              typeof (tile as { regionIndex?: unknown }).regionIndex === 'number' &&
              (tile as { regionIndex: number }).regionIndex >= 0 &&
              (tile as { regionIndex: number }).regionIndex < regions.length,
          )
        ) {
          return ok({
            ...source,
            kind: 'tileset',
            atlases,
            regions,
            tiles,
          } as unknown as TilesetAsset);
        }
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a tileset with atlas GUIDs and in-range tile regions',
        hint: 'repair the tileset regions; physics consumption is not installed by this owner',
        detail: { guid: envelope.guid, reason: 'tileset owner validation failed' },
      });
    },
  },
};
