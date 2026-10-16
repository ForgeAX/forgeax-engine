// tilemap-multi-atlas.test - resolveTilesetMaterial 3-hop atlasIndex routing
// + binary (atlasHandle, regionIndex) cache key invariants (feat-20260608
// M3 / m3-t6). RED at commit; m3-t7 lands the 3-hop dispatch.
//
// Spec (plan-strategy §D-7 step 2 + §D-12 + requirements §AC-04 / §AC-11):
//   resolveTilesetMaterial walks `tile.regionIndex -> regions[regionIndex]
//   -> region.atlasIndex ?? 0 -> atlases[atlasIndex]` so a TilesetAsset
//   with N atlases routes per-region to the correct GPU texture handle.
//   The material cache key stays binary `(atlasHandle, regionIndex)` --
//   different atlas handles for the same regionIndex produce distinct
//   material entries (charter P4).
//
// Charter mapping: P4 (cache key stays binary; widthCells / pivot extras
// do not leak into the key, so per-tile overrides share one material) +
// P3 (region.atlasIndex out-of-range is caught at register time via
// validateTilesetPayload m1-t6; runtime resolver bails to handle 0 if an
// atlas slot is unexpectedly empty rather than silently sampling the
// wrong texture).

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
import { makeTestTexture, makeTilemapAssetLookup } from './helpers/tilemap-assets';

interface RegionWithAtlasIndex {
  x: number;
  y: number;
  width: number;
  height: number;
  atlasIndex?: number;
}

function makeTwoAtlasTileset(opts: {
  atlases: string[];
  regions: RegionWithAtlasIndex[];
  tilesExtras?: Array<
    Partial<{ widthCells: number; heightCells: number; pivotX: number; pivotY: number }>
  >;
}): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: opts.atlases,
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    rows: 2,
    regions: opts.regions,
    tiles: opts.regions.map((_, i) => ({
      regionIndex: i,
      ...(opts.tilesExtras?.[i] ?? {}),
    })),
  };
}

function spawnTilemap(
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

function readMaterialTextureHandle(world: World, materialHandle: number): number {
  const tagged = toShared<'MaterialAsset'>(materialHandle);
  const res = resolveAssetHandle<MaterialAsset>(world, tagged);
  if (!res.ok) return 0;
  const asset = res.value;
  if (asset.kind !== 'material') return 0;
  const pv = asset.values as Readonly<Record<string, number | number[] | string | undefined>>;
  const tex = pv.baseColorTexture;
  return typeof tex === 'number' ? tex : 0;
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

describe('resolveTilesetMaterial - 3-hop atlasIndex routing (m3-t6)', () => {
  it('atlases=[A,B] + regions[].atlasIndex routes each region to its own atlas', () => {
    const world = new World();
    const atlasA = 'test/atlas-a';
    const atlasB = 'test/atlas-b';
    const tileset = makeTwoAtlasTileset({
      atlases: [atlasA, atlasB],
      regions: [
        { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
        { x: 0, y: 0, width: 16, height: 16, atlasIndex: 1 },
        { x: 16, y: 0, width: 16, height: 16 /* defaults to atlasIndex 0 */ },
      ],
    });
    const lookup = makeTilemapAssetLookup(tileset, {
      [atlasA]: makeTestTexture(201),
      [atlasB]: makeTestTexture(202),
    });

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, 'test/tileset', 3, 1, new Uint32Array([1, 2, 3]));
    tilemapChunkExtractSystem(world, lookup);

    const mats = readDerivedMaterialHandles(world);
    expect(mats.length).toBe(3);
    // All 3 handles must be distinct -- atlas A region 0 vs atlas B region 1
    // vs atlas A region 2 are three independent (atlasHandle, regionIndex)
    // cache keys.
    expect(new Set(mats).size).toBe(3);

    // The 3-hop walk must thread each region to the *correct* atlas. Build
    // a map cellX -> material -> texture so we can verify the routing.
    // tiles[0] regionIndex=0 atlasIndex=0 -> atlasA (id 201)
    // tiles[1] regionIndex=1 atlasIndex=1 -> atlasB (id 202)
    // tiles[2] regionIndex=2 (no atlasIndex, defaults to 0) -> atlasA (id 201)
    // Regions 0 and 2 intentionally share atlasA's texture payload.
    const textures = mats.map((h) => readMaterialTextureHandle(world, h));
    expect(new Set(textures).size).toBe(2);
  });

  it('same (atlasHandle, regionIndex) hits the same cache slot even when widthCells/pivot differ', () => {
    const world = new World();
    const atlasA = 'test/atlas-a';
    // Two tile entries reference the SAME region 0 but carry different
    // widthCells / pivot -- the cache key is strictly (atlasHandle,
    // regionIndex), so both must share one materialHandle.
    const tileset = {
      kind: 'tileset',
      atlases: [atlasA],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
      tiles: [
        { regionIndex: 0, widthCells: 1, heightCells: 1, pivotX: 0.5, pivotY: 0.5 },
        { regionIndex: 0, widthCells: 3, heightCells: 4, pivotX: 0.2, pivotY: 0.8 },
      ],
    } satisfies TilesetAsset;
    const lookup = makeTilemapAssetLookup(tileset, { [atlasA]: makeTestTexture(201) });

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, 'test/tileset', 2, 1, new Uint32Array([1, 2]));
    tilemapChunkExtractSystem(world, lookup);

    const mats = readDerivedMaterialHandles(world);
    expect(mats.length).toBe(2);
    expect(mats[0]).toBe(mats[1]);
  });

  it('different atlasIndex on the same regionIndex maps to different materials', () => {
    const world = new World();
    const atlasA = 'test/atlas-a';
    const atlasB = 'test/atlas-b';

    // Region 0 (x=0,y=0) appears twice -- once on atlas A, once on atlas B.
    // The TilesetAsset has two regions sharing identical pixel coordinates
    // but distinct atlasIndex; the cache must produce two material handles.
    const tileset = makeTwoAtlasTileset({
      atlases: [atlasA, atlasB],
      regions: [
        { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
        { x: 0, y: 0, width: 16, height: 16, atlasIndex: 1 },
      ],
    });
    const lookup = makeTilemapAssetLookup(tileset, {
      [atlasA]: makeTestTexture(401),
      [atlasB]: makeTestTexture(402),
    });

    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    spawnTilemap(world, 'test/tileset', 2, 1, new Uint32Array([1, 2]));
    tilemapChunkExtractSystem(world, lookup);

    const mats = readDerivedMaterialHandles(world).sort((a, b) => a - b);
    expect(mats.length).toBe(2);
    expect(mats[0]).not.toBe(mats[1]);

    const textures = mats.map((h) => readMaterialTextureHandle(world, h));
    expect(new Set(textures).size).toBe(2);
  });
});
