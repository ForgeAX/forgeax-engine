// tilemap-chunk-extract.test - per-cell entity TRS shape on dirty layers
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//  - One ECS entity is spawned per NON-ZERO cell (no Instances component).
//  - Each spawned entity carries Transform + MeshFilter (HANDLE_QUAD) +
//    MeshRenderer + Layer + ChildOf.
//  - Transform.pos[0] = (cellX + 0.5) * tileSizeX (M0 1x1 unit-cell form).
//  - Transform.pos[1] = (cellY + 0.5) * tileSizeY.
//  - scale[0] sign encodes flipH, scale[1] sign encodes flipV.
//  - quat[2] / quat[3] encode D flip (90deg CW z-rotation).
//
// Anchors: plan-tasks m0-t9 / m0-t10; plan-strategy §D-1 per-cell entity TRS.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
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

const SQRT1_2 = Math.SQRT1_2;

function makeSetup(opts: {
  cols: number;
  rows: number;
  tileSize?: readonly [number, number];
  chunkSize?: number;
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
          tileSize: opts.tileSize ?? [1, 1],
          chunkSize: opts.chunkSize ?? 16,
          tileset: 'test/tileset',
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  const layer = world
    .spawn(
      {
        component: TileLayer,
        data: {
          tiles: opts.tiles,
          layerOrder: 0,
          dirty: 1,
          sortScope: encodeSortScope('per-cell'),
        },
      },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, tilemap, layer, lookup };
}

describe('tilemapChunkExtractSystem (M0 baseline)', () => {
  it('spawns one entity per non-zero cell (no Instances)', () => {
    const cols = 4;
    const rows = 4;
    const tiles = new Uint32Array(cols * rows);
    tiles[0] = 1;
    tiles[5] = 1;
    tiles[10] = 1;
    const { world, lookup } = makeSetup({ cols, rows, tiles });
    tilemapChunkExtractSystem(world, lookup);
    // 3 non-zero cells -> 3 derived entities.
    let derivedCount = 0;
    for (const arch of world.inspect().archetypes) {
      if (
        arch.componentNames.includes('MeshFilter') &&
        arch.componentNames.includes('MeshRenderer') &&
        arch.componentNames.includes('Layer') &&
        !arch.componentNames.includes('Instances')
      ) {
        derivedCount += arch.entityCount;
      }
    }
    expect(derivedCount).toBe(3);
  });

  it('Transform.pos[0]/pos[1] land at cell center (M0 1x1 form)', () => {
    const cols = 2;
    const rows = 2;
    const tileSize = 16;
    const tiles = new Uint32Array(cols * rows);
    tiles[3] = 1; // cellX=1, cellY=1
    const { world, lookup } = makeSetup({
      cols,
      rows,
      tileSize: [tileSize, tileSize],
      tiles,
    });
    tilemapChunkExtractSystem(world, lookup);
    let px = Number.NaN;
    let py = Number.NaN;
    const query = world.query({ read: [Transform], with: [MeshFilter, Layer] }).unwrap();
    for (const row of query) {
      const t = row.get(Transform);
      px = t.pos[0] ?? Number.NaN;
      py = t.pos[1] ?? Number.NaN;
    }
    expect(px).toBeCloseTo((1 + 0.5) * tileSize, 5);
    expect(py).toBeCloseTo((1 + 0.5) * tileSize, 5);
  });

  it('flipH negates scale[0]; flipV negates scale[1]; D sets quat[2]=quat[3]=SQRT1_2', () => {
    const tileSize = 16;
    const tiles = new Uint32Array(1);
    tiles[0] = encodeTileBits(1, true, true, true, false);
    const { world, lookup } = makeSetup({
      cols: 1,
      rows: 1,
      tileSize: [tileSize, tileSize],
      tiles,
    });
    tilemapChunkExtractSystem(world, lookup);
    let sx = Number.NaN;
    let sy = Number.NaN;
    let qz = Number.NaN;
    let qw = Number.NaN;
    const query = world.query({ read: [Transform], with: [MeshFilter, Layer] }).unwrap();
    for (const row of query) {
      const t = row.get(Transform);
      sx = t.scale[0] ?? Number.NaN;
      sy = t.scale[1] ?? Number.NaN;
      qz = t.quat[2] ?? Number.NaN;
      qw = t.quat[3] ?? Number.NaN;
    }
    expect(sx).toBe(-tileSize);
    expect(sy).toBe(-tileSize);
    expect(qz).toBeCloseTo(SQRT1_2, 5);
    expect(qw).toBeCloseTo(SQRT1_2, 5);
  });

  it('uses HANDLE_QUAD as the MeshFilter handle on derived entities', () => {
    const tiles = new Uint32Array(1);
    tiles[0] = 1;
    const { world, lookup } = makeSetup({ cols: 1, rows: 1, tiles });
    tilemapChunkExtractSystem(world, lookup);
    const query = world.query({ read: [MeshFilter], with: [Layer] }).unwrap();
    for (const row of query) {
      const mf = row.get(MeshFilter);
      // Compare raw u32 (unwrap brand via numeric cast).
      expect(mf.assetHandle as unknown as number).toBe(HANDLE_QUAD as unknown as number);
    }
  });

  it('MeshRenderer is present on every derived entity', () => {
    const tiles = new Uint32Array(2);
    tiles[0] = 1;
    tiles[1] = 1;
    const { world, lookup } = makeSetup({ cols: 2, rows: 1, tiles });
    tilemapChunkExtractSystem(world, lookup);
    let count = 0;
    for (const arch of world.inspect().archetypes) {
      if (
        arch.componentNames.includes('MeshFilter') &&
        arch.componentNames.includes('MeshRenderer') &&
        arch.componentNames.includes('Layer')
      ) {
        count += arch.entityCount;
      }
    }
    expect(count).toBe(2);
  });

  // AC-07 (requirements C-4 frozen): when no Camera entity exists in the
  // World, `buildCameraFrustumPlanes` returns null and the per-cell
  // streaming path falls through to "all chunks visible". Every non-empty
  // cell across every chunk must spawn a derived entity. The path must
  // not throw, and must not silently degrade to "zero chunks active".
  //
  // Anchors: requirements AC-07 (null frustum -> all chunks spawned);
  // plan-strategy §5.3 (AC-07: null frustum -> full spawn fallback);
  // plan-strategy §4 R-4 (charter-insufficient — no diagnostic signal
  // emitted from this path; requirement C-4 froze the warn intentionally).
  it('null frustum (no Camera entity) -> all chunks spawn derived entities', () => {
    // 8x8 grid with chunkSize=4 = 4 chunks, every cell non-empty.
    const cols = 8;
    const rows = 8;
    const tiles = new Uint32Array(cols * rows);
    for (let i = 0; i < tiles.length; i++) tiles[i] = 1;
    const { world, lookup } = makeSetup({ cols, rows, chunkSize: 4, tiles });
    expect(() => tilemapChunkExtractSystem(world, lookup)).not.toThrow();
    // Without a Camera entity, all 64 cells must have spawned derived
    // entities (per-cell sortScope path under null frustum -> all chunks
    // visible -> every non-empty cell yields one derived entity).
    let derivedCount = 0;
    for (const arch of world.inspect().archetypes) {
      if (
        arch.componentNames.includes('MeshFilter') &&
        arch.componentNames.includes('MeshRenderer') &&
        arch.componentNames.includes('Layer') &&
        !arch.componentNames.includes('Instances') &&
        !arch.componentNames.includes('SpriteInstances')
      ) {
        derivedCount += arch.entityCount;
      }
    }
    expect(derivedCount).toBe(64);
  });
});
