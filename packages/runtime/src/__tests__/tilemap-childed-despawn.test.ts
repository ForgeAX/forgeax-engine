// tilemap-childed-despawn.test - derived entities ChildOf their TileLayer,
// world.despawn(tilemap) cascades through the whole subtree, engine-state
// despawnOnExit triggers the same cascade via the state transition system.
//
// Covers requirements AC-02 (ChildOf { parent: layerEntity } on both spawn
// paths), AC-03 (world.despawn cascade), AC-04 (despawnOnExit cascade).
// Anchors: plan-strategy §2 D-2 (single-cut ChildOf on both paths) + §4 R-6
// (multi-TileLayer depth-3 despawn); requirements §5 AC-02/03/04.
//
// M2 of tweak-20260714-tilemap-layer-childed-render-entities.

import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import {
  defineState,
  despawnOnExit,
  registerStatesPlugin,
  setNextState,
} from '@forgeax/engine-state';
import type { TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { encodeSortScope, markTileLayerDirty } from '../../../render/src/components/tile-layer';
import {
  _peekPerCellStreamingLayerKeys,
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

// One state token per file — defineState is module-level, redefining under
// the same name throws. `GameState` is shared between AC-04 setup and
// the state transition assertion.
const GameState = defineState('GameState', ['menu', 'playing'] as const);

interface SetupOpts {
  readonly cols: number;
  readonly rows: number;
  readonly tiles: Uint32Array;
  readonly sortScope: 'layer' | 'per-cell';
  readonly chunkSize?: number;
}

function makeTileset(cols: number, rows: number): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: cols,
    rows,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
}

function spawnTilemap(
  world: World,
  cols: number,
  rows: number,
  chunkSize = 16,
): { tilemap: EntityHandle; lookup: ReturnType<typeof makeTilemapAssetLookup> } {
  const tileset = makeTileset(cols, rows);
  const lookup = makeTilemapAssetLookup(tileset);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: { cols, rows, tileSize: [1, 1], chunkSize, tileset: 'test/tileset' },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  return { tilemap, lookup };
}

function spawnLayer(
  world: World,
  parent: EntityHandle,
  tiles: Uint32Array,
  sortScope: 'layer' | 'per-cell',
  layerOrder = 0,
): EntityHandle {
  return world
    .spawn(
      {
        component: TileLayer,
        data: {
          tiles,
          layerOrder,
          dirty: 1,
          sortScope: encodeSortScope(sortScope),
        },
      },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();
}

function setup(opts: SetupOpts) {
  const world = new World();
  const { tilemap, lookup } = spawnTilemap(world, opts.cols, opts.rows, opts.chunkSize);
  const layer = spawnLayer(world, tilemap, opts.tiles, opts.sortScope);
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, tilemap, layer, lookup };
}

function isAlive(world: World, entity: EntityHandle): boolean {
  const r = world.get(entity, Entity);
  if (r.ok) return true;
  return r.error.code !== 'stale-entity';
}

/** Snapshot the parent's Children.entities as a live Entity handle array. */
function readChildren(world: World, parent: EntityHandle): EntityHandle[] {
  const r = world.get(parent, Children);
  if (!r.ok) return [];
  const snap = r.value.entities;
  const out: EntityHandle[] = [];
  for (let i = 0; i < snap.length; i++) {
    const e = snap[i];
    if (e !== undefined) out.push(e as EntityHandle);
  }
  return out;
}

describe('tilemap derived entities are ChildOf their TileLayer (AC-02)', () => {
  it("terrain path (sortScope='layer') attaches ChildOf { parent: layerEntity }", () => {
    // 8x8 cells, chunkSize=4 → 4 chunks; every cell filled so batched terrain
    // path spawns one SpriteInstances entity per chunk (4 total).
    const cols = 8;
    const rows = 8;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, layer, lookup } = setup({ cols, rows, chunkSize: 4, tiles, sortScope: 'layer' });

    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBe(4);
    for (const child of derived) {
      const co = world.get(child, ChildOf).unwrap();
      expect(co.parent).toBe(layer as unknown as number);
    }
  });

  it("per-cell streaming path (sortScope='per-cell') attaches ChildOf { parent: layerEntity }", () => {
    // 2x2 grid, single chunk, no Camera → streaming path spawns per non-zero
    // cell under the null-frustum "all chunks visible" fallback.
    const cols = 2;
    const rows = 2;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });

    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBe(4);
    for (const child of derived) {
      const co = world.get(child, ChildOf).unwrap();
      expect(co.parent).toBe(layer as unknown as number);
    }
  });

  it('FALSIFY: reading ChildOf.parent as tilemap (not layer) does NOT match — proves the assertion is parent-sensitive', () => {
    const cols = 2;
    const rows = 2;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, tilemap, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });

    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBeGreaterThan(0);
    const firstChild = derived[0] as EntityHandle;
    const co = world.get(firstChild, ChildOf).unwrap();
    // Sanity: parent equals the layer, not the tilemap. If a future refactor
    // pointed derived entities at the tilemap directly (bypassing the layer)
    // this expectation would flip to red and surface the drift.
    expect(co.parent).not.toBe(tilemap as unknown as number);
    expect(co.parent).toBe(layer as unknown as number);
  });
});

