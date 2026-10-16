// tilemap-chunk-extract.overhang-bounds.test.ts
// bug-20260703-tilemap-chunk-stale-frustum-and-cull-overhang / M2 / m2-1.
//
// Asserts D2: chunk streaming visibility uses the union of every tile's
// post-TRS footprint (`computeChunkStreamBounds`) instead of a tile-aligned
// grid box, so multi-cell / off-pivot tiles that overhang their anchor
// chunk no longer flicker when the anchor chunk grid box leaves the
// frustum but the overhanging pixels are still on screen.
//
// Scene shape (shared across the OVERHANG + FALSIFY + flip variants):
//   cols=8, rows=1, chunkSize=4, tileSize=16 -> 2 chunks along x
//     chunk 0: cells 0..3   -> world x [ 0,  64]
//     chunk 1: cells 4..7   -> world x [64, 128]
//   Only cell 4 (chunk 1's first cell) holds a tile.
//   Camera window x in [50, 60] (posX=55, ortho left=-5/right=5).
//
// With `pivotX=0.5 / pivotY=1 / widthCells=2` the tile centers at world
// x=72 with scaleX=32 -> footprint x in [56, 88]. That footprint overhangs
// left into chunk 0 space but the anchor is chunk 1; the OLD grid box
// [64, 128] would miss the camera window [50, 60] and despawn chunk 1
// prematurely -- the D2 bug shape. The FIX bounds [56, 88] intersect
// [50, 60] and keep chunk 1 spawned.
//
// The FALSIFY variant swaps to `pivotX=0.5 / widthCells=1` at the same
// cell: footprint x in [64, 80] no longer overlaps the camera window, so
// chunk 1 must NOT spawn. Without this discriminating case, an always-on
// visibility test would pass the overhang assertion trivially (plan-
// strategy §5.4 falsification).
//
// The FLIP variants (H / V / D) exercise the plan-strategy §D-2
// pivot x flip composite. Each combination still produces a footprint
// that overlaps [50, 60]; if `computeChunkStreamBounds` composed pivot
// against flip incorrectly the overhang could drift by one full tile and
// miss the camera window entirely, so these guardrails catch pivot / flip
// drift future-proof.
//
// The EMPTY-CHUNK case directly calls the exported
// `computeChunkStreamBounds` sentinel branch (`specs.length === 0`) to
// confirm the inverted-infinity return is rejected by
// `frustum.intersectsBox` for any real frustum (plan-strategy §2 D-4).
//
// Anchors:
//   - requirements AC-04 (footprint union bounds for chunk visibility)
//   - requirements AC-05 (falsification: same-camera / no-overhang
//     variant must despawn chunk 1)
//   - requirements Edge Cases "tile fully outside anchor chunk"
//   - requirements Edge Cases "empty chunk"
//   - plan-strategy §2 D-2 / D-3 / D-4
//   - plan-strategy §5.3 D2 test points

