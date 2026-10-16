// tilemap-region-pack.test - per-cell entity Transform packing in cell units
// (feat-20260608 M0 baseline rebuild).
//
// Asserts the M0 1x1 unit-cell packing rules baked into
// `spawnDerivedRenderEntities`:
//
//   posX = (cellX + 0.5) * tileSizeX
//   posY = (cellY + 0.5) * tileSizeY
//   scaleX = +/- tileSizeX (sign encodes flipH)
//   scaleY = +/- tileSizeY (sign encodes flipV)
//   quatZ / quatW = D ? SQRT1_2 : 0 / D ? SQRT1_2 : 1
//
// M0 boundary: width/heightCells / pivotX/Y are NOT consumed yet (M2
// `feat-20260608` D-2 widens the form). 1x1 unit-cell only.
//
// Anchors: plan-tasks m0-t9; plan-strategy §D-1 per-cell entity TRS;
// plan-strategy §M0 (1x1 unit-cell baseline only).

import { World } from '@forgeax/engine-ecs';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { Layer, MeshFilter } from '@forgeax/engine-render';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { encodeSortScope } from '../../../render/src/components/tile-layer';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

function setup(opts: {
  cols: number;
  rows: number;
  tileSize: readonly [number, number];
  tiles: Uint32Array;
}) {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: opts.cols,
    rows: opts.rows,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const lookup = makeTilemapAssetLookup(tileset);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: {
          cols: opts.cols,
          rows: opts.rows,
          tileSize: opts.tileSize,
          chunkSize: 4,
          tileset: 'test/tileset',
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world.spawn(
    {
      component: TileLayer,
      data: { tiles: opts.tiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('per-cell') },
    },
    { component: ChildOf, data: { parent: tilemap } },
  );
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, lookup };
}

function readDerivedTransforms(world: World): Array<{
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
}> {
  const out: Array<{
    posX: number;
    posY: number;
    scaleX: number;
    scaleY: number;
    quatZ: number;
    quatW: number;
  }> = [];
  const query = world.query({ read: [Transform], with: [MeshFilter, Layer] }).unwrap();
  for (const row of query) {
    const t = row.get(Transform);
    out.push({
      posX: t.pos[0] ?? 0,
      posY: t.pos[1] ?? 0,
      scaleX: t.scale[0] ?? 1,
      scaleY: t.scale[1] ?? 1,
      quatZ: t.quat[2] ?? 0,
      quatW: t.quat[3] ?? 1,
    });
  }
  return out;
}

describe('tilemap region pack — M0 1x1 unit-cell Transform field assertions', () => {
  it('non-unit tileSize: posX/posY follow (cellX + 0.5) * tileSize', () => {
    const tiles = new Uint32Array(2);
    tiles[0] = 1; // (0, 0)
    tiles[1] = 1; // (1, 0)
    const { world, lookup } = setup({ cols: 2, rows: 1, tileSize: [32, 16], tiles });
    tilemapChunkExtractSystem(world, lookup);
    const xs = readDerivedTransforms(world)
      .map((t) => t.posX)
      .sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.5 * 32, 5);
    expect(xs[1]).toBeCloseTo(1.5 * 32, 5);
  });

  it('default tileSize (1, 1) on a 1x1 cell anchored at (0, 0)', () => {
    const tiles = new Uint32Array([1]);
    const { world, lookup } = setup({ cols: 1, rows: 1, tileSize: [1, 1], tiles });
    tilemapChunkExtractSystem(world, lookup);
    const transforms = readDerivedTransforms(world);
    expect(transforms.length).toBe(1);
    const t = transforms[0];
    if (t === undefined) throw new Error('expected one derived Transform');
    expect(t.posX).toBeCloseTo(0.5, 5);
    expect(t.posY).toBeCloseTo(0.5, 5);
    expect(t.scaleX).toBe(1);
    expect(t.scaleY).toBe(1);
    expect(t.quatZ).toBe(0);
    expect(t.quatW).toBe(1);
  });

  it('flipH alone negates scaleX, flipV alone negates scaleY (per-cell sign)', () => {
    const tiles = new Uint32Array([encodeTileBits(1, true, false, false, false)]);
    const { world, lookup } = setup({ cols: 1, rows: 1, tileSize: [1, 1], tiles });
    tilemapChunkExtractSystem(world, lookup);
    const t = readDerivedTransforms(world)[0];
    if (t === undefined) throw new Error('expected one derived Transform');
    expect(t.scaleX).toBe(-1);
    expect(t.scaleY).toBe(1);
  });
});
