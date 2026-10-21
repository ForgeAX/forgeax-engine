import { Tilemap } from '@forgeax/engine/render/authoring';
import { Transform } from '@forgeax/engine/scene';
import type { TilesetAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { spawnOrthoCamera, textureAsset } from './_shared/sprite';

const COLS = 14;
const ROWS = 7;
const TILE = 0.5;

function fill(tiles: Uint32Array, sparse: boolean): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      tiles[r * COLS + c] = sparse && (r + c) % 2 === 1 ? 0 : ((r + c) % 4) + 1;
    }
  }
}

export default defineFeature({
  title: 'Tilemap',
  catalog: 'Tilemap',
  kind: 'visual',
  summary: `A ${COLS}x${ROWS} Tilemap reads a managed Tileset over a 2x2 color atlas. Toggling publishes cells with world.set; visible chunks become native Renderer draws.`,
  expect:
    'ON: a solid band of diagonal red/green/blue/yellow tiles fills the middle of the canvas. OFF: every other tile is set to 0 (empty), leaving a checkerboard of holes showing the dark clear color.',
  setup({ app, world, canvas }) {
    const assets = app.assets;
    if (assets === undefined) throw new Error('app.assets is undefined');
    const colors = [
      [1, 0.1, 0.1, 1],
      [0.1, 1, 0.1, 1],
      [0.1, 0.2, 1, 1],
      [1, 0.9, 0.1, 1],
    ] as const;
    const atlas = textureAsset(
      32,
      32,
      (x, y) => colors[(y < 16 ? 0 : 2) + (x < 16 ? 0 : 1)] ?? [1, 1, 1, 1],
    );
    const tileset: TilesetAsset = {
      kind: 'tileset',
      atlases: [assets.create(atlas).unwrap()],
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
      rows: 2,
      regions: [
        { x: 0, y: 0, width: 16, height: 16 },
        { x: 16, y: 0, width: 16, height: 16 },
        { x: 0, y: 16, width: 16, height: 16 },
        { x: 16, y: 16, width: 16, height: 16 },
      ],
      tiles: [{ regionIndex: 0 }, { regionIndex: 1 }, { regionIndex: 2 }, { regionIndex: 3 }],
    };
    const handle = assets.create(tileset).unwrap();
    const tiles = new Uint32Array(COLS * ROWS);
    fill(tiles, false);
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
            tiles,
          },
        },
        { component: Transform, data: { pos: [(-COLS * TILE) / 2, (-ROWS * TILE) / 2, 0] } },
      )
      .unwrap();
    return {
      toggle(on) {
        const view = world.get(map, Tilemap).unwrap().tiles as Uint32Array;
        fill(view, !on);
        world.set(map, Tilemap, { tiles: view }).unwrap();
      },
    };
  },
});
