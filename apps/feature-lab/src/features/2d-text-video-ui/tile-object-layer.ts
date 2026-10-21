import { encodeTileBits } from '@forgeax/engine/graphics-extras';
import { Tilemap, TilemapSort } from '@forgeax/engine/render/authoring';
import { Transform } from '@forgeax/engine/scene';
import type { TilesetAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import {
  discTexture,
  spawnOrthoCamera,
  spawnSprite,
  spriteMaterial,
  spriteMaterialAsset,
  textureAsset,
} from './_shared/sprite';

const COLS = 14;
const ROWS = 7;
const TILE = 0.5;
const TOTEM = 1;
const STONE = 2;
const TOTEM_CELLS = [2, 5, 8] as const;

function tiles(flipped: boolean): Uint32Array {
  const out = new Uint32Array(COLS * ROWS);
  for (const c of TOTEM_CELLS)
    out[1 * COLS + c] = encodeTileBits(TOTEM, flipped, flipped, false, false);
  out[1 * COLS + 11] = encodeTileBits(STONE, false, false, false, false);
  return out;
}

export default defineFeature({
  title: 'Tilemap object semantics',
  catalog: 'Tilemap object semantics',
  kind: 'visual',
  summary:
    'A per-cell Tilemap carries object tiles: a 2x4-cell "totem" (red top, blue bottom, white left stripe) from atlas A and a 2x2 green stone from atlas B, with bottom-center pivots. A sprite shares the scene under sortScope per-cell.',
  expect:
    'ON: three tall totems stand red-on-top with the white stripe on the left, next to a green stone and a magenta disc sprite. OFF: the totem cells get flipH+flipV bits, so they turn blue-on-top with the stripe on the right; the stone and sprite stay unchanged.',
  setup({ app, world, canvas }) {
    const assets = app.assets;
    if (assets === undefined) throw new Error('app.assets is undefined');
    const atlasA = textureAsset(32, 64, (x, y) =>
      x < 6 ? [1, 1, 1, 1] : y < 32 ? [1, 0.15, 0.1, 1] : [0.1, 0.25, 1, 1],
    );
    const atlasB = textureAsset(32, 32, (x, y) =>
      Math.hypot(x - 15.5, y - 15.5) < 15 ? [0.1, 0.9, 0.3, 1] : [0, 0, 0, 0],
    );
    const tileset: TilesetAsset = {
      kind: 'tileset',
      atlases: [assets.create(atlasA).unwrap(), assets.create(atlasB).unwrap()],
      atlasSizes: [
        { pixelWidth: 32, pixelHeight: 64 },
        { pixelWidth: 32, pixelHeight: 32 },
      ],
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
      rows: 4,
      regions: [
        { x: 0, y: 0, width: 32, height: 64, atlasIndex: 0 },
        { x: 0, y: 0, width: 32, height: 32, atlasIndex: 1 },
      ],
      tiles: [
        { regionIndex: 0, widthCells: 2, heightCells: 4, pivotX: 0.5, pivotY: 0 },
        { regionIndex: 1, widthCells: 2, heightCells: 2, pivotX: 0.5, pivotY: 0 },
      ],
    };
    const handle = assets.create(tileset).unwrap();
    spawnOrthoCamera(world, canvas);
    const map = world
      .spawn(
        {
          component: Tilemap,
          data: {
            cols: COLS,
            rows: ROWS,
            tileSize: [TILE, TILE],
            chunkSize: 8,
            tileset: handle,
            tiles: tiles(false),
            sortScope: TilemapSort.perCell,
          },
        },
        { component: Transform, data: { pos: [(-COLS * TILE) / 2, (-ROWS * TILE) / 2, 0] } },
      )
      .unwrap();
    const disc = spriteMaterial(world, spriteMaterialAsset(discTexture(world), [1, 0.2, 1, 1]));
    spawnSprite(world, disc, [2.9, 0.2, 0], 0.9);
    return {
      toggle(on) {
        world.set(map, Tilemap, { tiles: tiles(!on) }).unwrap();
      },
    };
  },
});
