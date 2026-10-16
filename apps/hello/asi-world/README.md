# hello-asi-world

Real-data demo: drives forgeax's `Tilemap` / `TileLayer` / sprite / input
pipeline against ASI World scene assets. Renders the test2 (SAO) world,
lets you walk a Kirito sprite around with WASD or arrow keys, and blocks
the player against both impassable terrain and object footprints.

Migrated in `feat-20260608-tilemap-object-layer-rendering` M4: objects
no longer ride a per-instance sprite-entity path (779 entities + 1
`MaterialAsset` per atlas tile). They share the terrain `Tilemap`
parent through a single object `TileLayer` with `widthCells` /
`heightCells` / `pivotX` / `pivotY` / `collider` carried by the
`TilesetTileEntry` surface.

## What is wired

| Layer | Source asset | Engine surface |
|:--|:--|:--|
| Terrain atlas (16x16 tiles, irregular packed) | `public/world/terrain_atlas.{png,tsj}` | `TextureAsset` |
| Object atlas (variable-size sprites with pivot + collider) | `public/world/object_atlas.{png,tsj}` | `TextureAsset` |
| Combined tileset (terrain + object regions / tile entries) | `composeTilesetAsset()` in `main.ts` | one `TilesetAsset { atlases: [terrainAtlas, objectAtlas], regions, tiles }` (NICE-4 multi-atlas) |
| Per-cell terrain layers (3 height tiers: `-99`, `0`, `1`) | `terrain.json.cells` | one `TileLayer` per height tier, parented to a single `Tilemap` |
| World objects (trees, rocks, props) | `terrain.json.objects[]` x 153 atlas tiles | one object `TileLayer` carrying anchor cells only; chunk-extract spawns multi-cell quads per tile entry |
| Character spritesheet (4 frames x 4 directions) | `public/character/{idle,move}.png` | `SpriteRegionOverride` updated per-frame from a closure timer |
| Movement | `InputSnapshot` `keyboard.down('w'/'a'/'s'/'d')` | hand-rolled per-axis collision: `passable: Uint8Array(cols*rows)` derived from terrain templates + object collider rects |

## Coordinate convention

ASI World is top-down (y increases DOWN). forgeax renders y-up. Every
position written into the engine flips `worldY = (rows - 1) - asi_y`.

## Run

```bash
pnpm install                                # at the engine repo root
pnpm tsc -b                                 # refresh .d.ts (TilesetAsset / Tilemap)
pnpm -F @forgeax/engine-wgpu-wasm build     # one-time; needs Rust + wasm-pack (rustup.rs)
pnpm -F @forgeax/hello-asi-world dev        # http://localhost:5210
```

WASD / arrow keys to move; HUD top-right shows current cell + facing.

## What does NOT cleanly fit forgeax's `Tilemap`

The asi_world world data is two-layer: tile cells (regular grid) AND
object instances (variable-size sprites with custom pivot + collider).
Both halves now ride the tilemap path via the multi-cell tile entry
surface introduced in feat-20260608-tilemap-object-layer-rendering;
free-placed entities (player, NPCs, pickups) still use the per-entity
sprite path (`MeshFilter(HANDLE_QUAD) + MeshRenderer + Transform +
Layer`), which is the documented "two paths coexist" split (see
`packages/runtime/README.md` section Object layer).

Skipped intentionally: NPC AI, dialogue, quests, areaTags, day/night,
the asi_world `screenplay` system. Those are product-layer; the
engine is the substrate.