import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { frustum, mat4 } from '@forgeax/engine-math';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera } from '@forgeax/engine-render';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { TilesetAsset, TilesetTileEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { encodeSortScope } from '../../../render/src/components/tile-layer';
import {
  computeChunkStreamBounds,
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

// Camera window x in [CAMERA_POS - 5, CAMERA_POS + 5]. Landing at 55 puts
// the right edge at 60, which straddles the footprint of a widthCells=2
// tile anchored at cell 4 (footprint x in [56, 88]) but sits outside the
// widthCells=1 falsify variant (footprint x in [64, 80]).
const CAMERA_POS = 55;

interface OverhangSceneOpts {
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly widthCells?: number;
  readonly heightCells?: number;
  readonly flipH?: boolean;
  readonly flipV?: boolean;
  readonly flipDiagonal?: boolean;
}

interface Scene {
  readonly world: World;
  readonly cameraEntity: EntityHandle;
  readonly lookup: ReturnType<typeof makeTilemapAssetLookup>;
}

function makeOverhangScene(opts: OverhangSceneOpts = {}): Scene {
  const world = new World();
  const cols = 8;
  const rows = 1;
  const chunkSize = 4;
  const tileSizeX = 16;
  const tileSizeY = 16;
  const tiles = new Uint32Array(cols * rows);
  // Cell 4 belongs to chunk 1 (cells 4..7). tileId=1 -> tileset.tiles[0].
  tiles[4] = encodeTileBits(
    1,
    opts.flipH ?? false,
    opts.flipV ?? false,
    opts.flipDiagonal ?? false,
    false,
  );
  const tileEntry: TilesetTileEntry = {
    regionIndex: 0,
    widthCells: opts.widthCells ?? 1,
    heightCells: opts.heightCells ?? 1,
    pivotX: opts.pivotX ?? 0.5,
    pivotY: opts.pivotY ?? 0.5,
  };
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: cols,
    rows,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [tileEntry],
  };
  const lookup = makeTilemapAssetLookup(tileset);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols, rows, tileSize: [tileSizeX, tileSizeY], chunkSize, tileset: 'test/tileset' },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  world
    .spawn(
      {
        component: TileLayer,
        data: {
          tiles,
          layerOrder: 0,
          dirty: 1,
          sortScope: encodeSortScope('per-cell'),
        },
      },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  // Camera window x in [CAMERA_POS - 5, CAMERA_POS + 5] and y in [-8, 8].
  // posZ=5 with near=0.1 / far=100 keeps the tile plane (z=0) inside the
  // depth range.
  const cameraEntity = world
    .spawn(
      { component: Transform, data: { pos: [CAMERA_POS, 0, 5] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -5,
          right: 5,
          bottom: -8,
          top: 8,
        },
      },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, cameraEntity, lookup };
}

function countDerivedPerCellEntities(world: World): number {
  let count = 0;
  for (const arch of world.inspect().archetypes) {
    // Post tweak-20260714 M2 the derived per-cell archetype carries
    // ChildOf { parent: layerEntity } so `world.despawn(tilemap)` can
    // cascade-collect it; distinguish from the batched terrain / static
    // instance archetypes via SpriteInstances / Instances absence.
    const isPerCell =
      arch.componentNames.includes('MeshFilter') &&
      arch.componentNames.includes('MeshRenderer') &&
      arch.componentNames.includes('Layer') &&
      arch.componentNames.includes('Transform') &&
      !arch.componentNames.includes('SpriteInstances') &&
      !arch.componentNames.includes('Instances');
    if (!isPerCell) continue;
    count += arch.entityCount;
  }
  return count;
}

function runFrame(scene: Scene): number {
  propagateTransforms(scene.world);
  tilemapChunkExtractSystem(scene.world, scene.lookup);
  return countDerivedPerCellEntities(scene.world);
}

describe('tilemapChunkExtractSystem overhang bounds (D2)', () => {
  it('spawns chunk whose footprint overhangs the anchor grid into the frustum', () => {
    // pivotX=0.5 / widthCells=2 -> tile at cell 4 spans world x [56, 88].
    // Camera window [50, 60] intersects the footprint but NOT the grid
    // box [64, 128] -- the D2 bug shape. Post-fix: chunk 1 is spawned so
    // the widthCells=2 tile becomes visible.
    const scene = makeOverhangScene({ pivotX: 0.5, pivotY: 1, widthCells: 2 });
    expect(runFrame(scene)).toBe(1);
  });

  it('FALSIFY: same camera / same cell / no overhang -> chunk stays despawned', () => {
    // widthCells=1 -> footprint x [64, 80]; camera window [50, 60] does
    // NOT intersect. Chunk 1 must NOT spawn, otherwise the overhang test
    // above has no discriminating power.
    const scene = makeOverhangScene({ pivotX: 0.5, pivotY: 0.5, widthCells: 1 });
    expect(runFrame(scene)).toBe(0);
  });

  it('flipH keeps overhang visible (pivot x flip composite intact)', () => {
    const scene = makeOverhangScene({
      pivotX: 0.5,
      pivotY: 1,
      widthCells: 2,
      flipH: true,
    });
    expect(runFrame(scene)).toBe(1);
  });

  it('flipV keeps overhang visible (pivot y flip composite intact)', () => {
    const scene = makeOverhangScene({
      pivotX: 0.5,
      pivotY: 1,
      widthCells: 2,
      flipV: true,
    });
    expect(runFrame(scene)).toBe(1);
  });

  it('flipDiagonal keeps overhang visible (D swaps pivot X/Y roles)', () => {
    // With D=true the pivot axis roles swap:
    //   basePivotForX = pivotY = 1 -> effectivePivotX = 1
    //   posX = (4 + 1 + (0.5 - 1) * 2) * 16 = 64, scaleX = 32
    //   footprint x = [48, 80] still intersects camera window [50, 60].
    const scene = makeOverhangScene({
      pivotX: 0.5,
      pivotY: 1,
      widthCells: 2,
      flipDiagonal: true,
    });
    expect(runFrame(scene)).toBe(1);
  });

  it('empty chunk sentinel bounds are rejected by any real frustum', () => {
    // Empty spec list should never reach the visibility test in production
    // (bucketTileLayer filters empty cells), but the sentinel guards
    // against silent NaN paths if it ever did (charter P3 + plan-strategy
    // §2 D-4). Uses finite MAX_VALUE bounds inverted (min > max) so
    // `frustum.intersectsBox` reliably drives `dot` to -Infinity on the
    // non-zero-normal axis of every plane and returns false -- Infinity
    // multiplied by a zero-component normal would produce NaN and slip
    // through the `< 0` check silently.
    const bounds = computeChunkStreamBounds({ tileSize: [16, 16] }, []);
    // Inverted-large sentinel shape: min = +MAX_VALUE, max = -MAX_VALUE.
    expect(bounds[0]).toBe(Number.MAX_VALUE);
    expect(bounds[1]).toBe(Number.MAX_VALUE);
    expect(bounds[2]).toBe(-1);
    expect(bounds[3]).toBe(-Number.MAX_VALUE);
    expect(bounds[4]).toBe(-Number.MAX_VALUE);
    expect(bounds[5]).toBe(1);

    // Build a wide-open orthographic frustum and confirm the sentinel is
    // still rejected -- inverted-large means "no visible pixels" even when
    // the frustum would accept an ordinary large box.
    const proj = mat4.create();
    mat4.orthographic(
      proj as Parameters<typeof mat4.orthographic>[0],
      -1000,
      1000,
      1000,
      -1000,
      0.1,
      100,
    );
    const view = mat4.create();
    const camWorld = mat4.create();
    mat4.compose(
      camWorld as Parameters<typeof mat4.compose>[0],
      [0, 0, 5],
      [0, 0, 0, 1],
      [1, 1, 1],
    );
    mat4.invert(
      view as Parameters<typeof mat4.invert>[0],
      camWorld as Parameters<typeof mat4.invert>[1],
    );
    const vp = mat4.create();
    mat4.multiply(
      vp as Parameters<typeof mat4.multiply>[0],
      proj as Parameters<typeof mat4.multiply>[1],
      view as Parameters<typeof mat4.multiply>[2],
    );
    const f = frustum.create();
    frustum.fromViewProjection(f, vp as Parameters<typeof frustum.fromViewProjection>[1]);
    expect(frustum.intersectsBox(f, bounds)).toBe(false);
  });
});

// Kept for TypeScript "no unused import" when the file evolves; Entity is
// referenced via the `world.inspect().archetypes` iteration inside the
// counter helper via `componentNames` string identifiers only.
void Entity;
