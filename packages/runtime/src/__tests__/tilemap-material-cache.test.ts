// tilemap-material-cache.test - resolveTilesetMaterial cache key invariants
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//   - The atlas-material cache key is the binary tuple
//     `(atlasHandle, regionIndex)` (charter P4 + plan-strategy §D-9 / §D-12).
//   - Re-spawning identical (atlas, regionIndex) pairs (across distinct
//     Tilemap entities, distinct TileLayer entities) hits the SAME
//     materialHandle on the derived MeshRenderer entity.
//   - Different regionIndex values produce DIFFERENT material handles.
//
// The cache is module-scoped inside `tilemap-chunk-extract-system.ts`;
// `resetTilemapChunkExtractCache()` clears it between scenarios.
//
// Anchors: plan-tasks m0-t9 / m0-t10; plan-strategy §D-9 cache key shape;
// charter P4 (atlases plural composite + binary cache key).

import { World } from '@forgeax/engine-ecs';
import { Layer, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
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

function spawnTilemapWithLayer(
  world: World,
  tilesetGuid: string,
  cols: number,
  rows: number,
  tiles: Uint32Array,
) {
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols, rows, tileSize: [1, 1], chunkSize: 4, tileset: tilesetGuid },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world.spawn(
    {
      component: TileLayer,
      data: { tiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('per-cell') },
    },
    { component: ChildOf, data: { parent: tilemap } },
  );
}

function makeTileset(opts: {
  guid: string;
  regions: Array<{ x: number; y: number; width: number; height: number }>;
}): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: opts.regions,
    tiles: opts.regions.map((_, i) => ({ regionIndex: i })),
  };
}

function readDerivedMaterialHandles(world: World): number[] {
  const out: number[] = [];
  const query = world.query({ read: [MeshRenderer], with: [MeshFilter, Layer] }).unwrap();
  for (const row of query) {
    const handle = row.get(MeshRenderer).materials[0];
    if (handle !== undefined) out.push(handle as unknown as number);
  }
  return out;
}

describe('resolveTilesetMaterial — binary (atlasHandle, regionIndex) cache key', () => {
  it('twice-spawn the same (atlas, regionIndex) -> same materialHandle', () => {
    const world1 = new World();
    const tileset1 = makeTileset({
      guid: 'tileset/A',
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    });
    const lookup1 = makeTilemapAssetLookup(tileset1);
    spawnTilemapWithLayer(world1, 'test/tileset', 1, 1, new Uint32Array([1]));
    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();
    tilemapChunkExtractSystem(world1, lookup1);
    const mats1 = readDerivedMaterialHandles(world1);
    expect(mats1.length).toBe(1);

    // Second spawn: distinct world, same atlas handle (id=101) and same
    // regionIndex => the cache key collides => same materialHandle.
    const world2 = new World();
    const tileset2 = makeTileset({
      guid: 'tileset/B',
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    });
    const lookup2 = makeTilemapAssetLookup(tileset2);
    spawnTilemapWithLayer(world2, 'test/tileset', 1, 1, new Uint32Array([1]));
    tilemapChunkExtractSystem(world2, lookup2);
    const mats2 = readDerivedMaterialHandles(world2);
    expect(mats2.length).toBe(1);
    expect(mats1[0]).toBe(mats2[0]);
  });

  it('different regionIndex on the same atlas -> different materialHandle', () => {
    const world = new World();
    const tileset = makeTileset({
      guid: 'tileset/two-regions',
      regions: [
        { x: 0, y: 0, width: 16, height: 16 },
        { x: 16, y: 0, width: 16, height: 16 },
      ],
    });
    const lookup = makeTilemapAssetLookup(tileset);

    spawnTilemapWithLayer(world, 'test/tileset', 2, 1, new Uint32Array([1, 2]));
    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();
    tilemapChunkExtractSystem(world, lookup);
    const mats = readDerivedMaterialHandles(world).sort((a, b) => a - b);
    expect(mats.length).toBe(2);
    expect(mats[0]).not.toBe(mats[1]);
  });
});
