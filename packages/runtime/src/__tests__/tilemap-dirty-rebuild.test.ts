// tilemap-dirty-rebuild.test - dirty flag rebuild + first-frame heuristic
// (feat-20260608 M0 baseline rebuild).
//
// Asserts:
//   - First frame (dirty=0 but layer never extracted) still spawns derived
//     entities (charter F1 progressive disclosure -- AI users do not need
//     to manually call markTileLayerDirty on freshly-spawned layers).
//   - markTileLayerDirty(world, layer) triggers a full purge + rebuild on
//     the next tilemapChunkExtractSystem pass.
//   - Idempotent: calling the system twice without mutating tiles does not
//     produce duplicate derived entities.
//
// Anchors: plan-tasks m0-t9; charter F1.

import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import type { TilesetAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { encodeSortScope, markTileLayerDirty } from '../../../render/src/components/tile-layer';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

function setup() {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const lookup = makeTilemapAssetLookup(tileset);
  const tilemap = world
    .spawn(
      { component: Tilemap, data: { cols: 2, rows: 2, tileset: 'test/tileset' } },
      { component: Transform, data: {} },
    )
    .unwrap();
  const tiles = new Uint32Array([1, 0, 0, 1]);
  const layer = world
    .spawn(
      {
        component: TileLayer,
        data: { tiles, layerOrder: 0, dirty: 0, sortScope: encodeSortScope('per-cell') },
      },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, tilemap, layer, lookup };
}

function countDerived(world: World): number {
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
  return count;
}

describe('tilemap dirty rebuild (M0 baseline)', () => {
  it('first frame: dirty=0 + never-built layer still spawns derived entities', () => {
    const { world, lookup } = setup();
    expect(countDerived(world)).toBe(0);
    tilemapChunkExtractSystem(world, lookup);
    expect(countDerived(world)).toBe(2);
  });

  it('idempotent: second pass without dirty flag does not duplicate entities', () => {
    const { world, lookup } = setup();
    tilemapChunkExtractSystem(world, lookup);
    const after1 = countDerived(world);
    tilemapChunkExtractSystem(world, lookup);
    const after2 = countDerived(world);
    expect(after2).toBe(after1);
  });

  it('markTileLayerDirty triggers a full rebuild on the next pass', () => {
    const { world, layer, lookup } = setup();
    tilemapChunkExtractSystem(world, lookup);
    expect(countDerived(world)).toBe(2);
    // Mutate the tiles array in place + mark dirty.
    const tiles = world.get(layer, TileLayer).unwrap().tiles as Uint32Array;
    tiles[1] = 1; // adds a non-zero cell
    markTileLayerDirty(world, layer).unwrap();
    tilemapChunkExtractSystem(world, lookup);
    expect(countDerived(world)).toBe(3);
  });
});

// AC-05: terrain dirty-rebuild locates its previously-spawned derived
// entities via `Children.entities` on the TileLayer (mirror of ChildOf,
// engine-maintained) instead of the module-level tracker Map that lived
// in `tilemap-chunk-extract-system.ts` before tweak-20260714 M3. This
// suite drives the terrain path (`sortScope='layer'`); the M0 suite
// above uses `sortScope='per-cell'` which never entered the terrain
// tracker in the first place, so it does not exercise M3's fix by
// itself.
//
// The load-bearing observations, decomposed to isolate M3's contract
// from the engine mirror invariant:
//   1. First pass populates `Children.entities` with the derived
//      SpriteInstances handles (M2's ChildOf attachment).
//   2. After `markTileLayerDirty` + a second pass, every OLD derived
//      handle captured before rebuild must return `stale-entity` on
//      `world.get(..., Entity)` — proof that `purgeDerivedEntities`
//      correctly located the pre-existing children via the
//      `Children.entities` snapshot (M3's contract).
//   3. After the rebuild, `Children.entities` is re-read directly (the
//      SSOT the production code relies on) and must list exactly N fresh
//      derived entities, each carrying `ChildOf.parent === layer` — proof
//      the rebuild re-attached to the same parent SSOT AND that the mirror
//      list repopulates after a full drain (the ECS drain-then-refill fix,
//      I-1). Reading through `Children.entities` rather than an archetype
//      query is deliberate: it guards the exact contract production uses.
//   4. Repeated markDirty+rebuild cycles keep the derived count constant
//      at N (no leak) — the failure mode that the pre-fix ECS buffer-shrink
//      guard produced (4 → 8 → 12 accumulation).
//
// Anchors: requirements §5 AC-05; plan-strategy §2 D-3 + §7 M3 boundary
// criterion.
function setupTerrain() {
  const world = new World();
  const cols = 8;
  const rows = 8;
  const chunkSize = 4;
  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: ['test/atlas'],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
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
  const tiles = new Uint32Array(cols * rows).fill(1);
  const layer = world
    .spawn(
      {
        component: TileLayer,
        data: { tiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('layer') },
      },
      { component: ChildOf, data: { parent: tilemap } },
    )
    .unwrap();
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  return { world, tilemap, layer, lookup };
}

function readChildrenIds(world: World, parent: EntityHandle): EntityHandle[] {
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

function isAlive(world: World, entity: EntityHandle): boolean {
  const r = world.get(entity, Entity);
  if (r.ok) return true;
  return r.error.code !== 'stale-entity';
}

describe('AC-05: terrain dirty-rebuild locates derived entities via Children.entities', () => {
  it("terrain path (sortScope='layer'): first pass populates Children.entities with the chunk-grouped SpriteInstances entities", () => {
    // 8x8 cells + chunkSize=4 → 4 chunks; one atlas → 1 SpriteInstances
    // entity per (chunk, atlas) group → 4 derived entities total.
    const { world, layer, lookup } = setupTerrain();
    tilemapChunkExtractSystem(world, lookup);

    const kids = readChildrenIds(world, layer);
    expect(kids.length).toBe(4);
    for (const k of kids) expect(isAlive(world, k)).toBe(true);
  });

  it("terrain path (sortScope='layer'): markTileLayerDirty + rebuild purges OLD entities via Children.entities snapshot, spawns NEW entities with ChildOf.parent = layer", () => {
    const { world, layer, lookup } = setupTerrain();
    tilemapChunkExtractSystem(world, lookup);

    // Capture handles from the first build BEFORE dirty; these must be
    // despawned after the second pass. If purgeDerivedEntities were still
    // reading from the retired module Map (or a no-op), these handles
    // would stay alive and duplicate SpriteInstances entities would
    // accumulate.
    const oldKids = readChildrenIds(world, layer);
    expect(oldKids.length).toBe(4);
    for (const k of oldKids) expect(isAlive(world, k)).toBe(true);

    markTileLayerDirty(world, layer).unwrap();
    tilemapChunkExtractSystem(world, lookup);

    // Every OLD handle must now be dead — this is the load-bearing
    // observation that Children.entities was the source of truth used
    // by purgeDerivedEntities (a stale module Map or empty no-op would
    // leak these into the archetype tables).
    for (const k of oldKids) expect(isAlive(world, k)).toBe(false);

    // Re-read Children.entities directly — the exact SSOT production code
    // (`purgeDerivedEntities` + "already built" gate + despawn cascade)
    // depends on. After a full drain the mirror list MUST repopulate to
    // the fresh N derived entities (guards the ECS drain-then-refill fix,
    // I-1). Each must be alive, disjoint from the old set, and parented at
    // the layer via ChildOf.
    const derived = readChildrenIds(world, layer);
    expect(derived.length).toBe(4);
    for (const d of derived) {
      expect(isAlive(world, d)).toBe(true);
      expect(oldKids.includes(d)).toBe(false);
      const co = world.get(d, ChildOf).unwrap();
      expect(co.parent).toBe(layer as unknown as number);
    }
  });

  it('terrain path: 3 consecutive markDirty+rebuild cycles keep derived count constant at N (no leak) and Children.entities never drains to 0', () => {
    // Regression for the pre-fix ECS drain-then-refill leak: once
    // `Children.entities` was fully drained by `purgeDerivedEntities` it
    // could never repopulate (managed-buffer shrink guard), so each rebuild
    // stacked a fresh generation on top of un-purged ones (4 → 8 → 12) and
    // the mirror stayed empty. With I-1 fixed, every cycle purges the prior
    // N and re-attaches exactly N, and the mirror list reflects it.
    const { world, layer, lookup } = setupTerrain();
    tilemapChunkExtractSystem(world, lookup);
    expect(readChildrenIds(world, layer).length).toBe(4);

    for (let cycle = 0; cycle < 3; cycle++) {
      markTileLayerDirty(world, layer).unwrap();
      tilemapChunkExtractSystem(world, lookup);

      // Children.entities repopulates to exactly N (never sticks at 0).
      const kids = readChildrenIds(world, layer);
      expect(kids.length).toBe(4);
      for (const k of kids) expect(isAlive(world, k)).toBe(true);

      // World-wide derived entity count stays flat — no orphaned survivors
      // from prior cycles leaking into the archetype tables.
      expect(countDerived(world)).toBe(4);
    }
  });

  it("terrain path (sortScope='layer'): steady-state idempotency without dirty flag preserves Children.entities identity", () => {
    // A second extract pass without dirty must NOT purge + rebuild
    // (that would leak the "already built" signal), so Children.entities
    // stays byte-identical between passes. This is the Children-empty ⇔
    // never-built equivalence the plan-strategy §2 D-3 edge case 3 relies
    // on: populated Children + dirty=0 is the "skip" case.
    const { world, layer, lookup } = setupTerrain();
    tilemapChunkExtractSystem(world, lookup);
    const kids1 = readChildrenIds(world, layer);
    expect(kids1.length).toBe(4);

    tilemapChunkExtractSystem(world, lookup);
    const kids2 = readChildrenIds(world, layer);
    expect(kids2.length).toBe(4);
    for (let i = 0; i < kids1.length; i++) expect(kids2[i]).toBe(kids1[i]);
  });

  it('resetTilemapDerivedEntityTracker: signature unchanged, callable as void → void', () => {
    // AC-08 hard constraint. Also proves the reset does not require the
    // caller to know about internal Map/Set membership after M3 (the
    // former tracker Map is retired; Children.entities is the SSOT).
    expect(typeof resetTilemapDerivedEntityTracker).toBe('function');
    expect(resetTilemapDerivedEntityTracker.length).toBe(0);
    expect(resetTilemapDerivedEntityTracker()).toBeUndefined();
  });
});
