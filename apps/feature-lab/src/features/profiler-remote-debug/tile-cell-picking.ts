import { World } from '@forgeax/engine/ecs';
import { pickTile } from '@forgeax/engine/picking';
import { TileLayer, Tilemap } from '@forgeax/engine/render/authoring';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Tile-cell picking',
  catalog: 'Tile-cell picking',
  kind: 'headless',
  summary:
    'pickTile(world, tilemap, worldX, worldY) returns the topmost non-empty cell across the tilemap child TileLayers.',
  expect:
    'Cell (1,1) resolves to the higher layerOrder tile; empty and out-of-range cells are ok(null); a non-tilemap entity is a structured error.',
  run(checks) {
    const world = new World();
    const tilemap = world
      .spawn(
        { component: Tilemap, data: { cols: 4, rows: 4, tileset: 'lab/tileset' } },
        { component: Transform, data: {} },
      )
      .unwrap();
    const layer = (layerOrder: number, cell: number, tileId: number): void => {
      const tiles = new Uint32Array(16);
      tiles[cell] = tileId;
      world
        .spawn(
          { component: TileLayer, data: { tiles, layerOrder } },
          { component: ChildOf, data: { parent: tilemap } },
        )
        .unwrap();
    };
    layer(0, 5, 3);
    layer(4, 5, 9);
    layer(0, 0, 2);
    propagateTransforms(world);
    const top = pickTile(world, tilemap, 1.5, 1.5);
    checks.ok(
      'cell (1,1) returns the top layer tile 9',
      top.ok &&
        top.value !== null &&
        top.value.cellX === 1 &&
        top.value.cellY === 1 &&
        top.value.tileId === 9,
      JSON.stringify(top.ok ? top.value : top.error.code),
    );
    const single = pickTile(world, tilemap, 0.5, 0.5);
    checks.ok('cell (0,0) returns tile 2', single.ok && single.value?.tileId === 2);
    const empty = pickTile(world, tilemap, 3.5, 3.5);
    checks.ok('empty cell is ok(null)', empty.ok && empty.value === null);
    const outside = pickTile(world, tilemap, 40, 40);
    checks.ok('out-of-range is ok(null)', outside.ok && outside.value === null);
    const notMap = world.spawn({ component: Transform, data: {} }).unwrap();
    const wrong = pickTile(world, notMap, 0.5, 0.5);
    checks.ok(
      'non-tilemap entity is a structured error',
      !wrong.ok,
      wrong.ok ? 'ok' : wrong.error.code,
    );
  },
});
