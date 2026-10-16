// tilemap-uv-inset.test - half-texel inset on resolveTilesetMaterial
// (feat-20260608 M2 / m2-t3; plan-strategy §D-7 step 3).
//
// `resolveTilesetMaterial` is M2's UV-inset step on top of the M0
// baseline. It packs the region rectangle into normalized UV space such
// that GPU bilinear filtering at sub-pixel boundaries can never sample
// beyond the region rectangle (charter P3 - default behaviour does not
// silently bleed colours from the adjacent atlas tile).
//
// Inset formula (atlas extent in pixels, output in normalised [0, 1]^2):
//
//   uvU      = region.x      / atlasWidth  + 0.5 / atlasWidth
//   uvV      = region.y      / atlasHeight + 0.5 / atlasHeight
//   uvWidth  = region.width  / atlasWidth  - 1   / atlasWidth
//   uvHeight = region.height / atlasHeight - 1   / atlasHeight
//
// The 0.5 / atlasWidth term inset both edges by exactly half a texel,
// so any GPU bilinear filter sampling at the region edge stays inside
// the region instead of sampling the adjacent atlas tile.
//
// FALSIFY rationale: a regression that strips the inset (returns to the
// M0 baseline `u = region.x / atlasWidth`, `w = region.width / atlasWidth`)
// fails the numerical inset assertion below, locking the behaviour.
//
// Anchors: plan-tasks m2-t3; plan-strategy §D-7 step 3; charter P3
// (default behaviour avoids silently introducing visual defects).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Layer, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset, type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { encodeSortScope } from '../../../render/src/components/tile-layer';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

interface AtlasMeta {
  atlasWidth: number;
  atlasHeight: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

function makeTileset(opts: {
  guid: string;
  atlas: AtlasMeta;
  regions: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
}): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: opts.atlas.tileWidth,
    tileHeight: opts.atlas.tileHeight,
    columns: opts.atlas.columns,
    rows: opts.atlas.rows,
    regions: opts.regions,
    tiles: opts.regions.map((_, i) => ({ regionIndex: i })),
  };
}

function spawnAndExtract(
  tileset: TilesetAsset,
  layerTiles: Uint32Array,
  cols = 1,
  rows = 1,
): World {
  const world = new World();
  const lookup = makeTilemapAssetLookup(tileset);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols, rows, tileSize: [1, 1], chunkSize: 4, tileset: 'test/tileset' },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world.spawn(
    {
      component: TileLayer,
      data: { tiles: layerTiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('per-cell') },
    },
    { component: ChildOf, data: { parent: tilemap } },
  );
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  tilemapChunkExtractSystem(world, lookup);
  return world;
}

function readDerivedMaterialRegions(world: World): number[][] {
  const out: number[][] = [];
  const query = world.query({ read: [MeshRenderer], with: [MeshFilter, Layer] }).unwrap();
  for (const row of query) {
    const handleRaw = row.get(MeshRenderer).materials[0];
    if (handleRaw === undefined) continue;
    const matRes = resolveAssetHandle<MaterialAsset>(
      world,
      toShared<'MaterialAsset'>(handleRaw as unknown as number),
    );
    if (!matRes.ok) continue;
    const region = matRes.value.values?.region as readonly number[] | undefined;
    if (region !== undefined) out.push([...region]);
  }
  return out;
}

describe('resolveTilesetMaterial — half-texel UV inset (M2)', () => {
  it('top-left region inset: u = x/W + 0.5/W; w = width/W - 1/W (32x32 atlas, 16x16 region)', () => {
    const tileset = makeTileset({
      guid: 'tileset/uv-inset/top-left',
      atlas: {
        atlasWidth: 32,
        atlasHeight: 32,
        columns: 2,
        rows: 2,
        tileWidth: 16,
        tileHeight: 16,
      },
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    });
    const world = spawnAndExtract(tileset, new Uint32Array([1]));
    const regions = readDerivedMaterialRegions(world);
    expect(regions.length).toBe(1);
    const r = regions[0];
    if (r === undefined) throw new Error('expected one derived material region');
    // u = 0/32 + 0.5/32 = 0.015625
    // v = 0/32 + 0.5/32 = 0.015625
    // w = 16/32 - 1/32 = 0.46875
    // h = 16/32 - 1/32 = 0.46875
    expect(r[0]).toBeCloseTo(0.015625, 6);
    expect(r[1]).toBeCloseTo(0.015625, 6);
    expect(r[2]).toBeCloseTo(0.46875, 6);
    expect(r[3]).toBeCloseTo(0.46875, 6);
  });

  it('bottom-right region inset: u = 16/32 + 0.5/32; w = 16/32 - 1/32 (32x32 atlas, 16x16 region)', () => {
    const tileset = makeTileset({
      guid: 'tileset/uv-inset/bottom-right',
      atlas: {
        atlasWidth: 32,
        atlasHeight: 32,
        columns: 2,
        rows: 2,
        tileWidth: 16,
        tileHeight: 16,
      },
      regions: [{ x: 16, y: 16, width: 16, height: 16 }],
    });
    const world = spawnAndExtract(tileset, new Uint32Array([1]));
    const regions = readDerivedMaterialRegions(world);
    expect(regions.length).toBe(1);
    const r = regions[0];
    if (r === undefined) throw new Error('expected one derived material region');
    expect(r[0]).toBeCloseTo(0.515625, 6);
    expect(r[1]).toBeCloseTo(0.515625, 6);
    expect(r[2]).toBeCloseTo(0.46875, 6);
    expect(r[3]).toBeCloseTo(0.46875, 6);
  });

  it('adjacent tile insets stay >= 1 texel apart (prevents GPU bilinear bleed)', () => {
    const tileset = makeTileset({
      guid: 'tileset/uv-inset/adjacent',
      atlas: {
        atlasWidth: 64,
        atlasHeight: 32,
        columns: 4,
        rows: 2,
        tileWidth: 16,
        tileHeight: 16,
      },
      regions: [
        { x: 0, y: 0, width: 16, height: 16 },
        { x: 16, y: 0, width: 16, height: 16 },
      ],
    });
    const world = spawnAndExtract(tileset, new Uint32Array([1, 2]), /* cols= */ 2, /* rows= */ 1);
    const regions = readDerivedMaterialRegions(world);
    expect(regions.length).toBe(2);
    const [first, second] = regions.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    if (first === undefined || second === undefined) {
      throw new Error('expected two derived material regions');
    }
    // First region right edge in normalized UV: u_right = u + w
    //   = (0/64 + 0.5/64) + (16/64 - 1/64) = 0.5/64 + 15/64 = 15.5/64
    // Second region left edge: u_left = 16/64 + 0.5/64 = 16.5/64
    // Gap = 16.5/64 - 15.5/64 = 1/64 = 1 texel of atlasWidth.
    const firstRight = (first[0] ?? 0) + (first[2] ?? 0);
    const secondLeft = second[0] ?? 0;
    const gap = secondLeft - firstRight;
    expect(gap).toBeGreaterThanOrEqual(1 / 64 - 1e-6);
  });
});
