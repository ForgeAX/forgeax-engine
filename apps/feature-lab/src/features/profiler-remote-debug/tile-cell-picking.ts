import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { pickTile } from '@forgeax/engine/picking';
import { Tilemap } from '@forgeax/engine/render/authoring';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Tile-cell picking',
  catalog: 'Tile-cell picking',
  kind: 'headless',
  summary: 'pickTile(world, tilemap, worldX, worldY) queries the named Tilemap layer directly.',
  expect:
    'Cell (1,1) resolves to the authored tile; empty and out-of-range cells are ok(null); a non-tilemap entity is a structured error.',
  run(checks) {
    const assets = new AssetRegistry(),
      world = new World({ assets });
    const atlas = assets
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        mips: { kind: 'none' },
        data: new Uint8Array(4).fill(255),
      })
      .unwrap();
    const tileset = assets
      .create({
        kind: 'tileset',
        atlases: [atlas],
        tileWidth: 1,
        tileHeight: 1,
        columns: 1,
        rows: 1,
        regions: [{ x: 0, y: 0, width: 1, height: 1 }],
        tiles: Array.from({ length: 9 }, () => ({ regionIndex: 0 })),
      })
      .unwrap();
    const cells = new Uint32Array(16);
    cells[0] = 2;
    cells[5] = 9;
    const tilemap = world
      .spawn(
        { component: Tilemap, data: { cols: 4, rows: 4, tileset, tiles: cells } },
        { component: Transform, data: {} },
      )
      .unwrap();
    propagateTransforms(world);
    const top = pickTile(world, tilemap, 1.5, 1.5);
    checks.ok(
      'cell (1,1) returns tile 9',
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
    assets.dispose();
  },
});
