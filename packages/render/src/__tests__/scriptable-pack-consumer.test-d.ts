import type { TilesetAsset } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';

const tileset: TilesetAsset = {
  kind: 'tileset',
  atlases: ['019ffa97-9000-7000-8000-000000000004'],
  tileWidth: 1,
  tileHeight: 1,
  columns: 1,
  rows: 1,
  regions: [{ x: 0, y: 0, width: 1, height: 1 }],
  tiles: [{ regionIndex: 0 }],
};
expectTypeOf(tileset.atlases).toEqualTypeOf<readonly string[]>();