describe('world.despawn(tilemap) cascade-collects the whole subtree (AC-03)', () => {
  it('terrain layer + derived entities: single despawn wipes tilemap, layer, and all derived', () => {
    const cols = 4;
    const rows = 4;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, tilemap, layer, lookup } = setup({
      cols,
      rows,
      chunkSize: 4,
      tiles,
      sortScope: 'layer',
    });

    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBeGreaterThan(0);
    expect(isAlive(world, tilemap)).toBe(true);
    expect(isAlive(world, layer)).toBe(true);
    for (const d of derived) expect(isAlive(world, d)).toBe(true);

    world.despawn(tilemap).unwrap();

    expect(isAlive(world, tilemap)).toBe(false);
    expect(isAlive(world, layer)).toBe(false);
    for (const d of derived) expect(isAlive(world, d)).toBe(false);
  });

  it('per-cell layer + derived entities: single despawn wipes tilemap, layer, and all derived', () => {
    const cols = 3;
    const rows = 3;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, tilemap, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });

    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBe(9);

    world.despawn(tilemap).unwrap();

    expect(isAlive(world, tilemap)).toBe(false);
    expect(isAlive(world, layer)).toBe(false);
    for (const d of derived) expect(isAlive(world, d)).toBe(false);
  });

  it('terrain rebuild-then-despawn: build → markDirty+rebuild → despawn(tilemap) leaves zero survivors', () => {
    // The real lifecycle: despawn almost never lands on a pristine first
    // build — it happens after tile edits have triggered dirty-rebuilds. The
    // pre-I-1 ECS drain-then-refill leak left `Children.entities` empty after
    // the first rebuild, so this cascade silently collected nothing. Guards
    // AC-03 across the rebuild boundary.
    const cols = 8;
    const rows = 8;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, tilemap, layer, lookup } = setup({
      cols,
      rows,
      chunkSize: 4,
      tiles,
      sortScope: 'layer',
    });

    tilemapChunkExtractSystem(world, lookup);
    const firstGen = readChildren(world, layer);
    expect(firstGen.length).toBe(4);

    // Dirty-rebuild: prior generation purged, fresh generation spawned and
    // re-attached via Children.entities (the SSOT the cascade reads).
    markTileLayerDirty(world, layer).unwrap();
    tilemapChunkExtractSystem(world, lookup);

    const secondGen = readChildren(world, layer);
    expect(secondGen.length).toBe(4);
    for (const d of firstGen) expect(isAlive(world, d)).toBe(false);
    for (const d of secondGen) expect(isAlive(world, d)).toBe(true);

    // Cascade despawn AFTER a rebuild must still wipe the whole subtree.
    world.despawn(tilemap).unwrap();

    expect(isAlive(world, tilemap)).toBe(false);
    expect(isAlive(world, layer)).toBe(false);
    for (const d of secondGen) expect(isAlive(world, d)).toBe(false);
  });

  it('R-6 depth-3 despawn: 3 TileLayers under one Tilemap, world.despawn(tilemap) leaves zero survivors', () => {
    const world = new World();
    const { tilemap, lookup } = spawnTilemap(world, 4, 4, 4);
    const tiles = new Uint32Array(16).fill(1);
    const layers: EntityHandle[] = [
      spawnLayer(world, tilemap, tiles, 'layer', 0),
      spawnLayer(world, tilemap, tiles, 'per-cell', 1),
      spawnLayer(world, tilemap, tiles, 'layer', 2),
    ];
    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();

    tilemapChunkExtractSystem(world, lookup);

    const allDerived: EntityHandle[] = [];
    for (const l of layers) {
      const kids = readChildren(world, l);
      expect(kids.length).toBeGreaterThan(0);
      allDerived.push(...kids);
    }
    expect(allDerived.length).toBeGreaterThan(0);

    world.despawn(tilemap).unwrap();

    expect(isAlive(world, tilemap)).toBe(false);
    for (const l of layers) expect(isAlive(world, l)).toBe(false);
    for (const d of allDerived) expect(isAlive(world, d)).toBe(false);
  });
});

