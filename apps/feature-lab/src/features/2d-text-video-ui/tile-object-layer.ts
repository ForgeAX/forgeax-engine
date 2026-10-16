import { encodeTileBits } from '@forgeax/engine/graphics-extras';
import { TileLayer, Tilemap, TilemapSort } from '@forgeax/engine/render/authoring';
import { ChildOf, Transform } from '@forgeax/engine/scene';
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
const ATLAS_A = 'feature-lab/2d/object-atlas-a';
const ATLAS_B = 'feature-lab/2d/object-atlas-b';
const TILESET_KEY = 'feature-lab/2d/object-tileset';
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
  title: 'TileLayer object semantics',
  catalog: 'TileLayer object semantics',
  kind: 'visual',
  summary:
    'A per-cell TileLayer carries object tiles: a 2x4-cell "totem" (red top, blue bottom, white left stripe) from atlas A and a 2x2 green stone from atlas B, with bottom-center pivots. A sprite shares the scene under sortScope per-cell.',
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
      atlases: [ATLAS_A, ATLAS_B],
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
    const cataloged = [
      assets.catalog(ATLAS_A, atlasA),
      assets.catalog(ATLAS_B, atlasB),
      assets.catalog(TILESET_KEY, tileset),
    ];
    for (const result of cataloged)
      if (!result.ok) throw new Error(`catalog: ${result.error.code}`);
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
            tileset: TILESET_KEY,
          },
        },
        { component: Transform, data: { pos: [(-COLS * TILE) / 2, (-ROWS * TILE) / 2, 0] } },
      )
      .unwrap();
    const layer = world
      .spawn(
        {
          component: TileLayer,
          data: { tiles: tiles(false), layerOrder: 0, dirty: 1, sortScope: TilemapSort.perCell },
        },
        { component: ChildOf, data: { parent: map } },
        { component: Transform, data: {} },
      )
      .unwrap();
    const disc = spriteMaterial(world, spriteMaterialAsset(discTexture(world), [1, 0.2, 1, 1]));
    spawnSprite(world, disc, [2.9, 0.2, 0], 0.9);
    return {
      toggle(on) {
        const view = world.get(layer, TileLayer).unwrap().tiles as Uint32Array;
        view.set(tiles(!on));
        world.set(layer, TileLayer, { dirty: 1 });
      },
    };
  },
});