describe('per-cell streaming despawn detection clears stale caches (AC-11)', () => {
  // AC-11 anchors: requirements §5 AC-11 (slot-reuse must not disturb the
  // fresh layer); requirements §8 edge case #4 (per-cell despawn + slot
  // reuse); plan-strategy §2 D-4 (diff-cleanup in main-loop preamble,
  // onRemove hook rejected); §4 R-3 (flat key + activeSet-driven cleanup
  // fallback); OOS-3 (per-frame no-incremental-cost invariant — the diff
  // scan only touches per-cell cache Maps, no matrix work).
  //
  // Contract: after `world.despawn(layerEntity)` on a per-cell TileLayer,
  // the next `tilemapChunkExtractSystem` call MUST evict that layerKey
  // from `layerStreamCache`, `layerChunkActive`, and `layerChunkStreamEntities`.
  // `worldEntityKey(0, slot) === slot` under worldId=0, so the raw entity
  // handle equals the layerKey the extract system stored (matches
  // `record/frame-snapshot.ts` §D-1a #7 identity property).

  it('despawn(per-cell layer) causes next extract call to evict layerKey from all 3 streaming caches', () => {
    const cols = 2;
    const rows = 2;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });

    tilemapChunkExtractSystem(world, lookup);

    const oldLayerKey = layer as unknown as number;
    expect(_peekPerCellStreamingLayerKeys(world)).toContain(oldLayerKey);

    world.despawn(layer).unwrap();

    // Next extract call fires the diff-cleanup preamble; the query no
    // longer includes the dead layer, so its cache entries evict.
    tilemapChunkExtractSystem(world, lookup);

    expect(_peekPerCellStreamingLayerKeys(world)).not.toContain(oldLayerKey);
  });

  it('slot reuse: fresh per-cell TileLayer at same slot rebuilds cleanly, no stale cache interference', () => {
    // Step 1: spawn layer1 + populate caches.
    const cols = 2;
    const rows = 2;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, tilemap, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });
    tilemapChunkExtractSystem(world, lookup);
    const layer1Key = layer as unknown as number;
    expect(_peekPerCellStreamingLayerKeys(world)).toContain(layer1Key);

    // Step 2: despawn just the TileLayer (Tilemap stays alive).
    world.despawn(layer).unwrap();

    // Step 3: extract fires diff-cleanup; layer1Key evicts.
    tilemapChunkExtractSystem(world, lookup);
    expect(_peekPerCellStreamingLayerKeys(world)).not.toContain(layer1Key);

    // Step 4: spawn a new per-cell layer (may or may not reuse the slot —
    // ECS decides). Rebuild MUST populate caches for the new layerKey
    // regardless.
    const tiles2 = new Uint32Array(cols * rows).fill(1);
    const layer2 = spawnLayer(world, tilemap, tiles2, 'per-cell');

    tilemapChunkExtractSystem(world, lookup);

    // Step 5: new layer's Children.entities lists the 4 fresh per-cell
    // derived entities (2x2 filled tiles, chunkSize default 16 → 1 chunk).
    const derived2 = readChildren(world, layer2);
    expect(derived2.length).toBe(4);
    for (const child of derived2) {
      const co = world.get(child, ChildOf).unwrap();
      expect(co.parent).toBe(layer2 as unknown as number);
    }

    // Step 6: the fresh layer's layerKey is now in the caches; the old
    // layerKey (if slot got reused, layer2Key === layer1Key numerically;
    // if slot didn't reuse, layer2Key !== layer1Key) — either way the
    // stale entries under layer1Key must not linger. We assert the caches
    // contain exactly the new layer's key when slots differ.
    const layer2Key = layer2 as unknown as number;
    expect(_peekPerCellStreamingLayerKeys(world)).toContain(layer2Key);
    if (layer2Key !== layer1Key) {
      expect(_peekPerCellStreamingLayerKeys(world)).not.toContain(layer1Key);
    }
  });

  it('multi-layer eviction: 3 per-cell layers → despawn 2 → only survivor remains in caches', () => {
    const world = new World();
    const { tilemap, lookup } = spawnTilemap(world, 2, 2, 4);
    const tiles = new Uint32Array(4).fill(1);
    const l0 = spawnLayer(world, tilemap, tiles, 'per-cell', 0);
    const l1 = spawnLayer(world, tilemap, tiles, 'per-cell', 1);
    const l2 = spawnLayer(world, tilemap, tiles, 'per-cell', 2);
    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();
    tilemapChunkExtractSystem(world, lookup);

    const keysBefore = _peekPerCellStreamingLayerKeys(world);
    expect(keysBefore).toContain(l0 as unknown as number);
    expect(keysBefore).toContain(l1 as unknown as number);
    expect(keysBefore).toContain(l2 as unknown as number);

    // Despawn two — the survivor stays; the two dead layers must evict.
    world.despawn(l0).unwrap();
    world.despawn(l2).unwrap();

    tilemapChunkExtractSystem(world, lookup);

    const keysAfter = _peekPerCellStreamingLayerKeys(world);
    expect(keysAfter).not.toContain(l0 as unknown as number);
    expect(keysAfter).toContain(l1 as unknown as number);
    expect(keysAfter).not.toContain(l2 as unknown as number);
  });

  it('AC-06 no regression: alive per-cell layers keep their caches across frames when no layer despawns', () => {
    // Steady-state: caches populated on frame 1 remain untouched on frame 2
    // (diff-cleanup only fires on layer disappearance frames — OOS-3 guard).
    const cols = 2;
    const rows = 2;
    const tiles = new Uint32Array(cols * rows).fill(1);
    const { world, layer, lookup } = setup({ cols, rows, tiles, sortScope: 'per-cell' });

    tilemapChunkExtractSystem(world, lookup);
    const keysFrame1 = new Set(_peekPerCellStreamingLayerKeys(world));
    expect(keysFrame1.has(layer as unknown as number)).toBe(true);

    tilemapChunkExtractSystem(world, lookup);
    const keysFrame2 = new Set(_peekPerCellStreamingLayerKeys(world));
    expect(keysFrame2.has(layer as unknown as number)).toBe(true);

    // Same set — no eviction happened between frames.
    expect(keysFrame2.size).toBe(keysFrame1.size);
    for (const k of keysFrame1) expect(keysFrame2.has(k)).toBe(true);
  });
});

describe('despawnOnExit triggers the same cascade via state transition (AC-04)', () => {
  it("despawnOnExit(tilemap, GameState, 'playing') collects the whole subtree on state exit", () => {
    const world = new World();
    registerStatesPlugin(world);
    // Move the state to 'playing' first so a later setNextState('menu')
    // exits 'playing' and fires the despawnOnExit hook.
    setNextState(world, GameState, 'playing');
    world.update(1 / 60).unwrap();

    const { tilemap, lookup } = spawnTilemap(world, 2, 2);
    const tiles = new Uint32Array(4).fill(1);
    const layer = spawnLayer(world, tilemap, tiles, 'per-cell');
    resetTilemapChunkExtractCache();
    resetTilemapDerivedEntityTracker();
    tilemapChunkExtractSystem(world, lookup);

    const derived = readChildren(world, layer);
    expect(derived.length).toBe(4);

    despawnOnExit(world, tilemap, GameState, 'playing');

    // Trigger transition: leave 'playing' → transitionStatesSystem despawns
    // the tilemap, which linkedSpawn-cascades every layer + derived entity.
    setNextState(world, GameState, 'menu');
    world.update(1 / 60).unwrap();

    expect(isAlive(world, tilemap)).toBe(false);
    expect(isAlive(world, layer)).toBe(false);
    for (const d of derived) expect(isAlive(world, d)).toBe(false);
  });
});
